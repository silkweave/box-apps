// The CRM board's view model: which accounts show, how they group and sort, which optional columns
// render, and whether the board is a list or a pipeline. Mirrors `planningView.ts` in SHAPE - same
// anti-overwhelm rules, same repair-not-reset saved views - while sharing none of its vocabulary,
// because an account's axes (status, source, MRR, next action) and an initiative's (kind, value,
// effort, signal) have nothing in common. The mechanical half they DO share lives in `boardView.ts`.
//
// The rules this file exists to enforce:
//
//   • every filterable dimension is a short enum, so a filter is a chip and never a text box;
//   • optional columns are opt-in, so the default board stays readable;
//   • the layout (list vs pipeline) is part of the VIEW, so "Pipeline" can be a preset someone picks
//     rather than a separate mode with its own forgotten state.
//
// State persists under `<APP_STORAGE_PREFIX>.crm.*` (boardView.ts + usePersistedState), keyed
// through `appKey()` - see lib/storage.ts.

import { KanbanSquare, List } from 'lucide-react'
import { todayLocal } from '@silkweave/box-ui'
import type { ViewBarSpec } from '../../data/components/board/ViewBar.tsx'
import {
  CRM_ACCOUNT_SOURCES,
  CRM_ACCOUNT_SOURCE_LABEL,
  CRM_ACCOUNT_STATUSES,
  CRM_ACCOUNT_STATUS_LABEL,
  weightedMrr,
  type CrmAccount,
  type CrmAccountSource,
  type CrmAccountStatus,
} from '../crm-types.ts'
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

// --- terminal states ---------------------------------------------------------------------------

/**
 * Statuses a company does not come back from on its own. They matter twice: an overdue next action
 * on a closed account is not overdue (nobody is chasing it), and the pipeline board does not give
 * them a column by default (see PIPELINE_COLUMNS).
 */
export const CRM_TERMINAL_STATUSES: CrmAccountStatus[] = ['churned', 'lost', 'archived']

/**
 * The columns a pipeline board shows when the view names no statuses of its own: the ones a human
 * actually drags a card through. The three terminal statuses are reachable by filtering for them
 * (they then appear as columns, at the end) or in the list view - a board is a place you move things
 * THROUGH, and three columns of the dead would eat a third of the width holding rows nobody drags.
 */
export const PIPELINE_COLUMNS: CrmAccountStatus[] = [
  'stale',
  'meeting_requested',
  'meeting_booked',
  'demo',
  'proposal',
  'confirmed',
  'customer',
  'onboarding',
  'at_risk',
  'revisit',
]

// --- next-action dates -------------------------------------------------------------------------

/**
 * Is this account's next action late? A display judgment, never stored: the date is past AND the
 * account is still live. "Today" is the VIEWER's local day - "is this late?" is a question asked
 * inside a working day (the same call `planningView.isOverdue` makes, for the same reason).
 */
export function isActionOverdue(a: { next_action_at: string | null; status: CrmAccountStatus }): boolean {
  if (!a.next_action_at) return false
  if (CRM_TERMINAL_STATUSES.includes(a.status)) return false
  return a.next_action_at < todayLocal()
}

export type DueBucket = 'overdue' | 'this_week' | 'later' | 'none'
export const DUE_BUCKETS: DueBucket[] = ['overdue', 'this_week', 'later', 'none']
export const DUE_BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: 'Overdue',
  this_week: 'This week',
  later: 'Later',
  none: 'No next action',
}

function plusDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function dueBucket(a: { next_action_at: string | null; status: CrmAccountStatus }): DueBucket {
  if (!a.next_action_at) return 'none'
  if (isActionOverdue(a)) return 'overdue'
  const today = todayLocal()
  if (a.next_action_at >= today && a.next_action_at <= plusDays(today, 6)) return 'this_week'
  return 'later'
}

// --- the money axis ----------------------------------------------------------------------------

