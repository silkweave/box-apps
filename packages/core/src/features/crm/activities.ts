// CRM activities - one message, call or letter exchanged with a contact.
//
// TWO WRITE PATHS, and the split is the same one `crm_meetings` makes between `upsertCrmMeeting`
// and `upsertImportedMeeting`:
//
//   • `upsertCrmActivity`  - the PROVIDER path. Keyed on the upstream's own message id, so a
//     backfill, a live push and every webhook retry resolve to one row.
//   • `logCrmActivity`     - the HUMAN path. A call someone had, an email that never touched a tracked
//     inbox, a letter. Keyed `manual:<uuid>`, and the two id spaces cannot collide.
//
// The boundary against `crm_meetings` is already settled and worth restating, because "a call" can
// sound like either: a meeting is a FUTURE APPOINTMENT WITH A LIFECYCLE (it exists before it
// happens, then moves scheduled -> held/no_show/cancelled). A logged call is a PAST FACT with a
// body. `models.ts` names this table as where the second one belongs.

import { randomUUID } from 'node:crypto'
import { ensureSchema, withRead, withWrite } from '../../warehouse/db.js'
import { deleteRecord, fromNaiveUtc, readRecord, upsertRecord } from '../../warehouse/model.js'
import { CRM_ACTIVITIES } from './models.js'
import { readCrmContact } from './state.js'
import type { CrmActivity, CrmActivityChannel, CrmActivityDirection } from './types.js'

const bag = (v: unknown): Record<string, unknown> =>
  typeof v === 'string' ? (JSON.parse(v || '{}') as Record<string, unknown>) : ((v ?? {}) as Record<string, unknown>)

/** Hand-logged rows are keyed in their own namespace, so no sync can ever collide with one and no
 *  human edit can land on a provider row. Mirrors `MACHINE_MEETING_ID` in meetings.ts. */
export const MANUAL_ACTIVITY_ID = /^manual:\S+$/

/** One message. `id` carries the upstream's own message id, which is what makes this idempotent. */
export interface CrmActivityInput {
  id: string
  account_id: string
  contact_id: string
  channel: CrmActivityChannel
  direction: CrmActivityDirection
  occurred_at: string
  body: string
  subject?: string | null
  thread_id?: string | null
  thread_index?: number | null
  message_type?: string | null
  interaction_type?: string | null
  author_name?: string
  campaign_id?: string | null
  campaign_name?: string
  data_source_id?: string | null
  external_id?: string | null
  external?: Record<string, unknown>
  actor?: string
}

/**
 * Record one activity. Idempotent on `id`, and that is load-bearing: the same message arrives from
 * a backfill, from a live push, and again from every webhook retry.
 *
 * Returns whether the row was NEW, so a caller can report "12 messages, 3 new" rather than
 * pretending it did work it did not.
 */
export async function upsertCrmActivity(input: CrmActivityInput): Promise<{ created: boolean }> {
  await ensureSchema()
  if (!input.id?.trim()) throw new Error('crm activity: id is required')
  if (!input.account_id || !input.contact_id) {
    throw new Error(`crm activity ${input.id}: account_id and contact_id are both required`)
  }
  if (!input.occurred_at) throw new Error(`crm activity ${input.id}: occurred_at is required`)

  const prev = await readRecord<CrmActivity>(CRM_ACTIVITIES, { id: input.id })
  await upsertRecord<CrmActivity>(
    CRM_ACTIVITIES,
    {
      id: input.id,
      account_id: input.account_id,
      contact_id: input.contact_id,
      channel: input.channel,
      direction: input.direction,
      occurred_at: input.occurred_at,
      body: input.body ?? '',
      subject: input.subject ?? null,
      thread_id: input.thread_id ?? null,
      thread_index: input.thread_index ?? null,
      message_type: input.message_type ?? null,
      interaction_type: input.interaction_type ?? null,
      author_name: input.author_name ?? '',
      campaign_id: input.campaign_id ?? null,
      campaign_name: input.campaign_name ?? '',
      data_source_id: input.data_source_id ?? null,
      external_id: input.external_id ?? null,
      external: input.external ?? {},
      first_seen_at: prev?.first_seen_at ?? new Date().toISOString(),
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev: prev ?? undefined },
  )
  return { created: !prev }
}

