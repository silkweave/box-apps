// Read/write the planning tables (initiatives + tasks) and derive the OSS-PR outcome signal from
// the task ledger. Row↔domain plumbing (column lists, JSON/timestamp handling, partial upsert,
// audit stamps, enum validation) comes from the record layer (warehouse/model.ts) driven by the
// INITIATIVES/TASKS specs in warehouse/models.ts; this module keeps only the domain semantics:
// create-defaults, done_at management, slug-path re-keys, and the signal re-derive.

import { emitChange } from '../../changes.js'
import { ensureSchema, withRead, withWrite } from '../../warehouse/db.js'
import { replaceSignalRows, type SignalRow } from '../data/signals/write.js'
import { deleteRecord, modelColumns, readRecord, readRecords, upsertRecord } from '../../warehouse/model.js'
import { INITIATIVES, SPRINTS, SPRINT_CHECKINS, TASKS } from './models.js'
import { autoRegisterDefinitions } from '../data/signals/definitions.js'
import type { SignalHooks } from '../data/signals/hooks.js'
import {
  docSummary,
  movePlanningDoc,
  planningDocPath,
  removeEmptyInitiativeDir,
  writePlanningDoc,
  type DocKind,
  type PlanningDoc,
} from './docs.js'
import {
  DEFAULT_INITIATIVE_KIND,
  initiativeKinds,
  removeInitiativeKind,
  type InitiativeKindRecord,
} from './kinds.js'
import { assertTitleLength, normalizeEstimateHours, normalizePriority } from './types.js'
import type {
  Initiative,
  InitiativeInput,
  InitiativeWithTasks,
  PlanningStatus,
  Sprint,
  SprintInput,
  SprintStatus,
  Task,
  TaskInput,
} from './types.js'
import {
  burndown,
  checkSprint,
  formatHours,
  sprintCapacity,
  type BurndownPoint,
  type DayLoad,
  type SprintAvailabilityMap,
  type SprintCheck,
} from './sprints.js'
import { assertKnownUser } from '../../users/state.js'

// --- due dates ------------------------------------------------------------------------------------

/** A due date is a naive calendar date; the column is a DuckDB DATE, so a full ISO timestamp must
 *  never reach the cast. Same YYYY-MM-DD convention as `target.by_date` and the snapshot buckets. */
const DUE_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Validate a proposed due date. `undefined` keeps the stored value; `null`/`''` clears it. */
function normalizeCalendarDate(raw: string | null | undefined, field: string): string | null | undefined {
  if (raw === undefined) return undefined
  const v = raw === null ? '' : raw.trim()
  if (v === '') return null
  if (!DUE_DATE.test(v)) throw new Error(`invalid ${field} "${raw}" (expected YYYY-MM-DD)`)
  return v
}

function normalizeDueDate(raw: string | null | undefined): string | null | undefined {
  return normalizeCalendarDate(raw, 'due_date')
}

// --- reads ---------------------------------------------------------------------------------------

// The JSON list columns arrived by ALTER (migration 005), which cannot be NOT NULL on a populated
// table - so a row written before the record layer ever touched it can still read back null. Every
// read funnels through these so callers are handed an array, always.
const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])
const normInitiative = <T extends Initiative>(i: T): T => ({ ...i, blocked_by: list(i.blocked_by), tags: list(i.tags) })
const normTask = (t: Task): Task => ({ ...t, tags: list(t.tags) })

/** Every initiative, each with its tasks nested. Sorted by `sort` then created. */
export async function readInitiatives(): Promise<InitiativeWithTasks[]> {
  const inits = await readRecords<Initiative>(INITIATIVES, { orderBy: 'sort, created_at' })
  const tasks = await readRecords<Task>(TASKS, { orderBy: 'rank, created_at' })
  const tasksByInit = new Map<string, Task[]>()
  for (const t of tasks) {
    // A sprint task has no initiative to nest under - it is read through its sprint (`readSprint`).
    if (!t.initiative_id) continue
    const forInit = tasksByInit.get(t.initiative_id) ?? []
    forInit.push(normTask(t))
    tasksByInit.set(t.initiative_id, forInit)
  }
  return inits.map((i) => normInitiative({ ...i, tasks: tasksByInit.get(i.id) ?? [] }))
}

/** One initiative with its tasks, or null. */
export async function readInitiative(id: string): Promise<InitiativeWithTasks | null> {
  const init = await readRecord<Initiative>(INITIATIVES, { id })
  if (!init) return null
  const tasks = await readRecords<Task>(TASKS, {
    where: 'initiative_id = ?',
    params: [id],
    orderBy: 'rank, created_at',
  })
  return normInitiative({ ...init, tasks: tasks.map(normTask) })
}

// --- the dependency graph ------------------------------------------------------------------------

/** Every initiative's `blocked_by` edge list, as stored. */
async function readEdges(): Promise<Map<string, string[]>> {
  await ensureSchema()
  const rows = await withRead<{ id: string; blocked_by: string | null }>(
    `SELECT id, CAST(blocked_by AS VARCHAR) AS blocked_by FROM initiatives`,
  )
  return new Map(
    rows.map((r) => {
      try {
        const parsed: unknown = r.blocked_by ? JSON.parse(r.blocked_by) : []
        return [r.id, Array.isArray(parsed) ? (parsed as string[]) : []]
      } catch {
        return [r.id, []]
      }
    }),
  )
}

/** Persist one row's edge list (used by the rename/delete fixups, which bypass the upsert path). */
async function writeEdges(id: string, deps: string[]): Promise<void> {
  await withWrite(async (conn) => {
    await conn.run(`UPDATE initiatives SET blocked_by = ?::JSON, updated_at = now() WHERE id = ?`, [
      JSON.stringify(deps),
      id,
    ])
  })
}

/**
 * Clean a proposed `blocked_by` list: trimmed, de-duplicated, self-reference dropped, every target
 * must exist, and the resulting graph must stay acyclic. A cycle is worth refusing rather than
 * tolerating - the critical-path view walks these edges, and "A waits on B waits on A" is never a
 * true statement about work, it is a data-entry mistake.
 */
