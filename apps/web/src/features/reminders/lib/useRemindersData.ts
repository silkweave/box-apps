import { registerStoreReloads } from '../../../lib/changeFeed.ts'
import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'

// Reminders data layer: one shared store over the `reminders` tRPC query, reloaded by the change
// feed whenever the table moves - including when an agent writes through the MCP tools, which is the
// whole point of registering on `table:reminders` rather than refetching after each local mutation.

export interface Reminder {
  id: string
  title: string
  due_at: string
  description: string | null
  done_at: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

const store = createDataStore<Reminder[]>(() =>
  trpc.remindersList.query({}).then((d) => ((d as { reminders?: unknown[] }).reminders ?? []) as Reminder[]),
)
registerStoreReloads(['table:reminders'], store)

export const useReminders = (): { data: Reminder[] | null; error: string | null } => store.useData()
export const reloadReminders = store.reload

/** Create or partially update one, then refresh the store. */
export async function saveReminder(input: {
  id?: string
  title?: string
  due_at?: string
  description?: string
}): Promise<void> {
  await trpc.remindersUpsert.mutate(input)
  await store.reload()
}

/** Complete or reopen one. */
export async function setReminderDone(id: string, done: boolean): Promise<void> {
  await trpc.remindersDone.mutate({ id, done })
  await store.reload()
}

/** Remove one. */
export async function removeReminder(id: string): Promise<void> {
  await trpc.remindersDelete.mutate({ id })
  await store.reload()
}
