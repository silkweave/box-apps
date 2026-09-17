import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import type { Signal, SignalHealth } from '../../../types.ts'
import { channelLabel } from '../../../types.ts'
import { CircuitBoardFlow } from '../components/board/CircuitBoardFlowLazy.tsx'
import { useSignalsData } from '../lib/useSignalsData.ts'
import { saveBoardNodes, useBoardsData } from '../lib/useBoardsData.ts'
import { layoutByDepth, nextFreeSlot, type BoardPlacement } from '../lib/boardGraph.ts'
import { healthLook } from '../lib/signalHealth.ts'
import { cn } from '@/lib/utils'

// One circuit board: the persisted composite of signals, its edges drawn from the one global
// dependency graph (an edge renders when both endpoints are members).
//
// PERSISTENCE, and the one subtle rule in this file. `placements` is local state; every change
// (drag stop, picker add, node remove, arrange) arms a ~2s debounced save of the WHOLE node list,
// flushed on navigation away. A DIRTY FLAG - local edits not yet acknowledged by a resolved save -
// governs what an incoming `boardsData` reload may do: while dirty the reload is ignored for
// COORDINATES (our copy is the newer truth and, under last-write-wins, the one that will land),
// while everything drawn from `signalsData` - labels, health, points, edges - keeps updating
// freely. Without that rule the change feed's echo of our own save, or a teammate's, yanks a node
// mid-drag.
//
// Saves are idempotent and last-write-wins per board: the whole column is replaced, no version
// precondition, no 409. Two people arranging one board concurrently lose one arrangement,
// attributed by `updated_by`.

const SAVE_DEBOUNCE_MS = 2_000

const LEGEND: SignalHealth[] = ['met', 'on_track', 'off_track', 'no_data', 'no_target']

const sameNodes = (a: BoardPlacement[], b: BoardPlacement[]): boolean =>
  a.length === b.length && a.every((p, i) => p.signal_id === b[i].signal_id && p.x === b[i].x && p.y === b[i].y)

export function BoardView() {
  const { id } = useParams({ strict: false }) as { id: string }
  const { data } = useBoardsData()
  const { data: signalsData } = useSignalsData()
  const board = data?.boards.find((b) => b.id === id) ?? null

  // `null` until this board's stored nodes have been adopted once - so the canvas mounts WITH its
  // arrangement and React Flow's one-shot fitView frames the real board rather than an empty pane.
  const [adopted, setPlacements] = useState<BoardPlacement[] | null>(null)
  const placements = adopted ?? []
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const dirty = useRef(false)
  const pending = useRef<{ id: string; nodes: BoardPlacement[] } | null>(null)
  const timer = useRef<number | undefined>(undefined)

  /** Send whatever is queued, now. Called by the debounce timer and on navigation away. */
  const flush = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    const queued = pending.current
    if (!queued) return
    pending.current = null
    void saveBoardNodes(queued.id, queued.nodes)
      .then(() => {
        setSaveError(null)
        // Only stop being dirty if nothing was edited while this save was in flight - otherwise a
        // reload could still land on top of an unsaved arrangement.
        if (pending.current === null) dirty.current = false
      })
      .catch((e: unknown) => {
        // Stay dirty on failure: the local arrangement is still the newer truth, and the next edit
        // (or the next flush) retries it. Nothing is silently discarded.
        setSaveError(e instanceof Error ? e.message : String(e))
      })
  }, [])

  const commit = useCallback(
    (next: BoardPlacement[]) => {
      setPlacements(next)
      dirty.current = true
      pending.current = { id, nodes: next }
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
    },
    [id, flush],
  )

  // Switching boards (or leaving) flushes the arrangement we were holding, and the next board
  // starts clean so its stored nodes are adopted.
  useEffect(() => {
    dirty.current = false
    setPlacements(null)
    return () => flush()
  }, [id, flush])

  // The refetch rule: adopt the server's node list wholesale when NOT dirty, ignore it when dirty.
  useEffect(() => {
    if (!board || dirty.current) return
    setPlacements((cur) => (cur && sameNodes(cur, board.nodes) ? cur : board.nodes))
  }, [board])

  const memberIds = useMemo(() => new Set(placements.map((p) => p.signal_id)), [placements])
  const members = useMemo(
    () => (signalsData ? signalsData.signals.filter((s) => memberIds.has(s.id)) : []),
    [signalsData, memberIds],
  )

  const add = useCallback(
    (signalId: string) => commit([...placements, { signal_id: signalId, ...nextFreeSlot(placements) }]),
    [placements, commit],
  )
  const arrange = useCallback(() => {
    // layoutByDepth returns members in ITS order; a placement for a signal the payload does not
    // resolve is kept where it is rather than dropped - the read path never mutates membership.
    const laid = new Map(layoutByDepth(members).map((p) => [p.signal_id, p]))
    commit(placements.map((p) => laid.get(p.signal_id) ?? p))
  }, [members, placements, commit])

  if (!data || !signalsData) return null
  if (!board) {
    return (
      <div className='grid h-full place-items-center px-8 text-center text-body-sm text-muted-foreground'>
        <p className='max-w-prose'>
          No board with the id <code>{id}</code>. It may have been deleted - pick one from the sidebar.
        </p>
      </div>
    )
  }

  const offBoard = signalsData.signals.filter((s) => !memberIds.has(s.id))

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <header className='flex flex-wrap items-center justify-between gap-3 px-4 pt-6 pb-3 md:px-8'>
        <div className='min-w-0'>
          <h1 className='text-heading-2 font-semibold text-text'>{board.label}</h1>
          <p className='mt-1 max-w-prose text-body-sm text-muted-foreground'>
            {board.description || (
              <>
                {placements.length} signals on this board. An edge is a curated causal claim - moving the
                lower number is how you move the upper one - and never a calculation.
              </>
            )}
          </p>
          {saveError && <p className='mt-1 text-label text-danger'>Positions not saved: {saveError}</p>}
        </div>
        <ul className='flex flex-wrap items-center gap-3'>
          {LEGEND.map((h) => {
            const look = healthLook(h)
            return (
              <li key={h} className='flex items-center gap-1.5 text-label text-muted-foreground' title={look.hint}>
                <span aria-hidden className='size-2 rounded-full' style={{ background: look.color }} />
                {look.label}
              </li>
            )
          })}
        </ul>
      </header>

      <div className='flex min-h-0 flex-1 border-y border-border'>
        <div className='relative min-w-0 flex-1'>
          {adopted === null ? (
            <div className='grid h-full place-items-center text-body-sm text-muted-foreground'>Loading board…</div>
          ) : (
            <CircuitBoardFlow
              signals={signalsData.signals}
              sources={signalsData.sources}
              placements={adopted}
              onPlacements={commit}
              onArrange={arrange}
              onTogglePicker={() => setPickerOpen((o) => !o)}
              pickerOpen={pickerOpen}
            />
          )}
          {adopted?.length === 0 && (
            <div className='pointer-events-none absolute inset-0 grid place-items-center px-8 text-center'>
              <p className='max-w-prose text-body-sm text-muted-foreground'>
                This board is empty. Open "Add signals" and click the ones that belong on it - they land on
                the grid below whatever is already here.
              </p>
            </div>
          )}
        </div>
        {pickerOpen && <PickerPanel signals={offBoard} onAdd={add} onClose={() => setPickerOpen(false)} />}
      </div>
    </div>
  )
}

