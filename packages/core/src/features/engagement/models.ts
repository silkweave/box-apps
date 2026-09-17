// The engagement feature's tables: the tactical inbox (state + drafts) and the pods.

import type { ModelSpec } from '../../warehouse/model.js'
import {
  PARTICIPANT_KINDS,
  POD_CONTENT_SOURCES,
  POD_ENGAGEMENT_STATUSES,
  POD_MEMBER_ROLES,
  POD_STATUSES,
} from './pods/types.js'
import { ENGAGEMENT_ACTIONS } from './verify/types.js'

/** Tactical-inbox done/snoozed state; open items simply have no row. */
export const INBOX_STATE: ModelSpec = {
  table: 'inbox_state',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },
    status: { kind: 'text' },
    done_at: { kind: 'timestamp' },
    note: { kind: 'text', nullable: true },
  },
}

/** One draft reply per inbox item; `author` is the users.id whose voice the draft speaks in. */
export const INBOX_DRAFTS: ModelSpec = {
  table: 'inbox_drafts',
  pk: ['item_id'],
  columns: {
    item_id: { kind: 'text' },
    channel: { kind: 'text' },
    body: { kind: 'text' },
    author: { kind: 'text', nullable: true },
  },
  timestamps: true,
  audit: true,
}

export const PODS: ModelSpec = {
  table: 'pods',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },
    title: { kind: 'text', default: "''" },
    description: { kind: 'text', default: "''" },
    status: { kind: 'text', default: "'active'", enum: POD_STATUSES },
    owner: { kind: 'text', nullable: true },
    sort: { kind: 'int', default: '0' },
  },
  timestamps: true,
  audit: true,
}

export const POD_MEMBERS: ModelSpec = {
  table: 'pod_members',
  pk: ['pod_id', 'participant_kind', 'participant_id'],
  columns: {
    pod_id: { kind: 'text' },
    participant_kind: { kind: 'text', enum: PARTICIPANT_KINDS },
    participant_id: { kind: 'text' },
    role: { kind: 'text', default: "'member'", enum: POD_MEMBER_ROLES },
    joined_at: { kind: 'timestamp', default: 'now()' },
    created_by: { kind: 'text', nullable: true },
  },
}

export const POD_CONTENT: ModelSpec = {
  table: 'pod_content',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },
    pod_id: { kind: 'text' },
    source: { kind: 'text', default: "'team'", enum: POD_CONTENT_SOURCES },
    content_id: { kind: 'text', nullable: true },
    submitter_kind: { kind: 'text', nullable: true, enum: PARTICIPANT_KINDS },
    submitter_id: { kind: 'text', nullable: true },
    channel: { kind: 'text' },
    url: { kind: 'text' },
    title: { kind: 'text', default: "''" },
    advice: { kind: 'json', nullable: true },
    published_at: { kind: 'timestamp', nullable: true },
  },
  timestamps: true,
  audit: true,
}

export const POD_ENGAGEMENTS: ModelSpec = {
  table: 'pod_engagements',
  pk: ['pod_content_id', 'participant_kind', 'participant_id', 'action'],
  columns: {
    pod_content_id: { kind: 'text' },
    participant_kind: { kind: 'text', enum: PARTICIPANT_KINDS },
    participant_id: { kind: 'text' },
    action: { kind: 'text', enum: ENGAGEMENT_ACTIONS },
    status: { kind: 'text', default: "'verified'", enum: POD_ENGAGEMENT_STATUSES },
    verified_at: { kind: 'timestamp', nullable: true },
    evidence: { kind: 'json', nullable: true },
    karma_awarded: { kind: 'int', default: '0' },
    note: { kind: 'text', nullable: true },
  },
  timestamps: true,
  audit: true,
}

export const ENGAGEMENT_MODELS: readonly ModelSpec[] = [INBOX_STATE, INBOX_DRAFTS, PODS, POD_MEMBERS, POD_CONTENT, POD_ENGAGEMENTS]
