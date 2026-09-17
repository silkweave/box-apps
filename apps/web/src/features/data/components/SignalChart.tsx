// A signal's trend on its detail page: the headline reading, the change over the chosen window, and
// the plot.
//
// The DRAWING is `@silkweave/box-ui/charts`' TimeSeriesChart. What stays here is everything a chart
// is not allowed to know: that a signal has a unit and points, which windows this Box offers, and
// the sentence that reads the delta out ("+184 (12.4%) over 30D"). The library plots numbers; the
// vocabulary of a measure belongs to the feature that owns it.

import { useState } from 'react'
import { TimeSeriesChart, DEFAULT_TIME_RANGES, rangesFor, windowPoints } from '@silkweave/box-ui/charts'
import type { Signal } from '../../../types.ts'
import { formatBucket, formatNumber } from '../../../lib/format.ts'
import { cn } from '@/lib/utils'

export function SignalChart({ signal }: { signal: Signal }) {
  const points = [...signal.points].sort((a, b) => a.date.localeCompare(b.date))

  // Only the presets the data can fill; 'All' is always one of them.
  const ranges = rangesFor(points, DEFAULT_TIME_RANGES)
  const [range, setRange] = useState('all')
  const active = ranges.find((r) => r.id === range) ?? ranges[ranges.length - 1] ?? null

  // The headline reads the SAME window the plot draws, so the delta and the shape agree.
  const windowed = windowPoints(points, active)
  const first = windowed[0]
  const last = windowed[windowed.length - 1]
  const delta = first && last ? last.value - first.value : 0
  const pct = first && first.value !== 0 ? (delta / first.value) * 100 : null
  const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'

  return (
    <TimeSeriesChart
      points={points}
      unit={signal.unit ?? undefined}
      formatValue={formatNumber}
      formatTick={formatBucket}
      formatTooltipDate={(d) => d}
      ranges={ranges}
      range={active?.id ?? 'all'}
      onRangeChange={setRange}
      header={
        <div>
          <div className='font-serif text-display-lg tabular-nums leading-none text-text'>
            {last ? formatNumber(last.value) : '-'}
            {signal.unit ? <span className='ml-1 text-body-sm text-muted-foreground'>{signal.unit}</span> : null}
          </div>
          <div className='mt-1.5 flex items-center gap-2 text-label'>
            <span
              className={cn(
                'tabular-nums',
                dir === 'up' && 'text-success',
                dir === 'down' && 'text-danger',
                dir === 'flat' && 'text-muted-foreground',
              )}>
              {dir === 'up' ? '▲' : dir === 'down' ? '▼' : '–'} {delta >= 0 ? '+' : ''}
              {formatNumber(delta)}
              {pct == null ? '' : ` (${delta >= 0 ? '+' : ''}${pct.toFixed(1)}%)`}
            </span>
            <span className='text-muted-foreground'>over {active?.label === 'All' ? 'all time' : active?.label}</span>
          </div>
        </div>
      }
    />
  )
}