/**
 * MRR collapsed into chips. A number is not chip-shaped but the question people actually ask of it
 * is: does this account bill us anything? The Lark migration left plenty of `0` and `null` rows
 * (payment holidays, unpriced prospects), and telling those two apart matters - `0` is a decision,
 * `null` is a blank.
 */
export type MrrBucket = 'paying' | 'zero' | 'unset'
export const MRR_BUCKETS: MrrBucket[] = ['paying', 'zero', 'unset']
export const MRR_BUCKET_LABEL: Record<MrrBucket, string> = {
  paying: 'Has MRR',
  zero: 'Zero',
  unset: 'Not set',
}

export const mrrBucket = (a: CrmAccount): MrrBucket =>
  a.mrr_usd == null ? 'unset' : a.mrr_usd > 0 ? 'paying' : 'zero'

// --- columns -----------------------------------------------------------------------------------

export type CrmColumnKey =
  | 'contacts'
  | 'value'
  | 'mrr'
  | 'probability'
  | 'weighted'
  | 'next_action'
  | 'due'
  | 'source'
  | 'referral'
  | 'last_contacted'
  | 'subscription'
  | 'tags'
  | 'stripe'
  | 'space'
  | 'whatsapp'

/**
 * The optional columns, in the order they are OFFERED. What renders, and in what order, is view
 * state - see `CrmViewState.columns`. `width` is a DEFAULT (a person can drag any of them wider);
 * `hint` is the header tooltip, the legend that keeps a number readable without a key on the page.
 *
 * `numeric` right-aligns the CELLS, and only the cells: a column of figures is read by comparing
 * magnitudes, which needs the ones and tens digits stacked. The HEADER stays left-aligned with every
 * other header, because a header row is scanned horizontally and a label that starts somewhere
 * different each time makes the eye work for it.
 *
 * `agg` is what makes a column TOTALLABLE in the footer - how to read one account as a number, and
 * whether that number is money, a percentage or a count. It is deliberately the CRM's own call: the
 * footer never learns that `weighted` means MRR × probability.
 */
export const CRM_COLUMNS: {
  key: CrmColumnKey
  label: string
  width: string
  hint?: string
  numeric?: true
  agg?: Aggregatable<CrmAccount>
}[] = [
  {
    key: 'contacts',
    label: 'Contacts',
    width: '180px',
    hint: 'The primary contact, and how many people are on the account.',
    agg: { value: (a) => a.contacts.length },
  },
  {
    key: 'value',
    label: 'Value',
    width: '130px',
    numeric: true,
    hint: 'Weighted MRR on top - the operator MRR estimate times the close probability. Under it, the odds and the full MRR they are taken from. An estimate for prioritising work, never a forecast.',
    // The cell shows three numbers; the footer totals the one the cell leads with.
    agg: { value: weightedMrr, unit: 'currency' },
  },
  {
    key: 'mrr',
    label: 'MRR',
    width: '100px',
    numeric: true,
    hint: 'The operator estimate used to weigh the pipeline - NOT a finance number. Stripe owns money.',
    agg: { value: (a) => a.mrr_usd, unit: 'currency' },
  },
  {
    key: 'probability',
    label: 'Close %',
    width: '80px',
    numeric: true,
    hint: 'The operator read of the odds, 0-100.',
    agg: { value: (a) => a.close_probability, unit: 'percent' },
  },
  {
    key: 'weighted',
    label: 'Weighted',
    width: '100px',
    numeric: true,
    hint: 'MRR x close probability. An estimate for prioritising work, never a forecast.',
    agg: { value: weightedMrr, unit: 'currency' },
  },
  { key: 'next_action', label: 'Next action', width: '260px' },
  { key: 'due', label: 'Due', width: '96px', hint: 'When the next action is due. Red when past and the account is still live.' },
  { key: 'source', label: 'Source', width: '120px' },
  { key: 'referral', label: 'Referred by', width: '140px' },
  { key: 'last_contacted', label: 'Last contact', width: '104px' },
  { key: 'subscription', label: 'Subscription', width: '180px', hint: 'Start, and end/churn date when set.' },
  { key: 'tags', label: 'Tags', width: '160px' },
  // The three EXTERNAL LINKS, editable in the cell for the same reason they are editable on the
  // account page: only a person can decide which row in another system IS this account, and doing
  // that for thirty accounts one detail page at a time is the slow way to do it. A value already
  // held by another account is refused by the server - see `LinkCell`, which puts the refusal on
  // screen and restores the cell rather than leaving the rejected text sitting in the box.
  { key: 'stripe', label: 'Stripe ID', width: '180px', hint: 'The Stripe customer (cus_…). At most one account per customer id.' },
  { key: 'whatsapp', label: 'WhatsApp ID', width: '190px', hint: 'The WhatsApp group JID (…@g.us). Human-set: group names do not identify an account.' },
  { key: 'space', label: 'Space ID', width: '140px', hint: 'The platform space this account’s usage lives in.' },
]

