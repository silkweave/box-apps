import { useState } from 'react'
import { AlarmClock, Check, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { AppShell, Button, Checkbox, DateInput, EmptyState, PageContainer, PageHeader, todayLocal } from '@silkweave/box-ui'
import { useGroupNav } from '../../../lib/nav.ts'
import { formatDateTime, relativeTime } from '../../../lib/format.ts'
import { removeReminder, saveReminder, setReminderDone, useReminders, type Reminder } from '../lib/useRemindersData.ts'

/**
 * WHY THE DUE FIELD IS TWO CONTROLS. Core's `DateInput` is the one calendar field in the app and it
 * is deliberately date-only (`yyyy-mm-dd`); there is no date-TIME field in `@silkweave/box-ui`, and a
 * native `<input type='datetime-local'>` brings back exactly the locale-formatting problem
 * `DateInput` was written to end. So: the house date field, plus a 24-hour `HH:MM` text input whose
 * format is ours. The two are joined into one ISO instant here, in local time, because that is what
 * the person typing meant.
 */
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

function toIso(date: string, time: string): string | null {
  if (!date || !TIME.test(time)) return null
  const [h, m] = time.split(':').map(Number)
  const [y, mo, d] = date.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m).toISOString()
}

function ReminderRow({ reminder }: { reminder: Reminder }) {
  const done = reminder.done_at !== null
  const overdue = !done && new Date(reminder.due_at).getTime() < Date.now()
  return (
    <div className='flex items-start gap-3 border-b border-border px-4 py-3 last:border-0'>
      <Checkbox
        checked={done}
        onChange={(e) => void setReminderDone(reminder.id, e.target.checked)}
        aria-label={done ? `Reopen ${reminder.title}` : `Complete ${reminder.title}`}
        className='mt-0.5'
      />
      <div className='min-w-0 flex-1'>
        <p className={`truncate text-body-sm ${done ? 'text-muted-foreground line-through' : 'text-text'}`}>
          {reminder.title}
        </p>
        {reminder.description && (
          <p className='mt-0.5 line-clamp-2 text-label text-muted-foreground'>{reminder.description}</p>
        )}
      </div>
      <span className={`shrink-0 text-label ${overdue ? 'text-danger' : 'text-muted-foreground'}`} title={formatDateTime(reminder.due_at)}>
        {relativeTime(reminder.due_at)}
      </span>
      <Button
        variant='ghost'
        size='icon-xs'
        aria-label={`Delete ${reminder.title}`}
        onClick={() => void removeReminder(reminder.id)}
      >
        <Trash2 />
      </Button>
    </div>
  )
}

/** Add-one form: a title, a day, a 24-hour time, and an optional line of detail. */
function NewReminder() {
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(todayLocal())
  const [time, setTime] = useState('09:00')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const due_at = toIso(date, time)
    if (!title.trim()) return setError('Give it a name.')
    if (!due_at) return setError('A day and a 24-hour time, e.g. 09:00.')
    setError(null)
    try {
      await saveReminder({ title: title.trim(), due_at, description: description.trim() })
      setTitle('')
      setDescription('')
    } catch (e) {
      setError(String(e))
    }
  }

  const field = 'h-9 rounded-md border border-border bg-bg px-2.5 text-body-sm text-text outline-none focus-visible:border-ring'
  return (
    <div className='mb-6 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <div className='flex flex-wrap items-center gap-2'>
        <input
          className={`${field} min-w-56 flex-1`}
          placeholder='Remind me to…'
          value={title}
          aria-label='Reminder name'
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        <DateInput value={date} onChange={setDate} ariaLabel='Due date' />
        <input
          className={`${field} w-20 tabular-nums`}
          placeholder='09:00'
          value={time}
          aria-label='Due time, 24-hour'
          onChange={(e) => setTime(e.target.value)}
        />
        <Button onClick={() => void submit()}>
          <Plus /> Add
        </Button>
      </div>
      <input
        className={`${field} mt-2 w-full`}
        placeholder='Description (optional)'
        value={description}
        aria-label='Description'
        onChange={(e) => setDescription(e.target.value)}
      />
      {error && <p className='mt-2 text-label text-danger'>{error}</p>}
    </div>
  )
}

/** Reminders: open ones first, soonest first, then the completed ones. */
export function RemindersView() {
  const groupNav = useGroupNav('reminders')
  const { data, error } = useReminders()
  const open = (data ?? []).filter((r) => r.done_at === null)
  const done = (data ?? []).filter((r) => r.done_at !== null)

  return (
    <AppShell items={[]} activeId='' onSelect={() => undefined} groupNav={groupNav} topbar={{ crumbs: [{ label: 'Reminders' }] }}>
      <PageContainer width='wide'>
        <PageHeader title='Reminders' description='A moment in time, a name, and an optional line about why.' />
        {error && <p className='mb-4 text-body-sm text-danger'>{error}</p>}
        <NewReminder />

        {data && open.length === 0 && done.length === 0 ? (
          <EmptyState
            icon={<AlarmClock className='size-6' />}
            title='Nothing to remember'
            description='Add the first one above, or ask an agent: the same three writes are MCP tools.'
          />
        ) : (
          <>
            <div className='overflow-hidden rounded-lg border border-border bg-surface shadow-(--shadow-sm)'>
              {open.map((r) => (
                <ReminderRow key={r.id} reminder={r} />
              ))}
              {open.length === 0 && (
                <p className='px-4 py-6 text-center text-body-sm text-muted-foreground'>
                  <Check className='mr-1 inline size-4' /> Everything is done.
                </p>
              )}
            </div>

            {done.length > 0 && (
              <section className='mt-8'>
                <h2 className='mb-3 flex items-center gap-1.5 text-label uppercase tracking-[0.07em] text-muted-foreground'>
                  <RotateCcw className='size-3' /> Done
                </h2>
                <div className='overflow-hidden rounded-lg border border-border bg-surface shadow-(--shadow-sm)'>
                  {done.map((r) => (
                    <ReminderRow key={r.id} reminder={r} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </PageContainer>
    </AppShell>
  )
}
