// Mirror of the server's engagement domain (src/core/engagement/types.ts). The tRPC router reflects
// nested DTO arrays as `unknown`, so useEngagementData casts the wire shape to these - same pattern
// as content-types.ts.

import { Repeat2, Share2, StickyNote, ThumbsUp, type LucideIcon } from 'lucide-react'

export type EngagementAction = 'like' | 'react' | 'comment' | 'repost' | 'crosspost'
export type EngagementStatus = 'verified' | 'dismissed'

export interface EngagementEvidence {
  method: 'manual' | 'browser' | 'http'
  detail?: string
  screenshot_path?: string
  comment_text?: string
}

/** One derived to-do: "user X should <action> piece Y". Computed server-side, never stored. */
export interface EngagementCard {
  content_id: string
  /** content_topics.id of the main post - the group key for post grouping. */
  topic_id: string
  user_id: string
  channel: string
  title: string
  published_url: string
  published_at: string
  author: string
  action: EngagementAction
  days_left: number
}

/** One persisted engagement (or dismissal). */
export interface Engagement {
  content_id: string
  user_id: string
  action: EngagementAction
  status: EngagementStatus
  verified_at: string | null
  evidence: EngagementEvidence | null
  note: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

/** Verdict of the P2 verify-engagement op. Ambiguity is `unknown`, never `confirmed`. */
export type VerifyVerdict = 'confirmed' | 'not_found' | 'unknown'

/** Parsed outcome of one verify run (from the terminal chunk's `<verdict>: <detail>` summary). */
export interface EngagementVerifyResult {
  verdict: VerifyVerdict
  detail: string
}

/** Display copy per action: the imperative card label and the confirm-dialog phrasing. */
// Icon per action for the icon-only card badges (label stays in the tooltip/aria). react/like are
// the thumbs-up, comment is the note, a product decision, 2026-07-17.
export const ACTION_ICON: Record<EngagementAction, LucideIcon> = {
  like: ThumbsUp,
  react: ThumbsUp,
  comment: StickyNote,
  repost: Repeat2,
  crosspost: Share2,
}

export const ACTION_META: Record<EngagementAction, { label: string; imperative: string; confirm: string }> = {
  like: { label: 'Like', imperative: 'Like the post', confirm: 'you liked the post' },
  react: { label: 'React', imperative: 'React to the post', confirm: 'you reacted to the post' },
  comment: { label: 'Comment', imperative: 'Comment on the post', confirm: 'you commented on the post' },
  repost: { label: 'Repost', imperative: 'Repost it', confirm: 'you reposted it' },
  crosspost: { label: 'Crosspost', imperative: 'Crosspost it', confirm: 'you crossposted it' },
}
