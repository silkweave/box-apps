// Read/write `crm_revenue_events`. Row↔domain plumbing comes from the record layer, driven by the
// CRM_REVENUE_EVENTS ModelSpec; this module keeps the domain semantics that a schema cannot state.
//
// Four rules carry the weight, and each one exists because its absence corrupts a number the board
// report already shows. The full argument is on the ModelSpec; the short version:
//
//   1. `kind` is NEVER inferred. The sync may not write it on an existing row at all. Inferring
//      one_off from "no subscription association" reported $9,030 against a true $450.
//   2. THE COVERAGE WINDOW IS STORED. `covers_from`/`covers_to` are seeded from paid_at +
//      period_months and are then a human's to correct. Deriving them makes a late renewal look like
//      churn followed by NEW BUSINESS, which is the worst direction to be wrong in.
//   3. `amount_usd` IS FROZEN at issued_at's rate. Collections get their own column at paid_at's
//      rate. One column would make a re-run of last quarter's receivables report print new numbers.
//   4. A SUPERSEDED ROW IS HIDDEN BY DEFAULT, here, once - not deduplicated by every consumer.

import { readRecord, readRecords, deleteRecord, sameRecord, upsertRecord } from '../../warehouse/model.js'
import { CRM_ACCOUNTS, CRM_REVENUE_EVENTS } from './models.js'
import {
  CRM_REVENUE_MATCHED_BY,
  type CrmAccount,
  type CrmEventDeleteReport,
  type CrmImportedRevenueEventInput,
  type CrmImportedRevenueEventResult,
  type CrmRevenueEvent,
  type CrmRevenueEventInput,
  type CrmRevenueMatchedBy,
  type CrmRevenueProvider,
} from './types.js'

const bag = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const norm = (e: CrmRevenueEvent): CrmRevenueEvent => ({ ...e, external: bag(e.external) })

