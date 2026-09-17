// Content domain - TWO objects since 2026-08-12 (a product decision), neither of them an initiative:
//
//   • a **topic** (`content_topics`) is the parent - the idea, its briefing doc, its assets, and the
//     channels it should reach. It is what the weekly draft pipeline writes ten of per person, and
//     what a human reviews before anything is adapted for a channel.
//   • a **piece** (`content_pieces`) is that topic on ONE channel, with the publishing lifecycle.
//
// Content used to hang off `initiatives` (kind: 'content'), which was wrong in both directions: a
// content idea is not a body of work the company plans around, and thirty AI-written ideas a week
// would bury the product and company initiatives it shared a board with. The planning layer no
// longer knows about content at all.
//
// Structured state lives in the warehouse; the markdown stays on disk (a piece's `body_path`, a
// topic's `doc_path`). See features/content/SPEC.md.

import { PLANNING_STATUSES, type PlanningStatus } from '../planning/types.js'

/**
 * The author sentinel meaning "the company page, not a person".
 *
 * `metadata.author` on a piece, and the `@<author>` half of a voice-overlay filename, are normally
 * a `users.id`. This one value is not: it selects the organisation's own identity - the LinkedIn
 * org URN rather than a member's, and `voice/<channel>@company.md` rather than someone's overlay.
 * It is a reserved id, so a Box must not create a user called `company`.
 */
export const COMPANY_AUTHOR = 'company'

/**
 * Lifecycle of a content piece:
 *   draft → approved [→ scheduled] → published   (+ archived)
 *
 * **Four stages and an exit, since 2026-08-13** (migration `011`). It was eight, and half of them
 * held nothing: measured on production the day they were cut, `review`, `changes_requested`,
 * `scheduled` and `archived` had ZERO pieces between them, and across ~100 recorded transitions the
 * spine was draft → verified → approved → published. Three merges, all product decisions:
 *
 *   • `review` folded into **`draft`**. "Ready for a human read" is a fact about a draft, not a state
 *     of its own, and `verified → review` was firing as an ad-hoc "let me look at this again".
 *   • `verified` folded into **`approved`**. The gate's verdict lives on the piece (`verify`), and
 *     since findings are ticked off one by one before Approve enables, a separate status saying
 *     "checked but not signed off" was recording what the verdict already said.
 *   • `changes_requested` **removed entirely**, as a status and as a review decision. Sending a piece
 *     back is `reopen` - it is a draft again, which is the whole of what that status meant.
 *
 * A happy side-effect: `review` the STATUS no longer collides with `review` the FIELD (the human
 * decision record), a name clash that had been flagged as needing one of the two renamed.
 *
 * `approved` is a human SIGN-OFF and nothing more: it arms no publisher and sends nothing. The only
 * armed state is `scheduled`, which always carries an explicit `scheduled_at` - so a piece can never
 * be queued for a real send without a visible time attached to it (see isPublishDue). Changed
 * 2026-07-30: `approved` used to mean "any publisher may send this at will", which made picking
 * "Approved" in a dropdown post publicly within 5 minutes on LinkedIn. Statuses are reached through
 * named transitions (transitions.ts), not by setting a property.
 */
export type ContentStatus = 'draft' | 'approved' | 'scheduled' | 'published' | 'archived'

/** A piece is either the `canonical` source-of-record or a `derived` per-channel adaptation. */
export type ContentKind = 'canonical' | 'derived'

export const CONTENT_STATUSES: ContentStatus[] = ['draft', 'approved', 'scheduled', 'published', 'archived']

/** The lifecycle as a track, for the wizard on a piece's page. `archived` is deliberately absent: it
 *  is an exit from the track, not a step along it, and drawing it as one implies you pass through. */
export const CONTENT_STAGES: ContentStatus[] = ['draft', 'approved', 'scheduled', 'published']

/**
 * Whether a piece is releasable by a publisher RIGHT NOW: `scheduled` with its `scheduled_at` in the
 * past, and nothing else. One rule for every channel - the scheduled auto-publishers filter on this,
 * and the human-triggered publish actions refuse a piece whose scheduled time hasn't arrived.
 *
 * `approved` deliberately does NOT qualify: arming is the `schedule` / `publish-now` transition, which
 * always stamps a time ("publish now" = scheduled_at of now, picked up on the next publisher tick).
 * An operator signing a piece off can therefore never trip a real send by accident.
 */
