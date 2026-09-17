// Mirror of the server's pods domain (src/core/pods/types.ts). The tRPC router reflects nested DTO
// arrays as `unknown`, so usePodsData casts the wire shape to these - same pattern as
// engagement-types.ts / content-types.ts.

import type { EngagementAction, EngagementEvidence } from './engagement-types.ts'

export type { EngagementAction, EngagementEvidence }

export type ParticipantKind = 'user'
export type PodStatus = 'active' | 'paused' | 'archived'
export type UserStatus = 'invited' | 'active' | 'revoked'
export type PodMemberRole = 'admin' | 'member'
export type PodContentSource = 'team'
export type PodEngagementStatus = 'verified' | 'dismissed' | 'draft'

export interface EngagementAdvice {
  /** Single extra expected action (legacy shape; `actions` wins when both are set). */
  action?: EngagementAction
  /** Extra expected actions ADDED on top of the channel default (which always applies). */
  actions?: EngagementAction[]
  hint?: string
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

export interface PodMember {
  pod_id: string
  participant_kind: ParticipantKind
  participant_id: string
  role: PodMemberRole
  joined_at: string
  created_by: string | null
}

export interface PodContent {
  id: string
  pod_id: string
  source: PodContentSource
  content_id: string | null
  /** content_topics.id of the team piece's main post (post-grouping key); null for submissions. */
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

export interface PodCard {
  pod_id: string
  pod_content_id: string
  participant_kind: ParticipantKind
  participant_id: string
  channel: string
  title: string
  url: string
  published_at: string | null
  author_kind: ParticipantKind | null
  author_id: string | null
  /** ALL expected actions (e.g. linkedin → react + comment); the card asks for every one. */
  actions: EngagementAction[]
  /** The subset already completed (verified/dismissed) - the card clears when nothing remains. */
  done_actions: EngagementAction[]
  advice: EngagementAdvice | null
  /** THIS participant's saved comment draft (their `draft` engagement row), if any. */
  draft_comment: string | null
  days_left: number
}

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

export interface KarmaRow {
  participant_kind: ParticipantKind
  participant_id: string
  label: string
  pod_id: string | null
  /** GIVEN - contributed by engaging others' content. */
  given: number
  /** RECEIVED - what their own content earned from others. */
  received: number
}

/** The full internal picture returned by `podsOverview`. */
export interface PodsOverview {
  /** config/pods.json autoContent - null when not configured; enabled=false means paused. */
  autoContent: { pod: string; channels: string[]; enabled: boolean } | null
  pods: Pod[]
  members: PodMember[]
  content: PodContent[]
  engagements: PodEngagement[]
  cards: PodCard[]
  karma: KarmaRow[]
}

/** The self-scoped surface returned by `podsSelfOverview`. */
export interface PodsSelfOverview {
  me: { id: string; kind: ParticipantKind; display: string }
  pods: { id: string; title: string; description: string }[]
  cards: PodCard[]
  karma: KarmaRow[]
  leaderboards: Record<string, KarmaRow[]>
}

export const POD_STATUS_META: Record<PodStatus, { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'text-success' },
  paused: { label: 'Paused', tone: 'text-warning' },
  archived: { label: 'Archived', tone: 'text-muted-foreground' },
}

/** @deprecated the user lifecycle meta is core's USER_STATUS_META (user-types.ts). */
export { USER_STATUS_META as COLLAB_STATUS_META } from '../../user-types.ts'

/** A participant's display key (kind + id), for map lookups. */
export const pKey = (kind: ParticipantKind, id: string): string => `${kind}:${id}`
