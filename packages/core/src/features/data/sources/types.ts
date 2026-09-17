// Data sources - the warehouse-side half of the provider model (the code-side half is the
// `Provider` contract in @silkweave/box-provider-kit). A data source is a user-created, user-named instance
// of a provider: "Mailer EU" and "Mailer US" are two rows of provider `mailer`, separate
// workspaces and separate keys, syncing independently.
//
// Three ids, and it is worth being precise about them because they are deliberately the same
// string in three places:
//   • `data_sources.id`      - the row key,
//   • the credentials ACCOUNT key (`credentials.json → <provider> → <source id> → KEY`),
//   • the audit-snapshot channel (`snapshots.channel`).
// That is why the id charset is validated and why ids that would collide with a derived channel
// are refused (sources/state.ts).

export type DataSourceStatus = 'enabled' | 'disabled'
export const DATA_SOURCE_STATUSES: DataSourceStatus[] = ['enabled', 'disabled']

/** Outcome of the last sync attempt, stamped on the row (see DATA_SOURCES for why it is stored). */
export type SyncStatus = 'success' | 'error'
export const SYNC_STATUSES: SyncStatus[] = ['success', 'error']

export interface DataSource {
  id: string
  /** A PROVIDERS key. A row whose provider is no longer registered is readable but unsyncable. */
  provider: string
  label: string
  /** The provider-declared non-secret settings. Never secrets - those live in credentials.json. */
  config: Record<string, string>
  /** Only `enabled` sources ride the umbrella `sources-sync` cron; a disabled one still syncs
   *  on demand via `source-sync`, which is the supervised first run. */
  status: DataSourceStatus
  notes: string
  last_sync_at: string | null
  last_sync_status: SyncStatus | null
  last_sync_error: string | null
  last_sync_points: number | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

/** Partial upsert input - `id` identifies the row; provided fields overwrite, the rest persist. */
export interface DataSourceInput {
  id: string
  /** Required on create; immutable in practice (changing it would strand config + credentials). */
  provider?: string
  label?: string
  config?: Record<string, string>
  status?: DataSourceStatus
  notes?: string
  /** users.id performing this mutation (stamps created_by on insert, updated_by always). */
  actor?: string
}

/** A source as the API reports it: the row, plus what is knowable without exposing a secret. */
export interface DataSourceView extends DataSource {
  /** The provider's label, or null when the row names a provider no longer registered. */
  provider_label: string | null
  /** Per-credential-key PRESENCE, never values: {MAILER_API_KEY: true}. */
  credentials: Record<string, boolean>
  /** Signal ids bound to this source - the subscription set the next sync will pull. */
  bound_signals: string[]
  /** Bindings naming a measure this provider no longer offers: flagged, never auto-unbound. */
  dead_measures: { signal_id: string; measure_key: string }[]
}

/** What a delete leaves behind. Bindings are NOT cleared - a visible dead binding beats a
 *  silently narrowed signal (the initiative-binding precedent). */
export interface DataSourceDeleteReport {
  id: string
  /** Signals still bound to the deleted source. They keep their points and stop refreshing. */
  bound_signals: string[]
  warnings: string[]
}

/** The per-source outcome of one sync attempt, as the run log and the action summary report it. */
export interface SyncResult {
  source_id: string
  /** Signals whose live rows were replaced (bound AND naming a measure the provider still offers). */
  signals: number
  /** `signal_points` rows written. */
  points: number
  /** Non-fatal problems: dead measures, subscribed-but-unfetched keys. */
  warnings: string[]
}
