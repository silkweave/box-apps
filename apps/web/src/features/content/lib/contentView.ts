// The Content board's view model: which posts show, how they group and sort, which optional columns
// render, and whether the board is a list or a status board. The third module to get one, and the
// first that had to answer a question the other two did not: what IS a row here?
//
// A ROW IS A POST, ITS PIECES NESTED (a product decision, 2026-08-12). Content has two nouns - a post (an
// initiative: "the claude-worker showcase") and a piece (that post adapted to one channel). Making
// the piece the row would have been the closer mirror of the CRM, and it is wrong: nobody plans one
// LinkedIn adaptation, they plan a post and then chase its channels. So the list nests exactly the
// way Initiatives nests tasks under an initiative, and the board's columns hold posts.
//
// FILTERS SELECT PIECES; GROUPING AND SORTING ORDER POSTS. A post survives a filter when at least one
// of its pieces does, and the nested rows then show only the pieces that matched - so "everything in
// draft" answers with the posts that have something in draft, opened to exactly those channels.
// The alternative (filter posts wholesale) would show a post in draft with its published pieces
// listed underneath, which is the question nobody asked.
//
// A post has no status of its own: it takes the LOWEST status of its live pieces (`lowestStatus`),
// the same rule the sidebar and the old card grid already used. Archived pieces sit outside the
// lifecycle and do not drag the status down unless every piece is archived.
//
// State persists under `<APP_STORAGE_PREFIX>.content.*` (boardView.ts + usePersistedState),
// keyed through `appKey()` - see lib/storage.ts.

import { KanbanSquare, List } from 'lucide-react'
import type { ViewBarSpec } from '../../data/components/board/ViewBar.tsx'
import { CHANNEL_UI, CONTENT_STATUS_RANK, lowestStatus } from '../components/contentMeta.tsx'
import type { PlanningStatus } from '../../planning/planning-types.ts'
import {
  CONTENT_STATUSES,
  type ContentChannel,
  type ContentKind,
  type ContentPiece,
  type ContentStatus,
  type ContentTopic,
  type VerifyFinding,
} from '../content-types.ts'
import {
  activeFilterCountOf,
  compareKeys,
  isStringArray,
  normalizeFilters,
  pickEnum,
  pickSortDir,
  sameFilters,
  sameOrder,
  type BaseViewState,
  type BoardLayout,
  type SortDir,
  type SortKey,
} from '../../data/lib/boardView.ts'
import {
  aggregateSources,
  buildGrid,
  orderColumns,
  type Aggregatable,
  type AggregateSources,
  type ColumnWidths,
  type GridLayout,
  type GridSpec,
} from '../../../lib/gridColumns.ts'

/** Statuses a piece does not come back from on its own - the counterpart of the CRM's terminal set.
 *  `archived` is the only one: `published` is an end state but a published post is still live work
 *  (it gets edited, re-shared, measured). */
export const CONTENT_TERMINAL_STATUSES: ContentStatus[] = ['archived']

/** The columns a status board shows when the view names no statuses of its own: the lifecycle a post
 *  is actually moved through. Archived is reachable by filtering for it. */
export const CONTENT_BOARD_COLUMNS: ContentStatus[] = ['draft', 'approved', 'scheduled', 'published']

// --- the verify axis ------------------------------------------------------------------------------

/**
 * The agent's verdict, collapsed into chips. `verify` is an object or null, which is not chip-shaped,
 * but the question people ask of it is: has this been checked, and did it pass? "Not checked" and
 * "checked and failed" are the two that matter and they are nothing alike.
 */
export type VerifyBucket = 'passed' | 'failed' | 'unchecked'
export const VERIFY_BUCKETS: VerifyBucket[] = ['passed', 'failed', 'unchecked']
export const VERIFY_BUCKET_LABEL: Record<VerifyBucket, string> = {
  passed: 'Verified',
  failed: 'Has findings',
  unchecked: 'Not checked',
}
/** A fourth bucket, `waived`, existed for one day (2026-08-12/13) to keep "accepted without the gate"
 *  answerable. It went with the waiver: there is no longer a way to stamp `verified` without running
 *  the gate, so "checked" and "not checked" is the whole of the question again. */
