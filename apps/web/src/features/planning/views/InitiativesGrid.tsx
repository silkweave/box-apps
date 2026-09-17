import { useContext, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import {
  deleteInitiative,
  deleteTask,
  moveTask,
  reorderTasks,
  setTaskStatus,
  upsertInitiative,
  upsertTask,
  usePlanningData,
} from '../lib/usePlanningData.ts'
import { useSignalsData } from '../../data/lib/useSignalsData.ts'
import { confirm, Button, GridFooter, GridHeader, PageContainer, TopBarActions, UserPicker } from '@silkweave/box-ui'
import { ShowAllContext } from '@/lib/showAll.tsx'
import { StatusSelect } from '../components/status.tsx'
import { InitiativeDialog } from '../components/InitiativeDialog.tsx'
import { DoneGateDialog, unresolvedTasks } from '../components/DoneGateDialog.tsx'
import { EditableTitle, GripHandle, QuickAddTask, RowActions } from '../components/rowParts.tsx'
import {
  DepsCell,
  DueCell,
  EffortCell,
  KindCell,
  PriorityCell,
  SignalCell,
  TagsCell,
  TaskHoursCell,
  ValueCell,
} from '../components/cells.tsx'
import { PlanningKanban } from '../components/PlanningKanban.tsx'
import { ViewBar } from '../../data/components/board/ViewBar.tsx'
import { cn } from '@/lib/utils'
import { kindLabel, useInitiativeKinds } from '../lib/initiativeKinds.ts'
import {
  PLANNING_STATUSES,
  PLANNING_STATUS_META,
  TERMINAL_PLANNING_STATUSES,
  VALUE_META,
  EFFORT_META,
  type Initiative,
  type Task,
} from '../planning-types.ts'
import type { Signal } from '../../../types.ts'
import { useActiveUser } from '../../../lib/useActiveUser.ts'
import { usePersistedState } from '../../../lib/usePersistedState.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { userName } from '../../../user-types.ts'
import { useInitiativeView } from '../lib/useInitiativeView.ts'
import {
  COLUMNS,
  PATH_ROLE_LABEL,
  allTags,
  applyView,
  dependentsOf,
  planningAggregates,
  planningBarSpec,
  planningGrid,
  type ColumnKey,
  type PlanningRow,
} from '../lib/planningView.ts'
import { useColumnAggregates, useColumnWidths } from '../../../lib/gridColumns.ts'
import { rowCountLabel } from '../../../lib/rowCount.ts'
import { appKey } from '@/lib/storage.ts'

/** Only TASKS drag. `group` is an initiative's task container, which is a drop target and never a
 *  draggable - initiatives themselves have no order to rearrange (see `planningView.ts`). */
type DragRef = { type: 'task' | 'group'; id: string }
const parseId = (raw: string | number): DragRef => {
  const s = String(raw)
  const i = s.indexOf(':')
  return { type: s.slice(0, i) as DragRef['type'], id: s.slice(i + 1) }
}

/** Human label for a group header, per axis (the raw key is an enum value or an owner name). */
function headerLabel(groupBy: string, key: string): string {
  if (groupBy === 'kind') return kindLabel(key)
  if (groupBy === 'status') return PLANNING_STATUS_META[key as keyof typeof PLANNING_STATUS_META]?.label ?? key
  if (groupBy === 'path') return PATH_ROLE_LABEL[key as keyof typeof PATH_ROLE_LABEL] ?? key
  if (groupBy === 'value') return VALUE_META[key as keyof typeof VALUE_META]?.label ?? key
  if (groupBy === 'effort') return EFFORT_META[key as keyof typeof EFFORT_META]?.label ?? key
  return key
}

/** Data-grid overview: initiatives are parent rows, tasks indent beneath them. Inline-edit + DnD. */
export function InitiativesGrid() {
  const { data } = usePlanningData()
  // Subscribed here, not just in the cells: the kind list drives group headers and the filter bar's
  // Kind facet, both of which are built by the pure view functions in planningView.ts off the cached
  // list. Without a subscription at the top they would render once, before the first load, and stay
  // stale until something else re-rendered the board.
  useInitiativeKinds()
  const signals = useSignalsData()
  const { data: users } = useUsersData()
  const { userId: activeUserId, user: activeUser, filterMine } = useActiveUser()
  const showAll = useContext(ShowAllContext)
  const navigate = useNavigate()
  const v = useInitiativeView()
  // Widths, and what the footer totals, are per-browser user settings - deliberately outside the
  // preset, though the footer's choices are keyed BY the preset you are on (see `gridColumns.ts`).
  const { widths, setWidth } = useColumnWidths(appKey('initiatives'))
  const aggregates = useColumnAggregates(appKey('initiatives'), v.selected)
  // Groups start collapsed; the expanded set is remembered per initiative across sessions.
  const [expandedIds, setExpandedIds] = usePersistedState<string[]>(
    appKey('initiatives', 'expanded'),
    [],
    (val) => Array.isArray(val) && val.every((x) => typeof x === 'string'),
  )
  const [collapsedGroups, setCollapsedGroups] = usePersistedState<string[]>(
    appKey('initiatives', 'collapsedGroups'),
    [],
    (val) => Array.isArray(val) && val.every((x) => typeof x === 'string'),
  )
  const [createOpen, setCreateOpen] = useState(false)
  const [active, setActive] = useState<DragRef | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  if (!data) return null

  const signalById = new Map<string, Signal>((signals.data?.signals ?? []).map((s) => [s.id, s]))
  const ownerName = (id: string) => {
    const u = users?.find((x) => x.id === id)
    return u ? userName(u) : id
  }
  const mineOnly = filterMine && !!activeUserId
  const board = v.view.layout === 'board'
  // On the board the STATUSES ARE THE COLUMNS, so hiding rows by status is self-contradictory: the
  // eye would empty the Done and Dropped columns and leave no way to drag anything into them. It
  // keeps governing the list, and the board just shows every status it draws a column for.
  const groups = applyView(data, v.view, { showAll: showAll || board, mineOnly, activeUserId, ownerName })
  const visible = groups.flatMap((g) => g.items)
  const dependents = dependentsOf(data)
  const tagSuggestions = allTags(data)
  // The view's own order, not the catalog's - which columns you took AND how you arranged them.
  const columns = v.view.columns.filter((k) => COLUMNS.some((c) => c.key === k))
  const grid = planningGrid(columns, widths)
  const template = grid.template

  const findTask = (id: string): Task | undefined => data.flatMap((i) => i.tasks).find((t) => t.id === id)
  const toggle = (id: string) =>
    setExpandedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]))

  const onDragStart = (e: DragStartEvent) => setActive(parseId(e.active.id))

  const onDragEnd = (e: DragEndEvent) => {
    setActive(null)
    const { active: a, over } = e
    if (!over) return
    const from = parseId(a.id)
    const o = parseId(over.id)

    // A task drag - reorder within its initiative, or move it across to another.
    const task = findTask(from.id)
    if (!task) return
    const src = task.initiative_id
    let dst: string | undefined
    let dstIndex = 0
    if (o.type === 'task') {
      const ot = findTask(o.id)
      dst = ot?.initiative_id ?? undefined
      dstIndex = data.find((i) => i.id === dst)?.tasks.findIndex((t) => t.id === o.id) ?? 0
    } else {
      dst = o.id // an initiative's whole block - drop it at the end of that initiative's tasks
      dstIndex = data.find((i) => i.id === dst)?.tasks.length ?? 0
    }
    if (!dst) return

    if (dst === src) {
      const list = data.find((i) => i.id === src)!.tasks.map((t) => t.id)
      const fi = list.indexOf(from.id)
      const ti = o.type === 'task' ? list.indexOf(o.id) : list.length - 1
      if (fi < 0 || ti < 0 || fi === ti) return
      void reorderTasks(src, arrayMove(list, fi, ti))
    } else {
      void moveTask(from.id, dst, dstIndex)
    }
  }

  if (data.length === 0)
    return (
      <div className='mx-auto max-w-3xl px-4 py-16 text-center text-body-sm text-muted-foreground'>
        No initiatives yet. Create one here, or use the <code>InitiativeUpsert</code> MCP tool
        (<code>pnpm cli InitiativeUpsert</code>).
        <div className='mt-4'>
          <Button size='sm' onClick={() => setCreateOpen(true)}>
            <Plus /> New initiative
          </Button>
        </div>
        <InitiativeDialog open={createOpen} onOpenChange={setCreateOpen} existingIds={data.map((i) => i.id)} onSaved={() => undefined} />
      </div>
    )

  const openTask = (initiativeId: string, taskId: string) =>
    void navigate({
      to: '/initiatives/$id/$taskSlug',
      params: { id: initiativeId, taskSlug: taskId.slice(initiativeId.length + 1) },
    })

  return (
    // Flush: the bar and the grid ARE the page. No heading - the breadcrumb says "Initiatives ›
    // Overview", and a serif title plus a paragraph above a data grid pushed the first row of real
    // data below the fold on a laptop.
    <PageContainer width='flush' className='flex h-full flex-col'>
      <TopBarActions>
        <Button size='sm' onClick={() => setCreateOpen(true)} className='shrink-0'>
          <Plus /> New initiative
        </Button>
      </TopBarActions>

      <ViewBar
        view={v}
        spec={{
          ...planningBarSpec(data, allTags(data), ownerName, v.view.layout),
          notice: mineOnly && activeUser ? `Only ${activeUser.nickname || activeUser.id}'s` : undefined,
        }}
      />

      {board ? (
        <div className='min-h-0 flex-1 overflow-auto p-3'>
          <PlanningKanban
            initiatives={visible}
            // A status filter picks the columns, mirroring the CRM pipeline: filtering by status on a
            // board that IS statuses can only sensibly mean "show me these lanes".
            columns={v.view.filters.status.length > 0 ? v.view.filters.status : PLANNING_STATUSES}
            onOpen={(id) => void navigate({ to: '/initiatives/$id', params: { id } })}
          />
        </div>
      ) : (
      // No frame: the grid runs edge to edge and its own row separators are the only lines it needs.
      // A bordered, rounded card around a table that wants to be wider than the screen just adds a
      // gutter of dead space on both sides of a horizontal scrollbar.
      <div className='min-h-0 flex-1 overflow-auto'>
        {/* At least as tall as the scrollport - see the note in `CrmAccountsTable`. */}
        <div style={{ minWidth: grid.minWidth }} className='flex min-h-full flex-col'>
          <GridHeader columns={grid.columns} template={template} onResize={setWidth} />

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd}>
            {groups.map((group) => {
              const collapsed = collapsedGroups.includes(group.key)
              return (
                <div key={group.key}>
                  {group.label && (
                    <button
                      type='button'
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={!collapsed}
                      className='flex w-full items-center gap-1.5 border-b border-border bg-surface px-2 py-1.5 text-left text-label font-medium text-text hover:bg-accent-tint/40'>
                      {collapsed ? <ChevronRight className='size-3.5 text-muted-foreground' /> : <ChevronDown className='size-3.5 text-muted-foreground' />}
                      {headerLabel(v.view.groupBy, group.key)}
                      <span className='text-muted-foreground tabular-nums'>{group.items.length}</span>
                    </button>
                  )}
                  {!collapsed &&
                    group.items.map((initiative) => (
                      <InitiativeBlock
                        key={initiative.id}
                        initiative={initiative}
                        template={template}
                        columns={columns}
                        dependents={dependents.get(initiative.id) ?? []}
                        expanded={expandedIds.includes(initiative.id)}
                        onToggle={() => toggle(initiative.id)}
                        signalById={signalById}
                        all={data}
                        tagSuggestions={tagSuggestions}
                        onOpen={() => void navigate({ to: '/initiatives/$id', params: { id: initiative.id } })}
                        onOpenTask={(taskId) => openTask(initiative.id, taskId)}
                      />
                    ))}
                </div>
              )
            })}
            {visible.length === 0 && (
              <p className='py-8 text-center text-body-sm text-muted-foreground'>
                Nothing matches this view. Clear the filters, or use the eye toggle on the sidebar's
                Initiatives header to include inactive work.
              </p>
            )}
            <DragOverlay>
              {active && (
                <div className='rounded-md border border-accent/50 bg-bg px-3 py-1.5 text-body-sm font-medium text-text shadow-(--shadow-md)'>
                  {findTask(active.id)?.title}
                </div>
              )}
            </DragOverlay>
          </DndContext>

          {visible.length > 0 && (
            <GridFooter
              columns={grid.columns}
              template={template}
              // The initiatives only. A nested task is a row you opened, not a row the board counted.
              label={rowCountLabel(visible.length, data.length, { one: 'initiative', many: 'initiatives' })}
              sources={planningAggregates(visible, columns)}
              store={aggregates}
            />
          )}
        </div>
      </div>
      )}

      <InitiativeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        existingIds={data.map((i) => i.id)}
        onSaved={(id) => void navigate({ to: '/initiatives/$id', params: { id } })}
      />
    </PageContainer>
  )
}

