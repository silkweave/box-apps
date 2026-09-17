// Sprint Design - the first of the three sprint views: what window this sprint covers, and who is
// available inside it for how long. It is the step that moves a sprint `pending` -> `scheduled`,
// and the spec puts it well before planning (a quarterly sitting that lays out six two-week
// sprints), which is why it is reachable at any status rather than only at the start.
//
// **Availability IS the roster.** The server includes a person in the capacity grid when they have
// availability set or hold a slotted task, so the map's keys are the answer to "who is on this
// sprint" - there is no second membership field, and inventing one would give two places to say the
// same thing. Nobody is seeded automatically: a sprint that silently held the whole directory at 5h
// a day would report capacity for people who were never on it.
//
// Hours default to 5 (`DEFAULT_SPRINT_HOURS`) and NOT to 8, because ops, meetings and interrupts eat
// the rest - planning against 8 is how a sprint ends up 60% delivered.
//
// **The calendar is the surface** (2026-09-07). Availability used to be a number plus a list of
// days off, which could say "not working" two different ways and could not say "half a day" at all.
// It is now one grid - day down, person across, hours in the cell - laid out on the same axes as the
// planning grid so the two read as the same fortnight. A cell holding `0` IS the day off, and the
// per-person default above the column is what an untouched cell inherits.
//
// It is laid out FLUSH, like the initiatives and CRM grids: a toolbar strip of the sprint's own
// fields, then the calendar edge to edge, then a footer bar for the roster. The two rounded cards it
// used to sit in cost a gutter down both sides and a scroll cap at 60vh, which is a floating box of
// calendar on a page that had the room for all of it. The sprint TITLE lives in that strip now -
// this is where a sprint is defined, and the view no longer draws a header to hold it.

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, DateRangeInput, Avatar, InlineEdit, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@silkweave/box-ui'
import { Note } from './SprintGrid.tsx'
import { upsertSprint } from '../../lib/useSprintsData.ts'
import {
  DEFAULT_SPRINT_HOURS,
  capacityOn,
  datesBetween,
  formatDay,
  isWeekend,
  weekKey,
  type SprintAvailability,
  type SprintDetail,
} from '../../sprint-types.ts'
import { userName, type User } from '../../../../user-types.ts'

export function SprintDesign({
  sprint,
  users,
  onError,
}: {
  sprint: SprintDetail
  users: User[]
  onError: (message: string | null) => void
}) {
  const dates = datesBetween(sprint.start_date, sprint.end_date)
  const availability = sprint.availability ?? {}
  const roster = Object.keys(availability).sort()

  const save = (patch: Parameters<typeof upsertSprint>[0]): void => {
    onError(null)
    void upsertSprint(patch).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
  }

  /** Every write replaces the WHOLE map - that is the server's contract for `availability`. */
  const writeAvailability = (next: Record<string, SprintAvailability>): void =>
    save({ id: sprint.id, availability: next })

  const setPerson = (id: string, value: SprintAvailability | null): void => {
    const next = { ...availability }
    if (value === null) delete next[id]
    else next[id] = value
    // A write that changes nothing is not free: every upsert reloads the sprint, which re-renders
    // this grid, which can issue another write. That loop has bitten once already (see HoursInput),
    // and one structural equality check here makes it impossible to start rather than merely
    // unlikely.
    if (JSON.stringify(next) === JSON.stringify(availability)) return
    writeAvailability(next)
  }

  const offRoster = users.filter((u) => !(u.id in availability))

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      {/* The sprint's own fields, on one line. Same toolbar the grids wear: a bordered strip on the
          page background rather than a card floating in padding. The TITLE is not here - it is the
          breadcrumb, which is editable, and a second field for one string is one too many. */}
      <div className='flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg px-3 py-2'>
        <Field label='Window'>
          <DateRangeInput
            value={{ start: sprint.start_date ?? '', end: sprint.end_date ?? '' }}
            ariaLabel='Sprint window'
            onChange={({ start, end }) => save({ id: sprint.id, start_date: start, end_date: end })}
          />
        </Field>
        <Field label='Goal' className='min-w-64 flex-1'>
          <InlineEdit
            defaultValue={sprint.goal}
            aria-label='Sprint goal'
            placeholder='What this sprint is for'
            onCommit={(v) => save({ id: sprint.id, goal: v })}
            className='min-w-0 flex-1'
            inputClassName='px-1.5 py-0.5'
          />
        </Field>
        <span className='text-label whitespace-nowrap text-muted-foreground'>
          {dates.length > 0
            ? `${dates.length} days · ${dates.filter((d) => !isWeekend(d)).length} weekdays · ${roster.length} ${roster.length === 1 ? 'person' : 'people'}`
            : 'No window yet - a sprint needs both dates before it can leave Pending.'}
        </span>
      </div>

      {/* Only a missing window hides the calendar. An empty ROSTER must still draw it: the ghost
          column is the only place a person can be added, so hiding it on an empty sprint left no
          way onto the sprint at all. */}
      {dates.length === 0 ? (
        <div className='min-h-0 flex-1 overflow-y-auto p-3'>
          <Note>Set the window above and the calendar appears.</Note>
        </div>
      ) : (
        <AvailabilityCalendar
          dates={dates}
          roster={roster}
          users={users}
          offRoster={offRoster}
          availability={availability}
          onChangePerson={(id, next) => setPerson(id, next)}
          onRemovePerson={(id) => setPerson(id, null)}
        />
      )}

    </div>
  )
}