export const verifyBucket = (p: ContentPiece): VerifyBucket =>
  !p.verify ? 'unchecked' : p.verify.passed ? 'passed' : 'failed'

/**
 * The traffic light. A finding's `severity` already says how much it matters; what was missing was
 * anywhere that DREW the difference - every surface toned `fail` amber, so a blocking failure looked
 * exactly like an advisory warning and nothing in the app was ever red (fixed 2026-08-13).
 *
 * One map, used everywhere a severity becomes a colour, so the three levels cannot drift apart again.
 */
export const SEVERITY_TONE = { fail: 'danger', warn: 'warning', pass: 'success' } as const
export type VerifySeverity = keyof typeof SEVERITY_TONE

/** The same three colours as fills, for the traffic-light dot on a findings row. */
export const SEVERITY_DOT: Record<VerifySeverity, string> = {
  fail: 'bg-danger',
  warn: 'bg-warning',
  pass: 'bg-success',
}

/** Severity order, worst first - the sort order for a findings list and the rank for `worstSeverity`. */
export const SEVERITY_ORDER: VerifySeverity[] = ['fail', 'warn', 'pass']

/** What a count of findings at each level is CALLED. `fail` reads as "blocking" rather than "failed"
 *  because that is the consequence a reader needs: it is the level that keeps a piece out of `verified`. */
export const SEVERITY_LABEL: Record<VerifySeverity, (n: number) => string> = {
  fail: () => 'blocking',
  warn: (n) => (n === 1 ? 'warning' : 'warnings'),
  pass: () => 'passed',
}

/** How many findings sit at each level. Always all three keys, so a caller can render `0` or skip it. */
export function severityCounts(findings: VerifyFinding[]): Record<VerifySeverity, number> {
  const counts: Record<VerifySeverity, number> = { fail: 0, warn: 0, pass: 0 }
  for (const f of findings) counts[f.severity]++
  return counts
}

/** The verdict's own colour: the worst finding on it. Null when there is nothing to judge. */
export function worstSeverity(findings: VerifyFinding[]): VerifySeverity | null {
  return SEVERITY_ORDER.find((s) => findings.some((f) => f.severity === s)) ?? null
}

// --- columns --------------------------------------------------------------------------------------

export type ContentColumnKey = 'channels' | 'pieces' | 'owner' | 'verify' | 'published' | 'updated' | 'initiative'

/** The optional columns, in the order they are OFFERED. What renders, and in what order, is view
 *  state (`ContentViewState.columns`). `width` is a DEFAULT - a person can drag any column wider, and
 *  that stays with their browser. `hint` is the header tooltip.
 *
 *  `agg` is what makes a column TOTALLABLE in the footer. Both of Content's are counts of PIECES
 *  under a row that is a post - which is the honest answer to "how much is on this board", because
 *  the row count above already says how many posts there are. */
export const CONTENT_COLUMNS: {
  key: ContentColumnKey
  label: string
  width: string
  hint?: string
  agg?: Aggregatable<ContentPost>
}[] = [
  {
    // 120px, not the 160 it needed while it spelled the names out: the cell is glyphs only now
    // (2026-08-13), so all six channels fit in less room than four labels used to take.
    key: 'channels',
    label: 'Channels',
    width: '120px',
    hint: 'Which channels this post has been adapted to. Hover a glyph for its name.',
    agg: { value: (p) => p.all.length },
  },
  {
    key: 'pieces',
    label: 'Published',
    width: '110px',
    hint: 'How many of the post\'s live pieces are published.',
    agg: { value: (p) => p.published },
  },
  { key: 'owner', label: 'Owner', width: '120px', hint: 'The piece\'s creator, or the owning initiative\'s owner.' },
  { key: 'verify', label: 'Verify', width: '110px', hint: 'The agent\'s verdict: passed, findings, or never checked.' },
  { key: 'published', label: 'Live', width: '104px', hint: 'When the first piece of this post went out.' },
  { key: 'updated', label: 'Updated', width: '104px' },
  { key: 'initiative', label: 'Initiative', width: '180px', hint: 'The initiative id this post belongs to.' },
]

