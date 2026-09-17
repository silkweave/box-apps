// The initiative detail view's task list - ONE flat, editable, reorderable GRID.
//
// It replaced a status TAB BAR (2026-08-24). The tabs were five clicks hiding a handful of rows:
// almost every initiative here has fewer than eight tasks, so "Active (2) · Planned (3) · Blocked
// (0) · Done (4) · Dropped (0)" spent a whole row of chrome to hide four items and made the one
// question you actually open an initiative to answer - what is left - a thing you had to
// reconstruct by clicking through tabs. A flat list answers it by being read.
//
// It is a real grid, on the same machinery the three board grids use (`lib/gridColumns.ts` +
// `GridHeader`): labelled headers, drag-to-resize, and a column picker. Both settings are
// per-browser localStorage and nothing else - a detail view has no preset to belong to, and how wide
// you like the Due column is not a fact about the initiative.
//
// The rows are the board's rows: same title/priority/estimate/due/assignee/status controls, same
// quick-add, same drag-to-reorder.
//
// **Every task is in the one list, in rank order** - done and dropped included (2026-09-08). They
// used to sit behind a "3 done or dropped" fold at the bottom, which is the tab bar's mistake in
// miniature: it hid work you had just finished, and it moved a row the moment its status changed,
// so the list you were reading rearranged itself under you. Terminal rows read muted and drag like
// any other, because rank is the plan's order and finishing something does not remove it from it.
//
// The eye beside the column picker can hide them anyway (2026-09-08), and it **defaults to SHOW**
// so the above stays the behaviour you get: it is an opt-out for the initiative where finished rows
// are drowning the open ones, not a return of the fold. It is one per-browser preference for every
// initiative, because "I am reading these lists in a hurry today" is a fact about the reader.
// Reordering still works over the FULL list - a drag moves the row to the dragged-over row's place
// among all the tasks, so hidden rows keep their rank rather than being shuffled by an edit that
// could not see them.

import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Check, Columns3, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { confirm, GridHeader, Popover, PopoverContent, PopoverTrigger, UserPicker } from '@silkweave/box-ui'
import { ShowAllButton } from '@/lib/showAll.tsx'
import { StatusSelect } from './status.tsx'
import { DueCell, PriorityCell, TagsCell, TaskHoursCell } from './cells.tsx'
import { EditableTitle, GripHandle, QuickAddTask, RowActions } from './rowParts.tsx'
import { deleteTask, reorderTasks, setTaskStatus, upsertTask } from '../lib/usePlanningData.ts'
import { formatNumber } from '../../../lib/format.ts'
import { usePersistedState } from '../../../lib/usePersistedState.ts'
import { buildGrid, orderColumns, useColumnWidths, type ColumnDef, type GridSpec } from '../../../lib/gridColumns.ts'
import { TERMINAL_PLANNING_STATUSES, type Initiative, type Task } from '../planning-types.ts'
import { appKey } from '@/lib/storage.ts'

/** The columns a task row can show, in the order they are OFFERED. Name + delete are not optional. */
export const TASK_COLUMNS: ColumnDef[] = [
  { key: 'status', label: 'Status', width: '150px' },
  { key: 'assignee', label: 'Owner', width: '110px' },
  {
    key: 'priority',
    label: 'Priority',
    width: '84px',
    hint: 'How much it matters: 1-3 stars. Click a star to set it, click it again to clear.',
  },
  {
    // The key stays `effort` even though the scale is hours now: it is the id in every reader's
    // localStorage column choice, and renaming it would silently drop the column for all of them.
    key: 'effort',
    label: 'Estimate',
    // Wide enough for the four-segment picker (4 x 24px + its rules), which is the whole reason a
    // row can be estimated in one click.
    width: '124px',
    hint: 'How long it should take, in hours - 4+ is the top step, because a longer task should be split rather than estimated. The initiative’s size is the sum of these, so an unestimated task makes that total a floor.',
  },
  {
    key: 'due',
    label: 'Due',
    width: '96px',
    hint: 'Deadline. Amber on the day it is due, red once it is past and the work is still open.',
  },
  { key: 'tags', label: 'Tags', width: '140px' },
]

const TASK_COLUMN_KEYS = TASK_COLUMNS.map((c) => c.key)

/** Name flexes, the delete button gets the trailing slot, and the grip rides inside the name cell. */
const TASK_GRID: GridSpec = {
  name: { key: 'name', label: 'Task', min: 200, labelClass: 'pl-6' },
  fixed: [],
  actions: 40,
}

const isKeys = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/**
 * Pin a drag to the Y axis. Rank is a vertical order and there is nowhere sideways for a row to GO,
 * so horizontal travel was pure noise: the row slid out from under its own columns and, in a grid
 * that scrolls horizontally, could be dragged clean off the visible area while still being the thing
 * you were trying to place. Local rather than `@dnd-kit/modifiers` - the whole package is this.
 */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 })

