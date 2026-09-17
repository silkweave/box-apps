// Mirror of the server's content domain (src/core/content/types.ts + profiles.ts). The tRPC router
// reflects nested DTO arrays/objects as `unknown`, so useContentData casts the wire shape to these -
// same pattern the planning/inbox views use.

// A topic's status is deliberately the planning VOCABULARY (one list, imported rather than
// re-declared) even though content is no longer part of the planning layer - see core's
// content/types.ts for the argument.
import type { PlanningStatus } from '../planning/planning-types.ts'

export type ContentStatus = 'draft' | 'approved' | 'scheduled' | 'published' | 'archived'

export type ContentKind = 'canonical' | 'derived'
export type ContentChannel = 'blog' | 'reddit' | 'x' | 'linkedin' | 'linkedin-article' | 'hackernews' | 'substack'

/** Every channel, in the order a topic's channel picker offers them (canonical first). */
export const CONTENT_CHANNELS: ContentChannel[] = ['blog', 'substack', 'linkedin', 'linkedin-article', 'reddit', 'x', 'hackernews']

export const CONTENT_STATUSES: ContentStatus[] = ['draft', 'approved', 'scheduled', 'published', 'archived']

/** The lifecycle as a track, for the wizard on a piece's page. `archived` is deliberately absent - it
 *  is an exit from the track, not a step along it (mirror of core's CONTENT_STAGES). */
export const CONTENT_STAGES: ContentStatus[] = ['draft', 'approved', 'scheduled', 'published']

export interface VerifyFinding {
  lens: 'voice' | 'claims' | 'constraints'
  severity: 'fail' | 'warn' | 'pass'
  message: string
  /** Ticked off by a human. Approve stays disabled until every finding is ticked; a `pass` arrives
   *  already ticked. Identity is positional, so a re-verify resets every tick with the array. */
  approved?: boolean
}

/** The gate's verdict. The waiver (`{waived, by, note}`) was removed 2026-08-13 along with the
 *  `accept-unverified` transition: approving is approving, and the gate is advice a human accepts
 *  finding by finding (`VerifyFinding.approved`) rather than a wall with a door beside it. */
export interface ContentVerify {
  passed: boolean
  findings: VerifyFinding[]
  checkedAt: string
}

/** The last HUMAN decision on a piece - the counterpart to `verify` (the agent's verdict). */
export interface ContentReview {
  decision: 'approved'
  note: string
  /** users.id of the reviewer. */
  by: string
  at: string
}

/**
 * The lifecycle moves a piece can make, named as ACTIONS (mirror of core/content/transitions.ts).
 * The dashboard never sets a status directly - it fires one of these, and the server decides.
 */
export type ContentTransitionId =
  | 'verify'
  | 'approve'
  | 'schedule'
  | 'unschedule'
  | 'publish-now'
  | 'record-published'
  | 'reopen'
  | 'archive'

/** Server-shipped catalogue entry for a transition: label + the copy its dialog explains it with. */
export interface ContentTransitionSpec {
  id: ContentTransitionId
  label: string
  intent: string
  target: ContentStatus | null
  input: 'none' | 'note' | 'note?' | 'time' | 'url'
  runner: 'human' | 'agent'
  outward: boolean
  /** Whether to stop and ask before running. Derived by core (`transitionNeedsDialog`): true only for
   *  required input or an outward consequence - everything else is a direct click. */
  needsDialog: boolean
}

/** How an asset is used by the piece. `feature` is the hero/OG image; `inline` sits in the body. */
export const ASSET_USAGES = ['feature', 'inline', 'social', 'attachment'] as const
export type AssetUsage = (typeof ASSET_USAGES)[number]

/** A local media file attached via `metadata.assets` - one physical file in the topic's
 *  docs/content/<topic>/ folder, shared by every channel piece that references it. */
export interface ContentAsset {
  /** Filename inside the topic folder (e.g. `teaser.png`). */
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

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg)$/i
// Only extensions the backend asset route actually streams (ASSET_MIME in packages/core content/docs.ts).
const VIDEO_EXT = /\.mp4$/i

