// Read/write `content_pieces` and derive the content-published outcome signal from the lifecycle
// ledger. Row↔domain plumbing (column lists, JSON/timestamp handling, partial upsert, audit stamps,
// enum validation) comes from the record layer (warehouse/model.ts) with the CONTENT_PIECES spec in
// warehouse/models.ts; this module keeps the domain semantics: create-defaults derived from the
// slug-path id, the metadata deep-merge, published_at management, and the post-write hooks (outcome
// signal, pod auto-push, frontmatter mirror). The parent object lives in topics.ts.

import { ensureSchema, withRead, withWrite } from '../../warehouse/db.js'
import { replaceChannelSignals, type SignalRow } from '../data/signals/write.js'
import { readRecord, readRecords, upsertRecord } from '../../warehouse/model.js'
import { CONTENT_PIECES } from './models.js'
import { autoRegisterDefinitions } from '../data/signals/definitions.js'
import { recordEvent } from '../../events.js'
import { contentDocPath, syncContentDocFrontmatter } from './docs.js'
import { readContentTopic, upsertContentTopic } from './topics.js'
import {
  allowedContentTransitions,
  COMPANY_AUTHOR,
  normalizeVerify,
  type ContentChannel,
  type ContentInput,
  type ContentPiece,
  type ContentStatus,
  type ContentVerify,
} from './types.js'

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Deep-merge a metadata patch into the stored bag rather than replacing it wholesale: keys present in
 * the patch overwrite (scalars and arrays replace as a whole, nested plain objects merge recursively),
 * keys absent from the patch are preserved, and a key whose patch value is `null` is deleted. This
 * stops a partial `content-upsert --metadata` (e.g. changing only `flair`) from silently dropping
 * sibling keys like `subreddit`/`assets`. On create (empty `prev`), it behaves like a plain assign.
 */
export function mergeMetadata(
  prev: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...prev }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k]
      continue
    }
    const cur = out[k]
    out[k] = isPlainObject(v) && isPlainObject(cur) ? mergeMetadata(cur, v) : v
  }
  return out
}

// --- reads ---------------------------------------------------------------------------------------

/** Every content piece, optionally scoped to one topic. Sorted by topic then channel. */
export async function readContentPieces(topicId?: string): Promise<ContentPiece[]> {
  const rows = await readRecords<ContentPiece>(CONTENT_PIECES, {
    ...(topicId ? { where: 'topic_id = ?', params: [topicId] } : {}),
    orderBy: 'topic_id, kind DESC, channel',
  })
  return rows.map((p) => ({ ...p, verify: normalizeVerify(p.verify) }))
}

/** One piece by id, or null. */
export async function readContentPiece(id: string): Promise<ContentPiece | null> {
  const row = await readRecord<ContentPiece>(CONTENT_PIECES, { id })
  // Coerce on READ rather than backfilling: it makes verdicts written before severities were closed
  // (or before findings could be ticked) correct everywhere at once, and it is idempotent, so the
  // stored row catches up the first time anybody writes to it. See normalizeVerify.
  return row ? { ...row, verify: normalizeVerify(row.verify) } : null
}

// --- writes --------------------------------------------------------------------------------------

/**
 * Create or update a content piece. Partial: provided fields overwrite; the rest keep their stored
 * value (or a default on first insert). `created_at` is preserved on update. `published_at` is
 * managed from `status` (set when it flips to 'published', cleared otherwise) unless given explicitly.
 * Channel + initiative are derivable from the slug-path id when not provided. Re-derives the outcome
 * signal so the chart tracks the ledger.
 */
