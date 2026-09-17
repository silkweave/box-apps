// GitHub ingest - signals + engagement, plus the PR/star backfills. ACCOUNT-SCOPED: the pull sweeps
// every account in config/accounts.json (default account = the bare 'github' channel, others get
// 'github@<id>'). Auth: EVERY account authenticates with its own GH_TOKEN from
// config/credentials.json - a classic PAT (`repo` + `notifications` scopes; the notifications API
// is classic-only, and a fine-grained token can't span a user + an org owner). The ambient `gh`
// CLI login is deliberately NOT used: pulls fail loud without a token, so runs don't silently ride
// whoever is logged into `gh` (matters when the Box runs under a service supervisor). A zero-scope classic PAT
// suffices for public-only accounts (stars/followers); repo traffic needs `repo` scope. Pulls
// UPSERT into the warehouse; backfills write `source='backfill'` signal rows (history that fills
// in behind the daily snapshots).

import { execFileSync } from 'node:child_process'
import { accountChannel, channelAccounts, defaultAccount, type ChannelAccount } from '../../../accounts.js'
import { requireCredentials } from '../../../credentials.js'
import { upsertBackfillSignals, type SignalRow } from '../signals/write.js'
import { autoRegisterDefinitions } from '../signals/definitions.js'
import { persist, todayUtc, type IngestProgress, type PullResult } from './types.js'

/** Call `gh api <path>` as the given account token and parse JSON. Throws (fail-loud) on non-zero
 *  exit. GH_TOKEN in the env overrides the ambient `gh` CLI auth - the token is never optional. */
function ghApi<T = unknown>(path: string, args: string[] = [], token: string): T {
  const env = { ...process.env, GH_TOKEN: token }
  const out = execFileSync('gh', ['api', path, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env })
  return JSON.parse(out) as T
}

/** Repo traffic needs push access and only covers the last 14 days; tolerate 403s. */
function tryTraffic(repo: string, kind: 'views' | 'clones', token: string): unknown {
  try {
    return ghApi(`repos/${repo}/traffic/${kind}`, [], token)
  } catch {
    return { error: 'unavailable (needs push access)' }
  }
}

/** Accounts ready to pull (a blank login is a placeholder awaiting config). */
function pullableAccounts(): ChannelAccount[] {
  return channelAccounts('github').filter((a) => a.login.trim() !== '')
}

/** The account's PAT - required for every account, never falls back to the ambient `gh` auth. */
const accountToken = (a: ChannelAccount): string => requireCredentials('github', a.id, 'GH_TOKEN')[0]

/** Streaming ingest action - followers, repo stars/forks, traffic, and OSS PR count, per account. */
export async function* ingestGithub(opts: { date?: string } = {}): AsyncGenerator<IngestProgress> {
  const date = opts.date ?? todayUtc()
  const accounts = pullableAccounts()
  if (accounts.length === 0) throw new Error('no github accounts configured - see config/accounts.json')
  const skipped = channelAccounts('github').filter((a) => !a.login.trim())
  const summaries: string[] = []

  for (const acct of accounts) {
    const ch = accountChannel('github', acct)
    const token = accountToken(acct)
    yield { channel: ch, phase: 'start', message: `[${ch}] Fetching profile${acct.org ? ' + org' : ''}…` }

    const user = ghApi<Record<string, any>>(`users/${acct.login}`, [], token)
    const org = acct.org ? ghApi<Record<string, any>>(`orgs/${acct.org}`, [], token) : null

    const repos = []
    for (const full of acct.repos ?? []) {
      yield { channel: ch, phase: 'fetch', message: `[${ch}] repo ${full}…` }
      const r = ghApi<Record<string, any>>(`repos/${full}`, [], token)
      repos.push({
        full_name: r.full_name,
        private: r.private,
        stars: r.stargazers_count,
        forks: r.forks_count,
        watchers: r.subscribers_count,
        open_issues: r.open_issues_count,
        pushed_at: r.pushed_at,
        traffic_views: tryTraffic(full, 'views', token),
        traffic_clones: tryTraffic(full, 'clones', token),
      })
    }

    let ossPrs: number | undefined
    if (acct.ossPrQuery) {
      yield { channel: ch, phase: 'fetch', message: `[${ch}] Counting external PRs…` }
      ossPrs = ghApi<{ total_count: number }>('search/issues', [
        '-X', 'GET', '--raw-field', `q=${acct.ossPrQuery}`,
      ], token).total_count
    }

    const snapshot = {
      channel: ch,
      date,
      fetched_at: new Date().toISOString(),
      account: acct.id,
      user: { login: user.login, followers: user.followers, following: user.following, public_repos: user.public_repos },
      org: org ? { login: org.login, followers: org.followers, public_repos: org.public_repos } : undefined,
      repos,
      oss_prs_authored_external: ossPrs,
    }

    yield { channel: ch, phase: 'persist', message: `[${ch}] Writing snapshot + deriving signals…` }
    await persist(ch, date, snapshot)

    summaries.push(
      `${ch}: ${user.followers} followers` +
        (repos.length ? ` · ${repos.map((r) => `${String(r.full_name).split('/')[1]} ${r.stars}★`).join(' · ')}` : '') +
        (ossPrs != null ? ` · ${ossPrs} external PRs` : ''),
    )
  }

  const result: PullResult = {
    channel: 'github',
    date,
    summary:
      `github ${date}: ${summaries.join(' | ')}` +
      (skipped.length ? ` (skipped ${skipped.map((a) => `@${a.id}`).join(', ')}: no login configured)` : ''),
  }
  yield { channel: 'github', phase: 'done', message: result.summary, result }
}