async function normalizeBlockedBy(id: string, raw: string[]): Promise<string[]> {
  const deps = [...new Set(raw.map((s) => s.trim()).filter(Boolean))].filter((d) => d !== id)
  if (deps.length === 0) return deps
  const edges = await readEdges()
  const unknown = deps.filter((d) => !edges.has(d))
  if (unknown.length > 0) throw new Error(`initiative ${id}: blocked_by references unknown initiative(s) ${unknown.join(', ')}`)

  // Walk forward from the proposed dependencies with this row's edges substituted in. Reaching `id`
  // again means the edge closes a loop.
  edges.set(id, deps)
  const seen = new Set<string>()
  const stack = [...deps]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (cur === id) throw new Error(`initiative ${id}: blocked_by would create a dependency cycle`)
    if (seen.has(cur)) continue
    seen.add(cur)
    stack.push(...(edges.get(cur) ?? []))
  }
  return deps
}

// --- writes --------------------------------------------------------------------------------------

/**
 * Create or update an initiative. Partial: provided fields overwrite; the rest keep their stored
 * value (or a default on first insert). `created_at` is preserved on update.
 */
export async function upsertInitiative(input: InitiativeInput): Promise<InitiativeWithTasks> {
  const prev = await readRecord<Initiative>(INITIATIVES, { id: input.id })
  assertTitleLength('initiative', input.id, input.title, prev?.title)
  const dueDate = normalizeDueDate(input.due_date)
  const blockedBy =
    input.blocked_by !== undefined
      ? await normalizeBlockedBy(input.id, input.blocked_by)
      : list(prev?.blocked_by)
  await upsertRecord<Initiative>(
    INITIATIVES,
    {
      id: input.id,
      title: input.title ?? prev?.title ?? input.id,
      // Derived from the doc (savePlanningDoc), never from this input - it only carries forward here.
      summary: prev?.summary ?? '',
      status: input.status ?? prev?.status ?? 'planned',
      kind: input.kind ?? prev?.kind ?? DEFAULT_INITIATIVE_KIND,
      owner: input.owner !== undefined ? input.owner : (prev?.owner ?? null),
      signal_ids: input.signal_ids ?? prev?.signal_ids ?? [],
      target: input.target !== undefined ? input.target : (prev?.target ?? null),
      value_customer: input.value_customer !== undefined ? input.value_customer : (prev?.value_customer ?? null),
      value_company: input.value_company !== undefined ? input.value_company : (prev?.value_company ?? null),
      priority: input.priority !== undefined ? normalizePriority(input.priority) : (prev?.priority ?? null),
      blocked_by: blockedBy,
      tags: normalizeTags(input.tags ?? prev?.tags),
      doc_path: input.doc_path !== undefined ? input.doc_path : (prev?.doc_path ?? null),
      due_date: dueDate !== undefined ? dueDate : (prev?.due_date ?? null),
      sort: input.sort ?? prev?.sort ?? 0,
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev },
  )
  return (await readInitiative(input.id))!
}

/** Tags are a filter axis, so they get one canonical form: trimmed, lowercased, de-duplicated. */
function normalizeTags(raw: string[] | null | undefined): string[] {
  return [...new Set(list(raw).map((t) => t.trim().toLowerCase()).filter(Boolean))].sort()
}

/** Delete an initiative and all its tasks; prune dangling edges; re-derive the outcome signal. */
export async function deleteInitiative(id: string): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    await conn.run(`DELETE FROM tasks WHERE initiative_id = ?`, [id])
    await conn.run(`DELETE FROM initiatives WHERE id = ?`, [id])
  })
  // Anything that was waiting on this initiative is no longer waiting on anything named that -
  // leaving the id behind would break the critical-path walk and the "unknown blocked_by" guard.
  for (const [other, deps] of await readEdges()) {
    if (deps.includes(id)) await writeEdges(other, deps.filter((d) => d !== id))
  }
  await deriveOssPrSignals()
}

/**
 * Create or update a task. Partial, like upsertInitiative. `done_at` is managed automatically:
 * set to now() when status flips to 'done' (and not already set), cleared when it leaves 'done'.
 * Re-derives the outcome signal so the chart tracks the ledger.
 */
/**
 * The rank a brand-new task takes: one past the last row already in the initiative, so a create
 * APPENDS. The old default was a flat `0`, which put every new task at the head of the list and
 * left ties to be broken arbitrarily by whatever the query returned - 14 rows in one initiative all
 * sat at rank 0, which is what "the AI adds sub-tasks in random order" actually was. Only ever used
 * on create; an explicit rank and an existing row's rank both still win.
 */
async function nextRank(initiativeId: string): Promise<number> {
  const rows = await withRead<{ next: number }>(
    `SELECT COALESCE(MAX(rank), -1) + 1 AS next FROM tasks WHERE initiative_id = ?`,
    [initiativeId],
  )
  return rows[0]?.next ?? 0
}

