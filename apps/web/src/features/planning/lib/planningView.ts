// The Initiatives board's view model: which rows show, how they group, which optional columns
// render. Kept out of the grid component because three things need it - the grid, the board bar, and
// the default presets - and because the rules below are the whole anti-overwhelm story:
//
//   • every filterable dimension is a short enum, so a filter is a chip and never a text box;
//   • optional columns are opt-in, so the default board is the same six columns it always was;
//   • the "chapters" a plan reads as (critical path, fix first, product, growth) are VIEWS over
//     these fields, not stored state - which is why there is no `chapter` column anywhere.
//
// State persists under `<APP_STORAGE_PREFIX>.initiatives.*` (usePersistedState, keyed through
// `appKey()` - see lib/storage.ts), the same convention the
// Content and Signals boards use for their group-by.

import {
  EFFORTS,
  EFFORT_HINT,
  EFFORT_META,
  PLANNING_STATUSES,
  PLANNING_STATUS_META,
  TERMINAL_PLANNING_STATUSES,
  VALUE_LEVELS,
  VALUE_META,
  type Effort,
  type Initiative,
  type InitiativeKind,
  type PlanningStatus,
  type Task,
  type ValueLevel,
} from '../planning-types.ts'
import { kindIds, kindLabel } from './initiativeKinds.ts'
import { rollupEffort } from './effort.ts'
import { KanbanSquare, List } from 'lucide-react'
import { todayLocal } from '@silkweave/box-ui'
import type { ViewBarSpec } from '../../data/components/board/ViewBar.tsx'
import { pickEnum, sameOrder, type BaseViewState, type BoardLayout } from '../../data/lib/boardView.ts'
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
import { isStringArray } from '../../../lib/guards.ts'

// --- due dates -------------------------------------------------------------------------------

/**
 * Is this row late? A display judgment, never stored: the date is past AND the work is still open.
 * "Today" is the VIEWER's local day - "is this late?" is a question asked inside a working day, and
 * nothing downstream reads this (signal health uses UTC because it is computed server-side against
 * UTC buckets; no such constraint here).
 */
export function isOverdue(row: { due_date: string | null; status: PlanningStatus }): boolean {
  if (!row.due_date) return false
  if (TERMINAL_PLANNING_STATUSES.includes(row.status)) return false
  return row.due_date < todayLocal()
}

/**
 * Due TODAY, on the viewer's local day - the one date that is neither late nor comfortably ahead,
 * and the board tones it amber for exactly that reason. Terminal work is never "due" anything.
 */
export function isDueToday(row: { due_date: string | null; status: PlanningStatus }): boolean {
  if (!row.due_date) return false
  if (TERMINAL_PLANNING_STATUSES.includes(row.status)) return false
  return row.due_date === todayLocal()
}

/** The filterable buckets a date collapses into - a date is not chip-shaped, but its buckets are. */
export type DueBucket = 'overdue' | 'this_week' | 'later' | 'none'
export const DUE_BUCKETS: DueBucket[] = ['overdue', 'this_week', 'later', 'none']

export const DUE_BUCKET_META: Record<DueBucket, { label: string }> = {
  overdue: { label: 'Overdue' },
  this_week: { label: 'This week' },
  later: { label: 'Later' },
  none: { label: 'No due date' },
}

/** `this_week` is today through +6 days; anything earlier and still open is overdue. */
function plusDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + n)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Which bucket a row falls in. A past date on CLOSED work is not overdue - it is just `later`'s past. */
export function dueBucket(row: { due_date: string | null; status: PlanningStatus }): DueBucket {
  if (!row.due_date) return 'none'
  if (isOverdue(row)) return 'overdue'
  const today = todayLocal()
  if (row.due_date >= today && row.due_date <= plusDays(today, 6)) return 'this_week'
  return 'later'
}

// --- the dependency graph --------------------------------------------------------------------

