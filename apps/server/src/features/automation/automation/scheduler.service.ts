// The in-process cron scheduler - deliberately hand-rolled (no @nestjs/schedule): one chained
// setTimeout per enabled schedule, next fire computed via cron-parser, everything inspectable
// through status(). Loads config/schedules.json ONCE at boot; later file edits (dashboard CRUD)
// flip `restartRequired` instead of hot-reloading - see features/automation/SPEC.md.

import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common'
import { activeRuns, canonicalSchedules, env, executeRecorded, insertSkippedRun, isActionBusy, markOrphanedRuns, nextCronFire, readSchedulesFile, scheduleProblem, systemUserId, type Schedule } from '@silkweave/box-core'

// setTimeout clamps to a 32-bit signed int - rare cron expressions can fire further out than that,
// so cap the delay and re-arm (the re-arm just recomputes and sleeps again).
const MAX_DELAY_MS = 2 ** 31 - 1

/** A schedule as loaded at boot: the config entry + its armed-timer state. */
export interface LoadedSchedule extends Schedule {
  /** Why the entry could not be armed (unknown action, bad cron), or null when valid. */
  problem: string | null
  /** Next computed fire time (ISO), null when disabled/invalid. */
  nextFire: string | null
}

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name)
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private loaded: LoadedSchedule[] = []
  private loadedCanonical = ''
  private loadedAt = ''
  private disabled = false

  async onApplicationBootstrap(): Promise<void> {
    const orphans = await markOrphanedRuns()
    if (orphans > 0) this.logger.warn(`marked ${orphans} orphaned run(s) from a previous process as error`)

    // Background work is OPT-IN: schedules only arm when AUTOMATION_ENABLED=1, which belongs in
    // the env of the always-on Box. The safe default keeps a dev checkout, a throwaway boot and CI
    // from silently firing a team's real crons.
    this.disabled = env('AUTOMATION_ENABLED') !== '1'
    const file = readSchedulesFile()
    this.loadedCanonical = canonicalSchedules(file)
    this.loadedAt = new Date().toISOString()
    this.loaded = file.schedules.map((s) => ({ ...s, problem: scheduleProblem(s), nextFire: null }))

    if (this.disabled) {
      this.logger.warn('AUTOMATION_ENABLED is not 1 - schedules loaded but no timers armed (dev-safe default; set AUTOMATION_ENABLED=1 in .env to run them)')
      return
    }
    for (const s of this.loaded) {
      if (!s.enabled) continue
      if (s.problem) {
        this.logger.warn(`schedule "${s.id}" not armed: ${s.problem}`)
        continue
      }
      this.arm(s)
    }
    const armed = this.loaded.filter((s) => s.enabled && !s.problem)
    this.logger.log(`armed ${armed.length}/${this.loaded.length} schedule(s) from config/schedules.json`)
  }

  onModuleDestroy(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  /** Compute the next fire and sleep toward it (capped + re-armed for far-future fires). */
  private arm(s: LoadedSchedule): void {
    const next = nextCronFire(s.cron)
    if (!next) return // validated at boot; a parse failure here would be a cron-parser regression
    s.nextFire = next.toISOString()
    const delay = next.getTime() - Date.now()
    if (delay > MAX_DELAY_MS) {
      this.timers.set(s.id, setTimeout(() => this.arm(s), MAX_DELAY_MS))
      return
    }
    this.timers.set(
      s.id,
      setTimeout(() => {
        void this.fire(s).finally(() => this.arm(s))
      }, Math.max(0, delay)),
    )
  }

  /** One cron fire: skip (recorded) when the action is already queued/running, else run+record. */
  private async fire(s: LoadedSchedule): Promise<void> {
    try {
      if (isActionBusy(s.action_id)) {
        this.logger.warn(`schedule "${s.id}" skipped - action "${s.action_id}" already queued/running`)
        await insertSkippedRun(s.id, s.action_id, `skipped - "${s.action_id}" was already queued/running`)
        return
      }
      this.logger.log(`schedule "${s.id}" firing action "${s.action_id}"`)
      // Drain silently: executeRecorded persists progress + outcome; errors are already recorded.
      // Attributed to the `nova` system principal: a scheduled run has no human behind it, and
      // leaving triggered_by null made the Automation view's "who ran this" column simply blank.
      for await (const _ of executeRecorded(s.action_id, {
        trigger: 'schedule',
        scheduleId: s.id,
        triggeredBy: systemUserId(),
      })) {
        /* progress is buffered into the run's log */
      }
    } catch (err) {
      this.logger.error(`schedule "${s.id}" run failed: ${String((err as Error)?.message ?? err)}`)
    }
  }

  /** Scheduler state for the dashboard: loaded schedules, restart drift, in-flight runs. */
  status(): {
    loadedAt: string
    disabled: boolean
    restartRequired: boolean
    schedules: LoadedSchedule[]
    running: { runId: string; actionId: string; state: 'queued' | 'running' }[]
  } {
    let restartRequired = false
    try {
      restartRequired = canonicalSchedules(readSchedulesFile()) !== this.loadedCanonical
    } catch {
      restartRequired = true // the file on disk is currently unreadable/malformed → it diverged
    }
    return {
      loadedAt: this.loadedAt,
      disabled: this.disabled,
      restartRequired,
      schedules: this.loaded,
      running: activeRuns(),
    }
  }
}
