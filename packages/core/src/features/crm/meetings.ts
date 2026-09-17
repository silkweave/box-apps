// Read/write `crm_meetings`. Row↔domain plumbing comes from the record layer (warehouse/model.ts)
// driven by the CRM_MEETINGS ModelSpec; this module keeps only the domain semantics.
//
// The load-bearing rules, both from crm/types.ts:
//
//   • COLUMN OWNERSHIP. `upsertCrmMeeting` is the HUMAN path and cannot express a provider-owned
//     column on a CONNECTED row (source `calendar` / `transcript`), so a tool call can never fight
//     the calendar over when a meeting is. On a `manual` row there is no provider, so everything is
//     writable - that is how a phone call with no calendar entry gets recorded at all.
//   • NO MACHINE MAY ASSERT `no_show`. A human may. A past event with no transcript is either a
//     no-show or a call held somewhere that does not record, and guessing turns "we have no
//     evidence" into "they stood us up" - a lie about a customer. The gate lives in
//     upsertImportedMeeting; this module's job is to make sure the human path CAN set it.

import { readRecord, readRecords, deleteRecord, sameRecord, toNaiveUtc, upsertRecord } from '../../warehouse/model.js'
import { CRM_ACCOUNTS, CRM_CONTACTS, CRM_MEETINGS } from './models.js'
import {
  CRM_MEETING_MATCHED_BY,
  type CrmAccount,
  type CrmContact,
  type CrmEventDeleteReport,
  type CrmImportedMeetingInput,
  type CrmImportedMeetingResult,
  type CrmMeeting,
  type CrmMeetingInput,
  type CrmMeetingMatchedBy,
  type CrmMeetingOutcome,
  type CrmMeetingSource,
} from './types.js'

const bag = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const norm = (m: CrmMeeting): CrmMeeting => ({ ...m, external: bag(m.external) })

