// The content lifecycle as a PROCESS, not a property. Each move a piece can make is a NAMED
// transition with its own preconditions, its own required input, and its own consequence - so the
// operator picks "Publish now" or "Back to draft", never "set status = approved" and hopes.
//
// Why this exists (2026-07-30): the dashboard used to expose the lifecycle as a status dropdown.
// Picking `approved` there armed `linkedin-publish-approved` (cron, every 5 min, LIVE), i.e. a
// harmless-looking property change posted publicly within minutes. Dan put it exactly right - "I
// don't want to change the status to approved because I assume then it will be sent out". Two rules
// come out of that and are enforced here:
//
//   1. `approved` is a SIGN-OFF and nothing more. It arms nothing. The only armed state is
//      `scheduled`, which always carries an explicit `scheduled_at` (see isPublishDue), so a piece
//      can never be queued for a real send without a visible time on it.
//   1b. The gate is ADVICE a human accepts, not a wall (2026-08-13). `verify` runs in a Claude Code
//      session, so a piece nobody wanted to spend model time on used to have no way forward at all.
//      For one day the answer was `accept-unverified`, a second button recording a waiver; it is gone.
//      The answer now is that `approve` is available from the workshop and the findings themselves
//      carry the decision - every one has to be ticked before Approve enables (VerifyFinding.approved).
//      So the gate is read rather than dismissed, and there is one sign-off instead of two.
//
//   2. Whether a transition SENDS depends on the channel, and the channel says so itself
//      (`profile.publish.auto`). On LinkedIn "Publish now" hands the piece to a real publisher; on
//      Reddit nothing is ever sent from here, so the equivalent action is "Record published" and it
//      demands the URL of the post you made yourself.
//
// availableTransitions() is the single source of truth for what a piece can do next: the server
// computes it per piece and ships it with the row, so the dashboard renders buttons rather than
// re-deriving the machine (which is how the old dropdown drifted from the server's rules).

import { channelProfile, type ChannelContentProfile } from './profiles.js'
import { readContentPiece, upsertContent } from './state.js'
import type { ContentPiece, ContentStatus } from './types.js'

export type ContentTransitionId =
  | 'verify'
  | 'approve'
  | 'schedule'
  | 'unschedule'
  | 'publish-now'
  | 'record-published'
  | 'reopen'
  | 'archive'

/** The extra input a transition demands before it can run. `note?` is an optional note. */
export type ContentTransitionInputKind = 'none' | 'note' | 'note?' | 'time' | 'url'

export interface ContentTransitionSpec {
  id: ContentTransitionId
  /** Button text: a verb, naming what the operator is doing. */
  label: string
  /** One line of what actually happens, for the confirm dialog. Channel-specific detail is added by
   *  the caller (only the channel knows whether "publish" means "send" or "record"). */
  intent: string
  /** The status the piece lands in. Null for `verify`, whose target depends on the verdict. */
  target: ContentStatus | null
  input: ContentTransitionInputKind
  /** 'human' → applied by applyContentTransition. 'agent' → handed to a Claude Code session. */
  runner: 'human' | 'agent'
  /** Touches (or records) the outside world - the dashboard confirms these harder. */
  outward: boolean
}

/**
 * Whether the dashboard must stop and ask before running this - **a dialog is for required input or
 * an outward consequence, and nothing else** (a product decision, 2026-08-13).
 *
 * Before this, 7 of the then-11 human transitions opened a dialog that asked for nothing - `approve`,
 * `unschedule`, `reopen`, `archive` and three that have since been removed with the statuses they
 * served. Every one of them is
 * a single field write with a transition that undoes it, so the dialog bought nothing and cost a
 * click → read → click on the most ordinary moves in the lifecycle. Confirming everything is the same
 * as confirming nothing: it teaches people to dismiss the dialog that actually matters, which is the
 * one in front of a real send.
 *
 * Derived rather than declared per entry, so a new transition cannot forget the rule - and so the
 * dashboard reads the answer off the spec instead of re-deriving it (this is the same posture as
 * `availableTransitions`: core owns the machine, the UI owns presentation).
 *
 * Note the cost, which is deliberate: `approve` takes an OPTIONAL note (`note?`) and a direct click has
 * nowhere to type one. It stays reachable over MCP/tRPC.
 */
export function transitionNeedsDialog(spec: ContentTransitionSpec): boolean {
  // 'note?' is deliberately absent: an optional field is not a reason to interrupt anybody.
  return spec.input === 'note' || spec.input === 'time' || spec.input === 'url' || spec.outward
}

