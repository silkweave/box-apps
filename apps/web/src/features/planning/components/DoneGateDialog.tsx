import { Dialog, DialogContent, DialogDescription, DialogTitle, Button } from '@silkweave/box-ui'
import { PLANNING_STATUS_META, type Initiative, type Task } from '../planning-types.ts'

/** Tasks that still block an initiative from being marked done ('dropped' counts as resolved). */
export const unresolvedTasks = (i: Initiative): Task[] =>
  i.tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped')

const PREVIEW = 5

/**
 * Notification shown when a status change to `done` is refused because tasks are still open.
 * Purely informational - the caller never commits the change; closing leaves the status as-is.
 */
export function DoneGateDialog({
  initiative,
  open,
  onOpenChange,
}: {
  initiative: Initiative
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const blocking = unresolvedTasks(initiative)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className='flex flex-col gap-1'>
          <DialogTitle>Tasks still open</DialogTitle>
          <DialogDescription>
            "{initiative.title}" can only be marked done once every task is done or dropped -{' '}
            {blocking.length === 1 ? '1 task is' : `${blocking.length} tasks are`} still open.
          </DialogDescription>
        </div>

        <ul className='flex flex-col gap-1.5 text-body-sm text-text'>
          {blocking.slice(0, PREVIEW).map((t) => (
            <li key={t.id} className='flex items-baseline justify-between gap-3'>
              <span className='min-w-0 truncate'>{t.title}</span>
              <span className='shrink-0 text-label text-muted-foreground'>{PLANNING_STATUS_META[t.status].label}</span>
            </li>
          ))}
          {blocking.length > PREVIEW && (
            <li className='text-label text-muted-foreground'>… and {blocking.length - PREVIEW} more</li>
          )}
        </ul>

        <div className='flex justify-end'>
          <Button size='sm' onClick={() => onOpenChange(false)}>
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