/**
 * Post (flexes), Asset, Status … the optional columns … the action cluster.
 *
 * ASSET IS A COLUMN OF ITS OWN (a product decision, 2026-08-13), not the thumbnail that used to sit between the
 * caret and the title. Riding in front of the title made every post's name start at a different x
 * depending on whether it had an image yet, and left the thumbnails themselves unalignable - the one
 * thing a column of pictures is for is scanning down it. Always shown rather than opt-in, because a
 * post's picture is part of what it IS, and a stored view written before this column existed would
 * otherwise have quietly dropped the thumbnail it already had.
 */
const CONTENT_GRID: GridSpec = {
  name: { key: 'post', label: 'Post', min: 260 },
  fixed: [
    { key: 'asset', label: 'Asset', width: 64 },
    { key: 'status', label: 'Status', width: 150 },
  ],
  actions: 44,
}

/** The header columns, the grid template and the width the rows need - the view's column ORDER and
 *  this browser's column WIDTHS resolved into one layout. */
export const contentGrid = (columns: readonly string[], widths: ColumnWidths): GridLayout =>
  buildGrid(CONTENT_GRID, orderColumns(CONTENT_COLUMNS, columns), widths)

/** The numbers behind the footer row - read from the posts the view actually SHOWS, so a total
 *  answers "what am I looking at" rather than "what is in the table". */
export const contentAggregates = (rows: ContentPost[], columns: readonly string[]): AggregateSources =>
  aggregateSources(rows, columns, CONTENT_COLUMNS)

// --- view state -------------------------------------------------------------------------------------

export type ContentGroupBy = 'none' | 'status' | 'owner'
export type ContentSortBy = 'updated' | 'status' | 'title' | 'published' | 'pieces'

export interface ContentFilters {
  status: ContentStatus[]
  channel: ContentChannel[]
  kind: ContentKind[]
  owner: string[]
  verify: VerifyBucket[]
}

export interface ContentViewState extends BaseViewState {
  layout: BoardLayout
  groupBy: ContentGroupBy
  sort: ContentSortBy
  sortDir: SortDir
  filters: ContentFilters
  columns: ContentColumnKey[]
  search: string
}

export const EMPTY_CONTENT_FILTERS: ContentFilters = { status: [], channel: [], kind: [], owner: [], verify: [] }

export const DEFAULT_CONTENT_VIEW: ContentViewState = {
  layout: 'list',
  groupBy: 'none',
  sort: 'updated',
  sortDir: 'desc',
  filters: EMPTY_CONTENT_FILTERS,
  columns: ['channels', 'pieces', 'owner', 'updated'],
  search: '',
}

export const CONTENT_GROUP_BY_OPTIONS: { value: ContentGroupBy; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'status', label: 'Status' },
  { value: 'owner', label: 'Owner' },
]

/** Each names a FIELD plus the direction it reads naturally; the arrow beside the picker reverses it
 *  ("Most channels" is just "Channels" pointing down). */
export const CONTENT_SORT_OPTIONS: { value: ContentSortBy; label: string; defaultDir: SortDir }[] = [
  { value: 'updated', label: 'Updated', defaultDir: 'desc' },
  { value: 'status', label: 'Lifecycle', defaultDir: 'asc' },
  { value: 'published', label: 'Published', defaultDir: 'desc' },
  { value: 'pieces', label: 'Channels', defaultDir: 'desc' },
  { value: 'title', label: 'Title', defaultDir: 'asc' },
]

/** How a field reads when you switch to it - and what a stored view without a direction falls back to. */
export const contentSortDir = (sort: ContentSortBy): SortDir =>
  CONTENT_SORT_OPTIONS.find((o) => o.value === sort)?.defaultDir ?? 'asc'

/**
 * The DEFAULT presets - lenses over the same posts, deliberately not a stored field, because a post
 * belongs to several of these at once.
 *
 * A SEED, not a floor (2026-08-12): written into the team's shared list the first time anybody opens
 * Content, and ordinary editable records from that moment on.
 */
