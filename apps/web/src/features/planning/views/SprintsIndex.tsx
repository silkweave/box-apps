import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { CalendarRange, Plus, Trash2 } from 'lucide-react'
import { PageContainer, PageHeader, Badge, Button, confirm, DateInput, Dialog, DialogContent, DialogDescription, DialogTitle } from '@silkweave/box-ui'
import { deleteSprint, upsertSprint, useSprintsData } from '../lib/useSprintsData.ts'
import { SPRINT_STATUS_META, formatDay, type Sprint } from '../sprint-types.ts'

// The sprints index: every window, newest first. A sprint is a thing you CREATE, and it starts
// `pending` with no dates - the spec's Sprint Design step is what gives it a window, and a team
// laying out a quarter creates six of these in one sitting before any of them has a date.

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

/** First free id in the `base`, `base-2`, `base-3` … series. */
function freeId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  return `${base}-${Date.now()}`
}

export function SprintsIndex() {
  const { data, error } = useSprintsData()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  if (error) return <PageContainer><p className='text-body-sm text-danger'>{error}</p></PageContainer>
  if (!data) return null
  const taken = new Set(data.map((s) => s.id))

  return (
    <PageContainer width='wide'>
      <PageHeader
        title='Sprints'
        description='A sprint is a window of days with real capacity - a date range, who is available inside it and for how long, and the tasks slotted onto days. It holds no work of its own: initiatives are inferred from the tasks in it, and deleting one releases them.'
        actions={
          <Button size='sm' onClick={() => setCreating(true)}>
            <Plus /> New sprint
          </Button>
        }
      />

      {data.length === 0 ? (
        <div className='mt-10 grid place-items-center rounded-lg border border-dashed border-border px-6 py-16 text-center'>
          <CalendarRange className='size-6 text-muted-foreground' />
          <p className='mt-3 max-w-prose text-body-sm text-muted-foreground'>
            No sprints yet. Create one, set its window and who is on it in Design, then pull tasks in
            and put them on days.
          </p>
          <Button size='sm' className='mt-5' onClick={() => setCreating(true)}>
            <Plus /> New sprint
          </Button>
        </div>
      ) : (
        <ul className='mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
          {data.map((s) => (
            <li key={s.id}>
              <SprintCard sprint={s} />
            </li>
          ))}
        </ul>
      )}

      <NewSprintDialog
        open={creating}
        taken={taken}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false)
          void navigate({ to: '/sprints/$id/$tab', params: { id, tab: 'design' } })
        }}
      />
    </PageContainer>
  )
}

function SprintCard({ sprint: s }: { sprint: Sprint }) {
  const meta = SPRINT_STATUS_META[s.status]
  const people = Object.keys(s.availability ?? {}).length
  return (
    <div className='group relative h-full rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent/60'>
      <Link to='/sprints/$id' params={{ id: s.id }} className='block'>
        <div className='flex items-start gap-2'>
          <h2 className='min-w-0 flex-1 truncate text-body font-medium text-text'>{s.title}</h2>
          <Badge variant={meta.tone} title={meta.hint}>
            {meta.label}
          </Badge>
        </div>
        <p className='mt-1 line-clamp-2 min-h-8 text-body-sm text-muted-foreground'>{s.goal || 'No goal set.'}</p>
        <p className='mt-3 text-label text-muted-foreground'>
          {s.start_date && s.end_date ? `${formatDay(s.start_date)} - ${formatDay(s.end_date)}` : 'No window yet'}
          {people > 0 && ` · ${people} ${people === 1 ? 'person' : 'people'}`}
        </p>
      </Link>
      <Button
        size='icon-xs'
        variant='ghost'
        aria-label={`Delete ${s.title}`}
        title='Delete this sprint (its tasks are released, never deleted)'
        className='absolute top-10 right-2 hidden text-muted-foreground hover:text-danger group-hover:inline-flex'
        onClick={() => {
          void (async () => {
            const ok = await confirm({
              title: `Delete "${s.title}"?`,
              message:
                'The window goes and there is no undo. Its tasks are RELEASED back to their initiatives - they lose their sprint and their day, but nothing is deleted.',
              confirmLabel: 'Delete sprint',
              danger: true,
            })
            if (ok) await deleteSprint(s.id)
          })()
        }}>
        <Trash2 />
      </Button>
    </div>
  )
}

function NewSprintDialog({
  open,
  taken,
  onClose,
  onCreated,
}: {
  open: boolean
  taken: Set<string>
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = title.trim() ? freeId(slugify(title), taken) : ''

  const submit = async () => {
    if (!id) return
    setBusy(true)
    setError(null)
    try {
      // Created `pending` on purpose: dates are optional here, and a status past pending would be
      // refused by the server without both of them.
      await upsertSprint({ id, title: title.trim(), goal: goal.trim(), start_date: start, end_date: end })
      setTitle('')
      setGoal('')
      setStart('')
      setEnd('')
      onCreated(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className='max-w-md'>
        <DialogTitle>New sprint</DialogTitle>
        <DialogDescription>
          Name it the way the team says it out loud - "Sprint 12", "October week 1". The id is derived
          from the name and is what tools and links use. Dates are optional now; Design is where they
          usually get set.
        </DialogDescription>
        <div className='flex flex-col gap-3'>
          <label className='flex flex-col gap-1 text-label font-medium text-muted-foreground'>
            Name
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
              className='h-9 rounded-md border border-border bg-bg px-2.5 text-body-sm text-text outline-none focus:border-accent'
            />
            {id && <span className='font-normal text-fg-4'>id: {id}</span>}
          </label>
          <label className='flex flex-col gap-1 text-label font-medium text-muted-foreground'>
            Goal (optional)
            <input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className='h-9 rounded-md border border-border bg-bg px-2.5 text-body-sm text-text outline-none focus:border-accent'
            />
          </label>
          <div className='grid grid-cols-2 gap-3'>
            <label className='flex flex-col gap-1 text-label font-medium text-muted-foreground'>
              Starts
              <DateInput value={start} onChange={setStart} ariaLabel='Sprint start date' utc />
            </label>
            <label className='flex flex-col gap-1 text-label font-medium text-muted-foreground'>
              Ends
              <DateInput value={end} onChange={setEnd} ariaLabel='Sprint end date' utc />
            </label>
          </div>
          {error && <p className='text-body-sm text-danger'>{error}</p>}
        </div>
        <div className='flex justify-end gap-2'>
          <Button variant='ghost' size='sm' onClick={onClose}>
            Cancel
          </Button>
          <Button size='sm' disabled={!id || busy} onClick={() => void submit()}>
            Create sprint
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
