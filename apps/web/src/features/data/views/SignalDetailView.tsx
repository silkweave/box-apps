import { useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ArrowDownRight, ArrowLeft, ArrowUpRight, Minus, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Channel, Signal, SignalDataSource } from '../../../types.ts'
import { channelLabel } from '../../../types.ts'
import { setSignalOwner, useSignalsData } from '../lib/useSignalsData.ts'
import { findSignal, signalSlug } from '../lib/signalSlug.ts'
import { signalLabel, signalMap } from '../lib/signalLabel.ts'
import { healthLook } from '../lib/signalHealth.ts'
import { SignalChart } from '../components/SignalChart.tsx'
import { SignalDialog } from '../components/SignalDialog.tsx'
import { SignalPointsEditor } from '../components/SignalPointsEditor.tsx'
import { PageContainer, Button, UserPicker } from '@silkweave/box-ui'
import { computeDelta, formatBucket, formatDelta, formatNumber, relativeTime } from '../../../lib/format.ts'

/** A single signal's deep-dive at /signals/$channel/$signal: the definition (description, target,
 *  semantics), headline stats, the interactive range chart, and a recent-snapshots table. A
 *  data-less signal (registered, no points yet) renders its definition with an honest empty state. */
export function SignalDetailView() {
  const { channel, signal: slug } = useParams({ strict: false }) as { channel?: Channel; signal?: string }
  const { data } = useSignalsData()
  const navigate = useNavigate()
  const [editOpen, setEditOpen] = useState(false)

  if (!data) return null
  const signal = channel && slug ? findSignal(data.signals, channel, slug) : undefined

  if (!signal)
    return (
      <PageContainer width='reading'>
        <p className='text-body-sm text-muted-foreground'>
          No signal matches <code>{channel}/{slug}</code>.{' '}
          <Link to='/signals' className='text-accent hover:underline'>
            Back to overview
          </Link>
        </p>
      </PageContainer>
    )

  const points = signal.points
  const latest = points.length > 0 ? points[points.length - 1] : null
  const delta = computeDelta(points)
  const values = points.map((p) => p.value)
  const isIncrement = signal.accumulation === 'increment'
  // Sub-daily charts serve a trailing window (SUBDAILY_WINDOW_DAYS server-side), so peak/low over
  // `points` are window stats there - the label must not claim "all-time" it cannot back.
  const windowed = signal.interval === 'hour'

  // Peak/low carry the bucket they happened in - the sub-line slot exists on every tile anyway, and
  // "12,492 on Jul 18" answers the question the bare number provokes.
  const peak = points.length > 0 ? points.reduce((a, b) => (b.value > a.value ? b : a)) : null
  const low = points.length > 0 ? points.reduce((a, b) => (b.value < a.value ? b : a)) : null

  const stats: TileProps[] = latest
    ? [
        {
          // An increment signal's last bucket is still filling - say so instead of "Current".
          label: isIncrement ? (signal.interval === 'day' ? 'Today so far' : 'Current bucket') : 'Current',
          // The unit rides as its own element, never concatenated into the value: glued together
          // ("11,552.12 USD") they form one unbreakable string that blows through a quarter-width
          // card, which is what made these overflow.
          value: formatNumber(latest.value),
          unit: signal.unit,
          sub: formatBucket(latest.date),
        },
        {
          label: 'Latest change',
          // Header, then the absolute change, then the percentage as a colored chip - the three
          // used to be one string, which wrapped onto three lines at this width.
          value: delta ? `${delta.abs > 0 ? '+' : ''}${formatNumber(delta.abs)}` : 'baseline',
          unit: delta ? signal.unit : null,
          muted: !delta,
          sub: delta ? <DeltaChip delta={delta} /> : 'first point - nothing to compare',
        },
        {
          label: windowed ? '90d peak' : 'All-time peak',
          value: formatNumber(Math.max(...values)),
          unit: signal.unit,
          sub: peak ? formatBucket(peak.date) : null,
        },
        {
          label: windowed ? '90d low' : 'All-time low',
          value: formatNumber(Math.min(...values)),
          unit: signal.unit,
          sub: low ? formatBucket(low.date) : null,
        },
      ]
    : []

  // The three standing questions (plus last-7d), from the server's full-store aggregates - NOT
  // from `points`, which may be windowed. Null renders an honest dash, never a fabricated 0.
  const aggTitle = isIncrement ? 'Sum of the buckets in the window' : 'The latest value in the window'
  const periods: { label: string; value: number | null; title: string }[] = [
    { label: 'All time', value: signal.aggregates.all_time, title: isIncrement ? 'Sum of every bucket ever' : 'The latest value' },
    { label: 'Yesterday', value: signal.aggregates.yesterday, title: `${aggTitle} - the last complete UTC day` },
    { label: 'Month to date', value: signal.aggregates.month_to_date, title: `${aggTitle} - from the 1st of the current UTC month, today included` },
    { label: 'Last 7 days', value: signal.aggregates.last_7d, title: `${aggTitle} - the 7 complete UTC days before today` },
  ]

  const recent = [...points].reverse().slice(0, 14)
  const byId = signalMap(data)

  return (
    <PageContainer width='reading'>
      <Link
        to='/signals/$channel'
        params={{ channel: signal.channel }}
        className='mb-4 inline-flex items-center gap-1.5 text-label text-muted-foreground transition-colors hover:text-text'>
        <ArrowLeft className='size-3.5' /> {channelLabel(signal.channel)}
      </Link>

      <header className='mb-6'>
        <div className='flex items-start justify-between gap-3'>
          <div>
            <div className='text-label uppercase tracking-[0.06em] text-muted-foreground'>{signal.group}</div>
            <h1 className='mt-1 font-serif text-display-md leading-tight text-text'>{signal.label}</h1>
          </div>
          {/* Definitions are configuration - editing is admin-only, like the owner picker below. */}
          {(
            <Button size='sm' variant='outline' onClick={() => setEditOpen(true)}>
              <Pencil /> Edit
            </Button>
          )}
        </div>
        <div className='mt-1 flex flex-wrap items-center gap-3'>
          <code className='text-label text-muted-foreground'>{signal.id}</code>
          <span className='inline-flex items-center gap-1 text-label text-muted-foreground'>
            Owner
            {/* Writes the definition + a per-signal override in config/signal-owners.json (clear =
                explicitly unowned). Ownership is configuration - admin-only, read-only chip for
                everyone else. */}
            <UserPicker
              value={signal.owner}
              onChange={(id) => void setSignalOwner(signal.id, id)}
            />
          </span>
        </div>
        {/* The definition's semantics at a glance: source, grain, meaning, direction. */}
        <div className='mt-3 flex flex-wrap items-center gap-1.5'>
          <DefinitionChip title='Where the identity and points come from'>{signal.source}</DefinitionChip>
          <DefinitionChip title='Bucket width of one point'>{signal.interval}</DefinitionChip>
          <DefinitionChip title='snapshot = whole value at that time; increment = occurrences per bucket'>
            {signal.accumulation}
          </DefinitionChip>
          <DefinitionChip title='Which way is good'>{signal.direction === 'up' ? 'up is good' : 'down is good'}</DefinitionChip>
          {signal.target && (
            <>
              <DefinitionChip title={"The signal's standing target"}>
                target {formatNumber(signal.target.value)}
                {signal.unit ? ` ${signal.unit}` : ''}
                {signal.target.by_date ? ` by ${signal.target.by_date}` : ''}
                {signal.target.baseline != null
                  ? ` (from ${formatNumber(signal.target.baseline)}${signal.target.since ? ` on ${signal.target.since}` : ''})`
                  : ''}
              </DefinitionChip>
              {/* The verdict is the server's (core signalHealth) - never recomputed here. */}
              <DefinitionChip title={healthLook(signal.health).hint}>
                <span
                  aria-hidden
                  className='mr-1 inline-block size-2 rounded-full align-middle'
                  style={{ background: healthLook(signal.health).color }}
                />
                {healthLook(signal.health).label}
              </DefinitionChip>
            </>
          )}
        </div>
        {signal.data_source_id && <ConnectionChip signal={signal} sources={data.sources} />}
        {signal.description && (
          <p className='mt-3 max-w-prose text-body-sm leading-relaxed text-muted-foreground'>{signal.description}</p>
        )}
        {signal.depends_on.length > 0 && (
          <p className='mt-2 text-label text-muted-foreground'>
            Driven by:{' '}
            {signal.depends_on.map((id, i) => (
              <span key={id}>
                {i > 0 && ' · '}
                <DependencyLink byId={byId} id={id} />
              </span>
            ))}
          </p>
        )}
      </header>

      {latest ? (
        <>
          <section className='mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4'>
            {stats.map((s) => (
              <StatTile key={s.label} {...s} />
            ))}
          </section>

          <section className='mb-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4'>
            {periods.map((p) => (
              <StatTile
                key={p.label}
                label={p.label}
                title={p.title}
                value={p.value == null ? null : formatNumber(p.value)}
                unit={signal.unit}
                emptyHint='No data in this window'
              />
            ))}
          </section>

          <SignalChart signal={signal} />

          <section className='mt-8'>
            <h2 className='mb-3 text-label uppercase tracking-[0.07em] text-muted-foreground'>Recent snapshots</h2>
            <div className='overflow-hidden rounded-lg border border-border'>
              <table className='w-full text-body-sm'>
                <thead>
                  <tr className='border-b border-border bg-surface text-left text-label uppercase tracking-[0.06em] text-muted-foreground'>
                    <th className='px-4 py-2 font-medium'>Date</th>
                    <th className='px-4 py-2 text-right font-medium'>Value</th>
                    <th className='px-4 py-2 text-right font-medium'>Change</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((p, i) => {
                    const prev = recent[i + 1]
                    const diff = prev ? p.value - prev.value : null
                    return (
                      <tr key={p.date} className='border-b border-border last:border-0 bg-bg/40'>
                        <td className='px-4 py-2 text-muted-foreground tabular-nums'>{formatBucket(p.date)}</td>
                        <td className='px-4 py-2 text-right tabular-nums text-text'>{formatNumber(p.value)}</td>
                        <td className='px-4 py-2 text-right tabular-nums'>
                          {diff == null ? (
                            <span className='text-muted-foreground'>-</span>
                          ) : (
                            <span className={diff > 0 ? 'text-success' : diff < 0 ? 'text-danger' : 'text-muted-foreground'}>
                              {diff > 0 ? '+' : ''}
                              {formatNumber(diff)}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <section className='rounded-lg border border-dashed border-border bg-surface/50 p-6 text-body-sm text-muted-foreground'>
          No data points yet. The signal exists and can already be bound to initiatives and targets;
          {signal.data_source_id
            ? ' points appear on its data source’s next sync - run one from Settings → Data sources if it has never synced.'
            : signal.source === 'derived'
              ? ' points appear when its channel derives.'
              : signal.accumulation === 'increment'
                ? ' occurrences count in via the signal-event tool, and buckets can be gap-filled by hand below.'
                : ' enter points by hand below until a live source exists.'}
        </section>
      )}

      {/* Manual entry is the bridge until a live source exists - and gap-fill for derived signal.
          Always present: a shadowed manual point renders as such rather than being hidden. */}
      <SignalPointsEditor signal={signal} />

      <SignalDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        signal={signal}
        onSaved={(id, ch) => {
          // The channel is part of the route; follow the signal if curation moved it.
          if (ch !== signal.channel) {
            void navigate({
              to: '/signals/$channel/$signal',
              params: { channel: ch as Channel, signal: signalSlug({ id, channel: ch as Channel }) },
            })
          }
        }}
        onDeleted={() => void navigate({ to: '/signals' })}
      />
    </PageContainer>
  )
}

/**
 * The connection line for a signal bound to a data source: which source, which measure, and when it
 * last landed. Three honest states beyond "fine": the source was DELETED out from under the binding
 * (dangling - the points stay, they just stop refreshing), the last sync FAILED, or it has gone
 * STALE (read-side only, ~2x the daily cadence every source runs on - no stored staleness).
 */
function ConnectionChip({ signal, sources }: { signal: Signal; sources: SignalDataSource[] }) {
  const source = sources.find((s) => s.id === signal.data_source_id)
  const failed = source?.last_sync_status === 'error'
  const stale =
    source?.status === 'enabled' &&
    !!source.last_sync_at &&
    Date.now() - new Date(source.last_sync_at).getTime() > 2 * 24 * 60 * 60 * 1000
  const tone = !source || failed ? 'text-danger' : stale ? 'text-warning' : 'text-muted-foreground'

  return (
    <p className={cn('mt-3 text-label', tone)}>
      {!source ? (
        <>
          Connected to <code>{signal.data_source_id}</code>, which no longer exists - the points below are
          real history that has stopped refreshing. Re-point or clear the binding from Edit.
        </>
      ) : (
        <>
          {source.label} · <span title={`provider measure key: ${signal.measure_key}`}>{signal.measure_key}</span> ·{' '}
          {source.last_sync_at ? (
            <span title={source.last_sync_at}>
              {failed ? 'last sync FAILED ' : 'synced '}
              {relativeTime(source.last_sync_at)}
            </span>
          ) : (
            'never synced'
          )}
          {stale && !failed && ' - stale'}
          {source.status === 'disabled' && ' · source disabled (syncs only on demand)'}
        </>
      )}
    </p>
  )
}

interface TileProps {
  label: string
  /** Already formatted; `null` renders an honest dash rather than a fabricated zero. */
  value: string | null
  unit?: string | null
  /** The third line: a bucket date, or the delta chip. Optional - tiles without one stay flush. */
  sub?: React.ReactNode
  title?: string
  emptyHint?: string
  /** Render the value in the muted tone (a placeholder like "baseline", not a real number). */
  muted?: boolean
}

/**
 * One headline tile. Three fixed rows - LABEL / value / sub - so the two stat rows on this page read
 * as one system and every tile in a row lines up (grid rows stretch, so heights match for free).
 *
 * The overflow rules are the whole point and are easy to undo by accident:
 *   • the value TRUNCATES, which needs `min-w-0` on the flex child or the ellipsis never triggers;
 *   • the unit is a separate, `shrink-0` element - concatenating it into the value makes one
 *     unbreakable string that overflows a quarter-width card;
 *   • the value sits at display-sm, a step down from the old heading-1, which is what actually
 *     buys the room at four-across.
 */
function StatTile({ label, value, unit, sub, title, emptyHint, muted }: TileProps) {
  return (
    <div
      title={title}
      className='flex flex-col rounded-lg border border-border bg-surface px-3.5 py-3 shadow-(--shadow-sm) transition-colors hover:border-accent/40'>
      <div className='truncate text-label uppercase tracking-[0.06em] text-muted-foreground'>{label}</div>
      <div className='mt-2 flex items-baseline gap-1'>
        {value == null ? (
          <span className='font-serif text-display-sm leading-none text-muted-foreground' title={emptyHint}>
            -
          </span>
        ) : (
          <>
            <span
              title={value}
              className={cn(
                'min-w-0 truncate font-serif text-display-sm tabular-nums leading-none',
                muted ? 'text-muted-foreground' : 'text-text',
              )}>
              {value}
            </span>
            {unit && <span className='shrink-0 text-label text-muted-foreground'>{unit}</span>}
          </>
        )}
      </div>
      {sub != null && <div className='mt-2 truncate text-label tabular-nums text-muted-foreground'>{sub}</div>}
    </div>
  )
}

/** The percentage half of "latest change", as a tinted chip. Up is green and down is red, matching
 *  SignalCard - deliberately NOT direction-aware, so the two surfaces never disagree on a colour. */
function DeltaChip({ delta }: { delta: NonNullable<ReturnType<typeof computeDelta>> }) {
  const Icon = delta.dir === 'up' ? ArrowUpRight : delta.dir === 'down' ? ArrowDownRight : Minus
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-label tabular-nums whitespace-nowrap',
        delta.dir === 'up' && 'bg-success-bg text-success',
        delta.dir === 'down' && 'bg-danger-bg text-danger',
        delta.dir === 'flat' && 'text-muted-foreground',
      )}
      title={`Change from the previous bucket: ${formatDelta(delta)}`}>
      <Icon className='size-3' />
      {delta.pct == null ? formatNumber(delta.abs) : `${delta.pct > 0 ? '+' : ''}${delta.pct.toFixed(1)}%`}
    </span>
  )
}

function DefinitionChip({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <span
      title={title}
      className='inline-flex items-center rounded border border-border bg-surface px-1.5 py-0.5 text-label text-muted-foreground'>
      {children}
    </span>
  )
}

/** A depends_on entry: friendly label (raw id in the tooltip), linked when the signal resolves. */
function DependencyLink({ byId, id }: { byId: ReturnType<typeof signalMap>; id: string }) {
  const dep = byId.get(id)
  if (!dep) return <code title='no live signal with this id'>{id}</code>
  return (
    <Link
      to='/signals/$channel/$signal'
      params={{ channel: dep.channel, signal: signalSlug(dep) }}
      title={id}
      className='text-accent hover:underline'>
      {signalLabel(byId, id)}
    </Link>
  )
}
