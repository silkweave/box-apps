// The planning grid's cells - every one of them EDITABLE IN PLACE. Until 2026-08-24 the board's
// optional columns (kind, the two value axes, size/severity, due, tags, dependencies, signals) were
// read-only: seeing that something was unsized meant opening its detail view to fix one enum. That
// is the wrong shape for a board whose whole job is triage across a list.
//
// The rule these follow: **the resting cell still reads as a chip, not as a form.** A grid where
// every cell is a bordered control is unscannable, so the edit affordance is the hover - a borderless
// trigger that picks up a border and a tint when you point at it, and opens the SAME picker the
// detail view uses (one control per dimension, never a second implementation that can drift).
//
// Enums commit on selection through a base-ui Select; the multi-value pickers (tags, dependencies,
// signals) live in a Popover because a chip-input is taller than a row and cannot rest in one.

import { useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Calendar, todayLocal, todayUtc } from '@silkweave/box-ui'
import { DependencyPicker, EffortMeter, KindChip, PriorityStars, TagChips, TagPicker, ValueMeter } from './dimensions.tsx'
import { TaskHours } from './TaskHours.tsx'
import { SignalSelect } from '../../data/components/SignalSelect.tsx'
import { kindLabel, useInitiativeKinds } from '../lib/initiativeKinds.ts'
import {
  DEFAULT_INITIATIVE_KIND,
  VALUE_LEVELS,
  VALUE_META,
  type Initiative,
  type InitiativeKind,
  type PlanningStatus,
  type Priority,
  type ValueLevel,
} from '../planning-types.ts'
import type { Signal } from '../../../types.ts'
import { formatDate, formatNumber } from '../../../lib/format.ts'
import { isDueToday, isOverdue } from '../lib/planningView.ts'
import { rollupEffort } from '../lib/effort.ts'
import { signalLabel, signalLabels } from '../../data/lib/signalLabel.ts'

/**
 * The resting look of an editable cell: no chrome at all until the pointer arrives. `[&>*:last-child]`
 * is the Select's own chevron - hidden at rest for the same reason, since a column of chevrons reads
 * as a form and the hover already says "this changes".
 */
const CELL_TRIGGER = cn(
  'h-auto min-h-6 w-full justify-between gap-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-left',
  'hover:border-border-light hover:bg-accent-tint/40 data-popup-open:border-accent/60',
  '[&>*:last-child]:shrink-0 [&>*:last-child]:opacity-0 hover:[&>*:last-child]:opacity-60 data-popup-open:[&>*:last-child]:opacity-60',
)

/** Same resting look for the popover-backed cells, which have no chevron of their own. */
const CELL_BUTTON = cn(
  'flex min-h-6 w-full items-center gap-1 rounded border border-transparent px-1 py-0.5 text-left',
  'hover:border-border-light hover:bg-accent-tint/40 data-popup-open:border-accent/60',
)

/** "Nothing here" that still reads as a cell - the board's established placeholder. */
const Dot = ({ title }: { title: string }) => (
  <span title={title} className='text-label text-fg-4'>
    ·
  </span>
)

/**
 * Generic enum cell. `T | null` in, `T | ''` out - `''` is how the server clears a flattened enum
 * (see the planning controller's CLEARABLE), so the empty option round-trips rather than being a
 * client-side special case.
 */
