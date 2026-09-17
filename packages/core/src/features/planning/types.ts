// Planning domain - initiatives (signals-bound bodies of work) and the tasks underneath them.
// The structured state lives in the warehouse `initiatives`/`tasks` tables; the long-form rationale
// stays in the linked markdown (`docPath`). See features/planning/SPEC.md.

/**
 * Lifecycle of planned work - ONE vocabulary for initiatives and tasks alike (2026-08-11). The two
 * lists used to differ (`idea`/`paused`/`abandoned` on one side, `backlog`/`in_progress` on the
 * other) and drifted apart in both rendering and meaning; migration `009-planning-status-
 * consolidation` collapsed them. `blocked` is a real, settable status on both sides - `blocked_by`
 * remains the dependency graph, but nothing stops a human saying so directly.
 */
export type PlanningStatus = 'planned' | 'active' | 'blocked' | 'done' | 'dropped'

export const PLANNING_STATUSES: PlanningStatus[] = ['planned', 'active', 'blocked', 'done', 'dropped']

/** Statuses that end the lifecycle - the same two on both tables. */
export const TERMINAL_PLANNING_STATUSES: PlanningStatus[] = ['done', 'dropped']

/**
 * What shape of work an initiative is - the primary grouping axis on the board. Validated (a typo
 * used to silently create a one-row group), and deliberately short: every value has to earn its
 * place as a lane someone actually filters by.
 *
 * A plain string since 2026-08-28, because the LIST is instance configuration now
 * (config/initiative-kinds.json, see planning/kinds.ts) rather than a union nobody could extend
 * without a deploy. The ten kinds this shipped with survive as its seed. Validation did not go
 * away - it moved from the compiler to `assertInitiativeKind`, which every write goes through.
 *
 * `content` was a kind until 2026-08-12 and is gone on purpose: content is its own pair of objects
 * now (`content_topics` + `content_pieces`), so a content idea can never again occupy a lane on the
 * board the company plans its real work on. Migration 010 deleted the 25 rows that used it.
 */
export type InitiativeKind = string

/**
 * Qualitative worth on one axis. Four buckets on purpose: a number invites false precision and stops
 * being readable as a chip. `none` is an explicit "we looked, it is zero" - distinct from null (not
 * yet judged), which is what an unscored row carries.
 */
export type ValueLevel = 'high' | 'med' | 'low' | 'none'
export const VALUE_LEVELS: ValueLevel[] = ['high', 'med', 'low', 'none']

/**
 * How long a task is expected to take, in WHOLE HOURS, 1-8. An estimate is a number again
 * (2026-09-08): the four-bucket t-shirt scale it replaced could only ever answer "cannot tell" -
 * four `m` tasks were anywhere between 4 and 16 hours - so a sprint day's load was a range and the
 * capacity check was interval arithmetic against it. One working day is the ceiling on purpose: a
 * task that does not fit in a day is not one task, and 8 is the honest way for the board to say so.
 *
 * `null` is "not estimated", which is a real and different answer - it contributes nothing to a
 * day's load and is counted separately (see sprints.ts `loadFor`).
 *
 * INITIATIVES carry no size of their own at all any more. Theirs is the sum of their tasks' hours,
 * computed where it is shown, so the board can no longer hold a hand-set size that the work under
 * it contradicts.
 */
export const MIN_TASK_HOURS = 1
export const MAX_TASK_HOURS = 8
export const TASK_HOURS: number[] = [1, 2, 3, 4, 5, 6, 7, 8]

/**
 * Coerce anything a caller sends into a valid estimate or null. Rounded to a whole hour and CLAMPED
 * into 1-8 rather than rejected: an agent asking for 12 means "a big one", and the clamp says what
 * the scale can express instead of silently dropping the estimate. Half an hour rounds UP to the 1h
 * floor for the same reason. Only null and a non-positive number clear the estimate.
 */
export function normalizeEstimateHours(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  if (!Number.isFinite(v) || v <= 0) return null
  return Math.min(MAX_TASK_HOURS, Math.max(MIN_TASK_HOURS, Math.round(v)))
}

/**
 * How much this matters: a 1-3 star rating, `null` when nobody has rated it. One axis for
 * initiatives AND tasks since 2026-08-24, replacing the task-only defect `severity` (p1/p2/p3/fixed
 * - migration `015` mapped p1->3, p2->2, p3->1, `fixed` -> unrated). Severity answered "how bad is
 * this bug", which only ever applied to a quarter of the board and said nothing about the rest;
 * three stars answer "how much does this matter" for every row, which is the question a planning
 * board is actually sorted by. Deliberately three steps and not five - see CONTENT.md § Priority.
 */
export type Priority = 1 | 2 | 3
export const PRIORITIES: Priority[] = [1, 2, 3]

/** Coerce anything a caller sends into a valid rating (1-3) or null. Out-of-range is a clear. */
export function normalizePriority(v: number | null | undefined): Priority | null {
  if (v === null || v === undefined) return null
  const n = Math.round(v)
  return n === 1 || n === 2 || n === 3 ? (n as Priority) : null
}

