// UI-facing types for the tactical engagement inbox (views/RepliesSection, components/inbox/*).
// The data is served live over tRPC by the server's InboxController; these mirror that wire
// shape and add the UI-only label maps below.

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
  /** Stable id keyed on the platform-native immutable id, so committed done-state survives rebuilds. */
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

export interface InboxStateEntry {
  status: ItemStatus
  done_at: string
  note?: string
}

/** Done/snoozed state, keyed by item id for O(1) lookup. Open items have NO entry. */
export interface InboxState {
  version: number
  items: Record<string, InboxStateEntry>
}

/** Friendly labels for grouping in the UI. */
export const KIND_LABEL: Record<InboxKind, string> = {
  'issue-comment': 'Comments',
  'pr-review-comment': 'Review comments',
  'pr-review': 'Reviews',
  'mention': 'Mentions',
  'gh-notification': 'Notifications',
  'hn-comment': 'Comments on your posts',
  'hn-mention': 'Brand mentions',
  'reddit-comment-reply': 'Replies to your comments',
  'reddit-post-reply': 'Replies to your posts',
  'reddit-mention': 'Mentions',
  'reddit-message': 'Messages',
  'x-reply': 'Replies to your posts',
  'x-mention': 'Mentions',
  'x-quote': 'Quotes of your posts',
  'linkedin-comment': 'Comments on your posts',
}

export const INBOX_CHANNEL_LABEL: Record<InboxChannel, string> = {
  github: 'GitHub',
  hackernews: 'Hacker News',
  reddit: 'Reddit',
  x: 'X',
  linkedin: 'LinkedIn',
}
