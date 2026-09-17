// npm download counts via the public api.npmjs.org (no auth). In-process pull + backfill. Folded back
// from the retired channels/npm plugin (2026-07-16): npm/blog/hackernews run in-process like every
// other pull - the subprocess plugin runtime is gone. The deriver lives in signals/derive.ts.
//
// WHICH packages is configuration (config/npm-packages.json, see ../npm-packages.ts), read per run
// rather than at import so editing the file does not need a restart. No packages configured is a
// supported state: both entry points below say so in one line and do nothing.

import { fetchJson } from '../../../http.js'
import { upsertBackfillSignals, type SignalRow } from '../signals/write.js'
import { autoRegisterDefinitions } from '../signals/definitions.js'
import { NPM_NOT_CONFIGURED, readNpmPackages } from '../npm-packages.js'
import { persist, todayUtc, type IngestProgress, type PullResult } from './types.js'

const enc = (pkg: string): string => pkg.replace('/', '%2F')

/** Point download count for a package over a named period (last-day/week/month). 0 on any error. */
export async function downloadsPoint(pkg: string, period: string): Promise<number> {
  try {
    const r = await fetchJson<{ downloads?: number; error?: string }>(
      `https://api.npmjs.org/downloads/point/${period}/${enc(pkg)}`,
    )
    return r.error ? 0 : (r.downloads ?? 0)
  } catch {
    return 0
  }
}

/** Daily download counts for a package over [start,end], as a day→count map. Empty on any error. */
export async function downloadsRange(pkg: string, start: string, end: string): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  try {
    const r = await fetchJson<{ downloads?: { day: string; downloads: number }[]; error?: string }>(
      `https://api.npmjs.org/downloads/range/${start}:${end}/${enc(pkg)}`,
    )
    for (const d of r.downloads ?? []) map.set(d.day, d.downloads)
  } catch {
    /* package may not exist for the whole window - treated as zeros */
  }
  return map
}

type DownloadPoint = { last_day: number; last_week: number; last_month: number }

async function pointsFor(pkg: string): Promise<DownloadPoint> {
  return {
    last_day: await downloadsPoint(pkg, 'last-day'),
    last_week: await downloadsPoint(pkg, 'last-week'),
    last_month: await downloadsPoint(pkg, 'last-month'),
  }
}

/** Streaming ingest action - npm download counts for every configured package → snapshot + signal. */
export async function* ingestNpm(opts: { date?: string } = {}): AsyncGenerator<IngestProgress> {
  const date = opts.date ?? todayUtc()
  const declared = readNpmPackages()
  const count = declared.packages.length + declared.tracked.length
  // Nothing configured is not a failure: it is a Box that does not publish to npm, or one whose
  // owner has not filled the file in yet. Say which, and write no snapshot.
  if (count === 0) {
    const result: PullResult = { channel: 'npm', date, summary: `npm ${date}: skipped - ${NPM_NOT_CONFIGURED}` }
    yield { channel: 'npm', phase: 'done', message: result.summary, result }
    return
  }
  yield { channel: 'npm', phase: 'start', message: `Fetching npm downloads for ${count} packages…` }

  const packages: Record<string, DownloadPoint> = {}
  for (const pkg of declared.packages) packages[pkg] = await pointsFor(pkg)

  // Standalone tracked packages: their own signal, excluded from the all-package totals.
  const tracked: Record<string, DownloadPoint> = {}
  for (const pkg of declared.tracked) tracked[pkg] = await pointsFor(pkg)

  const totals = Object.values(packages).reduce(
    (t, p) => ({
      last_day: t.last_day + p.last_day,
      last_week: t.last_week + p.last_week,
      last_month: t.last_month + p.last_month,
    }),
    { last_day: 0, last_week: 0, last_month: 0 },
  )

  const snapshot = { channel: 'npm', date, fetched_at: new Date().toISOString(), totals, packages, tracked }

  yield { channel: 'npm', phase: 'persist', message: 'Writing snapshot + deriving signals…' }
  await persist('npm', date, snapshot)

  const result: PullResult = {
    channel: 'npm',
    date,
    summary: `npm ${date}: ${totals.last_week.toLocaleString()} downloads/week across ${declared.packages.length} packages`,
  }
  yield { channel: 'npm', phase: 'done', message: result.summary, result }
}

