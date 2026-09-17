// Data sources + providers, mirroring @silkweave/box-provider-kit's contract and core's `data_sources` row
// (the payloads are cast, not shared - same convention as content-types / planning-types).
//
// The vocabulary, because the three nouns are easy to blur: a PROVIDER is code shipped in this
// repo; a DATA SOURCE is a row someone created and named (two platform spaces = two sources of
// one provider); a MEASURE is one data point a provider offers. A signal is CONNECTED by binding
// (data_source_id, measure_key). The word "Measure" appears in the UI only inside that binding flow -
// everywhere else the word stays "signal".

import type { DataSourceStatus, SignalAccumulation, SignalDirection, SignalInterval, SyncStatus } from '../../types.ts'

/** One entry in a provider's catalogue; its fields PREFILL a new signal bound to it, and are
 *  ordinary editable fields afterwards - defaults, never locks. */
export interface ProviderMeasure {
  /** The provider's native token, verbatim ('FIRST_MESSAGE'). Shown demoted, in a tooltip. */
  key: string
  label: string
  unit: string | null
  interval: SignalInterval
  accumulation: SignalAccumulation
  direction: SignalDirection
  group: string
  description: string
}

export interface ProviderConfigField {
  key: string
  label: string
  required: boolean
  help?: string
}

export interface Provider {
  id: string
  label: string
  description: string
  config: ProviderConfigField[]
  /** Credential key NAMES this provider needs. Values never leave the server. */
  credentials: string[]
  measures: ProviderMeasure[]
}

export interface DataSource {
  id: string
  provider: string
  /** The provider's label; null when the row names a provider not registered in this build. */
  provider_label: string | null
  label: string
  config: Record<string, string>
  status: DataSourceStatus
  notes: string
  /** Credential key → configured? Presence only - there is no API that reports a value. */
  credentials: Record<string, boolean>
  bound_signals: string[]
  /** Bindings naming a measure the provider no longer offers: flagged, never auto-unbound. */
  dead_measures: { signal_id: string; measure_key: string }[]
  last_sync_at: string | null
  last_sync_status: SyncStatus | null
  last_sync_error: string | null
  last_sync_points: number | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}