/**
 * Account (flexes), Status, Owner … the optional columns … the action cluster.
 *
 * The Account column carries its own left inset, header and cell alike. Every other grid here opens
 * its identity column with a control - a caret, a drag handle - and the row's 8px of padding is the
 * gap before that control rather than before any text; the CRM has none, so the company name started
 * 8px from the edge of the canvas and read as if it had fallen off it.
 */
const CRM_GRID: GridSpec = {
  name: { key: 'account', label: 'Account', min: 220, labelClass: 'pl-2' },
  fixed: [
    { key: 'status', label: 'Status', width: 150 },
    { key: 'owner', label: 'Owner', width: 110 },
  ],
  actions: 44,
}

/** The header columns, the grid template and the width the rows need - the view's column ORDER and
 *  this browser's column WIDTHS resolved into one layout. */
export const crmGrid = (columns: readonly string[], widths: ColumnWidths): GridLayout =>
  buildGrid(CRM_GRID, orderColumns(CRM_COLUMNS, columns), widths)

/** The numbers behind the footer row - read from the accounts the view actually SHOWS, so a total
 *  answers "what am I looking at" rather than "what is in the table". */
export const crmAggregates = (rows: CrmAccount[], columns: readonly string[]): AggregateSources =>
  aggregateSources(rows, columns, CRM_COLUMNS)

// --- view state --------------------------------------------------------------------------------

export type CrmGroupBy = 'none' | 'status' | 'owner' | 'source' | 'referral'
export type CrmSortBy = 'status' | 'mrr' | 'weighted' | 'next_action' | 'last_contacted' | 'name' | 'updated'

export interface CrmFilters {
  status: CrmAccountStatus[]
  source: CrmAccountSource[]
  owner: string[]
  due: DueBucket[]
  mrr: MrrBucket[]
  tags: string[]
}

export interface CrmViewState extends BaseViewState {
  layout: BoardLayout
  groupBy: CrmGroupBy
  sort: CrmSortBy
  sortDir: SortDir
  filters: CrmFilters
  columns: CrmColumnKey[]
  search: string
}

export const EMPTY_CRM_FILTERS: CrmFilters = { status: [], source: [], owner: [], due: [], mrr: [], tags: [] }

export const DEFAULT_CRM_VIEW: CrmViewState = {
  layout: 'list',
  groupBy: 'none',
  sort: 'status',
  sortDir: 'asc',
  filters: EMPTY_CRM_FILTERS,
  columns: ['contacts', 'value', 'next_action', 'due', 'source'],
  search: '',
}

export const CRM_GROUP_BY_OPTIONS: { value: CrmGroupBy; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'status', label: 'Status' },
  { value: 'owner', label: 'Owner' },
  { value: 'source', label: 'Source' },
  { value: 'referral', label: 'Referred by' },
]