/**
 * The whole conversation with one account, oldest first - every contact interleaved, which is the
 * point of the account-level stream.
 *
 * Ordered by `(occurred_at, thread_index, id)`: `occurred_at` alone is NOT a total order (the
 * upstream's own sync keysets on a tiebreaker for exactly this reason), and two messages delivered
 * in the same second would otherwise render in whatever order the scan returned.
 */
export async function readCrmActivities(accountId: string, limit = 500): Promise<CrmActivity[]> {
  await ensureSchema()
  const rows = await withRead<CrmActivity>(
    `SELECT * FROM crm_activities WHERE account_id = ?
      ORDER BY occurred_at ASC, COALESCE(thread_index, 0) ASC, id ASC
      LIMIT ?`,
    [accountId, limit],
  )
  return rows.map((r) => ({ ...r, external: bag(r.external) }))
}

/**
 * Re-point an account's activities after its contact moved. `account_id` is denormalized onto the
 * activity (the account page's query is the whole reason the table exists), so a re-parent would
 * otherwise strand the history on the old account.
 */
export async function healActivitiesForContact(contactId: string): Promise<number> {
  await ensureSchema()
  const contact = await readCrmContact(contactId)
  if (!contact) return 0
  const stale = await withRead<{ n: number }>(
    `SELECT count(*) AS n FROM crm_activities WHERE contact_id = ? AND account_id <> ?`,
    [contactId, contact.account_id],
  )
  const n = Number(stale[0]?.n ?? 0)
  if (n === 0) return 0
  // withWrite, not withRead - the read connection is opened `read_only` and would refuse this.
  await withWrite(async (conn) => {
    await conn.run(
      `UPDATE crm_activities SET account_id = ?, updated_at = now() WHERE contact_id = ? AND account_id <> ?`,
      [contact.account_id, contactId, contact.account_id],
    )
  })
  return n
}

// --- the human path ---------------------------------------------------------------------------

/** A touch a person logs by hand. `contact_id` is the anchor - the account is derived from it, so
 *  an activity can never be attached to an account its contact does not belong to. */
export interface CrmManualActivityInput {
  /** Omit to create. Pass an existing `manual:` id to edit; a provider id is refused. */
  id?: string
  contact_id: string
  channel: CrmActivityChannel
  direction: CrmActivityDirection
  /** ISO date or timestamp. A bare `YYYY-MM-DD` is stored at midnight. Defaults to now. */
  occurred_at?: string
  body: string
  subject?: string | null
  /** Who said it. Defaults to the contact's name inbound, and to the actor's id outbound. */
  author_name?: string
  actor?: string
}

/**
 * Normalise to an instant the record layer will store unchanged, accepting a bare date.
 *
 * Returns full ISO WITH the `Z`. The record layer's `toNaiveUtc` is `new Date(value)`, and JS reads
 * a space-separated "2026-05-02 00:00:00" as LOCAL time - so returning the naive form here would
 * shift every hand-logged touch by the server's offset. A row read back out of the warehouse is
 * naive, so a caller re-saving one must be normalised the same way; `fromNaiveUtc` does that.
 */
function normalizeOccurredAt(value: string | undefined): string {
  const raw = (value ?? '').trim()
  if (!raw) return new Date().toISOString()
  // A bare date means the DAY (midnight UTC), not whatever time it is in the browser's zone.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : fromNaiveUtc(raw)
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`crm activity: occurred_at "${value}" is not a date`)
  return new Date(ms).toISOString()
}

