// The PARENT content object (2026-08-12): a topic is an idea with a brief, a set of channels it
// should reach, and a markdown doc carrying the argument. Pieces hang off it, one per channel.
//
// It exists because of the shape of the work: the weekly draft pipeline writes ten ideas per person,
// and a human has to be able to read them, kill some, sharpen others and approve the rest BEFORE any
// model time is spent adapting them per channel. The status is that review gate, expressed in the
// planning vocabulary rather than a second one of its own (see TOPIC_STATUSES in types.ts):
// `planned` is an idea nobody has ruled on, `active` is approved, `dropped` is killed-but-kept.
//
// What this deliberately is NOT is an initiative. Content hung off `initiatives` (kind: 'content')
// until migration 010, and the two reasons for cutting it are worth keeping verbatim, because
// they are about direction of travel rather than tidiness:
//
//   1. At scale it clogs the initiatives table and its views. Ten ideas per person per week is
//      thirty rows a week on a board that has to stay readable as the company's real work.
//   2. An initiative is work BEYOND the default ops scope. Content is going the other way - more
//      operationalized every month, with automation, an SOP and a weekly workload. A standing
//      weekly process is the opposite of an initiative, so filing it as one was a category error
//      that would only get worse.
//
// Nothing here reads or writes the planning layer.

import { ensureSchema, withRead, withWrite } from '../../warehouse/db.js'
import { deleteRecord, readRecord, readRecords, upsertRecord } from '../../warehouse/model.js'
import { CONTENT_TOPICS } from './models.js'
import { assertKnownUser } from '../../users/state.js'
import { CONTENT_CHANNELS, type ContentChannel, type ContentTopic, type ContentTopicInput } from './types.js'

/** One slug segment: lowercase, digits, dashes; must start alphanumeric (mirrors planning's SLUG_SEG,
 *  and it has to - a topic id is the first half of every one of its pieces' ids). */
const SLUG = /^[a-z0-9][a-z0-9-]*$/

/** The doc a topic's brief lives in, beside its pieces and assets rather than in a folder of its own:
 *  `docs/content/<id>/topic.md`. One folder per topic is what the assets panel already assumes. */
export function topicDocPath(id: string): string {
  return `docs/content/${id}/topic.md`
}

// --- reads ---------------------------------------------------------------------------------------

/** Every topic, newest-intent first: the team's explicit order, then most recently touched. */
export async function readContentTopics(): Promise<ContentTopic[]> {
  return readRecords<ContentTopic>(CONTENT_TOPICS, { orderBy: 'sort, updated_at DESC' })
}

/** One topic by id, or null. */
export async function readContentTopic(id: string): Promise<ContentTopic | null> {
  return readRecord<ContentTopic>(CONTENT_TOPICS, { id })
}

// --- writes --------------------------------------------------------------------------------------

/** Channels a topic may target: the closed content vocabulary. Unknown values are refused rather
 *  than dropped - a pipeline asking for `twitter` should hear about it, not silently target nothing. */
function assertChannels(channels: ContentChannel[]): ContentChannel[] {
  const out = [...new Set(channels.map((c) => String(c).trim()).filter(Boolean))]
  for (const c of out) {
    if (!(CONTENT_CHANNELS as readonly string[]).includes(c)) {
      throw new Error(`unknown channel "${c}" - one of ${CONTENT_CHANNELS.join(', ')}`)
    }
  }
  return out as ContentChannel[]
}

/**
 * Create or partially update a topic. Provided fields overwrite; the rest keep their stored value (or
 * a default on first insert), the record layer's contract everywhere else in this warehouse.
 *
 * Two things are validated here rather than left to the caller: the `owner` must be a real user (the
 * `assertKnownUser` rule the CRM and signal ownership already follow - an owner is who a draft speaks
 * as, so a ghost id would produce a piece in nobody's voice), and `target_channels` must name real
 * channels. `doc_path` defaults to the topic's own folder on create, so a brief always has somewhere
 * to be written without the caller composing a path.
 */
export async function upsertContentTopic(input: ContentTopicInput): Promise<ContentTopic> {
  if (!SLUG.test(input.id)) throw new Error(`invalid topic id "${input.id}" (use a-z, 0-9, -)`)
  const prev = await readContentTopic(input.id)
  if (input.owner) await assertKnownUser(input.owner)
  return upsertRecord<ContentTopic>(
    CONTENT_TOPICS,
    {
      id: input.id,
      title: input.title ?? prev?.title ?? input.id,
      brief: input.brief ?? prev?.brief ?? '',
      status: input.status ?? prev?.status ?? 'planned',
      owner: input.owner !== undefined ? input.owner : (prev?.owner ?? null),
      target_channels:
        input.target_channels !== undefined ? assertChannels(input.target_channels) : (prev?.target_channels ?? []),
      doc_path: input.doc_path !== undefined ? input.doc_path : (prev?.doc_path ?? topicDocPath(input.id)),
      signal_ids: input.signal_ids ?? prev?.signal_ids ?? [],
      tags: input.tags ? [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))] : (prev?.tags ?? []),
      due_date: input.due_date !== undefined ? input.due_date : (prev?.due_date ?? null),
      sort: input.sort ?? prev?.sort ?? 0,
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev },
  )
}

/** What a topic delete would take with it - the pieces are the part worth stating out loud. */
export interface TopicDeleteReport {
  id: string
  /** Piece ids removed with it. */
  pieces: string[]
  /** Published piece ids among them: the ones that exist in public and now have no record here. */
  published: string[]
}

/**
 * Delete a topic AND cascade to its pieces - the parent is what gives a piece its id, so leaving them
 * would strand rows whose first path segment names nothing. Reports what went, and separately which
 * of those were already PUBLISHED: those posts still exist on LinkedIn or the blog, and the warehouse
 * is simply forgetting them. Markdown bodies and assets on disk are left alone, as with deleteContent.
 */
export async function deleteContentTopic(id: string): Promise<TopicDeleteReport> {
  await ensureSchema()
  const pieces = await withRead<{ id: string; status: string }>(
    `SELECT id, status FROM content_pieces WHERE topic_id = ?`,
    [id],
  )
  await withWrite(async (conn) => {
    await conn.run(`DELETE FROM content_pieces WHERE topic_id = ?`, [id])
  })
  await deleteRecord(CONTENT_TOPICS, { id })
  return {
    id,
    pieces: pieces.map((p) => p.id),
    published: pieces.filter((p) => p.status === 'published').map((p) => p.id),
  }
}

/**
 * The channels an APPROVED topic still needs a piece for - what a "generate the pieces" action would
 * work on. Returns nothing for a topic that is not approved, which is the review gate doing its job:
 * generation is a separate, explicit act, and it never runs against an idea nobody has ruled on.
 */
export async function pendingTopicChannels(id: string): Promise<ContentChannel[]> {
  const topic = await readContentTopic(id)
  if (!topic || topic.status !== 'active') return []
  const have = new Set(
    (await withRead<{ channel: string }>(`SELECT channel FROM content_pieces WHERE topic_id = ?`, [id])).map(
      (r) => r.channel,
    ),
  )
  return topic.target_channels.filter((c) => !have.has(c))
}
