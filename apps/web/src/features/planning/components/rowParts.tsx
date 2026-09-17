// The pieces a planning ROW is made of - the grip, the editable title, the open/delete cluster, and
// the type-a-title quick-add. They started life inside `InitiativesGrid`, and moved here on
// 2026-08-24 when the initiative detail view grew a real task list of its own: two surfaces now draw
// the same row, and the point of one file is that they cannot drift into two idioms for "rename a
// task inline".

import { useState } from 'react'
import type { useSortable } from '@dnd-kit/sortable'
import { GripVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { InlineEdit } from '@silkweave/box-ui'
import { upsertTask } from '../lib/usePlanningData.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'
import type { Initiative, PlanningStatus } from '../planning-types.ts'

/** title → slug: lowercase, non-alphanumerics → '-', trimmed. Matches the server's slug rules. */
export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

/** Type-a-title-and-Enter row to create a task under this initiative. */
export function QuickAddTask({
  initiative,
  status = 'planned',
  className,
}: {
  initiative: Initiative
  /** Lifecycle the new task lands in - `planned` unless a surface has a reason to say otherwise. */
  status?: PlanningStatus
  className?: string
}) {
  const [title, setTitle] = useState('')
  const submit = () => {
    const slug = slugify(title)
    if (!slug) return
    const id = `${initiative.id}/${slug}`
    if (initiative.tasks.some((t) => t.id === id)) return
    setTitle('')
    // New tasks default their assignee to the active user (still editable on the row).
    void upsertTask({
      id,
      initiative_id: initiative.id,
      title: title.trim(),
      status,
      assignee: getActiveUserId() ?? undefined,
    })
  }
  return (
    <div className={cn('flex items-center gap-1 py-1 text-muted-foreground', className)}>
      <Plus className='size-3.5 shrink-0' />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
        onBlur={submit}
        placeholder='Add task…'
        className='w-full max-w-md rounded-md border border-transparent bg-transparent px-2 py-1 text-body-sm text-text outline-none transition-colors placeholder:text-fg-4 hover:border-border-light hover:bg-accent-tint focus:border-accent focus:bg-bg'
      />
    </div>
  )
}

export function GripHandle({
  attributes,
  listeners,
}: {
  attributes: ReturnType<typeof useSortable>['attributes']
  listeners: ReturnType<typeof useSortable>['listeners']
}) {
  return (
    <button
      type='button'
      aria-label='Drag to reorder'
      className='shrink-0 cursor-grab touch-none rounded p-0.5 text-fg-4 opacity-0 transition-opacity hover:text-muted-foreground group-hover:opacity-100 active:cursor-grabbing'
      {...attributes}
      {...listeners}>
      <GripVertical className='size-4' />
    </button>
  )
}

/**
 * Name cell: the title reads as a link that navigates to the detail view; a hover-revealed
 * pencil flips it into the inline-edit input (the primary open path is the title click).
 */
export function EditableTitle({
  value,
  summary,
  onOpen,
  onCommit,
  ariaLabel,
  textClassName,
  inputClassName,
}: {
  value: string
  summary?: string
  onOpen: () => void
  onCommit: (value: string) => void
  ariaLabel: string
  textClassName?: string
  inputClassName?: string
}) {
  const [editing, setEditing] = useState(false)
  if (editing)
    return (
      <div className='min-w-0 flex-1'>
        <InlineEdit
          defaultValue={value}
          aria-label={ariaLabel}
          inputClassName={inputClassName}
          autoFocus
          onCommit={onCommit}
          onDone={() => setEditing(false)}
        />
        {summary && <p className='truncate px-2 text-label text-muted-foreground'>{summary}</p>}
      </div>
    )
  return (
    <div className='group/title min-w-0 flex-1'>
      <div className='flex min-w-0 items-center gap-1'>
        <button
          type='button'
          onClick={onOpen}
          title='Open detail / doc'
          className={cn(
            'min-w-0 truncate rounded px-2 py-1 text-left text-body-sm text-text underline-offset-2 outline-none hover:text-accent hover:underline focus-visible:text-accent focus-visible:underline',
            textClassName,
          )}>
          {value}
        </button>
        <button
          type='button'
          onClick={() => setEditing(true)}
          aria-label={`Edit ${ariaLabel}`}
          title='Edit title'
          className='shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent-tint hover:text-accent focus-visible:opacity-100 group-hover/title:opacity-100'>
          <Pencil className='size-3.5' />
        </button>
      </div>
      {summary && <p className='truncate px-2 text-label text-muted-foreground'>{summary}</p>}
    </div>
  )
}

/**
 * The row's trailing cluster. Delete only, since 2026-08-24: it also carried an "open detail" file
 * icon, which was a second door onto the same page the title already opens - and a destructive
 * button reads more clearly when it is the only button next to it.
 */
export function RowActions({ onDelete }: { onDelete: () => void }) {
  return (
    <div className='flex items-center justify-end gap-0.5'>
      <button
        type='button'
        onClick={onDelete}
        title='Delete'
        aria-label='Delete'
        className='rounded p-1 text-muted-foreground hover:bg-danger/10 hover:text-danger'>
        <Trash2 className='size-3.5' />
      </button>
    </div>
  )
}