/** id → the initiatives that wait on it. An initiative with dependents is a *foundation*. */
export function dependentsOf(initiatives: Initiative[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const i of initiatives) {
    for (const dep of i.blocked_by) out.set(dep, [...(out.get(dep) ?? []), i.id])
  }
  return out
}

export type PathRole = 'foundation' | 'blocked' | 'free-standing'

/** Where a row sits on the critical path. Foundation wins: a thing can both block and be blocked. */
export function pathRole(i: Initiative, dependents: Map<string, string[]>): PathRole {
  if ((dependents.get(i.id)?.length ?? 0) > 0) return 'foundation'
  if (i.blocked_by.length > 0) return 'blocked'
  return 'free-standing'
}

export const PATH_ROLE_LABEL: Record<PathRole, string> = {
  foundation: 'Foundation',
  blocked: 'Blocked',
  'free-standing': 'Free-standing',
}

// --- columns ---------------------------------------------------------------------------------

export type ColumnKey =
  | 'kind'
  | 'value_customer'
  | 'value_company'
  | 'effort'
  | 'priority'
  | 'due'
  | 'signal'
  | 'tags'
  | 'deps'

/**
 * The optional columns, in the order they are OFFERED. **No `tasks` column since 2026-08-24** - a
 * 116px cell spelling out "0 active · 2 todo · 3 done" for every row was a paragraph in a grid, and
 * the number people actually scan for is "how many are under here". That is now a badge on the name
 * itself, next to the caret that opens them (see `InitiativesGrid`). What renders, and in what order, is view
 * state (`ViewState.columns`). `width` is a DEFAULT - a person can drag any column wider, and that
 * stays with their browser. `hint` is the header tooltip, the legend that makes a meter readable
 * without a key on the page.
 *
 * The three dimension columns were one compressed "Value / Size" cell until 2026-08-10. Splitting
 * them is what a full-width board buys: each axis gets a header saying which axis it is, so a
 * reader never has to remember whether `C` meant customer or company.
 *
 * `agg` is what makes a column TOTALLABLE in the footer. Only `tasks` carries one, and the omission
 * on the value axes is the deliberate part: they are ORDERED LABELS, not quantities, so summing them
 * would print a number with no unit that reads like a measurement. Size is a real quantity now
 * (hours), but half the tasks in any board carry no estimate, so a board-wide total would be a floor
 * presented as a sum - the per-row meter says that honestly and a footer number could not.
 */
export const COLUMNS: { key: ColumnKey; label: string; width: string; hint?: string; agg?: Aggregatable<Initiative> }[] = [
  { key: 'kind', label: 'Kind', width: '120px' },
  {
    key: 'value_customer',
    label: 'Customer',
    width: '84px',
    hint: 'Worth to the people we serve. Three segments: Low · Med · High. Empty meter = judged as None; a dot = not judged yet.',
  },
  {
    key: 'value_company',
    label: 'Company',
    width: '84px',
    hint: 'Worth to us - revenue, retention, differentiation, our own operating leverage. Same scale as Customer.',
  },
  {
    key: 'effort',
    label: 'Size',
    // 148px: the column carries the initiative's read-only meter AND, on the task rows nested under
    // it, the eight-segment estimate picker (8 x 16px plus its rules).
    width: '148px',
    hint:
      'The sum of the tasks\' estimates, bucketed: SM under a day · MD a day to a week · LG a week to a month · XL ' +
      'more. Always derived, never set. A hollow meter means some tasks carry no estimate, so the total is a floor.',
  },
  {
    key: 'priority',
    label: 'Priority',
    width: '84px',
    hint: 'How much it matters: 1-3 stars. Click a star to set it, click it again to clear.',
  },
  {
    key: 'due',
    label: 'Due',
    width: '96px',
    hint: 'Deadline. Amber on the day it is due, red once it is past and the work is still open.',
  },
  { key: 'signal', label: 'Signal / Target', width: '200px' },
  { key: 'tags', label: 'Tags', width: '160px' },
  {
    key: 'deps',
    label: 'Depends on',
    width: '150px',
    hint: 'Foundation = other initiatives wait on this one. Otherwise what it waits on.',
  },
]