// ----- engagement (feeds the tactical inbox, not aggregate signals - default account only) -----

const WINDOW_DAYS = 14
const MAX_CANDIDATES = 80
const SEARCH_PAGE_CAP = 5

function windowStart(date: string, days: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) - days * 24 * 60 * 60 * 1000
  return new Date(t).toISOString().slice(0, 10)
}

interface SearchItem {
  number: number
  title: string
  html_url: string
  repository_url: string
  user?: { login?: string }
  pull_request?: unknown
}

function searchIssues(q: string, token: string): SearchItem[] {
  const items: SearchItem[] = []
  for (let page = 1; page <= SEARCH_PAGE_CAP; page++) {
    const res = ghApi<{ total_count: number; items: SearchItem[] }>('search/issues', [
      '-X', 'GET', '--raw-field', `q=${q}`, '-f', 'per_page=100', '-f', `page=${page}`,
    ], token)
    items.push(...(res.items ?? []))
    if (!res.items || res.items.length < 100) break
  }
  return items
}

function tryList<T = any>(path: string, token: string): T[] {
  try {
    const res = ghApi<T[]>(path, ['-X', 'GET', '-f', 'per_page=100'], token)
    return Array.isArray(res) ? res : []
  } catch {
    return []
  }
}

const repoFromUrl = (repositoryUrl: string): string =>
  repositoryUrl.replace(/^https:\/\/api\.github\.com\/repos\//, '')
const clip = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 280)
const isBot = (login: string): boolean => login.endsWith('[bot]')

interface Engagement {
  kind: 'issue-comment' | 'pr-review-comment' | 'pr-review' | 'mention'
  comment_id: number | null
  author: string
  body: string
  html_url: string
  created_at: string
  target: { repo: string; type: 'pull' | 'issue'; number: number; title: string; url: string }
}

