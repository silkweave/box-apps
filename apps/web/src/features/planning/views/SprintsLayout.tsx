import { Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { AppShell, type NavItem, CenteredNote } from '@silkweave/box-ui'
import { useGroupNav } from '../../../lib/nav.ts'
import { upsertSprint, useSprintsData } from '../lib/useSprintsData.ts'
import { CircleCheck, CircleDot, CircleDotDashed, ClipboardList, ListTodo, type LucideIcon } from 'lucide-react'
import { SPRINT_STATUS_META, type Sprint, type SprintStatus } from '../sprint-types.ts'

// The Sprints shell: data fetch plus a sidebar of every sprint, sectioned by where it is in its
// lifecycle. Unlike the Initiatives sidebar (which lists what you have RECENTLY OPENED, because a
// nav listing every row of the board beside it is a second copy of that board), this one lists them
// all: a team runs a handful of sprints a quarter, and "which sprint" is the navigation.

const SPRINT_ICON: Record<SprintStatus, LucideIcon> = {
  pending: CircleDot,
  scheduled: ClipboardList,
  planned: ListTodo,
  active: CircleDotDashed,
  done: CircleCheck,
}

const SPRINT_ICON_CLASS: Record<SprintStatus, string> = {
  pending: 'text-muted-foreground',
  scheduled: 'text-info',
  planned: 'text-info',
  active: 'text-accent',
  done: 'text-success',
}

/** Running work first, then what is coming, then what is finished. */
const SECTION: Record<SprintStatus, string> = {
  active: 'Running',
  planned: 'Coming up',
  scheduled: 'Coming up',
  pending: 'Coming up',
  done: 'Closed',
}
const SECTION_ORDER = ['Running', 'Coming up', 'Closed']

export function SprintsLayout() {
  const groupNav = useGroupNav('sprints')
  const navigate = useNavigate()
  const { id } = useParams({ strict: false }) as { id?: string }
  const { data, error } = useSprintsData()

  if (error)
    return (
      <CenteredNote>
        Failed to reach the API: {error}
        <br />
        Start the backend: <code>pnpm dev</code>.
      </CenteredNote>
    )
  if (!data) return <CenteredNote>Loading…</CenteredNote>

  const ordered = [...data].sort(
    (a, b) => SECTION_ORDER.indexOf(SECTION[a.status]) - SECTION_ORDER.indexOf(SECTION[b.status]),
  )

  const navItems: NavItem[] = ordered.map((s: Sprint) => ({
    id: s.id,
    label: s.title,
    icon: SPRINT_ICON[s.status],
    iconClass: SPRINT_ICON_CLASS[s.status],
    badge: s.start_date ? s.start_date.slice(5) : SPRINT_STATUS_META[s.status].label,
    section: SECTION[s.status],
  }))

  const active = id ? data.find((s) => s.id === id) : undefined

  return (
    <AppShell
      items={navItems}
      activeId={id ?? 'all'}
      onSelect={(sel) => void navigate(sel === 'all' ? { to: '/sprints' } : { to: '/sprints/$id', params: { id: sel } })}
      groupNav={groupNav}
      topbar={{
        crumbs: [
          { label: 'Sprints', onClick: id ? () => void navigate({ to: '/sprints' }) : undefined },
          {
            label: id ? (active?.title ?? id) : 'Overview',
            // The sprint's name is EDITED here, in the only place it is shown. Sprint Design used to
            // carry a title field as well; two inputs for one string is one too many.
            ...(id && active ? { onRename: (title: string) => void upsertSprint({ id, title }) } : {}),
          },
        ],
      }}>
      <Outlet />
    </AppShell>
  )
}
