import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogTitle, Button, DateInput, UrlInput } from '@silkweave/box-ui'
import { StatusSelect } from './status.tsx'
import { upsertTask } from '../lib/usePlanningData.ts'
import type { PlanningStatus } from '../planning-types.ts'

/** title → slug: lowercase, non-alphanumerics → '-', trimmed. Matches the server's slug rules. */
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

const inputCls =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'

/**
 * Modal new-task flow. Captures title + the metadata you'd otherwise have to edit after creation
 * (status, due date, url, note). Status defaults to the currently selected task tab. On create it
 * upserts the task then hands the new id back so the caller can route into it.
 */
export function NewTaskDialog({
  open,
  onOpenChange,
  initiativeId,
  defaultStatus,
  existingTaskIds,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initiativeId: string
  defaultStatus: PlanningStatus
  existingTaskIds: string[]
  onCreated: (taskId: string) => void
}) {
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<PlanningStatus>(defaultStatus)
  const [url, setUrl] = useState('')
  const [due, setDue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Re-seed the form each time the dialog opens (picks up the active tab as the default status).
  // Driven by `open` because the parent opens us by setting state, which never fires onOpenChange.
  useEffect(() => {
    if (!open) return
    setTitle('')
    setStatus(defaultStatus)
    setUrl('')
    setDue('')
    setError(null)
    setSaving(false)
  }, [open, defaultStatus])

  const slug = slugify(title)
  const taskId = slug ? `${initiativeId}/${slug}` : ''
  const duplicate = !!taskId && existingTaskIds.includes(taskId)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return setError('Title is required.')
    if (!slug) return setError('Could not derive a slug from that title.')
    if (duplicate) return setError(`Task "${slug}" already exists.`)
    setSaving(true)
    void upsertTask({
      id: taskId,
      initiative_id: initiativeId,
      title: title.trim(),
      status,
      url: url.trim() || undefined,
      due_date: due || undefined,
    })
      .then(() => {
        onOpenChange(false)
        onCreated(taskId)
      })
      .catch((err) => {
        setSaving(false)
        setError(String(err))
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-md'>
        <div className='flex flex-col gap-1'>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            {taskId ? (
              <code className='text-label'>{taskId}</code>
            ) : (
              'A task under this initiative - the id is derived from the title.'
            )}
          </DialogDescription>
        </div>

        <form onSubmit={submit} className='flex flex-col gap-3'>
          <Field label='Title'>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              autoFocus
              value={title}
              onChange={(e) => {
                setTitle(e.target.value)
                setError(null)
              }}
              placeholder='Short identifier (e.g. Silkweave for owner/repo)'
              className={inputCls}
            />
          </Field>

          <Field label='Status'>
            <StatusSelect value={status} onChange={setStatus} className='w-full' />
          </Field>

          <Field label='Due date'>
            <DateInput value={due} onChange={setDue} ariaLabel='Due date' />
          </Field>

          <Field label='URL'>
            <UrlInput value={url} onChange={setUrl} placeholder='optional' />
          </Field>

          {error && <p className='text-label text-danger'>{error}</p>}

          <div className='mt-1 flex items-center justify-end gap-2'>
            <Button type='button' variant='ghost' size='sm' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={saving || !title.trim() || duplicate}>
              {saving ? 'Creating…' : 'Create task'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={cn('flex flex-col gap-1')}>
      <span className='text-label text-muted-foreground'>{label}</span>
      {children}
    </label>
  )
}