/**
 * The sort axes. Each names a FIELD and the direction it reads naturally; the direction itself is a
 * separate control on the bar, which is why "Least recently contacted" is now just "Last contact"
 * with the arrow pointing up. That option used to be the only way to ask the question at all, and
 * there was no way to ask it the other way round.
 */
export const CRM_SORT_OPTIONS: { value: CrmSortBy; label: string; defaultDir: SortDir }[] = [
  { value: 'status', label: 'Lifecycle', defaultDir: 'asc' },
  { value: 'mrr', label: 'MRR', defaultDir: 'desc' },
  { value: 'weighted', label: 'Weighted', defaultDir: 'desc' },
  { value: 'next_action', label: 'Next action', defaultDir: 'asc' },
  { value: 'last_contacted', label: 'Last contact', defaultDir: 'asc' },
  { value: 'name', label: 'Name', defaultDir: 'asc' },
  { value: 'updated', label: 'Updated', defaultDir: 'desc' },
]

/** How a field reads when you switch to it - and what a stored view without a direction falls back to. */
export const crmSortDir = (sort: CrmSortBy): SortDir =>
  CRM_SORT_OPTIONS.find((o) => o.value === sort)?.defaultDir ?? 'asc'

/**
 * The DEFAULT presets - each a lens over the same accounts, deliberately not a stored field, because
 * an account belongs to several of these at once and a column would have to pick one.
 *
 * A SEED, not a floor (2026-08-12): these are written into the team's shared list the first time
 * anybody opens the CRM, and from that moment they are ordinary editable records like any other.
 */
export const CRM_DEFAULT_PRESETS: { name: string; description: string; icon: string; state: CrmViewState }[] = [
  {
    name: 'Everything',
    icon: 'layout-grid',
    description: 'The default board - every live account, lifecycle order.',
    state: DEFAULT_CRM_VIEW,
  },
  {
    name: 'Pipeline',
    icon: 'kanban',
    description: 'The kanban: drag a company through the lifecycle.',
    state: {
      ...DEFAULT_CRM_VIEW,
      layout: 'board',
      sort: 'weighted',
      sortDir: 'desc',
      filters: { ...EMPTY_CRM_FILTERS, status: PIPELINE_COLUMNS },
    },
  },
  {
    name: 'Customers',
    icon: 'dollar-sign',
    description: 'Everyone paying us today, biggest first.',
    state: {
      ...DEFAULT_CRM_VIEW,
      sort: 'mrr',
      sortDir: 'desc',
      filters: { ...EMPTY_CRM_FILTERS, status: ['customer', 'at_risk'] },
      columns: ['contacts', 'mrr', 'subscription', 'last_contacted', 'source'],
    },
  },
  {
    name: 'Needs attention',
    icon: 'alert-triangle',
    description: 'At-risk accounts and anything whose next action is late.',
    state: {
      ...DEFAULT_CRM_VIEW,
      sort: 'next_action',
      sortDir: 'asc',
      filters: { ...EMPTY_CRM_FILTERS, due: ['overdue'] },
      columns: ['contacts', 'mrr', 'next_action', 'due', 'last_contacted'],
    },
  },
  {
    name: 'Closed',
    icon: 'check-circle',
    description: 'Churned and lost, most recently touched first.',
    state: {
      ...DEFAULT_CRM_VIEW,
      sort: 'updated',
      sortDir: 'desc',
      filters: { ...EMPTY_CRM_FILTERS, status: ['churned', 'lost'] },
      columns: ['contacts', 'mrr', 'subscription', 'source', 'referral'],
    },
  },
  {
    name: 'By partner',
    icon: 'handshake',
    description: 'Who each referral partner brought in.',
    state: {
      ...DEFAULT_CRM_VIEW,
      groupBy: 'referral',
      sort: 'mrr',
      sortDir: 'desc',
      columns: ['contacts', 'mrr', 'referral', 'source'],
    },
  },
]

// --- applying a view ---------------------------------------------------------------------------

