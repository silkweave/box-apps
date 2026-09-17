// The points layer (`signal_points`) - per-signal observations at the signal's OWN grain, phase B2
// of the signals track. Two row classes share the table, split by `source` (which is part of the
// PK so neither can overwrite the other):
//
//   • `manual` - human-entered, durable, never machine-deleted. Written one at a time
//     (setSignalPoint) or in bulk (setSignalPoints - twelve monthly Cash Balance points in one
//     call). This is the bridge until a real connector exists for a number.
//   • `live`   - machine-materialized, disposable, re-derivable at will. Today these are the
//     increment buckets: an `accumulation: 'increment'` signal stores OCCURRENCES in the `events`
//     table (kind `signal.increment`, subject = the signal id, idempotent via dedup_key) and
//     deriveSignalIncrements() rebuilds its live buckets from a bucket aggregation over them -
//     the `x.engagement` pattern (computeXEngagementRows + replaceSignalRows) promoted to a
//     general mechanism. Re-ingesting an occurrence can't double-count, late events are simply
//     present at the next re-derive, and the buckets are a projection you can always rebuild.
//
// The read path merges per bucket with **live beats manual; manual fills gaps and RESURFACES if
// the live source later retreats** - the direct descendant of the `signals` table's
// live-beats-backfill rule, implemented at read time and never by deleting the shadowed row. It
// also unifies the two stores: a signal's history is `signal_points` UNION the legacy `signals`
// rows for that signal (still owned by the derivers, at day grain), so a derived signal can take
// manual gap-fill history with no new machinery.
//
// Zero-fill for increment signals happens at READ within the served window, not in storage -
// storage stays sparse (zero-filling hourly buckets at derive would bloat the table; the daily
// zero-fill inside computeXEngagementRows is fine at day grain and stays as is).

import { randomUUID } from 'node:crypto'
import { emitChange } from '../../../changes.js'
import { ensureSchema, withRead, withWrite } from '../../../warehouse/db.js'
import { deleteRecord, readRecord, readRecords, toNaiveUtc, upsertRecord } from '../../../warehouse/model.js'
import { SIGNAL_POINTS } from '../models.js'
import { recordEvent } from '../../../events.js'
import { assertKnownActor } from '../../../users/state.js'
import { readSignalDefinition } from './definitions.js'
import type { SignalDefinition, SignalInterval, SignalPointSource } from './types.js'

/** The event kind an increment occurrence is recorded under (`subject` carries the signal id). */
export const SIGNAL_INCREMENT_KIND = 'signal.increment'

/**
 * Sub-daily signal are windowed at read to this many trailing days (design call 7, B2): an hourly
 * signal adds ~2k points to the `signalsData` payload instead of an unbounded stream. A constant
 * on purpose - not config.
 */
export const SUBDAILY_WINDOW_DAYS = 90

// --- bucket flooring (THE one shared helper - no other write path does date math) -----------------

const NAIVE_TS = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/

/**
 * Parse a caller timestamp as UTC. Offset-less inputs ('2026-08-10', '2026-08-10 14:00',
 * '2026-08-10T14:00:00') are read as UTC per the warehouse-wide naive-==-UTC rule - JS would
 * parse offset-less date-TIMES as machine-local, so they are pre-normalized before parsing.
 */