/**
 * Name (flexes, 220px floor), Status, Owner … the optional columns … the action cluster.
 *
 * The header's Name label carries the row's own left padding, so it sits over the title rather than
 * over the expand caret that precedes it.
 */
const PLANNING_GRID: GridSpec = {
  name: { key: 'name', label: 'Name', min: 220, labelClass: 'pl-6' },
  fixed: [
    { key: 'status', label: 'Status', width: 150 },
    { key: 'owner', label: 'Owner', width: 110 },
  ],
  actions: 72,
}

/**
 * The header columns, the grid template and the width the rows need - the view's column ORDER and
 * this browser's column WIDTHS resolved into one layout.
 *
 * The min-width matters as much as the template: a hard-coded one cannot follow this, because
 * turning a column on (or dragging one wider) changes the answer, and a block-level child sized at
 * 100% of its parent overflows silently rather than growing the scrollable area.
 */
export const planningGrid = (columns: readonly string[], widths: ColumnWidths): GridLayout =>
  buildGrid(PLANNING_GRID, orderColumns(COLUMNS, columns), widths)

/** The numbers behind the footer row - read from the initiatives the view actually SHOWS, so a total
 *  answers "what am I looking at" rather than "what is in the table". */
export const planningAggregates = (rows: Initiative[], columns: readonly string[]): AggregateSources =>
  aggregateSources(rows, columns, COLUMNS)

// --- view state ------------------------------------------------------------------------------

/** How the board draws itself. The list is the full-fidelity surface (every column, tasks nested and
 *  draggable); the board is the status-at-a-glance one, columns being the statuses. */

export type GroupBy = 'none' | 'kind' | 'status' | 'owner' | 'effort' | 'value' | 'path'

export interface Filters {
  kind: InitiativeKind[]
  status: PlanningStatus[]
  owner: string[]
  effort: Effort[]
  value_customer: ValueLevel[]
  value_company: ValueLevel[]
  due: DueBucket[]
  tags: string[]
}

/**
 * INITIATIVES HAVE NO SORT AXIS (a product decision, 2026-08-13). Every other board offers one; this one does
 * not, and the omission is the feature. An initiative's place in the list is its own - the order the
 * plan was written in - and a picker that could re-rank it by value, size or title made that order a
 * setting nobody could rely on, three people arriving at the same board through three different
 * arrangements of it. Only TASKS are arranged by hand, per initiative, by dragging them.
 */
export interface ViewState extends BaseViewState {
  layout: BoardLayout
  groupBy: GroupBy
  filters: Filters
  columns: ColumnKey[]
  search: string
}

export const EMPTY_FILTERS: Filters = {
  kind: [],
  status: [],
  owner: [],
  effort: [],
  value_customer: [],
  value_company: [],
  due: [],
  tags: [],
}

/**
 * The judgement columns, as a unit - the shape the old single `value` column expands into. Priority
 * joined them on 2026-08-24: it is the axis a board is actually sorted by, so a preset that shows
 * worth and size and hides how much it matters is showing two thirds of the argument.
 */
export const VALUE_COLUMNS: ColumnKey[] = ['value_customer', 'value_company', 'effort', 'priority']

export const DEFAULT_VIEW: ViewState = {
  layout: 'list',
  groupBy: 'none',
  filters: EMPTY_FILTERS,
  columns: [...VALUE_COLUMNS, 'signal'],
  search: '',
}

export const GROUP_BY_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'kind', label: 'Kind' },
  { value: 'status', label: 'Status' },
  { value: 'owner', label: 'Owner' },
  { value: 'value', label: 'Value' },
  { value: 'effort', label: 'Size' },
  { value: 'path', label: 'Path' },
]

