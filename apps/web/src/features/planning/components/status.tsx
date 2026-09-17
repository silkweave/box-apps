// The planning status control - ONE component for initiatives and tasks, because since 2026-08-11
// there is one status vocabulary (planned · active · blocked · done · dropped). The two selects
// this replaced had drifted apart in rendering (icon + tone-colored label on one side, a bare-text
// dropdown on the other) purely because they were two files; one component cannot drift from itself.

import { cn } from '@/lib/utils'
import { CircleCheck, CircleDot, CircleDotDashed, CircleSlash, CircleX, type LucideIcon } from 'lucide-react'
import { PLANNING_STATUSES, PLANNING_STATUS_META, type PlanningStatus } from '../planning-types.ts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@silkweave/box-ui'
import { setTaskStatus } from '../lib/usePlanningData.ts'

/** Per-status icon + the text color class for its semantic tone. Label/tone come from PLANNING_STATUS_META. */
export const PLANNING_STATUS_UI: Record<PlanningStatus, { icon: LucideIcon; color: string }> = {
  planned: { icon: CircleDot, color: 'text-muted-foreground' },
  active: { icon: CircleDotDashed, color: 'text-accent' },
  blocked: { icon: CircleSlash, color: 'text-danger' },
  done: { icon: CircleCheck, color: 'text-success' },
  dropped: { icon: CircleX, color: 'text-muted-foreground' },
}

/** Icon + colored label for a status, used inside the trigger and each option. */
export function StatusLabel({ status }: { status: PlanningStatus }) {
  const { icon: Icon, color } = PLANNING_STATUS_UI[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5', color)}>
      <Icon className='size-3.5 shrink-0' />
      <span className='truncate font-medium'>{PLANNING_STATUS_META[status].label}</span>
    </span>
  )
}

/** Controlled status select (base-ui) - an icon + semantic color per status, trigger AND options. */
export function StatusSelect({
  value,
  onChange,
  className,
}: {
  value: PlanningStatus
  onChange: (status: PlanningStatus) => void
  className?: string
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as PlanningStatus)}
      items={PLANNING_STATUSES.map((s) => ({ value: s, label: PLANNING_STATUS_META[s].label }))}>
      <SelectTrigger aria-label='Status' className={className}>
        <SelectValue>{(v) => <StatusLabel status={v as PlanningStatus} />}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {PLANNING_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            <StatusLabel status={s} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Write-through status changer for a task - optimistic via setTaskStatus. `stopRowClick` keeps the
 * click/keydown from bubbling to a row that's itself a button (the initiative task list).
 */
export function TaskStatusDropdown({
  id,
  status,
  className,
  stopRowClick = false,
}: {
  id: string
  status: PlanningStatus
  className?: string
  stopRowClick?: boolean
}) {
  return (
    <div
      onClick={stopRowClick ? (e) => e.stopPropagation() : undefined}
      onKeyDown={stopRowClick ? (e) => e.stopPropagation() : undefined}>
      <StatusSelect value={status} onChange={(s) => void setTaskStatus(id, s)} className={className} />
    </div>
  )
}
