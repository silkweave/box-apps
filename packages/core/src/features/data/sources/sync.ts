// The sync engine - the ONLY thing that turns a provider's fetch into warehouse rows. Providers
// are pure fetchers by contract, so every write discipline lives here in one reviewed place:
// credential resolution, the audit snapshot, bucket flooring, the windowed live replace, the
// health stamps, and the one non-warehouse write - persisting a credential the remote rotated
// out from under us mid-pull (a rotating refresh token; see saveCredentials below).
//
// The subscription model, and why it is this way round: the DEFINITION is the subscription. A sync
// asks "which signals are bound to this source?" and pulls only those measures. The alternative -
// the source declaring what to ingest and auto-creating definitions - inverts the registry's whole
// premise that a human names and owns each signal, and would mint 11 x N unnamed definitions with
// generated slugs. An unsubscribed measure is simply never fetched into anything, which is free.
//
// LIVE-WRITER EXCLUSIVITY: a bound signal's `source='live'` rows belong to its source's sync,
// exclusively. The increment machinery (deriveSignalIncrements) is also a live writer and DELETES
// every live row for a signal before rebuilding from events - it would vaporize a provider's
// history. signals/points.ts refuses it on bound signals; this file is the other half of that pact.

import { emitChange } from '../../../changes.js'
import { requireCredentials, writeCredentials } from '../../../credentials.js'
import { replaceLiveSignalPoints } from '../signals/points.js'
import { todayUtc } from '../../../ops/types.js'
import { upsertSnapshot } from '../signals/write.js'
import { findMeasure, requireProvider } from './registry.js'
import { readSourceBindings, requireDataSource, stampSync } from './state.js'
import type { DataSource, SyncResult } from './types.js'

export interface SyncOptions {
  /** Run-log sink. The caller (the automation action) tags lines with the source id. */
  progress?: (message: string) => void
}

/**
 * Sync one data source: pull every measure that has a subscriber and replace those signals' live
 * points. Throws on a failing pull - the caller decides whether that fails a whole run (the
 * umbrella action collects per-source failures and throws once, at the end).
 *
 * Nothing bound is a NO-OP, not an error: a freshly created source with no signals yet is a normal
 * state on the way to the first binding.
 */
export async function syncDataSource(source: DataSource, opts: SyncOptions = {}): Promise<SyncResult> {
  try {
    return await runSync(source, opts)
  } catch (err) {
    // Stamp the failure on the row before rethrowing, so a broken source reports its own last
    // error even when the run that hit it has scrolled away. The caller still gets the throw.
    const message = err instanceof Error ? err.message : String(err)
    await stampSync(source.id, { status: 'error', at: new Date().toISOString(), error: message })
    throw err
  }
}

