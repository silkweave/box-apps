// Sprint tasks, against a throwaway warehouse (2026-09-14).
//
// A sprint task is a task with NO initiative: it belongs to the sprint and is drawn on exactly one
// person-day of it. Nothing else draws it - not the backlog, not the board - so the refusals are
// the whole contract. A sprint task off its day, out of its sprint or without an owner is a row no
// surface would ever show again, and the only honest way out is to delete it or move it into an
// initiative.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createSprintTask,
  deleteSprint,
  moveTask,
  readInitiatives,
  readSprint,
  renameTask,
  upsertInitiative,
  upsertSprint,
  upsertTask,
} from './state.js'
import { upsertUser } from '../../users/state.js'
import { setInstanceDir, resetInstanceDir } from '../../testing.js'

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'box-sprint-tasks-'))
  setInstanceDir(dir)
  await upsertUser({ id: 'sam', first_name: 'Sam', last_name: 'Rivera' })
  await upsertUser({ id: 'kit', first_name: 'Kit', last_name: 'Moore' })
  await upsertInitiative({ id: 'platform', title: 'Platform' })
  await upsertSprint({ id: 'w38', title: 'Week 38', start_date: '2026-09-14', end_date: '2026-09-18' })
})

afterAll(() => {
  resetInstanceDir()
  rmSync(dir, { recursive: true, force: true })
})

describe('creating one', () => {
  it('lands slotted, assigned and due that day, under no initiative', async () => {
    const task = await createSprintTask({
      sprint_id: 'w38',
      title: 'Fix login',
      assignee: 'sam',
      slot_date: '2026-09-15',
      estimate_hours: 2,
      actor: 'sam',
    })
    expect(task.id).toBe('w38/fix-login')
    expect(task.initiative_id).toBeNull()
    expect(task.sprint_id).toBe('w38')
    expect(task.slot_date).toBe('2026-09-15')
    // The day IS the deadline, as it is for every task dropped onto the grid.
    expect(task.due_date).toBe('2026-09-15')
    expect(task.assignee).toBe('sam')
    expect(task.estimate_hours).toBe(2)
  })

  it('suffixes a taken slug rather than refusing - two "Fix login" tasks are two tasks', async () => {
    const again = await createSprintTask({ sprint_id: 'w38', title: 'Fix login', assignee: 'kit', slot_date: '2026-09-15' })
    expect(again.id).toBe('w38/fix-login-2')
  })

  it('refuses a day outside the window, a title that slugs to nothing, and an unknown sprint', async () => {
    await expect(
      createSprintTask({ sprint_id: 'w38', title: 'Too late', assignee: 'sam', slot_date: '2026-09-28' }),
    ).rejects.toThrow(/outside sprint w38/)
    await expect(
      createSprintTask({ sprint_id: 'w38', title: '!!!', assignee: 'sam', slot_date: '2026-09-15' }),
    ).rejects.toThrow(/task slug/)
    await expect(
      createSprintTask({ sprint_id: 'nope', title: 'Orphan', assignee: 'sam', slot_date: '2026-09-15' }),
    ).rejects.toThrow(/sprint nope not found/)
  })
})

describe('where it is readable', () => {
  it('is on its sprint, and on no initiative', async () => {
    const sprint = await readSprint('w38')
    expect(sprint?.tasks.map((t) => t.id)).toContain('w38/fix-login')
    // `initiative_ids` is derived from the tasks, and a sprint task contributes none.
    expect(sprint?.initiative_ids).toEqual([])
    const inits = await readInitiatives()
    expect(inits.flatMap((i) => i.tasks.map((t) => t.id))).not.toContain('w38/fix-login')
  })
})

describe('editing one', () => {
  it('takes every ordinary edit', async () => {
    const edited = await upsertTask({ id: 'w38/fix-login', title: 'Fix login properly', status: 'active', priority: 2 })
    expect(edited.title).toBe('Fix login properly')
    expect(edited.status).toBe('active')
    expect(edited.priority).toBe(2)
    expect(edited.initiative_id).toBeNull()
  })

  it('re-dates inside the window, and refuses a day outside it', async () => {
    const moved = await upsertTask({ id: 'w38/fix-login', slot_date: '2026-09-17' })
    expect(moved.slot_date).toBe('2026-09-17')
    await expect(upsertTask({ id: 'w38/fix-login', slot_date: '2026-10-01' })).rejects.toThrow(/outside sprint w38/)
  })

  it('refuses the three writes that would take it out of the only place it is drawn', async () => {
    await expect(upsertTask({ id: 'w38/fix-login', initiative_id: 'platform' })).rejects.toThrow(/use task-move/)
    await expect(upsertTask({ id: 'w38/fix-login', sprint_id: null })).rejects.toThrow(/cannot leave its sprint/)
    await expect(upsertTask({ id: 'w38/fix-login', slot_date: null })).rejects.toThrow(/cannot come off its day/)
    await expect(upsertTask({ id: 'w38/fix-login', assignee: null })).rejects.toThrow(/cannot lose its owner/)
    // Every refusal names the way out.
    await expect(upsertTask({ id: 'w38/fix-login', sprint_id: null })).rejects.toThrow(/Delete it instead/)
  })

  it('keeps the STORED parent on a rename, rather than adopting the sprint as an initiative', async () => {
    const renamed = await renameTask('w38/fix-login-2', 'fix-signup')
    expect(renamed.id).toBe('w38/fix-signup')
    expect(renamed.initiative_id).toBeNull()
  })
})

describe('the ways out', () => {
  it('task-move turns one into ordinary work under an initiative', async () => {
    const moved = await moveTask('w38/fix-signup', 'platform')
    expect(moved.id).toBe('platform/fix-signup')
    expect(moved.initiative_id).toBe('platform')
    // Now an ordinary task: it can leave the sprint.
    const out = await upsertTask({ id: 'platform/fix-signup', sprint_id: null })
    expect(out.sprint_id).toBeNull()
  })

  it('deleting the sprint deletes its sprint tasks and releases the rest', async () => {
    await upsertTask({ id: 'platform/keep-me', title: 'Keep me', sprint_id: 'w38', slot_date: '2026-09-16', assignee: 'sam' })
    await deleteSprint('w38')
    expect(await readSprint('w38')).toBeNull()
    const tasks = (await readInitiatives()).flatMap((i) => i.tasks)
    // The initiative task survives, released from the window it was in.
    const kept = tasks.find((t) => t.id === 'platform/keep-me')
    expect(kept?.sprint_id).toBeNull()
    expect(kept?.slot_date).toBeNull()
    // The sprint task is gone - released, it would be a row no surface draws.
    expect(tasks.map((t) => t.id)).not.toContain('w38/fix-login')
  })
})
