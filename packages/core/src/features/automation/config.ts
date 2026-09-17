// Schedules config - config/schedules.json is the source of truth for what runs when (checked in,
// full cron expressions). The dashboard CRUDs this file through the server, but the scheduler only
// reads it ONCE at boot: after an edit the file diverges from the loaded state and the TopBar shows
// "Restart Required" (compare via canonicalSchedules, robust against formatting-only writes).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CronExpressionParser } from 'cron-parser'
import cronstrue from 'cronstrue'
import { configPath } from '../../io.js'
import { listAutomationActions } from '../../ops/registry.js'
import type { Schedule, SchedulesFile } from './types.js'

/** One slug segment: lowercase, digits, dashes; must start alphanumeric (repo-wide convention). */
const SLUG_SEG = /^[a-z0-9][a-z0-9-]*$/

export function schedulesPath(): string {
  return configPath('schedules.json')
}

/** Parse the config file; a missing file is an empty schedule list, malformed JSON throws. */
export function readSchedulesFile(): SchedulesFile {
  const file = schedulesPath()
  if (!existsSync(file)) return { schedules: [] }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as SchedulesFile
  if (!raw || !Array.isArray(raw.schedules)) {
    throw new Error(`${file} must have shape { "schedules": [...] }`)
  }
  return raw
}

/** Pretty-print the config back to disk (2-space, trailing newline - diff-friendly). */
export function writeSchedulesFile(file: SchedulesFile): void {
  const path = schedulesPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
}

/**
 * Stable fingerprint of a schedules file for the restart-required comparison: normalized field
 * order, sorted by id (reordering entries in the file is not a semantic change).
 */
export function canonicalSchedules(file: SchedulesFile): string {
  const norm = [...file.schedules]
    .map((s) => ({
      id: s.id,
      action_id: s.action_id,
      cron: s.cron,
      enabled: s.enabled,
      description: s.description ?? '',
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return JSON.stringify(norm)
}

/** Human-friendly cron ("At 07:00 AM"); falls back to the raw expression when unparsable. */
export function humanizeCron(expr: string): string {
  try {
    return cronstrue.toString(expr)
  } catch {
    return expr
  }
}

/** Next fire time of a cron expression (server-local timezone), or null when unparsable. */
export function nextCronFire(expr: string): Date | null {
  try {
    return CronExpressionParser.parse(expr).next().toDate()
  } catch {
    return null
  }
}

/**
 * Validate one schedule entry - throws with a human-readable reason. Used by the upsert mutation
 * (fail loudly); the scheduler validates softly at boot (an invalid entry is surfaced but not armed).
 */
export function validateSchedule(s: Schedule): void {
  if (!SLUG_SEG.test(s.id)) throw new Error(`invalid schedule id "${s.id}" (use a-z, 0-9, -)`)
  if (!s.action_id) throw new Error(`schedule "${s.id}": action_id is required`)
  const action = listAutomationActions().find((a) => a.id === s.action_id)
  if (!action) {
    throw new Error(`schedule "${s.id}": unknown action "${s.action_id}" (see the actions catalog)`)
  }
  if (action.parameterized) {
    throw new Error(`schedule "${s.id}": "${s.action_id}" takes per-run params and cannot be scheduled`)
  }
  try {
    CronExpressionParser.parse(s.cron)
  } catch (err) {
    throw new Error(`schedule "${s.id}": invalid cron "${s.cron}" - ${String((err as Error).message)}`)
  }
}

/** Boot-time soft check: the reason a schedule can't be armed, or null when it is valid. */
export function scheduleProblem(s: Schedule): string | null {
  try {
    validateSchedule(s)
    return null
  } catch (err) {
    return String((err as Error).message)
  }
}
