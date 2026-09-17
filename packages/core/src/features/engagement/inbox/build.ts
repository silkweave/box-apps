// Build the tactical engagement inbox from the warehouse: read the LATEST github-engagement,
// hackernews, and reddit-engagement snapshots (the ground truth) and flatten them into a single
// actionable item list. Pure transform over the DB - no network. Served live over tRPC by the
// InboxController (was the dashboard's build-inbox.ts prebuild + inbox.json).
//
// The inbox only needs the latest snapshot per channel - it's a point-in-time task list, not a
// time signal.

import { listEvents, type EventRecord } from '../../../events.js'
import { inboxRefForEvent } from './inbox-map.js'
import { withRead } from '../../../warehouse/db.js'
import type { InboxChannel, InboxData, InboxItem, InboxKind } from './types.js'


/** Newest snapshot payload for a channel from the warehouse, or null if none yet. Read-only. */
async function latestSnapshot(channel: string): Promise<any | null> {
  const rows = await withRead<{ payload?: unknown }>(
    `SELECT payload FROM snapshots WHERE channel = ? ORDER BY snapshot_date DESC LIMIT 1`,
    [channel],
  )
  const p = rows[0]?.payload
  return p == null ? null : typeof p === 'string' ? JSON.parse(p) : p
}

/** Strip HTML tags + decode the few entities HN's comment HTML uses. */
function plainText(html: unknown): string {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280)
}

// ---------------- GitHub ----------------
function githubItems(snap: any): InboxItem[] {
  if (!snap) return []
  const out: InboxItem[] = []
  for (const e of snap.engagements ?? []) {
    if (!e.author || e.author === snap.self) continue
    const t = e.target ?? {}
    const ref = `${t.repo}#${t.number}`
    const id = e.kind === 'mention' ? `gh:mention:${ref}` : `gh:${e.kind}:${e.comment_id}`
    out.push({
      id,
      channel: 'github',
      kind: e.kind,
      author: e.author,
      title: t.title ?? ref,
      snippet: e.kind === 'mention' ? `Mentioned you in ${ref}` : (e.body ?? ''),
      url: e.html_url,
      created_at: e.created_at ?? '',
      target: ref,
    })
  }
  return out
}

// ---------------- Hacker News ----------------
/** Recursively collect comments by others from a submission's nested comment tree. */
function walkHnComments(node: any, submissionTitle: string, hnUser: string, out: InboxItem[]): void {
  for (const c of node?.comments ?? []) {
    if (c && c.by && c.by !== hnUser && !c.deleted) {
      out.push({
        id: `hn:comment:${c.id}`,
        channel: 'hackernews',
        kind: 'hn-comment',
        author: c.by,
        title: submissionTitle,
        snippet: plainText(c.text),
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        created_at: c.time ? new Date(c.time * 1000).toISOString() : '',
        target: submissionTitle,
      })
    }
    walkHnComments(c, submissionTitle, hnUser, out) // descend regardless of who authored this level
  }
}

function hackernewsItems(snap: any): InboxItem[] {
  if (!snap) return []
  const out: InboxItem[] = []
  // Whose account this snapshot is, read from the snapshot itself rather than re-derived from
  // config: the pull already stamped it, and a config edit between the pull and this transform
  // must not silently change which comments read as "ours". Empty means every author is someone
  // else, which errs towards listing an item rather than hiding one.
  const hnUser = typeof snap.profile?.id === 'string' ? snap.profile.id : ''

  // (a) Replies on our own submissions.
  for (const sub of snap.items ?? []) {
    if (sub) walkHnComments(sub, sub.title ?? 'submission', hnUser, out)
  }

  // (b) Brand mentions site-wide. Algolia search is fuzzy (e.g. "Silkwave" ≠ "silkweave"), so keep
  //     only hits where the brand term actually appears - precision matters for a task list.
  for (const [term, hits] of Object.entries(snap.mentions ?? {})) {
    const needle = term.toLowerCase()
    for (const h of (hits as any[]) ?? []) {
      if (!h.author || h.author === hnUser) continue
      const haystack = `${h.title ?? ''} ${h.snippet ?? ''} ${h.url ?? ''}`.toLowerCase()
      if (!haystack.includes(needle)) continue
      out.push({
        id: `hn:mention:${h.objectID}`,
        channel: 'hackernews',
        kind: 'hn-mention',
        author: h.author,
        title: `Brand mention: ${term}`,
        snippet: plainText(h.snippet || h.title),
        url: h.url,
        created_at: h.created_at ?? '',
        target: term,
      })
    }
  }
  return out
}

// ---------------- Reddit ----------------
const REDDIT_KIND: Record<string, InboxKind> = {
  'comment-reply': 'reddit-comment-reply',
  'post-reply': 'reddit-post-reply',
  mention: 'reddit-mention',
}

function redditItems(snap: any): InboxItem[] {
  if (!snap) return []
  const out: InboxItem[] = []
  for (const e of snap.engagements ?? []) {
    if (!e.author || e.author === snap.self) continue
    if (e.answered) continue // our own account already replied beneath it - handled, not a task
    const kind = REDDIT_KIND[e.kind]
    if (!kind) continue
    out.push({
      id: `reddit:${e.kind}:${e.id}`, // e.id is the reddit fullname (t1_/t3_) - stable across pulls
      channel: 'reddit',
      kind,
      author: e.author,
      title: e.link_title || (e.subreddit ? `r/${e.subreddit}` : 'Reddit'),
      snippet: e.body ?? '',
      url: e.url,
      created_at: e.created_at ?? '',
      target: e.subreddit ? `r/${e.subreddit}` : 'reddit',
    })
  }
  return out
}

