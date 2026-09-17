// Reddit inbox retrieval for the alerts initiative - BROWSER-FREE. Reads Reddit's tokenized private
// RSS inbox feed with a plain server-side GET: the per-user feed token IS the auth (no cookies, no
// OAuth app, no developer-approval form - the OAuth path is blocked, see features/data/SPEC.md). Not the
// rate-limited Data API, so it's quota-free; the `unread` feed is tiny. Zero deps, regex parse in the
// same style as channels/blog. The token is a per-user secret in config/credentials.json
// (reddit@<account> → REDDIT_FEED_TOKEN); the username comes from config/accounts.json.
//
// Caveat (verified 2026-07-09): the feed sends no Last-Modified/ETag, so there is no conditional 304
// - every poll returns the full (small) body. Cheap, not free. Dedup downstream by event `id` (the
// t1_/t3_/t4_ fullname), which is stable across polls until the item is marked read.

import { defaultAccount } from '../../../accounts.js'
import { requireCredentials } from '../../../credentials.js'
import { fetchText } from '../../../http.js'

export const ORIGIN = 'https://www.reddit.com'

/** Which Reddit inbox feed to read. `unread` is the alerting queue (only unread items). */
export type InboxKind = 'unread' | 'inbox' | 'mentions' | 'messages' | 'comments' | 'selfreply'
export const INBOX_KINDS: InboxKind[] = ['unread', 'inbox', 'mentions', 'messages', 'comments', 'selfreply']

/** What kind of notification an entry represents, derived from its fullname prefix + summary phrase. */
export type InboxEventKind = 'comment_reply' | 'post_reply' | 'username_mention' | 'private_message' | 'unknown'

/** One normalized inbox notification - everything an alert needs, source-agnostic downstream. */
export interface RedditInboxEvent {
  /** Reddit fullname (`t1_…` comment, `t3_…` post, `t4_…` message) - the stable dedup key. */
  id: string
  kind: InboxEventKind
  /** Author username, without the `/u/` prefix (empty for some system messages). */
  author: string
  /** Subreddit without the `r/` prefix, or '' for private messages. */
  subreddit: string
  /** Permalink to the comment/post/message. */
  permalink: string
  title: string
  /** Human-readable one-liner, e.g. "from X via r/Y sent 1 day ago: post reply". */
  summary: string
  /** ISO 8601 timestamp of the notification. */
  updated: string
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

/** Inner text of `<name>…</name>` (first match), CDATA-aware and entity-decoded. */
function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  const inner = m?.[1]
  if (inner == null) return ''
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  return decode((cdata?.[1] ?? inner).trim())
}

/** Value of an attribute on the first `<name …>` tag, e.g. attr(entry, 'link', 'href'). */
function attr(block: string, name: string, attribute: string): string {
  const m = block.match(new RegExp(`<${name}\\b[^>]*\\b${attribute}="([^"]*)"`, 'i'))
  return m ? decode(m[1]) : ''
}

/** Reddit's Atom notification "kind" phrase lives at the tail of the summary, after the last colon. */
function classify(id: string, summary: string): InboxEventKind {
  const phrase = summary.toLowerCase()
  if (phrase.includes('username mention')) return 'username_mention'
  if (phrase.includes('post reply')) return 'post_reply'
  if (phrase.includes('comment reply')) return 'comment_reply'
  if (id.startsWith('t4_')) return 'private_message'
  if (id.startsWith('t1_')) return 'comment_reply'
  return 'unknown'
}

/** Parse a Reddit inbox Atom feed into normalized events (feed order: newest first). */
export function parseInboxFeed(xml: string): RedditInboxEvent[] {
  const events: RedditInboxEvent[] = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const e = m[1] ?? ''
    const id = tag(e, 'id')
    if (!id) continue
    const summary = tag(e, 'summary') || tag(e, 'title')
    const label = attr(e, 'category', 'label') || attr(e, 'category', 'term')
    const updated = tag(e, 'updated')
    events.push({
      id,
      kind: classify(id, summary),
      author: tag(e, 'name').replace(/^\/?u\//i, ''),
      subreddit: label.replace(/^\/?r\//i, ''),
      permalink: attr(e, 'link', 'href'),
      title: tag(e, 'title'),
      summary,
      updated: updated && !Number.isNaN(Date.parse(updated)) ? new Date(updated).toISOString() : updated,
    })
  }
  return events
}

/** Build the tokenized private-feed URL for a given inbox kind. */
export function inboxFeedUrl(kind: InboxKind, token: string, user: string): string {
  return `${ORIGIN}/message/${kind}/.rss?feed=${encodeURIComponent(token)}&user=${encodeURIComponent(user)}`
}

/**
 * Fetch + parse a Reddit inbox feed for an account, browser-free. Defaults to the `unread` queue -
 * the natural alerting feed. Reads REDDIT_FEED_TOKEN from credentials and the username from accounts.
 * Fail-loud: a missing token throws (an automated alert poll must never silently read as "no news").
 */
export async function fetchInboxEvents(
  kind: InboxKind = 'unread',
  accountId: string = defaultAccount('reddit').id,
): Promise<RedditInboxEvent[]> {
  const user = defaultAccount('reddit').login
  const [token] = requireCredentials('reddit', accountId, 'REDDIT_FEED_TOKEN')
  const xml = await fetchText(inboxFeedUrl(kind, token, user))
  return parseInboxFeed(xml)
}
