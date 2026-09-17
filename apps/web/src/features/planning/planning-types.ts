// Mirror of the server's planning domain (src/core/planning/types.ts). The tRPC router reflects
// nested DTO arrays as `unknown[]`, so usePlanningData casts the wire shape to these types - same
// pattern the inbox/signals views use.

/**
 * Lifecycle of planned work - ONE vocabulary for initiatives and tasks alike (2026-08-11), mirroring
 * the server's `PlanningStatus`. `blocked` is settable on both sides; `blocked_by` stays the
 * dependency graph rather than the only way to say a thing is stuck.
 */
export type PlanningStatus = 'planned' | 'active' | 'blocked' | 'done' | 'dropped'

export const PLANNING_STATUSES: PlanningStatus[] = ['planned', 'active', 'blocked', 'done', 'dropped']

/** Statuses that end the lifecycle - the same two on both tables. Nothing overdue-tones past these. */
export const TERMINAL_PLANNING_STATUSES: PlanningStatus[] = ['done', 'dropped']

/**
 * What shape of work an initiative is - the board's primary grouping axis.
 *
 * A plain string since 2026-08-28: the LIST is tenant configuration now, served by `planningKinds`
 * and cached in lib/initiativeKinds.ts, so the labels and icons that used to be the KIND_LABEL map
 * (and a KIND_AREA map that has since been dropped entirely) are records the team edits in Settings.
 * Nothing in the SPA may assume a fixed set - use `kindLabel()` / `kindIcon()`, which fall back
 * rather than blanking a row.
 */
export type InitiativeKind = string

/** The lane an initiative falls into when none is given, and the one Settings will not delete. */
export const DEFAULT_INITIATIVE_KIND = 'general'

export type ValueLevel = 'high' | 'med' | 'low' | 'none'
export const VALUE_LEVELS: ValueLevel[] = ['high', 'med', 'low', 'none']

/**
 * A task's estimate is a NUMBER OF HOURS again (2026-09-08), `null` when nobody has estimated it.
 * The four-bucket t-shirt scale it replaced could only ever produce ranges, so a sprint day's load
 * straddled capacity and the check almost never had anything to say.
 *
 * The scale a human is OFFERED stops at four, and the top step is open-ended (`4+`): a task longer
 * than half a day should be split rather than estimated, and a picker that offers 8 invites the
 * estimate instead of the split. Bigger numbers still store and still sum - the column is an
 * integer and the backfill from the old `xl` bucket wrote 8s - they just read as `4+`.
 */
export const TOP_TASK_HOURS = 4
export const TASK_HOURS: number[] = [1, 2, 3, 4]

/** `4+` for the open-ended top step, plain hours below it. */
export const taskHoursLabel = (hours: number): string => (hours >= TOP_TASK_HOURS ? `${TOP_TASK_HOURS}h+` : `${hours}h`)

/**
 * An INITIATIVE has no size of its own. Its size is the sum of its tasks' hours (`lib/effort.ts`),
 * and these four buckets are only how that sum is GROUPED and FILTERED on the board - a label for a
 * range of days, never a value anybody sets. Hours on the initiative reading: a day is 8h, a week 5
 * days, working time.
 */
export type Effort = 's' | 'm' | 'l' | 'xl'
export const EFFORTS: Effort[] = ['s', 'm', 'l', 'xl']

export const EFFORT_META: Record<Effort, { label: string }> = {
  s: { label: 'SM' },
  m: { label: 'MD' },
  l: { label: 'LG' },
  xl: { label: 'XL' },
}

export const EFFORT_RANK: Record<Effort, number> = { s: 1, m: 2, l: 3, xl: 4 }

/** `max: null` is the open-ended top step. Hours, on the initiative reading. */
export const EFFORT_HOURS: Record<Effort, { min: number; max: number | null }> = {
  s: { min: 0, max: 8 },
  m: { min: 8, max: 40 },
  l: { min: 40, max: 160 },
  xl: { min: 160, max: null },
}

