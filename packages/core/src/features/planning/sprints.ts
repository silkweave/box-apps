// Sprints - a window of days with real capacity, and the tasks slotted into it.
//
// The one design call that shapes this whole file (re-decided 2026-09-08): **a task's size IS a
// number of hours** (1-8, `estimate_hours`), so a day's load is a SUM and every check here is plain
// arithmetic against the day's capacity. It replaced a four-bucket t-shirt scale whose honest
// answer was usually "cannot tell" - four `m` tasks were somewhere between 4 and 16 hours, which
// straddles every realistic day, so the check almost never fired. An estimate that is wrong by an
// hour is more useful than a range that is right and says nothing.
//
// One thing survives from the range era and is worth keeping: a task with NO estimate contributes
// nothing to the sum and is counted separately (`unsized`). Treating it as 0 would call a full day
// empty; guessing a number for it would invent capacity nobody promised.
//
// Availability lives ON the sprint row (`availability` JSON), not in `config/`. It is per-sprint
// data by nature - the spec's Sprint Design step sets "date range, holidays, availability per team
// member" together, and one person's days off in October say nothing about their November. A team-wide
// default hours figure is the one global, and it is a constant (DEFAULT_SPRINT_HOURS) until someone
// actually wants to change it.

import { DEFAULT_SPRINT_HOURS } from './types.js'

/** Sum the estimates of a set of tasks. An unestimated task adds nothing - see `loadFor`. */
export function hoursFor(estimates: (number | null | undefined)[]): number {
  return estimates.reduce<number>((acc, h) => acc + (h ?? 0), 0)
}