/**
 * The DEFAULT presets. Each is a lens over the same rows - deliberately NOT a stored field on the
 * initiative, because an item belongs to several of these at once and a column would have to pick
 * one.
 *
 * A SEED, not a floor (2026-08-12): these are written into the team's shared list the first time
 * anybody opens Initiatives, and from that moment they are ordinary editable records like any other.
 */
export const PLANNING_DEFAULT_PRESETS: { name: string; description: string; icon: string; state: ViewState }[] = [
  {
    name: 'Everything',
    icon: 'layout-grid',
    description: 'The default board - nothing filtered.',
    state: DEFAULT_VIEW,
  },
  {
    name: 'Board',
    icon: 'kanban',
    description: 'Status columns - drag an initiative to move it.',
    state: { ...DEFAULT_VIEW, layout: 'board' },
  },
  {
    name: 'Critical path',
    icon: 'git-branch',
    description: 'Foundations first, then what waits on them.',
    state: { ...DEFAULT_VIEW, groupBy: 'path', columns: [...VALUE_COLUMNS, 'deps'] },
  },
  {
    name: 'Product',
    icon: 'package',
    description: 'Product work, new capabilities, bugs and infra.',
    state: {
      ...DEFAULT_VIEW,
      groupBy: 'kind',
      filters: { ...EMPTY_FILTERS, kind: ['product', 'capability', 'bug', 'infra'] },
      columns: [...VALUE_COLUMNS, 'deps'],
    },
  },
  {
    name: 'Growth',
    icon: 'trending-up',
    description: 'Content, channel growth and OSS contribution.',
    state: {
      ...DEFAULT_VIEW,
      groupBy: 'kind',
      filters: { ...EMPTY_FILTERS, kind: ['channel-growth', 'oss-pr'] },
      columns: [...VALUE_COLUMNS, 'signal'],
    },
  },
  {
    name: 'Business',
    icon: 'briefcase',
    description: 'Company decisions, strategy and business bets.',
    state: {
      ...DEFAULT_VIEW,
      groupBy: 'kind',
      filters: { ...EMPTY_FILTERS, kind: ['business', 'strategy', 'decision'] },
      columns: [...VALUE_COLUMNS],
    },
  },
  {
    name: 'Quick wins',
    icon: 'zap',
    description: 'High customer value, small enough to just do.',
    state: {
      ...DEFAULT_VIEW,
      filters: { ...EMPTY_FILTERS, value_customer: ['high'], effort: ['s', 'm'] },
      columns: ['kind', ...VALUE_COLUMNS],
    },
  },
]

// --- applying a view -------------------------------------------------------------------------

const matches = <T extends string>(selected: T[], value: T | null): boolean =>
  selected.length === 0 || (value != null && selected.includes(value))

/**
 * An initiative as the board draws it, once a PERSON SCOPE (the owner filter, or the global "only
 * mine" toggle) or a STATUS FILTER is in play. Two things a bare `Initiative` cannot say:
 *
 *   • `visibleTasks` - the tasks that survived the scope AND the status filter. Filtering by a person
 *     means "show me MY work", so somebody else's tasks drop out of an initiative even when the
 *     initiative is mine; filtering by status means the same thing one row down, so a task whose
 *     status was not asked for drops out too.
 *     `tasks` is left WHOLE on purpose: the Done gate and the task counts are statements about the
 *     initiative, and they would start lying if they only saw one person's slice.
 *   • `viaTaskOnly` - this initiative is not yours; it is on screen because a task under it is.
 *     Drawn dimmed, and expanded, since the row's entire reason for being here is underneath it.
 */
export interface PlanningRow extends Initiative {
  visibleTasks: Task[]
  viaTaskOnly: boolean
}

export interface Group {
  key: string
  label: string
  items: PlanningRow[]
}

