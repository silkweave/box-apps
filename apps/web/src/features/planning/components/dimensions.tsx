// The chips and pickers for the planning dimensions - customer value, company value, size, priority,
// tags, dependencies. One file because they are one design decision: each dimension is a
// short enum rendered as a single glyph-width chip, so three of them fit in one grid cell instead of
// eating three columns. Free text lives in `tags` alone.

import { Combobox } from '@base-ui/react/combobox'
import { Check, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ChipList,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  groupCls,
  itemCls,
  popupCls,
} from '@silkweave/box-ui'
export { TagPicker } from '@/lib/tags.tsx'
import {
  EFFORT_HINT,
  EFFORT_META,
  EFFORT_RANK,
  PRIORITIES,
  PRIORITY_LABEL,
  VALUE_LEVELS,
  VALUE_META,
  VALUE_RANK,
  type Initiative,
  type InitiativeKind,
  type Priority,
  type ValueLevel,
} from '../planning-types.ts'
import { formatHours, type EffortRollup } from '../lib/effort.ts'
import { kindIcon, kindLabel, useInitiativeKinds } from '../lib/initiativeKinds.ts'
import { presetIcon } from '../../data/components/board/presetIcons.tsx'

// --- chips -----------------------------------------------------------------------------------

/** Placeholder for a dimension nobody has judged yet - readable as "empty", not as "low". */
const Unset = ({ title }: { title: string }) => (
  <span title={title} className='inline-flex h-4 items-center px-1 text-[0.6875rem] leading-none text-fg-4'>
    ·
  </span>
)

// --- dimension meters --------------------------------------------------------------------------

/** Fill color per column. The HUE says which dimension; the fill COUNT says how much of it. */
const METER_FILL: Record<'customer' | 'company' | 'size', string> = {
  customer: 'bg-warning',
  company: 'bg-accent',
  // Size is a cost, not a virtue - it reads as a neutral quantity rather than a good/bad measure.
  size: 'bg-fg-3',
}

/**
 * A segmented meter: `filled` of `segments` lit, the text label beneath. Deliberately not a
 * percentage bar - these are short ordinal enums, and a bar would invent precision the scale
 * does not have.
 */
function DimensionMeter({
  segments,
  filled,
  hue,
  label,
  title,
  tone = 'set',
}: {
  segments: number
  filled: number
  hue: keyof typeof METER_FILL
  label: string
  title: string
  /** `partial` draws the lit segments hollow - the value is known to be incomplete. */
  tone?: 'set' | 'partial'
}) {
  const lit = tone === 'partial' ? cn('bg-transparent ring-1 ring-inset', RING[hue]) : METER_FILL[hue]
  return (
    <span className='flex min-w-0 flex-col gap-1 rounded px-1 py-0.5' title={title}>
      <span className='flex items-center gap-0.5' aria-hidden='true'>
        {Array.from({ length: segments }, (_, i) => (
          <span key={i} className={cn('h-2.5 w-2 rounded-[2px]', i < filled ? lit : 'bg-border-light')} />
        ))}
      </span>
      <span className='truncate text-[0.6875rem] leading-none text-muted-foreground'>{label}</span>
    </span>
  )
}

/** Outline colour for a hollow (partial) segment - the same hue the filled one would use. */
const RING: Record<'customer' | 'company' | 'size', string> = {
  customer: 'ring-warning',
  company: 'ring-accent',
  size: 'ring-fg-3',
}

/**
 * One value axis as a 3-segment meter. The segments are the POSITIVE scale (low/med/high), so the
 * two empty states stay distinct and are never quietly folded onto a segment: `none` ("we looked,
 * it is zero") lights nothing and says so; `null` (not yet judged) renders the muted placeholder
 * and no meter at all.
 */
export function ValueMeter({
  value,
  hue,
  axis,
}: {
  value: ValueLevel | null
  hue: 'customer' | 'company'
  axis: string
}) {
  if (!value) return <Unset title={`${axis} not judged`} />
  return (
    <DimensionMeter
      segments={3}
      filled={VALUE_RANK[value]}
      hue={hue}
      label={VALUE_META[value].label}
      title={`${axis}: ${VALUE_META[value].label}`}
    />
  )
}

/**
 * An initiative's size as a 4-segment meter (SM · MD · LG · XL) over the summed hours of its tasks.
 * It is READ-ONLY by construction - there is no hand-set initiative size left for it to display, so
 * the only thing the meter can say is what the work underneath adds up to.
 *
 * The hollow state is the honest one: a sum taken over a half-estimated list is a FLOOR, not a
 * total, so the `+` on the label and the tooltip both say how many tasks are missing from it.
 */
