// Blog RSS - fetch + parse → publishing-cadence signal. In-process pull, folded back from the
// retired channels/blog plugin (2026-07-16). The RSS leg needs no auth (the feed is public); an
// optional GA4 leg (pulls/ga4.ts) adds daily website analytics when the blog account has a
// service-account key + numeric GA4_PROPERTY_ID configured, and degrades gracefully (skip +
// progress message) when it does not. The deriver lives in signals/derive.ts.
//
// WHICH feed is configuration - `feed` on a blog account in config/accounts.json, see
// ../blog-feed.ts - read per run rather than at import, so editing the file does not need a
// restart. No feed configured is a supported state: the pull says so in one line and does nothing.

import { channelAccounts } from '../../../accounts.js'
import { credential, readCredentialsFile } from '../../../credentials.js'
import { fetchText } from '../../../http.js'
import { BLOG_NOT_CONFIGURED, blogFeed } from '../blog-feed.js'
import { fetchGa4Daily, resolveKeyFile, type Ga4Block } from './ga4.js'
import { persist, todayUtc, type IngestProgress, type PullResult } from './types.js'

export interface FeedItem {
  title: string
  link: string
  guid: string
  description: string
  categories: string[]
  pub_date: string
  published_at: string | null
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m] ?? m)
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  const inner = m?.[1]
  if (inner == null) return ''
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  return decode((cdata?.[1] ?? inner).trim())
}

function allTags(block: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'gi')
  for (const m of block.matchAll(re)) out.push(decode((m[1] ?? '').trim()))
  return out
}

function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const channel = xml.match(/<channel>([\s\S]*)<\/channel>/i)?.[1] ?? xml
  const channelTitle = tag(channel.replace(/<item>[\s\S]*/i, ''), 'title')

  const items: FeedItem[] = []
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const b = m[1] ?? ''
    const pubDate = tag(b, 'pubDate')
    const parsed = pubDate ? new Date(pubDate) : null
    items.push({
      title: tag(b, 'title'),
      link: tag(b, 'link'),
      guid: tag(b, 'guid'),
      description: tag(b, 'description'),
      categories: allTags(b, 'category'),
      pub_date: pubDate,
      published_at: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
    })
  }
  return { title: channelTitle, items }
}

/**
 * Fetch + parse a feed, newest first. Throws if no items parse (fail-loud). The URL is REQUIRED:
 * it used to default to the author's own feed, which is how every Box ended up ingesting it.
 */
export async function fetchFeed(feed: string): Promise<{ feed: string; title: string; items: FeedItem[] }> {
  const xml = await fetchText(feed)
  const { title, items } = parseFeed(xml)
  if (items.length === 0) throw new Error(`no <item> entries parsed from ${feed} (${xml.length} bytes)`)
  items.sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))
  return { feed, title, items }
}

/**
 * The blog channel has no accounts.json entry yet - resolve the credential account id from the
 * default account when one is configured, else the first account keyed under `blog` in
 * config/credentials.json. Null when nothing is configured.
 */
function blogAccountId(): string | null {
  const acct = channelAccounts('blog').find((a) => a.default)
  if (acct) return acct.id
  return Object.keys(readCredentialsFile().blog ?? {})[0] ?? null
}

const GA4_WINDOW_DAYS = 28

/** `days` calendar days back from a YYYY-MM-DD date (UTC). */
function daysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

/**
 * The optional GA4 leg. Returns the snapshot block, or a skip reason when the account has no key
 * file / no numeric property id (graceful degradation - the RSS pull must keep working). Once both
 * exist, an API failure throws (fail-loud per repo style).
 */
async function fetchGa4Leg(date: string): Promise<{ ga4: Ga4Block } | { skip: string }> {
  const account = blogAccountId()
  if (!account) return { skip: 'no blog account configured (config/credentials.json)' }
  const keyPath = credential('blog', account, 'GOOGLE_APPLICATION_CREDENTIALS')
  const propertyId = credential('blog', account, 'GA4_PROPERTY_ID')
  if (!keyPath || !propertyId) return { skip: `blog@${account} has no GOOGLE_APPLICATION_CREDENTIALS/GA4_PROPERTY_ID` }
  if (!/^\d+$/.test(propertyId)) return { skip: `blog@${account} GA4_PROPERTY_ID is not a numeric property id` }
  const keyFile = resolveKeyFile(keyPath)
  if (!keyFile) return { skip: `service-account key not found at ${keyPath}` }
  // Last 28 complete days, ending yesterday (today is always a partial day in GA4).
  const end = daysBefore(date, 1)
  const start = daysBefore(end, GA4_WINDOW_DAYS - 1)
  return { ga4: await fetchGa4Daily({ keyFile, propertyId, start, end }) }
}

/** Streaming ingest action - the configured RSS feed (+ optional GA4 analytics) → snapshot + signal. */
export async function* ingestBlog(opts: { date?: string } = {}): AsyncGenerator<IngestProgress> {
  const date = opts.date ?? todayUtc()
  const configured = blogFeed()
  // Nothing configured is not a failure: it is a Box whose team has no blog, or one whose owner has
  // not filled the account in yet. Say which, and write no snapshot.
  if (!configured) {
    const result: PullResult = { channel: 'blog', date, summary: `blog ${date}: skipped - ${BLOG_NOT_CONFIGURED}` }
    yield { channel: 'blog', phase: 'done', message: result.summary, result }
    return
  }
  yield { channel: 'blog', phase: 'start', message: `Fetching RSS feed ${configured}…` }
  const { feed, title, items } = await fetchFeed(configured)

  yield { channel: 'blog', phase: 'fetch', message: 'Fetching GA4 website analytics…' }
  const leg = await fetchGa4Leg(date)
  if ('skip' in leg) yield { channel: 'blog', phase: 'fetch', message: `GA4 skipped: ${leg.skip}` }

  const snapshot = {
    channel: 'blog',
    date,
    fetched_at: new Date().toISOString(),
    feed_url: feed,
    feed_title: title,
    counts: { posts: items.length, latest_published_at: items[0]?.published_at ?? null },
    items,
    ...('ga4' in leg ? { ga4: leg.ga4 } : {}),
  }

  yield { channel: 'blog', phase: 'persist', message: 'Writing snapshot + deriving signals…' }
  await persist('blog', date, snapshot)

  const ga4Note = 'ga4' in leg ? `, ga4 ${leg.ga4.daily.length}d to ${leg.ga4.range.end}` : ', ga4 skipped'
  const result: PullResult = {
    channel: 'blog',
    date,
    summary: `blog ${date}: ${items.length} posts in "${title}" (latest ${items[0]?.published_at?.slice(0, 10) ?? '-'}${ga4Note})`,
  }
  yield { channel: 'blog', phase: 'done', message: result.summary, result }
}
