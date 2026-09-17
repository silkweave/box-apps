// Load + validate + edit config/alerts.json - the checked-in rule set (mirrors config/schedules.json).
// A missing file means "no rules configured" (feature dormant), not an error. Unlike schedules, the
// file is read fresh on every evaluation, so dashboard CRUD edits (upsert/delete below) apply on the
// next event - no restart. The JSON file stays the single source of truth; there is no rules table.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { configPath } from '../../io.js'
import type { AlertRule } from './types.js'

export function alertsConfigPath(): string {
  return configPath('alerts.json')
}

interface AlertsFile {
  /** Human-facing field reference kept at the top of the file - preserved verbatim on writes. */
  _readme?: string
  rules?: AlertRule[]
}

/** Shape-check one rule; throws with a human-actionable message (shared by loader + CRUD). */
export function validateAlertRule(r: AlertRule): void {
  if (!r.id || !r.event || !r.route || !r.message) {
    throw new Error(`invalid alert rule ${JSON.stringify(r.id ?? r)}: id, event, route, message are required`)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(r.id)) {
    throw new Error(`invalid alert rule id "${r.id}": lowercase kebab-case only`)
  }
  if (
    r.route !== 'owner' &&
    r.route !== 'channel' &&
    !/^user:[a-z0-9-]+$/.test(r.route) &&
    !/^chat:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(r.route)
  ) {
    throw new Error(
      `invalid alert rule "${r.id}": route must be owner | user:<id> | channel | chat:<room-slug>`
    )
  }
  if (r.notify !== undefined && r.notify !== 'realtime' && r.notify !== 'digest') {
    throw new Error(`invalid alert rule "${r.id}": notify must be realtime | digest`)
  }
  if (r.event.startsWith('signal.') && !r.signal_id) {
    throw new Error(`invalid alert rule "${r.id}": ${r.event} needs a signal_id`)
  }
  if (r.event === 'signal.threshold' && typeof r.threshold !== 'number') {
    throw new Error(`invalid alert rule "${r.id}": signal.threshold needs a numeric threshold`)
  }
  if (r.tiers !== undefined && (!Array.isArray(r.tiers) || r.tiers.some((t) => typeof t !== 'number'))) {
    throw new Error(`invalid alert rule "${r.id}": tiers must be an array of numbers`)
  }
}

function readAlertsFile(): AlertsFile {
  const file = alertsConfigPath()
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, 'utf8')) as AlertsFile
}

/** Pretty-print the file back to disk - `_readme` first, 2-space, trailing newline (diff-friendly). */
function writeAlertsFile(file: AlertsFile): void {
  const path = alertsConfigPath()
  mkdirSync(dirname(path), { recursive: true })
  const out: AlertsFile = {}
  if (file._readme) out._readme = file._readme
  out.rules = file.rules ?? []
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
}

/** All rules from config/alerts.json (empty if the file is absent). Malformed JSON throws. */
export function loadAlertRules(): AlertRule[] {
  const rules = readAlertsFile().rules ?? []
  for (const r of rules) validateAlertRule(r)
  return rules
}

/** Enabled rules listening for a given event kind. */
export function rulesForEvent(kind: string): AlertRule[] {
  return loadAlertRules().filter((r) => r.enabled && r.event === kind)
}

/**
 * Create or replace one rule in config/alerts.json (matched by id, order preserved; new rules
 * append). Validates before touching the file; applies on the next evaluation.
 */
export function upsertAlertRule(rule: AlertRule): AlertRule[] {
  validateAlertRule(rule)
  const file = readAlertsFile()
  const rules = file.rules ?? []
  const at = rules.findIndex((r) => r.id === rule.id)
  if (at >= 0) rules[at] = rule
  else rules.push(rule)
  writeAlertsFile({ ...file, rules })
  return rules
}

/** Remove one rule from config/alerts.json by id; throws when the id is unknown. */
export function deleteAlertRule(id: string): AlertRule[] {
  const file = readAlertsFile()
  const rules = file.rules ?? []
  if (!rules.some((r) => r.id === id)) throw new Error(`no alert rule "${id}"`)
  const next = rules.filter((r) => r.id !== id)
  writeAlertsFile({ ...file, rules: next })
  return next
}

/** Alerts' contribution to data: re-point rule `signal_id`s when a signal is renamed. */
export async function repointAlertRuleSignals(oldId: string, newId: string): Promise<void> {
  for (const rule of loadAlertRules()) {
    if (rule.signal_id === oldId) upsertAlertRule({ ...rule, signal_id: newId })
  }
}

export async function alertRulesReferencingSignal(signalId: string): Promise<string[]> {
  return loadAlertRules().filter((r) => r.signal_id === signalId).map((r) => `alert-rule:${r.id}`)
}
