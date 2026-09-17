// Shared data types for the tactical engagement inbox - the wire shape served over tRPC
// (InboxController). The dashboard keeps its own UI-facing copy (label maps etc.) in
// dashboard/src/inbox-types.ts and structurally casts the tRPC result, mirroring how the
// signals surface works.

export type InboxChannel = 'github' | 'hackernews' | 'reddit' | 'x' | 'linkedin'

export type InboxKind =
  // GitHub - engagements by others on our own PRs/issues
  | 'issue-comment'
  | 'pr-review-comment'
  | 'pr-review'
  | 'mention'
  // GitHub - participation notifications (events-derived, near-realtime)
  | 'gh-notification'
  // Hacker News
  | 'hn-comment'
  | 'hn-mention'
  // Reddit - replies to his comments/posts + username mentions
  | 'reddit-comment-reply'
  | 'reddit-post-reply'
  | 'reddit-mention'
  | 'reddit-message'
  // X - response-needed engagement (events-derived; no live producer since 2026-09-10)
  | 'x-reply'
  | 'x-mention'
  | 'x-quote'
  // LinkedIn - comments received on published posts (events-derived from the alerts-linkedin poll)
  | 'linkedin-comment'

/** One actionable engagement: someone else engaged us and a reply/decision is warranted. */
export interface InboxItem {
  /** Stable id keyed on the platform-native immutable id, so done-state survives re-pulls. */
  id: string
  channel: InboxChannel
  kind: InboxKind
  /** Who engaged (never the account holder - those are filtered out upstream). */
  author: string
  /** Human label for the thread: PR/issue title, HN submission title, or "Brand mention: <term>". */
  title: string
  /** First ~280 chars of what they said, plain text. */
  snippet: string
  /** Permalink to open the thread/comment. */
  url: string
  /** ISO timestamp, or '' when the source has none (those sort last). */
  created_at: string
  /** Short context: what of his they engaged (repo#number, submission title, or brand term). */
  target: string
  /** Full untruncated text when the source has more than the snippet (the detail page shows it). */
  body?: string
}

export interface InboxData {
  generatedAt: string
  channels: InboxChannel[]
  items: InboxItem[]
}

export type ItemStatus = 'done' | 'snoozed'

/** One done/snoozed row from the inbox_state table. Open items have NO entry. */
export interface InboxStateEntry {
  /** The InboxItem.id this state applies to. */
  id: string
  status: ItemStatus
  done_at: string
  note?: string
}

export interface InboxState {
  items: InboxStateEntry[]
}
