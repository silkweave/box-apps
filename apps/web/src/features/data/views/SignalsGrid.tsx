import { useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { BarChart3, Plus } from 'lucide-react'
import type { Channel, Signal } from '../../../types.ts'
import { baseChannel, channelLabel, inChannel } from '../../../types.ts'
import { SignalCard } from '../components/SignalCard.tsx'
import { SignalDialog } from '../components/SignalDialog.tsx'
import { PageContainer, SegmentedControl, Button, UserChip, EmptyState } from '@silkweave/box-ui'
import { useSignalsData } from '../lib/useSignalsData.ts'
import { useActiveUser } from '../../../lib/useActiveUser.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { usePersistedState } from '../../../lib/usePersistedState.ts'
import { signalSlug } from '../lib/signalSlug.ts'
import { formatNumber } from '../../../lib/format.ts'
import { appKey } from '@/lib/storage.ts'

/** How many signals the hero strip shows. Four fits the grid it lays out on at every breakpoint. */
const HERO_COUNT = 4

type GroupBy = 'group' | 'user'
const GROUP_BYS: { value: GroupBy; label: string }[] = [
  { value: 'group', label: 'Group' },
  { value: 'user', label: 'User' },
]

/** The Signals canvas: the overview (all channels, with a hero strip) at /signals, or a single
 *  channel's cards at /signals/$channel. Cards group into container cards per the "Group by"
 *  choice - signal group under its channel (default), or owner. Each card links to its detail. */
export function SignalsGrid() {
  const { channel } = useParams({ strict: false }) as { channel?: Channel }
  const { data } = useSignalsData()
  const { userId: activeUserId, user: activeUser, filterMine } = useActiveUser()
  const { data: users } = useUsersData()
  const [newOpen, setNewOpen] = useState(false)
  const [groupBy, setGroupBy] = usePersistedState<GroupBy>(
    appKey('signals', 'groupBy'),
    'group',
    (v) => GROUP_BYS.some((o) => o.value === v),
  )
  const mineOnly = filterMine && !!activeUserId

  const visible = useMemo(
    () =>
      data
        ? data.signals.filter(
            // A base-channel param ('github') includes its account variants ('github@dan').
            (s) => (!channel || inChannel(s.channel, channel)) && (!mineOnly || s.owner === activeUserId),
          )
        : [],
    [data, channel, mineOnly, activeUserId],
  )
  // The hero strip used to be four hard-coded signal ids, which existed on exactly one Box and were
  // dead code on every other. A TARGET is the general form of what those ids were reaching for: it
  // is the team saying, in the product, "this is a number we are driving" - nothing else in the
  // model carries that claim, and it costs no new storage key and no new config file. Nearest
  // deadline first, because that is the one worth a glance. No targets anywhere = no strip, which
  // is the honest state for a Box nobody has committed to a number on yet.
  const hero = useMemo(
    () =>
      data
        ? data.signals
            .filter((s) => s.target && (!mineOnly || s.owner === activeUserId))
            .sort((a, b) => (a.target?.by_date ?? '9999-12-31').localeCompare(b.target?.by_date ?? '9999-12-31') || a.label.localeCompare(b.label))
            .slice(0, HERO_COUNT)
        : [],
    [data, mineOnly, activeUserId],
  )

  if (!data) return null

  // A Box with no signals AT ALL - the first screen a new user lands on, since `/` redirects to the
  // first nav entry. Distinct from a filter that happens to match nothing, which the count line
  // above already explains.
  if (data.signals.length === 0)
    return (
      <PageContainer width='wide'>
        <EmptyState
          icon={<BarChart3 className='size-6' />}
          title='No signals yet'
          description={
            <>
              A signal is one number you watch over time - downloads a week, stars, signups, revenue
              booked. Define one by hand, or{' '}
              <Link
                to='/settings/$section'
                params={{ section: 'data-sources' }}
                className='font-medium text-accent transition-colors hover:underline'>
                connect a data source
              </Link>{' '}
              and let a sync fill one in.
            </>
          }
          action={
            <Button size='sm' onClick={() => setNewOpen(true)}>
              <Plus /> New signal
            </Button>
          }
        />
        <SignalDialog open={newOpen} onOpenChange={setNewOpen} />
      </PageContainer>
    )

  // Sections merge by BASE channel - account variants ('github@dan') fold into one "GitHub"
  // section; the per-card owner chip + swatch tint carry whose signal each one is.
  const channels = [...new Set(data.channels.map(baseChannel))].filter(
    (c) => (!channel || inChannel(c, channel) || c === baseChannel(channel)) && visible.some((s) => inChannel(s.channel, c)),
  )

  const grid = (list: Signal[]) => (
    <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
      {list.map((s) => (
        <Link
          key={s.id}
          to='/signals/$channel/$signal'
          params={{ channel: s.channel, signal: signalSlug(s) }}
          className='rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/50'>
          <SignalCard signal={s} />
        </Link>
      ))}
    </div>
  )

  return (
    <PageContainer width='wide'>
      <div className='mb-6 flex flex-wrap items-center justify-between gap-3'>
        <p className='text-body-sm text-muted-foreground'>
          {mineOnly && activeUser ? (
            <>
              Showing only <span className='text-accent'>{activeUser.nickname || activeUser.id}</span>
              {"'"}s signals ({visible.length}/
              {data.signals.filter((s) => !channel || inChannel(s.channel, channel)).length}) - toggle
              "Only my items" in the user menu to see everything.
            </>
          ) : (
            <>
              {visible.length} signal {channel ? `on ${channelLabel(baseChannel(channel))}` : 'across all channels'}.
            </>
          )}
        </p>
        <div className='flex items-center gap-2'>
          {(
            <Button size='sm' variant='outline' onClick={() => setNewOpen(true)}>
              <Plus /> New signal
            </Button>
          )}
          <SegmentedControl label='Group by' value={groupBy} options={GROUP_BYS} onChange={setGroupBy} />
        </div>
      </div>

      {/* Definitions are configuration - the dialog is admin-gated above. */}
      <SignalDialog open={newOpen} onOpenChange={setNewOpen} />

      {!channel && hero.length > 0 && (
        <section className='mb-9 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          {hero.map((s) => (
            <Link
              key={s.id}
              to='/signals/$channel/$signal'
              params={{ channel: s.channel, signal: signalSlug(s) }}
              className='rounded-lg border border-border bg-surface p-5 shadow-(--shadow-sm) transition-colors hover:border-accent/40'>
              <div className='text-body-sm text-muted-foreground'>{s.label}</div>
              <div className='mt-2 font-serif text-display-xl tabular-nums leading-none text-text'>
                {/* A hero signal can be registered but data-less; render '-' rather than crash. */}
                {s.points.length > 0 ? formatNumber(s.points[s.points.length - 1].value) : '-'}
                {s.unit ? <span className='ml-1 text-body text-muted-foreground'>{s.unit}</span> : null}
              </div>
              <div className='mt-2 text-label uppercase tracking-[0.06em] text-muted-foreground'>
                {channelLabel(s.channel)}
              </div>
            </Link>
          ))}
        </section>
      )}

      {groupBy === 'group'
        ? // Channel sections, each signal group as a container card ("npm" → "Downloads").
          channels.map((c) => {
            const groups = groupBy_(visible.filter((s) => inChannel(s.channel, c)), (s) => s.group)
            return (
              <section key={c} className='mb-10'>
                <h2 className='mb-4 flex items-center gap-2 text-heading-2 font-semibold text-text'>
                  {channelLabel(c)}
                </h2>
                <div className='flex flex-col gap-4'>
                  {[...groups.entries()].map(([group, list]) => (
                    <div key={group} className='rounded-xl border border-border p-3 sm:p-4'>
                      <div className='mb-3 flex items-center gap-2'>
                        <h3 className='text-body-sm font-semibold text-text'>{group}</h3>
                        <span className='text-label text-muted-foreground tabular-nums'>{list.length}</span>
                      </div>
                      {grid(list)}
                    </div>
                  ))}
                </div>
              </section>
            )
          })
        : // Owner containers, channel-labelled grids inside.
          [...new Set(visible.map((s) => s.owner ?? ''))]
            .sort((a, b) => {
              const name = (id: string) => users?.find((u) => u.id === id)?.nickname ?? id
              return a === '' ? 1 : b === '' ? -1 : name(a).localeCompare(name(b))
            })
            .map((owner) => {
              const own = visible.filter((s) => (s.owner ?? '') === owner)
              const byChannel = channels
                .map((c) => ({ channel: c, list: own.filter((s) => inChannel(s.channel, c)) }))
                .filter((g) => g.list.length > 0)
              return (
                <section key={owner || 'unowned'} className='mb-5 rounded-xl border border-border p-3 sm:p-4'>
                  <div className='mb-3 flex items-center gap-2'>
                    {owner ? (
                      <UserChip userId={owner} showName />
                    ) : (
                      <h3 className='text-body-sm font-medium text-muted-foreground'>Unassigned</h3>
                    )}
                    <span className='text-label text-muted-foreground tabular-nums'>{own.length}</span>
                  </div>
                  <div className='flex flex-col gap-4'>
                    {byChannel.map(({ channel: c, list }) => (
                      <div key={c}>
                        <h4 className='mb-2 text-label uppercase tracking-[0.07em] text-muted-foreground'>
                          {channelLabel(c)}
                        </h4>
                        {grid(list)}
                      </div>
                    ))}
                  </div>
                </section>
              )
            })}

      <footer className='border-t border-border pt-5 text-label text-muted-foreground'>
        Live from the DuckDB warehouse · trends fill in as daily snapshots accrue.
      </footer>
    </PageContainer>
  )
}

function groupBy_<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const item of arr) {
    const k = key(item)
    const cur = m.get(k)
    if (cur) cur.push(item)
    else m.set(k, [item])
  }
  return m
}