export function EffortMeter({ rollup }: { rollup: EffortRollup }) {
  const { hours, tier, unsized, counted } = rollup
  if (hours === null || tier === null)
    return <Unset title={counted === 0 ? 'No tasks yet' : `Not estimated - none of its ${counted} tasks carry an estimate`} />
  const partial = unsized > 0
  const title =
    `Size: ${formatHours(hours)} (${EFFORT_META[tier].label} - ${EFFORT_HINT[tier]})` +
    (partial
      ? ` · summed over ${counted - unsized} of ${counted} tasks - ${unsized} carry no estimate, so this is a floor`
      : ` · summed over all ${counted} tasks`)
  return (
    <DimensionMeter
      segments={4}
      filled={EFFORT_RANK[tier]}
      hue='size'
      label={partial ? `${formatHours(hours)}+` : formatHours(hours)}
      title={title}
      tone={partial ? 'partial' : 'set'}
    />
  )
}

/**
 * The 1-3 star rating. Clicking a star sets that rating; clicking the star that is already the
 * rating CLEARS it, which is the only unset gesture a star row has room for (and the one every
 * star widget on the web has taught people to expect).
 */
export function PriorityStars({
  value,
  onChange,
  ariaLabel = 'Priority',
  readonly = false,
  className,
}: {
  value: Priority | null
  onChange?: (next: Priority | null) => void
  ariaLabel?: string
  readonly?: boolean
  className?: string
}) {
  const label = value ? `${PRIORITY_LABEL[value]} priority` : 'No priority'
  if (readonly)
    return (
      <span className={cn('flex items-center gap-0.5', className)} title={label} aria-label={label}>
        {PRIORITIES.map((n) => (
          <Star key={n} className={cn('size-3.5', value && n <= value ? 'fill-warning text-warning' : 'text-border-light')} />
        ))}
      </span>
    )
  return (
    <span
      role='group'
      aria-label={ariaLabel}
      title={`${label} - click a star to set it, click it again to clear`}
      className={cn('group/stars flex items-center gap-0.5', className)}>
      {PRIORITIES.map((n) => (
        <button
          key={n}
          type='button'
          aria-label={`${PRIORITY_LABEL[n]} priority`}
          aria-pressed={value === n}
          onClick={() => onChange?.(value === n ? null : n)}
          // The hover lights every star UP TO the one under the pointer, which is how a star row
          // says "click here and you get this many" - a per-star hover would only ever light one.
          className='group/star cursor-pointer rounded p-0.5 transition-transform hover:scale-110'>
          <Star
            className={cn(
              'size-3.5 transition-colors',
              value && n <= value ? 'fill-warning text-warning' : 'text-border-light',
              'group-hover/stars:[&]:text-warning/60',
            )}
          />
        </button>
      ))}
    </span>
  )
}

export function KindChip({ kind }: { kind: InitiativeKind }) {
  // Subscribed, not just peeked: a relabel or a new icon in Settings has to repaint every chip
  // already on screen.
  useInitiativeKinds()
  const label = kindLabel(kind)
  const Icon = presetIcon(kindIcon(kind))
  return (
    <span className='flex min-w-0 items-center gap-1.5 text-label text-muted-foreground' title={label}>
      <Icon className='size-3.5 shrink-0' />
      <span className='truncate'>{label}</span>
    </span>
  )
}

/** Tags as a wrapping row of small pills; `max` truncates with a +n overflow marker. */
export function TagChips({ tags, max = 3 }: { tags: string[]; max?: number }) {
  if (tags.length === 0) return null
  const shown = tags.slice(0, max)
  const rest = tags.length - shown.length
  return (
    <span className='flex min-w-0 flex-wrap items-center gap-1'>
      {shown.map((t) => (
        <span key={t} className='truncate rounded bg-[var(--bg-code)] px-1 text-[0.6875rem] leading-4 text-muted-foreground'>
          {t}
        </span>
      ))}
      {rest > 0 && (
        <span title={tags.join(', ')} className='text-[0.6875rem] leading-4 text-fg-4'>
          +{rest}
        </span>
      )}
    </span>
  )
}

// --- enum pickers ----------------------------------------------------------------------------

/**
 * Generic nullable-enum select. The stored value is `T | null`; the empty option round-trips as ''
 * because that is how the server says "clear it" (see the planning controller's CLEARABLE).
 */