export const CONTENT_TRANSITIONS: Record<ContentTransitionId, ContentTransitionSpec> = {
  verify: {
    id: 'verify',
    label: 'Verify',
    intent:
      "Runs the content gate in a Claude Code session: the voice hard-rules, the topic's claims ledger, and this channel's format profile. It records findings for you to work through and never publishes; the piece stays a draft either way.",
    target: null,
    input: 'note?',
    runner: 'agent',
    outward: false,
  },
  approve: {
    id: 'approve',
    label: 'Approve',
    intent:
      'Your sign-off: the piece is good to go. It does NOT send or schedule anything - publishing stays a separate, explicit action.',
    target: 'approved',
    input: 'note?',
    runner: 'human',
    outward: false,
  },
  schedule: {
    id: 'schedule',
    label: 'Schedule',
    intent: 'Sets the date and time the piece goes out.',
    target: 'scheduled',
    input: 'time',
    runner: 'human',
    outward: true,
  },
  unschedule: {
    id: 'unschedule',
    label: 'Unschedule',
    intent: 'Stands the piece down: clears the time and returns it to approved. Nothing goes out.',
    target: 'approved',
    input: 'none',
    runner: 'human',
    outward: false,
  },
  'publish-now': {
    id: 'publish-now',
    label: 'Publish now',
    intent: 'Queues the piece to go out immediately.',
    target: 'scheduled',
    input: 'none',
    runner: 'human',
    outward: true,
  },
  'record-published': {
    id: 'record-published',
    label: 'Record published',
    intent:
      'Records a post you made yourself. Nothing is sent from here - paste the live URL and the piece is marked published, which drives the published signal.',
    target: 'published',
    input: 'url',
    runner: 'human',
    outward: true,
  },
  reopen: {
    id: 'reopen',
    label: 'Back to draft',
    intent: 'Reopens the piece for editing. Clears any schedule.',
    target: 'draft',
    input: 'none',
    runner: 'human',
    outward: false,
  },
  archive: {
    id: 'archive',
    label: 'Archive',
    intent: 'Files the piece away. It leaves the pipeline and stops appearing as open work.',
    target: 'archived',
    input: 'none',
    runner: 'human',
    outward: false,
  },
}

/**
 * What this piece can do next, most-likely-next-step first. The arming action is channel-dependent:
 * a channel with a real sender (`publish.auto`) gets `publish-now`, one without gets
 * `record-published` (which needs the URL of the post the operator made themselves).
 */
export function availableTransitions(
  piece: Pick<ContentPiece, 'status' | 'channel'>,
  profile: ChannelContentProfile | undefined = channelProfile(piece.channel),
): ContentTransitionId[] {
  const auto = profile?.publish.auto ?? false
  const arm: ContentTransitionId = auto ? 'publish-now' : 'record-published'
  switch (piece.status) {
    // `verify` leads in the workshop - the gate is the default path - but `approve` stands beside it
    // rather than behind it. It is not a way AROUND the gate: the dashboard holds the button disabled
    // until every finding on the verdict is ticked, so the shortcut only exists for a piece nobody ran
    // the gate on at all.
    case 'draft':
      return ['verify', 'approve', 'archive']
    case 'approved':
      // `arm` is already `record-published` on a manual channel, so this needs no second entry for
      // one - and must not offer it on an auto channel, where recordContentPublish refuses outright.
      // Re-verifying an approved piece is legitimate: a late edit deserves a fresh read.
      return [arm, 'schedule', 'verify', 'reopen', 'archive']
    case 'scheduled':
      return [arm, 'schedule', 'unschedule', 'reopen', 'archive']
    case 'published':
      return ['archive']
    case 'archived':
      return ['reopen']
  }
}

export interface ContentTransitionRequest {
  /** Piece id (`<initiative>/<channel>`). */
  id: string
  transition: ContentTransitionId
  /** Optional on `approve`. */
  note?: string
  /** Required by `schedule` - ISO timestamp. */
  scheduled_at?: string
  /** Required by `record-published` - the live URL of the post. */
  published_url?: string
  /** users.id performing the transition (audit stamp + review attribution). */
  actor?: string
}

/**
 * Apply a transition. Validates that it is actually available for the piece's current state (so a
 * stale dashboard tab can't fire a move that no longer applies) and that its required input is
 * present, then makes the single write that the transition means. The status machine in
 * upsertContent still has the last word.
 */
