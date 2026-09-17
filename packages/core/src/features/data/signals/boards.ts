// Circuit boards - the user-created, user-named composites of signals (docs/WAREHOUSE.md). A board
// row holds MEMBERSHIP + POSITIONS and nothing else: edges live on `signals.depends_on`, curated
// once and cycle-checked once, and a board is a VIEW onto that graph (an edge renders when both of
// its endpoints are members). So there is no per-board edge storage here, and no second cycle
// checker.
//
// The write pattern is whole-board: `nodes` is replaced in full on every autosave, last write wins
// per board, no version precondition. That is why `nodes` is a JSON column rather than a join table
// (the depends_on / signal_ids / blocked_by precedent), and why board-upsert deliberately does NOT
// accept nodes - a label edit can then never race the autosave onto the same column.
//
// The rename/delete CASCADE legs for a signal live with their cascades in signals/definitions.ts;
// the two helpers they call (renameSignalInBoards / pruneSignalFromBoards) are here, next to the
// node shape they rewrite.

import { emitChange } from '../../../changes.js'
import { ensureSchema, withRead, withWrite } from '../../../warehouse/db.js'
import { deleteRecord, readRecord, readRecords, upsertRecord } from '../../../warehouse/model.js'
import { SIGNAL_BOARDS } from '../models.js'

/** Board ids share the data-source id charset: a plain slug, because a board is a user-named thing. */
const BOARD_ID = /^[a-z0-9][a-z0-9-]*$/

/** One PLACEMENT on one board. Never the signal itself - removing a node removes it from THIS
 *  board only, and one signal may sit on any number of boards. */
export interface SignalBoardNode {
  signal_id: string
  /** Flow units. Stored verbatim (floats); snapping to the grid is the client's job. */
  x: number
  y: number
}