function parseUtc(at: string | Date): Date {
  if (at instanceof Date) {
    if (Number.isNaN(at.getTime())) throw new Error('invalid timestamp (Invalid Date)')
    return new Date(at.getTime())
  }
  const s = at.trim()
  const d = new Date(NAIVE_TS.test(s) ? `${s.replace(' ', 'T')}${s.includes('T') || s.includes(' ') ? 'Z' : 'T00:00:00Z'}` : s)
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp "${at}"`)
  return d
}

/**
 * Floor a timestamp to the start of a signal's interval bucket, in UTC. The single bucketing
 * implementation - every write path floors through here, and reads re-floor stored values so a
 * definition whose `interval` was edited re-buckets at read without touching storage.
 *
 * Conventions:
 *   • Offset-less inputs are UTC (see parseUtc), never machine-local.
 *   • `week` buckets are ISO weeks: Monday 00:00 UTC (matches DuckDB's date_trunc('week')).
 *   • Returns a canonical second-precision ISO-Z string ('2026-08-01T00:00:00Z'), the same shape
 *     the record layer's reads produce - flooring is idempotent on its own output.
 */
export function floorSignalBucket(at: string | Date, interval: SignalInterval): string {
  const d = parseUtc(at)
  d.setUTCMinutes(0, 0, 0)
  if (interval !== 'hour') d.setUTCHours(0)
  if (interval === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  if (interval === 'month') d.setUTCDate(1)
  return `${d.toISOString().slice(0, 19)}Z`
}

/** The bucket after `bucket` at the given interval - the read-time zero-fill stepper. */
export function nextSignalBucket(bucket: string, interval: SignalInterval): string {
  const d = new Date(bucket)
  if (interval === 'hour') d.setUTCHours(d.getUTCHours() + 1)
  else if (interval === 'day') d.setUTCDate(d.getUTCDate() + 1)
  else if (interval === 'week') d.setUTCDate(d.getUTCDate() + 7)
  else d.setUTCMonth(d.getUTCMonth() + 1)
  return `${d.toISOString().slice(0, 19)}Z`
}

/**
 * Serialize a bucket for the read payload's `points[].date` field (design call 7): day and coarser
 * buckets keep the 'YYYY-MM-DD' shape every existing consumer parses; sub-daily buckets ship the
 * full ISO timestamp in the SAME field (name kept for compatibility).
 */
export function serializeBucket(bucket: string, interval: SignalInterval): string {
  return interval === 'hour' ? bucket : bucket.slice(0, 10)
}

// --- domain shapes --------------------------------------------------------------------------------

/** One stored `signal_points` row, mapped by the record layer (bucket as ISO-Z). */
export interface SignalPointRecord {
  signal_id: string
  bucket: string
  value: number
  source: SignalPointSource
  note: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

/** A store-agnostic point handed to the merge: `live` covers machine rows from EITHER store. */
export interface StorePoint {
  bucket: string
  value: number
  source: SignalPointSource
  note: string | null
}

/** One merged (rendered) bucket: the winning value, with any shadowed manual point surfaced. */
export interface MergedSignalPoint {
  /** ISO-Z start of the interval bucket. */
  bucket: string
  value: number
  /** Where the winning value came from. Legacy `signals` rows count as `live` (machine class). */
  source: SignalPointSource
  /** The winning row's note (manual entries carry one; machine rows are null). */
  note: string | null
  /** The manual point a live value currently overrides - surfaced, never hidden; it resurfaces
   *  as the winner if the live source retreats. */
  shadowed_manual?: { value: number; note: string | null }
}

const utcNow = (): string => toNaiveUtc(new Date().toISOString())

async function requireDefinition(signalId: string): Promise<SignalDefinition> {
  const def = await readSignalDefinition(signalId)
  if (!def) {
    throw new Error(`signal ${signalId} not found - points attach to a registered signal; create the definition first (signal-upsert)`)
  }
  return def
}

/**
 * LIVE-WRITER EXCLUSIVITY (Track C). A signal bound to a data source has its `source='live'` rows
 * owned by that source's sync, exclusively. The increment machinery below is *also* a live writer
 * and DELETES every live row for a signal before rebuilding from events - pointed at a connected
 * signal it would silently vaporize the provider's entire history, and conversely the next sync
 * would clobber the event-derived buckets. Neither is a conflict the two can resolve at read time,
 * so it is refused at the door. Manual points still work on a bound signal unchanged: they are
 * shadowed by live per the merge, and resurface if the source retreats.
 */
function assertNotConnected(def: SignalDefinition, what: 'events'): void {
  if (!def.data_source_id) return
  throw new Error(
    `signal ${def.id} is connected to data source ${def.data_source_id} (measure ${def.measure_key}) - its live points come from that sync, so counting ${what} into it would destroy them. Hand-correct a bucket with signal-point-set instead, or unbind the signal first.`,
  )
}

// --- the merge (one implementation for every read) ------------------------------------------------

/**
 * Merge a signal's stores into one history, per bucket. Precedence within a bucket:
 * `signal_points` live > legacy `signals` row (live class) > manual - i.e. "live (either store)
 * over manual", with the fresher machinery preferred among machine rows. Stored buckets are
 * re-floored to the definition's CURRENT interval (an edited interval re-buckets at read;
 * last-written wins when rows collapse into one bucket). For `increment` signals the served
 * window zero-fills missing buckets from the first data bucket (or `from`) through now - a
 * display convention for "no occurrences", ranked below everything (a manual point in a quiet
 * bucket wins over the implied zero).
 */
export function mergeSignalPoints(
  def: Pick<SignalDefinition, 'interval' | 'accumulation'>,
  points: StorePoint[],
  legacyRows: { date: string; value: number }[],
  opts: { from?: string; now?: Date } = {},
): MergedSignalPoint[] {
  interface Slot {
    live?: { value: number }
    manual?: { value: number; note: string | null }
  }
  const slots = new Map<string, Slot>()
  const slot = (b: string): Slot => {
    let s = slots.get(b)
    if (!s) slots.set(b, (s = {}))
    return s
  }
  // Ascending input order makes "last wins" deterministic when re-flooring collapses rows; legacy
  // rows land first so a `signal_points` live row overwrites them (fresher machinery wins within
  // the live class).
  for (const r of [...legacyRows].sort((a, b) => a.date.localeCompare(b.date))) {
    slot(floorSignalBucket(r.date, def.interval)).live = { value: r.value }
  }
  for (const p of [...points].sort((a, b) => a.bucket.localeCompare(b.bucket))) {
    const s = slot(floorSignalBucket(p.bucket, def.interval))
    if (p.source === 'manual') s.manual = { value: p.value, note: p.note }
    else s.live = { value: p.value }
  }

  const from = opts.from ? floorSignalBucket(opts.from, def.interval) : null
  let merged: MergedSignalPoint[] = [...slots.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, s]) => {
      if (s.live) {
        return {
          bucket,
          value: s.live.value,
          source: 'live' as const,
          note: null,
          ...(s.manual ? { shadowed_manual: s.manual } : {}),
        }
      }
      return { bucket, value: s.manual!.value, source: 'manual' as const, note: s.manual!.note }
    })
  if (from) merged = merged.filter((p) => p.bucket >= from)

  if (def.accumulation === 'increment' && merged.length > 0) {
    const have = new Set(merged.map((p) => p.bucket))
    const end = floorSignalBucket(opts.now ?? new Date(), def.interval)
    for (let b = merged[0].bucket; b <= end; b = nextSignalBucket(b, def.interval)) {
      if (!have.has(b)) merged.push({ bucket: b, value: 0, source: 'live', note: null })
    }
    merged.sort((a, b) => a.bucket.localeCompare(b.bucket))
  }
  return merged
}

// --- reads ----------------------------------------------------------------------------------------

/** Every stored `signal_points` row, ascending - the signalsData bulk read (storage is sparse). */
export async function readAllSignalPointRecords(): Promise<SignalPointRecord[]> {
  return readRecords<SignalPointRecord>(SIGNAL_POINTS, { orderBy: 'signal_id, bucket, source' })
}

/** One signal's stored `signal_points` rows, ascending. */
export async function readSignalPointRecords(signalId: string): Promise<SignalPointRecord[]> {
  return readRecords<SignalPointRecord>(SIGNAL_POINTS, {
    where: 'signal_id = ?',
    params: [signalId],
    orderBy: 'bucket, source',
  })
}

/** A signal's legacy `signals` rows (the derived/backfill day-grain store), as merge input. */
async function readLegacyRows(signalId: string): Promise<{ date: string; value: number }[]> {
  await ensureSchema()
  const rows = await withRead<{ date: string; value: unknown }>(
    `SELECT CAST(date AS VARCHAR) AS date, value FROM legacy_signal_points WHERE signal_id = ? ORDER BY date`,
    [signalId],
  )
  return rows.map((r) => ({ date: r.date, value: Number(r.value) }))
}

/**
 * One signal's merged history across both stores (see mergeSignalPoints for the precedence).
 * Unknown signal ids are refused. `from` clips the served window (buckets >= floor(from)).
 */
export async function readSignalPoints(signalId: string, opts: { from?: string } = {}): Promise<MergedSignalPoint[]> {
  const def = await requireDefinition(signalId)
  const [points, legacy] = await Promise.all([readSignalPointRecords(signalId), readLegacyRows(signalId)])
  return mergeSignalPoints(def, points, legacy, opts)
}

// --- manual writes --------------------------------------------------------------------------------

export interface SignalPointInput {
  signal_id: string
  /** When the observation is for. Offset-less strings are UTC; floored to the interval bucket. */
  at: string
  value: number
  note?: string | null
  /** users.id performing the entry (audit stamp). */
  actor?: string
}

const checkValue = (signalId: string, value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`signal ${signalId}: point value must be a finite number`)
  }
  return value
}

/** Upsert ONE manual point at floor(at, interval). Unknown signal ids are refused with the reason. */
export async function setSignalPoint(input: SignalPointInput): Promise<SignalPointRecord> {
  const def = await requireDefinition(input.signal_id)
  const bucket = floorSignalBucket(input.at, def.interval)
  return upsertRecord<SignalPointRecord>(SIGNAL_POINTS, {
    signal_id: input.signal_id,
    bucket,
    source: 'manual',
    value: checkValue(input.signal_id, input.value),
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
  })
}

/** Remove one manual point (the bucket containing `at`). Refused when no such point exists. */
export async function deleteSignalPoint(signalId: string, at: string): Promise<SignalPointRecord> {
  const def = await requireDefinition(signalId)
  const bucket = floorSignalBucket(at, def.interval)
  const pk = { signal_id: signalId, bucket, source: 'manual' }
  const prev = await readRecord<SignalPointRecord>(SIGNAL_POINTS, pk)
  if (!prev) throw new Error(`signal ${signalId}: no manual point at bucket ${bucket}`)
  await deleteRecord(SIGNAL_POINTS, pk)
  return prev
}

/**
 * The bulk manual path - twelve monthly Cash Balance points in one call. Validates every entry
 * BEFORE writing anything (all-or-nothing), floors each `at` through the shared helper (two
 * entries landing in one bucket: the last wins), and writes the batch inside one connection -
 * the replaceSignalRows precedent, not N record-layer round-trips. Existing manual points at
 * the same buckets are updated (created_at/created_by preserved); live points are untouched.
 */
export async function setSignalPoints(
  signalId: string,
  points: { at: string; value: number; note?: string | null }[],
  actor?: string,
): Promise<SignalPointRecord[]> {
  const def = await requireDefinition(signalId)
  if (actor) await assertKnownActor(actor)
  const byBucket = new Map<string, { value: number; note: string | null }>()
  for (const p of points) {
    byBucket.set(floorSignalBucket(p.at, def.interval), {
      value: checkValue(signalId, p.value),
      note: p.note ?? null,
    })
  }
  if (byBucket.size === 0) return []

  await ensureSchema()
  const now = utcNow()
  await withWrite(async (conn) => {
    for (const [bucket, p] of byBucket) {
      await conn.run(
        `INSERT INTO signal_points (signal_id, bucket, value, source, note, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?::TIMESTAMP, ?, 'manual', ?, ?::TIMESTAMP, ?::TIMESTAMP, ?, ?)
         ON CONFLICT (signal_id, bucket, source) DO UPDATE SET
           value = excluded.value, note = excluded.note,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [signalId, toNaiveUtc(bucket), p.value, p.note, now, now, actor ?? null, actor ?? null],
      )
    }
  })
  emitChange('table:signal_points')
  return readSignalPointRecords(signalId).then((rows) =>
    rows.filter((r) => r.source === 'manual' && byBucket.has(r.bucket)),
  )
}

