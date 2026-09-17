// Engagement-action vocabulary shared by the pods module and the verify strategies. Lived in the
// retired cross-team engagement module; the pods network is the sole consumer now.

/** The platform action a participant performs on a piece. */
export type EngagementAction = 'like' | 'react' | 'comment' | 'repost' | 'crosspost'

/**
 * `verified` - the engagement was confirmed (manual attestation, or read from the engager's own
 * browser session). `dismissed` - deliberately opting out; removes the card without recording a
 * fake engagement, and never feeds signals.
 */
export type EngagementStatus = 'verified' | 'dismissed'

export const ENGAGEMENT_ACTIONS: EngagementAction[] = ['like', 'react', 'comment', 'repost', 'crosspost']
export const ENGAGEMENT_STATUSES: EngagementStatus[] = ['verified', 'dismissed']

/** How a verified engagement was confirmed. */
export interface EngagementEvidence {
  /** 'manual' - the engager attested in the dashboard. 'browser' - a verify op read it from their
   *  own logged-in session. 'http' - confirmed via a public, no-browser read (reddit thread JSON). */
  method: 'manual' | 'browser' | 'http'
  /** Free-form note on what was observed (e.g. "like button toggled active"). */
  detail?: string
  /** Repo-relative screenshot path captured by the browser verify. */
  screenshot_path?: string
  /** The engager's detected comment text, for comment actions. */
  comment_text?: string
}
