// "Add task" on a person-day: the quickest way to put work into a sprint that is not on the board
// yet - the fix somebody mentions in stand-up, the chore that is not worth an initiative. What it
// makes is a SPRINT task: it belongs to this sprint and to no initiative, and it cannot leave the
// sprint (core refuses it). The cell already says whose day it is and which, so the form asks only
// for the two things the cell cannot know - what the work is, and how long it takes.

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle, Button } from '@silkweave/box-ui'
import { TaskHours } from '../TaskHours.tsx'
import { createSprintTask } from '../../lib/useSprintsData.ts'
import { formatDay } from '../../sprint-types.ts'

/** The server's title cap (TITLE_MAX in core) - a title is a label, the detail goes in the doc. */
const TITLE_MAX = 64

const inputCls =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'

export function NewSprintTaskDialog({
  sprintId,
  slot,
  onClose,
}: {
  sprintId: string
  /** The person-day the task lands on; null = closed. */
  slot: { user: string; userLabel: string; date: string } | null
  onClose: () => void
}) {
  const [title, setTitle] = useState('')
  const [hours, setHours] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Re-seed on every open: the parent opens us by setting `slot`, which never fires onOpenChange.
  useEffect(() => {
    if (!slot) return
    setTitle('')
    setHours(null)
    setError(null)
    setSaving(false)
  }, [slot])

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!slot || !title.trim()) return
    setSaving(true)
    void createSprintTask({ sprintId, title: title.trim(), assignee: slot.user, date: slot.date, estimateHours: hours })
      .then(onClose)
      .catch((err: unknown) => {
        setSaving(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  }

  return (
    <Dialog open={Boolean(slot)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className='max-w-md'>
        <div className='flex flex-col gap-1'>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            {slot && (
              <>
                {slot.userLabel} · {formatDay(slot.date)}. It belongs to this sprint only, under no initiative.
              </>
            )}
          </DialogDescription>
        </div>

        <form onSubmit={submit} className='flex flex-col gap-3'>
          <label className='flex flex-col gap-1'>
            <span className='text-label text-muted-foreground'>Title</span>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              autoFocus
              value={title}
              maxLength={TITLE_MAX}
              onChange={(e) => {
                setTitle(e.target.value)
                setError(null)
              }}
              placeholder='What needs doing'
              className={inputCls}
            />
          </label>

          <div className='flex flex-col gap-1'>
            <span className='text-label text-muted-foreground'>Estimate</span>
            <TaskHours value={hours} onChange={setHours} />
          </div>

          {error && <p className='text-label text-danger'>{error}</p>}

          <div className='mt-1 flex items-center justify-end gap-2'>
            <Button type='button' variant='ghost' size='sm' onClick={onClose}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={saving || !title.trim()}>
              {saving ? 'Creating…' : 'Create task'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