const matches = <T extends string>(selected: T[], value: T | null): boolean =>
  selected.length === 0 || (value != null && selected.includes(value))

const STATUS_RANK: Record<CrmAccountStatus, number> = Object.fromEntries(
  CRM_ACCOUNT_STATUSES.map((s, i) => [s, i]),
) as Record<CrmAccountStatus, number>

/**
 * Rank a row on one axis, ASCENDING and direction-free - the view's `sortDir` decides which way it
 * is read. `null` means the row has no value on this axis, and `compareKeys` sinks those either way:
 * an account nobody has contacted is not "the least recently contacted", it is a blank.
 *
 * This used to bake each axis's direction into the key (negated numbers, `9999-12-31` sentinels),
 * which is exactly why there was a sort called "Least recently contacted" and no way to reverse it.
 */
function sortKey(a: CrmAccount, sort: CrmSortBy): SortKey {
  switch (sort) {
    case 'mrr':
      return a.mrr_usd
    case 'weighted':
      return weightedMrr(a)
    case 'next_action':
      return a.next_action_at
    case 'last_contacted':
      return a.last_contacted_at
    case 'name':
      return a.name.toLowerCase()
    case 'updated':
      return new Date(a.updated_at).getTime()
    default:
      return STATUS_RANK[a.status] ?? 99
  }
}

export interface CrmGroup {
  key: string
  label: string
  items: CrmAccount[]
}

function groupKeyOf(a: CrmAccount, groupBy: CrmGroupBy, ownerName: (id: string) => string): string {
  switch (groupBy) {
    case 'status':
      return a.status
    case 'owner':
      return a.owner ? ownerName(a.owner) : 'Unassigned'
    case 'source':
      return a.source
    case 'referral':
      return a.referral_partner || 'Direct (no partner)'
    default:
      return ''
  }
}

const GROUP_ORDER: Partial<Record<CrmGroupBy, string[]>> = {
  status: CRM_ACCOUNT_STATUSES,
  source: CRM_ACCOUNT_SOURCES,
}

export interface CrmApplyContext {
  /** The global eye toggle - when off, archived accounts are hidden. */
  showArchived: boolean
  /** The global "only my items" scope. */
  mineOnly: boolean
  activeUserId: string | null
  ownerName: (id: string) => string
}

/**
 * Filter → sort → group, in that order. Returns one group with an empty label when `groupBy` is
 * 'none', so both layouts render groups uniformly.
 *
 * The archived default is DEFERRED to whenever the view sets an explicit status filter - otherwise
 * picking a view like "everything archived" would silently return nothing (the same deferral
 * `planningView.applyView` makes for its own showAll rule).
 */
export function applyCrmView(accounts: CrmAccount[], view: CrmViewState, ctx: CrmApplyContext): CrmGroup[] {
  const q = view.search.trim().toLowerCase()
  const terms = q.split(/\s+/).filter(Boolean)
  const hasStatusFilter = view.filters.status.length > 0

  const rows = accounts.filter((a) => {
    if (ctx.mineOnly && ctx.activeUserId && a.owner !== ctx.activeUserId) return false
    if (!hasStatusFilter && !ctx.showArchived && a.status === 'archived') return false
    if (!matches(view.filters.status, a.status)) return false
    if (!matches(view.filters.source, a.source)) return false
    if (!matches(view.filters.due, dueBucket(a))) return false
    if (!matches(view.filters.mrr, mrrBucket(a))) return false
    if (view.filters.owner.length > 0 && !view.filters.owner.includes(a.owner ?? '')) return false
    if (view.filters.tags.length > 0 && !view.filters.tags.every((t) => a.tags.includes(t))) return false
    if (terms.length > 0) {
      // Contacts are part of the account's searchable text: "who was that person at Filter" is the
      // question, and the account is the answer.
      const haystack = [
        a.name,
        a.id,
        a.notes,
        a.next_action,
        a.referral_partner ?? '',
        a.tags.join(' '),
        a.contacts.map((c) => `${c.name} ${c.email ?? ''} ${c.headline}`).join(' '),
      ]
        .join(' ')
        .toLowerCase()
      if (!terms.every((t) => haystack.includes(t))) return false
    }
    return true
  })

  const sorted = [...rows].sort(
    (a, b) =>
      compareKeys(sortKey(a, view.sort), sortKey(b, view.sort), view.sortDir) || a.name.localeCompare(b.name),
  )

  if (view.groupBy === 'none') return [{ key: 'all', label: '', items: sorted }]

  const byKey = new Map<string, CrmAccount[]>()
  for (const a of sorted) {
    const key = groupKeyOf(a, view.groupBy, ctx.ownerName)
    byKey.set(key, [...(byKey.get(key) ?? []), a])
  }
  const order = GROUP_ORDER[view.groupBy]
  const keys = [...byKey.keys()].sort((x, y) => {
    if (order) {
      const ix = order.indexOf(x)
      const iy = order.indexOf(y)
      if (ix !== iy) return (ix < 0 ? order.length : ix) - (iy < 0 ? order.length : iy)
    }
    return x.localeCompare(y)
  })
  return keys.map((key) => ({ key, label: key, items: byKey.get(key)! }))
}