const clearable = (v: string | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim()

function assertValidId(id: string): void {
  if (!id || id.trim() !== id || /\s/.test(id) || id.includes('/') || id.length > 200) {
    throw new Error(`crm revenue event: invalid id "${id}" - no whitespace, no "/", max 200 characters`)
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100

function normalizeDate(v: string | null | undefined, field: string): string | null | undefined {
  const s = clearable(v)
  if (s === undefined || s === null) return s
  const day = s.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`crm revenue event: invalid ${field} "${v}" - use YYYY-MM-DD`)
  return day
}

/** Add whole months to a 'YYYY-MM-DD', clamping the day into the target month (31 Jan + 1 = 28 Feb). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const target = new Date(Date.UTC(y, m - 1 + months, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d, lastDay))
  return target.toISOString().slice(0, 10)
}

export interface CrmRevenueFilter {
  account_id?: string
  since?: string
  status?: CrmRevenueEvent['status']
  kind?: CrmRevenueEvent['kind']
  unassigned?: boolean
  /**
   * Show rows replaced by a later provider's copy of the same invoice. Default false, and that
   * default is the point (design call 3): during the HubSpot->Stripe cutover one invoice is two
   * rows, and every consumer deduplicating for itself is how two reports start disagreeing.
   */
  include_superseded?: boolean
}

export async function readCrmRevenueEvents(filter: CrmRevenueFilter = {}): Promise<CrmRevenueEvent[]> {
  const where: string[] = []
  const params: (string | number)[] = []
  if (!filter.include_superseded) where.push('superseded_by IS NULL')
  if (filter.unassigned) where.push('account_id IS NULL')
  else if (filter.account_id) {
    where.push('account_id = ?')
    params.push(filter.account_id)
  }
  if (filter.since) {
    where.push('issued_at >= ?')
    params.push(filter.since.slice(0, 10))
  }
  if (filter.status) {
    where.push('status = ?')
    params.push(filter.status)
  }
  if (filter.kind) {
    where.push('kind = ?')
    params.push(filter.kind)
  }
  const rows = await readRecords<CrmRevenueEvent>(CRM_REVENUE_EVENTS, {
    ...(where.length ? { where: where.join(' AND '), params } : {}),
    orderBy: 'issued_at DESC, id',
  })
  return rows.map(norm)
}

export async function readCrmRevenueEvent(id: string): Promise<CrmRevenueEvent | null> {
  const row = await readRecord<CrmRevenueEvent>(CRM_REVENUE_EVENTS, { id })
  return row ? norm(row) : null
}

/**
 * A `paid` `recurring` row with no coverage window cannot be walked, forecast or billed from - and
 * the failure is SILENT and twelve-fold: a 12-month prepay that arrived with no subscription object
 * behind it reads as a one-month payment, and one was dropped from a shipped report before a human
 * caught it by eye.
 *
 * So it is a validation failure that lands in the assign queue, never a default. This predicate is
 * what the queue and the run summary both ask.
 */
export function needsCoverage(e: CrmRevenueEvent): boolean {
  return e.status === 'paid' && e.kind === 'recurring' && (!e.covers_from || !e.covers_to)
}

/** Every row that cannot be walked: no account, or no coverage window. One list, one queue. */
export async function readCrmRevenueQueue(): Promise<CrmRevenueEvent[]> {
  const rows = await readCrmRevenueEvents({})
  return rows.filter((e) => e.account_id === null || needsCoverage(e))
}

/**
 * Create or partially update a revenue event.
 *
 * Provider rows expose only the Box columns plus the coverage window; a manual row (a bank transfer
 * with no invoice anywhere, which is how the largest payments in the book arrive) is fully writable.
 */
export async function upsertCrmRevenueEvent(input: CrmRevenueEventInput): Promise<CrmRevenueEvent> {
  const id = input.id
  assertValidId(id)
  const prev = await readCrmRevenueEvent(id)
  const provider = input.provider ?? prev?.provider ?? 'manual'

  // The human path creates `manual` rows ONLY. A provider row is the machine writer's to create
  // (upsertImportedRevenueEvent), because only it can populate the external ids that make the row
  // idempotent - a hand-made `hubspot:inv:...` row would be silently overwritten, or worse
  // duplicated, on the fetcher's first run.
  if (!prev && provider !== 'manual') {
    throw new Error(
      `crm revenue event ${id}: cannot hand-create a ${provider} row - that is the ${provider} sync's job. Use provider 'manual' to record a payment the sync cannot see (a bank transfer with no invoice), which is what manual is for.`,
    )
  }
  if (provider !== 'manual') {
    const owned = ['status', 'amount', 'currency', 'fx_rate', 'issued_at', 'due_at', 'paid_at', 'refunded_at', 'payer_email', 'invoice_number', 'description'] as const
    const refused = owned.filter((k) => input[k] !== undefined)
    if (refused.length) {
      throw new Error(
        `crm revenue event ${id}: ${refused.join(', ')} ${refused.length > 1 ? 'are' : 'is'} owned by the ${provider} sync and would be reverted on its next run - put the correction in notes, or fix it in ${provider}`,
      )
    }
  }

  const accountId = clearable(input.account_id)
  if (accountId && !(await readRecord<CrmAccount>(CRM_ACCOUNTS, { id: accountId }))) {
    throw new Error(`crm revenue event ${id}: account "${accountId}" does not exist`)
  }

  const amount = input.amount !== undefined ? input.amount : (prev?.amount ?? null)
  if (amount == null) throw new Error(`crm revenue event ${id}: amount is required on create`)
  if (amount < 0) {
    throw new Error(`crm revenue event ${id}: amount cannot be negative - a refund is status 'refunded', not a negative row`)
  }
  const currency = (input.currency ?? prev?.currency ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`crm revenue event ${id}: currency must be an ISO 4217 code (USD, SGD) - never assumed`)
  }
  // Never a silent 1.0 on a non-USD row: that is the Sleek provider's rule, and a missing rate that
  // defaults to parity understates SGD revenue by ~25% without a single warning.
  const fxRate = input.fx_rate !== undefined ? input.fx_rate : (prev?.fx_rate ?? (currency === 'USD' ? 1 : null))
  if (fxRate == null || fxRate <= 0) {
    throw new Error(`crm revenue event ${id}: ${currency} needs an explicit positive fx_rate (USD per ${currency})`)
  }

  const issuedAt = normalizeDate(input.issued_at, 'issued_at') ?? prev?.issued_at
  if (!issuedAt) throw new Error(`crm revenue event ${id}: issued_at is required on create`)
  const paidAt = input.paid_at !== undefined ? normalizeDate(input.paid_at, 'paid_at')! : (prev?.paid_at ?? null)
  const status = input.status ?? prev?.status ?? (paidAt ? 'paid' : 'open')
  if (status === 'paid' && !paidAt) {
    throw new Error(`crm revenue event ${id}: a paid row needs paid_at - the MRR walk buckets on it, never on issued_at`)
  }

  const kind = input.kind ?? prev?.kind ?? 'recurring'
  const periodMonths = input.period_months !== undefined ? input.period_months : (prev?.period_months ?? null)
  if (periodMonths != null && periodMonths <= 0) {
    throw new Error(`crm revenue event ${id}: period_months must be positive`)
  }

  // Coverage: seed it once from the payment, then never touch it again. Re-seeding on every write
  // would silently undo the human correction that is the whole reason the column is stored.
  let coversFrom = input.covers_from !== undefined ? normalizeDate(input.covers_from, 'covers_from')! : (prev?.covers_from ?? null)
  let coversTo = input.covers_to !== undefined ? normalizeDate(input.covers_to, 'covers_to')! : (prev?.covers_to ?? null)
  if (!coversFrom && !coversTo && kind === 'recurring' && paidAt && periodMonths) {
    coversFrom = paidAt
    coversTo = addMonths(paidAt, periodMonths)
  }
  if (coversFrom && coversTo && coversTo <= coversFrom) {
    throw new Error(`crm revenue event ${id}: covers_to (${coversTo}) must be after covers_from (${coversFrom})`)
  }

  // amount_usd frozen at issued_at's rate; collected_usd struck at paid_at's rate when the money
  // lands. Two flows, two months, two rates - one column would rewrite history on every re-run.
  //
  // WHAT IS FROZEN IS THE RATE, NOT THE VALUE - the machine path's rule (`amountUsd = amount x the
  // rate frozen on first sight`, recomputed every run), and this path now holds it too. Freezing the
  // VALUE meant a later `amount` or `fx_rate` edit left `amount_usd` behind, so the row contradicted
  // itself in the one column that exists to stop exactly that. The comment here used to name "a new
  // row plus superseded_by" as the correction path, but `CrmRevenueEventInput` has no
  // `superseded_by`, so the documented fix did not exist for a human.
  //
  // Only a MANUAL row recomputes, and the guard is doing real work: a provider row refuses `amount`
  // and `fx_rate` outright (above), so it has nothing to recompute from - and its `collected_usd`
  // was struck by the machine at the PAID month's rate, which is not `amount x fx_rate` and must not
  // be overwritten with it. "A re-run must not print new history" is untouched: a re-run does not
  // reach this path at all, and a human editing an amount is not a re-run.
  //
  // KNOWN GAP for the human path: when paid_at falls in a different FX month from issued_at, this
  // strikes collected_usd at issued_at's rate because the DTO carries only one. That is right for
  // the common case (same-month payment, and every USD row) and wrong for a late-paid non-USD
  // invoice. upsertImportedRevenueEvent passes the paid-month rate explicitly; until this DTO does
  // too, such a row needs its collected value checked by hand. Flagged, not silently approximated.
  const manual = provider === 'manual'
  const converted = Math.round(amount * fxRate * 100) / 100
  const amountUsd = manual ? converted : (prev?.amount_usd ?? converted)
  const collectedUsd =
    status === 'paid' || status === 'refunded' ? (manual ? converted : (prev?.collected_usd ?? converted)) : null

  const assigned = accountId !== undefined && accountId !== (prev?.account_id ?? null)

  await upsertRecord<CrmRevenueEvent>(
    CRM_REVENUE_EVENTS,
    {
      id,
      account_id: accountId !== undefined ? accountId : (prev?.account_id ?? null),
      provider,
      kind,
      status,
      amount,
      currency,
      amount_usd: amountUsd,
      collected_usd: collectedUsd,
      fx_rate: fxRate,
      fx_rate_month: prev?.fx_rate_month ?? issuedAt.slice(0, 7),
      issued_at: issuedAt,
      due_at: input.due_at !== undefined ? normalizeDate(input.due_at, 'due_at')! : (prev?.due_at ?? null),
      paid_at: paidAt,
      refunded_at:
        input.refunded_at !== undefined ? normalizeDate(input.refunded_at, 'refunded_at')! : (prev?.refunded_at ?? null),
      period_months: periodMonths,
      covers_from: coversFrom,
      covers_to: coversTo,
      payer_email: input.payer_email !== undefined ? clearable(input.payer_email)! : (prev?.payer_email ?? null),
      external_invoice_id: prev?.external_invoice_id ?? null,
      invoice_number: input.invoice_number !== undefined ? clearable(input.invoice_number)! : (prev?.invoice_number ?? null),
      external_payment_id: prev?.external_payment_id ?? null,
      external_subscription_id: prev?.external_subscription_id ?? null,
      superseded_by: prev?.superseded_by ?? null,
      description: input.description ?? prev?.description ?? '',
      matched_by: assigned ? 'manual' : (prev?.matched_by ?? null),
      notes: input.notes ?? prev?.notes ?? '',
      external: prev?.external ?? {},
      first_seen_at: prev?.first_seen_at ?? new Date().toISOString(),
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev: prev ?? undefined },
  )
  return (await readCrmRevenueEvent(id))!
}

