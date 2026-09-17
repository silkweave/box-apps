import { registerStoreReloads } from '../../../lib/changeFeed.ts'
import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'
import type {
  Initiative,
  InitiativeKind,
  PlanningStatus,
  Priority,
  Task,
  ValueLevel,
} from '../planning-types.ts'

/** The active user as the mutation's `actor` audit stamp (created_by/updated_by server-side). */
const actor = (): string | undefined => getActiveUserId() ?? undefined

// One shared store (see dataStore.ts) so every initiatives route shares ONE fetch and re-renders
// on mutation (mirrors useSignalsData, plus optimistic task-status writes like the inbox).
function fromWire(d: unknown): Initiative[] {
  return ((d as { initiatives?: unknown[] }).initiatives ?? []) as Initiative[]
}

const store = createDataStore<Initiative[]>(() => trpc.planningInitiatives.query({}).then(fromWire))
registerStoreReloads(['table:initiatives', 'table:tasks', 'docs:initiatives'], store)

/** Force a refetch (after a mutation made elsewhere). */
export const reloadPlanning = (): Promise<Initiative[]> => store.reload()

/** Optimistically set a task's status, then reconcile with the server. */
export async function setTaskStatus(id: string, status: PlanningStatus): Promise<void> {
  store.set((cur) =>
    cur.map((i) => ({
      ...i,
      tasks: i.tasks.map((t) => (t.id === id ? { ...t, status } : t)),
    })),
  )
  try {
    await trpc.planningTaskSetStatus.mutate({ id, status, actor: actor() })
  } finally {
    await store.reload()
  }
}

/** Fields editable from the dashboard (subset of the server's task-upsert input). */
export interface TaskUpsert {
  id: string
  initiative_id?: string
  title?: string
  status?: PlanningStatus
  rank?: number
  score?: number
  /** 1-3 stars; 0 clears it (the numeric twin of the '' convention). */
  priority?: number
  /** Whole hours 1-8; 0 clears it (the numeric twin of the '' convention). */
  estimate_hours?: number
  tags?: string[]
  url?: string
  assignee?: string
  metadata?: string
  /** Deadline YYYY-MM-DD; '' clears it (the server's clear-with-empty-string convention). */
  due_date?: string
  /** Sprint to scope this task into; '' takes it out (which also unslots it). */
  sprint_id?: string
  /** Day inside that sprint, YYYY-MM-DD; '' unslots while keeping it in scope. An EXPLICIT slot with
   *  no sprint is refused by the server - see features/planning/SPEC.md. */
  slot_date?: string
}

/**
 * Create or update a task (partial) - OPTIMISTICALLY. The patch lands in the store before the
 * request goes out, and the reload afterwards reconciles whatever the server actually did.
 *
 * Why: every one of these is a single deliberate edit (pick an owner, click a star, choose a size)
 * and the round trip to the server plus a full re-fetch of the board is long enough to see. A control
 * that shows the old value for a beat after you changed it reads as "did that work?", and the whole
 * point of an inline grid is that it does not.
 */
export async function upsertTask(input: TaskUpsert): Promise<void> {
  const patch = taskPatch(input)
  if (patch) store.set((cur) => cur.map((i) => ({ ...i, tasks: i.tasks.map((t) => (t.id === input.id ? { ...t, ...patch } : t)) })))
  try {
    await trpc.planningTaskUpsert.mutate({ ...input, actor: actor() })
  } finally {
    await store.reload()
  }
}

/**
 * The local shape of a task upsert - the fields whose effect we can predict exactly. Anything not
 * listed (a move to another initiative, which re-keys the row; metadata, which the server parses)
 * is left to the reload rather than guessed at. `null` when the input touches nothing predictable,
 * so a plain create still just waits for the server.
 */