export interface SignalBoard {
  id: string
  label: string
  description: string
  nodes: SignalBoardNode[]
  sort: number
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface SignalBoardInput {
  id: string
  label?: string
  /** '' clears it. */
  description?: string
  sort?: number
  actor?: string
}

// --- reads ---------------------------------------------------------------------------------------

// A JSON column can read back null on rows written outside the record layer; hand callers an array.
const norm = (b: SignalBoard): SignalBoard => ({ ...b, nodes: normalizeNodes(b.nodes) })

const normalizeNodes = (raw: unknown): SignalBoardNode[] =>
  Array.isArray(raw)
    ? (raw as unknown[]).flatMap((n) => {
        const node = n as Partial<SignalBoardNode>
        return typeof node?.signal_id === 'string' && typeof node.x === 'number' && typeof node.y === 'number'
          ? [{ signal_id: node.signal_id, x: node.x, y: node.y }]
          : []
      })
    : []

/** Every board, sorted by `sort` then id. Boards are few and small - `nodes` always rides along. */
export async function readSignalBoards(): Promise<SignalBoard[]> {
  return (await readRecords<SignalBoard>(SIGNAL_BOARDS, { orderBy: 'sort, id' })).map(norm)
}

/** One board, or null. */
export async function readSignalBoard(id: string): Promise<SignalBoard | null> {
  const b = await readRecord<SignalBoard>(SIGNAL_BOARDS, { id })
  return b ? norm(b) : null
}

// --- writes --------------------------------------------------------------------------------------

/**
 * Create or partially update a board's METADATA. Never touches `nodes`: the record layer's partial
 * upsert leaves unprovided columns alone, which is exactly what keeps a rename from clobbering an
 * in-flight drag autosave.
 */
export async function upsertSignalBoard(input: SignalBoardInput): Promise<SignalBoard> {
  if (!BOARD_ID.test(input.id)) {
    throw new Error(`invalid board id "${input.id}" (lowercase; a-z 0-9 and dashes; must start alphanumeric)`)
  }
  const prev = await readSignalBoard(input.id)
  return norm(
    await upsertRecord<SignalBoard>(
      SIGNAL_BOARDS,
      {
        id: input.id,
        label: input.label ?? prev?.label ?? input.id,
        description: input.description ?? prev?.description ?? '',
        sort: input.sort ?? prev?.sort ?? 0,
        // A fresh board is born empty; an existing one keeps whatever the autosave last wrote.
        nodes: prev?.nodes ?? [],
        ...(input.actor ? { actor: input.actor } : {}),
      },
      { prev },
    ),
  )
}

/** Delete a board. Nothing cascades - a board owns placements, never signals, edges or points. */
export async function deleteSignalBoard(id: string): Promise<{ id: string; nodes: number }> {
  const board = await readSignalBoard(id)
  if (!board) throw new Error(`board ${id} not found`)
  await deleteRecord(SIGNAL_BOARDS, { id })
  return { id, nodes: board.nodes.length }
}

/**
 * Replace a board's whole node list - the autosave path, and the only writer of `nodes`.
 *
 * Validation is the `depends_on` discipline applied to placements: the shape must be
 * `{signal_id, x, y}` with FINITE coordinates, every `signal_id` must name a registry row (an
 * unknown id means a deleted definition or a bad agent call, never something to store), and one
 * signal may appear at most once per board. Coordinates are stored verbatim: re-validating grid
 * alignment server-side would make the grid size a wire contract for no benefit.
 */
export async function setSignalBoardNodes(id: string, nodes: unknown, actor?: string): Promise<SignalBoard> {
  const prev = await readSignalBoard(id)
  if (!prev) throw new Error(`board ${id} not found`)
  const clean = await validateNodes(id, nodes)
  return norm(
    await upsertRecord<SignalBoard>(
      SIGNAL_BOARDS,
      { id, nodes: clean, ...(actor ? { actor } : {}) },
      { prev },
    ),
  )
}

/** Shape + membership validation for a proposed node list. Refuses with the reason, never coerces. */
async function validateNodes(boardId: string, raw: unknown): Promise<SignalBoardNode[]> {
  if (!Array.isArray(raw)) throw new Error(`board ${boardId}: nodes must be an array of {signal_id, x, y}`)
  const clean: SignalBoardNode[] = []
  const seen = new Set<string>()
  raw.forEach((entry, i) => {
    const n = entry as Partial<SignalBoardNode>
    if (!n || typeof n !== 'object' || typeof n.signal_id !== 'string' || !n.signal_id.trim()) {
      throw new Error(`board ${boardId}: nodes[${i}] needs a non-empty string signal_id`)
    }
    if (typeof n.x !== 'number' || !Number.isFinite(n.x) || typeof n.y !== 'number' || !Number.isFinite(n.y)) {
      throw new Error(`board ${boardId}: nodes[${i}] (${n.signal_id}) needs finite numeric x and y`)
    }
    const signalId = n.signal_id.trim()
    if (seen.has(signalId)) {
      throw new Error(`board ${boardId}: ${signalId} appears twice - a signal sits at one place per board`)
    }
    seen.add(signalId)
    clean.push({ signal_id: signalId, x: n.x, y: n.y })
  })
  if (clean.length === 0) return clean

  await ensureSchema()
  const known = new Set((await withRead<{ id: string }>(`SELECT id FROM signals`)).map((r) => r.id))
  const unknown = [...seen].filter((s) => !known.has(s))
  if (unknown.length > 0) {
    throw new Error(`board ${boardId}: nodes reference unknown signal(s) ${unknown.join(', ')}`)
  }
  return clean
}

// --- the signal rename/delete cascade legs ---------------------------------------------------------
// Every table keyed by `signal_id` has to be reachable from those two cascades - `signal_points` was
// orphaned by a rename once (2026-08-10) and this table is the next one that could be.

/** Write one board's `nodes` verbatim (the cascades bypass the validating upsert on purpose: they
 *  are rewriting rows that were already valid, for an id the caller has just moved or removed). */
async function writeNodes(id: string, nodes: SignalBoardNode[], actor?: string): Promise<void> {
  await withWrite(async (conn) => {
    await conn.run(
      `UPDATE signal_boards SET nodes = ?::JSON, updated_at = now(),
              updated_by = COALESCE(?, updated_by) WHERE id = ?`,
      [JSON.stringify(nodes), actor ?? null, id],
    )
  })
}

/** Rename cascade: re-key `oldId` to `newId` in every board's nodes. Returns the boards touched. */
export async function renameSignalInBoards(oldId: string, newId: string, actor?: string): Promise<string[]> {
  const touched: string[] = []
  for (const board of await readSignalBoards()) {
    if (!board.nodes.some((n) => n.signal_id === oldId)) continue
    // A board that somehow already holds newId keeps ONE placement - the moved one wins, because
    // the duplicate could only be a stale row and two cards for one signal is not renderable.
    const next: SignalBoardNode[] = []
    const seen = new Set<string>()
    for (const n of board.nodes) {
      const signalId = n.signal_id === oldId ? newId : n.signal_id
      if (seen.has(signalId)) continue
      seen.add(signalId)
      next.push({ ...n, signal_id: signalId })
    }
    await writeNodes(board.id, next, actor)
    touched.push(board.id)
  }
  if (touched.length > 0) emitChange('table:signal_boards')
  return touched
}

/** Delete cascade: PRUNE the signal's placement from every board (matching the `depends_on` edge
 *  treatment on delete - unlike a point, a placement has no history worth resurrecting). */
export async function pruneSignalFromBoards(signalId: string, actor?: string): Promise<string[]> {
  const touched: string[] = []
  for (const board of await readSignalBoards()) {
    if (!board.nodes.some((n) => n.signal_id === signalId)) continue
    await writeNodes(
      board.id,
      board.nodes.filter((n) => n.signal_id !== signalId),
      actor,
    )
    touched.push(board.id)
  }
  if (touched.length > 0) emitChange('table:signal_boards')
  return touched
}
