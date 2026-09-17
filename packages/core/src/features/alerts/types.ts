// Alert data model - the rule config, the source event an evaluator produces, and the recorded row.
// See features/alerts/SPEC.md. v1 keeps the rule set a small, closed thing (config-file only).

/** A source event any evaluator normalizes to before matching rules. Kind namespaces the source. */
export type { EventInput as AlertEvent } from '../../events.js'

/** A declarative alert rule from config/alerts.json. A closed `event` set to start. */
export interface AlertRule {
  id: string
  /** The AlertEvent.kind this rule listens for. */
  event: string
  /** Delivery route - `owner` | `user:<id>` | `channel` (resolved to a Lark target at delivery). */
  route: string
  /** Message template; `{field}` tokens are filled from the event's `fields`. */
  message: string
  /** Optional per-rule suppression window (minutes) applied at delivery. 0/absent = none. */
  cooldown_min?: number
  enabled: boolean
  /** Signal rules only (`signal.*`): the warehouse signal this rule watches. */
  signal_id?: string
  /** `signal.threshold` only: the value the signal must reach/cross upward to fire. */
  threshold?: number
  /**
   * Notify class (alerts v2): `realtime` records an alert row + batched Lark delivery (default);
   * `digest` records the EVENT only - no alert row, no DM - and the daily digest + traction
   * detection pick it up from the events table instead.
   */
  notify?: 'realtime' | 'digest'
  /** Delivery debounce (seconds) before the flush that carries this rule's alerts. Default 300. */
  debounce_sec?: number
  /** `traction.spike` only: the engagement-count ladder; one alert per (subject, tier) crossed. */
  tiers?: number[]
}

/** A recorded alert row (mirrors the `alerts` table). */
export interface AlertRecord {
  id: string
  rule_id: string
  event_kind: string
  dedup_key: string
  route: string
  target: string | null
  title: string | null
  message: string
  payload: Record<string, unknown>
  status: 'pending' | 'delivered' | 'suppressed' | 'error'
  event_at: string | null
  created_at: string
  delivered_at: string | null
  error: string | null
  /** Shared id across every row that went out in the same batched Lark message (null = unsent). */
  batch_id: string | null
}

/** A candidate alert an evaluator hands to the store - the rendered message + its provenance. */
export interface AlertCandidate {
  rule_id: string
  event_kind: string
  dedup_key: string
  route: string
  title?: string
  message: string
  payload: Record<string, unknown>
  event_at?: string
}

/** Render a rule's `message` template against an event's fields. Unknown tokens are left intact. */
export function renderMessage(template: string, fields: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => fields[key] ?? whole)
}
