import { Outlet, useNavigate, useParams } from '@tanstack/react-router'
import type { Channel } from '../../../types.ts'
import { baseChannel, channelLabel, inChannel } from '../../../types.ts'
import { AppShell, CenteredNote, type NavItem, type Crumb } from '@silkweave/box-ui'
import { channelIcon } from '@/lib/channelIcons.tsx'
import { useGroupNav } from '../../../lib/nav.ts'
import { useSignalsData } from '../lib/useSignalsData.ts'
import { findSignal } from '../lib/signalSlug.ts'

/** The Signals shell: data fetch, channel sidebar, and breadcrumbs. The canvas (overview grid,
 *  channel grid, or a signal detail) renders through the Outlet from the child routes. */
export function SignalsLayout() {
  const groupNav = useGroupNav('signals')
  const navigate = useNavigate()
  // strict:false so one layout serves /signals, /signals/$channel and /signals/$channel/$signal.
  const { channel, signal } = useParams({ strict: false }) as { channel?: Channel; signal?: string }
  const { data, error } = useSignalsData()

  if (error)
    return (
      <CenteredNote>
        Failed to reach the API: {error}
        <br />
        Start the backend: <code>pnpm dev</code>.
      </CenteredNote>
    )
  if (!data) return <CenteredNote>Loading…</CenteredNote>

  // One sidebar entry per BASE channel - account variants ('github@dan') fold into it; their
  // signal count toward it and the canvas shows them as sections. The circuit board used to sit
  // above them; it is now the top-level Circuit Boards group, because a board composes signals
  // across channels rather than slicing them.
  const activeId = channel ? baseChannel(channel) : 'all'
  const navItems: NavItem[] = [...new Set(data.channels.map(baseChannel))].map((c) => ({
    id: c,
    label: channelLabel(c),
    icon: channelIcon(c),
    count: data.signals.filter((s) => inChannel(s.channel, c)).length,
  }))

  const onSelect = (id: string) =>
    void navigate(id === 'all' ? { to: '/signals' } : { to: '/signals/$channel', params: { channel: id } })

  const crumbs: Crumb[] = [{ label: 'Signals', onClick: () => void navigate({ to: '/signals' }) }]
  if (channel) {
    const detail = signal ? findSignal(data.signals, channel, signal) : undefined
    crumbs.push({
      label: channelLabel(channel),
      onClick: signal ? () => void navigate({ to: '/signals/$channel', params: { channel } }) : undefined,
    })
    if (signal) crumbs.push({ label: detail?.label ?? signal })
  } else {
    crumbs[0].onClick = undefined
    crumbs.push({ label: 'Overview' })
  }

  return (
    <AppShell
      items={navItems}
      activeId={activeId}
      onSelect={onSelect}
      groupNav={groupNav}
      topbar={{ crumbs }}
>
      <Outlet />
    </AppShell>
  )
}

