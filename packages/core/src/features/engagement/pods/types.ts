// Engagement Pods domain - a cross-promotion network over the `users` directory, organised into
// topic `pods`. A pod's engagement to-do surface is DERIVED
// (pod content × pod members × expected action, minus recorded rows); only completions/dismissals
// persist, in `pod_engagements`. See features/engagement/SPEC.md.

// Reuse the internal module's action + evidence vocabularies so the two can converge later. These
// are re-exported through the core barrel from verify/types.js already - import, don't re-export.
import type { EngagementAction, EngagementEvidence } from '../verify/types.js'
export type { EngagementAction, EngagementEvidence }

/** A participant is a `users.id`. This was a discriminator over internal users vs external
 *  collaborators until 2026-09-10; collaborators are gone and only `user` remains. The COLUMN stays
 *  because it is part of the composite primary key of `pod_members`, `pod_engagements` and
 *  `pod_content` - narrowing the type is free, rewriting three primary keys is not. */
export type ParticipantKind = 'user'
export const PARTICIPANT_KINDS: ParticipantKind[] = ['user']

/** A verified engagement, a deliberate dismissal, or a saved comment DRAFT. Only `verified` awards
 *  karma; only `verified`/`dismissed` clear the card - a `draft` row keeps the card in the queue
 *  and carries the participant's own pre-written comment (evidence.comment_text, saved by the
 *  /engage skill) until they post it and verify. */
export type PodEngagementStatus = 'verified' | 'dismissed' | 'draft'
export const POD_ENGAGEMENT_STATUSES: PodEngagementStatus[] = ['verified', 'dismissed', 'draft']

export type PodStatus = 'active' | 'paused' | 'archived'
export const POD_STATUSES: PodStatus[] = ['active', 'paused', 'archived']

export type PodMemberRole = 'admin' | 'member'
export const POD_MEMBER_ROLES: PodMemberRole[] = ['admin', 'member']

/** Where a pod card's piece came from. `collaborator` retired with them on 2026-09-10; the column
 *  stays for the same primary-key reason as ParticipantKind. */
export type PodContentSource = 'team'
export const POD_CONTENT_SOURCES: PodContentSource[] = ['team']

/** Procured per-piece engagement guidance shown to members (e.g. X → "like + repost"). */
export interface EngagementAdvice {
  /** Single extra expected action (legacy shape; `actions` wins when both are set). */
  action?: EngagementAction
  /** Extra expected actions ADDED on top of the channel default (which always applies). */
  actions?: EngagementAction[]
  /** Short human hint ("Like and repost this"). */
  hint?: string
  /** A pre-drafted comment members can copy (linkedin/reddit comment actions). */
  draft_comment?: string
}

export interface Pod {
  id: string
  title: string
  description: string
  status: PodStatus
  owner: string | null
  sort: number
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface PodInput {
  id: string
  title?: string
  description?: string
  status?: PodStatus
  owner?: string | null
  sort?: number
  actor?: string
}

export interface PodMember {
  pod_id: string
  participant_kind: ParticipantKind
  participant_id: string
  role: PodMemberRole
  joined_at: string
  created_by: string | null
}

export interface PodMemberInput {
  pod_id: string
  participant_kind: ParticipantKind
  participant_id: string
  role?: PodMemberRole
  actor?: string
}

export interface PodContent {
  id: string
  pod_id: string
  source: PodContentSource
  /** content.id when source='team'; null for collaborator submissions. */
  content_id: string | null
  /** content_topics.id of the team piece's main post (resolved from content_id); null for submissions. */
  topic_id: string | null
  submitter_kind: ParticipantKind | null
  submitter_id: string | null
  channel: string
  url: string
  title: string
  advice: EngagementAdvice | null
  published_at: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface PodContentInput {
  /** Omit to mint a slug. */
  id?: string
  pod_id: string
  source?: PodContentSource
  content_id?: string | null
  submitter_kind?: ParticipantKind | null
  submitter_id?: string | null
  channel: string
  url: string
  title?: string
  advice?: EngagementAdvice | null
  published_at?: string | null
  actor?: string
}

/** One persisted engagement (or dismissal). PK (pod_content_id, participant_kind, participant_id, action). */
export interface PodEngagement {
  pod_content_id: string
  participant_kind: ParticipantKind
  participant_id: string
  action: EngagementAction
  status: PodEngagementStatus
  verified_at: string | null
  evidence: EngagementEvidence | null
  karma_awarded: number
  note: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface PodEngagementInput {
  pod_content_id: string
  participant_kind: ParticipantKind
  participant_id: string
  action: EngagementAction
  status?: PodEngagementStatus
  evidence?: EngagementEvidence | null
  note?: string | null
  actor?: string
}

/** One derived to-do: "participant P should <action> pod-piece Y". Never stored - computed on read. */
export interface PodCard {
  pod_id: string
  pod_content_id: string
  participant_kind: ParticipantKind
  participant_id: string
  channel: string
  title: string
  url: string
  published_at: string | null
  /** The piece's author/submitter (excluded from engaging their own piece). */
  author_kind: ParticipantKind | null
  author_id: string | null
  /** ALL expected actions for this piece (channel default, or the advice override) - a card asks
   *  for every one of them (e.g. linkedin → react + comment). */
  actions: EngagementAction[]
  /** The subset of `actions` this participant has already completed (verified or dismissed) -
   *  the card clears only when nothing remains. */
  done_actions: EngagementAction[]
  advice: EngagementAdvice | null
  /** THIS participant's saved comment draft (their `draft` engagement row), if any. */
  draft_comment: string | null
  /** Whole days until the card ages out of the recency window (>= 0). */
  days_left: number
}

/** Aggregated karma for one participant, split by direction. */
export interface KarmaRow {
  participant_kind: ParticipantKind
  participant_id: string
  /** users.id or collaborators.id display name/handle, resolved for the UI. */
  label: string
  pod_id: string | null
  /** GIVEN - contributed by engaging OTHERS' content (sum of their own verified karma_awarded). */
  given: number
  /** RECEIVED - what their OWN submissions earned from others' verified engagements. */
  received: number
}

/** Shape of config/pods.json. */
export interface PodsConfigFile {
  windowDays: number
  /** Base channel → the ALWAYS-expected action(s) (`actions` list wins over the legacy single
   *  `action`). A piece's advice ADDS extras on top; it never suppresses the base. */
  channels: Record<string, { action?: EngagementAction; actions?: EngagementAction[] }>
  /** Flat karma points per action, credited at verify time. */
  karma: Record<EngagementAction, number>
  /** When set, every content piece that flips to `published` on one of these channels is pushed
   *  into this pod automatically (source 'team', submitter = published_by). Null disables it;
   *  `enabled: false` pauses it without losing the pod/channel config (Settings → Pods toggle). */
  autoContent: { pod: string; channels: string[]; enabled?: boolean } | null
}