/**
 * Which statuses the pipeline board shows as columns, in lifecycle order. An explicit status filter
 * IS the column list (so the board obeys the same one filter surface the list does); with no filter
 * it falls back to the six live statuses.
 */
export function kanbanColumns(view: CrmViewState): CrmAccountStatus[] {
  const chosen = view.filters.status.length > 0 ? view.filters.status : PIPELINE_COLUMNS
  return CRM_ACCOUNT_STATUSES.filter((s) => chosen.includes(s))
}

/** Human label for a group header, per axis (the raw key is an enum value or an owner/partner name). */
export function crmGroupLabel(groupBy: CrmGroupBy, key: string): string {
  if (groupBy === 'status') return CRM_ACCOUNT_STATUS_LABEL[key as CrmAccountStatus] ?? key
  if (groupBy === 'source') return CRM_ACCOUNT_SOURCE_LABEL[key as CrmAccountSource] ?? key
  return key
}

// --- reading stored view state -----------------------------------------------------------------

const COLUMN_KEYS = new Set<string>(CRM_COLUMNS.map((c) => c.key))

/** Drop unknown keys, de-duplicate, and KEEP THE STORED ORDER - it is the render order now. */
function normalizeColumns(raw: unknown): CrmColumnKey[] {
  if (!isStringArray(raw)) return DEFAULT_CRM_VIEW.columns
  return [...new Set(raw.filter((k): k is CrmColumnKey => COLUMN_KEYS.has(k)))]
}

/**
 * Read one stored `CrmViewState`, repairing what can be repaired and returning null only when the
 * value is not a view at all (the caller then falls back to the default). Every field is checked
 * against the CURRENT vocabulary, so a value retired in a later release degrades to that field's
 * default instead of poisoning the whole board.
 */
export function normalizeCrmViewState(raw: unknown): CrmViewState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  if (!('columns' in v) && !('filters' in v) && !('groupBy' in v) && !('layout' in v)) return null
  const sort = pickEnum<CrmSortBy>(
    v.sort,
    CRM_SORT_OPTIONS.map((o) => o.value),
    DEFAULT_CRM_VIEW.sort,
  )
  return {
    layout: pickEnum<BoardLayout>(v.layout, ['list', 'board'], DEFAULT_CRM_VIEW.layout),
    groupBy: pickEnum<CrmGroupBy>(
      v.groupBy,
      CRM_GROUP_BY_OPTIONS.map((o) => o.value),
      DEFAULT_CRM_VIEW.groupBy,
    ),
    sort,
    // A view stored before the direction existed falls back to the one its sort used to bake in,
    // so an old preset keeps showing what it always showed.
    sortDir: pickSortDir(v.sortDir, crmSortDir(sort)),
    columns: normalizeColumns(v.columns),
    search: typeof v.search === 'string' ? v.search : '',
    filters: normalizeFilters(v.filters, EMPTY_CRM_FILTERS),
  }
}

