import { registerStoreReloads } from '../../../lib/changeFeed.ts'
import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'
import type {
  ChannelProfile,
  ContentChannel,
  ContentKind,
  ContentPiece,
  ContentTopic,
  ContentTopicUpsert,
  ContentTransitionId,
  ContentTransitionSpec,
} from '../content-types.ts'

/** The active user as the mutation's `actor` audit stamp (created_by/updated_by server-side). */
const actor = (): string | undefined => getActiveUserId() ?? undefined

// One shared store (see dataStore.ts) so every content route shares ONE fetch and re-renders on
// mutation (mirrors usePlanningData). TWO queries behind one store since 2026-08-12: the topics (the
// parent objects) and the pieces + per-channel profiles. One store rather than two because every
// content surface needs both - a board row is a topic drawn from its pieces - and two stores would
// render half-updated in the window between their reloads.
interface ContentData {
  topics: ContentTopic[]
  pieces: ContentPiece[]
  profiles: ChannelProfile[]
  /** The lifecycle transition catalogue (labels + dialog copy), straight from core. */
  transitionSpecs: ContentTransitionSpec[]
}

function fromWire(pieces: unknown, topics: unknown): ContentData {
  const o = pieces as { pieces?: unknown[]; profiles?: unknown[]; transitionSpecs?: unknown[] }
  return {
    topics: ((topics as { topics?: unknown[] }).topics ?? []) as ContentTopic[],
    pieces: (o.pieces ?? []) as ContentPiece[],
    profiles: (o.profiles ?? []) as ChannelProfile[],
    transitionSpecs: (o.transitionSpecs ?? []) as ContentTransitionSpec[],
  }
}

const store = createDataStore<ContentData>(() =>
  Promise.all([trpc.contentPieces.query({}), trpc.contentTopics.query({})]).then(([p, t]) => fromWire(p, t)),
)
registerStoreReloads(['table:content_pieces', 'table:content_topics', 'docs:content'], store)

/** Force a refetch after a mutation. */
export const reloadContent = (): Promise<ContentData> => store.reload()

/**
 * Fire a lifecycle transition (the ONLY way the dashboard moves a piece). Not optimistic: a
 * transition can be refused server-side (wrong state, missing input, a channel guard), and showing
 * a piece as "Published" before the server agreed is exactly the lie this rework exists to remove.
 */
export async function transitionContent(input: {
  id: string
  transition: ContentTransitionId
  note?: string
  scheduled_at?: string
  published_url?: string
}): Promise<void> {
  await trpc.contentTransition.mutate({ ...input, actor: actor() })
  await store.reload()
}

/**
 * Tick verify findings off (or untick them); omit `indices` to set every finding at once.
 *
 * **The caller debounces; this only guarantees no overlap.** Ticking is the one mutation people fire
 * in bursts - five findings, five clicks, faster than a round trip - so `VerifyPanel` holds the
 * changes locally and flushes one call per burst. That is what makes it feel instant AND what makes it
 * safe: a burst becomes a single atomic write instead of N read-modify-writes racing each other
 * (measured on a copy of production: 11 ticks fired concurrently, 1 survived).
 *
 * The chain here is the belt to that braces. Flushes should never overlap, but two CAN meet - a timer
 * firing just as the panel unmounts and flushes early - and a read-modify-write that loses is silent.
 * One line to make that impossible is worth it.
 */
let findingQueue: Promise<unknown> = Promise.resolve()
export function approveFindings(input: { id: string; approved: boolean; indices?: number[] }): Promise<void> {
  const send = async (): Promise<void> => {
    await trpc.contentFindingsApprove.mutate({ ...input, actor: actor() })
    await store.reload()
  }
  // Both arms run `send`: a failed link must not poison the chain for the tick behind it.
  const next = findingQueue.then(send, send)
  findingQueue = next.catch(() => undefined)
  return next
}

/**
 * Fields editable from the dashboard (subset of the server's content-upsert input; metadata as JSON).
 * Authoring only - `status` and `scheduled_at` are deliberately absent: the lifecycle moves through
 * transitionContent(), never by writing a status field.
 */
export interface ContentUpsert {
  id: string
  topic_id?: string
  channel?: ContentChannel
  kind?: ContentKind
  source_id?: string
  title?: string
  body_path?: string
  metadata?: string
}

/** Create or update a piece (partial), then reload. */
export async function upsertContent(input: ContentUpsert): Promise<void> {
  await trpc.contentUpsert.mutate({ ...input, actor: actor() })
  await store.reload()
}

/** Delete a piece (the on-disk body is left in place), then reload. */
export async function deleteContent(id: string): Promise<void> {
  await trpc.contentRemove.mutate({ id })
  await store.reload()
}

/** Create or partially update a TOPIC, then reload. The review gate (`status`) moves through here
 *  too: unlike a piece, a topic has no named-transition machine - approving is a status a human
 *  picks, and the only thing it arms is a separate, explicit generate action. */
export async function upsertContentTopic(input: ContentTopicUpsert): Promise<void> {
  await trpc.contentTopicUpsert.mutate({ ...input, actor: actor() })
  await store.reload()
}

/** Delete a topic AND its pieces; returns what went, so the caller can say so out loud. */
export async function deleteContentTopic(id: string): Promise<{ pieces: string[]; published: string[] }> {
  const report = (await trpc.contentTopicDelete.mutate({ id })) as unknown as {
    pieces: string[]
    published: string[]
  }
  await store.reload()
  return report
}

export function useContentData(): { data: ContentData | null; error: string | null } {
  return store.useData()
}
