// Reddit ingest - profile signals, the engagement inbox feed, and the topic radar. All attach to
// the stealth browser via reddit-client (no API keys; the OAuth path is blocked). Signals + radar
// UPSERT snapshots into the warehouse; engagement feeds the inbox (reddit.engagement_open signal).

import type { Page } from 'playwright-core'
import { redditSelf, withReddit, fetchAll, assertLoggedIn } from './reddit-client.js'
import { readRedditRadar, redditRadarConfigured, REDDIT_RADAR_NOT_CONFIGURED } from '../reddit-radar.js'
import { persist, todayUtc, type IngestProgress, type PullResult } from './types.js'

const clip = (s: unknown, n = 160): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

interface Item {
  kind: 't1' | 't3'
  id: string
  subreddit: string
  score: number
  num_comments?: number
  title: string
  body?: string
  permalink: string
  created_utc: number
}

function items(listing: any): Item[] {
  return (listing?.data?.children ?? []).map((c: any) => {
    const d = c.data ?? {}
    return {
      kind: c.kind,
      id: d.name,
      subreddit: d.subreddit,
      score: d.score ?? 0,
      num_comments: c.kind === 't3' ? d.num_comments : undefined,
      title: c.kind === 't3' ? clip(d.title, 200) : clip(d.link_title, 200),
      body: c.kind === 't1' ? clip(d.body, 280) : undefined,
      permalink: `https://www.reddit.com${d.permalink ?? ''}`,
      created_utc: d.created_utc,
    }
  })
}

/** Streaming ingest action - Reddit karma + top posts/comments for the configured account. */
export async function* ingestReddit(opts: { date?: string } = {}): AsyncGenerator<IngestProgress> {
  const date = opts.date ?? todayUtc()
  const self = redditSelf()
  yield { channel: 'reddit', phase: 'start', message: 'Leasing a tab in the stealth browser…' }

  const snapshot = await withReddit(async (page: Page) => {
    await assertLoggedIn(page)
    const aboutP = `/user/${self}/about.json`
    const meP = '/api/me.json'
    const submittedP = `/user/${self}/submitted.json?limit=100&sort=new&raw_json=1`
    const commentsP = `/user/${self}/comments.json?limit=100&sort=new&raw_json=1`
    const r = await fetchAll(page, [aboutP, meP, submittedP, commentsP])
    const about = r[aboutP]?.json?.data ?? {}
    const me = r[meP]?.json?.data ?? {}
    const posts = items(r[submittedP]?.json)
    const comments = items(r[commentsP]?.json)
    const byScore = (a: Item, b: Item) => b.score - a.score
    return {
      channel: 'reddit',
      date,
      fetched_at: new Date().toISOString(),
      account: {
        name: about.name ?? me.name ?? self,
        total_karma: about.total_karma ?? me.total_karma ?? 0,
        link_karma: about.link_karma ?? me.link_karma ?? 0,
        comment_karma: about.comment_karma ?? me.comment_karma ?? 0,
        created_utc: about.created_utc ?? me.created_utc ?? null,
        verified: about.verified ?? null,
        is_suspended: about.is_suspended ?? null,
        has_unread_mail: me.has_mail ?? null,
        inbox_count: me.inbox_count ?? null,
      },
      counts: { posts: posts.length, comments: comments.length },
      top_posts: [...posts].sort(byScore).slice(0, 10),
      top_comments: [...comments].sort(byScore).slice(0, 10),
    }
  })

  yield { channel: 'reddit', phase: 'persist', message: 'Writing snapshot + deriving signals…' }
  await persist('reddit', date, snapshot)

  const a = snapshot.account
  const result: PullResult = {
    channel: 'reddit',
    date,
    summary:
      `reddit ${date}: u/${a.name} · karma ${a.total_karma} (link ${a.link_karma} / comment ${a.comment_karma}) · ` +
      `${snapshot.counts.posts} posts / ${snapshot.counts.comments} comments`,
  }
  yield { channel: 'reddit', phase: 'done', message: result.summary, result }
}

