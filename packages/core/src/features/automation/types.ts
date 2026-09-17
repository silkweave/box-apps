// Automation feature - cron schedules over core's action registry. Schedules live in
// config/schedules.json (loaded once at server boot); every fire goes through core's ops funnel
// (ops/run.ts), which records the run. The run/action vocabulary itself is core's (ops/types.ts).

/** One schedule entry in config/schedules.json. */
export interface Schedule {
  /** Stable slug id (a-z, 0-9, -). */
  id: string
  /** The automation action to run (see listAutomationActions()). */
  action_id: string
  /** Full 5-field cron expression, evaluated in the server's local timezone. */
  cron: string
  enabled: boolean
  description?: string
}

export interface SchedulesFile {
  schedules: Schedule[]
}