function EnumSelect<T extends string>({
  value,
  options,
  labelOf,
  onChange,
  ariaLabel,
  emptyLabel,
  className,
}: {
  value: T | null
  options: T[]
  labelOf: (v: T) => string
  onChange: (v: T | '') => void
  ariaLabel: string
  emptyLabel: string
  className?: string
}) {
  const items = [{ value: '', label: emptyLabel }, ...options.map((o) => ({ value: o, label: labelOf(o) }))]
  return (
    <Select
      value={value ?? ''}
      onValueChange={(next) => onChange(next as T | '')}
      items={items}>
      <SelectTrigger aria-label={ariaLabel} className={className}>
        <SelectValue>{(v) => <span className={v ? '' : 'text-muted-foreground'}>{v ? labelOf(v as T) : emptyLabel}</span>}</SelectValue>
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

export function ValueSelect({
  value,
  onChange,
  ariaLabel,
  className,
}: {
  value: ValueLevel | null
  onChange: (v: ValueLevel | '') => void
  ariaLabel: string
  className?: string
}) {
  return (
    <EnumSelect
      value={value}
      options={VALUE_LEVELS}
      labelOf={(v) => VALUE_META[v].label}
      onChange={onChange}
      ariaLabel={ariaLabel}
      emptyLabel='Not judged'
      className={className}
    />
  )
}

// There is no size PICKER any more, on either scale: a task's estimate is `TaskHours.tsx`, and an
// initiative's size is arithmetic over those, so the only size control left is the read-only meter.

export function KindSelect({
  value,
  onChange,
  className,
}: {
  value: InitiativeKind
  onChange: (v: InitiativeKind) => void
  className?: string
}) {
  const { data } = useInitiativeKinds()
  // The row's own kind is always offered, even if the team has since deleted that lane - a select
  // whose value is not among its items renders empty, which reads as "this initiative has no kind".
  const ids = (data ?? []).map((k) => k.id)
  const options = value && !ids.includes(value) ? [...ids, value] : ids
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as InitiativeKind)}
      items={options.map((k) => ({ value: k, label: kindLabel(k) }))}>
      <SelectTrigger aria-label='Kind' className={className}>
        <SelectValue>{(v) => <KindChip kind={String(v)} />}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((k) => (
          <SelectItem key={k} value={k}>
            <KindChip kind={k} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// --- multi-select pickers --------------------------------------------------------------------
// Shared classes mirror SignalSelect so every chip picker in the app reads the same.

/**
 * "Depends on" picker over the other initiatives. Excludes self; the server refuses cycles and
 * unknown ids, and surfaces the reason, so this stays a plain picker rather than re-deriving the
 * reachable set client-side.
 */
export function DependencyPicker({
  value,
  onChange,
  initiatives,
  selfId,
}: {
  value: string[]
  onChange: (ids: string[]) => void
  initiatives: Initiative[]
  selfId: string
}) {
  const { contains } = Combobox.useFilter()
  const candidates = initiatives.filter((i) => i.id !== selfId)
  const titleOf = new Map(initiatives.map((i) => [i.id, i.title]))
  const options = candidates.map((i) => i.id)
  const label = (id: string) => titleOf.get(id) ?? id
  return (
    <Combobox.Root
      items={options}
      multiple
      value={value}
      onValueChange={(next: string[]) => onChange(next)}
      filter={(item: string, query) => contains(label(item), query) || contains(item, query)}>
      <Combobox.Chips className={groupCls}>
        <Combobox.Value>
          {(vals: string[]) => <ChipList values={vals} placeholder='waits on…' labelOf={label} />}
        </Combobox.Value>
      </Combobox.Chips>
      <Combobox.Portal>
        <Combobox.Positioner className='isolate z-60 outline-none' sideOffset={6}>
          <Combobox.Popup className={popupCls}>
            <Combobox.Empty className='px-2 py-2 text-body-sm text-muted-foreground'>No matching initiative.</Combobox.Empty>
            <Combobox.List>
              {(option: string) => (
                <Combobox.Item key={option} value={option} className={itemCls}>
                  <Combobox.ItemIndicator className='col-start-1 text-accent'>
                    <Check className='size-3.5' />
                  </Combobox.ItemIndicator>
                  <span className='col-start-2 flex min-w-0 flex-col'>
                    <span className='truncate'>{label(option)}</span>
                    <span className='truncate text-label text-muted-foreground'>{option}</span>
                  </span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
}
