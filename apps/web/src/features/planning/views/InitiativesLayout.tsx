import { Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { AppShell, CenteredNote, type NavItem, type Crumb } from '@silkweave/box-ui'
import { ShowAllContext, ShowAllEye, useShowAll } from '@/lib/showAll.tsx'
import { useGroupNav } from '../../../lib/nav.ts'
import { upsertInitiative, upsertTask, usePlanningData } from '../lib/usePlanningData.ts'
import { useActiveUser } from '../../../lib/useActiveUser.ts'
import { useInitiativeView } from '../lib/useInitiativeView.ts'
import { useRecentIds } from '../../../lib/useRecentIds.ts'
import { PLANNING_STATUS_UI } from '../components/status.tsx'
import { presetIcon } from '../../data/components/board/presetIcons.tsx'
import { appKey } from '@/lib/storage.ts'

/** How many recently-opened initiatives the sidebar lists. */
const RECENT_SHOWN = 10

/**
 * The Initiatives shell: data fetch + a sidebar of saved views and recent initiatives. The canvas
 * (overview list or one initiative's detail) renders through the Outlet, mirroring SignalsLayout.
 *
 * The sidebar mirrors the CRM's, and for the same two reasons. Views come first because a named lens
 * is a place you navigate to, not a setting you dial in - hiding "Critical path" inside a select
 * made it a feature you had to already know about. Below them are the initiatives you have OPENED
 * recently rather than all of them, because a nav listing every row of the board it sits beside is a
 * second copy of the board that scrolls worse than the board's own search.
 */
export function InitiativesLayout() {
  const groupNav = useGroupNav('initiatives')
  const navigate = useNavigate()
  const { id, taskSlug } = useParams({ strict: false }) as { id?: string; taskSlug?: string }
  const { data, error } = usePlanningData()
  const { userId: activeUserId, filterMine } = useActiveUser()
  // Only CURRENT initiatives (planned + active) show by default - the sidebar reads as "what's in
  // flight". The shared toggle (sidebar eye + top-bar action) reveals the rest (blocked, done,
  // dropped); the grid reads it via ShowAllContext.
  const [showAll, setShowAll] = useShowAll('initiatives')
  // The same store the board's view bar reads (module-level, not per-component), so selecting a view
  // here and reading `selected` there cannot drift.
  const planningView = useInitiativeView()
  const recentIds = useRecentIds(appKey('initiatives', 'recentInitiatives'), id)

  if (error)
    return (
      <CenteredNote>
        Failed to reach the API: {error}
        <br />
        Start the backend: <code>pnpm dev</code>.
      </CenteredNote>
    )
  if (!data) return <CenteredNote>Loading…</CenteredNote>

  // Same "Only my items" scope as the grid (initiative owner), so sidebar and canvas agree.
  const mineOnly = filterMine && !!activeUserId
  const scoped = mineOnly ? data.filter((i) => i.owner === activeUserId) : data
  const isCurrent = (s: string): boolean => s === 'planned' || s === 'active'
  const hiddenCount = scoped.filter((i) => !isCurrent(i.status)).length

  // Views first, then recents. Their ids are namespaced (`view:<name>`) because a view named
  // "Product" and an initiative slugged `product` must never collide in one flat nav.
  const viewItems: NavItem[] = planningView.presets.map((s) => ({
    id: `view:${s.name}`,
    label: s.name,
    icon: presetIcon(s.icon),
    section: 'Presets',
  }))

  // Recency order comes from the history, not the data: `recentIds` IS the order. An id that no
  // longer resolves (deleted) simply drops - the history is a hint, never a claim it still exists.
  //
  // Recents are read from the FULL set, not `scoped`, and the "current only" rule does not apply to
  // them: this is where you have been, and having opened something is stronger evidence you want it
  // in the nav than its status being terminal. Filtering it the way the board is filtered made the
  // section empty itself right after you used it - open three finished initiatives and the sidebar
  // shows nothing, which reads as broken. The eye still governs the board; it does not govern your
  // own history.
  const byId = new Map(data.map((i) => [i.id, i]))
  const navItems: NavItem[] = [
    ...viewItems,
    ...recentIds
      .map((rid) => byId.get(rid))
      .filter((i): i is NonNullable<typeof i> => !!i)
      .slice(0, RECENT_SHOWN)
      .map((i) => {
        const { icon, color } = PLANNING_STATUS_UI[i.status]
        // Dropped tasks sit outside the lifecycle (like archived content) - they don't count.
        const live = i.tasks.filter((t) => t.status !== 'dropped')
        const done = live.filter((t) => t.status === 'done').length
        return {
          id: i.id,
          label: i.title,
          icon,
          iconClass: color,
          badge: live.length > 0 ? `${done}/${live.length}` : undefined,
          section: 'Recent Initiatives',
        }
      }),
  ]

  // On the board, the highlighted item is the SELECTED preset - the one the URL names - and it stays
  // highlighted after you edit a filter, matching the bar (which keeps the name and marks it
  // changed). On an initiative, that initiative is highlighted instead.
  const activeId = id ?? (planningView.selected ? `view:${planningView.selected}` : 'all')

  const onSelect = (sel: string) => {
    if (sel.startsWith('view:')) {
      planningView.select(sel.slice('view:'.length))
      // Selecting a lens means "show me the board through it", so it also brings you back from an
      // initiative detail page - otherwise the click would appear to do nothing.
      if (id) void navigate({ to: '/initiatives' })
      return
    }
    void navigate(sel === 'all' ? { to: '/initiatives' } : { to: '/initiatives/$id', params: { id: sel } })
  }

  const active = id ? data.find((i) => i.id === id) : undefined
  const activeTask = taskSlug && active ? active.tasks.find((t) => t.id === `${id}/${taskSlug}`) : undefined
  const crumbs: Crumb[] = [
    { label: 'Initiatives', onClick: id ? () => void navigate({ to: '/initiatives' }) : undefined },
  ]
  if (id) {
    crumbs.push({
      label: active?.title ?? id,
      onClick: taskSlug ? () => void navigate({ to: '/initiatives/$id', params: { id } }) : undefined,
      // The initiative's title is EDITED here, the only place it is shown - the detail page no
      // longer draws a heading. Not on a task page: there this crumb is the way BACK to the
      // initiative, and an input in it would rename the record you are not looking at.
      ...(!taskSlug && active ? { onRename: (title: string) => void upsertInitiative({ id, title }) } : {}),
    })
    // The task crumb is the task's name field AND the way across to its siblings - the task page
    // draws no heading of its own either, and jumping between the tasks of one initiative was
    // otherwise a trip back up to the list and down again.
    if (taskSlug)
      crumbs.push({
        label: activeTask?.title ?? taskSlug,
        ...(activeTask ? { onRename: (title: string) => void upsertTask({ id: activeTask.id, title }) } : {}),
        ...(active && active.tasks.length > 1
          ? {
              menu: active.tasks.map((t) => ({
                label: t.title,
                value: t.id,
                current: t.id === activeTask?.id,
                onSelect: () =>
                  void navigate({
                    to: '/initiatives/$id/$taskSlug',
                    params: { id, taskSlug: t.id.slice(id.length + 1) },
                  }),
              })),
            }
          : {}),
      })
  } else {
    crumbs.push({ label: 'Overview' })
  }

  const toggleProps = {
    shown: showAll,
    onToggle: () => setShowAll((v) => !v),
    hiddenCount,
    noun: 'inactive',
  }

  return (
    <AppShell
      items={navItems}
      activeId={activeId}
      onSelect={onSelect}
      groupNav={groupNav}
      topbar={{ crumbs }}
      groupAction={<ShowAllEye {...toggleProps} />}
>
      <ShowAllContext.Provider value={showAll}>
        <Outlet />
      </ShowAllContext.Provider>
    </AppShell>
  )
}