async function runSync(source: DataSource, opts: SyncOptions): Promise<SyncResult> {
  const log = opts.progress ?? (() => undefined)
  const provider = requireProvider(source.provider)
  const bindings = await readSourceBindings(source.id)
  const warnings: string[] = []

  // A binding naming a measure the provider no longer offers is flagged and skipped, NEVER
  // auto-unbound - the same durability rule as a definition whose derived signal disappears.
  const live = bindings.filter((b) => {
    if (findMeasure(provider, b.measure_key)) return true
    warnings.push(`${b.signal_id}: measure ${b.measure_key} is no longer offered by ${provider.id} - skipped, binding left in place`)
    return false
  })
  if (live.length === 0) {
    const msg = bindings.length === 0
      ? `${source.id}: no signals bound - nothing to pull`
      : `${source.id}: every binding names a retired measure - nothing to pull`
    log(msg)
    await stampSync(source.id, { status: 'success', at: new Date().toISOString(), points: 0 })
    return { source_id: source.id, signals: 0, points: 0, warnings }
  }

  // Fail-loud with the exact missing-key message the rest of the repo gets. The credential store
  // is used verbatim: channel = the provider id, account = the source id.
  const values = requireCredentials(provider.id, source.id, ...provider.credentials)
  const credentials = Object.fromEntries(provider.credentials.map((k, i) => [k, values[i]]))

  const measures = [...new Set(live.map((b) => b.measure_key))]
  log(`${source.id}: pulling ${measures.length} measure(s) for ${live.length} signal(s)…`)
  const pull = await provider.pull({
    source: { id: source.id, provider: source.provider, label: source.label, config: source.config },
    credentials,
    measures,
    progress: (m) => log(`${source.id}: ${m}`),
    // Rotated-secret write-back (see the callback's contract in @silkweave/box-provider-kit). The engine
    // owns the write, and gates it on the provider's OWN declared keys: a provider must not be
    // able to reach into another key of the store through the one door it has to it. Values are
    // never logged - only which keys moved, so a run log can explain a rotation without leaking.
    saveCredentials: async (updates) => {
      const foreign = Object.keys(updates).filter((k) => !provider.credentials.includes(k))
      if (foreign.length > 0) {
        throw new Error(
          `${source.id}: provider ${provider.id} tried to write credential key(s) it does not declare: ${foreign.join(', ')}`,
        )
      }
      writeCredentials(provider.id, source.id, updates)
      log(`${source.id}: rotated credential(s) persisted: ${Object.keys(updates).join(', ')}`)
    },
  })

  // The audit snapshot: one row per source per day, the discipline every channel pull follows.
  // Nothing reads it automatically - it exists so a bad mapping can be diagnosed and points
  // rebuilt offline. (warehouse-derive does NOT rebuild provider points; a re-sync is the path.)
  await upsertSnapshot(source.id, todayUtc(), pull.raw)

  // One measure may have several subscribers (a renamed successor coexisting during a transition),
  // so an observation fans out to every signal bound to its key.
  const signalsByMeasure = new Map<string, string[]>()
  for (const b of live) signalsByMeasure.set(b.measure_key, [...(signalsByMeasure.get(b.measure_key) ?? []), b.signal_id])

  const entries: { signal_id: string; at: string; value: number }[] = []
  for (const p of pull.points) {
    if (typeof p.value !== 'number' || !Number.isFinite(p.value)) {
      throw new Error(`${source.id}: provider returned a non-finite value for ${p.measure_key} at ${p.at}`)
    }
    for (const signalId of signalsByMeasure.get(p.measure_key) ?? []) {
      entries.push({ signal_id: signalId, at: p.at, value: p.value })
    }
  }

  const signalIds = [...new Set(live.map((b) => b.signal_id))]
  // The replace window. A provider that declares one gets an exact clear (a day corrected DOWN to
  // zero loses its stale row even though it returned no observation); otherwise we fall back to
  // the earliest observation in the payload, which cannot clear a quiet leading edge. A pull that
  // returned NOTHING and declared no window replaces nothing at all - an empty payload is far more
  // likely an upstream outage than a genuine all-zero history, and this engine must not turn one
  // into a deletion.
  const from = pull.window?.from ?? entries.map((e) => e.at).sort()[0]
  let points = 0
  if (from === undefined) {
    warnings.push('provider returned no observations and declared no window - nothing was replaced (an empty payload is not treated as "all zero")')
  } else {
    points = await replaceLiveSignalPoints(
      signalIds,
      { from, ...(pull.window?.to !== undefined ? { to: pull.window.to } : {}) },
      entries,
    )
  }

  const missing = measures.filter((s) => !pull.points.some((p) => p.measure_key === s))
  if (missing.length > 0 && pull.points.length > 0) {
    log(`${source.id}: no observations in this window for ${missing.join(', ')}`)
  }
  log(`${source.id}: ${points} live point(s) across ${signalIds.length} signal(s)`)
  await stampSync(source.id, { status: 'success', at: new Date().toISOString(), points })
  emitChange('table:signal_points')
  return { source_id: source.id, signals: signalIds.length, points, warnings }
}

/** Sync one source by id (the `source-sync` action's path). */
export async function syncDataSourceById(id: string, opts: SyncOptions = {}): Promise<SyncResult> {
  return syncDataSource(await requireDataSource(id), opts)
}
