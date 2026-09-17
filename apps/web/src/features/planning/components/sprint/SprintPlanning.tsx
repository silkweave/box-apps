// Sprint Planning - the second view: pull tasks into the sprint, then put them on days. It is the
// step that moves a sprint `scheduled` -> `planned`, and the server refuses that move while any day
// is provably over capacity, so this surface's job is to make the refusal actionable BEFORE it
// happens - the capacity summary names the same days the server would.
//
// The backlog on the left is the whole board minus what is already here, and it is itself the
// "take it out" drop target: dragging a task back releases it from the sprint. That keeps every
// scope gesture in one place instead of hiding removal behind a menu on the chip.
//
// The sidebar is WIDER than a chip column and resizable (persisted per browser), because filling a
// sprint is a triage read, not a glance. The row IS the calendar's card (`TaskCard`) - same two
// lines, same editable owner and size - so a task reads and edits identically either side of the
// drop, and a click on it opens the same modal.

import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { useDroppable } from '@dnd-kit/core'
import { cn } from '@/lib/utils'
import { Note, OUT_DROP, SprintDnd, SprintGrid, TaskCard } from './SprintGrid.tsx'
import { Avatar, Checkbox, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, todayUtc } from '@silkweave/box-ui'
import { usePlanningData } from '../../lib/usePlanningData.ts'
import { usePersistedState } from '../../../../lib/usePersistedState.ts'
import { TERMINAL_PLANNING_STATUSES, type Initiative, type Task } from '../../planning-types.ts'
import { formatDay, type SprintDetail } from '../../sprint-types.ts'
import { userName, type User } from '../../../../user-types.ts'

/** Sidebar width, in px. Wide enough for a two-line row without wrapping the second one. */
const BACKLOG_WIDTH_KEY = 'sprint.planning.backlog-width'
const BACKLOG_COLLAPSED_KEY = 'sprint.planning.backlog-collapsed'
const BACKLOG_DEFAULT_WIDTH = 400
const BACKLOG_MIN_WIDTH = 340
const BACKLOG_MAX_WIDTH = 720

export function SprintPlanning({
  sprint,
  users,
  onOpenTask,
  onError,
}: {
  sprint: SprintDetail
  users: User[]
  onOpenTask?: (id: string) => void
  /** A refused write (a slot outside the window). Reported UP - the sprint header owns the banner,
   *  so there is one place a refusal ever appears. */
  onError: (message: string | null) => void
}) {
  const { data: initiatives } = usePlanningData()
  const containerRef = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = usePersistedState<boolean>(
    BACKLOG_COLLAPSED_KEY,
    false,
    (v) => typeof v === 'boolean',
  )
  const [width, setWidth] = usePersistedState<number>(
    BACKLOG_WIDTH_KEY,
    BACKLOG_DEFAULT_WIDTH,
    (v) => typeof v === 'number' && v >= BACKLOG_MIN_WIDTH && v <= BACKLOG_MAX_WIDTH,
  )

  // Pointer-driven resize rather than a CSS resizer: the sidebar is a dnd-kit drop target, and a
  // native `resize` handle inside one swallows the pointer sequence the sensor is listening for.
  //
  // The listeners live in an EFFECT keyed on `resizing` rather than being attached inside the
  // pointer handler, because unmounting mid-drag (a tab switch, a route change) used to leave
  // `pointermove`/`pointerup` bound to the window and the page stuck on a `col-resize` cursor with
  // no way back short of a reload. Cleanup is now the same code path as finishing the drag.
  const [resizing, setResizing] = useState(false)
  useEffect(() => {
    if (!resizing) return
    const move = (ev: PointerEvent): void => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      setWidth(Math.max(BACKLOG_MIN_WIDTH, Math.min(BACKLOG_MAX_WIDTH, ev.clientX - rect.left)))
    }
    const up = (): void => setResizing(false)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [resizing, setWidth])

  return (
    <SprintDnd sprint={sprint} onError={onError}>
      <div ref={containerRef} className='flex min-h-0 flex-1 flex-col lg:flex-row lg:items-stretch'>
        {collapsed ? (
          <button
            type='button'
            onClick={() => setCollapsed(false)}
            aria-label='Show the backlog'
            title='Show the backlog'
            className='hidden shrink-0 items-start justify-center border-r border-border px-2 py-3 text-muted-foreground transition-colors hover:bg-accent-tint hover:text-text lg:flex'>
            <PanelLeftOpen className='size-4' />
          </button>
        ) : (
          <>
            <Backlog
              sprint={sprint}
              users={users}
              initiatives={initiatives ?? []}
              onOpenTask={onOpenTask}
              width={width}
              onCollapse={() => setCollapsed(true)}
            />
            {/* The resize handle IS the border - a 1px rule down the full height with a fat
                invisible hit area, rather than a floating divider with a gutter either side. */}
            <div
              role='separator'
              aria-orientation='vertical'
              onPointerDown={(e) => {
                e.preventDefault()
                setResizing(true)
              }}
              onDoubleClick={() => setWidth(BACKLOG_DEFAULT_WIDTH)}
              title='Drag to resize · double-click to reset'
              className='relative z-10 hidden w-px shrink-0 cursor-col-resize self-stretch bg-border transition-colors hover:bg-accent/60 active:bg-accent lg:block'>
              <span className='absolute inset-y-0 -left-2 -right-2' />
            </div>
          </>
        )}
        {/* No capacity banner: the check lives in the top bar's status button now, where it costs
            no rows and is read in every tab rather than only this one. */}
        {/* No padding: the grid IS the surface on this side, and a gutter around a table only
            floats it off the frame's edge (the same call as the sidebar). */}
        <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
          <SprintGrid sprint={sprint} users={users} today={todayUtc()} onOpenTask={onOpenTask} />
        </div>
      </div>
    </SprintDnd>
  )
}

