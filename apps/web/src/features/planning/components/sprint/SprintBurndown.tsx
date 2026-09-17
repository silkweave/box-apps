// The sprint's burndown - estimated hours left, day by day, against the line the plan implies.
//
// **The SPA computes none of it.** `sprintGet` returns `burndown` already derived in
// `planning/sprints.ts` (and tested there), for the same reason the capacity grid is derived on the
// server: two ends deriving the same number is how they come to disagree, and a wrong number still
// renders. What lives here is the drawing and the one sentence of interpretation.
//
// Three things the shape of the data makes true, and the chart has to say honestly:
//   • **Only working days are on the axis** - a weekend is a flat run in both lines that says nothing
//     and eats a third of the width of a two-week sprint. Core decides which days those are (any day
//     the team has capacity on), so a Saturday somebody is rostered onto stays.
//   • **The ideal line follows CAPACITY** - a half day is a half step. A straight line would put
//     every team behind on the light days for no reason anyone could act on.
//   • **The actual line STOPS at today** (`remaining` is null beyond it, `connectNulls={false}`).
//     Running it flat to the end of the sprint would read as "nothing more will get done", which is
//     a claim about the future the data has not made.

import { TrendingDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CollapsibleSection } from '@silkweave/box-ui'
import { ChartTooltipRow, SeriesLineChart } from '@silkweave/box-ui/charts'
import { usePersistedState } from '../../../../lib/usePersistedState.ts'
import { formatDay, formatDayShort, formatHours, type BurndownPoint } from '../../sprint-types.ts'

const OPEN_KEY = 'sprint.board.burndown-open'

export function SprintBurndown({
  points,
  today,
  scope,
}: {
  points: BurndownPoint[]
  today: string
  /** Total estimated hours in the sprint. A plain sum of the tasks, made where it is shown - the
   *  same rule as an initiative's size. It cannot be read off the chart: every point is an END-of-day
   *  value, so even the first one is already a step down from the scope. */
  scope: number
}) {
  const [open, setOpen] = usePersistedState<boolean>(OPEN_KEY, true, (v) => typeof v === 'boolean')

  if (points.length === 0) return null

  const data = points.map((p) => ({ ...p, label: formatDayShort(p.date) }))
  // The last day that actually has a reading - "where we are", which is not the last row when the
  // sprint runs into the future.
  const live = [...points].reverse().find((p) => p.remaining !== null) ?? null
  const delta = live ? (live.ideal - live.remaining!) : 0
  const inWindow = points.some((p) => p.date === today)

  return (
    <CollapsibleSection
      className='border-b border-border'
      headerClassName='px-3 py-2'
      bodyClassName='px-2 pb-3'
      open={open}
      onOpenChange={setOpen}
      icon={<TrendingDown className='size-3.5 shrink-0 text-muted-foreground' />}
      title='Burndown'
      // The headline, and it is passed in BOTH states on purpose: on a folded hero the number IS the
      // section. "How much is left, and are we ahead or behind" is the whole read.
      aside={
        live && (
          <span className='flex shrink-0 items-baseline gap-2 text-label'>
            <span className='font-mono tabular-nums text-text'>{formatHours(live.remaining!)}</span>
            <span className='text-muted-foreground'>left of {formatHours(scope)}</span>
            <span
              className={cn(
                'rounded px-1.5 py-0.5 font-medium tabular-nums',
                delta >= 0 ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
              )}
              title='Actual against the ideal line, at the last day with a reading'>
              {delta >= 0 ? `${formatHours(delta)} ahead` : `${formatHours(-delta)} behind`}
            </span>
          </span>
        )
      }>
      <>
        <SeriesLineChart
          data={data}
          xKey='label'
          formatValue={(v) => `${v}h`}
          formatX={(row) => formatDay(row.date as string)}
          // Rounded up to a multiple of 20 so the ticks land on 40 / 80 / 120 rather than on
          // whatever quarter of the scope the data happens to be (35h / 70h / 105h reads as noise;
          // hours are counted in tens).
          yDomain={[0, (max: number) => Math.max(20, Math.ceil(max / 20) * 20)]}
          reference={inWindow ? { x: formatDayShort(today), label: 'today' } : undefined}
          series={[
            // The ideal line is dashed and drawn in the axis ink: it is the plan, not a reading.
            { key: 'ideal', label: 'Ideal', color: 'var(--chart-ink)', dashed: true },
            // `remaining` is null past today and connectNulls stays off - see the header.
            { key: 'remaining', label: 'Remaining', dots: true },
          ]}
          renderTooltip={(_row, rows) => (
            <>
              <ChartTooltipRow
                color={rows[1].color}
                label='Left'
                value={rows[1].value === null ? 'not yet' : formatHours(rows[1].value)}
              />
              <ChartTooltipRow
                color={rows[0].color}
                dashed
                label='Planned'
                value={rows[0].value === null ? '-' : formatHours(rows[0].value)}
              />
            </>
          )}
          caption="Working days only, and the ideal line follows the team's capacity - a half day is a half step. Every point is the END of its day. Unestimated tasks count as nothing, the same blind spot the capacity check nags about."
        />
      </>
    </CollapsibleSection>
  )
}