export function isPublishDue(
  piece: Pick<ContentPiece, 'status' | 'scheduled_at'>,
  now: Date = new Date(),
): boolean {
  if (piece.status !== 'scheduled') return false
  return piece.scheduled_at != null && new Date(piece.scheduled_at).getTime() <= now.getTime()
}
export const CONTENT_KINDS: ContentKind[] = ['canonical', 'derived']

/**
 * The status machine, enforced by upsertContent (2026-07-19 - previously a docs-only convention).
 * The workshop (`draft`/`archived`) moves freely within itself - drafting is iterative, and any state
 * can archive. The gated tail is protected in code:
 *   • `published` requires an armed piece (or `approved`, for record-only paths like a
 *     manual post recorded after the fact) AND a published_url;
 *   • a `published` piece only moves to `archived` - no silent un-publish.
 * Scripts can bypass with ContentInput.force (not exposed over tRPC/MCP).
 *
 * **`approved` is reachable from the workshop since 2026-08-13.** It used to require `verified`, so
 * that "the auto-publisher can never pick up an unverified piece" - but that was never the guarantee
 * it read as: `accept-unverified` let anyone stamp `verified` without a check, so the rule bought a
 * waiver record rather than a real gate. With the waiver dropped, approving IS the human sign-off and
 * it is the honest place for the decision. The guarantee that actually matters is untouched: `scheduled`
 * remains the ONLY armed state and always carries a visible `scheduled_at` (see isPublishDue), so
 * nothing goes out without somebody putting a time on it.
 */
const WORKSHOP_STATUSES: ContentStatus[] = ['draft', 'archived']
export function allowedContentTransitions(from: ContentStatus): ContentStatus[] {
  if (from === 'published') return ['published', 'archived']
  if (from === 'approved' || from === 'scheduled') {
    return [...WORKSHOP_STATUSES, 'approved', 'scheduled', 'published']
  }
  // From the workshop: sign-off is reachable, arming is not. `scheduled` has to be entered through
  // `schedule`/`publish-now` off an approved piece, so nothing can be queued for a send in one hop.
  return [...WORKSHOP_STATUSES, 'approved']
}

/** The channels a piece can target. The blog is the canonical; the rest adapt from it.
 * `linkedin-article` is a LinkedIn NEWSLETTER article (long-form, e.g. Dan's Atomic Insights) -
 * a separate channel from `linkedin` posts because the format, limits, and publish path all
 * differ (no official API exists for articles; see linkedin-article.ts).
 * `substack` is the newsletter on our own publication - longform like the blog, but it SENDS to a
 * subscriber list, which is why it is its own channel rather than a blog variant (see
 * substack-publish.ts: the email is the irreversible half of publishing). */
export const CONTENT_CHANNELS = ['blog', 'reddit', 'x', 'linkedin', 'linkedin-article', 'hackernews', 'substack'] as const
export type ContentChannel = (typeof CONTENT_CHANNELS)[number]

/** The three lights. Anything else a skill emits is coerced by `normalizeVerify` rather than stored. */
export const VERIFY_SEVERITIES = ['fail', 'warn', 'pass'] as const
export type VerifySeverity = (typeof VERIFY_SEVERITIES)[number]

/** One agent-verify finding (from /verify-content). */
export interface VerifyFinding {
  /** Which lens raised it. */
  lens: 'voice' | 'claims' | 'constraints'
  /** 'fail' blocks; 'warn' is advisory; 'pass' is an informational note. */
  severity: VerifySeverity
  message: string
  /**
   * Whether a human has ticked this finding off. **A piece cannot be approved until every finding is
   * ticked**, which is what makes the gate a thing somebody read rather than a thing somebody
   * dismissed. `pass` findings arrive already ticked - there is nothing to decide about a note.
   *
   * Identity is POSITIONAL, on purpose: the flag lives on the finding inside the stored verdict, so a
   * re-verify replaces the array and every tick resets with it. That is the correct behaviour, not a
   * limitation - findings regenerated against an edited draft are new findings, and inheriting an old
   * approval would be exactly the silent mis-accept that kept this feature unbuilt (BACKLOG).
   */
  approved?: boolean
}