export async function applyContentTransition(req: ContentTransitionRequest): Promise<ContentPiece> {
  const spec = CONTENT_TRANSITIONS[req.transition]
  if (!spec) throw new Error(`unknown content transition "${req.transition}"`)
  if (spec.runner === 'agent') {
    throw new Error(`transition "${spec.id}" runs in a Claude Code session (/${spec.id}-content), not here`)
  }
  const piece = await readContentPiece(req.id)
  if (!piece) throw new Error(`no content piece "${req.id}"`)
  const profile = channelProfile(piece.channel)
  if (!availableTransitions(piece, profile).includes(spec.id)) {
    throw new Error(
      `transition "${spec.id}" is not available for "${req.id}" (status: ${piece.status}) - ` +
        `available: ${availableTransitions(piece, profile).join(', ')}`,
    )
  }
  const note = (req.note ?? '').trim()
  if (spec.input === 'note' && !note) throw new Error(`transition "${spec.id}" needs a note saying what to change`)
  const actor = req.actor
  const at = new Date().toISOString()

  switch (spec.id) {
    case 'approve':
      return upsertContent({
        id: req.id,
        status: 'approved',
        review: { decision: 'approved', note, by: actor ?? '', at },
        ...(actor ? { actor } : {}),
      })

    case 'schedule': {
      if (!req.scheduled_at) throw new Error(`transition "schedule" needs a scheduled_at timestamp`)
      const when = new Date(req.scheduled_at)
      if (Number.isNaN(when.getTime())) throw new Error(`transition "schedule": unparseable time "${req.scheduled_at}"`)
      return upsertContent({
        id: req.id,
        status: 'scheduled',
        scheduled_at: when.toISOString(),
        ...(actor ? { actor } : {}),
      })
    }

    case 'unschedule':
      return upsertContent({ id: req.id, status: 'approved', scheduled_at: null, ...(actor ? { actor } : {}) })

    case 'publish-now':
      // Arming for "right now" is a schedule stamped with this instant: the piece stays in the one
      // state that means armed, and the publisher picks it up on its next tick.
      return upsertContent({
        id: req.id,
        status: 'scheduled',
        scheduled_at: at,
        ...(actor ? { actor } : {}),
      })

    case 'record-published': {
      const url = (req.published_url ?? '').trim()
      if (!url) throw new Error(`transition "record-published" needs the live URL of the post`)
      return recordContentPublish({ id: req.id, published_url: url, actor })
    }

    case 'reopen':
      return upsertContent({ id: req.id, status: 'draft', scheduled_at: null, ...(actor ? { actor } : {}) })

    case 'archive':
      return upsertContent({ id: req.id, status: 'archived', ...(actor ? { actor } : {}) })

    default:
      // Only `verify` reaches here, and the runner check above already turned it away.
      throw new Error(`transition "${spec.id}" has no server-side effect`)
  }
}

/**
 * The **record-only** publish: store the URL of a post the operator made themselves and flip the
 * piece to `published` (which feeds the `content.published.*` signal). Nothing is sent. Shared by the
 * `record-published` transition and the `content-publish` tRPC/MCP tool so both obey one rule.
 */
export async function recordContentPublish(input: {
  id: string
  published_url: string
  actor?: string
}): Promise<ContentPiece> {
  const piece = await readContentPiece(input.id)
  if (!piece) throw new Error(`content-publish refused: no piece "${input.id}"`)
  // Recording is an after-the-fact statement about the channel, so any piece that cleared the gate
  // qualifies - including one still armed (e.g. a platform-side scheduler beat us to it).
  if (!['approved', 'scheduled'].includes(piece.status)) {
    throw new Error(
      `content-publish refused: piece "${input.id}" is "${piece.status}", must be "approved" or "scheduled"`,
    )
  }
  // Channel guard: linkedin has a REAL send (linkedin-publish / linkedin-publish-approved) that
  // stamps metadata.post_urn - the per-post analytics join key. Recording a linkedin publish here
  // would leave that urn unstamped and silently skip the send, so refuse (BACKLOG 2026-07-17).
  if (piece.channel === 'linkedin') {
    throw new Error(
      `content-publish refused: linkedin pieces publish via the linkedin-publish action ` +
        `(or the scheduled linkedin-publish-approved), which sends the post and stamps metadata.post_urn`,
    )
  }
  return upsertContent({
    id: input.id,
    status: 'published',
    published_url: input.published_url,
    published_at: new Date().toISOString(),
    published_by: input.actor ?? null,
    ...(input.actor ? { actor: input.actor } : {}),
  })
}
