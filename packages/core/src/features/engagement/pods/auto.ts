// Auto-push published team content into an engagement pod. Driven by config/pods.json
// `autoContent` ({ pod, channels }) - read at write time like the rest of the pods config, so
// edits apply without a restart. Called from content upsert on the publish transition; IDEMPOTENT
// (a pod_content row with the piece's content_id already in the pod means "done"), so repeated
// upserts of a published piece (metadata stamps, re-saves) never duplicate the card. See
// features/engagement/SPEC.md.

import { ensureSchema, withRead } from '../../../warehouse/db.js'
import { readPodsConfig } from './config.js'
import { upsertPodContent } from './state.js'
import type { PodContent } from './types.js'
import type { EventInput } from '../../../events.js'

/** The published piece fields the hook needs (a subset of content's ContentPiece). */
export interface PublishedPieceRef {
  id: string
  channel: string
  title: string
  published_url: string
  published_at: string | null
  /** The author of record at publish time (a users.id); null credits nobody with received karma. */
  published_by: string | null
}

/**
 * Push a just-published piece into the configured pod. Returns the pod_content row, or null when
 * the feature is off, the channel isn't covered, or the piece is already in the pod.
 */
export async function autoPushPublishedContent(
  piece: PublishedPieceRef,
  actor?: string,
): Promise<PodContent | null> {
  const auto = readPodsConfig().autoContent
  if (!auto || auto.enabled === false || !auto.channels.includes(piece.channel)) return null
  await ensureSchema()
  const existing = await withRead<{ id: string }>(
    `SELECT id FROM pod_content WHERE pod_id = ? AND content_id = ?`,
    [auto.pod, piece.id],
  )
  if (existing.length) return null
  return upsertPodContent({
    pod_id: auto.pod,
    source: 'team',
    content_id: piece.id,
    submitter_kind: piece.published_by ? 'user' : null,
    submitter_id: piece.published_by,
    channel: piece.channel,
    url: piece.published_url,
    title: piece.title,
    published_at: piece.published_at,
    actor: actor ?? piece.published_by ?? undefined,
  })
}

/** The events-spine subscriber form: react to `content.published` (registered by PodsModule). */
export async function onContentPublished(event: EventInput): Promise<void> {
  if (event.kind !== 'content.published') return
  const f = event.fields
  await autoPushPublishedContent(
    {
      id: event.subject ?? '',
      channel: f.channel ?? '',
      title: f.title ?? '',
      published_url: f.published_url ?? event.url ?? '',
      published_at: f.published_at || null,
      published_by: f.published_by || null,
    },
    event.actor || undefined,
  )
}
