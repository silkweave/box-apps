import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './circuitBoard.css'
import { Settings2, X } from 'lucide-react'
import type { Signal, SignalDataSource } from '../../../../types.ts'
import { buildBoardView, GRID, NODE_H, NODE_W, type BoardPlacement } from '../../lib/boardGraph.ts'
import { healthLook, targetProgress } from '../../lib/signalHealth.ts'
import { Button } from '@silkweave/box-ui'
import { channelIcon } from '@/lib/channelIcons.tsx'
import { formatBucket, formatNumber, relativeTime } from '../../../../lib/format.ts'
import { signalSlug } from '../../lib/signalSlug.ts'
import { cn } from '@/lib/utils'

// The circuit board canvas - React Flow, loaded through CircuitBoardFlowLazy so ~150 kB of graph
// library only reaches a browser that opens a board route.
//
// Positions come from the BOARD ROW (signal_boards.nodes) and go back to it: this component is
// controlled by `placements` and reports every membership/position change up through
// `onPlacements`, where the debounced autosave lives. React Flow owns positions only for the
// duration of a drag, which is why the seed effect keys off a signature of the placements rather
// than their array identity - a `signalsData` refresh (health, points) must never yank a node the
// user is dragging.
//
// The card is the reference design's 240x96 on a 16px snap grid, so the visible dots ARE the grid.

const INTERVAL_WORD: Record<Signal['interval'], string> = {
  hour: 'hourly',
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
}

/** The per-node payload. React Flow requires an index signature on node data. */
type SignalNodeData = {
  signal: Signal
  sources: SignalDataSource[]
  /** Dimmed = not in the selected signal's up/downstream chain. */
  dimmed: boolean
  focused: boolean
  onRemove: (signalId: string) => void
  onOpen: (signal: Signal) => void
  [key: string]: unknown
}

/**
 * The judged point - not the last one: for an increment signal the newest bucket is still filling.
 * `health_at` is the bucket the server judged, so the value that matches it is the one a board
 * shows. A board number is ONE bucket, never a running total.
 */
function judgedIndex(signal: Signal): number {
  if (signal.points.length === 0) return -1
  if (signal.health_at) {
    const i = signal.points.findIndex((p) => p.date.startsWith(signal.health_at!.slice(0, 10)))
    if (i >= 0) return i
  }
  return signal.points.length - 1
}

/**
 * Period-over-period change: the judged complete bucket against the one before it (a snapshot
 * signal therefore compares its latest two points). Client-side on purpose - the payload carries
 * the points, and a delta is presentation, not a stored fact.
 */
function periodDelta(signal: Signal): number | null {
  const i = judgedIndex(signal)
  if (i < 1) return null
  const prev = signal.points[i - 1].value
  if (prev === 0) return null
  return ((signal.points[i].value - prev) / Math.abs(prev)) * 100
}

/** A bar sparkline of the last ~20 buckets, in the signal's health tone with a left-to-right
 *  opacity ramp - the reference's "history behind the number", never a second axis to read. */
function Sparkline({ signal, color }: { signal: Signal; color: string }) {
  const points = signal.points.slice(-20)
  if (points.length < 2) return null
  const max = Math.max(...points.map((p) => Math.abs(p.value)), 1)
  return (
    <div aria-hidden className='pointer-events-none absolute inset-x-0 bottom-0 flex h-12 items-end gap-[4px] opacity-35'>
      {points.map((p, i) => (
        <span
          key={p.date}
          className='flex-1 rounded-[1px]'
          style={{
            height: `${Math.max(12, (Math.abs(p.value) / max) * 100)}%`,
            background: color,
            opacity: 0.1 + (i / Math.max(1, points.length - 1)) * 0.65,
          }}
        />
      ))}
    </div>
  )
}

/**
 * The footer, by precedence: a TARGET beats provenance (the actionable line wins), a connected but
 * untargeted signal shows where its last measure came from, and a signal with neither shows the
 * bucket its number belongs to. Every field here is already on the payload - the footer never
 * fetches.
 */
