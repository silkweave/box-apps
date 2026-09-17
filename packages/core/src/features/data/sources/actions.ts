// The two automation actions that drive provider syncs. Both funnel through executeRecorded() like
// every other op, so they get a run row, a streamed log and the funnel's `run.error` event (which
// is what makes a failing source loud from day one, with no new alert rule).
//
//   • `sources-sync` - schedulable, iterates every ENABLED source. One cron entry covers all of
//     them; per-source cadence is not a thing anybody needs yet, and schedules cannot carry params.
//   • `source-sync`  - parameterized, one source INCLUDING a disabled one. This is the supervised
//     first run in the operating ritual: create the source (born disabled) → add the credential →
//     source-sync it and read the log → flip it to enabled.

import { todayUtc, type IngestProgress } from '../../../ops/types.js'
import { readDataSources, requireDataSource } from './state.js'
import { syncDataSource } from './sync.js'

const CHANNEL = 'sources'

/**
 * Sync every enabled source. Per-source try/catch is the load-bearing part: ONE bad credential
 * must not stop the other sources, so the loop always finishes and the successful sources' data
 * has already landed by the time this throws. The aggregate error at the end is what finalizes the
 * run as `error`, naming which source failed and why.
 */
export async function* sourcesSyncAction(): AsyncGenerator<IngestProgress> {
  yield { channel: CHANNEL, phase: 'start', message: 'syncing enabled data sources' }
  const sources = (await readDataSources()).filter((s) => s.status === 'enabled')
  if (sources.length === 0) {
    const summary = 'no enabled data sources - nothing to sync'
    yield { channel: CHANNEL, phase: 'done', message: summary, result: { channel: CHANNEL, date: todayUtc(), summary } }
    return
  }

  const failures: string[] = []
  let ok = 0
  let points = 0
  for (const source of sources) {
    const lines: string[] = []
    yield { channel: source.id, phase: 'fetch', message: `${source.label} (${source.provider})…` }
    try {
      const res = await syncDataSource(source, { progress: (m) => lines.push(m) })
      ok++
      points += res.points
      for (const line of [...lines, ...res.warnings]) {
        yield { channel: source.id, phase: 'persist', message: line }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push(`${source.id}: ${message}`)
      for (const line of lines) yield { channel: source.id, phase: 'persist', message: line }
      yield { channel: source.id, phase: 'persist', message: `FAILED - ${message}` }
    }
  }

  const summary = `${ok} ok, ${failures.length} failed · ${points} live points`
  if (failures.length > 0) throw new Error(`${summary} - ${failures.join(' | ')}`)
  yield { channel: CHANNEL, phase: 'done', message: summary, result: { channel: CHANNEL, date: todayUtc(), summary } }
}

/** Sync ONE source by id, enabled or not - the supervised run. Params are not persisted on the run
 *  row (they never are), so the source id goes into the log. */
export async function* sourceSyncAction(params: { source_id: string }): AsyncGenerator<IngestProgress> {
  const id = params.source_id?.trim()
  if (!id) throw new Error('source-sync needs a source_id param')
  const source = await requireDataSource(id)
  yield {
    channel: id,
    phase: 'start',
    message: `syncing ${source.label} (${source.provider}${source.status === 'disabled' ? ', disabled - supervised run' : ''})`,
  }

  const lines: string[] = []
  try {
    const res = await syncDataSource(source, { progress: (m) => lines.push(m) })
    for (const line of [...lines, ...res.warnings]) yield { channel: id, phase: 'persist', message: line }
    const summary = `${id}: ${res.points} live point(s) across ${res.signals} signal(s)${res.warnings.length > 0 ? ` · ${res.warnings.length} warning(s)` : ''}`
    yield { channel: id, phase: 'done', message: summary, result: { channel: id, date: todayUtc(), summary } }
  } catch (err) {
    // Drain what the pull managed to log before failing - the whole point of a supervised run.
    for (const line of lines) yield { channel: id, phase: 'persist', message: line }
    throw err
  }
}
