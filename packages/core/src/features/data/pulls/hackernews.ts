// Hacker News read sync - profile, submissions (comment trees), brand mentions → snapshot + signal.
// In-process pull, folded back from the retired channels/hackernews plugin (2026-07-16). No auth
// (Firebase v0 + Algolia search are public). The deriver lives in signals/derive.ts.

import { defaultAccount } from '../../../accounts.js'
import { fetchJson } from '../../../http.js'
import { persist, todayUtc, type IngestProgress, type PullResult } from './types.js'

const FIREBASE = 'https://hacker-news.firebaseio.com/v0'
const ALGOLIA = 'https://hn.algolia.com/api/v1'

/**
 * Whose profile this pull is, and which words count as someone talking about us - both from the
 * default `hackernews` account in config/accounts.json rather than from constants here, because
 * they are the two facts that differ for every Box that installs this feature. Read at call time,
 * so editing accounts.json takes effect on the next run with no restart. `defaultAccount` refuses
 * with a pointed message when the channel has no account, which is the honest outcome for a
 * scheduled pull nobody has configured yet.
 */
function hackernewsAccount(): { user: string; mentionTerms: string[] } {
  const acct = defaultAccount('hackernews')
  return { user: acct.login, mentionTerms: acct.mentionTerms ?? [] }
}
const MAX_ITEMS = 100 // safety cap on how many of our submissions to expand per run

interface HnUser {
  id: string
  karma: number
  created: number
  submitted?: number[]
}
interface HnItem {
  id: number
  type?: string
  by?: string
  time?: number
  title?: string
  text?: string
  url?: string
  score?: number
  descendants?: number
  kids?: number[]
  deleted?: boolean
  dead?: boolean
}

const item = (id: number): Promise<HnItem | null> => fetchJson<HnItem | null>(`${FIREBASE}/item/${id}.json`)

/** Recursively fetch an item's comment tree (bounded depth to stay deterministic/cheap). */
async function withComments(id: number, depth = 0): Promise<unknown> {
  const it = await item(id)
  if (!it || it.deleted) return null
  const kids = depth < 6 && it.kids ? it.kids : []
  const comments = []
  for (const kid of kids) comments.push(await withComments(kid, depth + 1))
  return { ...it, comments: comments.filter(Boolean) }
}

async function mentions(term: string): Promise<unknown[]> {
  const res = await fetchJson<{ hits: any[] }>(
    `${ALGOLIA}/search_by_date?query=${encodeURIComponent(term)}&tags=(story,comment)&hitsPerPage=50`,
  )
  return res.hits.map((h) => ({
    objectID: h.objectID,
    author: h.author,
    title: h.title ?? null,
    snippet: (h.story_text ?? h.comment_text ?? h.title ?? '').slice(0, 280),
    points: h.points ?? null,
    url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
    created_at: h.created_at,
  }))
}

/** Fetch the full HN snapshot (profile + expanded submissions + mentions) and a count for the summary. */
async function fetchSnapshot(date: string): Promise<{ snapshot: Record<string, unknown>; mentionCount: number }> {
  const { user: login, mentionTerms } = hackernewsAccount()
  const user = await fetchJson<HnUser>(`${FIREBASE}/user/${login}.json`)
  const submittedIds = (user.submitted ?? []).slice(0, MAX_ITEMS)
  const items = []
  for (const id of submittedIds) items.push(await withComments(id))

  const mentionsByTerm: Record<string, unknown[]> = {}
  for (const term of mentionTerms) mentionsByTerm[term] = await mentions(term)
  const mentionCount = Object.values(mentionsByTerm).reduce((n, a) => n + a.length, 0)

  const snapshot = {
    channel: 'hackernews',
    date,
    fetched_at: new Date().toISOString(),
    profile: {
      id: user.id,
      karma: user.karma,
      created: new Date(user.created * 1000).toISOString(),
      submission_count: (user.submitted ?? []).length,
    },
    items: items.filter(Boolean),
    mentions: mentionsByTerm,
  }
  return { snapshot, mentionCount }
}

/** Streaming ingest action - HN profile, submissions, brand mentions → snapshot + signal. */
export async function* ingestHackerNews(opts: { date?: string } = {}): AsyncGenerator<IngestProgress> {
  const date = opts.date ?? todayUtc()
  yield { channel: 'hackernews', phase: 'start', message: 'Syncing Hacker News profile + mentions…' }
  const { snapshot, mentionCount } = await fetchSnapshot(date)
  const profile = snapshot.profile as { karma: number; submission_count: number }

  yield { channel: 'hackernews', phase: 'persist', message: 'Writing snapshot + deriving signals…' }
  await persist('hackernews', date, snapshot)

  const result: PullResult = {
    channel: 'hackernews',
    date,
    summary: `hackernews ${date}: karma ${profile.karma} · ${profile.submission_count} submissions · ${mentionCount} brand mentions`,
  }
  yield { channel: 'hackernews', phase: 'done', message: result.summary, result }
}
