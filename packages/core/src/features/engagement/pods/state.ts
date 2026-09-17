// Read/write the pod tables and derive the pod engagement cards. Row↔domain plumbing (column
// lists, JSON/timestamp handling, partial upsert, audit stamps, enum validation) comes from the
// record layer (warehouse/model.ts) driven by the PODS/POD_MEMBERS/POD_CONTENT/POD_ENGAGEMENTS
// specs in warehouse/models.ts; this module keeps the domain semantics: slug ids, cascade deletes,
// membership/authorship guards, karma stamping, and the joined/derived reads (pod_content's
// topic join, the card matrix, karma sums), which stay raw SQL. The card matrix is never
// stored - it is a pure function of (pod content within window) × (pod members, author excluded)
// × (expected action), minus the persisted pod_engagements rows. See features/engagement/SPEC.md.

import { ensureSchema, withRead, withWrite } from '../../../warehouse/db.js'
import { deleteRecord, fromNaiveUtc, readRecord, readRecords, upsertRecord } from '../../../warehouse/model.js'
import { POD_CONTENT, POD_ENGAGEMENTS, POD_MEMBERS, PODS } from '../models.js'
import { readUsers } from '../../../users/state.js'
import { expectedActions, karmaFor, readPodsConfig } from './config.js'
import type {
  EngagementAction,
  EngagementAdvice,
  KarmaRow,
  ParticipantKind,
  Pod,
  PodCard,
  PodContent,
  PodContentInput,
  PodContentSource,
  PodEngagement,
  PodEngagementInput,
  PodEngagementStatus,
  PodInput,
  PodMember,
  PodMemberInput,
} from './types.js'

const SLUG_SEG = /^[a-z0-9][a-z0-9-]*$/
const parse = <T>(json: string | null, fallback: T): T => {
  if (json == null) return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

/** Derive a stable slug from a free-text name (mirrors users' userSlug). */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

// =================================================================================================
// Pods
// =================================================================================================

export async function readPods(): Promise<Pod[]> {
  return readRecords<Pod>(PODS, { orderBy: 'sort, created_at' })
}

export async function readPod(id: string): Promise<Pod | null> {
  return readRecord<Pod>(PODS, { id })
}

export async function upsertPod(input: PodInput): Promise<Pod> {
  if (!SLUG_SEG.test(input.id)) throw new Error(`invalid pod id "${input.id}" (use a-z, 0-9, -)`)
  const prev = await readPod(input.id)
  return upsertRecord<Pod>(
    PODS,
    {
      id: input.id,
      title: input.title ?? prev?.title ?? input.id,
      description: input.description ?? prev?.description ?? '',
      status: input.status ?? prev?.status ?? 'active',
      owner: input.owner !== undefined ? input.owner : (prev?.owner ?? null),
      sort: input.sort ?? prev?.sort ?? 0,
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev },
  )
}

/** Delete a pod and cascade its membership, content, and engagements. */
export async function deletePod(id: string): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    await conn.run(
      `DELETE FROM pod_engagements WHERE pod_content_id IN (SELECT id FROM pod_content WHERE pod_id = ?)`,
      [id],
    )
    await conn.run(`DELETE FROM pod_content WHERE pod_id = ?`, [id])
    await conn.run(`DELETE FROM pod_members WHERE pod_id = ?`, [id])
    await conn.run(`DELETE FROM pods WHERE id = ?`, [id])
  })
}

// =================================================================================================
// Membership
// =================================================================================================

export async function readPodMembers(podId?: string): Promise<PodMember[]> {
  return podId
    ? readRecords<PodMember>(POD_MEMBERS, {
        where: 'pod_id = ?',
        params: [podId],
        orderBy: 'participant_kind, participant_id',
      })
    : readRecords<PodMember>(POD_MEMBERS, { orderBy: 'pod_id, participant_kind, participant_id' })
}

/** Add (or re-role) a member. Re-adding an existing member updates ONLY the role (which resets to
 *  'member' when not given, as before); joined_at + created_by stick to the original join. */
export async function addPodMember(input: PodMemberInput): Promise<PodMember> {
  const key = {
    pod_id: input.pod_id,
    participant_kind: input.participant_kind,
    participant_id: input.participant_id,
  }
  const prev = await readRecord<PodMember>(POD_MEMBERS, key)
  return upsertRecord<PodMember>(
    POD_MEMBERS,
    {
      ...key,
      role: input.role ?? 'member',
      joined_at: prev?.joined_at ?? new Date().toISOString(),
      created_by: prev ? prev.created_by : (input.actor ?? null),
    },
    { prev },
  )
}