export async function upsertTask(input: TaskInput): Promise<Task> {
  const prev = await readRecord<Task>(TASKS, { id: input.id })
  // A sprint task (no initiative) is born only by `createSprintTask`; here it can only be edited.
  if (prev && !prev.initiative_id) return upsertSprintTask(prev, input)
  assertTitleLength('task', input.id, input.title, prev?.title)
  const status: PlanningStatus = input.status ?? prev?.status ?? 'planned'
  const dueDate = normalizeDueDate(input.due_date)
  // Task ids are slug paths `<initiative>/<task>`, so the parent initiative is derivable from the id
  // when not given explicitly (also dodges the cli proxy's snake_case-flag limitation).
  const derivedInitiative = input.id.includes('/') ? input.id.slice(0, input.id.indexOf('/')) : undefined
  const initiativeId = input.initiative_id ?? prev?.initiative_id ?? derivedInitiative
  if (!initiativeId) throw new Error(`task ${input.id}: initiative_id is required on create`)
  // The slug path is a CONVENTION the rest of the system treats as a guarantee: the dashboard's task
  // route is `/initiatives/<id>/<taskSlug>` and rebuilds the id by joining its two params, and
  // planningDocPath lays the doc out as `<initiative>/<task>.md`. Passing `initiative_id` explicitly
  // used to let any id through - which is how 28 September-planning tasks landed with bare ids like
  // `sep-agent-loop-staging`, each one unopenable in the UI because it has no address under that
  // route. Enforced on CREATE only: rows that predate the guard must stay updatable (a status flip
  // should not fail because of an id nobody can change from here), and re-keying them is moveTask's
  // job, which writes rows directly and so never passes through this path.
  if (!prev && derivedInitiative !== initiativeId) {
    throw new Error(
      `task ${input.id}: id must be the slug path "${initiativeId}/<task>" (the UI route and the doc path are both derived from it)`,
    )
  }
  // done_at: when 'done', use an explicit timestamp (seeding history) → existing → now; else clear.
  const doneAt = status === 'done' ? (input.done_at ?? prev?.done_at ?? new Date().toISOString()) : null
  const sprintId = input.sprint_id !== undefined ? (input.sprint_id || null) : (prev?.sprint_id ?? null)
  // A day slot is a position INSIDE a sprint, so the two fields interact. The distinction that
  // matters is EXPLICIT vs CARRIED-FORWARD: asking for a slot with no sprint is a mistake and is
  // refused loudly, but a slot left over from a sprint the task is being removed from is not - it is
  // just what leaving means, so it is dropped silently. Getting this backwards made clearing
  // `sprint_id` on a slotted task fail with "slot_date needs a sprint_id", which is nonsense: the
  // caller never mentioned slot_date.
  const slotInput = normalizeCalendarDate(input.slot_date, 'slot_date')
  if (slotInput && !sprintId) {
    throw new Error(`task ${input.id}: slot_date needs a sprint_id (a day slot is a position inside a sprint)`)
  }
  const slotDate = sprintId === null ? null : slotInput !== undefined ? slotInput : (prev?.slot_date ?? null)
  // Re-validated even when carried forward, so MOVING a task to a different sprint cannot smuggle a
  // slot date that falls outside the new window.
  if (slotDate && sprintId) await assertSlotInSprint(sprintId, slotDate)

  const task = await upsertRecord<Task>(
    TASKS,
    {
      id: input.id,
      initiative_id: initiativeId,
      title: input.title ?? prev?.title ?? input.id,
      // Derived from the doc (savePlanningDoc), never from this input - it only carries forward here.
      summary: prev?.summary ?? '',
      status,
      rank: input.rank ?? prev?.rank ?? (await nextRank(initiativeId)),
      score: input.score !== undefined ? input.score : (prev?.score ?? null),
      priority: input.priority !== undefined ? normalizePriority(input.priority) : (prev?.priority ?? null),
      estimate_hours:
        input.estimate_hours !== undefined ? normalizeEstimateHours(input.estimate_hours) : (prev?.estimate_hours ?? null),
      tags: normalizeTags(input.tags ?? prev?.tags),
      url: input.url !== undefined ? input.url : (prev?.url ?? null),
      assignee: input.assignee !== undefined ? input.assignee : (prev?.assignee ?? null),
      metadata: input.metadata ?? prev?.metadata ?? {},
      due_date: dueDate !== undefined ? dueDate : (prev?.due_date ?? null),
      sprint_id: sprintId,
      slot_date: slotDate,
      done_at: doneAt,
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev },
  )
  await deriveOssPrSignals()
  return task
}

// --- sprint tasks ---------------------------------------------------------------------------------
//
// A task made straight onto a sprint's grid (2026-09-14). It belongs to the SPRINT and to no
// initiative: `initiative_id` is NULL, the id is `<sprint>/<task>` (so its doc lands at
// `docs/initiatives/<sprint>/<task>.md` through the same path rule as any task), and it is always on
// a person-day of that sprint. That last part is the whole contract, and it is enforced here rather
// than in the UI: a sprint task taken out of its sprint or off its day would be a row no surface
// draws - it is not under any initiative, so the backlog and the board would never show it again.
// The way out is to delete it (or, over MCP, `task-move` it into an initiative, which re-keys it into
// an ordinary task). Deleting the sprint deletes its sprint tasks for the same reason.

/** Title -> task slug. Mirrors the web app's slugify, so a sprint task's id reads like its title. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** Create a task that belongs to a sprint and no initiative, already on a person-day. */
export async function createSprintTask(input: {
  sprint_id: string
  title: string
  assignee: string
  slot_date: string
  estimate_hours?: number | null
  actor?: string
}): Promise<Task> {
  const title = input.title.trim()
  if (!title) throw new Error('a sprint task needs a title')
  const sprint = await readRecord<Sprint>(SPRINTS, { id: input.sprint_id })
  if (!sprint) throw new Error(`sprint ${input.sprint_id} not found`)
  const slotDate = normalizeCalendarDate(input.slot_date, 'slot_date')
  if (!slotDate) throw new Error('a sprint task needs a slot_date - it lives on a person-day')
  await assertSlotInSprint(sprint.id, slotDate)
  await assertKnownUser(input.assignee)
  const base = slugify(title)
  if (!base) throw new Error(`cannot derive a task slug from "${title}"`)
  // Two "Fix login" tasks in one sprint are two tasks, so a taken slug gets a suffix instead of
  // refusing the create - nobody can see the id from the grid, only the title.
  let slug = base
  for (let n = 2; await readRecord<Task>(TASKS, { id: `${sprint.id}/${slug}` }); n++) slug = `${base}-${n}`
  const id = `${sprint.id}/${slug}`
  assertTitleLength('task', id, title, undefined)
  const rank = await withRead<{ next: number }>(
    `SELECT COALESCE(MAX(rank), -1) + 1 AS next FROM tasks WHERE initiative_id IS NULL AND sprint_id = ?`,
    [sprint.id],
  )
  return upsertRecord<Task>(TASKS, {
    id,
    initiative_id: null,
    title,
    summary: '',
    status: 'planned',
    rank: rank[0]?.next ?? 0,
    score: null,
    priority: null,
    estimate_hours: normalizeEstimateHours(input.estimate_hours),
    tags: [],
    url: null,
    assignee: input.assignee,
    metadata: {},
    // The day is the deadline, as it is for every task dropped onto the grid (`SprintDnd`).
    due_date: slotDate,
    sprint_id: sprint.id,
    slot_date: slotDate,
    done_at: null,
    ...(input.actor ? { actor: input.actor } : {}),
  })
}

