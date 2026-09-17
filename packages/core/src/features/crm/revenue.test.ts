// The two pieces of phase-3 revenue arithmetic that silently corrupt a board number when wrong:
// month addition (which seeds every coverage window) and the coverage/FX rules on the row itself.
// Pure functions only - no warehouse.

import { describe, expect, it } from 'vitest'
import { addMonths, needsCoverage } from './revenue.js'
import type { CrmRevenueEvent } from './types.js'

describe('addMonths', () => {
  it('adds whole months', () => {
    expect(addMonths('2026-01-15', 3)).toBe('2026-04-15')
    expect(addMonths('2026-01-15', 12)).toBe('2027-01-15')
  })

  it('clamps into a shorter target month rather than rolling into the next one', () => {
    // The trap: naive Date arithmetic turns 31 Jan + 1 month into 3 March, which puts a coverage
    // window a whole month out and shows as a gap in the MRR walk.
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30')
  })

  it('handles a leap February', () => {
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
  })

  it('crosses a year boundary', () => {
    expect(addMonths('2025-12-30', 12)).toBe('2026-12-30')
  })
})

const row = (over: Partial<CrmRevenueEvent> = {}): CrmRevenueEvent =>
  ({
    id: 'hubspot:inv:1',
    account_id: 'crestline',
    provider: 'hubspot',
    kind: 'recurring',
    status: 'paid',
    amount: 2265,
    currency: 'SGD',
    amount_usd: 1699,
    collected_usd: 1699,
    fx_rate: 0.75,
    fx_rate_month: '2025-12',
    issued_at: '2025-12-30',
    due_at: null,
    paid_at: '2025-12-30',
    refunded_at: null,
    period_months: 12,
    covers_from: '2025-12-30',
    covers_to: '2026-12-30',
    payer_email: null,
    external_invoice_id: null,
    invoice_number: 'INV-1068',
    external_payment_id: null,
    external_subscription_id: null,
    superseded_by: null,
    description: '',
    matched_by: null,
    notes: '',
    external: {},
    first_seen_at: '',
    created_at: '',
    updated_at: '',
    created_by: null,
    updated_by: null,
    ...over,
  }) as CrmRevenueEvent

describe('needsCoverage', () => {
  it('passes a paid recurring row with a full window', () => {
    expect(needsCoverage(row())).toBe(false)
  })

  it('flags the A4 case - a paid recurring row with no window', () => {
    // A 12-month prepay that arrived with no subscription object behind it. Under a defaulting
    // rule this reads as one month and is 12x wrong on both the walk and the forecast.
    expect(needsCoverage(row({ covers_from: null, covers_to: null, period_months: null }))).toBe(true)
  })

  it('flags a half-set window', () => {
    expect(needsCoverage(row({ covers_to: null }))).toBe(true)
  })

  it('does not flag a one_off row - coverage is meaningless for it', () => {
    expect(needsCoverage(row({ kind: 'one_off', covers_from: null, covers_to: null }))).toBe(false)
  })

  it('does not flag an unpaid row - the window is struck when the money lands', () => {
    expect(needsCoverage(row({ status: 'open', paid_at: null, covers_from: null, covers_to: null }))).toBe(false)
  })
})
