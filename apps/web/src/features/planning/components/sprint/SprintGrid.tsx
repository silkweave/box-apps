// The sprint's capacity grid: one row per day of the window, one column per person on the sprint,
// and the tasks that were put in each cell. This is the surface the Sprint Planning view and the
// Active Sprint view SHARE - the design call of 2026-08-28 merged the week-calendar view into the
// active sprint rather than building the same grid twice with different drop rules.
//
// Two things it deliberately does not do:
//
//   • **It computes nothing.** `sprintGet` returns `loads` (one DayLoad per person per day) and
//     `check` already derived in `planning/sprints.ts`. Re-deriving either here is how the two ends
//     drift, and the drift would be invisible - a wrong number still renders.
//   • **A day's load is a plain sum of hours** since task sizes became estimates again
//     (2026-09-08). `formatHours` is the only spelling of it.
//
// The grid includes weekends and days off, at 0h capacity, because a task slotted onto one lands as
// `over` against nothing - which is exactly the mistake the check exists to catch. Hiding those
// columns would hide the finding.

import { useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { AlertTriangle, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar, confirm } from '@silkweave/box-ui'
import { TaskCard } from './TaskCard.tsx'
import { NewSprintTaskDialog } from './NewSprintTaskDialog.tsx'
import { reloadSprint, slotTask } from '../../lib/useSprintsData.ts'
import { deleteTask } from '../../lib/usePlanningData.ts'
import { useActiveUser } from '../../../../lib/useActiveUser.ts'
import { type Task } from '../../planning-types.ts'
import {
  capacityOn,
  datesBetween,
  formatHours,
  formatDay,
  isWeekend,
  VERDICT_META,
  weekKey,
  type DayLoad,
  type SprintAvailability,
  type SprintDetail,
} from '../../sprint-types.ts'
import { userName, type User } from '../../../../user-types.ts'

export { TaskCard } from './TaskCard.tsx'

/** Droppable ids. Parsed in `SprintDnd`; a user id is a slug, so `:` is a safe separator. */
const CELL = (user: string, date: string): string => `cell:${user}:${date}`
export const OUT_DROP = 'out'

/** Below this a card's second line starts wrapping. The table scrolls rather than go under it. */
const MIN_PERSON_COL_PX = 288

/**
 * The sprint's roster: whoever has availability set, plus anyone holding a slotted task. Mirrors
 * `sprintCapacity` on the server, so the grid shows exactly the rows the check reasoned about - an
 * empty sprint renders no rows rather than the whole user directory.
 *
 * `first` (the signed-in user) leads when they are on the roster: your own column is the one you
 * plan into most, and it should not depend on where your id falls in the alphabet (2026-09-14).
 */
export function rosterOf(sprint: SprintDetail, first?: string | null): string[] {
  const slotted = sprint.tasks.filter((t) => t.slot_date && t.assignee).map((t) => t.assignee as string)
  const roster = [...new Set([...Object.keys(sprint.availability ?? {}), ...slotted])].sort()
  return first && roster.includes(first) ? [first, ...roster.filter((u) => u !== first)] : roster
}

/**
 * The drag layer for every sprint surface: it owns the DndContext, the overlay, and what a drop
 * MEANS. There are exactly TWO answers, because as of 2026-09-07 there are exactly two states a
 * task can be in: on a person-day cell (which slots it, assigns it, and dates it), or in the
 * backlog (which takes it out of the sprint).
 *
 * There used to be a third - in the sprint, on no day - and it earned its own drop target, its own
 * panel and its own empty state. It was a waiting room nobody waited in: a task in a sprint that
 * nobody has scheduled is indistinguishable from a task in the backlog, except that it quietly
 * counted towards the sprint's scope while contributing to no day's capacity. One less state.
 *
 * Writes go through `slotTask`, i.e. an ordinary task upsert - there is no "add to sprint"
 * procedure. The server can refuse one (a slot outside the window), so failures are reported up
 * rather than swallowed.
 */
export function SprintDnd({
  sprint,
  onError,
  children,
}: {
  sprint: SprintDetail
  onError: (message: string | null) => void
  children: ReactNode
}) {
  const [dragging, setDragging] = useState<Task | null>(null)
  // A small distance threshold keeps a click-to-open from being read as a drag (same as BoardKanban).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const onDragEnd = (e: DragEndEvent): void => {
    setDragging(null)
    const { active, over } = e
    if (!over) return
    const id = String(active.id)
    const target = String(over.id)
    const task = (active.data.current as { task?: Task } | undefined)?.task
    onError(null)

    const write = (patch: Parameters<typeof slotTask>[1]): void => {
      void slotTask(id, patch).catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
    }

    if (target === OUT_DROP) {
      if (!task?.sprint_id) return
      // A SPRINT task (made on the grid, no initiative) has no backlog to go back to - released, it
      // would be a row no surface draws. The server refuses the write anyway; asking here turns the
      // refusal into the one real choice, keep it on a day or delete it.
      if (!task.initiative_id) {
        void confirm({
          title: 'This task only exists in this sprint',
          message: `"${task.title}" was created on the sprint grid and belongs to no initiative, so there is no backlog to return it to. Keep it on a day, or delete it.`,
          confirmLabel: 'Delete task',
          danger: true,
        }).then((ok) => {
          if (!ok) return
          void deleteTask(id)
            .then(reloadSprint)
            .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
        })
        return
      }
      // Out of the sprint means off the calendar too - a slot_date pointing into a sprint the task
      // no longer belongs to is a row on a grid that will not draw it.
      return write({ sprintId: null, slotDate: null })
    }
    if (!target.startsWith('cell:')) return
    const [, user, date] = target.split(':')
    if (!user || !date) return
    if (task?.slot_date === date && task.assignee === user && task.due_date === date) return
    // The day is the deadline: a task planned for Tuesday IS due Tuesday, and letting the two
    // disagree is how a board shows a green week over a pile of quietly overdue work.
    write({ sprintId: sprint.id, slotDate: date, assignee: user, dueDate: date })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={(e: DragStartEvent) =>
        setDragging((e.active.data.current as { task?: Task } | undefined)?.task ?? null)
      }
      onDragEnd={onDragEnd}>
      {children}
      <DragOverlay>{dragging && <TaskCard task={dragging} overlay />}</DragOverlay>
    </DndContext>
  )
}