export async function removePodMember(podId: string, kind: ParticipantKind, participantId: string): Promise<void> {
  await deleteRecord(POD_MEMBERS, { pod_id: podId, participant_kind: kind, participant_id: participantId })
}

// =================================================================================================
// Pod content
// =================================================================================================

interface PodContentRow {
  id: string
  pod_id: string
  source: string
  content_id: string | null
  topic_id: string | null
  submitter_kind: string | null
  submitter_id: string | null
  channel: string
  url: string
  title: string
  advice: string | null
  published_at: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

// pc-qualified (a LEFT JOIN to content_pieces resolves the main-post topic for team pieces).
const CONTENT_COLS = `pc.id, pc.pod_id, pc.source, pc.content_id, c.topic_id AS topic_id,
  pc.submitter_kind, pc.submitter_id, pc.channel, pc.url, pc.title,
  CAST(pc.advice AS VARCHAR) AS advice, CAST(pc.published_at AS VARCHAR) AS published_at,
  CAST(pc.created_at AS VARCHAR) AS created_at, CAST(pc.updated_at AS VARCHAR) AS updated_at,
  pc.created_by, pc.updated_by`
const CONTENT_FROM = `pod_content pc LEFT JOIN content_pieces c ON c.id = pc.content_id`

function toPodContent(r: PodContentRow): PodContent {
  return {
    id: r.id,
    pod_id: r.pod_id,
    source: r.source as PodContentSource,
    content_id: r.content_id,
    topic_id: r.topic_id ?? null,
    submitter_kind: (r.submitter_kind as ParticipantKind | null) ?? null,
    submitter_id: r.submitter_id,
    channel: r.channel,
    url: r.url,
    title: r.title,
    advice: parse<EngagementAdvice | null>(r.advice, null),
    published_at: r.published_at == null ? null : fromNaiveUtc(r.published_at),
    created_at: fromNaiveUtc(r.created_at),
    updated_at: fromNaiveUtc(r.updated_at),
    created_by: r.created_by,
    updated_by: r.updated_by,
  }
}

export async function readPodContent(podId?: string): Promise<PodContent[]> {
  await ensureSchema()
  const rows = podId
    ? await withRead<PodContentRow>(
        `SELECT ${CONTENT_COLS} FROM ${CONTENT_FROM} WHERE pc.pod_id = ? ORDER BY pc.created_at DESC`,
        [podId],
      )
    : await withRead<PodContentRow>(`SELECT ${CONTENT_COLS} FROM ${CONTENT_FROM} ORDER BY pc.created_at DESC`)
  return rows.map(toPodContent)
}

export async function upsertPodContent(input: PodContentInput): Promise<PodContent> {
  const id = input.id ?? `${input.pod_id}-${slugify(input.title || input.url).slice(0, 24)}-${Date.now().toString(36)}`
  const prev = input.id ? (await readPodContent(input.pod_id)).find((c) => c.id === input.id) : undefined
  // Advice is a whole-value REPLACE (not a deep merge): a provided advice object overwrites the
  // stored one entirely; absent keeps the previous. The record layer serializes it.
  await upsertRecord<PodContent>(
    POD_CONTENT,
    {
      id,
      pod_id: input.pod_id,
      source: input.source ?? prev?.source ?? 'team',
      content_id: input.content_id !== undefined ? input.content_id : (prev?.content_id ?? null),
      submitter_kind: input.submitter_kind !== undefined ? input.submitter_kind : (prev?.submitter_kind ?? null),
      submitter_id: input.submitter_id !== undefined ? input.submitter_id : (prev?.submitter_id ?? null),
      channel: input.channel ?? prev?.channel,
      url: input.url ?? prev?.url,
      title: input.title ?? prev?.title ?? '',
      advice: input.advice !== undefined ? input.advice : (prev?.advice ?? null),
      published_at: input.published_at !== undefined ? input.published_at : (prev?.published_at ?? null),
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev: prev ?? null },
  )
  // Re-read through the joined read so the returned piece carries topic_id.
  return (await readPodContent(input.pod_id)).find((c) => c.id === id)!
}

export async function deletePodContent(id: string): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    await conn.run(`DELETE FROM pod_engagements WHERE pod_content_id = ?`, [id])
    await conn.run(`DELETE FROM pod_content WHERE id = ?`, [id])
  })
}

// =================================================================================================
// Engagements (the only persisted card state)
// =================================================================================================

