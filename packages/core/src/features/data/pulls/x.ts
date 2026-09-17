// X / Twitter ingest for the default `x` account in config/accounts.json. Pay-per-use API (owned
// reads ~$0.001 each); reading our own
// organic signals needs USER-CONTEXT auth → OAuth 1.0a. One timeline page per pull to bound cost.
// Pull UPSERTs into the warehouse; backfill writes `source='backfill'` rows for x.posts.

import { TwitterApi, type TwitterApiTokens, type TTweetv2TweetField } from 'twitter-api-v2'
import { defaultAccount } from '../../../accounts.js'
import { requireCredentials } from '../../../credentials.js'
import { upsertBackfillSignals, type SignalRow } from '../signals/write.js'
import { autoRegisterDefinitions } from '../signals/definitions.js'
import { persist, todayUtc, type IngestProgress, type PullResult } from './types.js'

const MAX_TWEETS = 100
type Signals = Record<string, number>

interface TweetOut {
  id: string
  created_at: string | null
  text: string
  public_metrics: Signals
  organic_metrics?: Signals
  non_public_metrics?: Signals
}

function impressions(t: TweetOut): number {
  return t.organic_metrics?.impression_count ?? t.public_metrics?.impression_count ?? 0
}

function client(): TwitterApi {
  const [appKey, appSecret, accessToken, accessSecret] = requireCredentials(
    'x',
    defaultAccount('x').id,
    'X_OAUTH1_CONSUMER_KEY',
    'X_OAUTH1_CONSUMER_KEY_SECRET',
    'X_OAUTH1_ACCESS_TOKEN',
    'X_OAUTH1_ACCESS_TOKEN_SECRET',
  )
  const creds: TwitterApiTokens = { appKey, appSecret, accessToken, accessSecret }
  return new TwitterApi(creds)
}

/** Streaming ingest action - X profile + per-post organic signals (newest page). */
export async function* ingestX(opts: { date?: string } = {}): AsyncGenerator<IngestProgress> {
  const date = opts.date ?? todayUtc()
  yield { channel: 'x', phase: 'start', message: 'Reading X profile…' }
  const api = client()

  const me = await api.v2.me({ 'user.fields': ['public_metrics', 'created_at', 'name', 'username'] })
  const u = me.data
  const pm = (u.public_metrics ?? {}) as Signals

  const base: TTweetv2TweetField[] = ['public_metrics', 'created_at']
  const rich: TTweetv2TweetField[] = [...base, 'organic_metrics', 'non_public_metrics']
  let signalsLevel: 'organic' | 'public' = 'organic'
  const fetchPage = (fields: TTweetv2TweetField[]) =>
    api.v2.userTimeline(u.id, { max_results: MAX_TWEETS, exclude: ['retweets', 'replies'], 'tweet.fields': fields })

  yield { channel: 'x', phase: 'fetch', message: 'Fetching recent posts + signals…' }
  let raw
  try {
    raw = (await fetchPage(rich)).data.data ?? []
  } catch {
    signalsLevel = 'public'
    raw = (await fetchPage(base)).data.data ?? []
  }

  const tweets: TweetOut[] = raw.map((t: any) => ({
    id: t.id,
    created_at: t.created_at ?? null,
    text: t.text ?? '',
    public_metrics: (t.public_metrics ?? {}) as Signals,
    ...(t.organic_metrics ? { organic_metrics: t.organic_metrics as Signals } : {}),
    ...(t.non_public_metrics ? { non_public_metrics: t.non_public_metrics as Signals } : {}),
  }))

  const impressionsTotal = tweets.reduce((n, t) => n + impressions(t), 0)
  const likesTotal = tweets.reduce((n, t) => n + (t.public_metrics?.like_count ?? 0), 0)
  const topTweet =
    [...tweets].sort((a, b) => (b.public_metrics?.like_count ?? 0) - (a.public_metrics?.like_count ?? 0))[0] ?? null

  const snapshot = {
    channel: 'x',
    date,
    fetched_at: new Date().toISOString(),
    signals_level: signalsLevel,
    account: {
      id: u.id,
      username: u.username,
      name: u.name,
      created: u.created_at ?? null,
      followers: pm.followers_count ?? 0,
      following: pm.following_count ?? 0,
      tweets: pm.tweet_count ?? 0,
      listed: pm.listed_count ?? 0,
    },
    counts: { tweets_fetched: tweets.length, impressions_total: impressionsTotal, likes_total: likesTotal },
    top_tweet: topTweet && {
      id: topTweet.id,
      text: topTweet.text.slice(0, 200),
      created_at: topTweet.created_at,
      likes: topTweet.public_metrics?.like_count ?? 0,
      impressions: impressions(topTweet),
    },
    tweets,
  }

  yield { channel: 'x', phase: 'persist', message: 'Writing snapshot + deriving signals…' }
  await persist('x', date, snapshot)

  const result: PullResult = {
    channel: 'x',
    date,
    summary:
      `x ${date}: @${u.username} · ${snapshot.account.followers.toLocaleString()} followers · ` +
      `${tweets.length} posts (${signalsLevel} signals) · ${impressionsTotal.toLocaleString()} impressions`,
  }
  yield { channel: 'x', phase: 'done', message: result.summary, result }
}

// ----- backfill (posting cadence → source='backfill' rows for x.posts) -----

const CAP = 3300
const DAY = 86_400_000
const ymd = (t: number): string => new Date(t).toISOString().slice(0, 10)
const parseDay = (d: string): number => Date.parse(`${d}T00:00:00Z`)

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

/** Streaming backfill - X posting cadence reconstructed from each tweet's created_at (x.posts). */
export async function* backfillX(): AsyncGenerator<IngestProgress> {
  yield { channel: 'x', phase: 'start', message: 'Paging full timeline for created_at…' }
  const api = client()
  const me = await api.v2.me()
  const timeline = await api.v2.userTimeline(me.data.id, { max_results: 100, 'tweet.fields': ['created_at'] })

  const created: string[] = []
  for await (const t of timeline) {
    if (t.created_at) created.push(t.created_at)
    if (created.length >= CAP) break
  }
  if (created.length === 0) throw new Error('backfill:x - timeline returned no tweets with created_at')

  created.sort()
  const first = new Date(created[0]!)
  const rows: SignalRow[] = curveDates(first).map((date) => ({
    channel: 'x',
    signal_id: 'x.posts',
    label: 'Posts',
    signal_group: 'Activity',
    unit: null,
    date,
    value: created.filter((c) => c.slice(0, 10) <= date).length,
    source: 'backfill',
  }))

  yield { channel: 'x', phase: 'persist', message: `Writing ${rows.length} cadence points…` }
  await upsertBackfillSignals(rows)
  await autoRegisterDefinitions(rows)

  const result: PullResult = {
    channel: 'x',
    date: todayUtc(),
    summary: `backfill:x: ${created.length} tweets · ${rows.length} points (→ ${rows.at(-1)!.value} posts)`,
  }
  yield { channel: 'x', phase: 'done', message: result.summary, result }
}
