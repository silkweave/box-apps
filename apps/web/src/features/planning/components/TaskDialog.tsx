// A task, editable in place, without leaving the surface you found it on. The sprint boards open
// this on a card click: planning is a comparing activity, and routing away to a full page to change
// one size and come back is how a planning pass turns into twenty round trips.
//
// It is the SAME field grid as the task page (`TaskFields`), so nothing is editable there and
// read-only here - and since 2026-09-08 it carries the task's DOC too, because reading what a task
// actually is turns out to be most of what planning one needs. Since 2026-09-14 it can DELETE the
// task as well, so the modal is now the whole task bar the metadata JSON - and it is what earned
// the sprint card the right to stop being a form (see `sprint/TaskCard.tsx`).
//
// Its shape follows the same rule as the card: the facts you plan with are on top, the ones you
// rarely touch (tags, URL, due date) are one click down behind "Additional details", and the
// provenance line - who created it - sits in the footer where a signature goes.
//
// A SPRINT task (made on the grid, no initiative) opens here too, and only here: it has no
// initiative and therefore no task page, so "Open full page" is not offered for one.

import { useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ExternalLink, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, InlineEdit, Button, UserChip, confirm } from '@silkweave/box-ui'
import { PlanningStatusPill } from './StatusPill.tsx'
import { TaskFields } from './TaskFields.tsx'
import { DocEditor } from '../../../components/DocEditor.tsx'
import { deleteTask, upsertTask, usePlanningData } from '../lib/usePlanningData.ts'
import { reloadSprint } from '../lib/useSprintsData.ts'
import type { Task } from '../planning-types.ts'

export function TaskDialog({
  taskId,
  onClose,
  sprintTasks,
}: {
  taskId: string | null
  onClose: () => void
  /** The open sprint's tasks - the only place a SPRINT task (no initiative) can be found. */
  sprintTasks?: Task[]
}) {
  const { data } = usePlanningData()
  const navigate = useNavigate()
  // Focus the popup, not its first field: base-ui otherwise lands on the title's InlineEdit, so the
  // dialog opens mid-rename and Escape means "discard the title" instead of "close".
  const popup = useRef<HTMLDivElement>(null)

  // The board store first - it is patched optimistically, so it is the fresher copy of any task it
  // holds. A sprint task is in no initiative and only the sprint's own list carries it.
  const initiative = taskId ? ((data ?? []).find((i) => i.tasks.some((t) => t.id === taskId)) ?? null) : null
  const task = initiative?.tasks.find((t) => t.id === taskId) ?? sprintTasks?.find((t) => t.id === taskId) ?? null
  const sprintOnly = Boolean(task && !task.initiative_id)
  // Every tag in use, initiatives and tasks alike - one shared vocabulary, as on the task page.
  const tagSuggestions = [...new Set((data ?? []).flatMap((i) => [...i.tags, ...i.tasks.flatMap((t) => t.tags)]))].sort()

  const onDelete = (): void => {
    if (!task) return
    void confirm({
      title: `Delete task "${task.title}"?`,
      message: sprintOnly
        ? 'It exists only in this sprint, so this removes it for good. Its doc on disk stays.'
        : 'Its doc on disk stays.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      onClose()
      void deleteTask(task.id).then(reloadSprint)
    })
  }

  return (
    <Dialog open={Boolean(taskId)} onOpenChange={(open) => !open && onClose()}>
      {/* Taller and wider than the default popup, and it SCROLLS: the doc editor has no natural
          ceiling, and a modal that grows past the viewport strands its own footer. */}
      <DialogContent ref={popup} initialFocus={popup} className='max-h-[88dvh] max-w-3xl overflow-y-auto'>
        {!task ? (
          <p className='py-6 text-center text-body-sm text-muted-foreground'>
            {data ? 'Task not found - it may have been deleted.' : 'Loading…'}
          </p>
        ) : (
          <>
            <div className='min-w-0'>
              <div className='flex items-center gap-2'>
                <PlanningStatusPill status={task.status} />
                <span
                  className='truncate text-label text-muted-foreground'
                  title={sprintOnly ? 'Created on the sprint grid - it belongs to this sprint and no initiative' : initiative?.title}>
                  {sprintOnly ? 'Sprint task · no initiative' : initiative?.title}
                </span>
              </div>
              <DialogTitle className='sr-only'>{task.title}</DialogTitle>
              <div className='-ml-2 mt-1.5'>
                <InlineEdit
                  key={task.id}
                  defaultValue={task.title}
                  aria-label='Title'
                  inputClassName='h-auto py-1 text-display-sm font-semibold tracking-tight'
                  onCommit={(v) => v.trim() && v !== task.title && void upsertTask({ id: task.id, title: v.trim() })}
                />
              </div>
            </div>

            {/* Flat: the dialog IS the panel, so a bordered card inside one is a box in a box. */}
            <TaskFields
              task={task}
              tagSuggestions={tagSuggestions}
              variant='flat'
              collapseExtras
              showCreatedBy={false}
            />

            {/* `key` on the task id: the editor seeds its content once per doc, so re-opening the
                modal on a different task has to give it a fresh instance. */}
            <DocEditor key={task.id} kind='task' id={task.id} compact placeholder='What is this task, really?' />

            <div className='flex items-center gap-3'>
              {task.created_by && (
                <span className='flex min-w-0 items-center gap-1.5 text-label text-muted-foreground'>
                  Created by <UserChip userId={task.created_by} showName />
                </span>
              )}
              <Button variant='destructive' size='sm' className='ml-auto shrink-0' onClick={onDelete}>
                <Trash2 /> Delete
              </Button>
              {initiative && (
                <Button
                  variant='outline'
                  size='sm'
                  className='shrink-0'
                  onClick={() => {
                    onClose()
                    void navigate({
                      to: '/initiatives/$id/$taskSlug',
                      params: { id: initiative.id, taskSlug: task.id.slice(initiative.id.length + 1) },
                    })
                  }}>
                  <ExternalLink /> Open full page
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
