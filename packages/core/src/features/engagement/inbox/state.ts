// Committed done/snoozed state for the tactical inbox, in the warehouse `inbox_state` table.
// Open items have NO row. Reads/writes go through the record layer (warehouse/model.ts) with the
// INBOX_STATE spec; this module keeps only the domain semantics: 'open' deletes the row (back to
// the inbox), a set stamps done_at now, and note always overwrites (absent clears it).

import { deleteRecord, readRecords, upsertRecord } from '../../../warehouse/model.js'
import { INBOX_STATE } from '../models.js'
import type { InboxState, ItemStatus } from './types.js'

interface StateRecord {
  id: string
  status: string
  done_at: string
  note: string | null
}

/** All done/snoozed entries. Read-only. */
export async function readInboxState(): Promise<InboxState> {
  const rows = await readRecords<StateRecord>(INBOX_STATE, { orderBy: 'done_at DESC' })
  return {
    items: rows.map((r) => ({
      id: r.id,
      status: r.status as ItemStatus,
      done_at: r.done_at,
      ...(r.note ? { note: r.note } : {}),
    })),
  }
}

/**
 * Record an item's state and return the full updated state. `'open'` deletes the row (back to the
 * inbox); `'done'`/`'snoozed'` UPSERT it. Mirrors the old POST /__inbox-state semantics.
 */
export async function setInboxState(
  id: string,
  status: ItemStatus | 'open',
  note?: string,
): Promise<InboxState> {
  if (status === 'open') {
    await deleteRecord(INBOX_STATE, { id })
  } else {
    // Every column is provided (note ?? null clears an absent note), so skip the prev read.
    await upsertRecord(
      INBOX_STATE,
      { id, status, done_at: new Date().toISOString(), note: note ?? null },
      { prev: null },
    )
  }
  return readInboxState()
}
