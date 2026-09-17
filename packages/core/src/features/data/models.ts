// The data feature's tables: raw snapshots, the signal set (definitions, points, boards) and the
// data-source registry. Baselined by schema.ts through the manifest.

import type { ModelSpec } from '../../warehouse/model.js'
import {
  SIGNAL_ACCUMULATIONS,
  SIGNAL_DIRECTIONS,
  SIGNAL_INTERVALS,
  SIGNAL_POINT_SOURCES,
  SIGNAL_SOURCES,
} from './signals/types.js'
import { DATA_SOURCE_STATUSES, SYNC_STATUSES } from './sources/types.js'

/** Raw verbatim pulls - one row per (channel, date), payload kept as-is. */
export const SNAPSHOTS: ModelSpec = {
  table: 'snapshots',
  pk: ['channel', 'snapshot_date'],
  columns: {
    channel: { kind: 'text' },
    snapshot_date: { kind: 'date' },
    fetched_at: { kind: 'timestamp' },
    payload: { kind: 'json' },
  },
}

/** Tidy long-format signal the dashboard reads; `live` rows re-derive, `backfill` fills gaps. */
export const LEGACY_SIGNAL_POINTS: ModelSpec = {
  table: 'legacy_signal_points',
  pk: ['signal_id', 'date'],
  columns: {
    channel: { kind: 'text' },
    signal_id: { kind: 'text' },
    label: { kind: 'text' },
    signal_group: { kind: 'text' },
    unit: { kind: 'text', nullable: true },
    date: { kind: 'date' },
    value: { kind: 'float' },
    source: { kind: 'text', default: "'live'", enum: ['live', 'backfill'] },
  },
}

/**
 * The signal registry - one row per first-class signal (signals/types.ts). `id` shares the signal
 * namespace with `signals.signal_id`; identity + curation live HERE, outside the wipe-and-rebuild
 * blast radius of the `signals` rows. Derived signal auto-register on derive (never overwriting an
 * existing row); manual signals are created by admins and can exist with no data at all. Born with
 * its full column set (`depends_on`, `target` included) - a later column would cost an ALTER
 * migration, a spare one costs nothing.
 */
export const SIGNAL_DEFINITIONS: ModelSpec = {
  table: 'signals',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },
    label: { kind: 'text' },
    signal_group: { kind: 'text', default: "''" },
    unit: { kind: 'text', nullable: true },
    channel: { kind: 'text' },
    source: { kind: 'text', default: "'manual'", enum: SIGNAL_SOURCES },
    interval: { kind: 'text', default: "'day'", enum: SIGNAL_INTERVALS },
    accumulation: { kind: 'text', default: "'snapshot'", enum: SIGNAL_ACCUMULATIONS },
    direction: { kind: 'text', default: "'up'", enum: SIGNAL_DIRECTIONS },
    owner: { kind: 'text', nullable: true },
    description: { kind: 'text', default: "''" },
    depends_on: { kind: 'json', default: "'[]'" },
    target: { kind: 'json', nullable: true },
    sort: { kind: 'int', default: '0' },
    // The provider binding (Track C). Both-or-neither, enforced in upsertSignalDefinition:
    // connectedness IS `data_source_id != null`, which is why `source` stays derived|manual and
    // never grew a third value - one fact in two fields would only invite drift.
    data_source_id: { kind: 'text', nullable: true },
    measure_key: { kind: 'text', nullable: true },
  },
  timestamps: true,
  audit: true,
}

/**
 * A user-created, user-named INSTANCE of a provider ("Mailer EU" and "Mailer US" are two rows
 * of provider `mailer`, each with its own workspace and its own key). A table rather
 * than a config file - unlike schedules and alert rules - because `signals` references
 * it (refuse-unknown-id validation and delete-reports-bindings both want the two sides
 * transactionally readable), it is CRUD-ed from the UI and wants the record layer's audit stamps,
 * and an edit must be effective immediately rather than at the next boot.
 *
 * SECRETS ARE NOT HERE - not a column, not inside `config`, never in a payload. They stay in the
 * gitignored config/credentials.json under `provider → source id → KEY`, which is
 * `credential(channel, account, key)` verbatim with no code change at all.
 *
 * The four `last_sync_*` stamps are denormalized on purpose: per-source outcomes are NOT
 * recoverable from `automation_runs`, which records one row per action run while the umbrella
 * sync action covers N sources.
 */
