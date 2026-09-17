// Mirror of the server's sprint domain (packages/core/src/planning/{types,sprints}.ts). Same
// pattern as planning-types.ts: the tRPC router reflects nested DTO arrays as `unknown[]`, so the
// data layer casts the wire shape to these.
//
// The ARITHMETIC is deliberately not mirrored. `sprintGet` returns `loads` and `check` already
// computed, and re-deriving a band in the SPA is how the two ends drift. What IS mirrored is the
// calendar walk (`datesBetween` / `isWeekend`), because the grid has to draw a column per day even
// for a sprint that holds no tasks and no availability yet - the case where `loads` is empty.

import type { Task } from './planning-types.ts'

/** One day on the burndown. `remaining` is null for a day that has not happened yet. */
export interface BurndownPoint {
  date: string
  ideal: number
  remaining: number | null
}

/** The three buckets a stand-up walks, per person, in the order the Board renders them. */
export const CHECKIN_BUCKETS = ['done', 'today', 'slipping'] as const
export type CheckinBucket = (typeof CHECKIN_BUCKETS)[number]

/** One day's stand-up, shared by the team - it lives in the warehouse, not in a browser. */
export interface SprintCheckin {
  sprint_id: string
  date: string
  /** `<users.id>:<bucket>`. */
  ticks: string[]
  completed_at: string | null
  completed_by: string | null
}

/**
 * A sprint's lifecycle. Deliberately NOT `PlanningStatus`: a sprint is a window with capacity, not
 * a body of work, so `blocked`/`dropped` mean nothing for one.
 */
export type SprintStatus = 'pending' | 'scheduled' | 'planned' | 'active' | 'done'

export const SPRINT_STATUSES: SprintStatus[] = ['pending', 'scheduled', 'planned', 'active', 'done']

/** Label + badge tone per status. Tone is information: the live sprint reads hot, a closed one muted. */
export const SPRINT_STATUS_META: Record<
  SprintStatus,
  { label: string; tone: 'neutral' | 'info' | 'accent' | 'success'; hint: string }
> = {
  pending: { label: 'Pending', tone: 'neutral', hint: 'Created, no dates agreed yet' },
  scheduled: { label: 'Scheduled', tone: 'info', hint: 'Dates and availability are set' },
  planned: { label: 'Planned', tone: 'info', hint: 'Tasks are slotted and the capacity check passes' },
  active: { label: 'Active', tone: 'accent', hint: 'Kicked off - this is the sprint being run' },
  done: { label: 'Done', tone: 'success', hint: 'Closed out' },
}

/** Hours assumed available on a working day when the sprint says nothing. Not 8 - see features/planning/SPEC.md. */
export const DEFAULT_SPRINT_HOURS = 5

/** Per-person availability inside ONE sprint. An absent user is not on the sprint at all. */
export interface SprintAvailability {
  /** Hours per working day, when the calendar says nothing about the day. */
  hours?: number
  /**
   * The calendar: `YYYY-MM-DD` -> hours worked that day. Overrides everything, so `0` IS a day off
   * and a Saturday with `4` is a Saturday somebody is working. Replaced `days_off[]` 2026-09-07.
   */
  hours_by_date?: Record<string, number>
}

export type DayVerdict = 'empty' | 'under' | 'ok' | 'over'

/** What one person has on one day, and whether it fits. Computed server-side, never here. */
export interface DayLoad {
  date: string
  /** users.id */
  user: string
  /** Capacity in hours; 0 on a weekend or a day off. */
  hours: number
  /** Estimated hours slotted onto the day - the sum of its tasks' `estimate_hours`. */
  planned: number
  taskCount: number
  /** Slotted tasks with no estimate - excluded from `planned`, surfaced so it can be fixed. */
  unsized: number
  verdict: DayVerdict
}

export interface SprintCheck {
  ok: boolean
  over: DayLoad[]
  under: DayLoad[]
  unsized: DayLoad[]
}