/** Which columns show - a per-browser user setting, shared by the list and its picker button. */
const useTaskColumns = () => usePersistedState<string[]>(appKey('initiative', 'taskColumns'), TASK_COLUMN_KEYS, isKeys)

/** Whether done + dropped rows show - the same shape of setting, shared by the list and its eye. */
const useShowDoneTasks = () =>
  usePersistedState<boolean>(appKey('initiative', 'showDoneTasks'), true, (v) => typeof v === 'boolean')

const isTerminal = (t: Task) => TERMINAL_PLANNING_STATUSES.includes(t.status)

export function TaskList({
  initiative,
  tagSuggestions,
  onOpenTask,
}: {
  initiative: Initiative
  tagSuggestions: string[]
  onOpenTask: (taskId: string) => void
}) {
  const [chosen] = useTaskColumns()
  const [showDone] = useShowDoneTasks()
  const { widths, setWidth } = useColumnWidths(appKey('initiative', 'tasks'))
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const columns = chosen.filter((k) => TASK_COLUMN_KEYS.includes(k))
  const grid = buildGrid(TASK_GRID, orderColumns(TASK_COLUMNS, columns), widths)
  const visible = showDone ? initiative.tasks : initiative.tasks.filter((t) => !isTerminal(t))

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    // The FULL list, not the visible one: a hidden row keeps its rank, and dropping onto a visible
    // row means "take that row's place" whichever rows are folded away around it.
    const ids = initiative.tasks.map((t) => t.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    void reorderTasks(initiative.id, arrayMove(ids, from, to))
  }

  const row = (t: Task) => (
    <TaskListRow
      key={t.id}
      task={t}
      columns={columns}
      template={grid.template}
      tagSuggestions={tagSuggestions}
      onOpen={() => onOpenTask(t.id)}
      muted={isTerminal(t)}
    />
  )

  return (
    <div className='overflow-x-auto rounded-lg border border-border bg-surface shadow-(--shadow-sm)'>
      <div style={{ minWidth: grid.minWidth }}>
        <GridHeader columns={grid.columns} template={grid.template} onResize={setWidth} className='rounded-t-lg bg-surface' />

        {/* No `DragOverlay`. It drew a second, differently-shaped chip under the pointer while the
            real row sat greyed out where it started, so the thing you were moving was not the thing
            you were looking at. Without it the sortable transform moves the ROW itself, which is
            what a drag is supposed to feel like. */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}>
          <SortableContext items={visible.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            {visible.map((t) => row(t))}
          </SortableContext>
        </DndContext>

        <QuickAddTask initiative={initiative} className='border-t border-border px-2' />
      </div>
    </div>
  )
}

/**
 * The show/hide switch for done + dropped rows, rendered beside the column picker. It hides itself
 * on an initiative that has none, which is the shared `ShowAllButton` rule: a switch that would
 * reveal nothing is chrome.
 */
export function TaskDoneTasksButton({ tasks }: { tasks: Task[] }) {
  const [shown, setShown] = useShowDoneTasks()
  return (
    <ShowAllButton
      shown={shown}
      onToggle={() => setShown((v) => !v)}
      hiddenCount={tasks.filter(isTerminal).length}
      noun='done tasks'
    />
  )
}

/**
 * The column picker for the list above, rendered next to the section heading (a detail view has no
 * board bar to hang it on). Toggle only, no drag-to-reorder: the offered order is the read order
 * here, and a six-column list is not one anybody needs to rearrange.
 */
export function TaskColumnsButton() {
  const [chosen, setChosen] = useTaskColumns()
  // Rebuilt from the catalog rather than appended, so turning a column back on returns it to its
  // place in the row instead of to the end of it.
  const toggle = (key: string) =>
    setChosen((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : TASK_COLUMN_KEYS.filter((k) => prev.includes(k) || k === key),
    )
  return (
    <Popover>
      <PopoverTrigger
        aria-label='Columns'
        title='Columns - which ones show'
        className='inline-flex size-7 items-center justify-center rounded-md border border-border bg-bg text-muted-foreground transition-colors hover:border-accent/40 hover:text-text'>
        <Columns3 className='size-3.5' />
      </PopoverTrigger>
      <PopoverContent align='end' side='bottom' className='flex w-60 flex-col gap-1'>
        <span className='px-1 pb-1 text-label text-fg-4'>
          Yours alone, kept in this browser. To resize, drag a column's right edge in the header.
        </span>
        {TASK_COLUMNS.map((c) => {
          const on = chosen.includes(c.key)
          return (
            <button
              key={c.key}
              type='button'
              onClick={() => toggle(c.key)}
              aria-pressed={on}
              className='flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left text-body-sm text-text hover:bg-accent-tint'>
              <Check className={cn('size-3.5 shrink-0', on ? 'text-accent' : 'opacity-0')} />
              <span className='truncate'>{c.label}</span>
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

/** One task, every field of it editable in place. `muted` is the tone terminal work reads in. */
function TaskListRow({
  task,
  columns,
  template,
  tagSuggestions,
  onOpen,
  muted = false,
}: {
  task: Task
  columns: string[]
  template: string
  tagSuggestions: string[]
  onOpen: () => void
  muted?: boolean
}) {
  // Terminal rows drag too: rank is the plan's order, and finishing a task does not take it out of
  // that order (the fold that used to hold them is gone).
  const sortable = useSortable({ id: task.id })
  const repo = typeof task.metadata.repo === 'string' ? task.metadata.repo : null
  const stars = typeof task.metadata.stars === 'number' ? task.metadata.stars : null
  const stack = typeof task.metadata.stack === 'string' ? task.metadata.stack : null
  const hasMeta = repo || stars != null || stack || task.score != null

  const onDelete = () => {
    void confirm({
      title: `Delete task "${task.title}"?`,
      message: 'Its doc on disk stays.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => void (ok && deleteTask(task.id)))
  }

  const cell = (key: string) => {
    switch (key) {
      case 'status':
        return <StatusSelect value={task.status} onChange={(s) => void setTaskStatus(task.id, s)} className='w-full' />
      case 'assignee':
        return (
          <UserPicker
            value={task.assignee}
            onChange={(id) => void upsertTask({ id: task.id, assignee: id ?? '' })}
            className='w-full'
          />
        )
      case 'priority':
        return (
          <PriorityCell value={task.priority} onChange={(priority) => void upsertTask({ id: task.id, priority: priority ?? 0 })} />
        )
      case 'effort':
        // 0 is how the server clears a numeric field (the twin of '' for a flattened enum).
        return (
          <TaskHoursCell
            value={task.estimate_hours}
            onChange={(h) => void upsertTask({ id: task.id, estimate_hours: h ?? 0 })}
          />
        )
      case 'due':
        return <DueCell row={task} onChange={(due_date) => void upsertTask({ id: task.id, due_date })} />
      case 'tags':
        return (
          <TagsCell tags={task.tags} suggestions={tagSuggestions} max={2} onChange={(tags) => void upsertTask({ id: task.id, tags })} />
        )
      default:
        return <span />
    }
  }

  return (
    <div
      ref={sortable.setNodeRef}
      // `Translate`, not `Transform`: dnd-kit's sortable also hands back a SCALE when the rows it is
      // swapping are different heights (a row with a summary line against one without), and a row
      // that squashes as you drag it stops reading as the row you picked up.
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition, gridTemplateColumns: template }}
      className={cn(
        'group grid items-center gap-2 border-b border-border px-2 py-1.5 last:border-b-0 hover:bg-accent-tint/30',
        // The dragged row LIFTS rather than fading. It used to go half-transparent because a
        // DragOverlay drew the thing you were actually moving; without the overlay this row IS the
        // thing being moved, so it gets the shadow instead of the ghost treatment.
        sortable.isDragging && 'relative z-10 bg-surface opacity-100 shadow-(--shadow-md)',
        muted && !sortable.isDragging && 'opacity-70',
      )}>
      <div className='flex min-w-0 items-center gap-1'>
        <GripHandle attributes={sortable.attributes} listeners={sortable.listeners} />
        <div className='min-w-0 flex-1'>
          <EditableTitle
            value={task.title}
            summary={task.summary}
            ariaLabel='Task title'
            onOpen={onOpen}
            onCommit={(v) => v.trim() && v !== task.title && void upsertTask({ id: task.id, title: v.trim() })}
          />
          {hasMeta && (
            <div className='flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 text-label text-muted-foreground'>
              {task.score != null && <span className='tabular-nums'>{task.score}/15</span>}
              {stars != null && <span className='tabular-nums'>{formatNumber(stars)}★</span>}
              {stack && <span>{stack}</span>}
              {repo && (
                <a
                  href={task.url ?? `https://github.com/${repo}`}
                  target='_blank'
                  rel='noreferrer'
                  className='inline-flex items-center gap-1 hover:text-accent'>
                  {repo}
                  <ExternalLink className='size-3' />
                </a>
              )}
            </div>
          )}
        </div>
      </div>
      {columns.map((key) => (
        <span key={key} className='min-w-0'>
          {cell(key)}
        </span>
      ))}
      <RowActions onDelete={onDelete} />
    </div>
  )
}
