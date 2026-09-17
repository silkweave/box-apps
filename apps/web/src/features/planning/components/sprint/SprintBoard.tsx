// The Board - and since 2026-09-08 it is one thing rather than two: **the daily check-in**.
//
// It used to be the stand-up read stacked on a copy of the week calendar, and the calendar half was
// never seen: both were `shrink-0`, so one person with 21 slipping tasks made the stand-up 2000px
// tall and pushed the grid off the bottom of the screen. The grid is gone from here entirely now -
// Planning owns the person-day calendar, at full height, with the drag surface - and what is left
// is the surface the team actually stands in front of at 09:00.
//
// The shape follows the ritual:
//   • a **burndown hero** on top, collapsible, answering "are we ahead or behind" before anyone
//     speaks;
//   • one **lane per person** - a big avatar, the name under it - because the stand-up goes round
//     the room, and the room is the axis;
//   • three **cards** per lane, in the order the questions get asked: done since the last working
//     day, today, slipping;
//   • each card is **ticked off** as it is discussed, which collapses it to a line, so what is left
//     on screen is exactly what has not been covered yet;
//   • when the last card is ticked a **Complete check-in** footer appears, and completing the day
//     records it (and throws confetti, because a ritual that never ends in anything is a meeting).
//
// **The ticks are the team's, not the browser's.** They live in `sprint_checkins`, one row per
// sprint-day, so two people running this side by side see one check-in. The write sends the KEY it
// is toggling rather than the whole set - see core's `tickCheckin` for why that is the difference
// between a shared ritual and a race.
//
// The page SCROLLS AS ONE (no split panes, no inner scrollers): a stand-up is read top to bottom.

import { useState } from 'react'
import { AlertTriangle, CalendarDays, Check, CheckCircle2, PartyPopper } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar, Button, Confetti, todayUtc } from '@silkweave/box-ui'
import { SprintBurndown } from './SprintBurndown.tsx'
import { Note, TaskCard, rosterOf } from './SprintGrid.tsx'
import { completeCheckin, tickCheckin } from '../../lib/useSprintsData.ts'
import { TERMINAL_PLANNING_STATUSES, type Task } from '../../planning-types.ts'
import { formatDay, previousWorkingDay, type CheckinBucket, type SprintDetail } from '../../sprint-types.ts'
import { userName, type User } from '../../../../user-types.ts'
import { useActiveUser } from '../../../../lib/useActiveUser.ts'

/** Below this a card's second line wraps. Past it the lanes scroll sideways rather than squeeze. */
const MIN_LANE_PX = 300