/**
 * Edit an existing sprint task. Every field an ordinary task can change, it can - except the three
 * that would take it out of the only place it is drawn: its sprint, its day, and its owner (a slot
 * without an assignee lands in no person's column). Refused loudly, naming the way out.
 */
async function upsertSprintTask(prev: Task, input: TaskInput): Promise<Task> {
  const refuse = (what: string): never => {
    throw new Error(
      `task ${prev.id} only exists inside sprint ${prev.sprint_id} - it cannot ${what}. Delete it instead, or move it into an initiative first`,
    )
  }
  if (input.initiative_id) refuse('take an initiative through an upsert (use task-move)')
  if (input.sprint_id !== undefined && (input.sprint_id || null) !== prev.sprint_id) refuse('leave its sprint')
  if (input.slot_date !== undefined && !input.slot_date) refuse('come off its day')
  if (input.assignee !== undefined && !input.assignee) refuse('lose its owner')
  assertTitleLength('task', input.id, input.title, prev.title)
  const status: PlanningStatus = input.status ?? prev.status
  const dueDate = normalizeDueDate(input.due_date)
  const slotDate = normalizeCalendarDate(input.slot_date, 'slot_date') ?? prev.slot_date
  if (slotDate && prev.sprint_id) await assertSlotInSprint(prev.sprint_id, slotDate)
  return upsertRecord<Task>(
    TASKS,
    {
      ...prev,
      title: input.title ?? prev.title,
      status,
      rank: input.rank ?? prev.rank,
      score: input.score !== undefined ? input.score : prev.score,
      priority: input.priority !== undefined ? normalizePriority(input.priority) : prev.priority,
      estimate_hours:
        input.estimate_hours !== undefined ? normalizeEstimateHours(input.estimate_hours) : prev.estimate_hours,
      tags: normalizeTags(input.tags ?? prev.tags),
      url: input.url !== undefined ? input.url : prev.url,
      assignee: input.assignee !== undefined ? input.assignee : prev.assignee,
      metadata: input.metadata ?? prev.metadata ?? {},
      due_date: dueDate !== undefined ? dueDate : prev.due_date,
      slot_date: slotDate,
      done_at: status === 'done' ? (input.done_at ?? prev.done_at ?? new Date().toISOString()) : null,
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev },
  )
}

/** Convenience: set just a task's status (the common quick action). */
export async function setTaskStatus(id: string, status: PlanningStatus): Promise<Task> {
  return upsertTask({ id, status })
}

/** One slug path segment: lowercase, digits, dashes; must start alphanumeric (mirrors docs.ts). */
const SLUG_SEG = /^[a-z0-9][a-z0-9-]*$/

/**
 * Re-key a task row to a new id (new initiative and/or new task slug), preserving created_at/done_at and
 * every other field, then move its on-disk doc and re-derive the outcome signal. Shared by moveTask
 * (changes the initiative prefix) and renameTask (changes the task slug). Refuses an id collision.
 */
async function rekeyTask(oldId: string, newId: string, newInitiativeId: string | null, newRank: number): Promise<Task> {
  const collision = await readRecord<Task>(TASKS, { id: newId })
  if (collision) throw new Error(`cannot re-key task to ${newId}: a task with that id already exists`)
  // The column list is DERIVED from the model spec, not hand-written. It used to be spelled out
  // twice (once in the INSERT, once in the SELECT), which made every new planning column a silent
  // data-loss bug waiting for the next task MOVE or RENAME to null it - a trap documented in
  // BACKLOG § Planning dimensions because it had already bitten. Only four values differ from the
  // source row; everything else, present and future, copies itself.
  const overrides: Record<string, string> = {
    id: '?',
    initiative_id: '?',
    rank: '?',
    updated_at: 'now()',
  }
  const names = Object.keys(modelColumns(TASKS))
  const selected = names.map((n) => overrides[n] ?? n)
  await withWrite(async (conn) => {
    // INSERT … SELECT copies the row (incl. the native JSON metadata) under the new key, keeping
    // created_at + done_at; then drop the old key.
    await conn.run(
      `INSERT INTO tasks (${names.join(', ')})
       SELECT ${selected.join(', ')} FROM tasks WHERE id = ?`,
      [newId, newInitiativeId, newRank, oldId],
    )
    await conn.run(`DELETE FROM tasks WHERE id = ?`, [oldId])
  })
  movePlanningDoc('task', oldId, newId)
  await deriveOssPrSignals()
  return (await readRecord<Task>(TASKS, { id: newId }))!
}

/**
 * Move a task to a different initiative. Tasks are keyed by the slug-path `<initiative>/<task>`, so a
 * cross-initiative move **re-keys** the row (preserving created_at/done_at/all fields) and renames its
 * on-disk doc to keep the path convention intact. Within the same initiative it just updates the rank.
 * Re-derives the outcome signal (a moved `done` oss-pr task still counts under its new parent).
 */
export async function moveTask(id: string, toInitiativeId: string, rank?: number): Promise<Task> {
  const prev = await readRecord<Task>(TASKS, { id })
  if (!prev) throw new Error(`task ${id} not found`)
  const taskSlug = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
  const newId = `${toInitiativeId}/${taskSlug}`
  const newRank = rank ?? prev.rank
  if (newId === id) return upsertTask({ id, initiative_id: toInitiativeId, rank: newRank })
  return rekeyTask(id, newId, toInitiativeId, newRank)
}

/**
 * Rename a task's **slug** (the task-part of its id) within the same initiative. Re-keys the row + moves
 * its doc; does not change the parent (cross-initiative moves go through moveTask / drag-and-drop).
 */
export async function renameTask(id: string, newSlug: string): Promise<Task> {
  if (!SLUG_SEG.test(newSlug)) throw new Error(`invalid task slug "${newSlug}" (use a-z, 0-9, -)`)
  if (!id.includes('/')) throw new Error(`task id "${id}" must be "<initiative>/<task>"`)
  const init = id.slice(0, id.indexOf('/'))
  const newId = `${init}/${newSlug}`
  const existing = await readRecord<Task>(TASKS, { id })
  if (!existing) throw new Error(`task ${id} not found`)
  if (newId === id) return existing
  // The stored parent, not the id prefix: a sprint task's prefix is its SPRINT, and re-keying it
  // must not quietly adopt it into an "initiative" of that name.
  return rekeyTask(id, newId, existing.initiative_id, existing.rank)
}

