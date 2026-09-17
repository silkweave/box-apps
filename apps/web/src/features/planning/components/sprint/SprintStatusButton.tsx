// The sprint's health, as one icon in the top bar.
//
// It replaced a banner above the calendar (2026-09-07). The banner was honest but it was always
// there, and it spent a full row of the surface saying "every day fits" - which is the case you
// never need told. Worse, a standing box trains the eye to skip it, and the box it trains you to
// skip is the one the OVER warning appears in.
//
// So: a traffic light you can read at a glance, and the detail behind a click. The three states are
// the three the capacity check already distinguishes, and the ORDER of severity is the design call
// the check itself rests on (features/planning/SPEC.md):
//
//   • RED    - a day is provably over capacity. This is the only state with teeth; it is what the
//              server refuses `planned` on, so it is the only one that blocks anything.
//   • ORANGE - soft findings. Days that look light, slotted tasks with no size, and (new here)
//              people on the sprint holding nothing at all. None of these are wrong; each is worth
//              a look before you call the sprint planned.
//   • GREEN  - nothing to fix, so the popover spends its space on the summary instead: what the
//              sprint holds, what it costs, and how much of the roster's time that is.
//
// It computes NO capacity. `sprintGet` returns `loads` and `check` already derived from the band
// arithmetic in `planning/sprints.ts`, and re-deriving a band in the SPA is how the two ends drift.
// What it does do is COUNT - tasks, people, hours - which is addition over what the server sent.