function NodeFooter({ signal, sources }: { signal: Signal; sources: SignalDataSource[] }) {
  const look = healthLook(signal.health)
  const i = judgedIndex(signal)
  const latest = i >= 0 ? signal.points[i] : null
  const progress = targetProgress(signal, latest?.value ?? null)
  if (progress) {
    return <span className={cn('truncate tabular-nums', look.tone)}>{progress}</span>
  }

  if (signal.data_source_id) {
    // The SignalDetailView connection-line rules, reused: the source can be GONE (deleted out from
    // under the binding), the last sync can have FAILED, or it can be STALE (read-side only, ~2x
    // the daily cadence every source runs on).
    const source = sources.find((s) => s.id === signal.data_source_id)
    const failed = source?.last_sync_status === 'error'
    const stale =
      source?.status === 'enabled' &&
      !!source.last_sync_at &&
      Date.now() - new Date(source.last_sync_at).getTime() > 2 * 24 * 60 * 60 * 1000
    const Glyph = channelIcon(source?.provider ?? signal.channel)
    const tone = !source || failed ? 'text-danger' : stale ? 'text-warning' : 'text-muted-foreground'
    return (
      <span className={cn('flex min-w-0 items-center gap-1 truncate', tone)}>
        <Glyph className='size-3 shrink-0' />
        {!source ? (
          <>Source {signal.data_source_id} is gone</>
        ) : (
          <span className='truncate' title={`${source.label} · ${signal.measure_key ?? ''}`}>
            {failed ? 'Last measure FAILED via' : 'Last measure via'} {source.label}
            {source.last_sync_at ? ` ${relativeTime(source.last_sync_at)}` : ' - never synced'}
            {stale && !failed ? ' - stale' : ''}
          </span>
        )}
      </span>
    )
  }

  return (
    <span className='truncate tabular-nums text-muted-foreground'>
      {latest ? formatBucket(latest.date) : 'no data yet'}
    </span>
  )
}