// --- live writes (direct-to-points remote sources) ------------------------------------------------

/**
 * Replace the `source='live'` rows of the given signals WITHIN a date range - the range-scoped
 * sibling of replaceChannelSignals, for remote sources whose payload is already tidy day-grain
 * buckets and therefore write straight into `signal_points` (a provider pull is the usual case; no
 * snapshot row, no deriver). Semantics, chosen deliberately:
 *
 *   • Buckets INSIDE [from, to] (bucket-floored, inclusive) are replaced wholesale -
 *     delete-then-insert - so a re-pulled day whose value fell to ZERO loses its stale row.
 *     Sources sparse-omit zero days; a plain upsert would keep yesterday's non-zero value forever,
 *     a silent-wrongness bug. Increment reads zero-fill at read, so storage stays sparse.
 *   • Buckets OUTSIDE the range are untouched - an incremental pull never erases history. An
 *     omitted `to` makes the window open-ended (everything from `from` onward), for a provider
 *     that knows where its payload starts but not where it stops.
 *   • `manual` rows are structurally safe: `source` is in the PK and the DELETE filters on 'live';
 *     the read merge keeps live-over-manual precedence, shadowed points resurface as ever.
 *
 * Entries floor through floorSignalBucket per each signal's own interval (the ONE bucket
 * implementation); unknown signal ids are refused - register definitions first
 * (ensureSignalDefinitions). Returns the number of rows written.
 */