/** '' means "clear it" over the @Mcp scalar surface; undefined means "leave it alone". */
const clearable = (v: string | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim()

function normalizeTimestamp(v: string | undefined, field: string): string | undefined {
  if (v === undefined) return undefined
  const t = Date.parse(v)
  if (Number.isNaN(t)) throw new Error(`crm meeting: invalid ${field} "${v}" - use an ISO 8601 timestamp`)
  return new Date(t).toISOString()
}

function assertValidId(id: string): void {
  if (!id || id.trim() !== id) throw new Error('crm meeting: id is required and cannot be padded with whitespace')
  if (/\s/.test(id)) throw new Error(`crm meeting: id "${id}" cannot contain whitespace`)
  if (id.includes('/')) throw new Error(`crm meeting: id "${id}" cannot contain "/" (it is a route segment)`)
  if (id.length > 200) throw new Error('crm meeting: id is too long (max 200 characters)')
}

export interface CrmMeetingFilter {
  account_id?: string
  /** ISO date or timestamp - `scheduled_at >= since`. */
  since?: string
  until?: string
  /** true = ONLY the assign queue (rows with no account). */
  unassigned?: boolean
}

/**
 * Meetings, newest first. Filters are SQL rather than client-side (the accounts payload is already
 * ~294KB and this table only grows): a report asking for one month must not pull the whole history.
 */
export async function readCrmMeetings(filter: CrmMeetingFilter = {}): Promise<CrmMeeting[]> {
  const where: string[] = []
  const params: (string | number)[] = []
  if (filter.unassigned) where.push('account_id IS NULL')
  else if (filter.account_id) {
    where.push('account_id = ?')
    params.push(filter.account_id)
  }
  if (filter.since) {
    where.push('scheduled_at >= ?')
    params.push(new Date(filter.since).toISOString())
  }
  if (filter.until) {
    where.push('scheduled_at <= ?')
    params.push(new Date(filter.until).toISOString())
  }
  const rows = await readRecords<CrmMeeting>(CRM_MEETINGS, {
    ...(where.length ? { where: where.join(' AND '), params } : {}),
    orderBy: 'scheduled_at DESC',
  })
  return rows.map(norm)
}

/**
 * A meeting a human still has to decide about: it is in the past and nobody has said whether it
 * happened. No machine may assert `no_show` (see the header), so `scheduled` on a past row is not a
 * state, it is an open question - and left alone it quietly inflates the held-meeting count.
 */
export function needsOutcome(m: CrmMeeting, now: number = Date.now()): boolean {
  return m.outcome === 'scheduled' && new Date(m.scheduled_at).getTime() < now
}

/**
 * Every meeting waiting on a human: no account (the sync could not attribute it), or past and still
 * `scheduled`. The mirror of readCrmRevenueQueue - one list, one queue, and the reason the sync is
 * allowed to write an unmatched row instead of dropping it.
 */
export async function readCrmMeetingQueue(): Promise<CrmMeeting[]> {
  const rows = await readCrmMeetings({})
  return rows.filter((m) => m.account_id === null || needsOutcome(m))
}

export async function readCrmMeeting(id: string): Promise<CrmMeeting | null> {
  const row = await readRecord<CrmMeeting>(CRM_MEETINGS, { id })
  return row ? norm(row) : null
}

/**
 * Create or partially update a meeting. Provided fields overwrite; the rest keep their stored value.
 *
 * A provider row (`calendar` / `transcript`) refuses the provider-owned columns outright rather than
 * accepting and silently reverting them on the next sync: an accepted write that vanishes overnight
 * is the single most trust-destroying thing this table could do, and the error message names the
 * alternative (`notes`).
 */
export async function upsertCrmMeeting(input: CrmMeetingInput): Promise<CrmMeeting> {
  assertValidId(input.id)
  const prev = await readCrmMeeting(input.id)

  // SOURCE IS THE ROW'S, NOT THE CALLER'S, once the row exists. Reading it from the input first let
  // `{ id: 'gcal:x', source: 'manual', scheduled_at }` convert a calendar row into a manual one and
  // then write every provider-owned column through the refusal below - and `upsertImportedMeeting`
  // would refuse that row on every later sync ("exists as a manual row"), so the calendar silently
  // stopped maintaining a meeting it still owns. A contradicting `source` is REFUSED rather than
  // ignored: quietly dropping a field the caller set is the same broken promise as reverting it.
  const source = prev ? prev.source : (input.source ?? 'manual')
  if (prev && input.source !== undefined && input.source !== prev.source) {
    throw new Error(
      `crm meeting ${input.id}: source is ${prev.source} and cannot be changed to ${input.source} - it names where the row comes from, and the ${prev.source} sync would keep re-asserting it. Delete the row and re-key it if it really is a hand-entered call.`,
    )
  }
  if (source !== 'manual') {
    const refused = (['scheduled_at', 'duration_min', 'attendee_email', 'title'] as const).filter(
      (k) => input[k] !== undefined,
    )
    if (refused.length) {
      throw new Error(
        `crm meeting ${input.id}: ${refused.join(', ')} ${refused.length > 1 ? 'are' : 'is'} owned by the ${source} sync and would be reverted on its next run - put the correction in notes, or fix it at the source`,
      )
    }
  }

  // An account_id that does not resolve is the failure this table exists to avoid: the row would
  // silently leave the assign queue and join nothing.
  const accountId = clearable(input.account_id)
  if (accountId) {
    if (!(await readRecord<CrmAccount>(CRM_ACCOUNTS, { id: accountId }))) {
      throw new Error(`crm meeting ${input.id}: account "${accountId}" does not exist`)
    }
  }
  const contactId = clearable(input.contact_id)
  if (contactId) {
    const contact = await readRecord<CrmContact>(CRM_CONTACTS, { id: contactId })
    if (!contact) throw new Error(`crm meeting ${input.id}: contact "${contactId}" does not exist`)
    const effAccount = accountId !== undefined ? accountId : (prev?.account_id ?? null)
    if (effAccount && contact.account_id !== effAccount) {
      throw new Error(
        `crm meeting ${input.id}: contact "${contactId}" belongs to account "${contact.account_id}", not "${effAccount}"`,
      )
    }
  }

  if (input.duration_min != null && input.duration_min < 0) {
    throw new Error(`crm meeting ${input.id}: duration_min cannot be negative`)
  }

  const scheduledAt = normalizeTimestamp(input.scheduled_at, 'scheduled_at')
  const effScheduled = scheduledAt ?? prev?.scheduled_at
  if (!effScheduled) throw new Error(`crm meeting ${input.id}: scheduled_at is required on create`)

  // A human assignment is TERMINAL - `matched_by: 'manual'` is what tells the next sync run to leave
  // account_id alone. Without this stamp the matcher would re-derive it and undo the human.
  const assigned = accountId !== undefined && accountId !== (prev?.account_id ?? null)

  await upsertRecord<CrmMeeting>(
    CRM_MEETINGS,
    {
      id: input.id,
      account_id: accountId !== undefined ? accountId : (prev?.account_id ?? null),
      contact_id: contactId !== undefined ? contactId : (prev?.contact_id ?? null),
      kind: input.kind ?? prev?.kind ?? 'other',
      scheduled_at: effScheduled,
      duration_min: input.duration_min !== undefined ? input.duration_min : (prev?.duration_min ?? null),
      outcome: input.outcome ?? prev?.outcome ?? 'scheduled',
      rescheduled_count: prev?.rescheduled_count ?? 0,
      source,
      external_id: prev?.external_id ?? null,
      meet_code: prev?.meet_code ?? null,
      attendee_email:
        input.attendee_email !== undefined ? clearable(input.attendee_email)! : (prev?.attendee_email ?? null),
      title: input.title ?? prev?.title ?? '',
      matched_by: assigned ? 'manual' : (prev?.matched_by ?? null),
      notes: input.notes ?? prev?.notes ?? '',
      external: prev?.external ?? {},
      first_seen_at: prev?.first_seen_at ?? new Date().toISOString(),
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev: prev ?? undefined },
  )
  return (await readCrmMeeting(input.id))!
}

// --- the machine path (F6) ------------------------------------------------------------------------

/** A machine row is keyed on the source's own id, prefixed, so it can never collide with a human's
 *  manual slug - and so `deleteCrmMeeting` can tell the two apart when it warns about re-import. */
const MACHINE_MEETING_ID = /^(gcal|meet):\S+$/

/**
 * The MACHINE path: what `crm-sync-calendar` and the transcript backfill write through. Not an MCP
 * tool (F6) - nothing a model or a human types can reach it. Three rules carry the weight, each
 * guarding a number the Sales Machine report shows:
 *
 *   • PROVIDER columns are re-asserted every run; the Box seeds (`account_id`, `contact_id`,
 *     `matched_by`, `kind`, `notes`) are written only while the row has NEVER carried a value.
 *     "Never" is judged on the stored row rather than on insert-vs-update, and that is deliberate:
 *     a row the matcher could not attribute is re-matchable on a later run once a contact gains the
 *     attendee's email (the whole reason `attendee_email` is kept raw), while a row a human touched -
 *     `matched_by: 'manual'`, whether they assigned it or cleared it - is never re-derived. `kind`
 *     and `notes` are non-null by schema, so for them "never carried a value" simply means insert.
 *   • `outcome` is asserted by VALUE, not by class. `held` and `cancelled` are evidence and the
 *     machine writes them; `scheduled` is the ABSENCE of evidence and never overwrites `held` - a
 *     nightly run on a box that cannot see the transcript archive would otherwise demote every
 *     backfilled meeting straight back into the queue. Nor does `cancelled` overwrite `held`:
 *     cancelling a recurring series marks its past, already-held instances cancelled too. `no_show`
 *     is a human's word: refused as input, and never overwritten once a human set it.
 *   • A moved `scheduled_at` is the SAME row: `rescheduled_count` bumps and the prior time is
 *     appended to `external.rescheduled_from[]`, a key this writer owns inside the provider's bag
 *     and carries across runs whatever bag the caller sends.
 *
 * Unchanged data does not write at all (sameRecord): a re-run is a no-op down to `updated_at` and
 * `updated_by`, so the stamps keep naming the last REAL change rather than "the sync, last night".
 */
export async function upsertImportedMeeting(input: CrmImportedMeetingInput): Promise<CrmImportedMeetingResult> {
  const id = input.id
  assertValidId(id)
  if (!MACHINE_MEETING_ID.test(id)) {
    throw new Error(
      `crm meeting ${id}: a machine row is keyed "gcal:<calendar event id>" or "meet:<meet code>:<yyyymmdd>" - a slug is the human path's (upsertCrmMeeting)`,
    )
  }
  const source = input.source as CrmMeetingSource
  if (source !== 'calendar' && source !== 'transcript') {
    throw new Error(`crm meeting ${id}: source must be calendar or transcript - a manual row is the human path's`)
  }
  // The type already cannot spell it; this is for the caller that maps a calendar payload and casts.
  const offeredOutcome = input.outcome as CrmMeetingOutcome | undefined
  if (offeredOutcome === 'no_show') {
    throw new Error(
      `crm meeting ${id}: no machine may assert no_show - a past event with no transcript is either a no-show or a call held somewhere that does not record; leave it scheduled and a human decides`,
    )
  }
  if (input.duration_min != null && input.duration_min < 0) {
    throw new Error(`crm meeting ${id}: duration_min cannot be negative`)
  }
  if (!input.scheduled_at) throw new Error(`crm meeting ${id}: scheduled_at is required`)
  const scheduledAt = normalizeTimestamp(input.scheduled_at, 'scheduled_at')!

  const prev = await readCrmMeeting(id)
  if (prev?.source === 'manual') {
    throw new Error(
      `crm meeting ${id}: exists as a manual row - a machine cannot take over a human's row; delete it, or re-key the manual one`,
    )
  }

  // --- attribution: seeded once, on a row nobody has attributed yet -----------------------------
  const offeredAccount = clearable(input.account_id) ?? null
  const offeredContact = clearable(input.contact_id) ?? null
  const offeredMatchedBy = (input.matched_by ?? null) as CrmMeetingMatchedBy | null
  if (offeredMatchedBy === 'manual') {
    throw new Error(`crm meeting ${id}: matched_by 'manual' is the human path's stamp - a machine names its own rubric (contact_email, domain, title)`)
  }
  if (offeredMatchedBy !== null && !CRM_MEETING_MATCHED_BY.includes(offeredMatchedBy)) {
    throw new Error(`crm meeting ${id}: unknown matched_by "${offeredMatchedBy}"`)
  }
  if ((offeredAccount === null) !== (offeredMatchedBy === null)) {
    throw new Error(`crm meeting ${id}: account_id and matched_by come together - an attribution without its rubric is not queryable, and a rubric without an account is nothing`)
  }
  if (offeredContact && !offeredAccount) {
    throw new Error(`crm meeting ${id}: contact_id needs account_id - a contact belongs to an account`)
  }
  const untouched = prev === null || (prev.account_id === null && prev.matched_by === null)
  let accountId = prev?.account_id ?? null
  let contactId = prev?.contact_id ?? null
  let matchedBy = prev?.matched_by ?? null
  if (untouched && offeredAccount) {
    if (!(await readRecord<CrmAccount>(CRM_ACCOUNTS, { id: offeredAccount }))) {
      throw new Error(`crm meeting ${id}: account "${offeredAccount}" does not exist`)
    }
    if (offeredContact) {
      const contact = await readRecord<CrmContact>(CRM_CONTACTS, { id: offeredContact })
      if (!contact) throw new Error(`crm meeting ${id}: contact "${offeredContact}" does not exist`)
      if (contact.account_id !== offeredAccount) {
        throw new Error(
          `crm meeting ${id}: contact "${offeredContact}" belongs to account "${contact.account_id}", not "${offeredAccount}"`,
        )
      }
    }
    accountId = offeredAccount
    contactId = offeredContact
    matchedBy = offeredMatchedBy
  }

  // --- outcome, by value --------------------------------------------------------------------------
  let outcome: CrmMeetingOutcome = prev?.outcome ?? 'scheduled'
  if (offeredOutcome !== undefined && prev?.outcome !== 'no_show' && prev?.outcome !== 'held') {
    outcome = offeredOutcome
  }

  // --- reschedule: the same row, at the precision the column stores -------------------------------
  // Compared at whole seconds because that is what a TIMESTAMP write keeps; an ISO input carrying
  // milliseconds would otherwise read as a move on every run and count up forever.
  const moved = prev !== null && toNaiveUtc(prev.scheduled_at) !== toNaiveUtc(scheduledAt)
  const priorTimes = Array.isArray(prev?.external.rescheduled_from) ? (prev.external.rescheduled_from as unknown[]) : []
  const rescheduledFrom = moved ? [...priorTimes, prev.scheduled_at] : priorTimes
  const providerBag = input.external !== undefined ? { ...bag(input.external) } : { ...prev?.external }
  delete providerBag.rescheduled_from // the writer's key, never the caller's
  const external = rescheduledFrom.length ? { ...providerBag, rescheduled_from: rescheduledFrom } : providerBag

  const next = {
    id,
    account_id: accountId,
    contact_id: contactId,
    kind: prev?.kind ?? input.kind ?? 'other',
    scheduled_at: scheduledAt,
    duration_min: input.duration_min !== undefined ? input.duration_min : (prev?.duration_min ?? null),
    outcome,
    rescheduled_count: (prev?.rescheduled_count ?? 0) + (moved ? 1 : 0),
    source,
    external_id: input.external_id !== undefined ? (clearable(input.external_id) ?? null) : (prev?.external_id ?? null),
    meet_code: input.meet_code !== undefined ? (clearable(input.meet_code) ?? null) : (prev?.meet_code ?? null),
    attendee_email:
      input.attendee_email !== undefined ? (clearable(input.attendee_email) ?? null) : (prev?.attendee_email ?? null),
    title: input.title !== undefined ? input.title : (prev?.title ?? ''),
    matched_by: matchedBy,
    notes: prev?.notes ?? input.notes ?? '',
    external,
    first_seen_at: prev?.first_seen_at ?? new Date().toISOString(),
  }

  if (prev && sameRecord(CRM_MEETINGS, prev, next)) return { op: 'unchanged', meeting: prev, rescheduled: false }
  await upsertRecord<CrmMeeting>(CRM_MEETINGS, { ...next, ...(input.actor ? { actor: input.actor } : {}) }, { prev })
  return { op: prev ? 'updated' : 'inserted', meeting: (await readCrmMeeting(id))!, rescheduled: moved }
}

/**
 * Delete a meeting. Machines mark `cancelled` and never delete, so this is always a human undoing a
 * mistake - and a calendar row still on the calendar comes straight back on the next run, which is
 * what the report says rather than leaving someone to rediscover it.
 */
export async function deleteCrmMeeting(id: string): Promise<CrmEventDeleteReport> {
  const row = await readCrmMeeting(id)
  if (!row) return { id, deleted: false, account_id: null, will_reimport: false, warnings: [`no meeting "${id}"`] }
  const willReimport = row.source === 'calendar'
  await deleteRecord(CRM_MEETINGS, { id })
  return {
    id,
    deleted: true,
    account_id: row.account_id,
    will_reimport: willReimport,
    warnings: willReimport
      ? [
          `"${row.title || id}" came from the calendar and will be re-created on the next crm-sync-calendar run - mark it cancelled instead if you want it gone for good`,
        ]
      : [],
  }
}