function SignalNode({ data }: NodeProps<Node<SignalNodeData>>) {
  const { signal, sources, dimmed, focused, onRemove, onOpen } = data
  const i = judgedIndex(signal)
  const latest = i >= 0 ? signal.points[i] : null
  const look = healthLook(signal.health)
  const delta = periodDelta(signal)
  // A rise is not automatically good: a `down` signal (churn, cost) improving means going down.
  const deltaTone =
    delta == null || Math.abs(delta) < 0.05
      ? 'text-muted-foreground'
      : (delta > 0) === (signal.direction === 'up')
        ? 'text-success'
        : 'text-danger'

  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      title={`${signal.label} - ${look.label}: ${look.hint}`}
      className={cn(
        'group relative flex flex-col rounded-[6px] border bg-surface shadow-(--shadow-sm) transition-opacity',
        focused ? 'border-accent ring-2 ring-accent/40' : 'border-border',
        dimmed && 'opacity-25',
      )}>
      <Handle type='target' position={Position.Bottom} className='!border-border !bg-border' />

      {/* Remove-from-board affordance. It never touches the definition or any edge - the picker
          re-offers the signal immediately. */}
      <button
        type='button'
        aria-label={`Remove ${signal.label} from this board`}
        title='Remove from this board'
        onClick={(e) => {
          e.stopPropagation()
          onRemove(signal.id)
        }}
        className='absolute -top-2 -right-2 z-10 hidden size-5 place-items-center rounded-full border border-border bg-surface text-muted-foreground shadow-(--shadow-sm) hover:text-danger group-hover:grid'>
        <X className='size-3' />
      </button>

      <div className='relative h-16 overflow-hidden rounded-t-[5px] px-3 py-2'>
        <Sparkline signal={signal} color={look.color} />
        <div className='relative flex items-center gap-1.5'>
          {/* The reference card has no health dot; ours keeps it, because `met` and `on_track`
              differ only by colour and on a board of tone-ramped sparklines a discrete dot is the
              unambiguous verdict - the legend already teaches it. */}
          <span aria-hidden className='size-2 shrink-0 rounded-full' style={{ background: look.color }} />
          <span className='min-w-0 flex-1 truncate text-body-sm font-medium text-text'>{signal.label}</span>
          <span className='shrink-0 font-serif text-heading-3 tabular-nums leading-none text-text'>
            {latest ? formatNumber(latest.value) : <span className='text-body-sm text-muted-foreground'>no data</span>}
            {latest && signal.unit ? <span className='ml-1 text-label text-muted-foreground'>{signal.unit}</span> : null}
          </span>
        </div>
        <div className='relative mt-1.5 flex items-baseline justify-between gap-2 text-label'>
          <span className='text-muted-foreground'>{INTERVAL_WORD[signal.interval]}</span>
          {delta != null && (
            <span className={cn('tabular-nums', deltaTone)} title='vs the previous complete bucket'>
              {delta > 0 ? '+' : ''}
              {delta.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      <div className='flex h-8 min-w-0 items-center gap-1.5 border-t border-border px-3 text-label'>
        <NodeFooter signal={signal} sources={sources} />
        <button
          type='button'
          aria-label={`Open ${signal.label}`}
          title='Open the signal'
          onClick={(e) => {
            e.stopPropagation()
            onOpen(signal)
          }}
          className='ml-auto shrink-0 text-muted-foreground hover:text-accent'>
          <Settings2 className='size-3.5' />
        </button>
      </div>

      <Handle type='source' position={Position.Top} className='!border-border !bg-border' />
    </div>
  )
}

const NODE_TYPES: NodeTypes = { signal: SignalNode }

export interface CircuitBoardFlowProps {
  /** Every signal in the payload - the board draws the ones its placements name. */
  signals: Signal[]
  sources: SignalDataSource[]
  placements: BoardPlacement[]
  /** Every membership/position change (drag stop, remove, delete key) - the caller debounces. */
  onPlacements: (next: BoardPlacement[]) => void
  onArrange: () => void
  onTogglePicker: () => void
  pickerOpen: boolean
}

export function CircuitBoardFlow({
  signals,
  sources,
  placements,
  onPlacements,
  onArrange,
  onTogglePicker,
  pickerOpen,
}: CircuitBoardFlowProps) {
  const navigate = useNavigate()
  const view = useMemo(() => buildBoardView(signals, placements), [signals, placements])
  const [focus, setFocus] = useState<string | null>(null)

  // The chain the focused signal belongs to: everything that drives it (down) and everything it
  // drives (up). This is the "where is the red coming from" affordance - the rest dims out.
  const chain = useMemo(() => {
    if (!focus) return null
    const up = new Map<string, string[]>()
    const down = new Map<string, string[]>()
    for (const e of view.edges) {
      up.set(e.source, [...(up.get(e.source) ?? []), e.target])
      down.set(e.target, [...(down.get(e.target) ?? []), e.source])
    }
    const walk = (from: string, adj: Map<string, string[]>): string[] => {
      const seen = new Set<string>()
      const stack = [from]
      while (stack.length > 0) {
        const cur = stack.pop()!
        for (const next of adj.get(cur) ?? []) {
          if (seen.has(next)) continue
          seen.add(next)
          stack.push(next)
        }
      }
      return [...seen]
    }
    return new Set<string>([focus, ...walk(focus, up), ...walk(focus, down)])
  }, [view.edges, focus])

  const remove = useCallback(
    (signalId: string) => onPlacements(placements.filter((p) => p.signal_id !== signalId)),
    [placements, onPlacements],
  )
  const open = useCallback(
    (s: Signal) =>
      void navigate({ to: '/signals/$channel/$signal', params: { channel: s.channel, signal: signalSlug(s) } }),
    [navigate],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<SignalNodeData>>([])
  // Seeding is keyed on a SIGNATURE of the placements, not their array identity: `signals` reloads
  // (a fresh point, a health flip) must not re-seed positions and yank a node mid-drag, while a
  // real membership/position change - including the one we just reported upward - must.
  const signature = useMemo(() => placements.map((p) => `${p.signal_id}:${p.x}:${p.y}`).join('|'), [placements])
  // Belt and braces on top of the caller's dirty flag: a seed that arrives WHILE a node is under
  // the pointer is deferred to drag-stop rather than applied, so nothing ever jumps out from under
  // a drag (a teammate's save, an SSE resync).
  const dragging = useRef(false)
  const deferredSeed = useRef(false)
  const [seedTick, setSeedTick] = useState(0)
  useEffect(() => {
    if (dragging.current) {
      deferredSeed.current = true
      return
    }
    setNodes(
      placements.map((p) => ({
        id: p.signal_id,
        type: 'signal',
        position: { x: p.x, y: p.y },
        data: {} as SignalNodeData, // filled in by `decorated` below, from the live payload
        draggable: true,
      })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` IS the placement content
  }, [signature, seedTick, setNodes])

  const decorated = useMemo(() => {
    const byId = new Map(view.nodes.map((n) => [n.id, n.signal]))
    return nodes.flatMap((n) => {
      const signal = byId.get(n.id)
      if (!signal) return [] // a placement whose signal is gone - dropped at render, never written
      return [
        {
          ...n,
          data: {
            signal,
            sources,
            dimmed: !!chain && !chain.has(n.id),
            focused: focus === n.id,
            onRemove: remove,
            onOpen: open,
          } satisfies SignalNodeData,
        },
      ]
    })
  }, [nodes, view.nodes, sources, chain, focus, remove, open])

  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(signals.map((s) => [s.id, s]))
    return view.edges.map((e) => {
      // The edge takes the DRIVER's health tone: an edge is not a value, it is the path the red
      // travels, so "this lever is off track" should be visible on the wire, not only on the card.
      const look = healthLook(byId.get(e.source)?.health ?? 'no_target')
      const inChain = !chain || (chain.has(e.source) && chain.has(e.target))
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        style: { stroke: look.color, strokeWidth: 1.5, opacity: inChain ? 1 : 0.15 },
      }
    })
  }, [view.edges, signals, chain])

  return (
    <div className='circuit-board flex h-full w-full flex-col'>
      {/* A real row, not an overlay: React Flow's attribution lives bottom-right of the canvas and
          the license requires it stay legible. */}
      <div className='flex items-center justify-between gap-3 border-b border-border px-4 py-1.5 md:px-8'>
        <p className='text-label text-muted-foreground'>
          Click a node to trace its chain · drag to arrange - positions save automatically.
          {view.missingIds.length > 0 && (
            <span className='text-warning'>
              {' '}
              {view.missingIds.length} placement(s) name a signal that no longer exists and are not drawn.
            </span>
          )}
        </p>
        <div className='flex shrink-0 items-center gap-1'>
          <Button size='sm' variant='ghost' onClick={onArrange}>
            Arrange by depth
          </Button>
          <Button size='sm' variant={pickerOpen ? 'secondary' : 'ghost'} onClick={onTogglePicker}>
            Add signals
          </Button>
        </div>
      </div>
      <div className='min-h-0 flex-1'>
        <ReactFlow
          nodes={decorated}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onNodeDragStart={() => {
            dragging.current = true
          }}
          onNodeDragStop={(_, __, dragged) => {
            dragging.current = false
            onPlacements(
              placements.map((p) => {
                const moved = dragged.find((d) => d.id === p.signal_id)
                return moved ? { ...p, x: moved.position.x, y: moved.position.y } : p
              }),
            )
            // A seed that arrived mid-drag was deferred; apply it now (the drag's own positions
            // have just been reported upward, so this cannot lose them).
            if (deferredSeed.current) {
              deferredSeed.current = false
              setSeedTick((t) => t + 1)
            }
          }}
          onNodesDelete={(deleted) => onPlacements(placements.filter((p) => !deleted.some((d) => d.id === p.signal_id)))}
          onNodeClick={(_, n) => setFocus((cur) => (cur === n.id ? null : n.id))}
          onNodeDoubleClick={(_, n) => open((n.data as SignalNodeData).signal)}
          onPaneClick={() => setFocus(null)}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.2}
          snapToGrid
          snapGrid={[GRID, GRID]}
          proOptions={{ hideAttribution: false }}
          nodesConnectable={false}
          // Edges are a curated causal claim, edited on the signal (SignalDialog) - never drawn here
          // by dragging, which would make an unreviewed claim one slip of the mouse away.
          edgesFocusable={false}
          defaultEdgeOptions={{ type: 'smoothstep' }}>
          <Background variant={BackgroundVariant.Dots} gap={GRID} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </div>
  )
}
