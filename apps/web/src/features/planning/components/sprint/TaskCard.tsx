// ONE card for every sprint surface - the backlog, the person-day grid, the standup buckets. It
// used to be two shapes (a small chip in a cell, a fuller row in the sidebar) and that was a bug in
// disguise: the sidebar is where you decide a task is ready to plan and the grid is where you find
// out it was not, so the facts you need are the same in both, and a fact you can only fix in one of
// them sends you round the houses.
//
// The card is a LABEL, not a form (2026-09-08). Title, status, owner, estimate and due date are
// read here and edited in the task dialog, which the whole card opens:
//
//     title
//     status   owner   4h ..................... due date
//
// It was a form until the dialog existed, and every control on it was a live `Select`, `Popover`,
// `DateInput` or `InlineEdit`. That cost three things and bought one:
//
//   • **Drag latency.** A grid holds dozens of cards, dnd-kit re-renders its consumers on every
//     pointer move, and each card was re-rendering a stack of popup-capable controls with their own
//     state. The card is now `memo`'d over a plain props object and has no state at all.
//   • **A card with almost no draggable pixels.** Each control had to swallow its own pointer, so
//     the drag surface was the thin margins between them, and the title needed a double-click
//     gesture nobody discovers to stay editable at all.
//   • **Alignment.** Four controls of three different intrinsic heights never did line up.
//
// What it bought was editing without opening anything - which is exactly what the dialog is for,
// and the dialog now carries the doc too. One click, every field, one place they are spelled.
//
// Click vs drag is measured by distance rather than by dnd-kit - the 6px activation constraint means
// a small movement never starts a drag but DOES still fire a click - and that measurement, the
// draggable wiring and the frame are all `DraggableCard`'s now (`@silkweave/box-ui/board`), shared
// with the kanban card that learned the same lessons separately. What is left here is the one thing
// that is about a TASK: which five facts the two lines carry.

import { memo } from 'react'
import { UserCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@silkweave/box-ui'
import { DraggableCard } from '@silkweave/box-ui/board'
import { PLANNING_STATUS_UI } from '../status.tsx'
import { formatHours } from '../../sprint-types.ts'
import { useUsersData } from '../../../../lib/useUsersData.ts'
import { isOverdue } from '../../lib/planningView.ts'
import { PLANNING_STATUS_META, type Task } from '../../planning-types.ts'
import { userName } from '../../../../user-types.ts'

/** One fact on the second line. One height, one alignment, for all of them. */
const FACT = 'inline-flex h-5 min-w-0 items-center gap-1 text-label text-muted-foreground'

export const TaskCard = memo(function TaskCard({
  task,
  onOpen,
  overlay = false,
  draggable = true,
}: {
  task: Task
  onOpen?: (id: string) => void
  overlay?: boolean
  draggable?: boolean
}) {
  const overdue = isOverdue(task)
  const { icon: StatusIcon, color } = PLANNING_STATUS_UI[task.status]

  return (
    <DraggableCard
      id={task.id}
      label={task.title}
      handle='surface'
      draggable={draggable}
      overlay={overlay}
      data={{ task }}
      onClick={onOpen && !overlay ? () => onOpen(task.id) : undefined}
      title={onOpen && !overlay ? `${task.title}\n\nClick to open` : task.title}
      className='flex flex-col gap-1 p-1.5'>
      {/* A long title clips rather than wrapping - the full text is on the hover title, and the
          dialog is one click away. */}
      <span className='block min-w-0 truncate px-0.5 text-body-sm leading-5 text-text'>{task.title}</span>
      <div className='flex items-center gap-2 px-0.5'>
        <span className={FACT} title={`Status: ${PLANNING_STATUS_META[task.status].label}`}>
          <StatusIcon className={cn('size-3 shrink-0', color)} aria-hidden />
          <span className='truncate'>{PLANNING_STATUS_META[task.status].label}</span>
        </span>
        <Owner task={task} />
        <span className={cn(FACT, 'shrink-0 font-mono tabular-nums')} title='Estimate'>
          {task.estimate_hours ? formatHours(task.estimate_hours) : 'N/A'}
        </span>
        <span
          className={cn(FACT, 'ml-auto shrink-0 tabular-nums', overdue ? 'text-danger' : 'text-fg-4')}
          title={overdue ? `Overdue: ${task.due_date}` : task.due_date ? `Due ${task.due_date}` : 'No due date'}>
          {task.due_date || 'N/A'}
        </span>
      </div>
    </DraggableCard>
  )
})

/** Owner, on the card: the avatar plus whatever of the name the column has room for. */
function Owner({ task }: { task: Task }) {
  const { data: users } = useUsersData()
  const current = (users ?? []).find((u) => u.id === task.assignee) ?? null
  const label = current ? current.nickname || userName(current) : 'Unassigned'

  return (
    <span className={cn(FACT, 'max-w-28')} title={`Owner: ${label}`}>
      {current ? (
        <Avatar user={current} size='xs' />
      ) : (
        <UserCircle2 className='size-3.5 shrink-0 text-fg-4' aria-hidden />
      )}
      <span className={cn('truncate', !current && 'text-fg-4')}>{label}</span>
    </span>
  )
}