function EnumCell<T extends string>({
  value,
  options,
  labelOf,
  onChange,
  render,
  ariaLabel,
  emptyLabel,
}: {
  value: T | null
  options: readonly T[]
  labelOf: (v: T) => string
  onChange: (v: T | '') => void
  render: (v: T | null) => React.ReactNode
  ariaLabel: string
  /** Omit for a non-nullable enum (kind) - then the cell offers no "clear" option. */
  emptyLabel?: string
}) {
  const items = [
    ...(emptyLabel === undefined ? [] : [{ value: '', label: emptyLabel }]),
    ...options.map((o) => ({ value: o as string, label: labelOf(o) })),
  ]
  return (
    <Select
      value={value ?? ''}
      onValueChange={(next) => {
        const v = (next ?? '') as T | ''
        if (v !== (value ?? '')) onChange(v)
      }}
      items={items}>
      <SelectTrigger aria-label={ariaLabel} className={CELL_TRIGGER}>
        <SelectValue>{(v) => <span className='flex min-w-0 flex-1'>{render((v as T) || null)}</span>}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {items.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span className={o.value ? '' : 'text-muted-foreground'}>{o.label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** The lane picker in the grid. Its options are the team's configured kinds - plus this row's own
 *  kind when the list no longer has it, so an orphaned lane stays selectable instead of silently
 *  reading as something else. */
export function KindCell({ value, onChange }: { value: InitiativeKind; onChange: (v: InitiativeKind) => void }) {
  const { data } = useInitiativeKinds()
  const current = value || DEFAULT_INITIATIVE_KIND
  const ids = (data ?? []).map((k) => k.id)
  const options = ids.includes(current) ? ids : [...ids, current]
  return (
    <EnumCell
      value={current}
      options={options}
      labelOf={(k) => kindLabel(k)}
      onChange={(v) => v && onChange(v)}
      render={(v) => <KindChip kind={v ?? DEFAULT_INITIATIVE_KIND} />}
      ariaLabel='Kind'
    />
  )
}

export function ValueCell({
  value,
  hue,
  axis,
  onChange,
}: {
  value: ValueLevel | null
  hue: 'customer' | 'company'
  axis: string
  onChange: (v: ValueLevel | '') => void
}) {
  return (
    <EnumCell
      value={value}
      options={VALUE_LEVELS}
      labelOf={(v) => VALUE_META[v].label}
      onChange={onChange}
      render={(v) => <ValueMeter value={v} hue={hue} axis={axis} />}
      ariaLabel={axis}
      emptyLabel='Not judged'
    />
  )
}

/**
 * An initiative's size - the ONE cell on this grid that is not editable, because there is nothing to
 * edit: it is the sum of its tasks' estimates (`lib/effort.ts`). It resting-looks like a chip and
 * stays one on hover, which is the grid's own way of saying "read this, do not click it".
 */
export function EffortCell({ initiative }: { initiative: Pick<Initiative, 'tasks'> }) {
  return (
    <span className='flex min-h-6 items-center'>
      <EffortMeter rollup={rollupEffort(initiative)} />
    </span>
  )
}

/**
 * A task's estimate in a dense row - the full eight-segment picker, not the card's `4h` menu. A
 * table row is where you go to estimate a batch of tasks, and there the whole point is that setting
 * one costs a single click; the column is sized (148px) to fit the control rather than the control
 * shrunk to fit the column.
 */
export function TaskHoursCell({ value, onChange }: { value: number | null; onChange: (next: number | null) => void }) {
  return (
    <span className='flex min-h-6 items-center'>
      <TaskHours value={value} onChange={onChange} />
    </span>
  )
}

/**
 * Priority as three stars, edited in place - no popover and no select, because a rating IS its own
 * control and one click should be the whole interaction. Clicking the lit star clears it.
 */
export function PriorityCell({ value, onChange }: { value: Priority | null; onChange: (v: Priority | null) => void }) {
  return (
    <span className='flex min-h-6 items-center'>
      <PriorityStars value={value} onChange={onChange} />
    </span>
  )
}

/**
 * A deadline, read as a date - danger tone once it is past AND the work is still open. Clicking it
 * opens the calendar straight away: the text field the detail view uses needs ~12rem, which this
 * column does not have, and in a grid you are picking a day rather than typing an ISO string.
 */
export function DueCell({
  row,
  onChange,
  utc = false,
}: {
  row: { due_date: string | null; status: PlanningStatus }
  onChange: (v: string) => void
  utc?: boolean
}) {
  const [open, setOpen] = useState(false)
  const late = isOverdue(row)
  const today = isDueToday(row)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label='Due date'
        title={
          row.due_date
            ? late
              ? `Overdue: due ${row.due_date}`
              : today
                ? `Due today (${row.due_date})`
                : `Due ${row.due_date}`
            : 'Set a due date'
        }
        className={CELL_BUTTON}>
        {row.due_date ? (
          // Three tones, because a deadline has three readings: past (danger), today (the one that
          // decides your afternoon - amber), and later (just a date).
          <span
            className={cn(
              'text-label tabular-nums',
              late ? 'font-medium text-danger' : today ? 'font-medium text-warning' : 'text-muted-foreground',
            )}>
            {formatDate(row.due_date)}
          </span>
        ) : (
          <Dot title='No due date' />
        )}
      </PopoverTrigger>
      <PopoverContent align='start' sideOffset={6} className='w-auto gap-0 rounded-lg border border-border p-3'>
        <Calendar
          value={row.due_date ?? ''}
          today={utc ? todayUtc() : todayLocal()}
          onPick={(next) => {
            setOpen(false)
            if (next !== (row.due_date ?? '')) onChange(next)
          }}
          onClear={() => {
            setOpen(false)
            if (row.due_date) onChange('')
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export function TagsCell({
  tags,
  suggestions,
  onChange,
  max = 3,
}: {
  tags: string[]
  suggestions: string[]
  onChange: (tags: string[]) => void
  max?: number
}) {
  return (
    <Popover>
      <PopoverTrigger aria-label='Tags' title={tags.length ? tags.join(', ') : 'Add tags'} className={CELL_BUTTON}>
        {tags.length > 0 ? <TagChips tags={tags} max={max} /> : <Dot title='No tags' />}
      </PopoverTrigger>
      <PopoverContent align='start' sideOffset={6} className='w-72 gap-2'>
        <span className='text-label text-muted-foreground'>Tags</span>
        <TagPicker
          value={tags}
          suggestions={suggestions}
          onChange={(next) => next.join(',') !== tags.join(',') && onChange(next)}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The dependency cell reads both directions, because "3 wait on this" is the fact that makes
 * something a foundation and it is invisible from the row's own `blocked_by`. Only the row's own
 * side is editable - the other direction is somebody else's `blocked_by`, and editing it here would
 * be editing a row you are not on.
 */
export function DepsCell({
  initiative,
  all,
  dependents,
  onChange,
}: {
  initiative: Initiative
  all: Initiative[]
  dependents: string[]
  onChange: (ids: string[]) => void
}) {
  const blockedBy = initiative.blocked_by
  return (
    <Popover>
      <PopoverTrigger aria-label='Depends on' title='Edit what this waits on' className={CELL_BUTTON}>
        {blockedBy.length === 0 && dependents.length === 0 ? (
          <span className='text-label text-fg-4'>free-standing</span>
        ) : (
          <span className='flex min-w-0 flex-col gap-0.5 text-label text-muted-foreground'>
            {dependents.length > 0 && (
              <span className='text-accent' title={`Blocks: ${dependents.join(', ')}`}>
                foundation · {dependents.length} wait
              </span>
            )}
            {blockedBy.length > 0 && (
              <span className='truncate' title={`Waits on: ${blockedBy.join(', ')}`}>
                waits on {blockedBy.length}
              </span>
            )}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align='start' sideOffset={6} className='w-96 gap-2'>
        <span className='text-label text-muted-foreground'>Waits on</span>
        <DependencyPicker
          value={blockedBy}
          initiatives={all}
          selfId={initiative.id}
          onChange={(ids) => ids.join(',') !== blockedBy.join(',') && onChange(ids)}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * Signal bindings + a compact target progress bar (mirrors the detail view's TargetBar math). The
 * popover edits the BINDINGS; the target itself stays on the detail view, where its baseline and
 * by-date have room to be a form rather than three cramped fields in a 200px column.
 */
export function SignalCell({
  initiative,
  signalById,
  onChange,
}: {
  initiative: Initiative
  signalById: Map<string, Signal>
  onChange: (ids: string[]) => void
}) {
  const target = initiative.target
  const signal = target ? signalById.get(target.signal_id) : undefined
  const current = target ? (signal ? (signal.points[signal.points.length - 1]?.value ?? 0) : (target.baseline ?? 0)) : 0
  const baseline = target?.baseline ?? 0
  const span = target ? target.value - baseline : 0
  const pct = !target || span <= 0 ? 0 : Math.max(0, Math.min(1, (current - baseline) / span))

  return (
    <Popover>
      <PopoverTrigger aria-label='Signals this drives' title='Edit the signals this drives' className={CELL_BUTTON}>
        {target ? (
          <span className='min-w-0 flex-1'>
            <span className='flex items-baseline justify-between gap-1 text-label text-muted-foreground tabular-nums'>
              <span className='truncate' title={target.signal_id}>
                {signalLabel(signalById, target.signal_id)}
              </span>
              <span className='shrink-0'>
                {formatNumber(current)}/{formatNumber(target.value)}
              </span>
            </span>
            <span className='mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-accent-tint'>
              <span className='block h-full rounded-full bg-accent' style={{ width: `${Math.round(pct * 100)}%` }} />
            </span>
          </span>
        ) : (
          <span className='flex min-w-0 flex-1 items-center gap-1.5 truncate text-label text-muted-foreground'>
            <BarChart3 className='size-3.5 shrink-0' />
            <span className='truncate' title={initiative.signal_ids.join(' · ')}>
              {signalLabels(signalById, initiative.signal_ids) || 'no signal'}
            </span>
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent align='start' sideOffset={6} className='w-96 gap-2'>
        <span className='text-label text-muted-foreground'>Signals (drives)</span>
        <SignalSelect
          value={initiative.signal_ids}
          onChange={(ids) => ids.join(',') !== initiative.signal_ids.join(',') && onChange(ids)}
        />
      </PopoverContent>
    </Popover>
  )
}