/**
 * Rename an initiative's **slug** (its id). Because a task id is `<initiative>/<task>`, this cascades:
 * the initiative row + every task row is re-keyed, and the initiative doc + each task doc is moved to the
 * new path (the now-empty old folder is removed). The signal join is on `initiative_id` (re-pointed), so
 * the derived outcome signal is preserved.
 */
export async function renameInitiative(oldId: string, newId: string): Promise<InitiativeWithTasks> {
  await ensureSchema()
  if (!SLUG_SEG.test(newId)) throw new Error(`invalid initiative slug "${newId}" (use a-z, 0-9, -)`)
  if (newId === oldId) return (await readInitiative(oldId))!
  const current = await readInitiative(oldId)
  if (!current) throw new Error(`initiative ${oldId} not found`)
  const collision = await readRecord<Initiative>(INITIATIVES, { id: newId })
  if (collision) throw new Error(`cannot rename to ${newId}: an initiative with that id already exists`)

  const newDocPath = planningDocPath('initiative', newId)
  const taskParts = current.tasks.map((t) => t.id.slice(t.id.indexOf('/') + 1))

  await withWrite(async (conn) => {
    await conn.run(`UPDATE initiatives SET id = ?, doc_path = ?, updated_at = now() WHERE id = ?`, [newId, newDocPath, oldId])
    await conn.run(
      `UPDATE tasks SET initiative_id = ?, id = ? || '/' || split_part(id, '/', 2), updated_at = now()
        WHERE initiative_id = ?`,
      [newId, newId, oldId],
    )
  })

  // Re-point every dependency edge that named the old slug, so the graph survives the rename the
  // same way the signal join does.
  for (const [other, deps] of await readEdges()) {
    if (deps.includes(oldId)) {
      await writeEdges(other, [...new Set(deps.map((d) => (d === oldId ? newId : d)))])
    }
  }

  movePlanningDoc('initiative', oldId, newId)
  for (const part of taskParts) movePlanningDoc('task', `${oldId}/${part}`, `${newId}/${part}`)
  removeEmptyInitiativeDir(oldId)
  await deriveOssPrSignals()
  return (await readInitiative(newId))!
}

/** Assign sequential `sort` to initiatives in the given id order (drag reorder). */
export async function reorderInitiatives(ids: string[]): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    for (let i = 0; i < ids.length; i++) {
      await conn.run(`UPDATE initiatives SET sort = ?, updated_at = now() WHERE id = ?`, [i, ids[i]])
    }
  })
}

/** Assign sequential `rank` to tasks in the given id order (drag reorder within one initiative). */
export async function reorderTasks(ids: string[]): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    for (let i = 0; i < ids.length; i++) {
      await conn.run(`UPDATE tasks SET rank = ?, updated_at = now() WHERE id = ?`, [i, ids[i]])
    }
  })
}

/** Delete a task; re-derive the outcome signal. */
export async function deleteTask(id: string): Promise<void> {
  await deleteRecord(TASKS, { id })
  await deriveOssPrSignals()
}

// --- derived outcome signal ----------------------------------------------------------------------

/** The task-ledger outcome signal. Lives under the `github` channel (Open source group) since
 *  2026-07-09 - the standalone `oss` dashboard channel was folded into GitHub. */
export const SILKWEAVE_PRS_SIGNAL_ID = 'github.silkweave_prs_merged'

/**
 * Compute `github.silkweave_prs_merged` rows from the task ledger: the cumulative count of merged
 * (status 'done') tasks across `oss-pr` initiatives, dated by `done_at`. The signal is therefore
 * *never* fabricated - it is exactly the number of committed PRs that landed. Extends a flat line
 * to today so the chart reaches the current date. Exported so the github channel derive can fold
 * these rows into its channel-level replace (which would otherwise wipe them on every pull).
 */