// ---------------- Events (alerts v2 - near-realtime response-needed items) ----------------
// Response-needed events become inbox items straight from the events table, alongside (and merged
// with) the snapshot-derived items. Ids come from inboxRefForEvent - the SAME mapping the Lark
// card deep links use, and for reddit the SAME id the snapshot items produce, so one engagement
// surfacing via both paths is ONE item with ONE state row. See features/engagement/SPEC.md.

const EVENT_KINDS = ['x.reply', 'x.mention', 'x.quote', 'reddit.inbox', 'github.notification', 'linkedin.comment']
const EVENT_WINDOW_DAYS = 30

const X_KIND: Record<string, { kind: InboxKind; label: string }> = {
  'x.reply': { kind: 'x-reply', label: 'Reply from' },
  'x.mention': { kind: 'x-mention', label: 'Mention by' },
  'x.quote': { kind: 'x-quote', label: 'Quote by' },
}

const REDDIT_EVENT_KIND: Record<string, InboxKind> = {
  comment_reply: 'reddit-comment-reply',
  post_reply: 'reddit-post-reply',
  username_mention: 'reddit-mention',
  private_message: 'reddit-message',
}

function eventItem(e: EventRecord): InboxItem | null {
  const ref = inboxRefForEvent(e.kind, e.dedup_key, e.fields)
  if (!ref) return null
  const created_at = e.event_at ?? e.received_at
  if (e.kind.startsWith('x.')) {
    const spec = X_KIND[e.kind]
    if (!spec) return null
    const text = String(e.fields.text ?? '')
    return {
      id: ref.id,
      channel: 'x',
      kind: spec.kind,
      author: e.actor || String(e.fields.author ?? ''),
      title: `${spec.label} @${e.actor || e.fields.author}`,
      snippet: text.slice(0, 280),
      body: text,
      url: e.url || String(e.fields.url ?? ''),
      created_at,
      target: 'X',
    }
  }
  if (e.kind === 'reddit.inbox') {
    const kind = REDDIT_EVENT_KIND[String(e.fields.kind ?? '')] ?? 'reddit-comment-reply'
    return {
      id: ref.id,
      channel: 'reddit',
      kind,
      author: e.actor || String(e.fields.author ?? ''),
      title: String(e.fields.title ?? '') || (e.fields.subreddit ? `r/${e.fields.subreddit}` : 'Reddit'),
      snippet: String(e.fields.summary ?? '').slice(0, 280),
      body: String(e.fields.summary ?? ''),
      url: e.url || String(e.fields.permalink ?? ''),
      created_at,
      target: e.fields.subreddit ? `r/${e.fields.subreddit}` : 'reddit',
    }
  }
  if (e.kind === 'linkedin.comment') {
    const text = String(e.fields.text ?? '')
    return {
      id: ref.id,
      channel: 'linkedin',
      kind: 'linkedin-comment',
      author: String(e.fields.author ?? '') || e.actor,
      title: String(e.fields.post_title ?? '') || 'LinkedIn post',
      snippet: text.slice(0, 280),
      body: text,
      url: e.url || String(e.fields.post_url ?? ''),
      created_at,
      target: String(e.fields.content_id ?? 'LinkedIn'),
    }
  }
  if (e.kind === 'github.notification') {
    return {
      id: ref.id,
      channel: 'github',
      kind: 'gh-notification',
      author: e.actor || 'github',
      title: String(e.fields.title ?? '') || String(e.fields.repo ?? ''),
      snippet: `${e.fields.reason ?? 'notification'} on ${e.fields.type ?? 'thread'} in ${e.fields.repo ?? ''}`,
      url: e.url || String(e.fields.url ?? ''),
      created_at,
      target: String(e.fields.repo ?? ''),
    }
  }
  return null
}

async function eventsItems(): Promise<InboxItem[]> {
  const since = new Date(Date.now() - EVENT_WINDOW_DAYS * 86_400_000).toISOString()
  const events = await listEvents(EVENT_KINDS, since, 500)
  return events.map(eventItem).filter((i): i is InboxItem => i !== null)
}

/** Flatten the latest engagement snapshots into the actionable inbox list (newest-first). */
export async function buildInbox(): Promise<InboxData> {
  const [gh, hn, reddit, fromEvents] = await Promise.all([
    latestSnapshot('github-engagement'),
    latestSnapshot('hackernews'),
    latestSnapshot('reddit-engagement'),
    eventsItems(),
  ])

  // Events first: when a snapshot-derived item shares an id (reddit), the snapshot's richer
  // version wins in the last-wins de-dupe below.
  const raw = [...fromEvents, ...githubItems(gh), ...hackernewsItems(hn), ...redditItems(reddit)]

  // De-dupe by stable id (last wins), then sort newest-first ('' timestamps sink to the bottom).
  const byId = new Map<string, InboxItem>()
  for (const it of raw) byId.set(it.id, it)
  const items = [...byId.values()].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))

  const channels: InboxChannel[] = [...new Set(items.map((i) => i.channel))]
  return { generatedAt: new Date().toISOString(), channels, items }
}