/** Render an hour figure the way every surface should: `6h`, `0h`, `7.5h`. */
export function formatHours(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

/**
 * How far below capacity a day has to be before it counts as under-filled. 0.6 means "more than 40%
 * of the day is idle". A threshold rather than "anything under capacity" because estimates are
 * approximate and a day that merely fails to reach the top is the normal case, not a warning.
 */
export const UNDER_UTILISATION_RATIO = 0.6

/**
 * The verdict for one person-day:
 *   `over`  - the estimates exceed capacity.
 *   `under` - they leave more than 40% of the day idle (see UNDER_UTILISATION_RATIO).
 *   `ok`    - it fits, and fills enough of the day to be a plan.
 *   `empty` - nothing slotted at all. Distinct from `under`, which means "slotted, but too little".
 * `unsized` is NOT a verdict but a flag alongside it, because a day can be provably over capacity
 * AND still have unestimated tasks in it, and both facts want saying.
 */
export type DayVerdict = 'empty' | 'under' | 'ok' | 'over'

export function dayVerdict(planned: number, hours: number, taskCount: number): DayVerdict {
  if (taskCount === 0) return 'empty'
  if (hours <= 0) return planned > 0 ? 'over' : 'empty'
  if (planned > hours) return 'over'
  if (planned < hours * UNDER_UTILISATION_RATIO) return 'under'
  return 'ok'
}

/** What one person has on one day, and whether it fits. */
export interface DayLoad {
  date: string
  user: string
  /** Capacity in hours. 0 when it is a day off or a non-working day. */
  hours: number
  /** Estimated hours slotted onto the day - the sum of its tasks' `estimate_hours`. */
  planned: number
  taskCount: number
  /** Tasks in the day with no estimate - excluded from `planned`, surfaced so it can be fixed. */
  unsized: number
  verdict: DayVerdict
}

/** Per-person availability inside ONE sprint. Absent user = the defaults. */
export interface SprintAvailability {
  /** Hours per working day, when the calendar says nothing. Defaults to DEFAULT_SPRINT_HOURS. */
  hours?: number
  /**
   * The calendar: absolute date (YYYY-MM-DD) -> hours that person works THAT day. It is the whole
   * per-day story and it OVERRIDES everything else, so `0` is how a day off is spelled and a
   * Saturday with `4` is a Saturday somebody is working. Replaced `days_off[]` on 2026-09-07: two
   * ways to say "not working" (an empty list plus `hours: 0`) meant every reader had to know the
   * precedence, and neither could express a short day.
   *
   * Per-person and absolute rather than a shared holiday calendar - the team is not in one country,
   * so there is no single set of public holidays to subtract.
   */
  hours_by_date?: Record<string, number>
}

/** The `availability` column: users.id -> their availability in this sprint. */
export type SprintAvailabilityMap = Record<string, SprintAvailability>

// --- dates ----------------------------------------------------------------------------------------
// All sprint dates are plain YYYY-MM-DD, all arithmetic is UTC. A sprint works in FULL DAYS (the
// spec is explicit), so a Date carrying a local timezone is only ever a way to land on the wrong day.

const DAY_MS = 86_400_000

function toUtc(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** Every date in `[start, end]` inclusive. Empty when end precedes start. */
export function datesBetween(start: string, end: string): string[] {
  const from = toUtc(start)
  const to = toUtc(end)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return []
  const out: string[] = []
  for (let t = from; t <= to; t += DAY_MS) out.push(fromUtc(t))
  return out
}

/** Saturday or Sunday, in UTC. The one non-working rule that is not per-person. */
export function isWeekend(date: string): boolean {
  const day = new Date(toUtc(date)).getUTCDay()
  return day === 0 || day === 6
}

/**
 * The last working day strictly BEFORE `date`. Monday answers Friday, which is the whole point: a
 * standup's "done since yesterday" read literally drops everything finished on Friday every Monday
 * morning, and Monday is the day a standup matters most. Weekends only - a person's own day off is
 * not applied, because the bucket is read by the whole team and skipping one person's Thursday would
 * make two people's standups disagree about what "since" means.
 */
export function previousWorkingDay(date: string): string {
  let t = toUtc(date) - DAY_MS
  while (isWeekend(fromUtc(t))) t -= DAY_MS
  return fromUtc(t)
}

/**
 * The dates one person actually works in a sprint: every day in the range they have hours on. It is
 * derived from `capacityOn` rather than re-stating the rule, so a calendar entry that puts somebody
 * on a Saturday counts here too.
 */
export function workingDays(start: string, end: string, availability?: SprintAvailability): string[] {
  return datesBetween(start, end).filter((d) => capacityOn(d, availability) > 0)
}

/**
 * Capacity for one person on one date. The calendar wins outright when it names the day - that is
 * what makes `0` a day off and `4` a half day - and only in its silence does the weekend rule and
 * then the per-day default apply.
 */
export function capacityOn(date: string, availability?: SprintAvailability): number {
  const named = availability?.hours_by_date?.[date]
  if (typeof named === 'number' && Number.isFinite(named)) return Math.max(0, named)
  if (isWeekend(date)) return 0
  return Math.max(0, availability?.hours ?? DEFAULT_SPRINT_HOURS)
}

// --- the check ------------------------------------------------------------------------------------

/** The slice of a task this layer needs. Anything with these three fields will do. */
export interface SlottedTask {
  assignee?: string | null
  slot_date?: string | null
  estimate_hours?: number | null
}

/**
 * The whole capacity picture for a sprint: one DayLoad per person per date in the range, including
 * the days they do not work (capacity 0), because a task slotted onto someone's day off is exactly
 * the thing this check exists to catch - it lands as `over` against 0 hours.
 *
 * Only people who appear in `availability` OR hold a slotted task are included. An empty sprint
 * therefore reports nothing rather than a grid of every user in the directory.
 */
/**
 * One day on the burndown: how much work SHOULD be left at the end of it, and how much actually is.
 *
 * `remaining` is `null` for a day that has not happened yet - the actual line stops at today rather
 * than drawing a flat run to the end of the sprint, which reads as "nothing will get done" instead
 * of "we do not know yet".
 */
export interface BurndownPoint {
  date: string
  /** Hours the plan says should remain at the END of this day. Reaches 0 on the last working day. */
  ideal: number
  /** Hours actually remaining at the end of this day; null for a future day. */
  remaining: number | null
}

/**
 * The sprint's burndown: estimated hours remaining, day by day, against the line the plan implies.
 *
 * Three decisions worth knowing, because each changes what the chart MEANS:
 *
 * **Only WORKING days are on the axis** (2026-09-08). A weekend on a burndown is a flat run in both
 * lines that says nothing and eats a third of the width of a two-week sprint. A day is "working" if
 * the team has any capacity on it, so it follows the availability calendar rather than the weekday
 * - a Saturday somebody is genuinely rostered onto stays. Work finished on a skipped day is not
 * lost: it burns on the next working day, which is the first day anybody could have seen it.
 *
 * **The ideal line follows CAPACITY.** Each day retires a share of the scope proportional to the
 * team's hours on it (`capacityOn` summed over the roster), so a half day is a half step. A straight
 * line would make every team look behind on the light days for no reason anybody could act on. With
 * no availability at all it degrades to an even step per working day, which is the only honest
 * answer when nothing is known about who works when.
 *
 * **Scope is measured as it stands NOW.** `remaining` walks `done_at` backwards from today's total,
 * so a task added mid-sprint appears to have been there all along and one deleted was never there.
 * Tracking scope changes over time needs a history table this system does not keep, and inventing
 * one from `created_at` would be a lie in the other direction (it would show scope arriving but
 * never leaving).
 *
 * Every value is the END of its day, both lines alike, which is why the first point already sits one
 * step below the total - it is Monday EVENING, not Monday morning. There is deliberately no synthetic
 * "day zero" before the sprint starts: a chart whose first tick is the Sunday of a sprint that starts
 * on Monday spends its clearest label on a day the sprint does not contain.
 *
 * Unestimated tasks count as 0 hours - they are invisible here exactly as they are invisible to the
 * capacity check, which is what `check.unsized` exists to nag about.
 */
export function burndown(
  start: string,
  end: string,
  tasks: { estimate_hours?: number | null; status?: string; done_at?: string | null }[],
  availability: Record<string, SprintAvailability> = {},
  today?: string,
): BurndownPoint[] {
  const all = datesBetween(start, end)
  if (all.length === 0) return []
  const roster = Object.keys(availability)
  const capacityOf = (d: string): number =>
    roster.length === 0
      ? isWeekend(d)
        ? 0
        : 1
      : roster.reduce((sum, u) => sum + capacityOn(d, availability[u]), 0)

  // A sprint that is entirely non-working days (a weekend hackathon nobody has availability for)
  // still has to draw something, so it falls back to every day rather than to nothing.
  const dates = all.filter((d) => capacityOf(d) > 0)
  if (dates.length === 0) return []
  const total = tasks.reduce((sum, t) => sum + (t.estimate_hours ?? 0), 0)

  // Hours burned per WORKING day. Work finished on a skipped day (or before the sprint opened) lands
  // on the next working day; work finished after the last one lands on the last, which is the honest
  // reading of a sprint that ran out of days before it ran out of work.
  const burned = new Map<string, number>()
  for (const t of tasks) {
    const at = (t.done_at ?? '').slice(0, 10)
    if (!at || t.status !== 'done') continue
    const day = dates.find((d) => d >= at) ?? (dates.at(-1) as string)
    burned.set(day, (burned.get(day) ?? 0) + (t.estimate_hours ?? 0))
  }

  const capacityTotal = dates.reduce((sum, d) => sum + capacityOf(d), 0)
  const points: BurndownPoint[] = []
  let spent = 0
  let left = total
  for (const date of dates) {
    spent += capacityOf(date)
    left -= burned.get(date) ?? 0
    points.push({
      date,
      ideal: round1(total * (1 - spent / capacityTotal)),
      remaining: today && date > today ? null : round1(left),
    })
  }
  return points
}

const round1 = (n: number): number => Math.round(n * 10) / 10

export function sprintCapacity(
  start: string,
  end: string,
  tasks: SlottedTask[],
  availability: SprintAvailabilityMap = {},
): DayLoad[] {
  const dates = datesBetween(start, end)
  const inRange = new Set(dates)
  const slotted = tasks.filter((t) => t.slot_date && inRange.has(t.slot_date) && t.assignee)
  const users = [...new Set([...Object.keys(availability), ...slotted.map((t) => t.assignee as string)])].sort()

  const out: DayLoad[] = []
  for (const user of users) {
    const avail = availability[user]
    for (const date of dates) {
      const mine = slotted.filter((t) => t.assignee === user && t.slot_date === date)
      const hours = capacityOn(date, avail)
      const planned = hoursFor(mine.map((t) => t.estimate_hours))
      out.push({
        date,
        user,
        hours,
        planned,
        taskCount: mine.length,
        unsized: mine.filter((t) => !t.estimate_hours).length,
        verdict: dayVerdict(planned, hours, mine.length),
      })
    }
  }
  return out
}

/**
 * Whether a sprint is fit to move `scheduled` -> `planned`. Over-capacity days block it; under-filled
 * days and unestimated tasks are reported but do NOT, because "this day looks light" is a judgement for
 * the person planning and not a rule. Unslotted tasks likewise: a sprint can hold work nobody has
 * put on a day yet.
 */
export interface SprintCheck {
  ok: boolean
  over: DayLoad[]
  under: DayLoad[]
  unsized: DayLoad[]
}

export function checkSprint(loads: DayLoad[]): SprintCheck {
  const over = loads.filter((l) => l.verdict === 'over')
  return {
    ok: over.length === 0,
    over,
    under: loads.filter((l) => l.verdict === 'under'),
    unsized: loads.filter((l) => l.unsized > 0),
  }
}