/** Structural equality, so the view bar can tell "you are on a preset" from "you edited it".
 *  Columns compare IN ORDER: rearranging them is an edit, the same as turning one on. */
export function sameCrmView(a: CrmViewState, b: CrmViewState): boolean {
  return (
    a.layout === b.layout &&
    a.groupBy === b.groupBy &&
    a.sort === b.sort &&
    a.sortDir === b.sortDir &&
    a.search.trim() === b.search.trim() &&
    sameOrder(a.columns, b.columns) &&
    sameFilters(a.filters, b.filters, EMPTY_CRM_FILTERS)
  )
}

/** Every tag in use, for the filter picker. */
export const allCrmTags = (accounts: CrmAccount[]): string[] =>
  [...new Set(accounts.flatMap((a) => a.tags))].sort()

/** How many filter dimensions are narrowing the board right now. */
export const activeCrmFilterCount = (view: CrmViewState): number => activeFilterCountOf(view.filters, view.search)

// --- the bar ------------------------------------------------------------------------------------

/**
 * What the shared `ViewBar` needs to render the CRM's controls. Everything here is
 * `{value, label}` pairs: the bar never learns what a status or an MRR bucket MEANS, which is what
 * lets one component serve three modules.
 *
 * Built per render rather than declared as a constant because half of it depends on what is actually
 * on the board - a filter for a source nobody uses, or an owner with no accounts, is noise.
 */
export function crmBarSpec(
  accounts: CrmAccount[],
  tags: string[],
  ownerLabel: (id: string) => string,
  layout: BoardLayout,
): ViewBarSpec {
  const usedSources = CRM_ACCOUNT_SOURCES.filter((s) => accounts.some((a) => a.source === s))
  const usedOwners = [...new Set(accounts.map((a) => a.owner).filter((o): o is string => !!o))]
  return {
    noun: 'accounts',
    savesHint: 'the current layout, filters, grouping and columns',
    searchPlaceholder: 'Search company, contact, notes…',
    layouts: [
      { value: 'list', label: 'List', icon: List },
      { value: 'board', label: 'Pipeline', icon: KanbanSquare },
    ],
    groupBy: CRM_GROUP_BY_OPTIONS,
    sort: CRM_SORT_OPTIONS,
    columns: CRM_COLUMNS.map((c) => ({ key: c.key, label: c.label })),
    columnsNote: 'Account, Status and Owner are always shown.',
    emptyFilters: EMPTY_CRM_FILTERS,
    sections: [
      {
        key: 'status',
        title: 'Status',
        options: CRM_ACCOUNT_STATUSES.map((s) => ({ value: s, label: CRM_ACCOUNT_STATUS_LABEL[s] })),
        note:
          layout === 'board'
            ? 'On the pipeline these ARE the columns. With none picked it shows the live statuses; churned, lost and archived get a column only when you ask for them.'
            : undefined,
      },
      {
        key: 'source',
        title: 'Source',
        options: usedSources.map((s) => ({ value: s, label: CRM_ACCOUNT_SOURCE_LABEL[s] })),
      },
      { key: 'due', title: 'Next action', options: DUE_BUCKETS.map((b) => ({ value: b, label: DUE_BUCKET_LABEL[b] })) },
      { key: 'mrr', title: 'MRR', options: MRR_BUCKETS.map((b) => ({ value: b, label: MRR_BUCKET_LABEL[b] })) },
      { key: 'owner', title: 'Owner', options: usedOwners.map((o) => ({ value: o, label: ownerLabel(o) })) },
      { key: 'tags', title: 'Tags', options: tags.map((t) => ({ value: t, label: t })) },
    ],
  }
}
