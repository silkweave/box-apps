// The editable field grid of a task - ONE implementation, two surfaces: the task page
// (`views/TaskDetailView.tsx`) and the modal (`TaskDialog.tsx`) the sprint boards open. Two copies
// of this drifted the moment one of them gained a field, and the drift is invisible until someone
// edits the same task from the other side and finds the control missing.
//
// It owns no state: every control commits straight to the store on change, same as the page always
// did. `slug` is a SLOT rather than a field because renaming a task re-keys it and moves its doc,
// which only makes sense where there is a route to send you to afterwards.

import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { setTaskStatus, upsertTask } from '../lib/usePlanningData.ts'
import { StatusSelect } from './status.tsx'
import { PriorityStars, TagPicker } from './dimensions.tsx'
import { TaskHours } from './TaskHours.tsx'
import { inlineSelectCls, DateInput, UrlInput, UserPicker, UserChip } from '@silkweave/box-ui'
import type { Task } from '../planning-types.ts'

export function TaskFields({
  task,
  tagSuggestions,
  slug,
  className,
  variant = 'card',
  showCreatedBy = true,
  collapseExtras = false,
}: {
  task: Task
  tagSuggestions: string[]
  /** The slug/rename control, when the surface can route to the renamed task. */
  slug?: ReactNode
  className?: string
  /** `flat` drops the panel chrome - for a surface that is already a panel (the modal). */
  variant?: 'card' | 'flat'
  /** The page puts it in the grid; the modal puts it in its footer. */
  showCreatedBy?: boolean
  /** Fold due date, tags and URL behind an "Additional details" row - the three fields a planning
   *  pass reads least, and the modal is short enough to be worth keeping short. */
  collapseExtras?: boolean
}) {
  const id = task.id
  const [extrasOpen, setExtrasOpen] = useState(false)
  const extrasShown = !collapseExtras || extrasOpen
  return (
    <section
      className={cn(
        'grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-4',
        variant === 'card' && 'rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)',
        className,
      )}>
      <Field label='Status'>
        <StatusSelect value={task.status} onChange={(s) => void setTaskStatus(id, s)} className={inlineSelectCls} />
      </Field>
      <Field label='Owner'>
        <UserPicker value={task.assignee} onChange={(who) => void upsertTask({ id, assignee: who ?? '' })} />
      </Field>
      <Field label='Priority'>
        <PriorityStars value={task.priority} onChange={(p) => void upsertTask({ id, priority: p ?? 0 })} className='h-8' />
      </Field>
      <Field label='Estimate'>
        {/* The eight-segment clicker rather than the dense `4h` face: this is the surface where a
            person DECIDES the estimate, and one click per value is what makes them bother. */}
        <TaskHours
          value={task.estimate_hours}
          onChange={(h) => void upsertTask({ id, estimate_hours: h ?? 0 })}
          className='h-8'
        />
      </Field>
      {slug && <Field label='Slug'>{slug}</Field>}
      {collapseExtras && (
        <div className='sm:col-span-4'>
          <button
            type='button'
            onClick={() => setExtrasOpen((v) => !v)}
            aria-expanded={extrasOpen}
            className='inline-flex items-center gap-1 rounded-md py-0.5 text-label text-muted-foreground transition-colors hover:text-text'>
            <ChevronRight className={cn('size-3.5 transition-transform', extrasOpen && 'rotate-90')} aria-hidden />
            Additional details
          </button>
        </div>
      )}
      {extrasShown && (
        <>
          <Field label='Due date' className='sm:col-span-2'>
            {/* A picker commits on selection - no half-typed state to defer, so no InlineEdit wrapper. */}
            <DateInput
              value={task.due_date ?? ''}
              ariaLabel='Due date'
              onChange={(v) => v !== (task.due_date ?? '') && void upsertTask({ id, due_date: v })}
            />
          </Field>
          <Field label='Tags' className='sm:col-span-4'>
            <TagPicker
              value={task.tags}
              suggestions={tagSuggestions}
              onChange={(tags) => tags.join(',') !== task.tags.join(',') && void upsertTask({ id, tags })}
            />
          </Field>
          <Field label='URL' className='sm:col-span-4'>
            <UrlInput
              defaultValue={task.url ?? ''}
              onCommit={(v) => v !== (task.url ?? '') && void upsertTask({ id, url: v })}
            />
          </Field>
        </>
      )}
      {showCreatedBy && task.created_by && (
        <Field label='Created by'>
          <span className='px-1.5'>
            <UserChip userId={task.created_by} showName />
          </span>
        </Field>
      )}
    </section>
  )
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className='text-label text-muted-foreground'>{label}</span>
      {children}
    </label>
  )
}