export const CONTENT_DEFAULT_PRESETS: { name: string; description: string; icon: string; state: ContentViewState }[] = [
  {
    name: 'Everything',
    icon: 'layout-grid',
    description: 'Every post, most recently touched first.',
    state: DEFAULT_CONTENT_VIEW,
  },
  {
    name: 'Board',
    icon: 'kanban',
    description: 'Lifecycle columns - drag a post to move it along.',
    state: { ...DEFAULT_CONTENT_VIEW, layout: 'board', sort: 'status', sortDir: 'asc' },
  },
  {
    name: 'Needs review',
    icon: 'eye',
    description: 'Still in the workshop - drafted, not signed off.',
    state: {
      ...DEFAULT_CONTENT_VIEW,
      sort: 'status',
      sortDir: 'asc',
      filters: { ...EMPTY_CONTENT_FILTERS, status: ['draft'] },
      columns: ['channels', 'owner', 'verify', 'updated'],
    },
  },
  {
    name: 'Unverified',
    icon: 'alert-triangle',
    description: 'Never checked, or checked and still carrying findings.',
    state: {
      ...DEFAULT_CONTENT_VIEW,
      sort: 'status',
      sortDir: 'asc',
      filters: { ...EMPTY_CONTENT_FILTERS, verify: ['failed', 'unchecked'] },
      columns: ['channels', 'owner', 'verify', 'updated'],
    },
  },
  {
    name: 'Ready to ship',
    icon: 'rocket',
    description: 'Approved or scheduled - waiting only on the publish.',
    state: {
      ...DEFAULT_CONTENT_VIEW,
      sort: 'status',
      sortDir: 'asc',
      filters: { ...EMPTY_CONTENT_FILTERS, status: ['approved', 'scheduled'] },
      columns: ['channels', 'owner', 'published', 'updated'],
    },
  },
  {
    name: 'Published',
    icon: 'check-circle',
    description: 'What is live, most recently published first.',
    state: {
      ...DEFAULT_CONTENT_VIEW,
      sort: 'published',
      sortDir: 'desc',
      filters: { ...EMPTY_CONTENT_FILTERS, status: ['published'] },
      columns: ['channels', 'pieces', 'owner', 'published'],
    },
  },
]

// --- applying a view --------------------------------------------------------------------------------

/** One post: an initiative id, the pieces that survived the filter, and the derived facts a row and a
 *  card both need. `all` is every piece of the post, before filtering - the published count has to be
 *  honest even when the view is showing you one channel. */
export interface ContentPost {
  id: string
  title: string
  /** The topic's own review status (planned = an idea nobody has ruled on, active = approved). */
  topicStatus: PlanningStatus
  pieces: ContentPiece[]
  all: ContentPiece[]
  /** The publishing roll-up across its pieces, or null when it has none yet. */
  status: ContentStatus | null
  owner: string | null
  /** Live (non-archived) pieces, and how many of them are published. */
  live: number
  published: number
  updated_at: string
  /** When the first piece went out, or null. */
  published_at: string | null
}

const matches = <T extends string>(selected: T[], value: T | null): boolean =>
  selected.length === 0 || (value != null && selected.includes(value))

/**
 * Rank a post on one axis, ASCENDING and direction-free - the view's `sortDir` decides which way it
 * is read. `null` means the post has no value on this axis, and `compareKeys` sinks those either
 * way: a post that never went out is not "the oldest publish".
 */
function sortKey(p: ContentPost, sort: ContentSortBy): SortKey {
  switch (sort) {
    case 'status':
      // A topic with no pieces has no publishing status at all; compareKeys sinks the blank either
      // way, which is right - "not drafted yet" is not the earliest stage of publishing.
      return p.status ? CONTENT_STATUS_RANK[p.status] : null
    case 'title':
      return p.title.toLowerCase()
    case 'pieces':
      return p.live
    case 'published':
      return p.published_at
    default:
      return p.updated_at
  }
}

/** The post's status: the lowest of its live pieces, or of all of them when every piece is archived. */
export function postStatus(pieces: ContentPiece[]): ContentStatus {
  const live = pieces.filter((p) => p.status !== 'archived')
  return lowestStatus((live.length > 0 ? live : pieces).map((p) => p.status))
}

