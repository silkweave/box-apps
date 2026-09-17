// The sprint data layer. Two shapes, because the API has two: a LIST store (every sprint, no tasks,
// no capacity grid) shared by the sidebar and the index, and a per-sprint DETAIL fetch that carries
// the tasks, the inferred initiatives, and the computed `loads` / `check`.
//
// The detail is not a `createDataStore` because it is parameterised by id and only ever one sprint
// is open. It is a plain hook that refetches on the change feed (`table:sprints`, `table:tasks` -
// slotting a task changes the grid) plus an explicit `reloadSprint()` for the mutation paths, so an
// agent slotting work over MCP shows up in an open Planning board without a refresh.
//
// Every write here can be REFUSED by the server and the refusal is the point: `scheduled` without
// dates, `planned` while a day is over capacity (it names the worst three), a slot outside the
// window. So these throw rather than swallow, and the views render the message verbatim.

import { useEffect, useState } from 'react'
import { registerStoreReloads, subscribeChanges } from '../../../lib/changeFeed.ts'
import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'
import { upsertTask } from './usePlanningData.ts'
import type { Sprint, SprintAvailability, SprintDetail, SprintStatus } from '../sprint-types.ts'

/** The active user as the mutation's `actor` audit stamp (created_by/updated_by server-side). */
const actor = (): string | undefined => getActiveUserId() ?? undefined

function fromWire(d: unknown): Sprint[] {
  return ((d as { sprints?: unknown[] }).sprints ?? []) as Sprint[]
}

const store = createDataStore<Sprint[]>(() => trpc.planningSprints.query({}).then(fromWire))
registerStoreReloads(['table:sprints'], store)

/** Force a refetch of the sprint LIST. */
export const reloadSprints = (): Promise<Sprint[]> => store.reload()

export function useSprintsData(): { data: Sprint[] | null; error: string | null } {
  return store.useData()
}

// --- the open sprint ------------------------------------------------------------------------------

const detailListeners = new Set<() => void>()

/** Refetch whatever sprint detail is currently mounted (after a mutation made from a view). */
export function reloadSprint(): void {
  detailListeners.forEach((l) => l())
}

/**
 * One sprint with its tasks and its computed capacity grid. `detail` is null while the first fetch
 * is in flight and stays null for an id the server does not know (with `error` set) - a sprint
 * deleted in another tab must not render as a half-empty board.
 */
export function useSprintDetail(id: string | undefined): { detail: SprintDetail | null; error: string | null } {
  const [detail, setDetail] = useState<SprintDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) {
      setDetail(null)
      return
    }
    let alive = true
    // Not cleared on refetch: a live board must not blink back to "Loading…" every time the change
    // feed fires. The stale grid stands until the new one lands.
    const fetchOne = (): void => {
      void trpc.planningSprintGet
        .mutate({ id })
        .then((d) => {
          if (!alive) return
          setDetail(d as unknown as SprintDetail)
          setError(null)
        })
        .catch((e: unknown) => {
          if (!alive) return
          setDetail(null)
          setError(e instanceof Error ? e.message : String(e))
        })
    }
    fetchOne()
    detailListeners.add(fetchOne)
    const unsubscribe = subscribeChanges(['table:sprints', 'table:tasks'], fetchOne)
    return () => {
      alive = false
      detailListeners.delete(fetchOne)
      unsubscribe()
    }
  }, [id])

  return { detail, error }
}

// --- mutations ------------------------------------------------------------------------------------

/** Fields editable from the dashboard (subset of the server's sprint-upsert input). */
export interface SprintUpsert {
  id: string
  title?: string
  goal?: string
  status?: SprintStatus
  /** `YYYY-MM-DD`; '' clears it (the server's clear-with-empty-string convention). */
  start_date?: string
  end_date?: string
  /** REPLACES the whole map - the keys are the sprint's roster. */
  availability?: Record<string, SprintAvailability>
}