export async function replaceLiveSignalPoints(
  signalIds: string[],
  range: { from: string; to?: string },
  entries: { signal_id: string; at: string; value: number }[],
): Promise<number> {
  const defs = new Map<string, SignalDefinition>()
  for (const id of new Set([...signalIds, ...entries.map((e) => e.signal_id)])) {
    defs.set(id, await requireDefinition(id))
  }
  const floored = entries.map((e) => ({
    signal_id: e.signal_id,
    bucket: floorSignalBucket(e.at, defs.get(e.signal_id)!.interval),
    value: checkValue(e.signal_id, e.value),
  }))
  await ensureSchema()
  const now = utcNow()
  await withWrite(async (conn) => {
    for (const id of signalIds) {
      const def = defs.get(id)!
      const from = toNaiveUtc(floorSignalBucket(range.from, def.interval))
      if (range.to === undefined) {
        await conn.run(
          `DELETE FROM signal_points WHERE signal_id = ? AND source = 'live' AND bucket >= ?::TIMESTAMP`,
          [id, from],
        )
      } else {
        await conn.run(
          `DELETE FROM signal_points
            WHERE signal_id = ? AND source = 'live' AND bucket >= ?::TIMESTAMP AND bucket <= ?::TIMESTAMP`,
          [id, from, toNaiveUtc(floorSignalBucket(range.to, def.interval))],
        )
      }
    }
    for (const p of floored) {
      // ON CONFLICT is belt-and-braces for entries outside the deleted range / duplicate buckets.
      await conn.run(
        `INSERT INTO signal_points (signal_id, bucket, value, source, note, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?::TIMESTAMP, ?, 'live', NULL, ?::TIMESTAMP, ?::TIMESTAMP, NULL, NULL)
         ON CONFLICT (signal_id, bucket, source) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`,
        [p.signal_id, toNaiveUtc(p.bucket), p.value, now, now],
      )
    }
  })
  emitChange('table:signal_points')
  return floored.length
}