function taskPatch(input: TaskUpsert): Partial<Task> | null {
  const p: Partial<Task> = {}
  if (input.title !== undefined) p.title = input.title
  if (input.status !== undefined) p.status = input.status
  if (input.rank !== undefined) p.rank = input.rank
  if (input.score !== undefined) p.score = input.score
  if (input.priority !== undefined) p.priority = priorityOf(input.priority)
  if (input.estimate_hours !== undefined) p.estimate_hours = input.estimate_hours || null
  if (input.tags !== undefined) p.tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort()
  if (input.url !== undefined) p.url = input.url || null
  if (input.assignee !== undefined) p.assignee = input.assignee || null
  if (input.due_date !== undefined) p.due_date = input.due_date || null
  if (input.sprint_id !== undefined) p.sprint_id = input.sprint_id || null
  // Leaving a sprint drops a carried slot server-side, so mirror that here rather than showing a
  // task still sitting on a day it is no longer in scope for.
  if (input.slot_date !== undefined) p.slot_date = input.slot_date || null
  else if (input.sprint_id === '') p.slot_date = null
  return Object.keys(p).length > 0 ? p : null
}

/** The server's rule, mirrored: 1-3 is a rating, anything else clears it. */
const priorityOf = (v: number): Priority | null => (v === 1 || v === 2 || v === 3 ? v : null)

/** Delete a task, then reload. */
export async function deleteTask(id: string): Promise<void> {
  await trpc.planningTaskDelete.mutate({ id })
  await store.reload()
}

/**
 * Move a task to another initiative (the server re-keys its id + moves its doc). Optimistically pops it
 * out of the source and splices it into the destination at `rank`, then reconciles with the server.
 */
export async function moveTask(id: string, toInitiativeId: string, rank?: number): Promise<void> {
  store.set((cur) => {
    let moved: Task | undefined
    const without = cur.map((i) => {
      const found = i.tasks.find((t) => t.id === id)
      if (found) moved = found
      return found ? { ...i, tasks: i.tasks.filter((t) => t.id !== id) } : i
    })
    if (!moved) return cur
    const m: Task = { ...moved, initiative_id: toInitiativeId }
    return without.map((i) => {
      if (i.id !== toInitiativeId) return i
      const tasks = [...i.tasks]
      tasks.splice(rank ?? tasks.length, 0, m)
      return { ...i, tasks }
    })
  })
  try {
    await trpc.planningTaskMove.mutate({ id, to_initiative_id: toInitiativeId, rank })
  } finally {
    await store.reload()
  }
}

/** Optimistically reorder one initiative's tasks to the given id order, then persist + reconcile. */
export async function reorderTasks(initiativeId: string, ids: string[]): Promise<void> {
  store.set((cur) =>
    cur.map((i) => {
      if (i.id !== initiativeId) return i
      const byId = new Map(i.tasks.map((t) => [t.id, t]))
      return { ...i, tasks: ids.map((id) => byId.get(id)).filter((t): t is Task => !!t) }
    }),
  )
  try {
    await trpc.planningTasksReorder.mutate({ ids })
  } finally {
    await store.reload()
  }
}

/** Rename a task's slug (task-part only; stays in its initiative), then reload (id changed). */
export async function renameTask(id: string, newSlug: string): Promise<void> {
  await trpc.planningTaskRename.mutate({ id, new_slug: newSlug })
  await store.reload()
}

/** Rename an initiative's slug - cascades to its tasks + moves docs server-side - then reload. */
export async function renameInitiative(id: string, newId: string): Promise<void> {
  await trpc.planningInitiativeRename.mutate({ id, new_id: newId })
  await store.reload()
}

/**
 * Optimistically reorder the initiatives to the given id order, then persist + reconcile.
 *
 * No caller in the dashboard since 2026-08-13: the board dropped its sort axis and its drag-to-
 * reorder with it, and an initiative's rank is now set on the initiative itself (the dialog's Sort
 * field) or over MCP. Kept because the tRPC route and the `initiatives-reorder` tool behind it are
 * still live, and this is the only client-side spelling of them.
 */