export async function upsertContent(input: ContentInput): Promise<ContentPiece> {
  const prev = await readContentPiece(input.id)

  // ids are slug paths `<topic>/<channel>`, so both are derivable from the id when not given.
  const slash = input.id.indexOf('/')
  const derivedTopic = slash > 0 ? input.id.slice(0, slash) : undefined
  const derivedChannel = slash > 0 ? (input.id.slice(slash + 1) as ContentChannel) : undefined

  const status: ContentStatus = input.status ?? prev?.status ?? 'draft'
  const topicId = input.topic_id ?? prev?.topic_id ?? derivedTopic
  const channel = input.channel ?? prev?.channel ?? derivedChannel
  if (!topicId) throw new Error(`content ${input.id}: topic_id is required on create`)
  if (!channel) throw new Error(`content ${input.id}: channel is required on create`)

  // scheduled_at arrives as any-ISO; validate here for a field-specific error (the record layer
  // normalizes offsets to naive UTC on write and re-attaches the Z on read).
  let scheduledAt: string | null
  if (input.scheduled_at !== undefined) {
    if (input.scheduled_at == null) scheduledAt = null
    else if (Number.isNaN(new Date(input.scheduled_at).getTime())) {
      throw new Error(`content ${input.id}: scheduled_at: unparseable timestamp "${input.scheduled_at}"`)
    } else scheduledAt = input.scheduled_at
  } else scheduledAt = prev?.scheduled_at ?? null
  if (status === 'scheduled' && !scheduledAt) {
    throw new Error(`content ${input.id}: status "scheduled" needs a scheduled_at timestamp`)
  }

  const metadata =
    input.metadata !== undefined ? mergeMetadata(prev?.metadata ?? {}, input.metadata) : (prev?.metadata ?? {})
  // published_at: when 'published', use an explicit timestamp → existing → now; else clear.
  const publishedAt =
    status === 'published' ? (input.published_at ?? prev?.published_at ?? new Date().toISOString()) : null
  const publishedUrl = input.published_url !== undefined ? input.published_url : (prev?.published_url ?? null)
  const publishedBy = input.published_by !== undefined ? input.published_by : (prev?.published_by ?? null)
  const title = input.title ?? prev?.title ?? ''

  // The status machine (allowedContentTransitions): enforced on every transition of an existing
  // row. Creates may land in any state (content:migrate ingests history as-is). `force` bypasses
  // for internal scripts - it is deliberately absent from the tRPC/MCP DTOs.
  if (prev && status !== prev.status && !input.force) {
    if (!allowedContentTransitions(prev.status).includes(status)) {
      throw new Error(
        `content ${input.id}: illegal status transition "${prev.status}" → "${status}" ` +
          `(allowed: ${allowedContentTransitions(prev.status).join(', ')})`,
      )
    }
    if (status === 'published' && !publishedUrl) {
      throw new Error(`content ${input.id}: publishing needs a published_url`)
    }
  }

  const piece = await upsertRecord<ContentPiece>(
    CONTENT_PIECES,
    {
      id: input.id,
      topic_id: topicId,
      channel,
      kind: input.kind ?? prev?.kind ?? (derivedChannel === 'blog' ? 'canonical' : 'derived'),
      source_id: input.source_id !== undefined ? input.source_id : (prev?.source_id ?? null),
      status,
      title,
      // body_path defaults to the canonical on-disk path derived from the slug id.
      body_path:
        input.body_path !== undefined ? input.body_path : (prev?.body_path ?? contentDocPath(input.id)),
      verify: input.verify !== undefined ? input.verify : (prev?.verify ?? null),
      review: input.review !== undefined ? input.review : (prev?.review ?? null),
      metadata,
      scheduled_at: scheduledAt,
      published_at: publishedAt,
      published_url: publishedUrl,
      published_by: publishedBy,
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev },
  )
  await deriveContentSignals()
  // A piece that is published AND has its url is announced on the events spine, once per piece
  // (dedup on the id): engagement pushes it into the pod from there. Gating on published_url means
  // a piece that flips first and gets its url in a later call still lands. Best-effort: a downstream
  // subscriber must never fail the content write, and recordEvent never throws into its caller.
  if (piece.status === 'published' && piece.published_url) {
    try {
      await recordEvent({
        kind: 'content.published',
        dedup_key: piece.id,
        event_at: piece.published_at ?? piece.updated_at,
        source: 'content',
        actor: input.actor ?? '',
        subject: piece.id,
        url: piece.published_url,
        fields: {
          channel,
          title: piece.title,
          published_url: piece.published_url,
          published_at: piece.published_at ?? '',
          published_by: piece.published_by ?? '',
        },
      })
    } catch (err) {
      console.warn(`content ${piece.id}: publish event failed - ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // Mirror status + channel metadata back into the on-disk frontmatter so the two never drift.
  // Best-effort: a missing/odd body must never fail the warehouse write it is meant to reflect.
  try {
    syncContentDocFrontmatter(piece.id, {
      status: piece.status,
      title: piece.title,
      metadata: piece.metadata,
    })
  } catch {
    /* ignore: the warehouse row is the source of truth; the doc mirror is advisory */
  }
  // Record every status transition on the events spine (durable history + alertable/digestable).
  // Best-effort like the other hooks - observability must never fail the write.
  if (!prev || prev.status !== piece.status) {
    try {
      await recordEvent({
        kind: 'content.status',
        dedup_key: `${piece.id}:${piece.status}:${piece.updated_at}`,
        event_at: piece.updated_at,
        source: 'funnel',
        actor: input.actor ?? '',
        subject: piece.id,
        url: piece.published_url ?? '',
        fields: {
          from: prev?.status ?? '',
          to: piece.status,
          channel,
          topic: topicId,
          title: piece.title,
          // The reviewer's note rides the event, so "why was this sent back?" survives the next
          // decision overwriting piece.review.
          ...(input.review?.note ? { note: input.review.note } : {}),
          ...(piece.scheduled_at ? { scheduled_at: piece.scheduled_at } : {}),
        },
      })
    } catch (err) {
      console.warn(`content ${piece.id}: status event failed - ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // A piece flipping to published closes out its topic when it was the LAST one outstanding. The
  // hook used to reach into the planning layer (close the publish task, flip the initiative to
  // active); content does not live there any more, so what is left is the one fact the topic itself
  // owns - every channel it wanted has shipped.
  if (prev && prev.status !== 'published' && piece.status === 'published') {
    try {
      await closeTopicIfFullyPublished(topicId, input.actor)
    } catch (err) {
      console.warn(
        `content ${piece.id}: topic advance failed - ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return piece
}

/**
 * Mark a topic `done` once every live piece under it has published. Only ever moves a topic FORWARD
 * from `planned`/`active`, and only when there is nothing left outstanding - a `blocked` or
 * `dropped` topic is a human's decision and a publish does not overrule it. Archived pieces sit
 * outside the lifecycle (the postStatus rule), so they neither hold a topic open nor close it alone.
 */
async function closeTopicIfFullyPublished(topicId: string, actor?: string): Promise<void> {
  const topic = await readContentTopic(topicId)
  if (!topic || (topic.status !== 'planned' && topic.status !== 'active')) return
  const pieces = await readContentPieces(topicId)
  const live = pieces.filter((p) => p.status !== 'archived')
  if (live.length === 0 || !live.every((p) => p.status === 'published')) return
  await upsertContentTopic({ id: topicId, status: 'done', ...(actor ? { actor } : {}) })
}

/**
 * Record an agent-verify verdict. **It no longer moves the piece** (2026-08-13): with `verified` and
 * `changes_requested` merged away, a verdict has no status of its own to land in - it is a reading of
 * a draft, and the draft stays a draft until a human signs it off. What the verdict drives is the
 * findings list the human ticks through, and whether Approve is enabled at the end of it.
 *
 * The one exception it used to need is gone with the same change: a re-verify of a PUBLISHED piece
 * (confirming a post-publish fix) previously had to special-case its way past the status machine,
 * because a failing verdict would otherwise try to knock a live post back to `changes_requested`.
 * Recording a verdict against any status is now simply safe.
 */
export async function recordContentVerify(id: string, verify: ContentVerify): Promise<ContentPiece> {
  // Normalize on the way in as well as on the way out, so the stored payload is the shape everything
  // reads: severities closed, and `pass` findings already ticked (nothing to decide about a note).
  return upsertContent({ id, verify: normalizeVerify(verify) })
}

/**
 * Tick findings off (or untick them). `indices` addresses positions in the stored verdict; omit it to
 * set every finding at once, which is what the panel's header checkbox does.
 *
 * **Positions, not a client-supplied array of findings.** The caller says "these three became true",
 * never "here is the whole list" - so a client working from a slightly stale copy cannot silently
 * revert a finding somebody else ticked. Combined with the dashboard's debounce (one call for a burst
 * of clicks) that makes rapid ticking a single atomic write rather than a race to be managed.
 *
 * Approving findings never moves the piece - the status machine is untouched here. It only decides
 * whether the `approve` transition is offered as enabled.
 */
export async function setFindingsApproved(input: {
  id: string
  approved: boolean
  indices?: number[]
  actor?: string
}): Promise<ContentPiece> {
  const piece = await readContentPiece(input.id)
  if (!piece) throw new Error(`no content piece "${input.id}"`)
  const verify = piece.verify
  if (!verify) throw new Error(`content piece "${input.id}" has no verify verdict to approve findings on`)
  const bad = (input.indices ?? []).filter((i) => !verify.findings[i])
  if (bad.length > 0) {
    throw new Error(
      `content piece "${input.id}" has no finding at index ${bad.join(', ')} (${verify.findings.length} findings)`,
    )
  }
  const touched = input.indices === undefined ? null : new Set(input.indices)
  const findings = verify.findings.map((f, i) =>
    touched === null || touched.has(i) ? { ...f, approved: input.approved } : f,
  )
  return upsertContent({
    id: input.id,
    verify: { ...verify, findings },
    ...(input.actor ? { actor: input.actor } : {}),
  })
}

/** Whether every finding on a piece has been ticked - the precondition the dashboard gates Approve on. */
export function allFindingsApproved(piece: Pick<ContentPiece, 'verify'>): boolean {
  return (piece.verify?.findings ?? []).every((f) => f.approved === true)
}

/** Delete a content piece (the on-disk body is left in place). Re-derives the outcome signal. */
export async function deleteContent(id: string): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    await conn.run(`DELETE FROM content_pieces WHERE id = ?`, [id])
  })
  await deriveContentSignals()
}

// --- derived outcome signal ----------------------------------------------------------------------

/**
 * Derive the content-published outcome signal from the lifecycle ledger: the cumulative count of
 * `published` pieces, per channel (`content.published.<channel>`) and in total
 * (`content.published_total`), dated by `published_at`. Like the OSS-PR signal, the number is exactly
 * the count of pieces that actually shipped - it can't be fabricated. Writes into a dedicated
 * `content` channel. See features/content/SPEC.md.
 */
export async function deriveContentSignals(): Promise<number> {
  await ensureSchema()
  const rows = await withRead<{ date: string; channel: string; n: number }>(
    `SELECT CAST(published_at AS DATE) AS date, channel, count(*) AS n
       FROM content_pieces
      WHERE status = 'published' AND published_at IS NOT NULL
      GROUP BY 1, 2 ORDER BY 1, 2`,
  )
  const today = (await withRead<{ d: string }>(`SELECT CAST(current_date AS VARCHAR) AS d`))[0].d
  const base = (signal_id: string, label: string, date: string, value: number): SignalRow => ({
    channel: 'content',
    signal_id,
    label,
    signal_group: 'Published',
    unit: 'posts',
    date,
    value,
  })

  // Build a cumulative signal per channel plus a combined total, all keyed by date.
  const dates = [...new Set(rows.map((r) => String(r.date)))].sort()
  const channels = [...new Set(rows.map((r) => r.channel))].sort()
  const out: SignalRow[] = []
  const cumByChannel = new Map<string, number>()
  let cumTotal = 0
  for (const d of dates) {
    for (const ch of channels) {
      const day = rows.find((r) => String(r.date) === d && r.channel === ch)
      if (day) cumByChannel.set(ch, (cumByChannel.get(ch) ?? 0) + Number(day.n))
      out.push(base(`content.published.${ch}`, `${ch} posts published`, d, cumByChannel.get(ch) ?? 0))
    }
    const dayTotal = rows.filter((r) => String(r.date) === d).reduce((s, r) => s + Number(r.n), 0)
    cumTotal += dayTotal
    out.push(base('content.published_total', 'Posts published (all channels)', d, cumTotal))
  }
  // Extend each signal flat to today so the chart reaches the current date.
  if (dates.length && dates[dates.length - 1] !== today) {
    for (const ch of channels) {
      out.push(base(`content.published.${ch}`, `${ch} posts published`, today, cumByChannel.get(ch) ?? 0))
    }
    out.push(base('content.published_total', 'Posts published (all channels)', today, cumTotal))
  }
  if (out.length === 0) out.push(base('content.published_total', 'Posts published (all channels)', today, 0))

  await replaceChannelSignals('content', out)
  await autoRegisterDefinitions(out)
  return out.length
}

/** Content's contribution to data's LinkedIn pull: every published member post with a stamped URN
 *  (articles carry the announcement share's URN; page posts are covered by org statistics). */
export async function publishedLinkedinPosts(): Promise<{ id: string; urn: string; title: string }[]> {
  return (await readContentPieces())
    .filter(
      (p) =>
        (p.channel === 'linkedin' || p.channel === 'linkedin-article') &&
        p.status === 'published' &&
        typeof p.metadata.post_urn === 'string' &&
        p.metadata.author !== COMPANY_AUTHOR,
    )
    .map((p) => ({ id: p.id, urn: p.metadata.post_urn as string, title: p.title }))
}