import { AlertTriangle, CheckCircle2, CircleHelp, Info, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@silkweave/box-ui'
import { capacityOn, datesBetween, formatDay, formatHours, type DayLoad, type SprintDetail } from '../../sprint-types.ts'
import { rosterOf } from './SprintGrid.tsx'
import { userName, type User } from '../../../../user-types.ts'

/** How many offending days each line names before it gives up and counts the rest. */
const NAMED = 3

type Tone = 'ok' | 'warn' | 'error'

const TONE: Record<Tone, { icon: typeof CheckCircle2; label: string; trigger: string; text: string }> = {
  ok: {
    icon: CheckCircle2,
    label: 'Every day fits',
    trigger: 'text-success hover:bg-success-bg',
    text: 'text-success',
  },
  warn: {
    icon: AlertTriangle,
    label: 'Worth a look before this sprint is planned',
    trigger: 'text-warning hover:bg-warning-bg',
    text: 'text-warning',
  },
  error: {
    icon: TriangleAlert,
    label: 'Over capacity - this blocks Planned',
    trigger: 'text-danger hover:bg-danger-bg',
    text: 'text-danger',
  },
}

export function SprintStatusButton({ sprint, users }: { sprint: SprintDetail; users: User[] }) {
  const { check } = sprint
  const who = (id: string): string => {
    const u = users.find((x) => x.id === id)
    return u ? u.nickname || userName(u) : id
  }
  const name = (l: DayLoad): string => `${who(l.user)} on ${formatDay(l.date)}`

  const dates = datesBetween(sprint.start_date, sprint.end_date)
  const roster = rosterOf(sprint)
  const slotted = sprint.tasks.filter((t) => t.slot_date)
  // Capacity is a plain sum over what the server already resolved per person-day.
  const capacity = roster.reduce(
    (total, id) => total + dates.reduce((n, d) => n + capacityOn(d, sprint.availability?.[id]), 0),
    0,
  )
  // Booked work is a plain sum of the estimates the server already resolved per person-day.
  const booked = sprint.loads.reduce((n, l) => n + l.planned, 0)
  const idle = roster.filter((id) => !slotted.some((t) => t.assignee === id))

  const problems: { key: string; icon: typeof Info; text: string }[] = []
  if (check.over.length > 0) {
    problems.push({
      key: 'over',
      icon: TriangleAlert,
      text: `${check.over.length} day${check.over.length === 1 ? '' : 's'} over capacity - ${list(
        check.over.map((l) => `${name(l)} (${formatHours(l.planned)} against ${l.hours}h)`),
      )}. This blocks Planned.`,
    })
  }

  const warnings: { key: string; icon: typeof Info; text: string }[] = []
  if (check.unsized.length > 0) {
    const total = check.unsized.reduce((n, l) => n + l.unsized, 0)
    warnings.push({
      key: 'unsized',
      icon: CircleHelp,
      text: `${total} slotted task${total === 1 ? '' : 's'} with no estimate - ${list(
        check.unsized.map((l) => name(l)),
      )}. They count towards no hours, so those days read lighter than they are.`,
    })
  }
  if (check.under.length > 0) {
    warnings.push({
      key: 'under',
      icon: Info,
      text: `${check.under.length} day${check.under.length === 1 ? ' looks' : 's look'} light - ${list(
        check.under.map((l) => `${name(l)} (${formatHours(l.planned)} against ${l.hours}h)`),
      )}.`,
    })
  }
  if (idle.length > 0) {
    warnings.push({
      key: 'idle',
      icon: Info,
      text: `${list(idle.map(who))} ${idle.length === 1 ? 'is' : 'are'} on this sprint with nothing slotted.`,
    })
  }

  const tone: Tone = problems.length > 0 ? 'error' : warnings.length > 0 ? 'warn' : 'ok'
  const meta = TONE[tone]
  const Icon = meta.icon

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Sprint status: ${meta.label}`}
        title={meta.label}
        className={cn(
          'inline-flex size-8 items-center justify-center rounded-md transition-colors outline-none',
          meta.trigger,
        )}>
        <Icon className='size-4' />
      </PopoverTrigger>
      <PopoverContent align='end' sideOffset={6} className='w-80 gap-0 rounded-lg border border-border p-3'>
        <p className={cn('mb-2 flex items-center gap-1.5 text-body-sm font-medium', meta.text)}>
          <Icon className='size-4 shrink-0' />
          {meta.label}
        </p>

        {[...problems, ...warnings].length > 0 && (
          <ul className='mb-2 flex flex-col gap-1.5'>
            {problems.map(({ key, icon: LineIcon, text }) => (
              <li key={key} className='flex items-start gap-1.5 text-body-sm text-muted-foreground'>
                <LineIcon className='mt-0.5 size-3.5 shrink-0 text-danger' />
                <span>{text}</span>
              </li>
            ))}
            {warnings.map(({ key, icon: LineIcon, text }) => (
              <li key={key} className='flex items-start gap-1.5 text-body-sm text-muted-foreground'>
                <LineIcon className='mt-0.5 size-3.5 shrink-0 text-warning' />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        )}

        {/* The summary is shown in every state, not just the green one: when something IS wrong, the
            size of the sprint is the context you need to judge how wrong. */}
        <dl className='flex flex-col gap-1 border-t border-border pt-2 text-body-sm'>
          <Row label='Window'>
            {dates.length > 0
              ? `${formatDay(sprint.start_date as string)} - ${formatDay(sprint.end_date as string)}`
              : 'Not set'}
          </Row>
          <Row label='On the sprint'>
            {roster.length} {roster.length === 1 ? 'person' : 'people'}
          </Row>
          <Row label='Tasks on a day'>{slotted.length}</Row>
          <Row label='Capacity'>{capacity}h</Row>
          <Row label='Booked'>
            {formatHours(booked)}
            {capacity > 0 && <span className='ml-1 text-fg-4'>({Math.round((booked / capacity) * 100)}%)</span>}
          </Row>
        </dl>
      </PopoverContent>
    </Popover>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex items-baseline justify-between gap-3'>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd className='tabular-nums text-text'>{children}</dd>
    </div>
  )
}

/** `a, b, c and 4 more` - the server names three too, and the two should read the same. */
function list(items: string[]): string {
  const head = items.slice(0, NAMED).join(', ')
  return items.length > NAMED ? `${head} and ${items.length - NAMED} more` : head
}