/**
 * The picker: every signal NOT on this board, searchable and grouped by channel, click to add. A
 * side panel rather than a modal, because seeing the canvas while choosing what to add is the whole
 * point. Adding never opens a layout decision - the new node lands on the next free grid slot.
 */
function PickerPanel({
  signals,
  onAdd,
  onClose,
}: {
  signals: Signal[]
  onAdd: (signalId: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const matches = q
    ? signals.filter((s) => s.label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
    : signals
  const groups = useMemo(() => {
    const byChannel = new Map<string, Signal[]>()
    for (const s of matches) byChannel.set(s.channel, [...(byChannel.get(s.channel) ?? []), s])
    return [...byChannel.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [matches])

  return (
    <aside className='flex w-72 shrink-0 flex-col border-l border-border bg-surface'>
      <div className='flex items-center gap-2 border-b border-border px-3 py-2'>
        <Search className='size-3.5 shrink-0 text-muted-foreground' />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Search signals…'
          className='min-w-0 flex-1 bg-transparent text-body-sm text-text outline-none placeholder:text-muted-foreground'
        />
        <button
          type='button'
          onClick={onClose}
          className='shrink-0 text-label text-muted-foreground hover:text-text'>
          Close
        </button>
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto px-3 py-2'>
        {groups.length === 0 ? (
          <p className='text-label text-muted-foreground'>
            {signals.length === 0 ? 'Every signal is already on this board.' : 'Nothing matches that.'}
          </p>
        ) : (
          groups.map(([channel, list]) => (
            <div key={channel} className='mb-3'>
              <p className='mb-1 text-label font-medium text-muted-foreground'>{channelLabel(channel)}</p>
              <ul>
                {list.map((s) => {
                  const look = healthLook(s.health)
                  return (
                    <li key={s.id}>
                      <button
                        type='button'
                        onClick={() => onAdd(s.id)}
                        title={`Add ${s.id} to this board`}
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-body-sm text-text',
                          'hover:bg-bg hover:text-accent',
                        )}>
                        <span aria-hidden className='size-2 shrink-0 rounded-full' style={{ background: look.color }} />
                        <span className='truncate'>{s.label}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
