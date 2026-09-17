import { useState } from 'react'
import { Sparkline } from '@silkweave/box-ui/charts'
import type { Signal } from '../../../types.ts'
import { computeDelta, formatBucket, formatDelta, formatNumber } from '../../../lib/format.ts'
import { healthLook, targetProgress } from '../lib/signalHealth.ts'
import { swatchClass, userSwatch } from '@silkweave/box-ui/lib'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { UserChip } from '@silkweave/box-ui'
import { cn } from '@/lib/utils'

/**
 * The sparkline's window. A card is a glanceable "which way is this going lately", not an archive:
 * a daily signal a year or two old carries hundreds of buckets, and at card width that renders as a
 * solid block of ink with no readable trend at all. Thirty days is the same window the detail page defaults its
 * 30D toggle to, so the two agree.
 *
 * The headline number and the delta are NOT windowed - they are the last complete bucket and the
 * one before it, which is what the card claims they are either way.
 */
const SPARK_DAYS = 30
/** Floor for coarse grains: a weekly or monthly signal can have 1-4 buckets inside 30 days, and a
 *  sparkline of one point is a dot. Fall back to trailing buckets rather than render nothing. */
const SPARK_MIN_POINTS = 10

function sparkWindow<T extends { date: string }>(points: T[]): T[] {
  if (points.length === 0) return points
  const cutoff = new Date(Date.now() - SPARK_DAYS * 86_400_000).toISOString().slice(0, 10)
  const recent = points.filter((p) => p.date.slice(0, 10) >= cutoff)
  return recent.length >= SPARK_MIN_POINTS ? recent : points.slice(-SPARK_MIN_POINTS)
}

export function SignalCard({ signal }: { signal: Signal }) {
  // A registered-but-data-less signal (e.g. `mrr` before Stripe exists) has points: [] - every
  // read below must survive that, rendering an honest empty card rather than crashing.
  //
  // The headline shows the number appropriate to the KIND. For a snapshot signal the last point
  // is the level - correct. For an increment signal the last point is the in-progress bucket
  // ("today so far" on a day-grain signal) - a misleading headline; the server zero-fills
  // increment signal through the current bucket, so the last point is ALWAYS the partial one and
  // the card defaults to the last COMPLETE bucket (yesterday, for day grain). The delta compares
  // the two last complete buckets for the same reason. Hover still scrubs every bucket.
  const isIncrement = signal.accumulation === 'increment'
  const complete = isIncrement && signal.points.length > 0 ? signal.points.slice(0, -1) : signal.points
  const latest: (typeof signal.points)[number] | null = complete[complete.length - 1] ?? null
  const delta = computeDelta(complete)
  // Only the CHART is windowed (see sparkWindow). Hover scrubbing therefore indexes into the same
  // windowed array - reading `signal.points[hoverIdx]` here would scrub to the wrong bucket.
  const spark = sparkWindow(signal.points)

  // The owner's swatch tints the card + colors the sparkline, so mixed-account grids parse at a
  // glance. Identity is never color-alone - the avatar + name chip sits top-right.
  const { data: users } = useUsersData()
  const owner = signal.owner ? users?.find((u) => u.id === signal.owner) : null
  const swatch = userSwatch(owner)

  // Hovering the sparkline scrubs the card's headline + date to that point (no floating
  // tooltip); leaving the chart snaps back to the latest value.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const active = (hoverIdx != null ? spark[hoverIdx] : null) ?? latest
  const look = healthLook(signal.health)
  const progress = targetProgress(signal, latest?.value ?? null)

  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm) transition-colors hover:border-accent/40',
        swatch && cn(swatchClass(swatch), 'swatch-card'),
      )}>
      <div className='flex items-start justify-between gap-2'>
        {/* Fixed two-line title box so every card is the same height: one-line titles pad down,
            three-plus-line titles clamp with an ellipsis (full label in the tooltip). */}
        <span className='line-clamp-2 min-h-[2lh] text-body-sm text-muted-foreground' title={signal.label}>
          {/* Health is server-computed (core signalHealth) and only shows where it means something:
              a signal with no target has nothing to be on track for, so it gets no dot. */}
          {signal.target && (
            <span
              aria-label={look.label}
              title={`${look.label}: ${look.hint}`}
              className='mr-1.5 inline-block size-2 rounded-full align-middle'
              style={{ background: look.color }}
            />
          )}
          {signal.label}
        </span>
        <UserChip userId={signal.owner} showName />
      </div>

      <div className='font-serif text-display-lg tabular-nums leading-none text-text'>
        {active ? formatNumber(active.value) : <span className='text-muted-foreground'>-</span>}
        {active && signal.unit ? <span className='ml-1 text-body-sm text-muted-foreground'>{signal.unit}</span> : null}
      </div>

      {/* The owner's swatch colours the line so mixed-account grids parse at a glance; identity is
          never colour-alone - the avatar chip sits top right. Hovering scrubs the headline above
          rather than floating a tooltip over it. */}
      <div className='-mx-1 mt-1' title={`Trend over the last ${SPARK_DAYS} days`}>
        <Sparkline points={spark} color='var(--swatch, var(--chart-1))' onHoverIndex={setHoverIdx} />
      </div>

      {progress && (
        <div className={cn('flex items-center justify-between gap-2 text-label tabular-nums', look.tone)} title={look.hint}>
          <span>{progress}</span>
          <span>{look.label}</span>
        </div>
      )}

      <div className='flex items-center justify-between gap-2 text-label text-muted-foreground tabular-nums'>
        <span title={isIncrement && hoverIdx == null && active ? 'Last complete bucket - the newest bucket is still filling' : undefined}>
          {active ? formatBucket(active.date) : 'no data yet'}
        </span>
        {delta ? (
          <span
            className={cn(
              'text-label tabular-nums whitespace-nowrap',
              delta.dir === 'up' && 'text-success',
              delta.dir === 'down' && 'text-danger',
              delta.dir === 'flat' && 'text-muted-foreground',
            )}>
            {delta.dir === 'up' ? '▲' : delta.dir === 'down' ? '▼' : '–'} {formatDelta(delta)}
          </span>
        ) : (
          <span className='text-label text-muted-foreground' title='Trend appears once a second daily snapshot exists'>
            {signal.points.length === 0 ? '' : 'baseline'}
          </span>
        )}
      </div>
    </div>
  )
}