/** "Anyone" is the absence of an owner filter; `unassigned` is a real answer to "who owns this". */
const ANY_OWNER = '__any__'
const NO_OWNER = '__none__'
/** "Any tag" is the absence of a tag filter. Tags are stored lowercased, so no real tag collides. */
const ANY_TAG = '__any__'

/**
 * The left panel: every open task that is not on a day in this sprint. That is the whole rule, and
 * it is the whole model - a task is slotted on a person-day or it is here (2026-09-07). The middle
 * state, "in the sprint but on no day", is gone: it counted towards the sprint's scope while
 * contributing to nobody's capacity, and on screen it was indistinguishable from the backlog.
 *
 * Dropping a card here takes it out of the sprint; dragging one onto a person-day puts it in.
 *
 * It is a PANEL, not a card: no radius, no inset, and its right border is the full-height rule
 * between it and the calendar. Finished work is hidden by default - a backlog listing last
 * quarter's done tasks is a list you stop reading.
 */
function Backlog({
  sprint,
  users,
  initiatives,
  onOpenTask,
  width,
  onCollapse,
}: {
  sprint: SprintDetail
  users: User[]
  initiatives: Initiative[]
  onOpenTask?: (id: string) => void
  width: number
  onCollapse: () => void
}) {
  const [query, setQuery] = useState('')
  const [owner, setOwner] = useState<string>(ANY_OWNER)
  const [tag, setTag] = useState<string>(ANY_TAG)
  const [dueInWindow, setDueInWindow] = useState(false)
  // Which initiatives are folded shut. Persisted: which parts of the board you are not working on
  // is a stable fact about a planning session, not something to re-answer on every reload.
  const [folded, setFolded] = usePersistedState<string[]>(
    'sprint.planning.folded-initiatives',
    [],
    (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  )
  const { setNodeRef, isOver } = useDroppable({ id: OUT_DROP })

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows: { initiative: Initiative; task: Task }[] = []
    for (const initiative of initiatives) {
      for (const task of initiative.tasks) {
        // On a day in THIS sprint is the only thing that takes a task out of this list. A task
        // carrying our sprint_id but no slot_date is a leftover of the retired "in the sprint, not
        // on a day" state - it belongs here, where it can be dragged onto a day or dropped out.
        if (task.sprint_id === sprint.id && task.slot_date) continue
        if (TERMINAL_PLANNING_STATUSES.includes(task.status)) continue
        if (q && !`${task.title} ${initiative.title} ${task.tags.join(' ')}`.toLowerCase().includes(q)) continue
        if (owner !== ANY_OWNER && (task.assignee ?? NO_OWNER) !== owner) continue
        // The TASK's own tags, not its initiative's: a tag like `sprint` is a per-task pick, and an
        // initiative carrying it would otherwise pull in every open task under it.
        if (tag !== ANY_TAG && !task.tags.includes(tag)) continue
        // "Due in this window" is the planning question, not "has a due date": a task due after the
        // sprint ends is not what you are filling these days with. A sprint with no dates yet cannot
        // answer it, so the control is disabled there rather than silently emptying the list.
        if (dueInWindow) {
          if (!task.due_date || !sprint.start_date || !sprint.end_date) continue
          if (task.due_date < sprint.start_date || task.due_date > sprint.end_date) continue
        }
        rows.push({ initiative, task })
      }
    }
    return rows
  }, [initiatives, sprint.id, sprint.start_date, sprint.end_date, query, owner, tag, dueInWindow])

  // Every tag on an open task, so the menu offers only tags that can match something.
  const tagOptions = useMemo(() => {
    const all = new Set<string>()
    for (const initiative of initiatives) {
      for (const task of initiative.tasks) {
        if (TERMINAL_PLANNING_STATUSES.includes(task.status)) continue
        for (const t of task.tags) all.add(t)
      }
    }
    return [...all].sort()
  }, [initiatives])

  // Grouped by initiative, because "what else is in this initiative" is the question you are
  // actually asking while filling a sprint - a flat list of 200 task titles answers nothing.
  const groups = new Map<string, { initiative: Initiative; tasks: Task[] }>()
  for (const { initiative, task } of candidates) {
    const g = groups.get(initiative.id) ?? { initiative, tasks: [] }
    g.tasks.push(task)
    groups.set(initiative.id, g)
  }

  const dated = Boolean(sprint.start_date && sprint.end_date)

  return (
    <section
      aria-label='Backlog'
      style={{ width }}
      className='flex min-h-0 w-full max-w-full shrink-0 flex-col bg-bg'>
      <header className='flex flex-col gap-1.5 border-b border-border p-2'>
        <div className='flex items-center gap-1.5 rounded-md border border-border bg-bg pl-2'>
          <Search className='size-3.5 shrink-0 text-fg-4' />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search the backlog'
            aria-label='Search the backlog'
            className='h-8 w-full min-w-0 bg-transparent text-body-sm text-text outline-none placeholder:text-fg-4'
          />
          <button
            type='button'
            onClick={onCollapse}
            aria-label='Hide the backlog'
            title='Hide the backlog'
            className='shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent-tint hover:text-text'>
            <PanelLeftClose className='size-4' />
          </button>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Select
            value={owner}
            onValueChange={(v) => setOwner(String(v))}
            items={[
              { value: ANY_OWNER, label: 'Anyone' },
              { value: NO_OWNER, label: 'Unassigned' },
              ...users.map((u) => ({ value: u.id, label: userName(u) })),
            ]}>
            <SelectTrigger aria-label='Filter by owner' className='h-7 min-w-32'>
              <SelectValue>
                {(v) =>
                  v === ANY_OWNER
                    ? 'Anyone'
                    : v === NO_OWNER
                      ? 'Unassigned'
                      : (users.find((u) => u.id === v)?.nickname ?? String(v))
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_OWNER}>Anyone</SelectItem>
              <SelectItem value={NO_OWNER}>Unassigned</SelectItem>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  <span className='flex items-center gap-1.5'>
                    <Avatar user={u} size='xs' />
                    {userName(u)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={tag}
            onValueChange={(v) => setTag(typeof v === 'string' && v ? v : ANY_TAG)}
            items={[{ value: ANY_TAG, label: 'Any tag' }, ...tagOptions.map((t) => ({ value: t, label: t }))]}>
            <SelectTrigger aria-label='Filter by tag' className='h-7 min-w-28'>
              <SelectValue>{(v) => (v === ANY_TAG ? 'Any tag' : `#${String(v)}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_TAG}>Any tag</SelectItem>
              {tagOptions.map((t) => (
                <SelectItem key={t} value={t}>
                  #{t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label
            className={cn(
              'inline-flex items-center gap-1.5 text-label',
              dated ? 'cursor-pointer text-muted-foreground' : 'cursor-not-allowed text-fg-4',
            )}
            title={
              dated
                ? `Only tasks due between ${formatDay(sprint.start_date as string)} and ${formatDay(sprint.end_date as string)}`
                : 'This sprint has no window yet - set the dates in Design'
            }>
            <Checkbox
              checked={dueInWindow}
              disabled={!dated}
              onChange={(e) => setDueInWindow(e.target.checked)}
            />
            Due in window
          </label>
        </div>
      </header>

      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-2 transition-colors',
          isOver && 'bg-accent-tint/40 ring-1 ring-accent ring-inset',
        )}>
        {/* Only spoken when it matters: a standing "drag onto a person-day" is instructions for
            something you are already doing. The drop affordance still shows, as the panel's tint. */}
        {isOver && <p className='px-0.5 text-label text-accent'>Drop to take it out of the sprint</p>}
        {groups.size === 0 ? (
          <Note>
            {query || owner !== ANY_OWNER || tag !== ANY_TAG || dueInWindow
              ? 'Nothing matches.'
              : 'Every open task is already in this sprint.'}
          </Note>
        ) : (
          [...groups.values()].map(({ initiative, tasks }) => {
            const shut = folded.includes(initiative.id)
            return (
              <div key={initiative.id}>
                {/* The initiative is the heading you navigate by while filling a sprint, so it reads
                    as one - body text, not a label - and it folds, because two initiatives you are
                    not working on should not cost you the scroll to the one you are. */}
                <button
                  type='button'
                  onClick={() => setFolded(shut ? folded.filter((x) => x !== initiative.id) : [...folded, initiative.id])}
                  aria-expanded={!shut}
                  title={initiative.title}
                  className='mb-1.5 flex w-full items-center gap-1 px-0.5 text-left text-body-sm font-medium text-text transition-colors hover:text-accent'>
                  {/* The chevron sits on the RIGHT and the task count is gone (2026-09-08): the
                      heading you scan is the title, and a number nobody acts on was competing with
                      it for the one spot the eye lands on. */}
                  <span className='truncate'>{initiative.title}</span>
                  <ChevronDown className={cn('ml-auto size-3.5 shrink-0 text-fg-4 transition-transform', shut && '-rotate-90')} />
                </button>
                {!shut && (
                  <div className='flex flex-col gap-2'>
                    {tasks.map((t) => (
                      <TaskCard key={t.id} task={t} onOpen={onOpenTask} />
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </section>
  )
}