/**
 * A title is a LABEL, not a description - "Improve Recurring Tasks", not "Decide how recurring
 * operational routines are modelled - after the board-view fixes land, not before". Detail belongs
 * in the doc body, which is where anyone reading an item actually looks; a title carrying it
 * truncates on every card and makes the board unscannable.
 */
export const TITLE_MAX = 64

/**
 * Refuse an over-long title, but ONLY when the title is actually being written. A carried-forward
 * one is left alone on purpose: 41 task rows predate this rule with titles up to 363 chars, and a
 * status flip must not fail because of prose nobody is touching. Same shape as the slug-path guard
 * in state.ts - new writes are held to the rule, history stays updatable.
 */
export function assertTitleLength(
  kind: 'task' | 'initiative',
  id: string,
  title: string | undefined,
  prevTitle: string | undefined,
): void {
  if (title === undefined || title === prevTitle || title.length <= TITLE_MAX) return
  throw new Error(
    `${kind} ${id}: title is ${title.length} chars, max ${TITLE_MAX} - put the detail in the doc body, not the title`,
  )
}

/** An optional, concrete goal on one of the initiative's bound signals. */
export interface InitiativeTarget {
  /** signals.signal_id this target tracks (should be one of the initiative's signal_ids). */
  signal_id: string
  /** The value to reach. */
  value: number
  /** Absolute date to reach it by (YYYY-MM-DD), if time-bound. */
  by_date?: string
  /** The signal value when the initiative started, for progress display. */
  baseline?: number
}

export interface Initiative {
  id: string
  title: string
  /**
   * One-line preview shown under the title on the board. **Derived, not typed** since 2026-08-24:
   * it is the first paragraph of this row's markdown doc, refreshed by `savePlanningDoc`. There is
   * no input field for it - write the doc.
   */
  summary: string
  status: PlanningStatus
  /** What shape of work this is - the board's primary grouping axis. */
  kind: InitiativeKind
  owner: string | null
  /** signals.signal_id values this initiative is meant to drive. The signals-bound contract: ≥1. */
  signal_ids: string[]
  target: InitiativeTarget | null
  /** Worth to the people we serve. null = not yet judged. */
  value_customer: ValueLevel | null
  /** Worth to us - revenue, retention, differentiation, our own operating leverage. */
  value_company: ValueLevel | null
  /** How much this matters: 1-3 stars, null = unrated. Same axis as a task's. */
  priority: Priority | null
  /**
   * `initiatives.id` values this one waits on. The edge list behind the critical-path view: an
   * initiative with inbound edges (something else lists it here) is a *foundation*. Kept acyclic on
   * write, and re-pointed/pruned when a referenced initiative is renamed or deleted.
   */
  blocked_by: string[]
  /**
   * Free-form labels - the pressure valve that keeps the typed columns short. Product area, the
   * customer who asked, the source: anything that wants to be filterable without earning a column.
   */
  tags: string[]
  /**
   * Deadline as a naive calendar date (`YYYY-MM-DD`), or null. A DATE, not a timestamp: a deadline
   * is a day, and a time-of-day would be invented precision. "Overdue" is not stored - it is a
   * display judgment (past AND the work is still open), computed where it is shown.
   */
  due_date: string | null
  /** Path to the long-form markdown (e.g. docs/initiatives/silkweave-pr-targets.md). */
  doc_path: string | null
  sort: number
  created_at: string
  updated_at: string
  /** users.id that created / last edited the row via the dashboard; null for agent/MCP writes. */
  created_by: string | null
  updated_by: string | null
}

export interface Task {
  id: string
  /**
   * The initiative this task is under, or null for a SPRINT TASK - one made straight onto a sprint's
   * grid (2026-09-14). A sprint task is keyed `<sprint>/<task>`, lives only inside `sprint_id`, and
   * is refused any write that would take it out (see `upsertTask`); deleting the sprint deletes it.
   */
  initiative_id: string | null
  /** Short-form title (the identifier line). */
  title: string
  /** Longer one-line description shown under the title on cards. */
  summary: string
  status: PlanningStatus
  /** Ordering within the initiative (lower = higher priority); the "top 3" sit at the front. */
  rank: number
  /** Optional numeric score (e.g. a 0–15 rubric total). */
  score: number | null
  /** How much this matters: 1-3 stars, null = unrated. */
  priority: Priority | null
  /** How long this task is expected to take, in whole hours 1-8. null = not estimated. */
  estimate_hours: number | null
  /** Free-form labels, same role as the initiative's (product area, reporter, source). */
  tags: string[]
  url: string | null
  /** users.id this task is assigned to, or null (unassigned). */
  assignee: string | null
  /** Flexible bag for kind-specific fields: repo, stars, stage, rubric breakdown, PR url… */
  metadata: Record<string, unknown>
  /** Deadline as a naive calendar date (`YYYY-MM-DD`), or null. Same semantics as the initiative's. */
  due_date: string | null
  /** The sprint this task is scoped into, or null. A task is in at most one sprint, which is why
   *  this is a column and not a join table. */
  sprint_id: string | null
  /** The DAY inside that sprint the plan puts it on (`YYYY-MM-DD`), or null when it is in scope but
   *  not yet slotted. Distinct from `due_date`: a deadline is a promise, a slot is a plan. */
  slot_date: string | null
  created_at: string
  updated_at: string
  /** Set when status becomes 'done'; cleared otherwise. Feeds derived outcome signals. */
  done_at: string | null
  /** users.id that created / last edited the row via the dashboard; null for agent/MCP writes. */
  created_by: string | null
  updated_by: string | null
}

