// Draft replies for inbox items (P3b) - channel-generic state in the warehouse `inbox_drafts`
// table, keyed by InboxItem.id. Items themselves are pure derivations (events/snapshots); drafts
// must survive rebuilds, so they are their own rows. Written by the /draft-reply skill (via MCP
// `inbox-draft-save`) and the detail page's draft panel; never auto-sent - the human copies the
// text out. Reads/writes go through the record layer (warehouse/model.ts) with the INBOX_DRAFTS
// spec; the one domain rule here: an empty body DELETES the row. See features/engagement/SPEC.md.

import { deleteRecord, readRecord, readRecords, upsertRecord } from '../../../warehouse/model.js'
import { INBOX_DRAFTS } from '../models.js'

export interface InboxDraft {
  item_id: string
  channel: string
  body: string
  /** users.id whose voice the draft speaks in (the item owner's author overlay). */
  author: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

/** Every draft, optionally scoped to one inbox channel. Newest-edited first. */
export async function listInboxDrafts(channel?: string): Promise<InboxDraft[]> {
  return channel
    ? readRecords<InboxDraft>(INBOX_DRAFTS, { where: 'channel = ?', params: [channel], orderBy: 'updated_at DESC' })
    : readRecords<InboxDraft>(INBOX_DRAFTS, { orderBy: 'updated_at DESC' })
}

/** One item's draft, or null when none has been written. */
export async function readInboxDraft(itemId: string): Promise<InboxDraft | null> {
  return readRecord<InboxDraft>(INBOX_DRAFTS, { item_id: itemId })
}

export interface SaveDraftInput {
  item_id: string
  channel: string
  body: string
  author?: string
  /** users.id performing the save (stamps created_by on insert, updated_by always). */
  actor?: string
}

/**
 * Create or update an item's draft; an empty body DELETES the row (the panel's "clear"). Returns
 * the stored draft, or null after a clear. `created_at`/`created_by` are preserved on update.
 */
export async function saveInboxDraft(input: SaveDraftInput): Promise<InboxDraft | null> {
  if (!input.item_id) throw new Error('inbox-draft-save needs item_id')
  if (!input.body.trim()) {
    await deleteRecord(INBOX_DRAFTS, { item_id: input.item_id })
    return null
  }
  return upsertRecord<InboxDraft>(INBOX_DRAFTS, {
    item_id: input.item_id,
    channel: input.channel,
    body: input.body,
    author: input.author ?? null,
    ...(input.actor ? { actor: input.actor } : {}),
  })
}