export interface Sprint {
  id: string
  title: string
  /** One line on what this sprint is for. Long-form rationale belongs in an initiative. */
  goal: string
  status: SprintStatus
  /** Full calendar days, inclusive. Null until Sprint Design sets them. */
  start_date: string | null
  end_date: string | null
  /** users.id -> availability. Its KEYS are the sprint's roster (see SprintDesign). */
  availability: Record<string, SprintAvailability>
  started_at: string | null
  done_at: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface SprintDetail extends Sprint {
  tasks: Task[]
  /** INFERRED from the tasks - a sprint never assigns an initiative. */
  initiative_ids: string[]
  /** One entry per person per day; EMPTY until the sprint has dates. */
  loads: DayLoad[]
  check: SprintCheck
  burndown: BurndownPoint[]
  /** TODAY's stand-up, if one has been started. */
  checkin: SprintCheckin | null
}

/** Render an hour figure the way every surface must: `6h`, `0h`, `7.5h`. */
export function formatHours(hours: number): string {
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

/**
 * Tone per verdict. `ok` and `empty` are silent on purpose - only a real signal gets a colour.
 *
 * `cell` is a BACKGROUND wash rather than a border since the grid grew real cell rules (2026-09-07):
 * the table draws the lines now, so a verdict that recoloured them would be competing with the grid
 * instead of marking a day.
 */
export const VERDICT_META: Record<DayVerdict, { label: string; cell: string; text: string }> = {
  empty: { label: 'Nothing slotted', cell: '', text: 'text-fg-4' },
  under: { label: 'Light - even the worst case leaves the day mostly empty', cell: '', text: 'text-info' },
  ok: { label: 'Fits', cell: '', text: 'text-muted-foreground' },
  over: { label: 'Over capacity - even the best case exceeds the day', cell: 'bg-danger-bg/40', text: 'text-danger' },
}

// --- the calendar walk ----------------------------------------------------------------------------
// UTC on plain YYYY-MM-DD strings, exactly like the server: a Date carrying a local timezone is only
// ever a way to land on the wrong day.

const DAY_MS = 86_400_000

const toUtc = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

const fromUtc = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Every date in `[start, end]` inclusive. Empty when either is missing or end precedes start. */
export function datesBetween(start: string | null, end: string | null): string[] {
  if (!start || !end) return []
  const from = toUtc(start)
  const to = toUtc(end)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return []
  const out: string[] = []
  for (let t = from; t <= to; t += DAY_MS) out.push(fromUtc(t))
  return out
}

export function isWeekend(date: string): boolean {
  const day = new Date(toUtc(date)).getUTCDay()
  return day === 0 || day === 6
}

/**
 * The last working day strictly before `date` - Monday answers Friday. Mirrors core's
 * `previousWorkingDay` (tested there): it is calendar arithmetic, the one layer this file does
 * mirror, because the Board has to answer "since when" for a sprint the server was never asked
 * about.
 */
export function previousWorkingDay(date: string): string {
  let t = toUtc(date) - DAY_MS
  while (isWeekend(fromUtc(t))) t -= DAY_MS
  return fromUtc(t)
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `2026-09-14` -> `Mon 14 Sep`, in UTC so it matches the day the server counted. */
export function formatDay(date: string): string {
  const d = new Date(toUtc(date))
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

/** `2026-09-14` -> `14 Sep`. The weekday is the grid's column header, not something a card repeats. */
export function formatDayShort(date: string): string {
  const d = new Date(toUtc(date))
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}

/** The ISO week a date falls in, as a stable grouping key for the grid's week separators. */
export function weekKey(date: string): string {
  const d = new Date(toUtc(date))
  // Walk back to Monday, then key on that date - no week-number arithmetic to get wrong.
  const back = (d.getUTCDay() + 6) % 7
  return fromUtc(toUtc(date) - back * DAY_MS)
}

/** Capacity for one person on one date - the server's `capacityOn`, mirrored for the empty grid. */
export function capacityOn(date: string, availability?: SprintAvailability): number {
  const named = availability?.hours_by_date?.[date]
  if (typeof named === 'number' && Number.isFinite(named)) return Math.max(0, named)
  if (isWeekend(date)) return 0
  return Math.max(0, availability?.hours ?? DEFAULT_SPRINT_HOURS)
}