export async function computeSilkweavePrRows(): Promise<SignalRow[]> {
  await ensureSchema()
  const rows = await withRead<{ date: string; n: number }>(
    `SELECT CAST(t.done_at AS DATE) AS date, count(*) AS n
       FROM tasks t JOIN initiatives i ON t.initiative_id = i.id
      WHERE i.kind = 'oss-pr' AND t.status = 'done' AND t.done_at IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
  )
  const today = (await withRead<{ d: string }>(`SELECT CAST(current_date AS VARCHAR) AS d`))[0].d
  const base = (date: string, value: number): SignalRow => ({
    channel: 'github',
    signal_id: SILKWEAVE_PRS_SIGNAL_ID,
    label: 'Silkweave PRs merged',
    signal_group: 'Open source',
    unit: null,
    date,
    value,
  })

  const out: SignalRow[] = []
  let cum = 0
  for (const r of rows) {
    cum += Number(r.n)
    out.push(base(String(r.date), cum))
  }
  if (out.length === 0) out.push(base(today, 0))
  else if (out[out.length - 1].date !== today) out.push(base(today, cum))
  return out
}

/** Re-derive the ledger signal in place (task mutations call this; pulls go through deriveSignals). */
export async function deriveOssPrSignals(): Promise<number> {
  const out = await computeSilkweavePrRows()
  await replaceSignalRows(SILKWEAVE_PRS_SIGNAL_ID, out)
  await autoRegisterDefinitions(out)
  return out.length
}

/**
 * Write an initiative/task doc AND refresh the row's cached `summary` from it.
 *
 * This is the only writer of `summary` since 2026-08-24. The dashboard used to carry a plain-text
 * summary box beside the markdown editor; two fields for one piece of prose meant whichever you
 * edited last was right and nothing said which that was. The doc won - it is the thing people
 * actually write in - and the column became a derived one-line preview for the board (see
 * `docSummary`). Nothing here CREATES a row: a doc can be written for an id before its row exists
 * (the ingest skills do), and inventing an untitled initiative from a file write would be worse
 * than a summary that catches up on the next upsert.
 */
export async function savePlanningDoc(kind: DocKind, id: string, content: string, actor?: string): Promise<PlanningDoc> {
  const doc = writePlanningDoc(kind, id, content)
  const summary = docSummary(content)
  if (kind === 'initiative') {
    const prev = await readRecord<Initiative>(INITIATIVES, { id })
    if (prev && prev.summary !== summary) {
      await upsertRecord<Initiative>(INITIATIVES, { ...prev, summary, ...(actor ? { actor } : {}) }, { prev })
    }
  } else {
    const prev = await readRecord<Task>(TASKS, { id })
    if (prev && prev.summary !== summary) {
      await upsertRecord<Task>(TASKS, { ...prev, summary, ...(actor ? { actor } : {}) }, { prev })
    }
  }
  return doc
}

// --- the kind list --------------------------------------------------------------------------------
// The list itself is config (planning/kinds.ts, fs-only). What lives HERE is the part that needs the
// warehouse: how many initiatives sit in each lane, and the guard that stops a lane being deleted
// out from under them. Nothing rewrites `initiatives.kind`, so a delete is only ever a no-op on the
// data - which is exactly why it has to be refused while rows still point at it.

export interface InitiativeKindUsage extends InitiativeKindRecord {
  /** Initiatives currently in this lane. */
  count: number
}

/** The team's kinds by label, each with how many initiatives use it. */
export async function readInitiativeKindUsage(): Promise<InitiativeKindUsage[]> {
  await ensureSchema()
  const rows = await withRead<{ kind: string; count: number }>(
    'SELECT kind, COUNT(*)::INT AS count FROM initiatives GROUP BY kind',
  )
  const counts = new Map(rows.map((r) => [r.kind, Number(r.count)]))
  const kinds = initiativeKinds()
  const known = new Set(kinds.map((k) => k.id))
  // Kinds on rows that are no longer in the list (deleted while empty, then used again by an older
  // client, or a hand-edited file) are appended rather than hidden - an orphan lane the board is
  // rendering is something Settings has to be able to show and clean up.
  const orphans: InitiativeKindUsage[] = [...counts.keys()]
    .filter((id) => id && !known.has(id))
    .map((id) => ({
      id,
      label: id,
      icon: null,
      updated_at: new Date(0).toISOString(),
      updated_by: null,
      count: counts.get(id) ?? 0,
    }))
  return [...kinds.map((k) => ({ ...k, count: counts.get(k.id) ?? 0 })), ...orphans].sort(
    (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  )
}

/**
 * Delete a kind, refusing while any initiative is in it. Moving those rows is the caller's decision
 * (the board's inline Kind cell is one edit each), never a silent rewrite from a settings screen.
 */
export async function deleteInitiativeKind(id: string): Promise<void> {
  const usage = await readInitiativeKindUsage()
  const found = usage.find((k) => k.id === id)
  if (found && found.count > 0) {
    throw new Error(
      `"${id}" is used by ${found.count} initiative${found.count === 1 ? '' : 's'} - move them to another kind first`,
    )
  }
  removeInitiativeKind(id)
}

// --- sprints ---------------------------------------------------------------------------------------

/** A sprint plus what it holds: its tasks, the initiatives INFERRED from them, and the capacity grid. */
export interface SprintDetail extends Sprint {
  tasks: Task[]
  /** Initiative ids touched by this sprint's tasks. Never assigned - always derived (spec § Sprints). */
  initiative_ids: string[]
  /** One entry per person per day in the range. Empty until the sprint has dates. */
  loads: DayLoad[]
  check: SprintCheck
  /** Hours remaining, day by day, against the line the plan implies. Empty until it has dates. */
  burndown: BurndownPoint[]
  /** TODAY's stand-up, if one has been started. Null on any day nobody has ticked anything. */
  checkin: SprintCheckin | null
}

/** One day's stand-up: which buckets have been walked, and whether the day was closed out. */
export interface SprintCheckin {
  sprint_id: string
  date: string
  /** `<users.id>:<bucket>` - the buckets a human has ticked off. */
  ticks: string[]
  completed_at: string | null
  completed_by: string | null
}

/** The three buckets a stand-up walks, per person. The Board renders them in this order. */
export const CHECKIN_BUCKETS = ['done', 'today', 'slipping'] as const
export type CheckinBucket = (typeof CHECKIN_BUCKETS)[number]

/** Every sprint, newest window first; undated ones (still `pending`) last. */
export async function readSprints(): Promise<Sprint[]> {
  await ensureSchema()
  const rows = await readRecords<Sprint>(SPRINTS)
  return rows.sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? '') || a.id.localeCompare(b.id))
}

/** Tasks scoped into a sprint, in board order. */
export async function readSprintTasks(sprintId: string): Promise<Task[]> {
  await ensureSchema()
  const rows = await readRecords<Task>(TASKS, { where: 'sprint_id = ?', params: [sprintId] })
  return rows.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
}

/** One sprint with its tasks, inferred initiatives and the capacity check over it. */
export async function readSprint(id: string): Promise<SprintDetail | null> {
  await ensureSchema()
  const sprint = await readRecord<Sprint>(SPRINTS, { id })
  if (!sprint) return null
  const tasks = await readSprintTasks(id)
  const dated = Boolean(sprint.start_date && sprint.end_date)
  const loads = dated
    ? sprintCapacity(sprint.start_date!, sprint.end_date!, tasks, sprint.availability ?? {})
    : []
  return {
    ...sprint,
    tasks,
    initiative_ids: [...new Set(tasks.flatMap((t) => (t.initiative_id ? [t.initiative_id] : [])))].sort(),
    loads,
    check: checkSprint(loads),
    burndown: dated ? burndown(sprint.start_date!, sprint.end_date!, tasks, sprint.availability ?? {}, todayUtc()) : [],
    checkin: await readCheckin(id, todayUtc()),
  }
}

// --- the daily check-in ----------------------------------------------------------------------------
//
// The stand-up is a shared ritual, so its state is shared: one row per sprint-day in the warehouse
// rather than a flag in somebody's browser. Two people running the Board side by side see the same
// ticks, and a completed day stays completed after a reload, on any machine.

/** Today, UTC, as `YYYY-MM-DD`. The whole planning layer dates by UTC day - see features/planning/SPEC.md. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/** One day's check-in, or null if nobody has ticked anything on it yet. */
export async function readCheckin(sprintId: string, date: string): Promise<SprintCheckin | null> {
  await ensureSchema()
  const row = await readRecord<SprintCheckin>(SPRINT_CHECKINS, { sprint_id: sprintId, date })
  if (!row) return null
  return { ...row, date: String(row.date).slice(0, 10), ticks: normalizeTicks(row.ticks) }
}

/**
 * Tick one bucket on or off. The KEY is what travels, never the whole array - two people ticking
 * different buckets in the same second would otherwise each write their own read of the set and one
 * of them would silently lose the other's tick.
 *
 * Ticking anything on a day that was already completed REOPENS it: a check-in somebody closed early
 * is a mistake to correct, not a state to be stuck in.
 */
export async function tickCheckin(input: {
  sprintId: string
  date: string
  user: string
  bucket: CheckinBucket
  done: boolean
  actor?: string
}): Promise<SprintCheckin> {
  await ensureSchema()
  if (!CHECKIN_BUCKETS.includes(input.bucket)) throw new Error(`unknown check-in bucket '${input.bucket}'`)
  await assertKnownUser(input.user)
  const prev = await readCheckin(input.sprintId, input.date)
  const key = `${input.user}:${input.bucket}`
  const ticks = new Set(prev?.ticks ?? [])
  if (input.done) ticks.add(key)
  else ticks.delete(key)
  const reopened = !input.done && Boolean(prev?.completed_at)
  await upsertRecord(
    SPRINT_CHECKINS,
    {
      sprint_id: input.sprintId,
      date: input.date,
      ticks: [...ticks].sort(),
      completed_at: reopened ? null : (prev?.completed_at ?? null),
      completed_by: reopened ? null : (prev?.completed_by ?? null),
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev: prev ?? undefined },
  )
  return (await readCheckin(input.sprintId, input.date))!
}

/**
 * Close the day out. Idempotent, and it does NOT check that every bucket is ticked: the UI decides
 * when to offer the button, and a team that wants to end a stand-up early is not doing anything the
 * data should refuse. Re-completing keeps the first stamp - when the day was closed is a fact.
 */
export async function completeCheckin(input: {
  sprintId: string
  date: string
  actor?: string
}): Promise<SprintCheckin> {
  await ensureSchema()
  const prev = await readCheckin(input.sprintId, input.date)
  await upsertRecord(
    SPRINT_CHECKINS,
    {
      sprint_id: input.sprintId,
      date: input.date,
      ticks: prev?.ticks ?? [],
      completed_at: prev?.completed_at ?? new Date().toISOString(),
      completed_by: prev?.completed_by ?? input.actor ?? null,
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev: prev ?? undefined },
  )
  return (await readCheckin(input.sprintId, input.date))!
}

/** A stored `ticks` is JSON and therefore whatever anyone put there. Strings only, deduped, sorted. */
function normalizeTicks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.filter((t): t is string => typeof t === 'string'))].sort()
}

/**
 * Create or update a sprint. Partial, like the rest of the planning layer.
 *
 * The status machine is NOT enforced here beyond what a write can prove. `scheduled` requires dates
 * (Sprint Design is what sets them) and `planned` requires the capacity check to pass, because both
 * are claims the data can contradict. Everything else - including which order a human moves through
 * pending/scheduled/planned - is left alone: a team that plans a sprint in one sitting should not
 * have to walk a state machine to record it.
 */
export async function upsertSprint(input: SprintInput): Promise<SprintDetail> {
  await ensureSchema()
  const prev = await readRecord<Sprint>(SPRINTS, { id: input.id })
  const start = normalizeCalendarDate(input.start_date, 'start_date')
  const end = normalizeCalendarDate(input.end_date, 'end_date')
  const startDate = start !== undefined ? start : (prev?.start_date ?? null)
  const endDate = end !== undefined ? end : (prev?.end_date ?? null)
  if (startDate && endDate && endDate < startDate) {
    throw new Error(`sprint ${input.id}: end_date ${endDate} precedes start_date ${startDate}`)
  }
  const status: SprintStatus = input.status ?? prev?.status ?? 'pending'
  if (status !== 'pending' && !(startDate && endDate)) {
    throw new Error(`sprint ${input.id}: cannot be '${status}' without a start_date and an end_date`)
  }
  const availability = normalizeAvailability(input.availability ?? prev?.availability)
  for (const user of Object.keys(availability)) await assertKnownUser(user)

  if (status === 'planned' && prev?.status !== 'planned') {
    // The one gate with teeth: a sprint claiming to be planned must not hold a day that is provably
    // over capacity. Under-filled days and unsized tasks do NOT block - see checkSprint for why.
    const tasks = await readSprintTasks(input.id)
    const check = checkSprint(sprintCapacity(startDate!, endDate!, tasks, availability))
    if (!check.ok) {
      const worst = check.over
        .slice(0, 3)
        .map((l) => `${l.user} on ${l.date} (${formatHours(l.planned)} against ${l.hours}h)`)
        .join(', ')
      throw new Error(
        `sprint ${input.id}: cannot be 'planned' - ${check.over.length} day(s) over capacity: ${worst}`,
      )
    }
  }

  await upsertRecord<Sprint>(
    SPRINTS,
    {
      id: input.id,
      title: input.title ?? prev?.title ?? input.id,
      goal: input.goal ?? prev?.goal ?? '',
      status,
      start_date: startDate,
      end_date: endDate,
      availability,
      // Stamped the first time it goes active, and never cleared - it is when the sprint actually
      // began, which stays true even if someone moves it back to `planned` to fix the scope.
      started_at: status === 'active' ? (prev?.started_at ?? new Date().toISOString()) : (prev?.started_at ?? null),
      done_at: status === 'done' ? (prev?.done_at ?? new Date().toISOString()) : null,
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev },
  )
  return (await readSprint(input.id))!
}

/**
 * Availability, canonicalised: hours clamped to >= 0, the calendar keyed by real dates in order.
 *
 * It also UPGRADES the retired `days_off: string[]` shape it may still be handed - an old stored
 * row, an MCP caller written against the old docs - by folding each date in as a 0. Doing it here
 * rather than at read time means a sprint is rewritten into the new shape the first time anybody
 * touches it, and there is exactly one place that knows the old spelling.
 */
function normalizeAvailability(raw: SprintAvailabilityMap | null | undefined): SprintAvailabilityMap {
  const out: SprintAvailabilityMap = {}
  for (const [user, v] of Object.entries(raw ?? {})) {
    const hours = typeof v?.hours === 'number' && Number.isFinite(v.hours) ? Math.max(0, v.hours) : undefined
    const legacy = (v as { days_off?: unknown } | undefined)?.days_off
    const calendar: Record<string, number> = {}
    if (Array.isArray(legacy)) {
      for (const d of legacy) if (typeof d === 'string' && DUE_DATE.test(d)) calendar[d] = 0
    }
    for (const [date, h] of Object.entries(v?.hours_by_date ?? {})) {
      if (!DUE_DATE.test(date)) continue
      if (typeof h !== 'number' || !Number.isFinite(h)) continue
      calendar[date] = Math.max(0, h)
    }
    const dates = Object.keys(calendar).sort()
    out[user] = {
      ...(hours !== undefined ? { hours } : {}),
      ...(dates.length ? { hours_by_date: Object.fromEntries(dates.map((d) => [d, calendar[d] as number])) } : {}),
    }
  }
  return out
}

/** A slot must land inside its sprint's window - otherwise it shows on no grid and fits no capacity. */
async function assertSlotInSprint(sprintId: string, slotDate: string): Promise<void> {
  const sprint = await readRecord<Sprint>(SPRINTS, { id: sprintId })
  if (!sprint) throw new Error(`sprint ${sprintId} not found`)
  if (!sprint.start_date || !sprint.end_date) {
    throw new Error(`sprint ${sprintId}: cannot slot a task onto a day before the sprint has dates`)
  }
  if (slotDate < sprint.start_date || slotDate > sprint.end_date) {
    throw new Error(
      `slot_date ${slotDate} is outside sprint ${sprintId} (${sprint.start_date} to ${sprint.end_date})`,
    )
  }
}

/**
 * Delete a sprint. Its tasks are RELEASED, never deleted - a sprint is a window over work, not the
 * work itself, so dropping the window has to leave the tasks on the board where they came from.
 *
 * The one exception is its SPRINT tasks: they came from nowhere but this sprint, so there is no
 * board to return them to, and released they would be rows no surface ever draws again.
 */
export async function deleteSprint(id: string): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    await conn.run(`DELETE FROM tasks WHERE sprint_id = ? AND initiative_id IS NULL`, [id])
    await conn.run(`UPDATE tasks SET sprint_id = NULL, slot_date = NULL WHERE sprint_id = ?`, [id])
  })
  await deleteRecord(SPRINTS, { id })
}

// --- what planning contributes to data's signal operations (registered by PlanningModule) --------

/** Every initiative's signal bindings (list + target), parsed defensively. */
async function readInitiativeBindings(): Promise<
  { id: string; signal_ids: string[]; target: { signal_id?: string } | null }[]
> {
  const rows = await withRead<{ id: string; signal_ids: string | null; target: string | null }>(
    `SELECT id, CAST(signal_ids AS VARCHAR) AS signal_ids, CAST(target AS VARCHAR) AS target
       FROM initiatives`,
  )
  return rows.map((r) => {
    const parse = (json: string | null): unknown => {
      if (!json) return null
      try {
        return JSON.parse(json)
      } catch {
        return null
      }
    }
    const ids = parse(r.signal_ids)
    const target = parse(r.target)
    return {
      id: r.id,
      signal_ids: Array.isArray(ids) ? (ids as string[]) : [],
      target: target && typeof target === 'object' ? (target as { signal_id?: string }) : null,
    }
  })
}

/** Re-point `initiatives.signal_ids` + `initiatives.target.signal_id` from oldId to newId. */
export async function repointInitiativeBindings(oldId: string, newId: string): Promise<void> {
  const rows = await readInitiativeBindings()
  let touched = 0
  for (const r of rows) {
    const boundList = r.signal_ids.includes(oldId)
    const boundTarget = r.target?.signal_id === oldId
    if (!boundList && !boundTarget) continue
    const nextIds = boundList ? [...new Set(r.signal_ids.map((i) => (i === oldId ? newId : i)))] : r.signal_ids
    const nextTarget = boundTarget ? { ...r.target, signal_id: newId } : r.target
    await withWrite(async (conn) => {
      await conn.run(
        `UPDATE initiatives SET signal_ids = ?::JSON, target = ?::JSON, updated_at = now() WHERE id = ?`,
        [JSON.stringify(nextIds), nextTarget == null ? null : JSON.stringify(nextTarget), r.id],
      )
    })
    touched++
  }
  if (touched > 0) emitChange('table:initiatives')
}

/** Initiatives still binding a signal id (signal_ids or target), as `initiative:<id>`. */
export async function initiativesReferencingSignal(signalId: string): Promise<string[]> {
  return (await readInitiativeBindings())
    .filter((r) => r.signal_ids.includes(signalId) || r.target?.signal_id === signalId)
    .map((r) => `initiative:${r.id}`)
}

/** Planning's contribution to data: the task-ledger rows on the github channel, its outcome
 *  derive, and its re-pointing of initiative bindings on a rename. */
export const PLANNING_SIGNAL_HOOKS: SignalHooks = {
  id: 'planning',
  channelRows: { github: computeSilkweavePrRows },
  derive: deriveOssPrSignals,
  onRename: repointInitiativeBindings,
  references: initiativesReferencingSignal,
}

/**
 * Planning's half of core's user-deletion port (registered by PlanningModule).
 *
 * A deleted user must not stay named as an owner or an assignee, so both are set back to NULL
 * (unassigned) - the rows survive, they just become unclaimed. Core used to run this SQL itself,
 * which meant core naming planning's tables; on a Box without planning the statements would not
 * fail to compile, they would fail at runtime on the first delete.
 */
export async function unassignDeletedUser(id: string): Promise<void> {
  await ensureSchema()
  await withWrite(async (conn) => {
    await conn.run(`UPDATE initiatives SET owner = NULL, updated_at = now() WHERE owner = ?`, [id])
    await conn.run(`UPDATE tasks SET assignee = NULL, updated_at = now() WHERE assignee = ?`, [id])
  })
}
