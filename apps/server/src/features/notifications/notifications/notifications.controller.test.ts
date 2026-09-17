// The bell's read-state rule, pinned as a pure function.
//
// The bug it exists for: an alert whose `event_at` is in the future is permanently unseen against
// a `Date.now()` watermark and permanently un-clearable against the dismiss watermark, and the
// bell's mark-on-open then fights its own reload in a loop.

import { describe, expect, it } from 'vitest'
import { alertSeenKey } from './notifications.controller.js'

const iso = (ms: number): string => new Date(ms).toISOString()

describe('alertSeenKey', () => {
  it('uses the event time for an ordinary row, where the event precedes the write', () => {
    const eventAt = Date.parse('2026-09-10T09:00:00Z')
    expect(alertSeenKey(eventAt, iso(eventAt + 3_000))).toBe(eventAt)
  })

  it('clamps a FUTURE event_at down to when the row was recorded', () => {
    // An upstream stamped 9 hours ahead - a skewed clock, or a payload in another timezone.
    const recorded = Date.parse('2026-09-09T23:00:00Z')
    const eventAt = Date.parse('2026-09-10T09:14:22Z')
    expect(alertSeenKey(eventAt, iso(recorded))).toBe(recorded)
  })

  it('makes a marked-seen watermark actually cover a future-dated row', () => {
    const recorded = Date.parse('2026-09-09T23:00:00Z')
    const eventAt = Date.parse('2026-09-10T09:14:22Z')
    const watermark = Date.parse('2026-09-09T23:30:00Z') // "seen" pressed at 23:30
    expect(eventAt > watermark).toBe(true) // the bug
    expect(alertSeenKey(eventAt, iso(recorded)) > watermark).toBe(false) // the fix
  })

  it('falls back to the event time when created_at is unparseable', () => {
    const eventAt = Date.parse('2026-09-10T09:00:00Z')
    expect(alertSeenKey(eventAt, 'not a date')).toBe(eventAt)
  })
})