export function SprintBoard({
  sprint,
  users,
  onOpenTask,
  onError,
}: {
  sprint: SprintDetail
  users: User[]
  onOpenTask?: (id: string) => void
  /** A refused write. Reported UP - the sprint header owns the one banner. */
  onError: (message: string | null) => void
}) {
  const today = todayUtc()
  const { userId } = useActiveUser()
  const roster = rosterOf(sprint, userId)
  const since = previousWorkingDay(today)
  const checkin = sprint.checkin
  const ticks = new Set(checkin?.ticks ?? [])
  const completed = Boolean(checkin?.completed_at)
  // Fired by INCREMENT rather than a boolean: completing twice (a reopened day closed again) should
  // throw confetti twice, and a flag flipped back to true is not a new event.
  const [burst, setBurst] = useState(0)
  const [busy, setBusy] = useState(false)

  const lanes = roster.map((id) => ({
    id,
    user: users.find((u) => u.id === id),
    buckets: bucketsFor(sprint.tasks.filter((t) => t.assignee === id), today, since),
  }))
  const total = lanes.length * 3
  const done = lanes.reduce(
    (n, lane) => n + lane.buckets.filter((b) => ticks.has(`${lane.id}:${b.id}`)).length,
    0,
  )
  const allTicked = total > 0 && done === total

  const toggle = (user: string, bucket: CheckinBucket, next: boolean): void => {
    onError(null)
    void tickCheckin({ id: sprint.id, date: today, user, bucket, done: next }).catch((e: unknown) =>
      onError(e instanceof Error ? e.message : String(e)),
    )
  }

  const finish = (): void => {
    setBusy(true)
    onError(null)
    void completeCheckin(sprint.id, today)
      .then(() => setBurst((n) => n + 1))
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <Confetti fire={burst} />
      {/* ONE scroller for the whole view - the hero, the lanes and the footer are a single page. */}
      <div className='min-h-0 flex-1 overflow-y-auto'>
        <SprintBurndown
          points={sprint.burndown}
          today={today}
          scope={sprint.tasks.reduce((h, t) => h + (t.estimate_hours ?? 0), 0)}
        />

        {roster.length === 0 ? (
          <div className='p-4'>
            <Note>Nobody is on this sprint yet. Add the team in Design - availability is the roster.</Note>
          </div>
        ) : (
          <>
            <div className='flex items-center gap-2 border-b border-border px-3 py-2 text-label'>
              <CheckCircle2 className={cn('size-3.5 shrink-0', completed ? 'text-success' : 'text-muted-foreground')} />
              <span className='font-medium text-text'>Check-in</span>
              <span className='truncate text-muted-foreground'>{formatDay(today)}</span>
              <span className='ml-auto shrink-0 tabular-nums text-fg-4'>
                {done} / {total}
              </span>
            </div>

            {/* Lanes share the width and only overflow past the point a card stops being readable -
                the same rule as the planning grid's person columns. */}
            <div
              className='grid items-start overflow-x-auto'
              style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(${MIN_LANE_PX}px, 1fr))` }}>
              {lanes.map((lane) => (
                <Lane
                  key={lane.id}
                  userId={lane.id}
                  user={lane.user}
                  buckets={lane.buckets}
                  ticks={ticks}
                  onToggle={toggle}
                  onOpenTask={onOpenTask}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* The footer is OUTSIDE the scroller: a call to action that scrolls away is one nobody
          presses. It appears only when there is nothing left to walk. */}
      {roster.length > 0 && (allTicked || completed) && (
        <footer className='flex shrink-0 items-center gap-3 border-t border-border bg-surface px-4 py-3'>
          {completed ? (
            <>
              <PartyPopper className='size-4 shrink-0 text-success' />
              <span className='text-body-sm text-text'>
                Check-in complete
                <span className='ml-2 text-label text-muted-foreground'>
                  {formatTime(checkin?.completed_at)}
                  {checkin?.completed_by ? ` · ${checkin.completed_by}` : ''}
                </span>
              </span>
              <span className='ml-auto text-label text-fg-4'>Un-tick any card to reopen the day</span>
            </>
          ) : (
            <>
              <span className='text-body-sm text-text'>Every lane is walked.</span>
              <span className='text-label text-muted-foreground'>{formatDay(today)}</span>
              <Button className='ml-auto' disabled={busy} onClick={finish}>
                <CheckCircle2 /> Complete check-in
              </Button>
            </>
          )}
        </footer>
      )}
    </div>
  )
}

/** `2026-09-08T09:12:33Z` -> `09:12`. Local time: it is a thing that happened in the room. */
function formatTime(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

interface BucketView {
  id: CheckinBucket
  label: string
  icon: typeof CheckCircle2
  tone: string
  hint?: string
  tasks: Task[]
}

/**
 * The three questions, derived - never stored.
 *
 * `since` is the last WORKING day rather than literally yesterday: on a Monday, yesterday is Sunday,
 * and the bucket silently dropped everything finished on Friday - on the one morning of the week a
 * stand-up is actually held (2026-09-08).
 */
function bucketsFor(tasks: Task[], today: string, since: string): BucketView[] {
  const open = (t: Task): boolean => !TERMINAL_PLANNING_STATUSES.includes(t.status)
  return [
    {
      id: 'done',
      label: `Done since ${formatDay(since)}`,
      icon: CheckCircle2,
      tone: 'text-success',
      tasks: tasks.filter((t) => t.status === 'done' && (t.done_at ?? '').slice(0, 10) >= since),
    },
    {
      id: 'today',
      label: 'Today',
      icon: CalendarDays,
      tone: 'text-accent',
      tasks: tasks.filter((t) => t.slot_date === today),
    },
    {
      id: 'slipping',
      label: 'Slipping',
      icon: AlertTriangle,
      tone: 'text-danger',
      hint: 'Blocked, past its deadline, or left on a day that has gone by',
      tasks: tasks.filter(
        (t) =>
          open(t) &&
          (t.status === 'blocked' ||
            (t.due_date !== null && t.due_date < today) ||
            (t.slot_date !== null && t.slot_date < today)),
      ),
    },
  ]
}

/** One person's lane: who they are, then the three cards, in the order the questions get asked. */
function Lane({
  userId,
  user,
  buckets,
  ticks,
  onToggle,
  onOpenTask,
}: {
  userId: string
  user?: User
  buckets: BucketView[]
  ticks: Set<string>
  onToggle: (user: string, bucket: CheckinBucket, next: boolean) => void
  onOpenTask?: (id: string) => void
}) {
  const walked = buckets.every((b) => ticks.has(`${userId}:${b.id}`))
  return (
    <section
      aria-label={user ? userName(user) : userId}
      className='flex min-w-0 flex-col gap-2 border-r border-border p-2 last:border-r-0'>
      {/* The person, centred and large: the stand-up goes round the room, so whose turn it is should
          be readable from across one. */}
      <header className='flex flex-col items-center gap-1.5 px-2 py-3'>
        <span className='relative'>
          {user ? (
            <Avatar user={user} size='lg' />
          ) : (
            <span className='grid size-12 place-items-center rounded-full bg-bg text-body-sm text-fg-4'>?</span>
          )}
          {walked && (
            <span className='absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full bg-success text-bg'>
              <Check className='size-3' aria-label='Walked' />
            </span>
          )}
        </span>
        <span className='max-w-full truncate text-body-sm font-medium text-text'>
          {user ? userName(user) : userId}
        </span>
      </header>

      {buckets.map((b) => (
        <CheckCard
          key={b.id}
          bucket={b}
          ticked={ticks.has(`${userId}:${b.id}`)}
          onToggle={(next) => onToggle(userId, b.id, next)}
          onOpenTask={onOpenTask}
        />
      ))}
    </section>
  )
}

/**
 * One bucket, as a card you can tick off. Ticked, it collapses to its own header with a check - the
 * point of the gesture is that what remains on screen is what has not been discussed yet.
 *
 * The whole header is the toggle. A stand-up is driven at speed by whoever is talking, and a 16px
 * checkbox is not the target for that; the card says what it is with the cursor and the hover.
 */
function CheckCard({
  bucket,
  ticked,
  onToggle,
  onOpenTask,
}: {
  bucket: BucketView
  ticked: boolean
  onToggle: (next: boolean) => void
  onOpenTask?: (id: string) => void
}) {
  const { icon: Icon, tone, label, tasks, hint } = bucket
  return (
    <article
      className={cn(
        'overflow-hidden rounded-lg border transition-colors',
        ticked ? 'border-border bg-bg/40' : 'border-border bg-surface',
      )}>
      <button
        type='button'
        onClick={() => onToggle(!ticked)}
        aria-pressed={ticked}
        title={hint}
        className={cn(
          'flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors',
          ticked ? 'hover:bg-accent-tint/30' : 'hover:bg-accent-tint/40',
        )}>
        <span
          className={cn(
            'grid size-4 shrink-0 place-items-center rounded border transition-colors',
            ticked ? 'border-success bg-success text-bg' : 'border-border-strong text-transparent',
          )}>
          <Check className='size-3' aria-hidden />
        </span>
        <Icon className={cn('size-3.5 shrink-0', ticked ? 'text-fg-4' : tone)} aria-hidden />
        <span className={cn('min-w-0 truncate text-label font-medium', ticked ? 'text-fg-4' : 'text-text')}>
          {label}
        </span>
        <span className={cn('ml-auto shrink-0 text-label tabular-nums', ticked ? 'text-fg-4' : 'text-muted-foreground')}>
          {tasks.length}
        </span>
      </button>

      {!ticked && (
        <div className='flex flex-col gap-1 px-1.5 pb-1.5'>
          {tasks.length === 0 ? (
            <p className='px-1 py-1 text-label text-fg-4'>Nothing</p>
          ) : (
            // Not draggable: the check-in is a reading of the plan. Planning is where it changes.
            tasks.map((t) => <TaskCard key={t.id} task={t} onOpen={onOpenTask} draggable={false} />)
          )}
        </div>
      )}
    </article>
  )
}
