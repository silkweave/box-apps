import { Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { AppShell, type NavItem, type Crumb, CenteredNote } from '@silkweave/box-ui'
import { ShowAllContext, ShowAllEye, useShowAll } from '@/lib/showAll.tsx'
import { useGroupNav } from '../../../lib/nav.ts'
import { useContentData } from '../lib/useContentData.ts'
import { useActiveUser } from '../../../lib/useActiveUser.ts'
import { CHANNEL_UI, CONTENT_STATUS_UI } from '../components/contentMeta.tsx'
import { presetIcon } from '../../data/components/board/presetIcons.tsx'
import { useContentView } from '../lib/useContentView.ts'
import { useRecentIds } from '../../../lib/useRecentIds.ts'
import { postStatus, resolvePieceOwner } from '../lib/contentView.ts'
import type { ContentPiece } from '../content-types.ts'
import { appKey } from '@/lib/storage.ts'

/**
 * The Content shell: data fetch + a sidebar. The canvas (the board or one piece's detail) renders
 * through the Outlet, mirroring InitiativesLayout and CrmLayout - which is now literally true rather
 * than approximately: the sidebar carries the team's PRESETS first, then the posts you have opened
 * recently.
 *
 * It used to list every post with pieces, which is a second copy of the board: by the time it scrolls
 * it is slower than the board's own search, and it pushed everything else below the fold. Ten most
 * recent, per-browser (`localStorage`), deliberately not shared - where you have been is not team
 * state, unlike a preset.
 */
const RECENT_SHOWN = 10

export function ContentLayout() {
  const groupNav = useGroupNav('content')
  const navigate = useNavigate()
  const { topic, channel } = useParams({ strict: false }) as { topic?: string; channel?: string }
  const { data, error } = useContentData()
  const { userId: activeUserId, filterMine } = useActiveUser()
  // The same store the board's bar reads (module-level, not per-component), so selecting a preset
  // here and reading `selected` there cannot drift.
  const contentView = useContentView()
  // Visit history, newest first - recorded here because this is the component that both knows the
  // open id and renders the nav.
  const recentIds = useRecentIds(appKey('content', 'recentTopics'), topic)
  // Fully published posts count as "done" and hide by default; the shared toggle (sidebar eye +
  // top-bar action) reveals them. NOTE: the persisted key moved from `.showCompleted` to the
  // uniform `<prefix>.content.showAll` in the 2026-07-19 toggle unification.
  const [showCompleted, setShowCompleted] = useShowAll('content')

  if (error)
    return (
      <CenteredNote>
        Failed to reach the API: {error}
        <br />
        Start the backend: <code>pnpm dev</code>.
      </CenteredNote>
    )
  if (!data) return <CenteredNote>Loading…</CenteredNote>

  // Same owner resolution + "Only my items" scope as the board, so sidebar and canvas agree.
  const topicOwners = new Map(data.topics.map((t) => [t.id, t.owner]))
  const mineOnly = filterMine && !!activeUserId
  const scopedPieces = mineOnly
    ? data.pieces.filter((p) => resolvePieceOwner(p, topicOwners) === activeUserId)
    : data.pieces

  // Group by initiative in first-seen order. Archived pieces sit outside the lifecycle: they don't
  // drive the status icon or the published/total badge (unless an initiative is archived wholesale).
  const byInitiative = new Map<string, ContentPiece[]>()
  for (const p of scopedPieces) {
    const list = byInitiative.get(p.topic_id)
    if (list) list.push(p)
    else byInitiative.set(p.topic_id, [p])
  }

  // Fully published posts count as "done" and hide from the board unless the toggle is on. The count
  // is still computed here because the sidebar eye and the top-bar "Show N done" are two handles on
  // the same persisted switch, and both live in this shell.
  let doneCount = 0
  for (const [id, pieces] of byInitiative) {
    const live = pieces.filter((p) => p.status !== 'archived')
    const considered = live.length > 0 ? live : pieces
    if (considered.every((p) => p.status === 'published') && id !== topic) doneCount++
  }

  // Presets first, then posts. Their ids are namespaced (`preset:<name>`) because a preset named
  // "Published" and a topic slugged `published` must never collide in one flat nav.
  const presetItems: NavItem[] = contentView.presets.map((s) => ({
    id: `preset:${s.name}`,
    label: s.name,
    icon: presetIcon(s.icon),
    section: 'Presets',
  }))
  const recentPosts: NavItem[] = recentIds
    .filter((id) => byInitiative.has(id))
    .slice(0, RECENT_SHOWN)
    .map((id) => {
      const pieces = byInitiative.get(id)!
      const live = pieces.filter((p) => p.status !== 'archived')
      const considered = live.length > 0 ? live : pieces
      const published = considered.filter((p) => p.status === 'published').length
      const { icon, color } = CONTENT_STATUS_UI[postStatus(pieces)]
      return {
        id,
        label: id,
        icon,
        iconClass: color,
        badge: `${published}/${considered.length}`,
        section: 'Recent Content',
      }
    })
  const navItems: NavItem[] = [...presetItems, ...recentPosts]

  // On the board, the highlighted item is the SELECTED preset - the one the URL names - and it stays
  // highlighted after you edit a filter, matching the bar (which keeps the name and marks it
  // changed). On a post, the post is highlighted instead.
  const activeId = topic ?? (contentView.selected ? `preset:${contentView.selected}` : 'all')

  const onSelect = (sel: string) => {
    if (sel.startsWith('preset:')) {
      contentView.select(sel.slice('preset:'.length))
      // Selecting a lens means "show me the board through it", so it also brings you back from a
      // piece's detail page - otherwise the click would appear to do nothing.
      if (topic) void navigate({ to: '/content' })
      return
    }
    void navigate(sel === 'all' ? { to: '/content' } : { to: '/content/$topic', params: { topic: sel } })
  }

  const activePiece = topic && channel ? data.pieces.find((p) => p.id === `${topic}/${channel}`) : undefined
  const crumbs: Crumb[] = [{ label: 'Content', onClick: topic ? () => void navigate({ to: '/content' }) : undefined }]
  if (topic) {
    crumbs.push({
      label: topic,
      onClick: channel ? () => void navigate({ to: '/content/$topic', params: { topic } }) : undefined,
    })
    if (channel) {
      // The last crumb is a quick-switch dropdown across this topic's sibling channel pieces.
      const siblings = data.pieces
        .filter((p) => p.topic_id === topic)
        .sort((a, b) => (a.kind === b.kind ? a.channel.localeCompare(b.channel) : a.kind === 'canonical' ? -1 : 1))
      crumbs.push({
        label: activePiece ? (CHANNEL_UI[activePiece.channel]?.label ?? channel) : channel,
        menu: siblings.map((p) => ({
          label: CHANNEL_UI[p.channel]?.label ?? p.channel,
          value: p.channel,
          current: p.channel === channel,
          onSelect: () =>
            void navigate({ to: '/content/$topic/$channel', params: { topic, channel: p.channel } }),
        })),
      })
    }
  } else {
    crumbs.push({ label: 'Overview' })
  }

  const toggleProps = {
    shown: showCompleted,
    onToggle: () => setShowCompleted((v) => !v),
    hiddenCount: doneCount,
    noun: 'done',
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
      <ShowAllContext.Provider value={showCompleted}>
        <Outlet />
      </ShowAllContext.Provider>
    </AppShell>
  )
}
