// The circuit board's geometry and layout - pure functions over the `signalsData` payload and a
// board's stored placements, with no React and no React Flow types, so the layering is testable and
// the library stays swappable.
//
// The graph is SIGNALS and their `depends_on` edges. An edge is a curated causal claim ("moving
// the child is how you move the parent") and NOTHING more: the board never sums a parent from its
// children, never weights an edge, never implies arithmetic. It answers two questions - which
// lever moves which number, and where the red is coming from.
//
// A BOARD is a view onto that one global graph: it stores membership + positions (signal_boards.
// nodes), and an edge RENDERS on it exactly when both endpoints are members. So a node whose
// drivers sit off-board renders driverless - the honest consequence of edges living in one place.
//
// Positions are TEAM state, persisted on the board row (never localStorage). The layout below is
// only used to SEED them - "Arrange by depth" and the "start from the wired graph" seed - so
// everything it produces is snapped to the same 16px grid the canvas snaps to.

import type { Signal } from '../../../types.ts'

/** Node geometry, in flow units. The card is the reference design's 240x96 (15x6 grid cells) on a
 *  16px grid, so the visible dots ARE the snap grid and no card edge ever lands off it. */
export const NODE_W = 240
export const NODE_H = 96
/** The one grid size: snapGrid, the Background dot gap, and every layout constant divide by it. */
export const GRID = 16
const COL_GAP = 32
const ROW_GAP = 80

/** Snap a flow coordinate to the grid. The server stores coordinates verbatim - snapping is
 *  deliberately a client concern, so the grid size never becomes a wire contract. */
export const snap = (n: number): number => Math.round(n / GRID) * GRID

/** One placement on one board: which signal, and where it sits. Mirrors the server's node shape. */
export interface BoardPlacement {
  signal_id: string
  x: number
  y: number
}

export interface BoardNode {
  id: string
  signal: Signal
  x: number
  y: number
}

export interface BoardEdge {
  id: string
  /** The driver (lower row). */
  source: string
  /** The signal it drives (upper row). */
  target: string
}

export interface BoardView {
  nodes: BoardNode[]
  edges: BoardEdge[]
  /** Placements naming a signal the payload does not resolve - dropped at RENDER with a visible
   *  count, never auto-written away (the read path never mutates). */
  missingIds: string[]
}

/** Every signal that PARTICIPATES in an edge (drives something or is driven by something). */
export function wiredSignals(all: Signal[]): Signal[] {
  const byId = new Map(all.map((s) => [s.id, s]))
  const connected = new Set<string>()
  for (const s of all) {
    for (const dep of s.depends_on) {
      if (!byId.has(dep)) continue
      connected.add(s.id)
      connected.add(dep)
    }
  }
  return all.filter((s) => connected.has(s.id))
}

/** The edges among a given member set - both endpoints must be members, which is exactly the
 *  board rule (a board cannot show an edge to a signal that is not on it). */
function edgesAmong(members: Signal[]): BoardEdge[] {
  const ids = new Set(members.map((s) => s.id))
  const edges: BoardEdge[] = []
  for (const s of members) {
    for (const dep of s.depends_on) {
      if (ids.has(dep)) edges.push({ id: `${dep}->${s.id}`, source: dep, target: s.id })
    }
  }
  return edges
}

/**
 * Resolve a board's stored placements against the live payload: the nodes to draw (with their
 * persisted positions), the edges that render on this board, and the placements whose signal is
 * gone.
 */
export function buildBoardView(all: Signal[], placements: BoardPlacement[]): BoardView {
  const byId = new Map(all.map((s) => [s.id, s]))
  const nodes: BoardNode[] = []
  const missingIds: string[] = []
  for (const p of placements) {
    const signal = byId.get(p.signal_id)
    if (!signal) {
      missingIds.push(p.signal_id)
      continue
    }
    nodes.push({ id: signal.id, signal, x: p.x, y: p.y })
  }
  return { nodes, edges: edgesAmong(nodes.map((n) => n.signal)), missingIds }
}

