import { Outlet, useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { ListChecks } from 'lucide-react'
import { AppShell, type NavItem, type Crumb, formatCurrency, CenteredNote } from '@silkweave/box-ui'
import { ShowAllContext, ShowAllEye, useShowAll } from '@/lib/showAll.tsx'
import type { CrmAccount } from '../crm-types.ts'
import { crmStatusUi } from '../components/crmStatus.tsx'
import { useActiveUser } from '../../../lib/useActiveUser.ts'
import { useCrmData } from '../lib/useCrmData.ts'
import { useCrmView } from '../lib/useCrmView.ts'
import { useAssignQueueCount } from './CrmAssignQueue.tsx'
import { useRecentIds } from '../../../lib/useRecentIds.ts'
import { presetIcon } from '../../data/components/board/presetIcons.tsx'
import { useGroupNav } from '../../../lib/nav.ts'
import { appKey } from '@/lib/storage.ts'

/** How many recently-opened accounts the sidebar lists. */
const RECENT_SHOWN = 10

/**
 * The CRM shell: data fetch + an account sidebar. The canvas (the accounts board or one account's
 * detail) renders through the Outlet, mirroring InitiativesLayout.
 *
 * The sidebar is NAVIGATION, not a filter. It used to be a status nav, which stopped making sense
 * the moment the board grew a real view bar - two filter surfaces disagreeing about what is on
 * screen is worse than either alone. Filtering still lives in exactly one place (the view bar's
 * status chips, which are also the pipeline's columns).
 *
 * What the sidebar DOES carry, above the accounts, is the saved views - because a named lens is a
 * place you go to, not a setting you dial in, and hiding "Pipeline" inside a select made it a
 * feature you had to already know about. Clicking one selects it in the view bar and returns to the
 * board; the two surfaces read the same store, so they can never disagree about which view is on.
 *
 * Below them are the accounts you have OPENED recently, not all 53 - a nav listing every row of the
 * board it sits next to is a second copy of the board, and by the time it scrolls it is slower than
 * the board's own search. Ten, most recent first. History is per-browser (`localStorage`) and
 * deliberately not shared: where you have been is not team state, and syncing it would put one
 * person's afternoon in a teammate's sidebar.
 */
export function CrmLayout() {
  const groupNav = useGroupNav('crm')
  const navigate = useNavigate()
  const { id } = useParams({ strict: false }) as { id?: string }
  const onQueue = useLocation().pathname.replace(/\/$/, '').endsWith('/crm/queue')
  // Fetched here rather than in the view so the badge is right before you open it - the whole point
  // of the queue is that nobody has to remember to go looking.
  const queueCount = useAssignQueueCount()
  const { data, error } = useCrmData()
  // The same store the board's view bar reads (module-level, not per-component), so selecting a view
  // here and reading `selected` there cannot drift.
  const crmView = useCrmView()
  const { userId: activeUserId, filterMine } = useActiveUser()
  // Archived accounts are hidden by default everywhere; the shared eye reveals them. The board reads
  // the same flag through ShowAllContext, so sidebar and canvas always agree.
  const [showAll, setShowAll] = useShowAll('crm')

  // Visit history, newest first - recorded here because this is the component that both knows the
  // open id and renders the nav.
  const recentIds = useRecentIds(appKey('crm', 'recentAccounts'), id)

  if (error)
    return (
      <CenteredNote>
        Failed to reach the API: {error}
        <br />
        Start the backend: <code>pnpm dev</code>.
      </CenteredNote>
    )
  if (!data) return <CenteredNote>Loading…</CenteredNote>

  // Same "Only my items" scope as the board (account owner), so sidebar and canvas agree.
  const mineOnly = filterMine && !!activeUserId
  const scoped = mineOnly ? data.filter((a) => a.owner === activeUserId) : data
  const hiddenCount = scoped.filter((a) => a.status === 'archived').length
  // Views first, then accounts. Their ids are namespaced (`view:<name>`) because a view named
  // "Pipeline" and an account slugged `pipeline` must never collide in one flat nav.
  const viewItems: NavItem[] = crmView.presets.map((s) => ({
    id: `view:${s.name}`,
    label: s.name,
    icon: presetIcon(s.icon),
    section: 'Presets',
  }))
  // Recency order comes from the history, not from the data: `recentIds` IS the order. An id that no
  // longer resolves (deleted) simply drops - the history is a hint, never a claim that the account
  // is still there.
  //
  // Recents are read from the FULL set, not `scoped`, and the archived rule does not apply to them:
  // this is where you have been, and having opened something is stronger evidence you want it in the
  // nav than its status being an exit. The eye still governs the board; it does not govern your own
  // history. (Same call on the Initiatives sidebar, where hiding finished work emptied the section
  // right after it was used.)
  const byId = new Map(data.map((a) => [a.id, a]))
  const recentAccounts = recentIds
    .map((rid) => byId.get(rid))
    .filter((a): a is CrmAccount => !!a)
    .slice(0, RECENT_SHOWN)

  const navItems: NavItem[] = [
    {
      id: 'queue',
      label: 'Assign queue',
      icon: ListChecks,
      iconClass: queueCount ? 'text-warning' : undefined,
      badge: queueCount ? String(queueCount) : undefined,
    },
    ...viewItems,
    ...recentAccounts.map((a) => ({
      id: a.id,
      label: a.name,
      icon: crmStatusUi(a.status).icon,
      iconClass: crmStatusUi(a.status).color,
      badge: a.mrr_usd ? formatCurrency(a.mrr_usd) : undefined,
      section: 'Recent Accounts',
    })),
  ]

  // On the board, the highlighted item is the SELECTED preset - the one the URL names - and it stays
  // highlighted after you edit a filter, matching the bar (which keeps the name and marks it
  // changed). On an account, the account is highlighted instead.
  const activeNavId = onQueue ? 'queue' : (id ?? (crmView.selected ? `view:${crmView.selected}` : 'all'))

  const account = id ? data.find((a) => a.id === id) : undefined
  const crumbs: Crumb[] = [{ label: 'CRM', onClick: id ? () => void navigate({ to: '/crm' }) : undefined }]
  crumbs.push({ label: onQueue ? 'Assign queue' : id ? (account?.name ?? id) : 'All accounts' })

  const toggleProps = {
    shown: showAll,
    onToggle: () => setShowAll((v) => !v),
    hiddenCount,
    noun: 'archived',
  }

  return (
    <AppShell
      items={navItems}
      activeId={activeNavId}
      onSelect={(sel) => {
        if (sel === 'queue') return void navigate({ to: '/crm/queue' })
        if (sel.startsWith('view:')) {
          const name = sel.slice('view:'.length)
          crmView.select(name)
          // Selecting a lens means "show me the board through it", so it also brings you back from
          // wherever else in the CRM you are - an account page OR the assign queue. Checking only
          // for an open account left the queue (which has no `id`) selecting the preset and staying
          // put, so a click on "Pipeline" from there did nothing you could see.
          //
          // The preset rides ALONG on that navigation rather than being left to `select`'s own
          // `?preset=` write: two navigations in one tick race, and the second one won with the
          // search it was built from - the preset you were leaving. You clicked Pipeline and landed
          // on Everything.
          if (id || onQueue) void navigate({ to: '/crm', search: { preset: name } as never })
          return
        }
        void navigate(sel === 'all' ? { to: '/crm' } : { to: '/crm/$id', params: { id: sel } })
      }}
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
