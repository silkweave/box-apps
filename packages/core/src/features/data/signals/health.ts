// "On track" is owned by the server, in ONE function. Cards, the signal circuit board and any
// future alert rule read this; three copies of "on track" would drift within a week, and each copy
// would get the direction rule subtly wrong for churn.
//
// The five states, and what each one is honestly claiming:
//   • no_target  - nobody said what good looks like. NOT a failure; most signals live here.
//   • no_data    - a target exists but the signal has no usable observation yet.
//   • met        - the target value has been reached (direction-aware: `down` signals meet a
//                  target by falling to or below it).
//   • on_track   - not met, and nothing observed says it is failing.
//   • off_track  - not met, and something observed says so: the deadline passed, or the pace is
//                  behind, or the number moved AWAY from where it started.
//
// What decides on_track vs off_track, in order (each rule needs strictly more information than the
// one above it, so a bare `{value}` target still gets an honest answer):
//   1. `by_date` in the past          → off_track. The deadline came and went unmet.
//   2. `baseline` + `since` + `by_date`, all three, and now inside the window → LINEAR PACE: the
//      value must have covered at least the elapsed fraction of the baseline→target distance.
//   3. `baseline` alone               → DIRECTION OF TRAVEL: better than baseline is on_track,
//      worse is off_track. No dates needed and no pace asserted.
//   4. nothing else                   → on_track. A target with no baseline and no deadline gives
//      us no evidence of trouble, and inventing some would be dishonest.
//
// `since` is the anchor rule 2 needs and is why it exists on SignalTarget: a baseline is a value
// with no date of its own, and a pace check without a start point is arithmetic on a guess. The
// write path stamps it (today) whenever a target lands with a baseline and no `since`, so a target
// set through the dialog or an MCP tool acquires the anchor with no extra input.
//
// NOT in here, deliberately: trend/slope forecasting ("will it get there?"), period-over-period
// deltas (client-side, the SPA has every point), and anything that reads more than the ONE latest
// point - health answers "where are we against the goal", not "how did we get here".

import type { MergedSignalPoint } from './points.js'
import type { SignalDefinition } from './types.js'

export type SignalHealth = 'no_target' | 'no_data' | 'on_track' | 'off_track' | 'met'
export const SIGNAL_HEALTHS: SignalHealth[] = ['no_target', 'no_data', 'on_track', 'off_track', 'met']

/** The one observation health reads: a bucket start (ISO-Z) and its value. */
export interface SignalHealthPoint {
  bucket: string
  value: number
}

/**
 * The point a signal's headline (and therefore its health) should be judged on.
 *
 * For a `snapshot` signal that is simply the last observation - a level is a level. For an
 * `increment` signal the last bucket is the one still filling ("today so far" at day grain, and
 * the read path zero-fills through the current bucket, so it is ALWAYS partial) - judging a target
 * against it would report every signal as off_track every morning. So increments answer with the
 * last COMPLETE bucket, the same rule SignalCard's headline already uses.
 *
 * `merged` must be ascending (mergeSignalPoints output). Returns null when there is nothing to
 * judge, which is exactly the `no_data` case.
 */
export function latestSignalPoint(
  def: Pick<SignalDefinition, 'accumulation'>,
  merged: MergedSignalPoint[],
): SignalHealthPoint | null {
  const usable = def.accumulation === 'increment' ? merged.slice(0, -1) : merged
  const last = usable[usable.length - 1]
  return last ? { bucket: last.bucket, value: last.value } : null
}

const DAY = /^(\d{4}-\d{2}-\d{2})/
/** Both `by_date` and `since` are YYYY-MM-DD; a bucket is ISO-Z. Compare at UTC-day grain. */
const day = (iso: string): string | null => DAY.exec(iso)?.[1] ?? null

/**
 * Where a signal stands against its own standing target. `latest` is the point from
 * `latestSignalPoint` (null = none). `now` is injectable for tests.
 */
export function signalHealth(
  def: Pick<SignalDefinition, 'direction' | 'target'>,
  latest: SignalHealthPoint | null,
  now: Date = new Date(),
): SignalHealth {
  const target = def.target
  if (!target) return 'no_target'
  if (!latest) return 'no_data'

  const up = def.direction !== 'down'
  const reached = (value: number, goal: number): boolean => (up ? value >= goal : value <= goal)
  if (reached(latest.value, target.value)) return 'met'

  const today = day(now.toISOString())!
  if (target.by_date && target.by_date < today) return 'off_track' // rule 1: deadline passed unmet

  const { baseline, since, by_date } = target
  if (baseline == null) return 'on_track' // rule 4: no evidence either way

  // Rule 2 - linear pace, only with a real anchor and a deadline still ahead. `since >= by_date`
  // is a nonsense window (or a same-day target) and falls through to rule 3 rather than dividing
  // by zero.
  if (since && by_date && since < by_date && today >= since) {
    const span = Date.parse(`${by_date}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)
    const elapsed = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)
    const fraction = Math.min(1, Math.max(0, elapsed / span))
    const required = baseline + (target.value - baseline) * fraction
    return reached(latest.value, required) ? 'on_track' : 'off_track'
  }

  // Rule 3 - direction of travel. Sitting exactly on the baseline counts as on_track: no movement
  // is not yet evidence of failure (a passed deadline, rule 1, is what makes standing still fail).
  return reached(latest.value, baseline) ? 'on_track' : 'off_track'
}
