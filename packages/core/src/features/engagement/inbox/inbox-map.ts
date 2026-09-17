// Event → Inbox-item mapping (alerts v2) - the ONE place that decides which event kinds are
// "response-needed" (they become tactical-Inbox items) and what their inbox item id/channel is.
// Used by the card renderer (deep links) and the inbox build (item derivation), so a Lark card
// button always lands on the exact item the event created. Ids stay platform-native and ALIGNED
// with the snapshot-derived ids in src/core/inbox/build.ts - the same engagement surfacing via
// both paths (an event now, tomorrow's snapshot) must collapse to ONE item with ONE state row.

/** Where an inbox deep link points: the dashboard channel segment + the stable item id. */
export interface InboxRef {
  channel: 'x' | 'reddit' | 'github' | 'linkedin'
  id: string
}

/** Reddit RSS kinds → the snapshot-derived id segments (see build.ts REDDIT_KIND). */
const REDDIT_SEGMENT: Record<string, string> = {
  comment_reply: 'comment-reply',
  post_reply: 'post-reply',
  username_mention: 'mention',
  private_message: 'message',
}

/**
 * The inbox item a response-needed event maps to, or null for kinds that carry no user action
 * (likes, follows, stars, run errors, signals, traction, digests).
 */
export function inboxRefForEvent(
  kind: string,
  dedupKey: string,
  fields: Record<string, unknown>,
): InboxRef | null {
  if (kind === 'x.reply' || kind === 'x.mention' || kind === 'x.quote') {
    // dedup_key is `x:<tweet id>` - reuse the id, segmented by kind.
    return { channel: 'x', id: `x:${kind.slice('x.'.length)}:${dedupKey.replace(/^x:/, '')}` }
  }
  if (kind === 'reddit.inbox') {
    // dedup_key is the reddit fullname (t1_/t3_/t4_) - EXACTLY the id the reddit-engagement
    // snapshot items use, so both paths merge: `reddit:<kind>:<fullname>`.
    const segment = REDDIT_SEGMENT[String(fields.kind ?? '')] ?? 'reply'
    return { channel: 'reddit', id: `reddit:${segment}:${dedupKey}` }
  }
  if (kind === 'github.notification') {
    return { channel: 'github', id: `gh:notif:${dedupKey}` }
  }
  if (kind === 'linkedin.comment') {
    // dedup_key is the comment URN (`urn:li:comment:(…)`) - stable across API and browser paths.
    return { channel: 'linkedin', id: `linkedin:comment:${dedupKey}` }
  }
  return null
}

/** The dashboard base URL for deep links (tailnet-only by design), or null when unconfigured. */
export function dashboardUrl(): string | null {
  const url = process.env.DASHBOARD_URL?.trim().replace(/\/+$/, '')
  return url || null
}

/** Deep link to a Replies item's detail page, or null when not linkable. Paths, not `#/` fragments,
 *  since the SPA moved to browser history on 2026-09-14; cards already delivered keep the old
 *  spelling and are rewritten client-side (see apps/web/src/router.tsx). */
export function inboxDeepLink(kind: string, dedupKey: string, fields: Record<string, unknown>): string | null {
  const base = dashboardUrl()
  const ref = inboxRefForEvent(kind, dedupKey, fields)
  if (!base || !ref) return null
  return `${base}/engagement/replies/${ref.channel}/${encodeURIComponent(ref.id)}`
}
