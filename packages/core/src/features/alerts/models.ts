// The alerts feature's table: fired-alert history, deduped by (rule_id, dedup_key). The events it
// reacts to live in core's `events` table.

import type { ModelSpec } from '../../warehouse/model.js'

/** Fired-alert history, deduped by (rule_id, dedup_key). */
export const ALERTS: ModelSpec = {
  table: 'alerts',
  pk: ['rule_id', 'dedup_key'],
  columns: {
    id: { kind: 'text' },
    rule_id: { kind: 'text' },
    event_kind: { kind: 'text' },
    dedup_key: { kind: 'text' },
    route: { kind: 'text' },
    target: { kind: 'text', nullable: true },
    title: { kind: 'text', nullable: true },
    message: { kind: 'text' },
    payload: { kind: 'json', default: "'{}'" },
    status: { kind: 'text', default: "'pending'", enum: ['pending', 'delivered', 'suppressed', 'error'] },
    event_at: { kind: 'timestamp', nullable: true },
    created_at: { kind: 'timestamp', default: 'now()' },
    delivered_at: { kind: 'timestamp', nullable: true },
    error: { kind: 'text', nullable: true },
    batch_id: { kind: 'text', nullable: true },
  },
}

export const ALERTS_MODELS: readonly ModelSpec[] = [ALERTS]