/**
 * Coerce a stored verdict into the shape the app guarantees. Two jobs, both idempotent:
 *
 * 1. **Severity is closed, and anything else is DROPPED.** Production carried 8 findings at
 *    `severity: 'info'` - a value no skill documents and nothing validated (the DTO typed it as a bare
 *    string), so they rendered green for months by falling through a ternary. A finding the app cannot
 *    colour, count or tick off is not a finding it can show honestly, and re-badging one into a level
 *    its author did not choose would be inventing a verdict. So it goes (a product decision, 2026-08-13). New
 *    writes never reach this path: `content-verify` refuses an unknown severity outright.
 * 2. **`approved` has a default.** A `pass` starts ticked, everything else starts unticked, so a
 *    verdict written before findings could be ticked reads correctly without a backfill.
 */
export function normalizeVerify(verify: ContentVerify | null | undefined): ContentVerify | null {
  if (!verify) return null
  // Rebuilt from named keys rather than spread, so a field the verdict no longer has cannot ride
  // along: `{waived, by, note}` is still sitting in one stored row and would otherwise keep being
  // served to every client as JSON the types swear does not exist.
  return {
    passed: verify.passed,
    checkedAt: verify.checkedAt,
    findings: (Array.isArray(verify.findings) ? verify.findings : [])
      .filter((f) => (VERIFY_SEVERITIES as readonly string[]).includes(f.severity))
      .map((f) => ({
        lens: f.lens,
        severity: f.severity,
        message: f.message,
        approved: f.approved ?? f.severity === 'pass',
      })),
  }
}

/**
 * The last agent-verify verdict recorded on a piece.
 *
 * **The waiver is gone (2026-08-13, a product decision).** For one day this could also hold `{waived, by, note}` -
 * the record of a human clearing a piece without running the gate, written by an `accept-unverified`
 * transition. Both are removed: approving is approving, and the gate is advice a human accepts finding
 * by finding (`VerifyFinding.approved`) rather than a wall with a door beside it. One historical row
 * carried a waiver (`dad-mode-two-buttons/linkedin`, published); it reads as an ordinary verdict now.
 */
export interface ContentVerify {
  passed: boolean
  findings: VerifyFinding[]
  /** ISO timestamp the verdict was produced. */
  checkedAt: string
}

/**
 * The last HUMAN sign-off on a piece - the counterpart to `verify` (the agent's verdict). Written by
 * `approve`, cleared by `reopen`, so it always describes the CURRENT approval rather than a stale one.
 *
 * `decision` had a second member, `changes_requested`, removed with that status on 2026-08-13. It is
 * kept as a one-member union rather than dropped because the field is what carries WHO signed off and
 * when - `updated_by` only says who touched the row last - and because a second decision (a rejection
 * that is more than "back to draft") is the obvious thing to add here if one is ever wanted.
 */
export interface ContentReview {
  decision: 'approved'
  /** Why it is signed off. Optional on approve, so usually empty. */
  note: string
  /** users.id of the reviewer. */
  by: string
  /** ISO timestamp of the decision. */
  at: string
}

/** How an asset is used by the piece. `feature` is the hero/OG image; `inline` sits in the body. */
export const ASSET_USAGES = ['feature', 'inline', 'social', 'attachment'] as const
export type AssetUsage = (typeof ASSET_USAGES)[number]

/**
 * A local media file attached to a piece via `metadata.assets` (an array of these). The file lives in
 * the topic's docs/content/<topic>/ folder - one physical file, shared by every channel piece that
 * references it - and is served to the dashboard by GET /api/content/asset/….
 */
export interface ContentAsset {
  /** Filename inside the initiative folder (e.g. `teaser.png`). */
  path: string
  usage: AssetUsage
  /** Alt text / caption, used when publishing channels that support it. */
  alt?: string
}

/** Parse `metadata.assets` defensively (metadata is a free-form JSON bag). */
export function pieceAssets(metadata: Record<string, unknown>): ContentAsset[] {
  const raw = metadata.assets
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (a): a is ContentAsset =>
      typeof a === 'object' && a !== null &&
      typeof (a as ContentAsset).path === 'string' &&
      typeof (a as ContentAsset).usage === 'string',
  )
}

/**
 * A topic's lifecycle, and it is deliberately the SAME five words the planning layer uses - imported
 * rather than re-declared, because "a per-side need is a new member of the ONE list, never a second
 * list" (the 2026-08-11 consolidation). Content no longer belongs to planning, but a shared
 * VOCABULARY is not a coupling: nothing here reads or writes an initiative.
 *
 * It is also the review gate the draft pipeline needs, expressed in words that already existed:
 *   • `planned` - an idea somebody (usually the pipeline) wrote down. Nothing is generated from it.
 *   • `active`  - reviewed and approved: this one gets adapted for its target channels.
 *   • `dropped` - reviewed and killed. Kept, not deleted, so the pipeline can see what was rejected.
 *   • `blocked` - waiting on something (a number, a launch date, a legal read).
 *   • `done`    - every piece it wanted has published.
 */