export async function reorderInitiatives(ids: string[]): Promise<void> {
  store.set((cur) => {
    const byId = new Map(cur.map((i) => [i.id, i]))
    return ids.map((id) => byId.get(id)).filter((i): i is Initiative => !!i)
  })
  try {
    await trpc.planningInitiativesReorder.mutate({ ids })
  } finally {
    await store.reload()
  }
}

/** Fields editable from the dashboard (subset of the server's initiative-upsert input; target is flat). */
export interface InitiativeUpsert {
  id: string
  title?: string
  status?: PlanningStatus
  kind?: InitiativeKind
  owner?: string
  signal_ids?: string[]
  target_signal_id?: string
  target_value?: number
  target_by_date?: string
  target_baseline?: number
  /** '' clears it (the server's flattened-enum convention). */
  value_customer?: ValueLevel | ''
  value_company?: ValueLevel | ''
  /** 1-3 stars; 0 clears it. */
  priority?: number
  blocked_by?: string[]
  tags?: string[]
  doc_path?: string
  /** Deadline YYYY-MM-DD; '' clears it (the server's clear-with-empty-string convention). */
  due_date?: string
  sort?: number
}

/**
 * Optimistically move an initiative's status (the board's drag), then reconcile. Status is
 * Box-owned, so moving a card IS an ordinary human edit - no new tool, no new permission.
 *
 * It carries no policy of its own: the Done gate (an initiative cannot be done while a task is
 * still open) belongs to the CALLER, exactly as it does for the list's status select. The board
 * refuses the drop and shows DoneGateDialog rather than writing and apologising.
 */
export async function setInitiativeStatus(id: string, status: PlanningStatus): Promise<void> {
  store.set((cur) => cur.map((i) => (i.id === id ? { ...i, status } : i)))
  try {
    await trpc.planningInitiativeUpsert.mutate({ id, status, actor: actor() })
  } finally {
    await store.reload()
  }
}

/** Create or update an initiative (partial), optimistically - see the note on `upsertTask`. */
export async function upsertInitiative(input: InitiativeUpsert): Promise<void> {
  const patch = initiativePatch(input)
  if (patch) store.set((cur) => cur.map((i) => (i.id === input.id ? { ...i, ...patch } : i)))
  try {
    await trpc.planningInitiativeUpsert.mutate({ ...input, actor: actor() })
  } finally {
    await store.reload()
  }
}

/**
 * The predictable half of an initiative upsert. `target_*` is deliberately absent: it is a flattened
 * four-field shape the server reassembles, and `blocked_by` can be REFUSED (cycles, unknown ids), so
 * showing either as done before the server agrees would be showing a lie.
 */
function initiativePatch(input: InitiativeUpsert): Partial<Initiative> | null {
  const p: Partial<Initiative> = {}
  if (input.title !== undefined) p.title = input.title
  if (input.status !== undefined) p.status = input.status
  if (input.kind !== undefined) p.kind = input.kind
  if (input.owner !== undefined) p.owner = input.owner || null
  if (input.signal_ids !== undefined) p.signal_ids = input.signal_ids
  if (input.value_customer !== undefined) p.value_customer = input.value_customer === '' ? null : input.value_customer
  if (input.value_company !== undefined) p.value_company = input.value_company === '' ? null : input.value_company
  if (input.priority !== undefined) p.priority = priorityOf(input.priority)
  if (input.tags !== undefined) p.tags = [...new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].sort()
  if (input.due_date !== undefined) p.due_date = input.due_date || null
  if (input.sort !== undefined) p.sort = input.sort
  return Object.keys(p).length > 0 ? p : null
}

/** Delete an initiative and its tasks, then reload. */
export async function deleteInitiative(id: string): Promise<void> {
  await trpc.planningInitiativeDelete.mutate({ id })
  await store.reload()
}

export function usePlanningData(): { data: Initiative[] | null; error: string | null } {
  return store.useData()
}