// ----- backfill (weekly trailing-7-day history per top package + all-package total) -----

const WINDOW_DAYS = 510 // ~17 months - under the range endpoint's 18-month cap
const STEP = 7
const TOP_PACKAGES = 6
const DAY = 86_400_000
const ymd = (t: number): string => new Date(t).toISOString().slice(0, 10)
const parseDay = (d: string): number => Date.parse(`${d}T00:00:00Z`)

/** Streaming backfill - weekly download history as `source:'backfill'` rows (history behind the daily
 *  snapshots). No snapshot - backfills self-source their history. */
export async function* backfillNpm(): AsyncGenerator<IngestProgress> {
  const declared = readNpmPackages()
  if (declared.packages.length + declared.tracked.length === 0) {
    const summary = `backfill:npm: skipped - ${NPM_NOT_CONFIGURED}`
    yield { channel: 'npm', phase: 'done', message: summary, result: { channel: 'npm', date: todayUtc(), summary } }
    return
  }
  yield { channel: 'npm', phase: 'start', message: 'Fetching daily download history…' }
  const today = parseDay(ymd(Date.now()))
  const samples: string[] = []
  for (let t = today; t > today - WINDOW_DAYS * DAY; t -= STEP * DAY) samples.unshift(ymd(t))

  const start = ymd(Date.now() - WINDOW_DAYS * DAY)
  const end = ymd(Date.now())
  const daily = new Map<string, Map<string, number>>()
  for (const pkg of [...declared.packages, ...declared.tracked]) daily.set(pkg, await downloadsRange(pkg, start, end))

  const trailing7 = (map: Map<string, number>, date: string): number => {
    const base = parseDay(date)
    let sum = 0
    for (let i = 0; i < 7; i++) sum += map.get(ymd(base - i * DAY)) ?? 0
    return sum
  }

  const rows: SignalRow[] = []
  const pushSignal = (signal_id: string, label: string, group: string, points: { date: string; value: number }[]): void => {
    for (const p of points)
      rows.push({ channel: 'npm', signal_id, label, signal_group: group, unit: 'dl', date: p.date, value: p.value, source: 'backfill' })
  }

  // Per-package weekly signal (drop leading zeros before the package had any downloads).
  const pkgSignal: { pkg: string; total: number; points: { date: string; value: number }[] }[] = []
  for (const pkg of declared.packages) {
    const map = daily.get(pkg)!
    const points = samples.map((date) => ({ date, value: trailing7(map, date) }))
    const firstNonZero = points.findIndex((p) => p.value > 0)
    if (firstNonZero === -1) continue
    const trimmed = points.slice(firstNonZero)
    pkgSignal.push({ pkg, total: trimmed.at(-1)!.value, points: trimmed })
  }

  const totalPoints = samples.map((date) => ({ date, value: declared.packages.reduce((s, pkg) => s + trailing7(daily.get(pkg)!, date), 0) }))
  const firstTotal = totalPoints.findIndex((p) => p.value > 0)
  pushSignal('npm.week', 'Downloads / week (all pkgs)', 'Downloads', firstTotal === -1 ? totalPoints : totalPoints.slice(firstTotal))
  for (const p of pkgSignal.sort((a, c) => c.total - a.total).slice(0, TOP_PACKAGES)) {
    pushSignal(`npm.pkg.${p.pkg}`, `${p.pkg} / wk`, 'Top packages', p.points)
  }

  // Standalone tracked packages always get their own signal (never gated on the top-N cut).
  for (const pkg of declared.tracked) {
    const map = daily.get(pkg)!
    const points = samples.map((date) => ({ date, value: trailing7(map, date) }))
    const firstNonZero = points.findIndex((p) => p.value > 0)
    if (firstNonZero === -1) continue
    pushSignal(`npm.pkg.${pkg}`, `${pkg} / wk`, 'Top packages', points.slice(firstNonZero))
  }

  yield { channel: 'npm', phase: 'persist', message: `Writing ${rows.length} weekly points…` }
  await upsertBackfillSignals(rows)
  await autoRegisterDefinitions(rows)

  const result: PullResult = {
    channel: 'npm',
    date: todayUtc(),
    summary: `backfill:npm: ${pkgSignal.length} package signal · ${rows.length} weekly points`,
  }
  yield { channel: 'npm', phase: 'done', message: result.summary, result }
}