export interface InitiativeWithTasks extends Initiative {
  tasks: Task[]
}

/** Partial upsert input - `id` identifies the row; any provided field overwrites, the rest persist. */
export interface InitiativeInput {
  id: string
  title?: string
  status?: PlanningStatus
  kind?: InitiativeKind
  owner?: string | null
  signal_ids?: string[]
  target?: InitiativeTarget | null
  value_customer?: ValueLevel | null
  value_company?: ValueLevel | null
  /** 1-3 stars; null (or an out-of-range number) clears the rating. */
  priority?: number | null
  blocked_by?: string[]
  tags?: string[]
  doc_path?: string | null
  /** Deadline `YYYY-MM-DD`; null clears it. */
  due_date?: string | null
  sort?: number
  /** users.id performing this mutation (stamps created_by on insert, updated_by always). */
  actor?: string
}

export interface TaskInput {
  id: string
  initiative_id?: string
  title?: string
  status?: PlanningStatus
  rank?: number
  score?: number | null
  /** 1-3 stars; null (or an out-of-range number) clears the rating. */
  priority?: number | null
  /** Whole hours 1-8 (rounded + clamped); null or 0 clears the estimate. */
  estimate_hours?: number | null
  tags?: string[]
  url?: string | null
  assignee?: string | null
  metadata?: Record<string, unknown>
  /** Deadline `YYYY-MM-DD`; null clears it. */
  due_date?: string | null
  /** Scope this task into a sprint; null takes it out. Setting it does NOT slot it onto a day. */
  sprint_id?: string | null
  /** Put it on a day inside the sprint (`YYYY-MM-DD`); null unslots it while keeping it in scope. */
  slot_date?: string | null
  /** Explicit merge/done timestamp (e.g. seeding a historical PR); else managed from `status`. */
  done_at?: string | null
  /** users.id performing this mutation (stamps created_by on insert, updated_by always). */
  actor?: string
}

/**
 * A sprint's lifecycle, four steps before the terminal one, each moved by a human (features/planning/SPEC.md
 * § Sprints):
 *   pending   - created, no dates agreed yet.
 *   scheduled - Sprint Design done: date range + per-person availability are set.
 *   planned   - Sprint Planning done: tasks assigned and the capacity check passes.
 *   active    - kicked off. At most one sprint should be active, but nothing enforces that: two
 *               overlapping sprints is a real thing teams do, and a guard here would be a guess.
 *   done      - closed out.
 * Deliberately NOT `PlanningStatus`: a sprint is not a body of work, it is a window with capacity,
 * and `blocked`/`dropped` mean nothing for one.
 */
export type SprintStatus = 'pending' | 'scheduled' | 'planned' | 'active' | 'done'

export const SPRINT_STATUSES: SprintStatus[] = ['pending', 'scheduled', 'planned', 'active', 'done']

/** Hours a person is assumed available on a working day when the sprint says nothing. Not 8: the
 *  spec's reason is that ops, meetings and interrupts eat the rest, and planning against 8 is how a
 *  sprint ends up 60% delivered. */
export const DEFAULT_SPRINT_HOURS = 5

/** A window of days with capacity. See planning/sprints.ts for the arithmetic over it. */
export interface Sprint {
  id: string
  title: string
  /** One line on what this sprint is for. Long-form rationale belongs in an initiative, not here. */
  goal: string
  status: SprintStatus
  /** Full calendar days, inclusive. Null until Sprint Design sets them. */
  start_date: string | null
  end_date: string | null
  /** users.id -> per-person availability inside THIS sprint (`SprintAvailability`). */
  availability: Record<string, { hours?: number; hours_by_date?: Record<string, number> }>
  /** When a human kicked it off. Null until then. */
  started_at: string | null
  done_at: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

/** Partial upsert input - `id` identifies the row; any provided field overwrites, the rest persist. */
export interface SprintInput {
  id: string
  title?: string
  goal?: string
  status?: SprintStatus
  start_date?: string | null
  end_date?: string | null
  availability?: Record<string, { hours?: number; hours_by_date?: Record<string, number> }>
  actor?: string
}