// --- increments via events ------------------------------------------------------------------------

/**
 * Rebuild one increment signal's live buckets from its events: delete `source='live'` rows,
 * re-insert from a per-bucket count over `events` rows with kind `signal.increment` and
 * subject = the signal id. Idempotent and cheap (bounded per signal); late-arriving events are
 * handled by simply being present here. The aggregation floors through floorSignalBucket in
 * process rather than SQL date math, so the ONE bucket implementation stays the only one.
 */
export async function deriveSignalIncrements(signalId: string): Promise<number> {
  const def = await requireDefinition(signalId)
  if (def.accumulation !== 'increment') {
    throw new Error(`signal ${signalId} is a '${def.accumulation}' signal - only 'increment' signals derive buckets from events`)
  }
  assertNotConnected(def, 'events')
  await ensureSchema()
  const rows = await withRead<{ at: string }>(
    `SELECT CAST(COALESCE(event_at, received_at) AS VARCHAR) AS at
       FROM events WHERE kind = ? AND subject = ?`,
    [SIGNAL_INCREMENT_KIND, signalId],
  )
  const counts = new Map<string, number>()
  for (const r of rows) {
    const b = floorSignalBucket(`${r.at.replace(' ', 'T')}Z`, def.interval)
    counts.set(b, (counts.get(b) ?? 0) + 1)
  }
  const now = utcNow()
  await withWrite(async (conn) => {
    await conn.run(`DELETE FROM signal_points WHERE signal_id = ? AND source = 'live'`, [signalId])
    for (const [bucket, value] of counts) {
      await conn.run(
        `INSERT INTO signal_points (signal_id, bucket, value, source, note, created_at, updated_at, created_by, updated_by)
         VALUES (?, ?::TIMESTAMP, ?, 'live', NULL, ?::TIMESTAMP, ?::TIMESTAMP, NULL, NULL)`,
        [signalId, toNaiveUtc(bucket), value, now, now],
      )
    }
  })
  emitChange('table:signal_points')
  return counts.size
}