export const isImageAsset = (file: string): boolean => IMAGE_EXT.test(file)
export const isVideoAsset = (file: string): boolean => VIDEO_EXT.test(file)

/** Dashboard URL for an asset file (served by the content controller; single-origin in dev + prod). */
export function assetUrl(topicId: string, file: string): string {
  // Tolerate a stored repo-relative path by keeping only the filename.
  const name = file.split('/').pop() ?? file
  return `/api/content/asset/${encodeURIComponent(topicId)}/${encodeURIComponent(name)}`
}

export interface ContentPiece {
  id: string
  topic_id: string
  channel: ContentChannel
  kind: ContentKind
  source_id: string | null
  status: ContentStatus
  title: string
  body_path: string | null
  verify: ContentVerify | null
  /** Last human sign-off (approve), cleared by reopen. Null if never approved. */
  review: ContentReview | null
  /** Transitions available from this state, most-likely-next first. Computed server-side. */
  transitions: ContentTransitionId[]
  metadata: Record<string, unknown>
  /** When a `scheduled` piece should go out (ISO). Publishers hold the piece until then. */
  scheduled_at: string | null
  published_at: string | null
  published_url: string | null
  /** users.id that published the piece (stamped by the gated publish); null on legacy rows. */
  published_by: string | null
  created_at: string
  updated_at: string
  /** users.id that created / last edited the row via the dashboard; null for agent/MCP writes. */
  created_by: string | null
  updated_by: string | null
}

/** Per-channel content profile (mirror of src/core/content/profiles.ts). */
export interface ChannelProfile {
  channel: ContentChannel
  label: string
  bodyKind: 'longform' | 'medium' | 'thread' | 'short'
  limits: {
    perUnitChars?: number
    titleChars?: number
    units?: [number, number]
    unitKind?: 'words' | 'posts' | 'chars'
  }
  voiceNotes: string
  requires: string[]
  recommends?: string[]
  publish: {
    mode: 'workflow' | 'exploration' | 'manual'
    tool?: string
    costNote?: string
    gated: true
    /** The channel has a real sender: arming a piece here makes the machine post it for you. */
    auto: boolean
  }
}

/** Display label + semantic tone per status (tone maps to a Badge variant / Tailwind color). */
export const CONTENT_STATUS_META: Record<
  ContentStatus,
  { label: string; tone: 'accent' | 'success' | 'danger' | 'warning' | 'info' | 'neutral' }
> = {
  draft: { label: 'Draft', tone: 'neutral' },
  approved: { label: 'Approved', tone: 'accent' },
  scheduled: { label: 'Scheduled', tone: 'info' },
  published: { label: 'Published', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
}

/** What a status MEANS, in the operator's terms - shown under the status badge on a piece. The
 *  answer to "if I put it here, does something get sent?" is the first thing each line settles. */
export const CONTENT_STATUS_BLURB: Record<ContentStatus, string> = {
  draft: 'Being written, and read by the gate. Nothing leaves this room.',
  approved: 'Signed off and holding. Nothing goes out until you schedule or publish it.',
  scheduled: 'Armed. This is the only state a publisher acts on.',
  published: 'Live on the channel.',
  archived: 'Filed away, out of the pipeline.',
}

/** The PARENT content object: an idea, its brief, and the channels it should reach. Mirrors core's
 *  ContentTopic (warehouse/models.ts CONTENT_TOPICS) - see the note at the top of this file about
 *  why the web app keeps hand-written mirrors of the wire types. */
export interface ContentTopic {
  id: string
  title: string
  brief: string
  /** The review gate: planned = an idea nobody has ruled on, active = approved, dropped = killed. */
  status: PlanningStatus
  owner: string | null
  target_channels: ContentChannel[]
  doc_path: string | null
  signal_ids: string[]
  tags: string[]
  due_date: string | null
  sort: number
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

/** Fields the dashboard may write on a topic. The two list fields travel comma-separated, matching
 *  the MCP scalar-input constraint the server DTO documents. */
export interface ContentTopicUpsert {
  id: string
  title?: string
  brief?: string
  status?: PlanningStatus
  owner?: string
  target_channels?: string
  signal_ids?: string
  tags?: string
  due_date?: string
}