/**
 * The availability calendar: one row per day of the window, one column per person - the SAME axes
 * as the planning grid, deliberately, because they are two readings of one fortnight and inverting
 * one of them would make the pair unreadable together.
 *
 * A cell holds the hours that person works that day. It shows the EFFECTIVE number always (an
 * untouched Wednesday reads `5`, an untouched Saturday reads `off`) but only an explicitly set day
 * is stored, so raising somebody's default afterwards still moves every day they never touched.
 * That difference is visible: an inherited value is muted, an override is solid and carries a
 * revert affordance.
 */
function AvailabilityCalendar({
  dates,
  roster,
  users,
  offRoster,
  availability,
  onChangePerson,
  onRemovePerson,
}: {
  dates: string[]
  roster: string[]
  users: User[]
  /** Everyone not on the sprint yet - the ghost column's menu. */
  offRoster: User[]
  availability: Record<string, SprintAvailability>
  onChangePerson: (id: string, next: SprintAvailability) => void
  onRemovePerson: (id: string) => void
}) {
  const setHoursOn = (id: string, date: string, hours: number | null): void => {
    const person = availability[id] ?? {}
    const calendar = { ...person.hours_by_date }
    // Clearing an override DELETES the key rather than writing the default in as a number: an
    // inherited day has to stay inherited, or raising the column's default later would move every
    // day except the ones somebody once looked at.
    if (hours === null) delete calendar[date]
    else calendar[date] = Math.max(0, hours)
    onChangePerson(id, { ...person, hours_by_date: calendar })
  }

  const totalFor = (id: string): number =>
    dates.reduce((sum, d) => sum + capacityOn(d, availability[id]), 0)

  // Weekends are not rows here. A sprint is planned in working days, and a fortnight drew four rows
  // of zeroes nobody was going to edit - which is a third of the grid spent saying "Saturday".
  //
  // Unless somebody actually works one: a date the calendar NAMES stays visible whatever day of the
  // week it falls on, because that is a real, deliberate entry, and a row you cannot see is a row
  // you cannot take back. (`totalFor` still walks the whole window - a worked Saturday counts either
  // way, and hiding a row must never change a number.)
  const worked = new Set(roster.flatMap((id) => Object.keys(availability[id]?.hours_by_date ?? {})))
  const rows = dates.filter((d) => !isWeekend(d) || worked.has(d))

  return (
    <div className='min-h-0 flex-1 overflow-auto'>
      <table className='w-full min-w-max border-separate border-spacing-0'>
        <thead>
          <tr>
            <th className='sticky top-0 left-0 z-30 w-32 min-w-32 bg-bg px-3 py-2 text-left align-bottom text-label font-medium text-muted-foreground'>
              Day
            </th>
            {roster.map((id) => {
              const user = users.find((u) => u.id === id)
              const person = availability[id] ?? {}
              return (
                <th
                  key={id}
                  className='sticky top-0 z-20 w-44 min-w-44 border-l border-border-light bg-bg px-3 py-2 text-left align-bottom'>
                  <div className='flex items-center justify-between gap-1'>
                    <span className='inline-flex min-w-0 items-center gap-1.5 text-body-sm font-medium text-text'>
                      {user && <Avatar user={user} size='xs' />}
                      <span className='truncate'>{user ? user.nickname || userName(user) : id}</span>
                    </span>
                    <Button
                      variant='ghost'
                      size='icon-xs'
                      aria-label={`Remove ${user ? userName(user) : id} from the sprint`}
                      onClick={() => onRemovePerson(id)}>
                      <X />
                    </Button>
                  </div>
                  {/* The default sits at the top of the column it governs, rather than in a
                      separate list - it is the value every untouched cell below is showing. No
                      "h / day" caption: the field renders its own `h`, and the column IS days. */}
                  <div className='mt-1'>
                    <HoursInput
                      value={person.hours ?? DEFAULT_SPRINT_HOURS}
                      ariaLabel={`Default hours a day for ${user ? userName(user) : id}`}
                      onCommit={(v) => onChangePerson(id, { ...person, hours: v ?? DEFAULT_SPRINT_HOURS })}
                    />
                  </div>
                </th>
              )
            })}
            {/* The GHOST column: the place a new person is added, at the end of the row of people
                they are joining. It doubles as the spacer that takes every pixel the roster does
                not need - without one, the table's auto layout shares the leftover width among the
                person columns and a 3-person sprint draws three 500px columns holding one number
                each. */}
            <th className='sticky top-0 z-20 w-full border-x border-border-light bg-[var(--bg-code)] px-3 py-2 text-left align-bottom'>
              {offRoster.length > 0 ? (
                // On the NAME row, not under it: this is the next column's name, waiting to be
                // chosen. The empty line below keeps its baseline with the hours defaults beside it.
                <div className='flex h-full flex-col'>
                  <Select
                    value=''
                    // The select is pinned to '' so it always reads "Add person", which means it
                    // also reports a CLEAR (`null`) once the chosen person leaves `offRoster`.
                    // `String(null)` is "null", and the server rightly refuses a user by that name.
                    onValueChange={(v) => {
                      if (typeof v === 'string' && v) onChangePerson(v, { hours: DEFAULT_SPRINT_HOURS })
                    }}
                    items={offRoster.map((u) => ({ value: u.id, label: userName(u) }))}>
                    <SelectTrigger
                      aria-label='Add somebody to this sprint'
                      className='h-6 w-40 border-none bg-transparent px-0 text-muted-foreground hover:text-text'>
                      <SelectValue placeholder='Add person'>
                        {() => (
                          <span className='inline-flex items-center gap-1.5 text-body-sm font-medium'>
                            <Plus className='size-3.5' /> Add person
                          </span>
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {offRoster.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          <span className='flex items-center gap-1.5'>
                            <Avatar user={u} size='xs' />
                            {userName(u)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className='mt-1 h-7' aria-hidden />
                </div>
              ) : (
                <span className='text-label text-fg-4'>Everybody is on this sprint</span>
              )}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((date, i) => {
            const newWeek = i > 0 && weekKey(date) !== weekKey(rows[i - 1] as string)
            return (
              <tr key={date}>
                <th
                  className={cn(
                    'sticky left-0 z-10 border-t bg-bg px-3 py-1 text-left align-middle text-label font-medium whitespace-nowrap',
                    newWeek ? 'border-border-strong' : 'border-border-light',
                    isWeekend(date) ? 'text-fg-4' : 'text-muted-foreground',
                  )}>
                  {formatDay(date)}
                </th>
                {roster.map((id) => {
                  const person = availability[id] ?? {}
                  const override = person.hours_by_date?.[date]
                  return (
                    <td
                      key={id}
                      className={cn(
                        'border-t border-l border-border-light px-2 py-1 align-middle',
                        newWeek && 'border-t-border-strong',
                        isWeekend(date) && 'bg-bg/60',
                      )}>
                      <HoursInput
                        value={capacityOn(date, person)}
                        muted={override === undefined}
                        ariaLabel={`Hours for ${id} on ${formatDay(date)}`}
                        onCommit={(v) => setHoursOn(id, date, v)}
                      />
                    </td>
                  )
                })}
                <td
                  className={cn(
                    'border-x border-t border-border-light bg-[var(--bg-code)]',
                    newWeek && 'border-t-border-strong',
                  )}
                />
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr>
            <th className='sticky bottom-0 left-0 z-30 border-t border-border-strong bg-bg px-3 py-2 text-left text-label font-medium text-muted-foreground'>
              Capacity
            </th>
            {roster.map((id) => (
              <td
                key={id}
                // Right-aligned on the same edge as the hours above it, so the column reads as one
                // stack of numbers and the total lines up under what it totals.
                className='sticky bottom-0 z-20 border-t border-l border-border-strong bg-bg py-2 pr-3.5 text-right text-label tabular-nums text-text'>
                {totalFor(id)}h
              </td>
            ))}
            <td className='sticky bottom-0 z-20 border-x border-t border-border-light border-t-border-strong bg-[var(--bg-code)]' />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

/**
 * One hours field, filling its cell.
 *
 * It reads as `5h` at rest and edits as a right-aligned number with the `h` still showing beside it,
 * so the unit never disappears and the column stays a column of numbers rather than jumping a
 * character wider the moment you click into it. The suffix is a sibling span, not part of the value:
 * putting it in the string would mean parsing it back out on every keystroke.
 *
 * **Whole hours only.** Arrow keys step by one and a typed `3.5` rounds on commit - the capacity
 * check reasons in effort bands (`4-16h`), so a half hour of availability is precision the arithmetic
 * downstream cannot use and nobody would trust.
 *
 * **Empty means "inherit".** Clearing the field is how a day goes back to the column's default,
 * which is why there is no reset control beside it: the field already had a spelling for it.
 *
 * Controlled with a local draft rather than `defaultValue`, so a change made over MCP or in another
 * tab appears here instead of being masked by a stale uncontrolled input.
 *
 * **The draft is synced DURING RENDER, not in an effect** - and that is a bug fix, not a style
 * choice (2026-09-07). With `useEffect` the sync lands after paint, so there is a window where the
 * field is showing this render's `value` while `draft` still holds the last one; a blur in that
 * window commits the stale number, the write re-renders the grid, and the next blur does it again.
 * On a column of these it ran away: the dashboard sat there issuing `sprintUpsert` after
 * `sprintUpsert`, walking each person's hours one column sideways, with nobody touching the page.
 * React's own name for this pattern is "adjusting state when props change"; it runs before the
 * commit, so there is no stale window at all.
 */
function HoursInput({
  value,
  ariaLabel,
  muted,
  onCommit,
}: {
  value: number
  ariaLabel: string
  /** The value is inherited rather than set here - shown, but not asserted. */
  muted?: boolean
  /** `null` = clear this override and go back to the default. */
  onCommit: (next: number | null) => void
}) {
  const [editing, setEditing] = useState(false)
  // The prop is the truth: whenever it moves under us (another tab, a default change above this
  // column, an optimistic write settling) the field follows it - synchronously, see above.
  const [draft, setDraft] = useState(String(value))
  const [syncedTo, setSyncedTo] = useState(value)
  if (syncedTo !== value) {
    setSyncedTo(value)
    setDraft(String(value))
  }

  const commit = (): void => {
    setEditing(false)
    const raw = draft.trim()
    if (raw === '') {
      setDraft(String(value))
      return onCommit(null)
    }
    const n = Math.round(Number(raw))
    if (!Number.isFinite(n) || n < 0) return setDraft(String(value))
    setDraft(String(n))
    if (n !== value) onCommit(n)

  }

  const nudge = (by: number): void => {
    const n = Math.min(24, Math.max(0, Math.round(Number(draft.trim() || value)) + by))
    setDraft(String(n))
  }

  return (
    <span
      className={cn(
        'flex h-7 w-full items-center rounded-md border pr-1.5 transition-colors',
        editing ? 'border-accent bg-bg' : 'border-transparent hover:border-border',
      )}>
      <input
        type='text'
        inputMode='numeric'
        value={draft}
        aria-label={ariaLabel}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(String(value))
            e.currentTarget.blur()
          }
          // Arrow keys step whole hours - a text input gives us none of that for free, and it is
          // the one affordance a number input had that was worth keeping.
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            nudge(1)
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            nudge(-1)
          }
        }}
        className={cn(
          'min-w-0 flex-1 bg-transparent text-right text-body-sm tabular-nums outline-none',
          muted && !editing ? 'text-fg-4' : 'text-text',
          value <= 0 && !editing && 'text-fg-4',
        )}
      />
      <span
        aria-hidden
        className={cn('shrink-0 pl-0.5 text-body-sm', muted && !editing ? 'text-fg-4' : 'text-muted-foreground')}>
        h
      </span>
    </span>
  )
}

/** A label and its control, side by side - the toolbar strip is one line, not a form. */
function Field({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <label className={cn('flex items-center gap-1.5', className)}>
      <span className='shrink-0 text-label font-medium text-muted-foreground'>{label}</span>
      {children}
    </label>
  )
}
