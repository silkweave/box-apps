// GitHub notifications alert evaluator - the conditional-poll tier. Polls the Notifications API
// (participation events: OSS PRs in repos we don't own, review requests, mentions - the events
// with `If-Modified-Since`, so an unchanged inbox is a free `304` that does NOT
// count against the rate limit. Honors the server-advertised `X-Poll-Interval` between polls. This
// is a raw fetch, not `gh api`, precisely so we can read/set those headers.
//
// Runs as a normal funnel action (`alerts-github`), schedulable like alerts-reddit. Cross-run
// protocol state (Last-Modified + the earliest next poll time) persists in the warehouse kv_state
// table - losing it only costs one full response. See features/alerts/SPEC.md.

import { defaultAccount } from '../../accounts.js'
import { requireCredentials } from '../../credentials.js'
import { USER_AGENT, sleep } from '../../http.js'
import { todayUtc, type IngestProgress } from '../../ops/types.js'
import { getKvState, setKvState } from '../../warehouse/db.js'
import { rulesForEvent } from './config.js'
import { ingestEvent } from './evaluate.js'
import { flushAlertsNow } from './flush.js'
import type { AlertEvent } from './types.js'

const EVENT_KIND = 'github.notification'
const STATE_KEY = 'alerts-github.notifications'
const API_URL = 'https://api.github.com/notifications?participating=true&all=false&per_page=50'

interface PollState {
  /** Verbatim Last-Modified from the last 200 - echoed back as If-Modified-Since. */
  last_modified?: string
  /** ISO time before which the server asked us not to poll again (X-Poll-Interval). */
  next_poll_at?: string
}

/** The subset of a notification thread we alert on. */
interface NotificationThread {
  id: string
  updated_at: string
  reason: string
  unread: boolean
  repository?: { full_name?: string; html_url?: string }
  subject?: { title?: string; url?: string | null; type?: string }
}

/** Map a notification subject's API url to the human page (textual, no extra API calls). */
export function subjectHtmlUrl(t: NotificationThread): string {
  const api = t.subject?.url
  if (!api) return t.repository?.html_url ?? ''
  return api
    .replace('https://api.github.com/repos/', 'https://github.com/')
    .replace(/\/pulls\/(\d+)$/, '/pull/$1')
    .replace(/\/commits\/([0-9a-f]+)$/, '/commit/$1')
    .replace(/\/releases\/\d+$/, '/releases')
}

function toAlertEvent(t: NotificationThread): AlertEvent {
  return {
    kind: EVENT_KIND,
    // A thread id is reused as the thread updates - key on (id, updated_at) so a NEW comment on an
    // already-alerted thread alerts again, while re-polling the same state stays a no-op.
    dedup_key: `${t.id}:${t.updated_at}`,
    event_at: t.updated_at,
    source: 'poll:github',
    subject: t.repository?.full_name ?? '',
    fields: {
      id: t.id,
      reason: t.reason,
      repo: t.repository?.full_name ?? '',
      type: t.subject?.type ?? '',
      title: t.subject?.title ?? '',
      url: subjectHtmlUrl(t),
    },
  }
}

/** One conditional GET. Returns the threads (200), or null when unchanged (304). Fail-loud else. */
async function conditionalFetch(
  token: string,
  lastModified: string | undefined,
): Promise<{ threads: NotificationThread[] | null; lastModified?: string; pollIntervalSec: number }> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch(API_URL, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
          ...(lastModified ? { 'If-Modified-Since': lastModified } : {}),
        },
      })
      const pollIntervalSec = Number(res.headers.get('X-Poll-Interval') ?? '60') || 60
      if (res.status === 304) return { threads: null, pollIntervalSec }
      if (!res.ok) throw new Error(`GET notifications → ${res.status} ${res.statusText}`)
      return {
        threads: (await res.json()) as NotificationThread[],
        // An empty inbox sends no Last-Modified, but the endpoint still honors If-Modified-Since
        // (verified 2026-07-14) - fall back to the response Date so those polls 304 too.
        lastModified: res.headers.get('Last-Modified') ?? res.headers.get('Date') ?? undefined,
        pollIntervalSec,
      }
    } catch (err) {
      lastErr = err
      if (attempt < 2) await sleep(500 * 2 ** attempt)
    }
  }
  throw lastErr
}

/**
 * Conditional-poll the default github account's participating notifications and record fresh
 * alerts. `not_modified` marks the free-304 path; `skipped` means the server-advertised poll
 * interval hasn't elapsed yet (we never poll faster than GitHub asks).
 */
export async function evaluateGithubNotifications(): Promise<{
  outcome: 'skipped' | 'not_modified' | 'fetched'
  fetched: number
  recorded: number
}> {
  const rules = rulesForEvent(EVENT_KIND)
  if (rules.length === 0) return { outcome: 'skipped', fetched: 0, recorded: 0 }

  const state = (await getKvState<PollState>(STATE_KEY)) ?? {}
  if (state.next_poll_at && Date.now() < Date.parse(state.next_poll_at)) {
    return { outcome: 'skipped', fetched: 0, recorded: 0 }
  }

  const acct = defaultAccount('github')
  const [token] = requireCredentials('github', acct.id, 'GH_TOKEN')
  const { threads, lastModified, pollIntervalSec } = await conditionalFetch(token, state.last_modified)

  await setKvState(STATE_KEY, {
    // A 304 sends no Last-Modified - keep the one that produced it.
    last_modified: lastModified ?? state.last_modified,
    next_poll_at: new Date(Date.now() + pollIntervalSec * 1000).toISOString(),
  } satisfies PollState)

  if (threads === null) return { outcome: 'not_modified', fetched: 0, recorded: 0 }

  let recorded = 0
  for (const t of threads) {
    const r = await ingestEvent(toAlertEvent(t))
    if (r.fresh) recorded++
  }
  return { outcome: 'fetched', fetched: threads.length, recorded }
}

/** Funnel action wrapper - ingest → flush (one batched message), mirroring alertsRedditAction. */
export async function* alertsGithubAction(): AsyncGenerator<IngestProgress> {
  yield { channel: 'alerts-github', phase: 'start', message: 'conditional-polling GitHub notifications…' }
  const { outcome, fetched, recorded } = await evaluateGithubNotifications()
  yield { channel: 'alerts-github', phase: 'persist', message: `${outcome}: ${recorded} new alert(s); delivering…` }
  const { delivered, suppressed, failed, messages } = await flushAlertsNow()
  const summary =
    `alerts-github: ${outcome}` +
    (outcome === 'fetched' ? ` (${fetched} threads, ${recorded} new)` : '') +
    `; delivered ${delivered} in ${messages} message(s), suppressed ${suppressed}, failed ${failed}`
  yield {
    channel: 'alerts-github',
    phase: 'done',
    message: summary,
    result: { channel: 'alerts-github', date: todayUtc(), summary },
  }
}