export const DATA_SOURCES: ModelSpec = {
  table: 'data_sources',
  pk: ['id'],
  columns: {
    id: { kind: 'text' }, // user slug; also the credentials account key and the audit-snapshot channel
    provider: { kind: 'text' }, // a PROVIDERS key; unknown providers are refused on write
    label: { kind: 'text' },
    config: { kind: 'json', default: "'{}'" }, // the provider-declared non-secret settings
    // Born `disabled`: a new source is armed only after a supervised first run (the schedules-file
    // posture - everything armed deliberately). The record layer has no bool kind; text enum
    // follows pods.status / users.status.
    status: { kind: 'text', default: "'disabled'", enum: DATA_SOURCE_STATUSES },
    notes: { kind: 'text', default: "''" },
    last_sync_at: { kind: 'timestamp', nullable: true },
    last_sync_status: { kind: 'text', nullable: true, enum: SYNC_STATUSES },
    last_sync_error: { kind: 'text', nullable: true },
    last_sync_points: { kind: 'int', nullable: true },
  },
  timestamps: true,
  audit: true,
}

/**
 * The point store for registered signals at the signal's OWN grain (`signals.interval`):
 * `bucket` is the naive-UTC start of the interval bucket, floored by the one shared helper
 * (signals/points.ts floorSignalBucket - ISO weeks, Monday start). `source` is part of the PK ON
 * PURPOSE: a `live` write (increment buckets re-derived from events, connector output later) can
 * never destroy a `manual` point - reads deduplicate per bucket with live-over-manual precedence,
 * so a shadowed manual point resurfaces if the live source retreats. The legacy `signals` table
 * stays the point store for `source: 'derived'` definitions at day grain; the read path unifies
 * the two stores per signal.
 */
export const SIGNAL_POINTS: ModelSpec = {
  table: 'signal_points',
  pk: ['signal_id', 'bucket', 'source'],
  columns: {
    signal_id: { kind: 'text' },
    bucket: { kind: 'timestamp' },
    value: { kind: 'float' },
    source: { kind: 'text', default: "'manual'", enum: SIGNAL_POINT_SOURCES },
    note: { kind: 'text', nullable: true },
  },
  timestamps: true,
  audit: true,
}

/**
 * A user-created circuit board: WHICH signals are on it and WHERE each sits. Edges are NOT here -
 * they stay on signals.depends_on (one causal claim, curated once, cycle-checked once); a board is
 * a VIEW onto that graph, and an edge renders when both endpoints are members. `nodes` is a JSON
 * column rather than a join table: it is written whole on every autosave, never queried across
 * boards, and a node carries no attributes worth querying (the depends_on / signal_ids / blocked_by
 * precedent). Positions are TEAM state - never localStorage.
 */
export const SIGNAL_BOARDS: ModelSpec = {
  table: 'signal_boards',
  pk: ['id'],
  columns: {
    id: { kind: 'text' }, // slug, ^[a-z0-9][a-z0-9-]*$ (the data-source id charset)
    label: { kind: 'text' },
    description: { kind: 'text', default: "''" },
    nodes: { kind: 'json', default: "'[]'" }, // [{signal_id, x, y}] - x/y in flow units, snapped client-side
    sort: { kind: 'int', default: '0' },
  },
  timestamps: true,
  audit: true,
}

export const DATA_MODELS: readonly ModelSpec[] = [
  SNAPSHOTS,
  LEGACY_SIGNAL_POINTS,
  SIGNAL_DEFINITIONS,
  SIGNAL_POINTS,
  SIGNAL_BOARDS,
  DATA_SOURCES,
]
