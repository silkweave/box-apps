// The `data` feature's own writers for the two tables it owns that core used to write for it:
// `snapshots` (raw pull payloads) and `legacy_signal_points` (the tidy rows every derive and
// backfill produces). They lived in `packages/core/src/warehouse/db.ts` until 2026-09-13, which
// made core name a feature's tables; nothing broke, because only feature code called them, but it
// is the same class of defect as core's `deleteUser` naming planning's columns.
//
// They stay raw SQL rather than going through the record layer: `replaceChannelSignals` is a
// DELETE-then-UPSERT whose ON CONFLICT clause changes per row (live overwrites, backfill only
// fills gaps), which is precedence logic the partial upsert has no way to express.

import { ensureSchema, withWrite } from '../../../warehouse/db.js'
import { emitChange } from '../../../changes.js'

/**
 * UPSERT a raw pull payload (replaces writeSnapshot). Keyed on (channel, date), so re-running a
 * pull for the same date overwrites in place - same idempotency the dated JSON files gave us.
 */
export async function upsertSnapshot(channel: string, date: string, payload: unknown): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    await conn.run(
      `INSERT INTO snapshots (channel, snapshot_date, fetched_at, payload)
       VALUES (?, ?::DATE, now(), ?::JSON)
       ON CONFLICT (channel, snapshot_date)
       DO UPDATE SET fetched_at = excluded.fetched_at, payload = excluded.payload`,
      [channel, date, JSON.stringify(payload)],
    )
  })
  emitChange('table:snapshots')
}

/** One tidy signal row, as produced by deriveSignals / backfills. */
export interface SignalRow {
  channel: string
  signal_id: string
  label: string
  signal_group: string
  unit: string | null
  date: string
  value: number
  source?: 'live' | 'backfill'
}

/**
 * Replace `channel`'s live signal rows, then UPSERT the given rows. `live` rows overwrite on
 * conflict; `backfill` rows only fill gaps (DO NOTHING) so a live value always wins on a shared date.
 */
export async function replaceChannelSignals(channel: string, rows: SignalRow[]): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    await conn.run(`DELETE FROM legacy_signal_points WHERE channel = ? AND source = 'live'`, [channel])
    for (const r of rows) {
      const source = r.source ?? 'live'
      const conflict =
        source === 'live'
          ? `DO UPDATE SET channel = excluded.channel, label = excluded.label,
               signal_group = excluded.signal_group, unit = excluded.unit,
               value = excluded.value, source = excluded.source`
          : `DO NOTHING`
      await conn.run(
        `INSERT INTO legacy_signal_points (channel, signal_id, label, signal_group, unit, date, value, source)
         VALUES (?, ?, ?, ?, ?, ?::DATE, ?, ?)
         ON CONFLICT (signal_id, date) ${conflict}`,
        [r.channel, r.signal_id, r.label, r.signal_group, r.unit, r.date, r.value, source],
      )
    }
  })
  emitChange('table:signals')
}

/**
 * Replace a single signal' rows regardless of source. For derived-ledger signal that live inside a
 * channel someone else re-derives (e.g. `github.oss_prs_merged` in the pull-derived `github`
 * channel) - the channel-level replace handles the pull path, this handles task-mutation re-derives.
 */
export async function replaceSignalRows(signalId: string, rows: SignalRow[]): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    await conn.run(`DELETE FROM legacy_signal_points WHERE signal_id = ?`, [signalId])
    for (const r of rows) {
      await conn.run(
        `INSERT INTO legacy_signal_points (channel, signal_id, label, signal_group, unit, date, value, source)
         VALUES (?, ?, ?, ?, ?, ?::DATE, ?, ?)
         ON CONFLICT (signal_id, date) DO UPDATE SET channel = excluded.channel, label = excluded.label,
           signal_group = excluded.signal_group, unit = excluded.unit,
           value = excluded.value, source = excluded.source`,
        [r.channel, r.signal_id, r.label, r.signal_group, r.unit, r.date, r.value, r.source ?? 'live'],
      )
    }
  })
  emitChange('table:signals')
}

/** UPSERT backfill rows (history). Only fills gaps - never clobbers a live value (DO NOTHING). */
export async function upsertBackfillSignals(rows: SignalRow[]): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    for (const r of rows) {
      await conn.run(
        `INSERT INTO legacy_signal_points (channel, signal_id, label, signal_group, unit, date, value, source)
         VALUES (?, ?, ?, ?, ?, ?::DATE, ?, 'backfill')
         ON CONFLICT (signal_id, date) DO NOTHING`,
        [r.channel, r.signal_id, r.label, r.signal_group, r.unit, r.date, r.value],
      )
    }
  })
  emitChange('table:signals')
}