// ----- engagement (inbox feed → reddit.engagement_open signal, derived under 'reddit') -----

const clipE = (s: unknown, n = 280): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

interface Engagement {
  kind: 'comment-reply' | 'post-reply' | 'mention'
  id: string
  author: string
  subreddit: string
  link_title: string
  body: string
  url: string
  created_at: string
  is_new: boolean
  answered: boolean
}

const KIND: Record<string, Engagement['kind']> = {
  comment_reply: 'comment-reply',
  post_reply: 'post-reply',
  username_mention: 'mention',
}

function selfRepliedUnder(listing: any, fullname: string, self: string): boolean {
  for (const c of listing?.data?.children ?? []) {
    if (c.kind !== 't1') continue
    const d = c.data ?? {}
    if (d.name === fullname) {
      return (d.replies?.data?.children ?? []).some((r: any) => r.kind === 't1' && r.data?.author === self)
    }
    if (d.replies && selfRepliedUnder(d.replies, fullname, self)) return true
  }
  return false
}

/** Streaming ingest action - Reddit inbox items awaiting a reply (engagement feed). */
export async function* ingestRedditEngagement(opts: { date?: string } = {}): AsyncGenerator<IngestProgress> {
  const self = redditSelf()
  const date = opts.date ?? todayUtc()
  yield { channel: 'reddit-engagement', phase: 'start', message: 'Reading Reddit inbox…' }

  const snapshot = await withReddit(async (page: Page) => {
    await assertLoggedIn(page)
    const paths = [
      '/message/inbox.json?limit=100&raw_json=1',
      '/message/unread.json?limit=100&raw_json=1',
      '/message/mentions.json?limit=100&raw_json=1',
    ]
    const r = await fetchAll(page, paths)

    const byId = new Map<string, Engagement>()
    for (const p of paths) {
      for (const c of r[p]?.json?.data?.children ?? []) {
        const d = c.data ?? {}
        const kind = KIND[d.type]
        if (!kind) continue
        if (!d.author || d.author === self || d.author === '[deleted]') continue
        const contextPath = `${(d.context ?? d.permalink ?? '').split('?')[0]}`
        byId.set(d.name, {
          kind,
          id: d.name,
          author: d.author,
          subreddit: d.subreddit ?? '',
          link_title: clipE(d.link_title, 200),
          body: clipE(d.body),
          url: `https://www.reddit.com${contextPath}`,
          created_at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : '',
          is_new: Boolean(d.new),
          answered: false,
        })
      }
    }

    const ctxOf = (e: Engagement) => `${e.url.replace('https://www.reddit.com', '').replace(/\/$/, '')}.json?raw_json=1&limit=50&context=0`
    const candidates = [...byId.values()]
    const ctx = await fetchAll(page, candidates.map(ctxOf))
    for (const e of candidates) {
      const f = ctx[ctxOf(e)]
      const commentListing = Array.isArray(f?.json) ? f.json[1] : undefined
      e.answered = commentListing ? selfRepliedUnder(commentListing, e.id, self) : false
    }

    const engagements = candidates.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    return { channel: 'reddit-engagement', date, fetched_at: new Date().toISOString(), self, engagements }
  })

  yield { channel: 'reddit-engagement', phase: 'persist', message: 'Writing snapshot + deriving signals…' }
  await persist('reddit-engagement', date, snapshot, 'reddit') // feeds reddit.engagement_open

  const open = snapshot.engagements.filter((e) => !e.answered)
  const byKind = open.reduce<Record<string, number>>((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {})
  const result: PullResult = {
    channel: 'reddit-engagement',
    date,
    summary:
      `reddit-engagement ${date}: ${open.length} actionable / ${snapshot.engagements.length} total ` +
      `(${Object.entries(byKind).map(([k, c]) => `${c} ${k}`).join(', ') || 'none open'})`,
  }
  yield { channel: 'reddit-engagement', phase: 'done', message: result.summary, result }
}

// ----- topic radar (reply opportunities; snapshot only - no live signal) -----

// WHICH subs and WHICH topics are configuration (config/reddit-radar.json, see ../reddit-radar.ts),
// read per run rather than at import so editing the file does not need a restart. They used to be
// two constants here, holding the author's own target communities and product keywords.
const DEFAULT_DAYS = 14
const PER_SUB = 75

/** Whole-word, case-insensitive matcher per topic, built per run from the configured list. */
function matchers(topics: string[]): { topic: string; re: RegExp }[] {
  return topics.map((t) => ({
    topic: t,
    re: new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
  }))
}

interface Candidate {
  subreddit: string
  title: string
  author: string
  score: number
  num_comments: number
  created_at: string
  age_days: number
  matched: string[]
  url: string
}

/** Streaming ingest action - scan the configured subs' /new for on-topic threads to reply to. */
export async function* redditRadar(opts: { date?: string; days?: number } = {}): AsyncGenerator<IngestProgress> {
  const date = opts.date ?? todayUtc()
  const days = opts.days ?? DEFAULT_DAYS
  // Read the listening list ONCE, before the scan, and carry that value through both the scan and
  // the snapshot. Nothing configured is not a failure: it is a Box that is not listening yet.
  const { subs, topics } = readRedditRadar()
  if (!redditRadarConfigured({ subs, topics })) {
    const summary = `reddit-radar ${date}: skipped - ${REDDIT_RADAR_NOT_CONFIGURED}`
    yield { channel: 'reddit-radar', phase: 'done', message: summary, result: { channel: 'reddit-radar', date, summary } }
    return
  }
  const self = redditSelf()
  const cutoff = Date.now() / 1000 - days * 86400
  const topicMatchers = matchers(topics)
  yield {
    channel: 'reddit-radar',
    phase: 'start',
    message: `Scanning ${subs.length} subs for ${topics.length} topics (last ${days}d)…`,
  }

  const snapshot = await withReddit(async (page: Page) => {
    await assertLoggedIn(page)
    const paths = subs.map((s) => `/r/${s}/new.json?limit=${PER_SUB}&raw_json=1`)
    const r = await fetchAll(page, paths)
    const candidates: Candidate[] = []
    for (const [i, p] of paths.entries()) {
      const sub = subs[i]
      if (!sub) continue
      const f = r[p]
      if (!f?.ok) continue
      for (const c of f.json?.data?.children ?? []) {
        const d = c.data ?? {}
        if (d.created_utc < cutoff) continue
        if (d.author === self || d.author === '[deleted]') continue
        const hay = `${d.title ?? ''} ${d.selftext ?? ''}`
        const matched = topicMatchers.filter((m) => m.re.test(hay)).map((m) => m.topic)
        if (matched.length === 0) continue
        candidates.push({
          subreddit: sub,
          title: String(d.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
          author: d.author,
          score: d.score ?? 0,
          num_comments: d.num_comments ?? 0,
          created_at: new Date(d.created_utc * 1000).toISOString(),
          age_days: Math.round((Date.now() / 1000 - d.created_utc) / 86400),
          matched,
          url: `https://www.reddit.com${d.permalink ?? ''}`,
        })
      }
    }
    candidates.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.matched.length - a.matched.length)
    // Stamp the subs AND topics that actually produced this scan. Same rule the engagement inbox
    // builder follows when it reads whose account a snapshot is from the snapshot rather than from
    // live config: an edit to config/reddit-radar.json between this pull and any later read must not
    // silently change what the stored rows mean. `matched` is only interpretable against `topics`.
    return {
      channel: 'reddit-radar',
      date,
      fetched_at: new Date().toISOString(),
      window_days: days,
      subs,
      topics,
      candidates,
    }
  })

  yield { channel: 'reddit-radar', phase: 'persist', message: 'Writing snapshot…' }
  await persist('reddit-radar', date, snapshot, null) // opportunity feed - no live signals

  const result: PullResult = {
    channel: 'reddit-radar',
    date,
    summary: `reddit-radar ${date}: ${snapshot.candidates.length} candidate(s) over last ${days}d`,
  }
  yield { channel: 'reddit-radar', phase: 'done', message: result.summary, result }
}
