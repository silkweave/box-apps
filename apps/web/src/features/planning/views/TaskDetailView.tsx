import { useNavigate, useParams } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { deleteTask, renameTask, usePlanningData } from '../lib/usePlanningData.ts'
import { confirm, PageContainer, TopBarActions, SplitPane, Button, InlineEdit } from '@silkweave/box-ui'
import { DocEditor } from '../../../components/DocEditor.tsx'
import { MetadataEditor } from '../components/MetadataEditor.tsx'
import { TaskFields } from '../components/TaskFields.tsx'
import { appKey } from '@/lib/storage.ts'

/** title/slug → slug: lowercase, non-alphanumerics → '-', trimmed. Matches the server's slug rules. */
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

export function TaskDetailView() {
  const { id, taskSlug } = useParams({ strict: false }) as { id?: string; taskSlug?: string }
  const { data } = usePlanningData()
  const navigate = useNavigate()
  if (!data || !id || !taskSlug) return null

  const taskId = `${id}/${taskSlug}`
  const task = data.find((i) => i.id === id)?.tasks.find((t) => t.id === taskId)
  // Suggest from every tag in use, initiatives and tasks alike - one shared vocabulary is the point.
  const tagSuggestions = [...new Set(data.flatMap((i) => [...i.tags, ...i.tasks.flatMap((t) => t.tags)]))].sort()
  if (!task)
    return <div className='mx-auto max-w-3xl px-4 py-16 text-center text-body-sm text-muted-foreground'>Task not found.</div>

  const onDelete = (): void => {
    void confirm({
      title: `Delete task "${task.title}"?`,
      message: 'This removes its row (the doc file stays on disk).',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => void (ok && deleteTask(taskId).then(() => navigate({ to: '/initiatives/$id', params: { id } }))))
  }

  // Renaming the slug re-keys the task (task-part only, same initiative) and moves its doc; confirm,
  // then route to the new task.
  const renameSlug = (raw: string): void => {
    const next = slugify(raw)
    if (!next || next === taskSlug) return
    const sibling = data.find((i) => i.id === id)?.tasks.some((t) => t.id === `${id}/${next}`)
    if (sibling) return void window.alert(`A task "${next}" already exists in this initiative.`)
    void confirm({
      title: `Rename slug to "${next}"?`,
      message: 'This re-keys the task and moves its doc on disk.',
      confirmLabel: 'Rename',
    }).then(
      (ok) =>
        void (ok && renameTask(taskId, next).then(() => navigate({ to: '/initiatives/$id/$taskSlug', params: { id, taskSlug: next } }))),
    )
  }

  const left = (
    // Full width and no page header, matching the initiative page. The title is edited in the
    // BREADCRUMB (see InitiativesLayout) and the status lives in the field grid below, so the old
    // header row was a second copy of both plus an id nobody reads - and it capped a form that has
    // the frame's whole width to use.
    <PageContainer width='full' key={task.id}>
      {/* Editable fields - presentable at rest, lift to inputs on hover/focus. The top line
          mirrors the initiative card (quarter/quarter/half). Rank is drag-only on the board and
          score belongs to the /ingest-sink rubric - neither gets a field here. The grid itself is
          shared with the task MODAL (components/planning/TaskFields.tsx), so a field added in one
          place exists in both. */}
      <TaskFields
        task={task}
        tagSuggestions={tagSuggestions}
        className='mb-6'
        slug={<InlineEdit key={task.id} defaultValue={taskSlug} aria-label='Slug' onCommit={renameSlug} />}
      />

      {/* Metadata - free-form JSON, view/edit toggle */}
      <MetadataEditor taskId={taskId} metadata={task.metadata} url={task.url} />
    </PageContainer>
  )

  return (
    <>
      {/* Icon-only delete in the bar, exactly as on an initiative - a red trash with a tooltip
          reads as destructive without the word, and the confirm is what actually guards it. */}
      <TopBarActions>
        <Button
          variant='outline'
          size='icon-sm'
          onClick={onDelete}
          className='text-danger'
          title='Delete task'
          aria-label='Delete task'>
          <Trash2 />
        </Button>
      </TopBarActions>
      <SplitPane
        storageKey={appKey('split', 'task')}
        collapseLabel='notes'
        left={left}
        right={<DocEditor key={taskId} kind='task' id={taskId} variant='panel' />}
      />
    </>
  )
}