/**
 * The day x person grid: one ROW per day of the window, one COLUMN per person on the sprint.
 *
 * Axes inverted on 2026-08-28, and the reason is the shape of the data rather than taste. A sprint
 * is two or three weeks long and a team is three or four people, so days are the long axis - down
 * the page, where scrolling is free and a week is a block you can see - and people are the short
 * one, side by side, where "who is loaded on Tuesday" is a single horizontal read. The old
 * orientation put twelve columns of cards across a viewport that fits three.
 *
 * `days` lets a caller narrow the window (the Active view opens on the current week) without the
 * grid inventing a date rule of its own.
 */
export function SprintGrid({
  sprint,
  users,
  days,
  today,
  onOpenTask,
}: {
  sprint: SprintDetail
  users: User[]
  /** Defaults to the whole sprint window. */
  days?: string[]
  /** Highlighted row, when it falls inside the window. */
  today?: string
  onOpenTask?: (id: string) => void
}) {
  const { userId: me } = useActiveUser()
  // The person-day an "Add task" was clicked on; null = the dialog is closed.
  const [adding, setAdding] = useState<{ user: string; userLabel: string; date: string } | null>(null)
  const dates = days ?? datesBetween(sprint.start_date, sprint.end_date)
  const roster = rosterOf(sprint, me)
  const loads = new Map(sprint.loads.map((l) => [`${l.user}:${l.date}`, l]))
  const labelOf = (id: string): string => {
    const user = users.find((u) => u.id === id)
    return user ? user.nickname || userName(user) : id
  }
  const byCell = new Map<string, Task[]>()
  for (const t of sprint.tasks) {
    if (!t.slot_date || !t.assignee) continue
    const key = `${t.assignee}:${t.slot_date}`
    byCell.set(key, [...(byCell.get(key) ?? []), t])
  }

  if (dates.length === 0) {
    return <Note>This sprint has no dates yet. Set the window in Design and the grid appears.</Note>
  }
  if (roster.length === 0) {
    return <Note>Nobody is on this sprint yet. Add the team in Design - availability is the roster.</Note>
  }

  // The grid scrolls INSIDE its own box, which is what makes both headers stick: `position: sticky`
  // resolves against the nearest scroll container, and with the page as that container a sticky <th>
  // has nothing to stick to. Days go down, so the vertical cap is the one that matters - the person
  // header stays put while you walk the fortnight. The cap is the FLEX PARENT's leftover height
  // rather than a `100dvh` guess: guessing the chrome above it left dead scrollable space on the
  // page whenever the guess was too tall (2026-08-28).
  return (
    <div className='min-h-0 flex-1 overflow-auto'>
      {/* The columns SHARE whatever width is going, down to the minimum a card is readable at,
          rather than sitting at a fixed 20rem and leaving a stripe of dead page to the right of a
          three-person sprint (2026-09-07). Past that minimum the table overflows and the container
          scrolls, which is the old behaviour on a big roster.
          `table-fixed` is what makes it work, and it is not optional: with auto layout a column's
          width is its widest CONTENT, so one long task title stretched Dan's column past the
          viewport and pushed the last two members off the right-hand edge - with truncation never kicking
          in, because there was nothing constraining the cell to truncate against. Fixed layout takes
          the widths from this row and lets the cards clip inside them. */}
      <table
        className='w-full table-fixed border-separate border-spacing-0'
        style={{ minWidth: roster.length * MIN_PERSON_COL_PX }}>
        <thead>
          {/* The person header rides along on a vertical scroll - with days going down, the column
              you are dropping into would otherwise lose its name three rows in. */}
          {/* Sticky lives on the CELLS, not the row: `position: sticky` on a <tr> is ignored by
              Chrome, so a sticky row header has to be spelled th-by-th. */}
          <tr>
            {roster.map((userId) => {
              const user = users.find((u) => u.id === userId)
              return (
                <th
                  key={userId}
                  className='sticky top-0 z-20 border-r border-b border-border bg-bg px-2 py-2 text-left align-middle'>
                  {/* `flex`, not `inline-flex`: an inline box in a table cell sits on the text
                      baseline, so the line box keeps the strut's descender underneath it and the
                      name rides ~8px high however the cell is aligned. A block-level flex has no
                      strut, so `align-middle` finally means what it says (2026-09-08). */}
                  <span className='flex items-center gap-1.5 text-body-sm font-medium text-text'>
                    {user && <Avatar user={user} size='xs' />}
                    <span className='truncate'>{user ? user.nickname || userName(user) : userId}</span>
                  </span>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {dates.map((date, i) => {
            // A thicker rule where the ISO week turns - a two-week sprint is read a week at a time.
            const newWeek = i > 0 && weekKey(date) !== weekKey(dates[i - 1] as string)
            return (
              <tr key={date}>
                {roster.map((userId) => (
                  <td
                    key={userId}
                    // `h-px` is what makes the cell's WHOLE area the drop target: a table cell's
                    // height is auto, so a `h-full` child has nothing to resolve against and the
                    // droppable ends up as tall as its own content - a strip at the top of the cell,
                    // which is why a card dropped low in a tall row landed nowhere (2026-09-08). A
                    // definite (tiny) height on the td is ignored for layout - the row still sizes
                    // to its content - but it gives the child a percentage base.
                    className={cn(
                      'h-px border-r border-b border-border p-0 align-top',
                      newWeek && 'border-t border-t-border-strong',
                    )}>
                    <DayCell
                      user={userId}
                      date={date}
                      load={loads.get(`${userId}:${date}`)}
                      availability={sprint.availability?.[userId]}
                      tasks={byCell.get(`${userId}:${date}`) ?? []}
                      isToday={date === today}
                      onOpenTask={onOpenTask}
                      onAdd={() => setAdding({ user: userId, userLabel: labelOf(userId), date })}
                    />
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
      <NewSprintTaskDialog sprintId={sprint.id} slot={adding} onClose={() => setAdding(null)} />
    </div>
  )
}

/**
 * One person-day: a droppable well, its verdict, and the band against the capacity. The band is
 * rendered even when the day is fine, because "3-8h against 5h" is the whole reason to look at a
 * planning grid - a cell that only spoke up when it was angry would leave you guessing the rest of
 * the time.
 */
function DayCell({
  user,
  date,
  load,
  availability,
  tasks,
  isToday,
  onOpenTask,
  onAdd,
}: {
  user: string
  date: string
  load?: DayLoad
  availability?: SprintAvailability
  tasks: Task[]
  isToday?: boolean
  onOpenTask?: (id: string) => void
  /** "Add task" on this person-day - makes a sprint task (see `NewSprintTaskDialog`). */
  onAdd?: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: CELL(user, date) })
  // A day with no DayLoad is a day the server had nothing to say about (an empty sprint before any
  // task lands). Its capacity is still knowable, and showing it is what makes the empty grid usable.
  const hours = load?.hours ?? capacityOn(date, availability)
  const verdict = load?.verdict ?? 'empty'
  const meta = VERDICT_META[verdict]
  const off = hours <= 0
  const weekend = isWeekend(date)

  return (
    <div
      ref={setNodeRef}
      // Named for the two things that identify it - whose day, and which - so the grid is navigable
      // without the header row, which a screen reader has already scrolled past by cell three.
      // `role='group'` is what makes the name reachable: a bare div carries an aria-label nowhere.
      role='group'
      aria-label={`${user}, ${formatDay(date)}`}
      // The CELL is the drop target, edge to edge, rather than a dashed box floating inside one
      // (2026-09-07): the table's own rules already draw the grid, so a second border inside every
      // cell was a box drawn around a box, and it made the droppable smaller than the thing the eye
      // reads as the target. A valid drag now just lights the whole cell.
      className={cn(
        'group/cell flex h-full min-h-20 w-full min-w-0 flex-col gap-1.5 p-1 transition-colors',
        meta.cell,
        off && verdict !== 'over' && 'bg-bg/60',
        isToday && 'bg-accent-tint/20',
        isOver && 'bg-accent-tint',
      )}>
      {/* The day is spelled HERE, once per cell, rather than in a column of its own down the left
          (2026-09-08). A sprint row is as tall as its fullest person-day - 800px is ordinary - so a
          left-hand date scrolled out of sight while you were still inside the day it named, and it
          was 112px of chrome to say a thing the cell could say itself. Date left, load right: the
          two facts you read a cell's header for, and the same shape in every one of them. */}
      <div className='flex items-baseline gap-2 px-0.5 text-label'>
        <span
          className={cn(
            'truncate font-medium whitespace-nowrap',
            weekend ? 'text-fg-4' : 'text-muted-foreground',
            isToday && 'text-accent',
          )}>
          {formatDay(date)}
          {isToday && <span className='ml-1 text-fg-4'>today</span>}
        </span>
        <span className='ml-auto flex shrink-0 items-baseline gap-1'>
          <span className={cn('font-mono tabular-nums', meta.text)} title={meta.label}>
            {formatHours(load?.planned ?? 0)}
          </span>
          <span className='text-fg-4'>/ {off ? 'off' : `${hours}h`}</span>
          {verdict === 'over' && (
            <AlertTriangle className='size-3 self-center text-danger' aria-label={meta.label} />
          )}
        </span>
      </div>
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} onOpen={onOpenTask} />
      ))}
      {/* Directly under the cards rather than pinned to the cell's bottom edge: in a tall row that
          edge can be a screen away from the day's last card. Faint until the cell is hovered - fifty
          cells each shouting "Add task" would drown the cards they sit under. */}
      {onAdd && (
        <button
          type='button'
          onClick={onAdd}
          className='inline-flex items-center gap-1 self-start rounded px-1 py-0.5 text-label text-fg-4 transition-colors group-hover/cell:text-muted-foreground hover:bg-accent-tint hover:text-accent focus-visible:text-accent'>
          <Plus className='size-3' aria-hidden />
          Add task
        </button>
      )}
    </div>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <p className='rounded-lg border border-dashed border-border px-4 py-8 text-center text-body-sm text-muted-foreground'>
      {children}
    </p>
  )
}
