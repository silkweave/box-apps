// The machine write path for revenue events (upsertImportedRevenueEvent), against a throwaway
// warehouse. Each case is a rule from the PRD as a behaviour, and most of them guard a board number:
// kind is never machine-written, amount_usd never drifts, collected_usd is struck at the paid month
// or not at all, the coverage window and a human's assignment survive every run.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  needsCoverage,
  readCrmRevenueEvent,
  readCrmRevenueEvents,
  readCrmRevenueQueue,
  upsertCrmRevenueEvent,
  upsertImportedRevenueEvent,
} from './revenue.js'
import { upsertCrmAccount } from './state.js'
import type { CrmImportedRevenueEventInput } from './types.js'

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'box-crm-revenue-import-'))
  process.env.BOX_DATA_DIR = dir
  await upsertCrmAccount({ id: 'crestline', name: 'Crestline' })
  await upsertCrmAccount({ id: 'larkfield', name: 'Larkfield' })
})

afterAll(() => {
  delete process.env.BOX_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

let seq = 0
const invoice = (over: Partial<CrmImportedRevenueEventInput> = {}): CrmImportedRevenueEventInput => ({
  id: `hubspot:inv:${++seq}`,
  provider: 'hubspot',
  external_invoice_id: 'obj',
  status: 'open',
  amount: 1994,
  currency: 'USD',
  issued_at: '2026-08-19',
  due_at: '2026-09-02',
  invoice_number: 'INV-1042',
  description: '2 seats, quarterly',
  payer_email: 'billing@larkfield.example',
  external: { portal_id: 49012214 },
  account_id: 'larkfield',
  matched_by: 'payer_email',
  period_months: 3,
  ...over,
})

describe('upsertImportedRevenueEvent - insert and idempotency', () => {
  it('inserts an open USD invoice: rate 1, amount_usd struck, nothing collected, kind recurring', async () => {
    const input = invoice()
    const r = await upsertImportedRevenueEvent(input)
    expect(r.op).toBe('inserted')
    expect(r.event).toMatchObject({
      id: input.id,
      provider: 'hubspot',
      status: 'open',
      kind: 'recurring',
      amount: 1994,
      currency: 'USD',
      amount_usd: 1994,
      collected_usd: null,
      fx_rate: 1,
      fx_rate_month: '2026-08',
      issued_at: '2026-08-19',
      due_at: '2026-09-02',
      paid_at: null,
      period_months: 3,
      covers_from: null,
      covers_to: null,
      account_id: 'larkfield',
      matched_by: 'payer_email',
      invoice_number: 'INV-1042',
      external_invoice_id: 'obj',
      superseded_by: null,
      external: { portal_id: 49012214 },
    })
  })

  it('does not write on a second identical run', async () => {
    const input = invoice()
    const first = await upsertImportedRevenueEvent(input)
    const again = await upsertImportedRevenueEvent(input)
    expect(again.op).toBe('unchanged')
    expect(again.event.updated_at).toBe(first.event.updated_at)
  })
})

describe('upsertImportedRevenueEvent - FX is explicit and frozen', () => {
  it('throws on a non-USD row with no rate, a non-positive rate, or a scaled USD row', async () => {
    await expect(upsertImportedRevenueEvent(invoice({ currency: 'SGD', amount: 315 }))).rejects.toThrow(/needs an explicit positive fx_rate/)
    await expect(upsertImportedRevenueEvent(invoice({ currency: 'SGD', amount: 315, fx_rate: 0 }))).rejects.toThrow(/needs an explicit positive fx_rate/)
    await expect(upsertImportedRevenueEvent(invoice({ fx_rate: 0.75 }))).rejects.toThrow(/USD row's fx_rate is 1/)
  })

  it('freezes amount_usd at the first-seen rate: a refined rate table does not rewrite history', async () => {
    const input = invoice({ currency: 'SGD', amount: 2265, issued_at: '2025-12-30', fx_rate: 0.74 })
    const first = await upsertImportedRevenueEvent(input)
    expect(first.event.amount_usd).toBe(1676.1)
    expect(first.event.fx_rate).toBe(0.74)
    expect(first.event.fx_rate_month).toBe('2025-12')

    const rerun = await upsertImportedRevenueEvent({ ...input, fx_rate: 0.78 })
    expect(rerun.op).toBe('unchanged')
    expect(rerun.event.amount_usd).toBe(1676.1)
    expect(rerun.event.fx_rate).toBe(0.74)

    // It is the RATE that is frozen, not the provider's amount: if upstream restates an open
    // invoice, amount_usd follows at the frozen rate so the row never disagrees with itself.
    const restated = await upsertImportedRevenueEvent({ ...input, amount: 2000, fx_rate: 0.78 })
    expect(restated.op).toBe('updated')
    expect(restated.event.amount).toBe(2000)
    expect(restated.event.fx_rate).toBe(0.74)
    expect(restated.event.amount_usd).toBe(1480)
  })

  it('strikes collected_usd once at the paid month: same month reuses the frozen rate, a later month needs fx_rate_paid', async () => {
    const input = invoice({ currency: 'SGD', amount: 315, issued_at: '2026-09-01', fx_rate: 0.78, account_id: 'crestline', period_months: 1 })
    await upsertImportedRevenueEvent(input)

    // Paid in the issue month: the paid rate IS the frozen rate, no second rate needed.
    const sameMonth = await upsertImportedRevenueEvent({ ...input, status: 'paid', paid_at: '2026-09-03', external_payment_id: 'pay-1' })
    expect(sameMonth.op).toBe('updated')
    expect(sameMonth.event.collected_usd).toBe(245.7)
    expect(sameMonth.event.amount_usd).toBe(245.7)
    expect(sameMonth.event.external_payment_id).toBe('pay-1')

    // A different row, paid two months later: silence is a throw, never another month's rate.
    const late = invoice({ currency: 'SGD', amount: 315, issued_at: '2026-09-01', fx_rate: 0.78, account_id: 'crestline', period_months: 1 })
    await upsertImportedRevenueEvent(late)
    await expect(upsertImportedRevenueEvent({ ...late, status: 'paid', paid_at: '2026-11-10' })).rejects.toThrow(/pass fx_rate_paid/)
    const paid = await upsertImportedRevenueEvent({ ...late, status: 'paid', paid_at: '2026-11-10', fx_rate_paid: 0.8 })
    expect(paid.event.amount_usd).toBe(245.7) // issued-month rate, untouched
    expect(paid.event.collected_usd).toBe(252) // paid-month rate

    // And once struck, a later run with yet another rate does not move it.
    const again = await upsertImportedRevenueEvent({ ...late, status: 'paid', paid_at: '2026-11-10', fx_rate_paid: 0.9 })
    expect(again.op).toBe('unchanged')
    expect(again.event.collected_usd).toBe(252)
  })

  it('refuses a currency change on an existing row', async () => {
    const input = invoice()
    await upsertImportedRevenueEvent(input)
    await expect(upsertImportedRevenueEvent({ ...input, currency: 'SGD', fx_rate: 0.75 })).rejects.toThrow(/currency changed/)
  })
})

describe('upsertImportedRevenueEvent - coverage and the A4 queue', () => {
  it('seeds the window from paid_at + period_months on the run that sees the row paid, then never again', async () => {
    const input = invoice({ period_months: 3 })
    await upsertImportedRevenueEvent(input)
    const paid = await upsertImportedRevenueEvent({ ...input, status: 'paid', paid_at: '2026-08-31' })
    expect(paid.event.covers_from).toBe('2026-08-31')
    expect(paid.event.covers_to).toBe('2026-11-30')
    expect(paid.event.collected_usd).toBe(1994)

    // A human backdates the window (the late-renewal correction). The next run keeps it.
    await upsertCrmRevenueEvent({ id: input.id, covers_from: '2026-08-01', covers_to: '2026-11-01' })
    const rerun = await upsertImportedRevenueEvent({ ...input, status: 'paid', paid_at: '2026-08-31' })
    expect(rerun.op).toBe('unchanged')
    expect(rerun.event.covers_from).toBe('2026-08-01')
    expect(rerun.event.covers_to).toBe('2026-11-01')
  })

  it('prefers an explicit provider window over the computed one, both-or-neither', async () => {
    const input = invoice({ provider: 'stripe', id: `stripe:inv:${++seq}`, covers_from: '2026-09-01', covers_to: '2026-12-01' })
    const r = await upsertImportedRevenueEvent(input)
    expect(r.event.covers_from).toBe('2026-09-01')
    expect(r.event.covers_to).toBe('2026-12-01')
    await expect(upsertImportedRevenueEvent(invoice({ covers_from: '2026-09-01', covers_to: null }))).rejects.toThrow(/come together/)
    await expect(upsertImportedRevenueEvent(invoice({ covers_from: '2026-12-01', covers_to: '2026-09-01' }))).rejects.toThrow(/must be after/)
  })

  it('lands a paid recurring row with no period_months in the queue instead of defaulting it', async () => {
    // A 12-month prepay that arrived with no subscription object behind it. A silent default of one
    // month is a 12x error; the honest answer is a queue row a human fills in.
    const input = invoice({
      currency: 'SGD',
      amount: 2265,
      issued_at: '2025-12-30',
      fx_rate: 0.74,
      status: 'paid',
      paid_at: '2025-12-30',
      invoice_number: 'INV-1068',
      account_id: 'crestline',
      period_months: null,
    })
    const r = await upsertImportedRevenueEvent(input)
    expect(r.event.period_months).toBeNull()
    expect(r.event.covers_from).toBeNull()
    expect(needsCoverage(r.event)).toBe(true)
    expect((await readCrmRevenueQueue()).map((e) => e.id)).toContain(input.id)

    // A later run that has learned the period seeds it - the row had never carried one.
    const learned = await upsertImportedRevenueEvent({ ...input, period_months: 12 })
    expect(learned.event.period_months).toBe(12)
    expect(learned.event.covers_to).toBe('2026-12-30')
    expect(needsCoverage(learned.event)).toBe(false)
  })

  it('refuses a paid row without paid_at and a non-integer period', async () => {
    await expect(upsertImportedRevenueEvent(invoice({ status: 'paid' }))).rejects.toThrow(/needs paid_at/)
    await expect(upsertImportedRevenueEvent(invoice({ period_months: 1.5 }))).rejects.toThrow(/positive whole number/)
  })
})

describe('upsertImportedRevenueEvent - the human wins', () => {
  it('never writes kind, and keeps a human one_off, notes, period and account across runs', async () => {
    const input = invoice()
    await upsertImportedRevenueEvent(input)
    await upsertCrmRevenueEvent({ id: input.id, kind: 'one_off', notes: 'extended support, per the operator', period_months: 1, account_id: 'crestline' })

    const r = await upsertImportedRevenueEvent({
      ...input,
      description: 'edited upstream',
      notes: 'the sync has opinions',
      period_months: 12,
      account_id: 'larkfield',
      matched_by: 'payer_email',
    })
    expect(r.op).toBe('updated')
    expect(r.event.description).toBe('edited upstream')
    expect(r.event.kind).toBe('one_off')
    expect(r.event.notes).toBe('extended support, per the operator')
    expect(r.event.period_months).toBe(1)
    expect(r.event.account_id).toBe('crestline')
    expect(r.event.matched_by).toBe('manual')
  })

  it('writes an unmatched row to the queue, fills it once it resolves, and respects a human clearing it', async () => {
    const input = invoice({ account_id: null, matched_by: null, payer_email: 'someone@unknown.example' })
    const first = await upsertImportedRevenueEvent(input)
    expect(first.event.account_id).toBeNull()
    expect((await readCrmRevenueQueue()).map((e) => e.id)).toContain(input.id)

    const matched = await upsertImportedRevenueEvent({ ...input, account_id: 'crestline', matched_by: 'reseller_comment' })
    expect(matched.event).toMatchObject({ account_id: 'crestline', matched_by: 'reseller_comment' })

    await upsertCrmRevenueEvent({ id: input.id, account_id: '' })
    const cleared = await upsertImportedRevenueEvent({ ...input, account_id: 'crestline', matched_by: 'reseller_comment' })
    expect(cleared.op).toBe('unchanged')
    expect(cleared.event.account_id).toBeNull()
    expect(cleared.event.matched_by).toBe('manual')
  })
})

describe('upsertImportedRevenueEvent - the cutover', () => {
  it('hides a superseded HubSpot row by default and keeps the marker through the retired fetcher\'s runs', async () => {
    const hs = invoice({ status: 'paid', paid_at: '2026-08-20', period_months: 3 })
    await upsertImportedRevenueEvent(hs)
    const stripeId = `stripe:inv:${++seq}`
    await upsertImportedRevenueEvent({ ...hs, id: stripeId, provider: 'stripe', external_invoice_id: 'in_123' })

    // Self-reference and a target that is not there yet are both refused.
    await expect(upsertImportedRevenueEvent({ ...hs, superseded_by: hs.id })).rejects.toThrow(/cannot supersede itself/)
    await expect(upsertImportedRevenueEvent({ ...hs, superseded_by: 'stripe:inv:not-yet' })).rejects.toThrow(/does not exist/)

    const marked = await upsertImportedRevenueEvent({ ...hs, superseded_by: stripeId })
    expect(marked.event.superseded_by).toBe(stripeId)
    const visible = (await readCrmRevenueEvents({ account_id: 'larkfield' })).map((e) => e.id)
    expect(visible).toContain(stripeId)
    expect(visible).not.toContain(hs.id)
    expect((await readCrmRevenueEvents({ account_id: 'larkfield', include_superseded: true })).map((e) => e.id)).toContain(hs.id)

    // The HubSpot fetcher, kept runnable for history, does not know about the marker and must not clear it.
    const history = await upsertImportedRevenueEvent(hs)
    expect(history.op).toBe('unchanged')
    expect(history.event.superseded_by).toBe(stripeId)
  })
})

describe('upsertImportedRevenueEvent - refusals', () => {
  it('refuses a manual provider, a mismatched prefix, a negative amount, a manual rubric and a dangling account', async () => {
    await expect(
      upsertImportedRevenueEvent(invoice({ provider: 'manual' as unknown as CrmImportedRevenueEventInput['provider'] })),
    ).rejects.toThrow(/provider must be hubspot or stripe/)
    await expect(upsertImportedRevenueEvent(invoice({ id: 'stripe:inv:9', provider: 'hubspot' }))).rejects.toThrow(/keyed "hubspot:/)
    await expect(upsertImportedRevenueEvent(invoice({ id: 'hubspot:' }))).rejects.toThrow(/keyed "hubspot:/)
    await expect(upsertImportedRevenueEvent(invoice({ amount: -1 }))).rejects.toThrow(/cannot be negative/)
    await expect(
      upsertImportedRevenueEvent(invoice({ matched_by: 'manual' as unknown as CrmImportedRevenueEventInput['matched_by'] })),
    ).rejects.toThrow(/human path's stamp/)
    await expect(upsertImportedRevenueEvent(invoice({ matched_by: null }))).rejects.toThrow(/come together/)
    await expect(upsertImportedRevenueEvent(invoice({ account_id: 'nope' }))).rejects.toThrow(/does not exist/)
  })

  it('refuses to take over a manual row', async () => {
    await upsertCrmRevenueEvent({ id: 'hubspot:inv:hand-made', amount: 100, currency: 'USD', issued_at: '2026-08-01' })
    expect((await readCrmRevenueEvent('hubspot:inv:hand-made'))?.provider).toBe('manual')
    await expect(upsertImportedRevenueEvent(invoice({ id: 'hubspot:inv:hand-made' }))).rejects.toThrow(/exists as a manual row/)
  })
})

describe('upsertCrmRevenueEvent - the RATE is frozen, not the value', () => {
  it('recomputes amount_usd on a manual row when the amount is corrected', async () => {
    const id = 'manual:typo'
    await upsertCrmRevenueEvent({ id, account_id: 'larkfield', amount: 10_000, currency: 'SGD', fx_rate: 0.75, issued_at: '2026-08-01' })
    expect((await readCrmRevenueEvent(id))?.amount_usd).toBe(7500)

    // The bug this pins: amount_usd used to be frozen at its FIRST value, so a corrected amount left
    // the row asserting 10,000 SGD = $7,500 next to an amount of 1,000.
    const r = await upsertCrmRevenueEvent({ id, amount: 1000 })
    expect(r.amount).toBe(1000)
    expect(r.amount_usd).toBe(750)
  })

  it('recomputes when the fx_rate itself is corrected, and moves collected_usd with it', async () => {
    const id = 'manual:bad-rate'
    await upsertCrmRevenueEvent({
      id,
      account_id: 'larkfield',
      amount: 2000,
      currency: 'SGD',
      fx_rate: 1,
      issued_at: '2026-08-01',
      paid_at: '2026-08-20',
      status: 'paid',
    })
    expect((await readCrmRevenueEvent(id))?.collected_usd).toBe(2000)

    const r = await upsertCrmRevenueEvent({ id, fx_rate: 0.78 })
    expect(r.amount_usd).toBe(1560)
    expect(r.collected_usd).toBe(1560)
  })

  it('leaves a PROVIDER row alone - its collected_usd was struck at the paid month, not at fx_rate', async () => {
    // The row is paid in a different FX month, so collected_usd (fx_rate_paid) is deliberately NOT
    // amount x fx_rate. A human touching the Box columns must not restate it.
    const input = invoice({ status: 'paid', currency: 'SGD', fx_rate: 0.75, paid_at: '2026-09-15', fx_rate_paid: 0.8 })
    await upsertImportedRevenueEvent(input)
    const before = await readCrmRevenueEvent(input.id)
    expect(before?.amount_usd).toBe(round2(input.amount * 0.75))
    expect(before?.collected_usd).toBe(round2(input.amount * 0.8))

    await upsertCrmRevenueEvent({ id: input.id, notes: 'checked with the operator' })
    const after = await readCrmRevenueEvent(input.id)
    expect(after?.amount_usd).toBe(before?.amount_usd)
    expect(after?.collected_usd).toBe(before?.collected_usd)
  })
})

const round2 = (n: number): number => Math.round(n * 100) / 100