/** Delete one engagement row by its full key - used to CLEAR a draft (the card stays derived from
 *  what's absent, so dropping a verified/dismissed row would resurrect the card; callers guard). */
export async function deletePodEngagement(
  podContentId: string,
  kind: ParticipantKind,
  participantId: string,
  action: EngagementAction,
): Promise<void> {
  await deleteRecord(POD_ENGAGEMENTS, {
    pod_content_id: podContentId,
    participant_kind: kind,
    participant_id: participantId,
    action,
  })
}

export async function readPodEngagements(): Promise<PodEngagement[]> {
  return readRecords<PodEngagement>(POD_ENGAGEMENTS, { orderBy: 'updated_at DESC' })
}

/**
 * Record an engagement (or dismissal) - the ONLY persisted card state. Upserts on the
 * (pod_content_id, participant_kind, participant_id, action) key. Guards: the piece exists, the
 * participant is a pod member, and is not the piece's own author/submitter. Verified rows are
 * credited flat karma from config; dismissals award 0.
 */
export async function recordPodEngagement(input: PodEngagementInput): Promise<PodEngagement> {
  const status: PodEngagementStatus = input.status ?? 'verified'
  const piece = (await readPodContent()).find((c) => c.id === input.pod_content_id)
  if (!piece) throw new Error(`engagement refused: no pod content "${input.pod_content_id}"`)
  const members = await readPodMembers(piece.pod_id)
  const isMember = members.some(
    (m) => m.participant_kind === input.participant_kind && m.participant_id === input.participant_id,
  )
  if (!isMember) {
    throw new Error(`engagement refused: ${input.participant_kind} "${input.participant_id}" is not a member of pod "${piece.pod_id}"`)
  }
  if (piece.submitter_kind === input.participant_kind && piece.submitter_id === input.participant_id) {
    throw new Error(`engagement refused: "${input.participant_id}" submitted "${input.pod_content_id}" - authors don't engage their own posts`)
  }
  // Full overwrite of every mutable field (no prev merge, as before): verified_at re-stamps to now
  // on every verify and NULLs on dismissal/draft; karma is credited flat at verify time, 0 otherwise;
  // absent evidence/note clear the stored values. created_at/created_by stick to the first record.
  const karma = status === 'verified' ? karmaFor(input.action) : 0
  return upsertRecord<PodEngagement>(POD_ENGAGEMENTS, {
    pod_content_id: input.pod_content_id,
    participant_kind: input.participant_kind,
    participant_id: input.participant_id,
    action: input.action,
    status,
    verified_at: status === 'verified' ? new Date().toISOString() : null,
    evidence: input.evidence ?? null,
    karma_awarded: karma,
    note: input.note ?? null,
    ...(input.actor ? { actor: input.actor } : {}),
  })
}

// =================================================================================================
// Card derivation + karma
// =================================================================================================

/**
 * Derive the full pod card matrix (every participant, every pod). The dashboard / micro-app filter
 * to the relevant participant + pod. A piece whose channel isn't in config gets its action from its
 * own advice.action; without either, it produces no cards.
 */
