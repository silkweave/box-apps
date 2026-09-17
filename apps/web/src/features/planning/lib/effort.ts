// Size arithmetic: what an initiative's tasks add up to, and how that sum reads as a bucket.
//
// Since 2026-09-08 an initiative has NO size of its own - it is always the sum of its tasks'
// `estimate_hours`, computed here and shown read-only. A hand-set size was a judgement made once at
// the start and never revisited, and the board's job was then to referee it against the work
// underneath; deleting the judgement deletes the referee (`rollupEffort`'s `conflict` went with it).
//
// A sum over a half-estimated list is a number that reads as knowledge and is not, so the count of
// unestimated tasks travels WITH the total rather than being folded into it.

import { EFFORT_HOURS, EFFORTS, TERMINAL_PLANNING_STATUSES, type Effort, type Initiative, type Task } from '../planning-types.ts'

/**
 * The tasks a size is answerable for: everything except `dropped`. `done` work still counts - the
 * question "how big is this initiative" is about the whole of it, not about what is left, and an
 * initiative whose size shrank as it was delivered would be unreadable.
 */
export const sizedTasks = (tasks: Task[]): Task[] => tasks.filter((t) => t.status !== 'dropped')

/** `24h` / `7.5h` - an hour figure, said the way a person would say it. */
export const formatHours = (hours: number): string => `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`

export interface EffortRollup {
  /** The summed estimate of the tasks that carry one, or null when none of them do. */
  hours: number | null
  /** Counted tasks with no estimate. Non-zero means `hours` is a floor, not a total. */
  unsized: number
  /** How many tasks the sum is over (excluding `dropped`). */
  counted: number
  /** Which day-scale bucket `hours` falls in - the board's grouping axis. null when unestimated. */
  tier: Effort | null
}

/** What an initiative's Size cell should say: the sum of its tasks, and how complete that sum is. */
export function rollupEffort(initiative: Pick<Initiative, 'tasks'>): EffortRollup {
  const counted = sizedTasks(initiative.tasks)
  const rated = counted.filter((t) => typeof t.estimate_hours === 'number')
  const hours = rated.length ? rated.reduce((acc, t) => acc + (t.estimate_hours ?? 0), 0) : null
  return {
    hours,
    unsized: counted.length - rated.length,
    counted: counted.length,
    tier: hours === null ? null : hoursToEffort(hours),
  }
}

/** The day-scale bucket an hour figure lands in: <1d · 1d-1w · 1w-4w · 4w+. */
export function hoursToEffort(hours: number): Effort {
  for (const step of EFFORTS) {
    const { max } = EFFORT_HOURS[step]
    if (max === null || hours <= max) return step
  }
  return 'xl'
}

/** Sort key for an initiative's derived size. Unestimated sorts first (nothing to compare). */
export const effortSortRank = (hours: number | null): number => hours ?? 0

/** Re-exported so a view can ask "does this row still count" without a second import. */
export const isTerminal = (status: Task['status']): boolean => TERMINAL_PLANNING_STATUSES.includes(status)