/** One initiative parent row + (when expanded) its task children, a droppable task group, and quick-add. */
function InitiativeBlock({
  initiative,
  template,
  columns,
  dependents,
  expanded,
  onToggle,
  signalById,
  all,
  tagSuggestions,
  onOpen,
  onOpenTask,
}: {
  initiative: PlanningRow
  template: string
  columns: ColumnKey[]
  dependents: string[]
  expanded: boolean
  onToggle: () => void
  signalById: Map<string, Signal>
  /** Every initiative - the dependency picker needs the candidates, not just this row. */
  all: Initiative[]
  tagSuggestions: string[]
  onOpen: () => void
  onOpenTask: (taskId: string) => void
}) {
  // A drop target, never a draggable: a task can be dragged INTO an initiative, but an initiative's
  // own place in the list is not something the board rearranges.
  //
  // The target is the WHOLE block, row included, not just the strip its tasks sit in - a collapsed
  // initiative shows no such strip, and "you can only move a task into an initiative you have already
  // opened" is not a rule anybody would guess. Tasks nested inside still win the collision when the
  // pointer is over one of them, which is what makes dropping at a POSITION work.
  const { setNodeRef: setDropRef } = useDroppable({ id: `group:${initiative.id}` })
  const [doneGateOpen, setDoneGateOpen] = useState(false)

  const onDelete = () => {
    const n = initiative.tasks.length
    void confirm({
      title: `Delete "${initiative.title}"?`,
      message: n > 0 ? `Its ${n} task(s) go with it. Docs on disk stay.` : undefined,
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => void (ok && deleteInitiative(initiative.id)))
  }
  const commit = (patch: Omit<Parameters<typeof upsertInitiative>[0], 'id'>) =>
    void upsertInitiative({ ...patch, id: initiative.id })

  // A row that is only here because one of ITS TASKS is yours: dimmed, and always open, because
  // collapsing it would hide the only thing that put it on screen.
  const viaTask = initiative.viaTaskOnly
  const open = expanded || viaTask

  return (
    <div ref={setDropRef} className='border-b border-border'>
      {/* Parent row */}
      <div
        className={cn('group grid items-center gap-2 px-2 py-2', viaTask && 'opacity-60')}
        title={viaTask ? 'Not yours - shown because a task under it is' : undefined}
        style={{ gridTemplateColumns: template }}>
        <div className='flex min-w-0 items-center gap-1'>
          <button
            type='button'
            onClick={onToggle}
            disabled={viaTask}
            aria-label={open ? 'Collapse' : 'Expand'}
            className='shrink-0 rounded p-0.5 text-muted-foreground hover:text-text disabled:opacity-40'>
            {open ? <ChevronDown className='size-4' /> : <ChevronRight className='size-4' />}
          </button>
          <EditableTitle
            value={initiative.title}
            summary={initiative.summary}
            ariaLabel='Initiative title'
            textClassName='font-medium'
            inputClassName='font-medium'
            onOpen={onOpen}
            onCommit={(val) => val.trim() && val !== initiative.title && commit({ title: val.trim() })}
          />
          <TaskCountBadge initiative={initiative} />
        </div>
        <StatusSelect
          value={initiative.status}
          onChange={(s) => {
            // `done` is gated: refuse while tasks are still open and explain why in a dialog.
            if (s === 'done' && unresolvedTasks(initiative).length > 0) return setDoneGateOpen(true)
            commit({ status: s })
          }}
          className='w-full'
        />
        <UserPicker value={initiative.owner} onChange={(id) => commit({ owner: id ?? '' })} className='w-full' />
        {columns.map((key) => (
          <Cell
            key={key}
            column={key}
            initiative={initiative}
            dependents={dependents}
            signalById={signalById}
            all={all}
            tagSuggestions={tagSuggestions}
            commit={commit}
          />
        ))}
        <RowActions onDelete={onDelete} />
      </div>

      {/* Children */}
      {open && (
        <div className='pb-1'>
          <SortableContext items={initiative.visibleTasks.map((t) => `task:${t.id}`)} strategy={verticalListSortingStrategy}>
            {initiative.visibleTasks.map((task) => (
              <TaskGridRow
                key={task.id}
                task={task}
                template={template}
                columns={columns}
                tagSuggestions={tagSuggestions}
                onOpen={() => onOpenTask(task.id)}
              />
            ))}
          </SortableContext>
          {!viaTask && <QuickAddTask initiative={initiative} className='pl-14' />}
        </div>
      )}

      <DoneGateDialog initiative={initiative} open={doneGateOpen} onOpenChange={setDoneGateOpen} />
    </div>
  )
}

/**
 * One optional column's cell for an initiative row. Every one of them writes: the board is where
 * triage happens, so judging a dimension has to be a click here rather than a trip to the detail view.
 */
function Cell({
  column,
  initiative,
  dependents,
  signalById,
  all,
  tagSuggestions,
  commit,
}: {
  column: ColumnKey
  initiative: Initiative
  dependents: string[]
  signalById: Map<string, Signal>
  all: Initiative[]
  tagSuggestions: string[]
  commit: (patch: Omit<Parameters<typeof upsertInitiative>[0], 'id'>) => void
}) {
  switch (column) {
    case 'kind':
      return <KindCell value={initiative.kind} onChange={(kind) => commit({ kind })} />
    case 'value_customer':
      return (
        <ValueCell
          value={initiative.value_customer}
          hue='customer'
          axis='Customer value'
          onChange={(value_customer) => commit({ value_customer })}
        />
      )
    case 'value_company':
      return (
        <ValueCell
          value={initiative.value_company}
          hue='company'
          axis='Company value'
          onChange={(value_company) => commit({ value_company })}
        />
      )
    case 'effort':
      return <EffortCell initiative={initiative} />
    case 'priority':
      return <PriorityCell value={initiative.priority} onChange={(priority) => commit({ priority: priority ?? 0 })} />
    case 'due':
      return <DueCell row={initiative} onChange={(due_date) => commit({ due_date })} />
    case 'signal':
      return <SignalCell initiative={initiative} signalById={signalById} onChange={(signal_ids) => commit({ signal_ids })} />
    case 'tags':
      return <TagsCell tags={initiative.tags} suggestions={tagSuggestions} onChange={(tags) => commit({ tags })} />
    case 'deps':
      return (
        <DepsCell
          initiative={initiative}
          all={all}
          dependents={dependents}
          // The server refuses cycles and unknown ids; surface its reason rather than silently
          // leaving the picker showing an edit that never landed.
          onChange={(ids) =>
            void upsertInitiative({ id: initiative.id, blocked_by: ids }).catch((err: unknown) =>
              window.alert(err instanceof Error ? err.message : String(err)),
            )
          }
        />
      )
    default:
      return <span />
  }
}

function TaskGridRow({
  task,
  template,
  columns,
  tagSuggestions,
  onOpen,
}: {
  task: Task
  template: string
  columns: ColumnKey[]
  tagSuggestions: string[]
  onOpen: () => void
}) {
  const sortable = useSortable({ id: `task:${task.id}` })
  const onDelete = () => {
    void confirm({
      title: `Delete task "${task.title}"?`,
      message: 'Its doc on disk stays.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => void (ok && deleteTask(task.id)))
  }
  return (
    <div
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition, gridTemplateColumns: template }}
      className={cn('group grid items-center gap-2 px-2 py-1 hover:bg-accent-tint/30', sortable.isDragging && 'opacity-50')}>
      <div className='flex min-w-0 items-center gap-1 pl-6'>
        <GripHandle attributes={sortable.attributes} listeners={sortable.listeners} />
        <EditableTitle
          value={task.title}
          summary={task.summary}
          ariaLabel='Task title'
          onOpen={onOpen}
          onCommit={(val) => val.trim() && val !== task.title && void upsertTask({ id: task.id, title: val.trim() })}
        />
      </div>
      <StatusSelect value={task.status} onChange={(s) => void setTaskStatus(task.id, s)} className='w-full' />
      <UserPicker value={task.assignee} onChange={(id) => void upsertTask({ id: task.id, assignee: id ?? '' })} className='w-full' />
      {columns.map((key) => (
        <span key={key} className='min-w-0'>
          {/* The dimensions a task shares with its initiative, edited the same way on both rows -
              except Size, which the two rows read differently on purpose: a task carries the ESTIMATE
              you set, its initiative carries the SUM, and only the task's is editable. The value axes
              stay initiative-only. */}
          {key === 'effort' && (
            <TaskHoursCell
              value={task.estimate_hours}
              onChange={(h) => void upsertTask({ id: task.id, estimate_hours: h ?? 0 })}
            />
          )}
          {key === 'priority' && (
            <PriorityCell value={task.priority} onChange={(priority) => void upsertTask({ id: task.id, priority: priority ?? 0 })} />
          )}
          {key === 'due' && <DueCell row={task} onChange={(due_date) => void upsertTask({ id: task.id, due_date })} />}
          {key === 'tags' && (
            <TagsCell
              tags={task.tags}
              suggestions={tagSuggestions}
              max={2}
              onChange={(tags) => void upsertTask({ id: task.id, tags })}
            />
          )}
        </span>
      ))}
      <RowActions onDelete={onDelete} />
    </div>
  )
}

/**
 * How many tasks are under this initiative, as a small outline badge on the title line - the number
 * the old 116px Tasks column existed to give, in the place your eye already is (right next to the
 * caret that opens them). The breakdown it used to spell out lives in the tooltip, where a
 * three-part count belongs.
 */
function TaskCountBadge({ initiative }: { initiative: Initiative }) {
  const n = initiative.tasks.length
  if (n === 0) return null
  const open = initiative.tasks.filter((t) => !TERMINAL_PLANNING_STATUSES.includes(t.status)).length
  return (
    <span
      title={`${n} task${n === 1 ? '' : 's'} · ${open} still open`}
      className='ml-auto shrink-0 rounded border border-border-light px-1.5 text-label leading-4 text-muted-foreground tabular-nums'>
      {n}
    </span>
  )
}