export interface ContentViewContext {
  /** Every topic - the ROW source. Pieces nest under them; a topic with none is still a row. */
  topics: ContentTopic[]
  /** The owning topic's owner, per topic id - the fallback when a piece has no creator. */
  topicOwners: Map<string, string | null>
  /** Titles for posts whose canonical piece has none. */
  showArchived: boolean
  mineOnly: boolean
  activeUserId: string | null
  ownerName: (id: string) => string
}

/** Displayed owner of a piece: dashboard creator when set, else its TOPIC's owner - the same
 *  fallback idea as signal ownership (pipeline-created pieces would otherwise all be blank). Since
 *  2026-08-12 that fallback is the topic rather than an initiative, which is also more correct: a
 *  topic's owner is whose voice its pieces speak in. */
export function resolvePieceOwner(
  piece: Pick<ContentPiece, 'created_by' | 'topic_id'>,
  topicOwners: Map<string, string | null>,
): string | null {
  return piece.created_by ?? topicOwners.get(piece.topic_id) ?? null
}

/** The group a topic with no pieces falls into when grouping by status - it has no publishing status
 *  to be in, and dropping it would hide exactly the rows the review gate exists for. */
export const NO_PIECES = 'not drafted'

export interface ContentGroup {
  key: string
  label: string
  items: ContentPost[]
}

/**
 * Filter → build rows → sort → group. The order matters: filters are per PIECE, everything after is
 * per TOPIC, and a topic that lost every piece to the filter is not a row the board should show.
 *
 * A ROW IS A TOPIC, not a group of pieces (2026-08-12). The difference is the whole point of the
 * review gate: a topic the pipeline just wrote has NO pieces at all, and under the old
 * group-the-pieces model it would not have appeared anywhere - ten ideas a week, invisible until
 * somebody drafted them, which is exactly backwards. So a pieceless topic is a row, and it survives
 * unless a piece-level filter is active (a filter on channel or verify state is a question about
 * pieces, and a topic with none cannot answer it).
 */