/** Streaming ingest action - item-level GitHub engagements awaiting our reply (inbox feed). */
export async function* ingestGithubEngagement(opts: { date?: string } = {}): AsyncGenerator<IngestProgress> {
  const acct = defaultAccount('github')
  const SELF = acct.login
  const token = accountToken(acct)
  const date = opts.date ?? todayUtc()
  const since = windowStart(date, WINDOW_DAYS)
  yield { channel: 'github-engagement', phase: 'start', message: `Finding candidates active since ${since}…` }

  const candidatesByKey = new Map<string, SearchItem>()
  for (const it of [
    ...searchIssues(`involves:${SELF} updated:>=${since}`, token),
    ...searchIssues(`author:${SELF} updated:>=${since}`, token),
  ]) {
    candidatesByKey.set(`${repoFromUrl(it.repository_url)}#${it.number}`, it)
  }
  const candidates = [...candidatesByKey.values()].slice(0, MAX_CANDIDATES)
  const truncated = candidatesByKey.size > candidates.length

  const engagements: Engagement[] = []
  const push = (e: Engagement) => {
    if (e.author && e.author !== SELF && !isBot(e.author)) engagements.push(e)
  }

  let i = 0
  for (const it of candidates) {
    if (++i % 10 === 0) yield { channel: 'github-engagement', phase: 'fetch', message: `thread ${i}/${candidates.length}…` }
    const repo = repoFromUrl(it.repository_url)
    const isPr = it.pull_request != null
    const target = { repo, type: (isPr ? 'pull' : 'issue') as 'pull' | 'issue', number: it.number, title: it.title, url: it.html_url }

    const events: Engagement[] = []
    const add = (e: Engagement) => {
      if (e.author) events.push(e)
    }
    for (const c of tryList<any>(`repos/${repo}/issues/${it.number}/comments`, token)) {
      add({ kind: 'issue-comment', comment_id: c.id, author: c.user?.login ?? '', body: clip(c.body), html_url: c.html_url, created_at: c.created_at, target })
    }
    if (isPr) {
      for (const c of tryList<any>(`repos/${repo}/pulls/${it.number}/comments`, token)) {
        add({ kind: 'pr-review-comment', comment_id: c.id, author: c.user?.login ?? '', body: clip(c.body), html_url: c.html_url, created_at: c.created_at, target })
      }
      for (const r of tryList<any>(`repos/${repo}/pulls/${it.number}/reviews`, token)) {
        if (!r.body) continue
        add({ kind: 'pr-review', comment_id: r.id, author: r.user?.login ?? '', body: clip(r.body), html_url: r.html_url, created_at: r.submitted_at, target })
      }
    }

    const timed = events.filter((e) => e.created_at).sort((a, b) => a.created_at.localeCompare(b.created_at))
    const last = timed.at(-1)
    if (!last || last.author === SELF) continue
    const myLast = [...timed].reverse().find((e) => e.author === SELF)?.created_at ?? ''
    for (const e of events) {
      if (myLast && e.created_at && e.created_at <= myLast) continue
      push(e)
    }
  }

  for (const it of searchIssues(`mentions:${SELF} updated:>=${since}`, token)) {
    const repo = repoFromUrl(it.repository_url)
    push({
      kind: 'mention',
      comment_id: null,
      author: it.user?.login ?? '',
      body: clip(it.title),
      html_url: it.html_url,
      created_at: '',
      target: { repo, type: it.pull_request != null ? 'pull' : 'issue', number: it.number, title: it.title, url: it.html_url },
    })
  }

  let notifications: unknown
  try {
    notifications = ghApi('notifications', ['-X', 'GET', '-f', 'all=false', '-f', 'participating=true'], token)
  } catch {
    notifications = { error: 'unavailable (token scope)' }
  }

  const snapshot = {
    channel: 'github-engagement',
    date,
    fetched_at: new Date().toISOString(),
    self: SELF,
    window_since: since,
    candidates_truncated: truncated,
    engagements,
    notifications,
  }

  yield { channel: 'github-engagement', phase: 'persist', message: 'Writing snapshot…' }
  await persist('github-engagement', date, snapshot, null) // inbox feed only - no live signals

  const byKind = engagements.reduce<Record<string, number>>((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {})
  const result: PullResult = {
    channel: 'github-engagement',
    date,
    summary:
      `github-engagement ${date}: ${engagements.length} engagements ` +
      `(${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}) from ${candidates.length} candidates${truncated ? ' (truncated)' : ''}`,
  }
  yield { channel: 'github-engagement', phase: 'done', message: result.summary, result }
}

// ----- backfills (history → source='backfill' signal rows) -----

const PR_PAGE_CAP = 10
const STAR_PAGE_CAP = 400

function searchAllPrs(q: string, token: string): { created_at: string }[] {
  const items: { created_at: string }[] = []
  for (let page = 1; page <= PR_PAGE_CAP; page++) {
    const res = ghApi<{ items?: { created_at: string }[] }>('search/issues', [
      '-X', 'GET', '--raw-field', `q=${q}`, '-f', 'per_page=100', '-f', `page=${page}`,
    ], token)
    const batch = res.items ?? []
    items.push(...batch)
    if (batch.length < 100) break
  }
  return items
}

/** Last day of each month from `first` to today (inclusive), capped at today. As YYYY-MM-DD. */
function monthlyDates(first: Date): string[] {
  const today = new Date()
  const todayStr = today.toISOString().slice(0, 10)
  const dates: string[] = []
  let y = first.getUTCFullYear()
  let m = first.getUTCMonth()
  for (;;) {
    const endOfMonth = new Date(Date.UTC(y, m + 1, 0))
    const d = endOfMonth.toISOString().slice(0, 10)
    dates.push(d > todayStr ? todayStr : d)
    if (y > today.getUTCFullYear() || (y === today.getUTCFullYear() && m >= today.getUTCMonth())) break
    m++
    if (m > 11) { m = 0; y++ }
  }
  return [...new Set(dates)]
}

/** Streaming backfill - external PRs authored per account with an ossPrQuery, as a cumulative
 *  monthly curve (signal <channel>.oss_prs). */
export async function* backfillPrs(): AsyncGenerator<IngestProgress> {
  const accounts = pullableAccounts().filter((a) => a.ossPrQuery)
  if (accounts.length === 0) throw new Error('backfill:prs - no github account has an ossPrQuery configured')

  const rows: SignalRow[] = []
  let total = 0
  for (const acct of accounts) {
    const ch = accountChannel('github', acct)
    yield { channel: ch, phase: 'start', message: `[${ch}] Enumerating external PRs…` }
    const prs = searchAllPrs(acct.ossPrQuery!, accountToken(acct))
    if (prs.length === 0) throw new Error(`backfill:prs - ${ch} search returned 0 PRs (auth/query issue?)`)
    total += prs.length
    const createdAts = prs.map((p) => p.created_at).sort()
    const first = new Date(createdAts[0]!)
    for (const date of monthlyDates(first)) {
      rows.push({
        channel: ch,
        signal_id: `${ch}.oss_prs`,
        label: 'External PRs authored',
        signal_group: 'Open source',
        unit: null,
        date,
        value: createdAts.filter((c) => c.slice(0, 10) <= date).length,
        source: 'backfill',
      })
    }
  }

  yield { channel: 'github', phase: 'persist', message: `Writing ${rows.length} monthly points…` }
  await upsertBackfillSignals(rows)
  await autoRegisterDefinitions(rows)

  const result: PullResult = {
    channel: 'github',
    date: todayUtc(),
    summary: `backfill:prs: ${total} PRs · ${rows.length} monthly points across ${accounts.length} account(s)`,
  }
  yield { channel: 'github', phase: 'done', message: result.summary, result }
}

const DAY = 86_400_000
const ymd = (t: number): string => new Date(t).toISOString().slice(0, 10)
const parseDay = (d: string): number => Date.parse(`${d}T00:00:00Z`)

/** Sample dates from `first` to today: daily ≤120d, weekly ≤~2.5y, else monthly. */
function curveDates(first: Date): string[] {
  const today = parseDay(ymd(Date.now()))
  const start = parseDay(ymd(first.getTime()))
  const spanDays = (today - start) / DAY
  const step = spanDays <= 120 ? 1 : spanDays <= 900 ? 7 : 30
  const dates: string[] = []
  for (let t = today; t >= start; t -= step * DAY) dates.unshift(ymd(t))
  if (dates[0] !== ymd(start)) dates.unshift(ymd(start))
  return dates
}

function starredAt(repo: string, token: string): string[] {
  const out: string[] = []
  for (let page = 1; page <= STAR_PAGE_CAP; page++) {
    const res = ghApi<{ starred_at?: string }[]>(`repos/${repo}/stargazers`, [
      '-X', 'GET', '-H', 'Accept: application/vnd.github.star+json', '-f', 'per_page=100', '-f', `page=${page}`,
    ], token)
    if (!Array.isArray(res) || res.length === 0) break
    out.push(...res.map((s) => s.starred_at).filter((x): x is string => Boolean(x)))
    if (res.length < 100) break
  }
  return out
}

/** Streaming backfill - per-repo star growth curve (signal <channel>.stars.<name>), per account. */
export async function* backfillStars(): AsyncGenerator<IngestProgress> {
  const rows: SignalRow[] = []
  let repoCount = 0
  for (const acct of pullableAccounts()) {
    const ch = accountChannel('github', acct)
    const token = accountToken(acct)
    for (const repo of acct.repos ?? []) {
      const name = repo.split('/')[1]!
      repoCount++
      yield { channel: ch, phase: 'fetch', message: `[${ch}] stargazers for ${repo}…` }
      const stars = starredAt(repo, token).sort()
      if (stars.length === 0) continue
      const first = new Date(stars[0]!)
      for (const date of curveDates(first)) {
        rows.push({
          channel: ch,
          signal_id: `${ch}.stars.${name}`,
          label: `${name} ★`,
          signal_group: 'Stars',
          unit: null,
          date,
          value: stars.filter((s) => s.slice(0, 10) <= date).length,
          source: 'backfill',
        })
      }
    }
  }
  if (rows.length === 0) throw new Error('backfill:stars - no repos had retrievable stars')

  yield { channel: 'github', phase: 'persist', message: `Writing ${rows.length} star points…` }
  await upsertBackfillSignals(rows)
  await autoRegisterDefinitions(rows)

  const result: PullResult = {
    channel: 'github',
    date: todayUtc(),
    summary: `backfill:stars: ${rows.length} points across ${repoCount} repos`,
  }
  yield { channel: 'github', phase: 'done', message: result.summary, result }
}