export async function derivePodCards(): Promise<PodCard[]> {
  const cfg = readPodsConfig()
  const [pods, members, contentRows, engagements] = await Promise.all([
    readPods(),
    readPodMembers(),
    readPodContent(),
    readPodEngagements(),
  ])
  const activePods = new Set(pods.filter((p) => p.status === 'active').map((p) => p.id))
  const membersByPod = new Map<string, PodMember[]>()
  for (const m of members) {
    const list = membersByPod.get(m.pod_id) ?? []
    list.push(m)
    membersByPod.set(m.pod_id, list)
  }
  // Only verified/dismissed rows clear a card; a `draft` row keeps it in the queue and hangs the
  // saved comment on it.
  const key = (e: { pod_content_id: string; participant_kind: string; participant_id: string; action: string }) =>
    `${e.pod_content_id}|${e.participant_kind}:${e.participant_id}|${e.action}`
  const done = new Set(engagements.filter((e) => e.status !== 'draft').map(key))
  // The card's comment text: a pending draft, or - once the comment is verified (the draft row
  // upserts to verified on confirm) - the REAL comment captured as evidence, so the card keeps
  // showing what was actually posted.
  const drafts = new Map(
    engagements
      .filter((e) => e.status === 'verified' && e.evidence?.comment_text)
      .map((e) => [key(e), e.evidence?.comment_text ?? null] as const),
  )
  for (const e of engagements) {
    if (e.status === 'draft') drafts.set(key(e), e.evidence?.comment_text ?? e.note ?? null)
  }

  const now = Date.now()
  const cards: PodCard[] = []
  for (const piece of contentRows) {
    if (!activePods.has(piece.pod_id)) continue
    // ALL expected actions for the piece (e.g. linkedin → react + comment). One card asks for all
    // of them; per-action completion is tracked and the card clears only when nothing remains.
    const actions = expectedActions(cfg, piece.channel, piece.advice)
    if (actions.length === 0) continue
    // Recency window from published_at (fall back to created_at).
    const stamp = piece.published_at ?? piece.created_at
    const ageDays = stamp ? Math.floor((now - Date.parse(stamp)) / 86_400_000) : 0
    if (ageDays > cfg.windowDays) continue
    const podMembers = membersByPod.get(piece.pod_id) ?? []
    for (const m of podMembers) {
      if (m.participant_kind === piece.submitter_kind && m.participant_id === piece.submitter_id) continue
      const keyOf = (action: EngagementAction) =>
        key({ pod_content_id: piece.id, participant_kind: m.participant_kind, participant_id: m.participant_id, action })
      const doneActions = actions.filter((a) => done.has(keyOf(a)))
      if (doneActions.length === actions.length) continue // everything handled - card cleared
      // The participant's saved comment draft rides the card whichever action key it was saved
      // under (comment preferred - that's what /engage writes).
      const draftKeys = ['comment' as EngagementAction, ...actions]
      const draft = draftKeys.map((a) => drafts.get(keyOf(a))).find((d) => d != null) ?? null
      cards.push({
        pod_id: piece.pod_id,
        pod_content_id: piece.id,
        participant_kind: m.participant_kind,
        participant_id: m.participant_id,
        channel: piece.channel,
        title: piece.title,
        url: piece.url,
        published_at: piece.published_at,
        author_kind: piece.submitter_kind,
        author_id: piece.submitter_id,
        actions,
        done_actions: doneActions,
        advice: piece.advice,
        draft_comment: draft,
        days_left: Math.max(0, cfg.windowDays - ageDays),
      })
    }
  }
  return cards.sort(
    (a, b) =>
      (b.published_at ?? '').localeCompare(a.published_at ?? '') ||
      a.participant_id.localeCompare(b.participant_id),
  )
}

/**
 * Karma per participant, both per-pod and global (pod_id null). Non-gated in V1 - a display score.
 * Each verified engagement credits its karma_awarded twice: as GIVEN to the engager, and as
 * RECEIVED to the engaged piece's submitter (a submitter-less piece credits nobody). Both
 * directions merge into one row per participant per pod, zero-filled. label resolves a users
 * nickname for the UI.
 */
export async function computeKarma(): Promise<KarmaRow[]> {
  await ensureSchema()
  const users = await readUsers()
  const label = (id: string): string => users.find((u) => u.id === id)?.nickname ?? id

  const rows = await withRead<{
    participant_kind: string
    participant_id: string
    pod_id: string
    submitter_kind: string | null
    submitter_id: string | null
    karma: number
  }>(
    `SELECT pe.participant_kind, pe.participant_id, pc.pod_id, pc.submitter_kind, pc.submitter_id,
            SUM(pe.karma_awarded) AS karma
       FROM pod_engagements pe JOIN pod_content pc ON pc.id = pe.pod_content_id
      WHERE pe.status = 'verified'
      GROUP BY 1, 2, 3, 4, 5`,
  )
  // Accumulate both directions into one row per (participant, pod), plus the global (null) rollup.
  const acc = new Map<string, KarmaRow>()
  const bump = (kind: ParticipantKind, id: string, podId: string | null, dir: 'given' | 'received', karma: number): void => {
    const k = `${kind}:${id}|${podId ?? '*'}`
    const row = acc.get(k) ?? {
      participant_kind: kind,
      participant_id: id,
      label: label(id),
      pod_id: podId,
      given: 0,
      received: 0,
    }
    row[dir] += karma
    acc.set(k, row)
  }
  for (const r of rows) {
    const karma = Number(r.karma)
    for (const podId of [r.pod_id, null]) {
      bump(r.participant_kind as ParticipantKind, r.participant_id, podId, 'given', karma)
      if (r.submitter_kind && r.submitter_id) {
        bump(r.submitter_kind as ParticipantKind, r.submitter_id, podId, 'received', karma)
      }
    }
  }
  return [...acc.values()].sort((a, b) => b.given - a.given || b.received - a.received)
}