export function applyContentView(
  pieces: ContentPiece[],
  view: ContentViewState,
  ctx: ContentViewContext,
): ContentGroup[] {
  const ownerOf = (p: ContentPiece): string | null => resolvePieceOwner(p, ctx.topicOwners)
  const q = view.search.trim().toLowerCase()

  const keep = pieces.filter((p) => {
    if (!ctx.showArchived && p.status === 'archived') return false
    if (ctx.mineOnly && ctx.activeUserId && ownerOf(p) !== ctx.activeUserId) return false
    if (!matches(view.filters.status, p.status)) return false
    if (!matches(view.filters.channel, p.channel)) return false
    if (!matches(view.filters.kind, p.kind)) return false
    if (!matches(view.filters.owner, ownerOf(p))) return false
    if (!matches(view.filters.verify, verifyBucket(p))) return false
    if (q && ![p.title, p.id, p.topic_id, p.channel].some((s) => s.toLowerCase().includes(q))) return false
    return true
  })

  const keptByTopic = new Map<string, ContentPiece[]>()
  for (const p of keep) {
    const list = keptByTopic.get(p.topic_id)
    if (list) list.push(p)
    else keptByTopic.set(p.topic_id, [p])
  }
  const allByTopic = new Map<string, ContentPiece[]>()
  for (const p of pieces) {
    const list = allByTopic.get(p.topic_id)
    if (list) list.push(p)
    else allByTopic.set(p.topic_id, [p])
  }
  // Whether the view asks a question only a PIECE can answer. A pieceless topic is dropped when one
  // is active, and kept otherwise - see the note on this function.
  const pieceFilterActive =
    view.filters.status.length > 0 ||
    view.filters.channel.length > 0 ||
    view.filters.kind.length > 0 ||
    view.filters.verify.length > 0

  const posts: ContentPost[] = ctx.topics.flatMap((topic) => {
    const all = allByTopic.get(topic.id) ?? []
    const kept = keptByTopic.get(topic.id) ?? []
    if (all.length > 0 && kept.length === 0) return []
    if (all.length === 0) {
      if (pieceFilterActive) return []
      if (ctx.mineOnly && ctx.activeUserId && topic.owner !== ctx.activeUserId) return []
      if (view.filters.owner.length > 0 && !matches(view.filters.owner, topic.owner)) return []
      if (q && ![topic.title, topic.id, topic.brief].some((s) => s.toLowerCase().includes(q))) return []
    }
    const live = all.filter((p) => p.status !== 'archived')
    const considered = live.length > 0 ? live : all
    const publishedAt = all
      .map((p) => p.published_at)
      .filter((d): d is string => !!d)
      .sort()[0]
    const canonical = all.find((p) => p.kind === 'canonical') ?? all[0]
    return [{
      id: topic.id,
      // The TOPIC carries the row's identity now - it exists before any piece does, and a canonical
      // piece retitled for the blog should not silently rename the idea it came from.
      title: topic.title || canonical?.title || topic.id,
      topicStatus: topic.status,
      pieces: [...kept].sort((a, b) =>
        a.kind === b.kind ? a.channel.localeCompare(b.channel) : a.kind === 'canonical' ? -1 : 1,
      ),
      all,
      status: all.length > 0 ? postStatus(all) : null,
      owner: topic.owner ?? (canonical ? ownerOf(canonical) : null),
      live: considered.length,
      published: considered.filter((p) => p.status === 'published').length,
      updated_at: all.map((p) => p.updated_at).sort().at(-1) ?? topic.updated_at,
      published_at: publishedAt ?? null,
    }]
  })

  const sorted = [...posts].sort(
    (a, b) => compareKeys(sortKey(a, view.sort), sortKey(b, view.sort), view.sortDir) || a.title.localeCompare(b.title),
  )

  if (view.groupBy === 'none') return [{ key: 'all', label: '', items: sorted }]

  const keyOf = (p: ContentPost): string => (view.groupBy === 'status' ? (p.status ?? NO_PIECES) : (p.owner ?? ''))
  const byKey = new Map<string, ContentPost[]>()
  for (const p of sorted) {
    const key = keyOf(p)
    const list = byKey.get(key)
    if (list) list.push(p)
    else byKey.set(key, [p])
  }
  const keys =
    view.groupBy === 'status'
      ? [...CONTENT_STATUSES, NO_PIECES].filter((s) => byKey.has(s))
      : [...byKey.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : ctx.ownerName(a).localeCompare(ctx.ownerName(b))))
  return keys.map((key) => ({
    key: key || 'unassigned',
    label: view.groupBy === 'owner' ? (key ? ctx.ownerName(key) : 'Unassigned') : key,
    items: byKey.get(key)!,
  }))
}

/**
 * Which statuses the board shows as columns, in lifecycle order. An explicit status filter IS the
 * column list (so the board obeys the same one filter surface the list does); with no filter it falls
 * back to the seven a post is actually moved through.
 */
export function contentBoardColumns(view: ContentViewState): ContentStatus[] {
  const chosen = view.filters.status.length > 0 ? view.filters.status : CONTENT_BOARD_COLUMNS
  return CONTENT_STATUSES.filter((s) => chosen.includes(s))
}

// --- reading stored view state -----------------------------------------------------------------------

const COLUMN_KEYS = new Set<string>(CONTENT_COLUMNS.map((c) => c.key))

/** Drop unknown keys, de-duplicate, and KEEP THE STORED ORDER - it is the render order now. */
function normalizeColumns(raw: unknown): ContentColumnKey[] {
  if (!isStringArray(raw)) return DEFAULT_CONTENT_VIEW.columns
  return [...new Set(raw.filter((k): k is ContentColumnKey => COLUMN_KEYS.has(k)))]
}

/**
 * Read one stored `ContentViewState`, repairing what can be repaired and returning null only when
 * the value is not a view at all (the caller then falls back to the default). Every field is checked
 * against the CURRENT vocabulary, so a value retired in a later release degrades to that field's
 * default instead of poisoning the whole board.
 */