/**
 * Lay `members` out by topological depth, DRIVERS AT THE BOTTOM: a signal that depends on nothing
 * (within this member set) is depth 0 and sits on the bottom row; a signal sits one row above its
 * deepest driver, so every edge points strictly upward and the ladder-up story reads bottom-to-top.
 * Members with no edge at all land on the bottom row alongside the roots.
 *
 * Used to SEED positions ("Start from the wired graph", "Arrange by depth") - every coordinate it
 * returns is snapped, so a freshly arranged board is already grid-aligned.
 */
export function layoutByDepth(members: Signal[]): BoardPlacement[] {
  const edges = edgesAmong(members)

  // Depth = 1 + the deepest resolved driver. Iterative with a relaxation cap rather than
  // recursion: the server refuses cycles, but a client that hard-loops on bad data is a worse
  // failure than one that lays a cycle out slightly wrong.
  const depth = new Map<string, number>(members.map((s) => [s.id, 0]))
  const driversOf = new Map<string, string[]>()
  for (const e of edges) driversOf.set(e.target, [...(driversOf.get(e.target) ?? []), e.source])
  for (let pass = 0; pass < members.length; pass++) {
    let moved = false
    for (const s of members) {
      const d = Math.max(0, ...(driversOf.get(s.id) ?? []).map((id) => (depth.get(id) ?? 0) + 1))
      if (d > (depth.get(s.id) ?? 0)) {
        depth.set(s.id, d)
        moved = true
      }
    }
    if (!moved) break
  }

  // Rows, top (deepest) first. Within a row, order by the barycenter of the drivers already placed
  // in the row below - two sweeps of the classic heuristic, which is enough to keep a dozen-node
  // funnel from crossing itself.
  const maxDepth = Math.max(0, ...depth.values())
  const rows: { id: string; signal: Signal; y: number }[][] = []
  for (let d = 0; d <= maxDepth; d++) {
    rows[d] = members
      .filter((s) => depth.get(s.id) === d)
      .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
      .map((s) => ({ id: s.id, signal: s, y: (maxDepth - d) * (NODE_H + ROW_GAP) }))
  }
  const indexIn = (row: { id: string }[], id: string): number => row.findIndex((n) => n.id === id)
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let d = 1; d <= maxDepth; d++) {
      const below = rows[d - 1]
      rows[d] = [...rows[d]]
        .map((n, i) => {
          const anchors = (driversOf.get(n.id) ?? []).map((id) => indexIn(below, id)).filter((i2) => i2 >= 0)
          return { n, key: anchors.length ? anchors.reduce((a, b) => a + b, 0) / anchors.length : i }
        })
        .sort((a, b) => a.key - b.key)
        .map((e) => e.n)
    }
  }

  // Center every row on x = 0 so the board reads as a column of rows rather than a left-aligned
  // staircase, then snap: the centering offset is a half-width and would otherwise put a whole row
  // half a cell off the grid the canvas snaps to.
  const out: BoardPlacement[] = []
  for (const row of rows) {
    const width = row.length * NODE_W + (row.length - 1) * COL_GAP
    row.forEach((n, i) => {
      out.push({ signal_id: n.id, x: snap(-width / 2 + i * (NODE_W + COL_GAP)), y: snap(n.y) })
    })
  }
  return out
}

/**
 * Where a newly picked signal lands: the next free grid slot, scanning left to right in rows just
 * below the current bounding box. Deterministic, never overlapping, always snapped - "add" must
 * not open a layout decision.
 */
export function nextFreeSlot(placements: BoardPlacement[]): { x: number; y: number } {
  if (placements.length === 0) return { x: 0, y: 0 }
  const minX = Math.min(...placements.map((p) => p.x))
  const maxY = Math.max(...placements.map((p) => p.y))
  const maxX = Math.max(...placements.map((p) => p.x))
  const cols = Math.max(1, Math.floor((maxX - minX) / (NODE_W + COL_GAP)) + 1)
  const startY = snap(maxY + NODE_H + ROW_GAP)
  const taken = new Set(placements.map((p) => `${p.x},${p.y}`))
  for (let row = 0; row < 100; row++) {
    for (let col = 0; col < cols; col++) {
      const x = snap(minX + col * (NODE_W + COL_GAP))
      const y = snap(startY + row * (NODE_H + ROW_GAP))
      if (!taken.has(`${x},${y}`)) return { x, y }
    }
  }
  return { x: snap(minX), y: snap(startY) }
}