/** The label a row groups under, per group-by axis. */
function groupLabel(i: Initiative, groupBy: GroupBy, dependents: Map<string, string[]>, ownerName: (id: string) => string): string {
  switch (groupBy) {
    case 'kind':
      return i.kind
    case 'status':
      return i.status
    case 'owner':
      return i.owner ? ownerName(i.owner) : 'Unassigned'
    case 'effort':
      // Derived, like every other reading of an initiative's size: the bucket its summed hours fall in.
      return rollupEffort(i).tier ?? 'Unsized'
    case 'value':
      return i.value_customer ?? 'Unscored'
    case 'path':
      return pathRole(i, dependents)
    default:
      return ''
  }
}

/** Stable group ordering per axis - enum order, not alphabetical, so "high" never sits under "low". */
const GROUP_ORDER: Partial<Record<GroupBy, string[]>> = {
  path: ['foundation', 'blocked', 'free-standing'],
  value: ['high', 'med', 'low', 'none', 'Unscored'],
  effort: ['s', 'm', 'l', 'xl', 'Unsized'],
}

export interface ApplyContext {
  /** The global eye toggle - when off, only planned/active rows show. */
  showAll: boolean
  /** The global "only my items" scope. */
  mineOnly: boolean
  activeUserId: string | null
  ownerName: (id: string) => string
}

/**
 * Filter → group, in that order - there is no sort step, and there is no sort axis to run one on
 * (see `ViewState`). Rows keep the order the server hands them over in, which is the plan's own.
 * Returns one group with an empty label when `groupBy` is 'none', so the grid renders groups
 * uniformly either way.
 *
 * The `showAll` default (planned/active only) is DEFERRED to whenever the view sets an explicit
 * status filter - otherwise picking a view like "everything blocked" would silently return nothing.
 *
 * Two of the filters reach the TASKS nested under a row as well as the row itself - the person scope
 * (2026-08-24) and status (2026-09-09). Both narrow `visibleTasks`; see `PlanningRow`.
 */
