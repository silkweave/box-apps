// Period aggregates - the read-path layer that answers, for EVERY signal, the three standing
// questions: all time, yesterday, month to date (plus last 7 days). Nothing else computes these:
// the SPA's computeDelta is last-point-vs-previous only, and a card's "latest value" is the wrong
// headline for an increment signal (the last bucket is "today so far").
//
// The semantics follow the signal's `accumulation`, because a level and a count aggregate
// differently:
//   • `increment` → SUM of the buckets in the window ("how many first messages this month").
//   • `snapshot`  → the LAST value in the window (a level has no period total; "this month" for a
//     cash balance IS the latest value observed in the month).
//
// THE TRAP THIS MODULE EXISTS TO AVOID: aggregates MUST be computed over the signal's FULL merged
// history - `readSignalPoints(id)` un-windowed, or the controller's un-windowed merge - never over
// the `points[]` array served to the chart, which SUBDAILY_WINDOW_DAYS trims to 90 days for
// sub-daily signals. An `all_time` summed from the trimmed array silently under-reports and looks
// completely plausible. We aggregate the full in-memory merge rather than raw SQL over
// `signal_points` + `signals` on purpose: the merge (mergeSignalPoints) is the ONE implementation
// of bucket precedence (live-over-manual, signal_points-over-legacy), interval re-flooring and
// increment zero-fill - a SQL SUM over the two stores would double-count buckets present in both
// and re-implement precedence, which is exactly the drift this codebase avoids ("bucket flooring
// is ONE function"). Every caller of this module already holds the full store in memory.
//
// Window conventions (naive-UTC per the warehouse-wide rule; buckets are selected by their START,
// so a week/month bucket counts in the window containing its start - no proration):
//   • all_time      - unbounded.
//   • yesterday     - the last COMPLETE UTC day: [yesterday 00:00Z, today 00:00Z).
//   • month_to_date - from the 1st of the current UTC month, today-so-far INCLUDED (that is what
//     "to date" means).
//   • last_7d       - the 7 complete UTC days before today, today-so-far EXCLUDED (a per-day
//     comparison window never mixes in a partial day).
// A window with no buckets in it answers null - honest "we do not know", never a fabricated 0.
// (Increment signals zero-fill at read from their first bucket through now, so an ACTIVE increment
// signal answers 0, not null, for a genuinely quiet window.)

import { readSignalDefinition } from './definitions.js'
import { readSignalPoints, type MergedSignalPoint } from './points.js'
import type { SignalAccumulation, SignalDefinition } from './types.js'

/** The named period set shipped per signal on the `signalsData` payload. Null = no data in window. */
export interface SignalPeriodAggregates {
  all_time: number | null
  yesterday: number | null
  month_to_date: number | null
  last_7d: number | null
}

/**
 * One window's answer, per the signal's accumulation (see the header). `merged` must be the FULL
 * ascending merged history; bounds are ISO-Z bucket-start strings, half-open [from, to),
 * null/omitted = unbounded.
 */
export function aggregateSignalWindow(
  accumulation: SignalAccumulation,
  merged: MergedSignalPoint[],
  window: { from?: string | null; to?: string | null } = {},
): number | null {
  const from = window.from ?? null
  const to = window.to ?? null
  let sum = 0
  let last: number | null = null
  let any = false
  for (const p of merged) {
    if (from !== null && p.bucket < from) continue
    if (to !== null && p.bucket >= to) continue
    any = true
    sum += p.value
    last = p.value // merged is ascending - the final hit is the window's last value
  }
  if (!any) return null
  return accumulation === 'increment' ? sum : last
}

const DAY_MS = 86_400_000
const dayStart = (d: Date): string => `${d.toISOString().slice(0, 10)}T00:00:00Z`

/**
 * The named period set for one signal, from its FULL merged history (see the header trap note -
 * never pass the windowed/served points array). `now` is injectable for tests.
 */
export function computeSignalAggregates(
  def: Pick<SignalDefinition, 'accumulation'>,
  fullMerged: MergedSignalPoint[],
  now: Date = new Date(),
): SignalPeriodAggregates {
  const today = dayStart(now)
  const yesterday = dayStart(new Date(now.getTime() - DAY_MS))
  const weekAgo = dayStart(new Date(now.getTime() - 7 * DAY_MS))
  const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00Z`
  const win = (from: string | null, to: string | null): number | null =>
    aggregateSignalWindow(def.accumulation, fullMerged, { from, to })
  return {
    all_time: win(null, null),
    yesterday: win(yesterday, today),
    month_to_date: win(monthStart, null),
    last_7d: win(weekAgo, today),
  }
}

/**
 * Standalone read: one signal's period aggregates straight from the store. Reads the FULL merged
 * history (readSignalPoints un-windowed - both `signal_points` and the legacy `signals` rows), so
 * `all_time` is never truncated by the chart window. Unknown signal ids are refused.
 */
export async function readSignalAggregates(signalId: string, now: Date = new Date()): Promise<SignalPeriodAggregates> {
  const def = await readSignalDefinition(signalId)
  if (!def) throw new Error(`signal ${signalId} not found`)
  return computeSignalAggregates(def, await readSignalPoints(signalId), now)
}
