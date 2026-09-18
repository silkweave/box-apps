// The reminders write path against a throwaway warehouse: what it refuses, what it normalizes, and
// what a partial update leaves alone. Three properties this app promises and nothing else pins:
//
//   - `due_at` is an INSTANT, normalized to ISO-Z whatever offset it arrives in;
//   - `done_at` is the whole lifecycle, and it round-trips both ways;
//   - a partial update keeps every column it does not mention (the record layer's merge).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteReminder, listReminders, readReminder, setReminderDone, upsertReminder } from './state.js'
import { setInstanceDir, resetInstanceDir } from '../../testing.js'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'box-reminders-'))
  setInstanceDir(dir)
})

afterAll(() => {
  resetInstanceDir()
  rmSync(dir, { recursive: true, force: true })
})

describe('creating', () => {
  it('needs a title and a due_at', async () => {
    await expect(upsertReminder({ due_at: '2026-10-01T09:00:00Z' })).rejects.toThrow(/"title"/)
    await expect(upsertReminder({ title: 'Renew the domain' })).rejects.toThrow(/"due_at"/)
    await expect(upsertReminder({ title: '   ', due_at: '2026-10-01T09:00:00Z' })).rejects.toThrow(/blank/)
  })

  it('refuses a due_at that is not a date/time', async () => {
    await expect(upsertReminder({ title: 'x', due_at: 'next tuesday' })).rejects.toThrow(/date\/time/)
  })

  it('normalizes any offset to ISO-Z and mints an id', async () => {
    const r = await upsertReminder({ title: 'Renew the domain', due_at: '2026-10-01T11:00:00+02:00' })
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.due_at).toBe('2026-10-01T09:00:00Z')
    expect(r.description).toBeNull()
    expect(r.done_at).toBeNull()
  })

  it('stores a blank description as NULL, not as ""', async () => {
    const r = await upsertReminder({ title: 'Water the plants', due_at: '2026-10-02T08:00:00Z', description: '  ' })
    expect(r.description).toBeNull()
  })
})

describe('updating', () => {
  it('leaves every column the input does not mention', async () => {
    const made = await upsertReminder({
      title: 'Call the bank',
      due_at: '2026-10-03T10:00:00Z',
      description: 'about the transfer',
    })
    const moved = await upsertReminder({ id: made.id, due_at: '2026-10-04T10:00:00Z' })
    expect(moved.title).toBe('Call the bank')
    expect(moved.description).toBe('about the transfer')
    expect(moved.due_at).toBe('2026-10-04T10:00:00Z')
  })

  it("clears the description with '' and keeps it cleared", async () => {
    const made = await upsertReminder({ title: 'Book the flight', due_at: '2026-10-05T10:00:00Z', description: 'aisle seat' })
    expect((await upsertReminder({ id: made.id, description: '' })).description).toBeNull()
    expect((await upsertReminder({ id: made.id, title: 'Book the flight home' })).description).toBeNull()
  })

  it('refuses an unknown id rather than silently creating one', async () => {
    await expect(upsertReminder({ id: 'nope', title: 'x' })).rejects.toThrow(/no reminder/)
  })
})

describe('done_at is the whole lifecycle', () => {
  it('stamps on complete and clears on reopen', async () => {
    const made = await upsertReminder({ title: 'Cancel the trial', due_at: '2026-10-06T10:00:00Z' })
    const done = await setReminderDone(made.id, true)
    expect(done.done_at).not.toBeNull()
    expect(await setReminderDone(made.id, false)).toHaveProperty('done_at', null)
  })
})

describe('listing and deleting', () => {
  it('puts the open ones first, then the soonest first', async () => {
    const rows = await listReminders()
    const openCount = rows.findIndex((r) => r.done_at !== null)
    const open = openCount === -1 ? rows : rows.slice(0, openCount)
    expect(open.length).toBeGreaterThan(1)
    // Pairwise rather than a sort: oxlint refuses a mutating `.sort()` here and core's tsconfig
    // lib predates `.toSorted()`, so the honest assertion is that no neighbour is out of order.
    const due = open.map((r) => r.due_at)
    expect(due.every((v, i) => i === 0 || due[i - 1]! <= v)).toBe(true)
  })

  it('deletes, and deleting twice is not an error', async () => {
    const made = await upsertReminder({ title: 'Temporary', due_at: '2026-10-07T10:00:00Z' })
    await deleteReminder(made.id)
    expect(await readReminder(made.id)).toBeNull()
    await expect(deleteReminder(made.id)).resolves.toBeUndefined()
  })
})