// --- the machine path (F6) ------------------------------------------------------------------------

/**
 * The MACHINE path: the one writer `crm-sync-payments` and the all-time backfill map onto, for
 * HubSpot now and Stripe at cutover (the provider is a value on the row, not a branch in here).
 * Not an MCP tool (F6). The rules, each against the number it protects:
 *
 *   • PROVIDER columns are re-asserted every run. The Box seeds (`account_id` + `matched_by`,
 *     `period_months`, `covers_from`/`covers_to`, `notes`) are written only while the row has NEVER
 *     carried a value - judged on the stored row, not on insert-vs-update, because the row's main
 *     life is an UPDATE: an invoice is first seen `open` with no `paid_at`, so its coverage window
 *     can only be struck on the later run that sees it paid. A window a human backdated, a
 *     `period_months` a human set, an account a human assigned or cleared (`matched_by: 'manual'`)
 *     are never touched again. An unattributed row IS re-matchable on a later run.
 *   • `kind` is not in the input at all. It is `recurring` on insert and a human's word thereafter
 *     (the "no subscription = one_off" rule reported $9,030 against a true $450).
 *   • FX is explicit and frozen. `fx_rate` is required for a non-USD row on insert and is never
 *     moved by a later run, so `amount_usd` = `amount` x that frozen rate cannot drift when the rate
 *     table is refined - a receivables report re-run next quarter prints the same history.
 *     `collected_usd` is struck ONCE, the first run that sees the row paid, at `paid_at`'s month:
 *     `fx_rate_paid` when given, the frozen `fx_rate` when the paid month IS the frozen month (by
 *     definition the same table entry), and otherwise a throw. Never a silent 1.0 and never a
 *     silent reuse of another month's rate - the Sleek provider's rule, because a missing rate that
 *     defaults to parity understates SGD revenue by ~25% without a single warning.
 *   • `superseded_by` is set on the OLDER provider's row at cutover and is kept unless given, so the
 *     retired fetcher's history runs never clear it.
 *
 * Unchanged data does not write (sameRecord): a re-run is a no-op down to the audit stamps.
 */
