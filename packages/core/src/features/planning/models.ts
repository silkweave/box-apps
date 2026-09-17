// The planning feature's tables: initiatives, tasks, sprints and sprint check-ins.

import type { ModelSpec } from '../../warehouse/model.js'
import { PLANNING_STATUSES, SPRINT_STATUSES, VALUE_LEVELS } from './types.js'
import { DEFAULT_INITIATIVE_KIND, initiativeKindIds } from './kinds.js'

/** Signals-bound bodies of work; `signal_ids` binds each to the numbers it drives. */
export const INITIATIVES: ModelSpec = {
  table: 'initiatives',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },
    title: { kind: 'text' },
    summary: { kind: 'text', default: "''" },
    status: { kind: 'text', default: "'planned'", enum: PLANNING_STATUSES },
    kind: { kind: 'text', default: `'${DEFAULT_INITIATIVE_KIND}'`, enum: initiativeKindIds },
    owner: { kind: 'text', nullable: true },
    signal_ids: { kind: 'json', default: "'[]'" },
    target: { kind: 'json', nullable: true },
    value_customer: { kind: 'text', nullable: true, enum: VALUE_LEVELS },
    value_company: { kind: 'text', nullable: true, enum: VALUE_LEVELS },
    // How much it matters: 1-3 stars, NULL = unrated. The same axis tasks carry (migration 015).
    priority: { kind: 'int', nullable: true },
    blocked_by: { kind: 'json', default: "'[]'" },
    tags: { kind: 'json', default: "'[]'" },
    doc_path: { kind: 'text', nullable: true },
    due_date: { kind: 'date', nullable: true },
    sort: { kind: 'int', default: '0' },
  },
  timestamps: true,
  audit: true,
}

/** Units under an initiative; id is the slug path `<initiative>/<task>`; `done_at` feeds signals. */
export const TASKS: ModelSpec = {
  table: 'tasks',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },
    // NULL = a SPRINT task (planning migration 001): made on the sprint grid, owned by the sprint
    // rather than by any initiative, id `<sprint>/<task>`. It never leaves its sprint - see
    // `upsertTask`.
    initiative_id: { kind: 'text', nullable: true },
    title: { kind: 'text' },
    summary: { kind: 'text', default: "''" },
    status: { kind: 'text', default: "'planned'", enum: PLANNING_STATUSES },
    rank: { kind: 'int', default: '0' },
    score: { kind: 'float', nullable: true },
    // How much it matters: 1-3 stars, NULL = unrated (replaced the p1/p2/p3 `severity` in 015).
    priority: { kind: 'int', nullable: true },
    // The estimate, in whole hours 1-8, NULL = not estimated (migration 024 replaced the t-shirt
    // `effort` enum with it). An initiative has no size column at all: its size is the sum of these.
    estimate_hours: { kind: 'int', nullable: true },
    tags: { kind: 'json', default: "'[]'" },
    url: { kind: 'text', nullable: true },
    assignee: { kind: 'text', nullable: true },
    metadata: { kind: 'json', default: "'{}'" },
    due_date: { kind: 'date', nullable: true },
    // Which sprint this task is scoped into, and which DAY inside it the plan puts it on. A column
    // rather than a join table because a task is in at most one sprint, and a nullable `slot_date`
    // rather than a fourth table because a slot holds exactly one fact. Both are NULL for the
    // overwhelming majority of rows: the board does not require a sprint.
    //
    // BOTH MUST BE LISTED IN `rekeyTask` (planning/state.ts) - it hand-writes its column list, so a
    // planning column missing from it is silently nulled on every task MOVE and every RENAME.
    sprint_id: { kind: 'text', nullable: true },
    slot_date: { kind: 'date', nullable: true },
    done_at: { kind: 'timestamp', nullable: true },
  },
  timestamps: true,
  audit: true,
}

/**
 * A window of days with capacity, and the scope planned into it. Initiatives are NEVER assigned to a
 * sprint - the spec is explicit that they are INFERRED from the sprint's tasks, so there is no
 * initiative_id here and there never should be.
 *
 * Dates are full days (`date`, not `timestamp`): a sprint has no start time, and giving it one would
 * only invite timezone bugs into a thing every human involved reads off a calendar.
 */
export const SPRINTS: ModelSpec = {
  table: 'sprints',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },
    title: { kind: 'text' },
    goal: { kind: 'text', default: "''" },
    status: { kind: 'text', default: "'pending'", enum: SPRINT_STATUSES },
    start_date: { kind: 'date', nullable: true },
    end_date: { kind: 'date', nullable: true },
    // users.id -> { hours, hours_by_date{} }. Per-sprint rather than in config/ because availability IS
    // sprint-design data: one person's October leave says nothing about their November. See planning/sprints.ts.
    availability: { kind: 'json', default: "'{}'" },
    // When a human kicked it off (pending/scheduled/planned -> active). Null until then.
    started_at: { kind: 'timestamp', nullable: true },
    done_at: { kind: 'timestamp', nullable: true },
  },
  timestamps: true,
  audit: true,
}

/**
 * One day's stand-up, recorded. The team walks three buckets per person (done since the last working
 * day, today, slipping) and ticks each off as it is discussed; when the last one is ticked the day
 * can be completed.
 *
 * **One row per sprint-day, and the ticks are a SET inside it** rather than a row per tick. Two
 * reasons: the whole thing is read as a unit (the Board asks "where is today's check-in up to", never
 * "who ticked Dan's Today"), and a set makes the write idempotent - ticking twice from two browsers
 * is the same row. The write is server-side add/remove of ONE key, never a whole-array PUT from a
 * client, so two people ticking different buckets at the same moment cannot clobber each other.
 *
 * `date` is the sprint-day, not the wall clock: a check-in held at 09:00 on the 8th is the 8th's.
 */
export const SPRINT_CHECKINS: ModelSpec = {
  table: 'sprint_checkins',
  pk: ['sprint_id', 'date'],
  columns: {
    sprint_id: { kind: 'text' },
    date: { kind: 'date' },
    // `<users.id>:<bucket>` strings, e.g. `dan:today`. Buckets are named in planning/sprints.ts.
    ticks: { kind: 'json', default: "'[]'" },
    // Set when a human closes the day out. Null while it is still in progress.
    completed_at: { kind: 'timestamp', nullable: true },
    completed_by: { kind: 'text', nullable: true },
  },
  timestamps: true,
  audit: true,
}

export const PLANNING_MODELS: readonly ModelSpec[] = [INITIATIVES, TASKS, SPRINTS, SPRINT_CHECKINS]
