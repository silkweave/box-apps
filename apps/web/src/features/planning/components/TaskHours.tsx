// The task estimate control - hours, 1-8, in the two sizes the app needs.
//
// Estimating is the step everyone skips, so the control is built to cost ONE click. The default
// size is a four-segment picker: every value on the scale is its own target, so setting "3h" is one
// click rather than open-menu-then-pick, and clicking the segment that is already the value clears
// it - the only unset gesture a row of segments has room for, and the one `PriorityStars` already
// taught here. It is used wherever a row has ~100px to spare, the task list included.
//
// `small` is for a card, where four targets still will not fit. It renders as `3h` / `4h+` and
// opens a menu.
//
// **The scale stops at `4+` on purpose.** A task longer than half a day should be SPLIT, not
// estimated, and a picker that offers 8 invites the estimate instead of the split. A stored value
// above 4 (the old `xl` bucket backfilled 8s) still sums as itself and reads as `4h+` here.

import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@silkweave/box-ui'
import { TASK_HOURS, TOP_TASK_HOURS, taskHoursLabel } from '../planning-types.ts'

/** What an unestimated task shows. Warning-toned: it contributes nothing to any day's capacity. */
const UNSET_LABEL = 'N/A'

export function TaskHours({
  value,
  onChange,
  size = 'default',
  readonly = false,
  className,
  triggerClassName,
}: {
  value: number | null
  /** `null` clears the estimate. */
  onChange?: (next: number | null) => void
  size?: 'default' | 'small'
  readonly?: boolean
  className?: string
  /** Only used by `small` - the trigger's own classes, so a card can hand it its control style. */
  triggerClassName?: string
}) {
  const title = value ? `Estimate: ${taskHoursLabel(value)}` : 'Not estimated - contributes nothing to a day of capacity'

  if (size === 'small') {
    const face = (v: number | null) => (
      <span className={cn('font-mono tabular-nums', v ? 'text-muted-foreground' : 'text-warning')}>
        {v ? taskHoursLabel(v) : UNSET_LABEL}
      </span>
    )
    if (readonly || !onChange) return <span className={cn(triggerClassName, 'inline-flex items-center')}>{face(value)}</span>
    return (
      <Select
        value={value === null ? '' : String(Math.min(value, TOP_TASK_HOURS))}
        onValueChange={(next) => {
          const v = String(next) === '' ? null : Number(next)
          if (v !== value) onChange(v)
        }}
        items={[{ value: '', label: UNSET_LABEL }, ...TASK_HOURS.map((h) => ({ value: String(h), label: taskHoursLabel(h) }))]}>
        <SelectTrigger aria-label='Estimate' title={title} className={triggerClassName}>
          <SelectValue>{(v) => face(v ? Number(v) : null)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value=''>
            <span className='text-muted-foreground'>{UNSET_LABEL} · not estimated</span>
          </SelectItem>
          {TASK_HOURS.map((h) => (
            <SelectItem key={h} value={String(h)}>
              {taskHoursLabel(h)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  }

  return (
    <span
      role='group'
      aria-label='Estimate in hours'
      title={
        readonly || !onChange ? title : `${title} - click an hour to set it, click it again to clear`
      }
      className={cn(SEGMENT_ROW, className)}>
      {TASK_HOURS.map((h) =>
        readonly || !onChange ? (
          <Segment key={h} hours={h} lit={!!value && h <= value} />
        ) : (
          <button
            key={h}
            type='button'
            aria-label={taskHoursLabel(h)}
            aria-pressed={value === h}
            onClick={() => onChange(value === h ? null : h)}
            className='cursor-pointer'>
            <Segment hours={h} lit={!!value && h <= value} interactive />
          </button>
        ),
      )}
    </span>
  )
}

/**
 * The segments are ONE control, not four chips: a single rounded box with hairline rules between
 * the steps, so the row reads as a scale you are picking a point on. Everything up to and including
 * the estimate lights, the way a rating does - the filled run IS the quantity, and a single lit box
 * in the middle of three empty ones reads as a selected option rather than as a size.
 */
const SEGMENT_ROW = 'inline-flex w-fit items-center divide-x divide-border overflow-hidden rounded-md border border-border bg-bg'

/** One step: 24x32, the app's control height, divided from the previous by a hairline not a gap. */
function Segment({ hours, lit, interactive = false }: { hours: number; lit: boolean; interactive?: boolean }) {
  return (
    <span
      className={cn(
        'flex h-8 w-6 items-center justify-center text-label leading-none tabular-nums transition-colors',
        lit ? 'bg-accent font-medium text-accent-fg' : 'text-muted-foreground',
        interactive && !lit && 'hover:bg-accent-tint hover:text-text',
      )}>
      {hours}
    </span>
  )
}
