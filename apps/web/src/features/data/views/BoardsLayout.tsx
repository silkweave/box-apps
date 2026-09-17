import { Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { LayoutGrid, Waypoints } from 'lucide-react'
import { AppShell, CenteredNote, type NavItem, type Crumb } from '@silkweave/box-ui'
import { useGroupNav } from '../../../lib/nav.ts'
import { useBoardsData } from '../lib/useBoardsData.ts'

/** The Circuit Boards shell: one sidebar entry per board (label + node count) above the index.
 *  The canvas (the index or one board) renders through the Outlet from the child routes. */
export function BoardsLayout() {
  const groupNav = useGroupNav('boards')
  const navigate = useNavigate()
  // strict:false so one layout serves both /boards and /boards/$id.
  const { id } = useParams({ strict: false }) as { id?: string }
  const { data, error } = useBoardsData()

  if (error)
    return (
      <CenteredNote>
        Failed to reach the API: {error}
        <br />
        Start the backend: <code>pnpm dev</code>.
      </CenteredNote>
    )
  if (!data) return <CenteredNote>Loading…</CenteredNote>

  const navItems: NavItem[] = [
    { id: 'all', label: 'All boards', icon: LayoutGrid, count: data.boards.length },
    ...data.boards.map((b) => ({
      id: b.id,
      label: b.label,
      icon: Waypoints,
      // Node count = MEMBERSHIP, which is the only thing a board row stores about size.
      count: b.nodes.length,
    })),
  ]

  const onSelect = (next: string) =>
    void navigate(next === 'all' ? { to: '/boards' } : { to: '/boards/$id', params: { id: next } })

  const active = id ? data.boards.find((b) => b.id === id) : undefined
  const crumbs: Crumb[] = [{ label: 'Circuit Boards', onClick: id ? () => void navigate({ to: '/boards' }) : undefined }]
  crumbs.push({ label: id ? (active?.label ?? id) : 'All boards' })

  return (
    <AppShell items={navItems} activeId={id ?? 'all'} onSelect={onSelect} groupNav={groupNav} topbar={{ crumbs }}>
      <Outlet />
    </AppShell>
  )
}