/** The legend under each step - what the bucket means in plain time. */
export const EFFORT_HINT: Record<Effort, string> = {
  s: 'under a day',
  m: 'a day to a week',
  l: 'a week to a month',
  xl: 'more than a month',
}

/** Label + tone per value level. Tone is information: high reads hot, none reads muted. */
export const VALUE_META: Record<ValueLevel, { label: string; tone: 'accent' | 'info' | 'muted' }> = {
  high: { label: 'High', tone: 'accent' },
  med: { label: 'Med', tone: 'info' },
  low: { label: 'Low', tone: 'muted' },
  none: { label: 'None', tone: 'muted' },
}

/** Rank for sorting - higher is more valuable. Unscored (null) sorts last. */
export const VALUE_RANK: Record<ValueLevel, number> = { high: 3, med: 2, low: 1, none: 0 }

/** How much a row matters: 1-3 stars, null = unrated. Replaced the task-only defect severity. */
export type Priority = 1 | 2 | 3
export const PRIORITIES: Priority[] = [1, 2, 3]
export const PRIORITY_LABEL: Record<Priority, string> = { 1: 'Low', 2: 'Medium', 3: 'High' }

export interface InitiativeTarget {
  signal_id: string
  value: number
  by_date?: string
  baseline?: number
}

export interface Task {
  id: string
  /** null = a SPRINT task: made on the sprint grid, id `<sprint>/<task>`, lives only in `sprint_id`. */
  initiative_id: string | null
  title: string
  summary: string
  status: PlanningStatus
  rank: number
  score: number | null
  /** How much this matters: 1-3 stars, null = unrated. */
  priority: Priority | null
  /** How long it should take, in whole hours 1-8. null = not estimated. */
  estimate_hours: number | null
  tags: string[]
  url: string | null
  /** users.id this task is assigned to, or null (unassigned). */
  assignee: string | null
  metadata: Record<string, unknown>
  /** Deadline as a naive calendar date (`YYYY-MM-DD`), or null. Overdue is derived, never stored. */
  due_date: string | null
  /** The sprint this task is scoped into, or null. A task is in at most one (features/planning/SPEC.md). */
  sprint_id: string | null
  /** The day inside that sprint the plan puts it on (`YYYY-MM-DD`), or null when it is scoped but unslotted. */
  slot_date: string | null
  created_at: string
  updated_at: string
  done_at: string | null
  /** users.id that created / last edited the row via the dashboard; null for agent/MCP writes. */
  created_by: string | null
  updated_by: string | null
}

export interface Initiative {
  id: string
  title: string
  summary: string
  status: PlanningStatus
  kind: InitiativeKind
  owner: string | null
  signal_ids: string[]
  target: InitiativeTarget | null
  value_customer: ValueLevel | null
  value_company: ValueLevel | null
  /** How much this matters: 1-3 stars, null = unrated. */
  priority: Priority | null
  /** initiatives.id values this one waits on (server-guaranteed acyclic + existing). */
  blocked_by: string[]
  tags: string[]
  doc_path: string | null
  /** Deadline as a naive calendar date (`YYYY-MM-DD`), or null. Overdue is derived, never stored. */
  due_date: string | null
  sort: number
  created_at: string
  updated_at: string
  /** users.id that created / last edited the row via the dashboard; null for agent/MCP writes. */
  created_by: string | null
  updated_by: string | null
  tasks: Task[]
}

/** Display label + tone per status (tone maps to a Tailwind text/badge color). One map, both tables. */
export const PLANNING_STATUS_META: Record<PlanningStatus, { label: string; tone: 'accent' | 'success' | 'danger' | 'muted' }> = {
  planned: { label: 'Planned', tone: 'muted' },
  active: { label: 'Active', tone: 'accent' },
  blocked: { label: 'Blocked', tone: 'danger' },
  done: { label: 'Done', tone: 'success' },
  dropped: { label: 'Dropped', tone: 'muted' },
}