export interface SignalIncrementInput {
  signal_id: string
  /** Occurrence time; defaults to now. Offset-less strings are UTC. */
  at?: string
  /** Idempotency key - firing the same occurrence twice with one key counts 1. Scoped per signal
   *  server-side (`<signal_id>:<key>`), generated when omitted (every call then counts). */
  dedup_key?: string
  /** users.id (or automation id) recording the occurrence - lands on the event's `actor`. */
  actor?: string
}

export interface SignalIncrementResult {
  signal_id: string
  /** False when the dedup_key was already recorded - nothing was counted. */
  fresh: boolean
  /** The bucket the occurrence falls in, and its live count after the re-derive. */
  bucket: string
  value: number
}

/**
 * Record one occurrence of an increment signal: an idempotent `events` insert (the existing
 * durable intake - recordEvent, the same freshness gate the whole alerts pipeline keys off), then
 * a re-derive of the signal's live buckets when the event is fresh. Deliberately calls
 * recordEvent, not ingestEvent: data entry must surface real failures, which ingestEvent's
 * never-throw contract swallows. Events of this kind arriving through OTHER intakes (polls →
 * ingestEvent) still refresh buckets - evaluate.ts carries the matching hook.
 */
export async function recordSignalIncrement(input: SignalIncrementInput): Promise<SignalIncrementResult> {
  const def = await requireDefinition(input.signal_id)
  if (def.accumulation !== 'increment') {
    throw new Error(
      `signal ${input.signal_id} is a '${def.accumulation}' signal - occurrences only count into 'increment' signals; enter a value with signal-point-set instead`,
    )
  }
  assertNotConnected(def, 'events')
  const at = input.at ?? new Date().toISOString()
  const bucket = floorSignalBucket(at, def.interval) // also validates `at` before anything writes
  const key = input.dedup_key?.trim() ? input.dedup_key.trim() : randomUUID()
  const fresh = await recordEvent({
    kind: SIGNAL_INCREMENT_KIND,
    dedup_key: `${input.signal_id}:${key}`,
    // The event keeps the occurrence's full precision; only the derived bucket is floored.
    event_at: parseUtc(at).toISOString(),
    subject: input.signal_id,
    actor: input.actor ?? '',
    source: 'api',
    fields: { signal_id: input.signal_id },
  })
  if (fresh) await deriveSignalIncrements(input.signal_id)
  const row = await readRecord<SignalPointRecord>(SIGNAL_POINTS, {
    signal_id: input.signal_id,
    bucket,
    source: 'live',
  })
  return { signal_id: input.signal_id, fresh, bucket, value: row?.value ?? 0 }
}