/**
 * Create or update a sprint. NOT optimistic, unlike the task/initiative writes: half of these can be
 * refused (dates, the capacity gate), and showing a status move as done before the server agrees
 * would be showing a lie. The returned detail is the server's, already re-checked.
 */
export async function upsertSprint(input: SprintUpsert): Promise<SprintDetail> {
  const { availability, ...rest } = input
  const detail = (await trpc.planningSprintUpsert.mutate({
    ...rest,
    actor: actor(),
    ...(availability ? { availability: JSON.stringify(availability) } : {}),
  })) as unknown as SprintDetail
  await store.reload()
  reloadSprint()
  return detail
}

/** Delete a sprint. Its tasks are RELEASED, never deleted - the window goes, the work stays. */
export async function deleteSprint(id: string): Promise<void> {
  await trpc.planningSprintDelete.mutate({ id })
  await store.reload()
}

/**
 * Scope a task into a sprint and/or put it on a day. There is no "add to sprint" procedure - this is
 * an ordinary task upsert, and it goes through `upsertTask` so the initiatives store patches
 * optimistically and the board behind you stays in step.
 *
 * `sprintId: null` takes the task out of the sprint (which also unslots it); `slotDate: null` unslots
 * while keeping it in scope. Assignee travels with the slot because a grid cell IS a person-day -
 * dropping a task there without owning it would leave the capacity check counting nobody's hours,
 * and `dueDate` travels with it too when the caller asks: putting work on Tuesday is a promise about
 * Tuesday, so the grid drops the day into the deadline rather than leaving the two to disagree.
 */
export async function slotTask(
  id: string,
  {
    sprintId,
    slotDate,
    assignee,
    dueDate,
  }: { sprintId?: string | null; slotDate?: string | null; assignee?: string | null; dueDate?: string | null },
): Promise<void> {
  await upsertTask({
    id,
    ...(sprintId !== undefined ? { sprint_id: sprintId ?? '' } : {}),
    ...(slotDate !== undefined ? { slot_date: slotDate ?? '' } : {}),
    ...(assignee !== undefined ? { assignee: assignee ?? '' } : {}),
    ...(dueDate !== undefined ? { due_date: dueDate ?? '' } : {}),
  })
  reloadSprint()
}

/**
 * Make a task straight onto one person-day - a SPRINT task, under no initiative. The server derives
 * the id (`<sprint>/<slug>`) and refuses anything outside the window, so this throws rather than
 * swallows, like every other sprint write here.
 */
export async function createSprintTask(input: {
  sprintId: string
  title: string
  assignee: string
  date: string
  estimateHours: number | null
}): Promise<void> {
  await trpc.planningSprintTaskCreate.mutate({
    sprint_id: input.sprintId,
    title: input.title,
    assignee: input.assignee,
    slot_date: input.date,
    ...(input.estimateHours ? { estimate_hours: input.estimateHours } : {}),
    actor: actor(),
  })
  reloadSprint()
}

/**
 * Tick one bucket of today's stand-up on or off. The KEY travels rather than the whole set, so two
 * people running the Board at once cannot clobber each other's ticks (see core's `tickCheckin`).
 *
 * Not optimistic: a tick is a shared fact and the round trip is one call - showing it as ticked
 * before the team's copy agrees is the one thing a shared ritual must not do.
 */
export async function tickCheckin(input: {
  id: string
  date: string
  user: string
  bucket: 'done' | 'today' | 'slipping'
  done: boolean
}): Promise<void> {
  await trpc.planningSprintCheckinTick.mutate({ ...input, actor: actor() })
  reloadSprint()
}

/** Close today's stand-up out. Idempotent; the first stamp stands. */
export async function completeCheckin(id: string, date: string): Promise<void> {
  await trpc.planningSprintCheckinComplete.mutate({ id, date, actor: actor() })
  reloadSprint()
}
