// The content feature's tables: topics (the idea) and pieces (the idea on one channel).

import type { ModelSpec } from '../../warehouse/model.js'
import { PLANNING_STATUSES } from '../planning/types.js'
import { CONTENT_KINDS, CONTENT_STATUSES } from './types.js'

/** One row per outward-facing piece; id is `<initiative>/<channel>`; body markdown stays on disk. */
/** The PARENT content object (2026-08-12): an idea, its brief, its target channels, its doc. Not an
 *  initiative - see content/types.ts for why content left the planning layer. */
export const CONTENT_TOPICS: ModelSpec = {
  table: 'content_topics',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },
    title: { kind: 'text' },
    brief: { kind: 'text', default: "''" },
    status: { kind: 'text', default: "'planned'", enum: PLANNING_STATUSES },
    owner: { kind: 'text', nullable: true },
    target_channels: { kind: 'json', default: "'[]'" },
    doc_path: { kind: 'text', nullable: true },
    signal_ids: { kind: 'json', default: "'[]'" },
    tags: { kind: 'json', default: "'[]'" },
    due_date: { kind: 'date', nullable: true },
    sort: { kind: 'int', default: '0' },
  },
  timestamps: true,
  audit: true,
}

export const CONTENT_PIECES: ModelSpec = {
  table: 'content_pieces',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },
    topic_id: { kind: 'text' },
    channel: { kind: 'text' },
    kind: { kind: 'text', default: "'derived'", enum: CONTENT_KINDS },
    source_id: { kind: 'text', nullable: true },
    status: { kind: 'text', default: "'draft'", enum: CONTENT_STATUSES },
    title: { kind: 'text', default: "''" },
    body_path: { kind: 'text', nullable: true },
    verify: { kind: 'json', nullable: true },
    review: { kind: 'json', nullable: true },
    metadata: { kind: 'json', default: "'{}'" },
    published_at: { kind: 'timestamp', nullable: true },
    published_url: { kind: 'text', nullable: true },
    published_by: { kind: 'text', nullable: true },
    scheduled_at: { kind: 'timestamp', nullable: true },
  },
  timestamps: true,
  audit: true,
}

export const CONTENT_MODELS: readonly ModelSpec[] = [CONTENT_TOPICS, CONTENT_PIECES]