/**
 * Log (or edit) a touch by hand.
 *
 * **A provider row is not editable here.** The sync owns those rows and would overwrite an edit on
 * its next run, so silently accepting one would be a lie - the same refusal `upsertImportedMeeting`
 * makes in the other direction.
 */
export async function logCrmActivity(input: CrmManualActivityInput): Promise<CrmActivity> {
  await ensureSchema()
  const body = (input.body ?? '').trim()
  if (!body) throw new Error('crm activity: body is required - an empty touch records nothing')
  if (!input.contact_id) throw new Error('crm activity: contact_id is required')

  const contact = await readCrmContact(input.contact_id)
  if (!contact) throw new Error(`crm activity: no contact "${input.contact_id}"`)

  let prev: CrmActivity | null = null
  if (input.id) {
    if (!MANUAL_ACTIVITY_ID.test(input.id)) {
      throw new Error(
        `crm activity ${input.id}: only a hand-logged row ("manual:…") can be edited - this one is owned by a sync and an edit would be overwritten on its next run`,
      )
    }
    prev = await readRecord<CrmActivity>(CRM_ACTIVITIES, { id: input.id })
    if (!prev) throw new Error(`crm activity: no activity "${input.id}"`)
  }

  const id = input.id ?? `manual:${randomUUID()}`
  const inbound = input.direction === 'inbound'
  // A users.id in the stream reads as a machine artefact ("jdoe" beside "Ella Wong"). Resolve it to
  // the display name, and fall back to the id rather than failing - `actor` is validated by the
  // record layer a moment later anyway.
  let authorName = (input.author_name ?? '').trim()
  if (!authorName) {
    if (inbound) authorName = contact.name
    else if (input.actor) {
      const { readUser } = await import('../../users/state.js')
      const user = await readUser(input.actor)
      authorName = user ? [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || input.actor : input.actor
    } else authorName = 'Us'
  }
  await upsertRecord<CrmActivity>(
    CRM_ACTIVITIES,
    {
      id,
      // Derived from the contact on every write, so re-parenting the contact and re-saving the row
      // cannot leave it pointing at the wrong company.
      account_id: contact.account_id,
      contact_id: contact.id,
      channel: input.channel,
      direction: input.direction,
      occurred_at: normalizeOccurredAt(input.occurred_at ?? prev?.occurred_at),
      body,
      subject: input.subject?.trim() || null,
      thread_id: prev?.thread_id ?? null,
      thread_index: prev?.thread_index ?? null,
      message_type: null,
      interaction_type: null,
      author_name: authorName,
      campaign_id: prev?.campaign_id ?? null,
      campaign_name: prev?.campaign_name ?? '',
      // NULL data_source_id is what makes a row hand-logged, alongside the id namespace. Provider
      // columns stay empty so nothing downstream mistakes this for a synced row.
      data_source_id: null,
      external_id: null,
      external: { ...bag(prev?.external), logged_by: input.actor ?? null },
      first_seen_at: prev?.first_seen_at ?? new Date().toISOString(),
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev: prev ?? undefined },
  )
  return (await readRecord<CrmActivity>(CRM_ACTIVITIES, { id }))!
}

/**
 * Delete an activity. **Hand-logged rows only.**
 *
 * A provider row would come back on the next sync (the backfill re-reads the whole thread), so
 * deleting one is not a delete - it is a row that reappears and a person who concludes the CRM is
 * broken. Refused with that reason rather than half-done.
 */
export async function deleteCrmActivity(id: string): Promise<{ id: string; deleted: boolean }> {
  await ensureSchema()
  if (!MANUAL_ACTIVITY_ID.test(id)) {
    throw new Error(
      `crm activity ${id}: only a hand-logged row ("manual:…") can be deleted - a synced message would be re-created by the next backfill`,
    )
  }
  const prev = await readRecord<CrmActivity>(CRM_ACTIVITIES, { id })
  if (!prev) return { id, deleted: false }
  await deleteRecord(CRM_ACTIVITIES, { id })
  return { id, deleted: true }
}