export const TOPIC_STATUSES = PLANNING_STATUSES
export type TopicStatus = PlanningStatus

/** The parent object: an idea, its brief, and the channels it should reach. */
export interface ContentTopic {
  /** Slug (e.g. `claude-max-5x-vs-20x`) - the namespace every piece of it is filed under. */
  id: string
  title: string
  /** One or two sentences: what this is and why it is worth posting. The full argument, the claims
   *  ledger and the research live in the markdown doc. */
  brief: string
  status: TopicStatus
  /** users.id responsible for it - whose voice the pieces will speak in by default. */
  owner: string | null
  /** Which channels this topic should become. The review gate's other half: approving a topic says
   *  "yes, and on these channels". A piece can still be created for a channel that is not listed -
   *  this is an intent, not a permission. */
  target_channels: ContentChannel[]
  /** Instance-relative markdown path (`docs/content/<id>/topic.md`) - the briefing doc. */
  doc_path: string | null
  /** Signals this topic is meant to move. Carried over from the content initiatives it replaced,
   *  which is where the launch-era bindings (reddit.top_post_score, npm.pkg.keybridge…) came from. */
  signal_ids: string[]
  tags: string[]
  /** Target publish date (YYYY-MM-DD), or null. */
  due_date: string | null
  sort: number
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

/** Partial upsert input - `id` identifies the row; provided fields overwrite, the rest persist. */
export interface ContentTopicInput {
  id: string
  title?: string
  brief?: string
  status?: TopicStatus
  owner?: string | null
  target_channels?: ContentChannel[]
  doc_path?: string | null
  signal_ids?: string[]
  tags?: string[]
  due_date?: string | null
  sort?: number
  actor?: string
}

export interface ContentPiece {
  /** Slug path `<topic>/<channel>` (e.g. `claude-max-5x-vs-20x/reddit`). */
  id: string
  topic_id: string
  channel: ContentChannel
  kind: ContentKind
  /** The canonical piece a derived one adapts from (id), if any. */
  source_id: string | null
  status: ContentStatus
  /** Display title / X first-post hook. */
  title: string
  /** Repo-relative markdown path holding the narrative. */
  body_path: string | null
  /** Last agent-verify verdict, or null if never run. */
  verify: ContentVerify | null
  /** Last human review decision (`approved`, the only member since 2026-08-13), or null if never reviewed. */
  review: ContentReview | null
  /** Per-channel bag: subreddit, flair, thread split… */
  metadata: Record<string, unknown>
  /** When a `scheduled` piece should go out (ISO timestamp). Publishers hold the piece until then. */
  scheduled_at: string | null
  published_at: string | null
  published_url: string | null
  /** users.id that published the piece (stamped by content-publish). Null on legacy rows - readers
   *  fall back to the channel's default account owner (config/accounts.json). */
  published_by: string | null
  created_at: string
  updated_at: string
  /** users.id that created / last edited the row via the dashboard; null for agent/MCP writes. */
  created_by: string | null
  updated_by: string | null
}

/** Partial upsert input - `id` identifies the row; provided fields overwrite, the rest persist. */
export interface ContentInput {
  id: string
  topic_id?: string
  channel?: ContentChannel
  kind?: ContentKind
  source_id?: string | null
  status?: ContentStatus
  title?: string
  body_path?: string | null
  verify?: ContentVerify | null
  review?: ContentReview | null
  metadata?: Record<string, unknown>
  /** ISO timestamp gating a `scheduled` piece; null clears it. Required when status is `scheduled`. */
  scheduled_at?: string | null
  /** Explicit publish details (set by content-publish); else managed from `status`. */
  published_at?: string | null
  published_url?: string | null
  published_by?: string | null
  /** users.id performing this mutation (stamps created_by on insert, updated_by always). */
  actor?: string
  /** Bypass the status-transition gate (allowedContentTransitions). For internal scripts and
   *  backfills only - deliberately NOT exposed through the tRPC/MCP DTOs. */
  force?: boolean
}
