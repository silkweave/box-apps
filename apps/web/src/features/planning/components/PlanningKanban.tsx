// The Initiatives board: one column per planning status, cards you drag between them. The structure
// (drag context, columns, the card frame and its grip) is `components/board/BoardKanban`; what lives
// here is what a card SHOWS and what a drop MEANS.
//
// Dragging writes `status` through the ordinary initiative-upsert path: status is Box-owned, so
// moving a card IS a human edit and needs no new tool, no new permission and no new column.
//
// The Done gate is enforced HERE, not in the write path, so it matches the list exactly: an
// initiative with unresolved tasks cannot become done, and the drop is refused with the same dialog
// the status select shows rather than written and apologised for.

import { useState } from 'react'
import { CircleUser, ListChecks } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@silkweave/box-ui'
import { BoardKanban, type KanbanColumn } from '@silkweave/box-ui/board'
import { DoneGateDialog, unresolvedTasks } from './DoneGateDialog.tsx'
import { EffortMeter, KindChip, ValueMeter } from './dimensions.tsx'
import { PLANNING_STATUS_UI } from './status.tsx'
import { isOverdue } from '../lib/planningView.ts'
import { rollupEffort } from '../lib/effort.ts'
import { setInitiativeStatus } from '../lib/usePlanningData.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'
import {
  PLANNING_STATUS_META,
  TERMINAL_PLANNING_STATUSES,
  type Initiative,
  type PlanningStatus,
} from '../planning-types.ts'
import { userName, type User } from '../../../user-types.ts'

export function PlanningKanban({
  initiatives,
  columns,
  onOpen,
}: {
  /** Already filtered and sorted by the view - the board only buckets by status. */
  initiatives: Initiative[]
  columns: PlanningStatus[]
  onOpen: (id: string) => void
}) {
  const { data: users } = useUsersData()
  const [doneGate, setDoneGate] = useState<Initiative | null>(null)
  const kanbanColumns: KanbanColumn[] = columns.map((status) => ({
    key: status,
    label: PLANNING_STATUS_META[status].label,
    icon: PLANNING_STATUS_UI[status].icon,
    color: PLANNING_STATUS_UI[status].color,
    terminal: TERMINAL_PLANNING_STATUSES.includes(status),
  }))

  return (
    <>
      <BoardKanban
        items={initiatives}
        columns={kanbanColumns}
        columnOf={(i) => i.status}
        idOf={(i) => i.id}
        cardLabel={(i) => i.title}
        onDrop={(initiative, status) => {
          // Same rule as the list's status select: done means every task is done or dropped.
          if (status === 'done' && unresolvedTasks(initiative).length > 0) return setDoneGate(initiative)
          void setInitiativeStatus(initiative.id, status as PlanningStatus)
        }}
        renderCard={(i) => <CardBody initiative={i} users={users ?? []} onOpen={onOpen} />}
      />
      {doneGate && <DoneGateDialog initiative={doneGate} open onOpenChange={(open) => !open && setDoneGate(null)} />}
    </>
  )
}

/**
 * One initiative, as a card: what it is, whose it is, how it is judged, and how far along its tasks
 * are. The value/size meters ride along because "should this move" is a judgment made against them,
 * and on a card there is room for the three of them where a status column in the list has none.
 */
function CardBody({
  initiative: i,
  users,
  onOpen,
}: {
  initiative: Initiative
  users: User[]
  onOpen: (id: string) => void
}) {
  const owner = i.owner ? users.find((u) => u.id === i.owner) : undefined
  // Dropped tasks sit outside the lifecycle (like archived content) - they don't count.
  const live = i.tasks.filter((t) => t.status !== 'dropped')
  const done = live.filter((t) => t.status === 'done').length
  const late = isOverdue(i)
  const size = rollupEffort(i)

  return (
    <>
      <div className='flex items-start gap-1'>
        <button type='button' onClick={() => onOpen(i.id)} className='min-w-0 flex-1 text-left outline-none'>
          <span className='line-clamp-2 font-medium text-text hover:text-accent'>{i.title}</span>
        </button>
        {owner ? (
          <span title={userName(owner)} className='shrink-0'>
            <Avatar user={owner} size='xs' />
          </span>
        ) : (
          <CircleUser className='size-4 shrink-0 text-fg-4' aria-label='Unowned' />
        )}
      </div>

      <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
        <KindChip kind={i.kind} />
        {live.length > 0 && (
          <span
            className='inline-flex items-center gap-1 text-label tabular-nums text-muted-foreground'
            title={`${done} of ${live.length} tasks done`}>
            <ListChecks className='size-3' />
            {done}/{live.length}
          </span>
        )}
        {i.due_date && (
          <span className={cn('text-label tabular-nums', late ? 'text-danger' : 'text-fg-4')} title='Due'>
            {i.due_date}
          </span>
        )}
      </div>

      {/* The judgment row, only when there is a judgment to show - an unscored initiative renders
          nothing here rather than three empty meters pretending to be data. */}
      {(i.value_customer || i.value_company || size.hours !== null) && (
        <div className='mt-1.5 flex items-center gap-3 border-t border-border-light pt-1.5'>
          <ValueMeter value={i.value_customer} hue='customer' axis='Customer' />
          <ValueMeter value={i.value_company} hue='company' axis='Company' />
          <EffortMeter rollup={size} />
        </div>
      )}
    </>
  )
}