export function applyView(initiatives: Initiative[], view: ViewState, ctx: ApplyContext): Group[] {
  const dependents = dependentsOf(initiatives)
  const q = view.search.trim().toLowerCase()
  const hasStatusFilter = view.filters.status.length > 0
  // The person scope: an explicit owner filter, or the global "only mine" toggle standing in for one.
  // Both mean the same question - "what is MINE here" - and since 2026-08-24 that question reaches
  // TASKS too, because half of anyone's work sits under somebody else's initiative.
  const scope = view.filters.owner.length > 0 ? view.filters.owner : ctx.mineOnly && ctx.activeUserId ? [ctx.activeUserId] : []

  const rows = initiatives
    .map((i): PlanningRow => {
      const mine = scope.length === 0 || scope.includes(i.owner ?? '')
      // Both narrowings that reach TASKS, in one pass. A filter the board applies to initiatives and
      // not to the rows nested under them reads as broken: ask for "blocked" and every open task of a
      // blocked initiative is still on screen, none of them blocked. Status is the same question asked
      // of the child rows, so it answers there too.
      const scoped = i.tasks.filter(
        (t) => (scope.length === 0 || scope.includes(t.assignee ?? '')) && matches(view.filters.status, t.status),
      )
      return { ...i, visibleTasks: scoped, viaTaskOnly: !mine }
    })
    .filter((i) => {
      // In scope when the initiative is yours OR at least one task under it is. An initiative you do
      // not own and have no task in is not your business, however it is grouped.
      if (scope.length > 0 && i.viaTaskOnly && i.visibleTasks.length === 0) return false
      if (!hasStatusFilter && !ctx.showAll && i.status !== 'planned' && i.status !== 'active') return false
      if (!matches(view.filters.status, i.status)) return false
      if (!matches(view.filters.kind, i.kind)) return false
      if (!matches(view.filters.effort, rollupEffort(i).tier)) return false
      if (!matches(view.filters.value_customer, i.value_customer)) return false
      if (!matches(view.filters.value_company, i.value_company)) return false
      if (!matches(view.filters.due, dueBucket(i))) return false
      if (view.filters.tags.length > 0 && !view.filters.tags.every((t) => i.tags.includes(t))) return false
      if (q) {
        const haystack = `${i.title} ${i.summary} ${i.id} ${i.tags.join(' ')}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })

  if (view.groupBy === 'none') return [{ key: 'all', label: '', items: rows }]

  const byKey = new Map<string, PlanningRow[]>()
  for (const i of rows) {
    const key = groupLabel(i, view.groupBy, dependents, ctx.ownerName)
    byKey.set(key, [...(byKey.get(key) ?? []), i])
  }
  const order = GROUP_ORDER[view.groupBy]
  const keys = [...byKey.keys()].sort((a, b) => {
    if (order) {
      const ia = order.indexOf(a)
      const ib = order.indexOf(b)
      if (ia !== ib) return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib)
    }
    return a.localeCompare(b)
  })
  return keys.map((key) => ({ key, label: key, items: byKey.get(key)! }))
}

// --- reading stored view state ---------------------------------------------------------------

/**
 * Column keys that no longer exist, and what they became. A stored view is a user's own work, so a
 * renamed column MIGRATES rather than resetting the view - `value` was one cell carrying all three
 * dimensions, so it expands into all three columns in place.
 */
const LEGACY_COLUMNS: Record<string, ColumnKey[]> = { value: VALUE_COLUMNS }

const COLUMN_KEYS = new Set<string>(COLUMNS.map((c) => c.key))

/** Expand legacy keys, drop unknown ones, de-duplicate - and KEEP THE STORED ORDER, which is the
 *  render order now (it used to be COLUMNS' own order, and a stored view could not say otherwise). */
function normalizeColumns(raw: unknown): ColumnKey[] {
  if (!isStringArray(raw)) return DEFAULT_VIEW.columns
  const out = raw.flatMap((k) => LEGACY_COLUMNS[k] ?? (COLUMN_KEYS.has(k) ? [k as ColumnKey] : []))
  return [...new Set(out)]
}

/**
 * Read one stored `ViewState`, repairing what can be repaired and returning null only when the
 * value is not a view at all (the caller then falls back to the default). Every field is checked
 * against the CURRENT vocabulary, so a value retired in a later release degrades to the default
 * for that field instead of poisoning the whole board.
 */
export function normalizeViewState(raw: unknown): ViewState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  if (!('columns' in v) && !('filters' in v) && !('groupBy' in v)) return null

  const filters = (v.filters ?? {}) as Record<string, unknown>
  // `sort`/`sortDir` are read off nothing on purpose: a view stored while the board still had a sort
  // picker simply loses it, which is what retiring an axis means.
  return {
    layout: pickEnum<BoardLayout>(v.layout, ['list', 'board'], DEFAULT_VIEW.layout),
    groupBy: GROUP_BY_OPTIONS.some((o) => o.value === v.groupBy) ? (v.groupBy as GroupBy) : DEFAULT_VIEW.groupBy,
    columns: normalizeColumns(v.columns),
    search: typeof v.search === 'string' ? v.search : '',
    filters: Object.fromEntries(
      (Object.keys(EMPTY_FILTERS) as (keyof Filters)[]).map((k) => [k, isStringArray(filters[k]) ? filters[k] : []]),
    ) as unknown as Filters,
  }
}

/** Every tag in use, for the filter picker. */
export function allTags(initiatives: Initiative[]): string[] {
  return [...new Set(initiatives.flatMap((i) => i.tags))].sort()
}

/** How many filter dimensions are narrowing the board right now (drives the "Filter · n" badge). */
export function activeFilterCount(view: ViewState): number {
  return Object.values(view.filters).reduce((n, list) => n + (list.length > 0 ? 1 : 0), 0) + (view.search.trim() ? 1 : 0)
}

/**
 * Structural equality, so the bar can tell "you are on a preset" from "you edited it".
 * Compared field by field rather than by JSON string: a stored view is rebuilt by
 * `normalizeViewState`, and object key order is not guaranteed to survive that round trip - which
 * would make a reloaded preset read as a "Custom view" for no visible reason. Columns compare IN
 * ORDER, though: rearranging them is an edit, the same as turning one on.
 */
export function sameView(a: ViewState, b: ViewState): boolean {
  const sameList = (x: string[], y: string[]) => x.length === y.length && [...x].sort().join() === [...y].sort().join()
  return (
    a.layout === b.layout &&
    a.groupBy === b.groupBy &&
    a.search.trim() === b.search.trim() &&
    sameOrder(a.columns, b.columns) &&
    (Object.keys(EMPTY_FILTERS) as (keyof Filters)[]).every((k) => sameList(a.filters[k], b.filters[k]))
  )
}

// --- the bar ------------------------------------------------------------------------------------

/**
 * What the shared `ViewBar` needs to render the Initiatives controls. Everything here is
 * `{value, label}` pairs: the bar never learns what a kind or a value level MEANS, which is what lets
 * one component serve three modules.
 *
 * Built per render rather than declared as a constant because half of it depends on what is actually
 * on the board - a filter for a kind nobody uses, or an owner with no initiatives, is noise.
 */
export function planningBarSpec(
  initiatives: Initiative[],
  tags: string[],
  ownerLabel: (id: string) => string,
  layout: BoardLayout,
): ViewBarSpec {
  // Every configured lane, plus any kind a row still carries that the list no longer has (a lane
  // deleted while empty and then re-used, or a hand-edited config file). Filtering the CONFIG by
  // what is in use would hide an empty lane you are about to file work into; filtering the ROWS by
  // the config would hide rows entirely.
  const configured = kindIds()
  const usedKinds = [...configured, ...new Set(initiatives.map((i) => i.kind).filter((k) => k && !configured.includes(k)))]
  const usedOwners = [...new Set(initiatives.map((i) => i.owner).filter((o): o is string => !!o))]
  return {
    noun: 'initiatives',
    savesHint: 'the current layout, filters, grouping and columns',
    searchPlaceholder: 'Search title, id, tags…',
    layouts: [
      { value: 'list', label: 'List', icon: List },
      { value: 'board', label: 'Board', icon: KanbanSquare },
    ],
    groupBy: GROUP_BY_OPTIONS,
    // No sort axis at all - see `ViewState`. The bar draws no sort control for an empty list.
    sort: [],
    columns: COLUMNS.map((c) => ({ key: c.key, label: c.label })),
    columnsNote: 'Name, Status and Owner are always shown.',
    emptyFilters: EMPTY_FILTERS,
    sections: [
      { key: 'kind', title: 'Kind', options: usedKinds.map((k) => ({ value: k, label: kindLabel(k) })) },
      {
        key: 'status',
        title: 'Status',
        options: PLANNING_STATUSES.map((s) => ({ value: s, label: PLANNING_STATUS_META[s].label })),
        note: layout === 'board' ? 'On the board these ARE the columns. With none picked it shows all five.' : undefined,
      },
      {
        key: 'value_customer',
        title: 'Customer value',
        options: VALUE_LEVELS.map((l) => ({ value: l, label: VALUE_META[l].label })),
      },
      {
        key: 'value_company',
        title: 'Company value',
        options: VALUE_LEVELS.map((l) => ({ value: l, label: VALUE_META[l].label })),
      },
      {
        key: 'effort',
        title: 'Size',
        options: EFFORTS.map((e) => ({ value: e, label: `${EFFORT_META[e].label} · ${EFFORT_HINT[e]}` })),
      },
      { key: 'due', title: 'Due', options: DUE_BUCKETS.map((b) => ({ value: b, label: DUE_BUCKET_META[b].label })) },
      { key: 'owner', title: 'Owner', options: usedOwners.map((o) => ({ value: o, label: ownerLabel(o) })) },
      { key: 'tags', title: 'Tags', options: tags.map((t) => ({ value: t, label: t })) },
    ],
  }
}