export async function upsertImportedRevenueEvent(
  input: CrmImportedRevenueEventInput,
): Promise<CrmImportedRevenueEventResult> {
  const id = input.id
  assertValidId(id)
  const provider = input.provider as CrmRevenueProvider
  if (provider !== 'hubspot' && provider !== 'stripe') {
    throw new Error(`crm revenue event ${id}: provider must be hubspot or stripe - a manual row is the human path's (upsertCrmRevenueEvent)`)
  }
  if (!id.startsWith(`${provider}:`) || id.length <= provider.length + 1) {
    throw new Error(
      `crm revenue event ${id}: a ${provider} row is keyed "${provider}:inv:<id>" / "${provider}:pay:<id>" - the prefix is what keeps the two eras of one invoice apart`,
    )
  }
  const prev = await readCrmRevenueEvent(id)
  if (prev?.provider === 'manual') {
    throw new Error(`crm revenue event ${id}: exists as a manual row - a machine cannot take over a human's row; delete it, or re-key the manual one`)
  }

  // --- the provider's facts ---------------------------------------------------------------------
  const amount = input.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error(`crm revenue event ${id}: amount is required`)
  if (amount < 0) {
    throw new Error(`crm revenue event ${id}: amount cannot be negative - a refund is status 'refunded', not a negative row`)
  }
  const currency = (input.currency ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`crm revenue event ${id}: currency must be an ISO 4217 code (USD, SGD) - never assumed`)
  }
  // The frozen rate is a rate FOR a currency; a row that changes currency would keep converting
  // with the wrong one. Finalised invoices are immutable upstream, so this is a fetcher bug.
  if (prev && prev.currency !== currency) {
    throw new Error(`crm revenue event ${id}: currency changed from ${prev.currency} to ${currency} on an existing row - void and re-issue upstream, or delete the row`)
  }
  const issuedAt = normalizeDate(input.issued_at, 'issued_at')
  if (!issuedAt) throw new Error(`crm revenue event ${id}: issued_at is required`)
  const dueAt = input.due_at !== undefined ? normalizeDate(input.due_at, 'due_at')! : (prev?.due_at ?? null)
  const paidAt = input.paid_at !== undefined ? normalizeDate(input.paid_at, 'paid_at')! : (prev?.paid_at ?? null)
  const refundedAt =
    input.refunded_at !== undefined ? normalizeDate(input.refunded_at, 'refunded_at')! : (prev?.refunded_at ?? null)
  const status = input.status
  if (status === 'paid' && !paidAt) {
    throw new Error(`crm revenue event ${id}: a paid row needs paid_at - the MRR walk buckets on it, never on issued_at`)
  }

  // --- FX: frozen at first sight ----------------------------------------------------------------
  let fxRate: number
  let fxMonth: string
  if (prev) {
    fxRate = prev.fx_rate
    fxMonth = prev.fx_rate_month ?? prev.issued_at.slice(0, 7)
  } else if (currency === 'USD') {
    if (input.fx_rate != null && input.fx_rate !== 1) {
      throw new Error(`crm revenue event ${id}: a USD row's fx_rate is 1 by definition (got ${input.fx_rate}) - a scaled USD row is a caller bug`)
    }
    fxRate = 1
    fxMonth = issuedAt.slice(0, 7)
  } else {
    if (input.fx_rate == null || !(input.fx_rate > 0)) {
      throw new Error(
        `crm revenue event ${id}: ${currency} needs an explicit positive fx_rate (USD per ${currency}) for ${issuedAt.slice(0, 7)} - never a silent 1.0`,
      )
    }
    fxRate = input.fx_rate
    fxMonth = issuedAt.slice(0, 7)
  }
  const amountUsd = round2(amount * fxRate)

  let collectedUsd: number | null = null
  if ((status === 'paid' || status === 'refunded') && paidAt) {
    if (prev?.collected_usd != null) {
      collectedUsd = prev.collected_usd
    } else {
      const paidMonth = paidAt.slice(0, 7)
      let paidRate: number
      if (currency === 'USD') {
        if (input.fx_rate_paid != null && input.fx_rate_paid !== 1) {
          throw new Error(`crm revenue event ${id}: a USD row's fx_rate_paid is 1 by definition (got ${input.fx_rate_paid})`)
        }
        paidRate = 1
      } else if (input.fx_rate_paid != null) {
        if (!(input.fx_rate_paid > 0)) throw new Error(`crm revenue event ${id}: fx_rate_paid must be positive`)
        paidRate = input.fx_rate_paid
      } else if (paidMonth === fxMonth) {
        paidRate = fxRate
      } else {
        throw new Error(
          `crm revenue event ${id}: paid in ${paidMonth} against a rate frozen for ${fxMonth} - pass fx_rate_paid (USD per ${currency}) for ${paidMonth}; collected_usd is struck at the month the money landed, never at another month's rate`,
        )
      }
      collectedUsd = round2(amount * paidRate)
    }
  }

  // --- attribution: seeded once, on a row nobody has attributed yet -----------------------------
  const offeredAccount = clearable(input.account_id) ?? null
  const offeredMatchedBy = (input.matched_by ?? null) as CrmRevenueMatchedBy | null
  if (offeredMatchedBy === 'manual') {
    throw new Error(`crm revenue event ${id}: matched_by 'manual' is the human path's stamp - a machine names its own rubric (payer_email, reseller_comment, contact_email, domain)`)
  }
  if (offeredMatchedBy !== null && !CRM_REVENUE_MATCHED_BY.includes(offeredMatchedBy)) {
    throw new Error(`crm revenue event ${id}: unknown matched_by "${offeredMatchedBy}"`)
  }
  if ((offeredAccount === null) !== (offeredMatchedBy === null)) {
    throw new Error(`crm revenue event ${id}: account_id and matched_by come together - an attribution without its rubric is not queryable, and a rubric without an account is nothing`)
  }
  const untouched = prev === null || (prev.account_id === null && prev.matched_by === null)
  let accountId = prev?.account_id ?? null
  let matchedBy = prev?.matched_by ?? null
  if (untouched && offeredAccount) {
    if (!(await readRecord<CrmAccount>(CRM_ACCOUNTS, { id: offeredAccount }))) {
      throw new Error(`crm revenue event ${id}: account "${offeredAccount}" does not exist`)
    }
    accountId = offeredAccount
    matchedBy = offeredMatchedBy
  }

  // --- the other Box seeds ------------------------------------------------------------------------
  const kind = prev?.kind ?? 'recurring'
  if (input.period_months != null && (!Number.isInteger(input.period_months) || input.period_months <= 0)) {
    throw new Error(`crm revenue event ${id}: period_months must be a positive whole number of months`)
  }
  const periodMonths = prev?.period_months ?? input.period_months ?? null

  // Coverage: struck once, then a human's. Seeded from what the provider knows (an explicit
  // window) before what we can compute (paid_at + period_months); a half-set stored window is a
  // human mid-edit and is left alone for needsCoverage to flag.
  let coversFrom = prev?.covers_from ?? null
  let coversTo = prev?.covers_to ?? null
  if (!coversFrom && !coversTo) {
    const offeredFrom = normalizeDate(input.covers_from, 'covers_from') ?? null
    const offeredTo = normalizeDate(input.covers_to, 'covers_to') ?? null
    if ((offeredFrom === null) !== (offeredTo === null)) {
      throw new Error(`crm revenue event ${id}: covers_from and covers_to come together`)
    }
    if (offeredFrom && offeredTo) {
      coversFrom = offeredFrom
      coversTo = offeredTo
    } else if (kind === 'recurring' && paidAt && periodMonths) {
      coversFrom = paidAt
      coversTo = addMonths(paidAt, periodMonths)
    }
  }
  if (coversFrom && coversTo && coversTo <= coversFrom) {
    throw new Error(`crm revenue event ${id}: covers_to (${coversTo}) must be after covers_from (${coversFrom})`)
  }

  // --- cutover -----------------------------------------------------------------------------------
  const supersededBy =
    input.superseded_by !== undefined ? (clearable(input.superseded_by) ?? null) : (prev?.superseded_by ?? null)
  if (supersededBy !== null && supersededBy !== (prev?.superseded_by ?? null)) {
    if (supersededBy === id) throw new Error(`crm revenue event ${id}: a row cannot supersede itself`)
    if (!(await readCrmRevenueEvent(supersededBy))) {
      throw new Error(`crm revenue event ${id}: superseded_by "${supersededBy}" does not exist - write the newer provider's row first`)
    }
  }

  const next = {
    id,
    account_id: accountId,
    provider,
    kind,
    status,
    amount,
    currency,
    amount_usd: amountUsd,
    collected_usd: collectedUsd,
    fx_rate: fxRate,
    fx_rate_month: fxMonth,
    issued_at: issuedAt,
    due_at: dueAt,
    paid_at: paidAt,
    refunded_at: refundedAt,
    period_months: periodMonths,
    covers_from: coversFrom,
    covers_to: coversTo,
    payer_email: input.payer_email !== undefined ? (clearable(input.payer_email) ?? null) : (prev?.payer_email ?? null),
    external_invoice_id:
      input.external_invoice_id !== undefined ? (clearable(input.external_invoice_id) ?? null) : (prev?.external_invoice_id ?? null),
    invoice_number:
      input.invoice_number !== undefined ? (clearable(input.invoice_number) ?? null) : (prev?.invoice_number ?? null),
    external_payment_id:
      input.external_payment_id !== undefined ? (clearable(input.external_payment_id) ?? null) : (prev?.external_payment_id ?? null),
    external_subscription_id:
      input.external_subscription_id !== undefined
        ? (clearable(input.external_subscription_id) ?? null)
        : (prev?.external_subscription_id ?? null),
    superseded_by: supersededBy,
    description: input.description !== undefined ? input.description : (prev?.description ?? ''),
    matched_by: matchedBy,
    notes: prev?.notes ?? input.notes ?? '',
    external: input.external !== undefined ? bag(input.external) : (prev?.external ?? {}),
    first_seen_at: prev?.first_seen_at ?? new Date().toISOString(),
  }

  if (prev && sameRecord(CRM_REVENUE_EVENTS, prev, next)) return { op: 'unchanged', event: prev }
  await upsertRecord<CrmRevenueEvent>(
    CRM_REVENUE_EVENTS,
    { ...next, ...(input.actor ? { actor: input.actor } : {}) },
    { prev },
  )
  return { op: prev ? 'updated' : 'inserted', event: (await readCrmRevenueEvent(id))! }
}

/** Delete a revenue event. Machines mark `voided` and never delete. */
export async function deleteCrmRevenueEvent(id: string): Promise<CrmEventDeleteReport> {
  const row = await readCrmRevenueEvent(id)
  if (!row) return { id, deleted: false, account_id: null, will_reimport: false, warnings: [`no revenue event "${id}"`] }
  const willReimport = row.provider !== 'manual'
  await deleteRecord(CRM_REVENUE_EVENTS, { id })
  return {
    id,
    deleted: true,
    account_id: row.account_id,
    will_reimport: willReimport,
    warnings: willReimport
      ? [`${row.invoice_number ?? id} came from ${row.provider} and will be re-created on the next sync - mark it voided instead if you want it gone for good`]
      : [],
  }
}
