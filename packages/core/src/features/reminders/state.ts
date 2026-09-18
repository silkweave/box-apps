// Reminders: read, upsert, complete, delete. Everything goes through the record layer
// (warehouse/model.ts + the REMINDERS spec), which owns the column list, the naive-UTC ↔ ISO-Z
// timestamp convention, the audit stamp and the `table:reminders` change-feed emit. There is no raw
// SQL here on purpose: this feature is the reference for "a table and nothing clever".

import { randomUUID } from 'node:crypto'
import { deleteRecord, readRecord, readRecords, upsertRecord } from '../../warehouse/model.js'
import { REMINDERS } from './models.js'

/** One reminder as every caller sees it: timestamps are ISO-8601 with `Z`. */
export interface Reminder {
  id: string
  title: string
  due_at: string
  description: string | null
  /** NULL while it is still open; the moment it was completed once it is not. */
  done_at: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

/** Partial upsert input. Omit `id` to create; omit any other field to leave it as it was. */
export interface ReminderInput {
  id?: string
  title?: string
  due_at?: string
  /** `''` clears it (the @Mcp() convention for a nullable text column). */
  description?: string | null
  done_at?: string | null
  actor?: string
}

/** Normalize to ISO-Z and refuse anything Date cannot read, so a bad string never reaches SQL. */
function isoAt(value: string, field: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new Error(`reminders: "${field}" is not a date/time: ${JSON.stringify(value)}`)
  return d.toISOString()
}

/**
 * Every reminder, soonest first, with the open ones ahead of the completed ones. The set is small
 * enough that the dashboard reads it whole; there is no paging and no filter language.
 */
export async function listReminders(): Promise<Reminder[]> {
  return readRecords<Reminder>(REMINDERS, {
    orderBy: 'CASE WHEN done_at IS NULL THEN 0 ELSE 1 END, due_at ASC, id ASC',
  })
}

/** One reminder, or null when the id is unknown. */
export async function readReminder(id: string): Promise<Reminder | null> {
  return readRecord<Reminder>(REMINDERS, { id })
}

/**
 * Create or partially update a reminder. A create needs a `title` and a `due_at`; an update needs
 * only the fields that change. The id is a UUID rather than a slug of the title: a reminder is
 * never addressed by name, and renaming one must not move it.
 */
export async function upsertReminder(input: ReminderInput): Promise<Reminder> {
  const { id, actor, ...rest } = input
  const prev = id ? await readReminder(id) : null
  if (id && !prev) throw new Error(`reminders: no reminder "${id}"`)

  const fields: Record<string, unknown> = {}
  if (rest.title !== undefined) {
    const title = rest.title.trim()
    if (!title) throw new Error('reminders: "title" cannot be blank')
    fields.title = title
  }
  if (rest.due_at !== undefined) fields.due_at = isoAt(rest.due_at, 'due_at')
  if (rest.description !== undefined) {
    const d = rest.description?.trim()
    fields.description = d ? d : null
  }
  if (rest.done_at !== undefined) fields.done_at = rest.done_at ? isoAt(rest.done_at, 'done_at') : null

  if (!prev) {
    if (!fields.title) throw new Error('reminders: a new reminder needs a "title"')
    if (!fields.due_at) throw new Error('reminders: a new reminder needs a "due_at"')
  }
  return upsertRecord<Reminder>(REMINDERS, { id: id ?? randomUUID(), ...fields, actor }, { prev })
}

/** Flip one reminder's completion. `done: false` reopens it; the stamp is always server-side. */
export async function setReminderDone(id: string, done: boolean, actor?: string): Promise<Reminder> {
  return upsertReminder({ id, done_at: done ? new Date().toISOString() : null, actor })
}

/** Remove a reminder. Silent when it is already gone - deleting twice is not an error. */
export async function deleteReminder(id: string): Promise<void> {
  await deleteRecord(REMINDERS, { id })
}
