// Circuit boards ride their OWN store, not `signalsData`. `signalsData` is the heavy payload
// (every point of every signal) and reloads on every `table:signal_points` event; a board changes
// on a ~2s autosave cadence while someone drags a node. Folding boards in would re-push the big
// payload once per drag-save echo. Separate stores mean a drag-save reload costs a few hundred
// bytes, and the board view simply composes the two.

import type { BoardPlacement } from './boardGraph.ts'
import { registerStoreReloads } from '../../../lib/changeFeed.ts'
import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'

/** The active user as the mutation's `actor` audit stamp (created_by/updated_by server-side). */
const actor = (): string | undefined => getActiveUserId() ?? undefined

/** One board row: membership + positions in `nodes`, and nothing about edges (those live on the
 *  signals themselves, curated once). */
export interface CircuitBoard {
  id: string
  label: string
  description: string
  nodes: BoardPlacement[]
  sort: number
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface BoardsData {
  generatedAt: string
  boards: CircuitBoard[]
}

const store = createDataStore<BoardsData>(() => trpc.boardsList.query({}).then((d) => d as unknown as BoardsData))
registerStoreReloads(['table:signal_boards'], store)

export function useBoardsData(): { data: BoardsData | null; error: string | null } {
  return store.useData()
}

/** Force a refetch. */
export const reloadBoards = (): Promise<BoardsData> => store.reload()

/** Create or partially update a board's metadata. Deliberately cannot carry `nodes` - see
 *  boards.controller.ts: a label edit must never race the position autosave onto the same column. */
export async function saveBoard(input: {
  id: string
  label?: string
  description?: string
  sort?: number
}): Promise<void> {
  await trpc.boardsUpsert.mutate({ ...input, actor: actor() })
  await store.reload()
}

/** Delete a board. No undo, no soft delete - the arrangement is gone; the signals are untouched. */
export async function removeBoard(id: string): Promise<void> {
  await trpc.boardsDelete.mutate({ id, actor: actor() })
  await store.reload()
}

/**
 * Replace a board's WHOLE node list - the autosave path. Idempotent and last-write-wins per board:
 * no version precondition, no 409. Two people dragging one board lose one arrangement, attributed
 * by `updated_by` (the repo's standing posture, matching DocSave).
 */
export async function saveBoardNodes(id: string, nodes: BoardPlacement[]): Promise<void> {
  await trpc.boardsNodesSet.mutate({ id, nodes: JSON.stringify(nodes), actor: actor() })
  await store.reload()
}
