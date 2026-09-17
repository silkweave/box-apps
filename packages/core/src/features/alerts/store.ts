// Alert persistence - the dedup gate + read side. recordAlerts() is the single write path: it
// inserts only rows whose (rule_id, dedup_key) is new, so re-evaluating the same source event is a
// no-op. Delivery (Slice 3) flips status/target/delivered_at; here every fresh alert lands `pending`.
//
// The dedup insert and the status-flip keep their raw SQL (INSERT … ON CONFLICT DO NOTHING …
// RETURNING is the idempotency gate the record layer's partial upsert must not replace); the read
// side goes through the record layer (warehouse/model.ts + the ALERTS spec), which owns the
// column list, JSON parsing, and the naive-UTC ↔ ISO-Z timestamp convention. Raw writes stamp
// their own UTC-naive timestamps (never SQL now(), which is local wall time) to match.

import { ensureSchema, withRead, withWrite } from '../../warehouse/db.js'
import { fromNaiveUtc, readRecords, rowToRecord, selectCols, toNaiveUtc } from '../../warehouse/model.js'
import { ALERTS } from './models.js'
import type { AlertCandidate, AlertRecord } from './types.js'

/** UTC-naive "now" for raw writes - the same stamp convention the record layer uses. */
const utcNow = (): string => toNaiveUtc(new Date().toISOString())

/**
 * Record only the candidates whose (rule_id, dedup_key) isn't already stored, returning the rows
 * that were newly inserted (the ones a delivery step should act on). Idempotent by construction.
 */
export async function recordAlerts(candidates: AlertCandidate[]): Promise<AlertRecord[]> {
  if (candidates.length === 0) return []
  await ensureSchema()
  return withWrite(async (conn) => {
    const inserted: AlertRecord[] = []
    for (const c of candidates) {
      const id = `${c.rule_id}:${c.dedup_key}`
      // ON CONFLICT DO NOTHING + RETURNING yields the row only when it was actually inserted.
      const res = await conn.runAndReadAll(
        `INSERT INTO alerts (id, rule_id, event_kind, dedup_key, route, title, message, payload, status, event_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::JSON, 'pending', ?::TIMESTAMP, ?::TIMESTAMP)
         ON CONFLICT (rule_id, dedup_key) DO NOTHING
         RETURNING ${selectCols(ALERTS)}`,
        [id, c.rule_id, c.event_kind, c.dedup_key, c.route, c.title ?? null, c.message,
          JSON.stringify(c.payload ?? {}), c.event_at ? toNaiveUtc(c.event_at) : null, utcNow()],
      )
      const rows = res.getRowObjectsJson() as Record<string, unknown>[]
      if (rows[0]) inserted.push(rowToRecord<AlertRecord>(ALERTS, rows[0]))
    }
    return inserted
  })
}

/** Recent alerts, newest first - for the Alerts dashboard view (Slice 5) and inspection. */
export async function listAlerts(limit = 100): Promise<AlertRecord[]> {
  return readRecords<AlertRecord>(ALERTS, { orderBy: `created_at DESC LIMIT ${Number(limit)}` })
}

/** Alerts awaiting delivery (oldest first, so retries preserve event order). */
export async function listPendingAlerts(): Promise<AlertRecord[]> {
  return readRecords<AlertRecord>(ALERTS, {
    where: `status = 'pending'`,
    orderBy: 'COALESCE(event_at, created_at) ASC',
  })
}

/** Most recent successful delivery time for a rule - the cooldown reference point. */
export async function lastDeliveredAt(ruleId: string): Promise<string | null> {
  await ensureSchema()
  const rows = await withRead<{ ts: string | null }>(
    `SELECT CAST(max(delivered_at) AS VARCHAR) AS ts FROM alerts WHERE rule_id = ? AND status = 'delivered'`,
    [ruleId],
  )
  return rows[0]?.ts ? fromNaiveUtc(rows[0].ts) : null
}

/** Terminal delivery outcome for one alert. `delivered` stamps target + delivered_at (+ batch). */
export async function markAlert(
  id: string,
  patch: { status: AlertRecord['status']; target?: string | null; error?: string | null; batch_id?: string | null },
): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    await conn.run(
      `UPDATE alerts
         SET status = ?, target = COALESCE(?, target), error = ?, batch_id = COALESCE(?, batch_id),
             delivered_at = CASE WHEN ? = 'delivered' THEN ?::TIMESTAMP ELSE delivered_at END
       WHERE id = ?`,
      [patch.status, patch.target ?? null, patch.error ?? null, patch.batch_id ?? null, patch.status, utcNow(), id],
    )
  })
}
