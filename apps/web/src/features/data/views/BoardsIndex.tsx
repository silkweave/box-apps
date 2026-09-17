import { useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Plus, Trash2, Waypoints } from 'lucide-react'
import { PageContainer, PageHeader, Button, confirm, Dialog, DialogContent, DialogDescription, DialogTitle } from '@silkweave/box-ui'
import { removeBoard, saveBoard, saveBoardNodes, useBoardsData } from '../lib/useBoardsData.ts'
import { useSignalsData } from '../lib/useSignalsData.ts'
import { layoutByDepth, wiredSignals } from '../lib/boardGraph.ts'
import { relativeTime } from '../../../lib/format.ts'

// The boards index. A board is a thing you CREATE: nothing is auto-seeded server-side (DDL-time
// code inserting data rows is a pattern this repo avoids, and a server seed would resurrect on
// every fresh warehouse even after someone deleted it deliberately). Instead the empty state
// offers the one-click "Start from the wired graph", which reproduces the old implicit board -
// client-side layout, saved through the ordinary tools.

/** A label → board id slug, in the id charset the server enforces. */
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

/** First free id in the `base`, `base-2`, `base-3` … series. */
function freeId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }
  return `${base}-${Date.now()}`
}

export function BoardsIndex() {
  const { data } = useBoardsData()
  const { data: signals } = useSignalsData()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!data) return null
  const taken = new Set(data.boards.map((b) => b.id))

  // The B3 list's other job: "what still needs wiring" is a question about the GLOBAL graph, which
  // the per-board picker no longer answers. It lives here as one line.
  const unwired = signals ? signals.signals.length - wiredSignals(signals.signals).length : 0

  const seedFromWired = async () => {
    if (!signals) return
    setBusy(true)
    setError(null)
    try {
      const id = freeId('wired-graph', taken)
      await saveBoard({ id, label: 'Wired graph', description: 'Every signal that participates in a dependency edge.' })
      await saveBoardNodes(id, layoutByDepth(wiredSignals(signals.signals)))
      await navigate({ to: '/boards/$id', params: { id } })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer width='wide'>
      <PageHeader
        title='Circuit Boards'
        description='A board is a named composite of signals - which ones are on it, and where each sits. Edges are not stored here: they live on the signals themselves, so an edge draws whenever both of its endpoints are on the board.'
        actions={
          <Button size='sm' onClick={() => setCreating(true)}>
            <Plus /> New board
          </Button>
        }
      />

      {error && <p className='mt-4 text-body-sm text-danger'>{error}</p>}

      {data.boards.length === 0 ? (
        <div className='mt-10 grid place-items-center rounded-lg border border-border border-dashed px-6 py-16 text-center'>
          <Waypoints className='size-6 text-muted-foreground' />
          <p className='mt-3 max-w-prose text-body-sm text-muted-foreground'>
            No boards yet. Start one empty and add signals from the picker, or seed a board from every
            signal that already declares a dependency.
          </p>
          <div className='mt-5 flex flex-wrap items-center justify-center gap-2'>
            <Button size='sm' onClick={() => setCreating(true)}>
              <Plus /> New board
            </Button>
            <Button size='sm' variant='outline' disabled={busy || !signals} onClick={() => void seedFromWired()}>
              Start from the wired graph
            </Button>
          </div>
        </div>
      ) : (
        <ul className='mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
          {data.boards.map((b) => (
            <li key={b.id}>
              <div className='group relative h-full rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent/60'>
                <Link to='/boards/$id' params={{ id: b.id }} className='block'>
                  <h2 className='truncate text-body font-medium text-text'>{b.label}</h2>
                  <p className='mt-1 line-clamp-2 min-h-8 text-body-sm text-muted-foreground'>
                    {b.description || 'No description.'}
                  </p>
                  <p className='mt-3 text-label text-muted-foreground'>
                    {b.nodes.length} signal{b.nodes.length === 1 ? '' : 's'} · updated {relativeTime(b.updated_at)}
                    {b.updated_by ? ` by ${b.updated_by}` : ''}
                  </p>
                </Link>
                <Button
                  size='icon-xs'
                  variant='ghost'
                  aria-label={`Delete ${b.label}`}
                  title='Delete this board (the signals are untouched)'
                  className='absolute top-2 right-2 hidden text-muted-foreground hover:text-danger group-hover:inline-flex'
                  onClick={() => {
                    void (async () => {
                      const ok = await confirm({
                        title: `Delete "${b.label}"?`,
                        message: 'The arrangement is gone - there is no undo. The signals, their edges and their points are untouched.',
                        confirmLabel: 'Delete board',
                        danger: true,
                      })
                      if (ok) await removeBoard(b.id)
                    })()
                  }}>
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {signals && unwired > 0 && (
        <p className='mt-6 text-label text-muted-foreground'>
          {unwired} signal{unwired === 1 ? ' participates' : 's participate'} in no dependency edge at all -{' '}
          <Link to='/signals' className='hover:text-accent hover:underline'>
            open the signals grid
          </Link>{' '}
          to declare what drives what.
        </p>
      )}

      <NewBoardDialog
        open={creating}
        taken={taken}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false)
          void navigate({ to: '/boards/$id', params: { id } })
        }}
      />
    </PageContainer>
  )
}

function NewBoardDialog({
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
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = label.trim() ? freeId(slugify(label), taken) : ''

  const submit = async () => {
    if (!id) return
    setBusy(true)
    setError(null)
    try {
      await saveBoard({ id, label: label.trim(), description: description.trim() })
      setLabel('')
      setDescription('')
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
        <DialogTitle>New circuit board</DialogTitle>
        <DialogDescription>
          Name it after the story it tells - "Outreach funnel", "MRR ladder". The id is derived from the
          name and is what tools and links use.
        </DialogDescription>
        <label className='flex flex-col gap-1 text-label text-muted-foreground'>
          Name
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            className='rounded-md border border-border bg-bg px-2 py-1.5 text-body-sm text-text outline-none focus:border-accent'
          />
        </label>
        <label className='flex flex-col gap-1 text-label text-muted-foreground'>
          Description (optional)
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            className='rounded-md border border-border bg-bg px-2 py-1.5 text-body-sm text-text outline-none focus:border-accent'
          />
        </label>
        <p className='text-label text-muted-foreground'>
          id: <code>{id || '…'}</code>
        </p>
        {error && <p className='text-label text-danger'>{error}</p>}
        <div className='flex justify-end gap-2'>
          <Button size='sm' variant='ghost' onClick={onClose}>
            Cancel
          </Button>
          <Button size='sm' disabled={!id || busy} onClick={() => void submit()}>
            Create board
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