export function normalizeContentViewState(raw: unknown): ContentViewState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  if (!('columns' in v) && !('filters' in v) && !('groupBy' in v) && !('layout' in v)) return null
  const sort = pickEnum<ContentSortBy>(
    v.sort,
    CONTENT_SORT_OPTIONS.map((o) => o.value),
    DEFAULT_CONTENT_VIEW.sort,
  )
  return {
    layout: pickEnum<BoardLayout>(v.layout, ['list', 'board'], DEFAULT_CONTENT_VIEW.layout),
    groupBy: pickEnum<ContentGroupBy>(
      v.groupBy,
      CONTENT_GROUP_BY_OPTIONS.map((o) => o.value),
      DEFAULT_CONTENT_VIEW.groupBy,
    ),
    sort,
    // A view stored before the direction existed falls back to the one its sort used to bake in.
    sortDir: pickSortDir(v.sortDir, contentSortDir(sort)),
    columns: normalizeColumns(v.columns),
    search: typeof v.search === 'string' ? v.search : '',
    filters: normalizeFilters(v.filters, EMPTY_CONTENT_FILTERS),
  }
}

/** Structural equality, so the bar can tell "you are on a preset" from "you edited it".
 *  Columns compare IN ORDER: rearranging them is an edit, the same as turning one on. */
export function sameContentView(a: ContentViewState, b: ContentViewState): boolean {
  return (
    a.layout === b.layout &&
    a.groupBy === b.groupBy &&
    a.sort === b.sort &&
    a.sortDir === b.sortDir &&
    a.search.trim() === b.search.trim() &&
    sameOrder(a.columns, b.columns) &&
    sameFilters(a.filters, b.filters, EMPTY_CONTENT_FILTERS)
  )
}

/** How many filter dimensions are narrowing the board right now. */
export const activeContentFilterCount = (view: ContentViewState): number =>
  activeFilterCountOf(view.filters, view.search)

// --- the bar ------------------------------------------------------------------------------------

/** What the shared `ViewBar` needs to render Content's controls - `{value, label}` pairs only,
 *  so the bar never learns what a channel or a verify verdict MEANS. Built per render because half of
 *  it depends on what is actually on the board. */
export function contentBarSpec(
  pieces: ContentPiece[],
  ownerLabel: (id: string) => string,
  topicOwners: Map<string, string | null>,
  layout: BoardLayout,
): ViewBarSpec {
  const usedChannels = [...new Set(pieces.map((p) => p.channel))]
  const usedOwners = [
    ...new Set(pieces.map((p) => resolvePieceOwner(p, topicOwners)).filter((o): o is string => !!o)),
  ]
  return {
    noun: 'posts',
    savesHint: 'the current layout, filters, grouping and columns',
    searchPlaceholder: 'Search title, post, channel…',
    layouts: [
      { value: 'list', label: 'List', icon: List },
      { value: 'board', label: 'Board', icon: KanbanSquare },
    ],
    groupBy: CONTENT_GROUP_BY_OPTIONS,
    sort: CONTENT_SORT_OPTIONS,
    columns: CONTENT_COLUMNS.map((c) => ({ key: c.key, label: c.label })),
    columnsNote: 'Post, Asset and Status are always shown.',
    emptyFilters: EMPTY_CONTENT_FILTERS,
    sections: [
      {
        key: 'status',
        title: 'Status',
        options: CONTENT_STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ') })),
        note:
          layout === 'board'
            ? 'On the board these ARE the columns, and a post sits in the column of its LOWEST piece. With none picked it shows the seven live stages; archived gets a column only when you ask for it.'
            : 'Filters pick PIECES - a post shows when one of its channels matches, opened to exactly those.',
      },
      {
        key: 'channel',
        title: 'Channel',
        options: usedChannels.map((c) => ({ value: c, label: CHANNEL_UI[c]?.label ?? c })),
      },
      {
        key: 'kind',
        title: 'Kind',
        options: [
          { value: 'canonical', label: 'Canonical' },
          { value: 'derived', label: 'Adaptation' },
        ],
      },
      {
        key: 'verify',
        title: 'Verify',
        options: VERIFY_BUCKETS.map((b) => ({ value: b, label: VERIFY_BUCKET_LABEL[b] })),
      },
      { key: 'owner', title: 'Owner', options: usedOwners.map((o) => ({ value: o, label: ownerLabel(o) })) },
    ],
  }
}
