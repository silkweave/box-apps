// The Content working surface: one row per TOPIC, its channel pieces nested underneath. A topic is
// the idea (and the review gate the draft pipeline writes into); a piece is that idea on one
// channel. A topic with NO pieces is still a row - ten ideas a week that only appeared once somebody
// drafted them would defeat the point of reviewing them.
//
// Two layouts over one view model - a full-width list, and a lifecycle board. The layout is part of
// the preset, so "Board" is a lens someone picks rather than a mode with its own forgotten state.
// The board does not drag: a post's column is the LOWEST status of its pieces, so a drop would have
// to fire a different transition on each of them, and the content lifecycle deliberately routes
// those through named actions on a piece (see `contentView.ts`).
//
// Everything that shapes what is on screen is in ONE place, the board bar. The card grid this view
// used to be had a "Group by" control and nothing else - no filters, no search, no columns, no saved
// lenses - which is why "show me everything waiting on review" was a question you answered by
// scrolling.

import { useContext } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, ShieldCheck, ShieldX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge, GridFooter, GridHeader, PageContainer, UserChip } from '@silkweave/box-ui'
import { ShowAllContext } from '@/lib/showAll.tsx'
import { BoardKanban, type KanbanColumn } from '@silkweave/box-ui/board'
import { ViewBar } from '../../data/components/board/ViewBar.tsx'
import { AssetThumb } from '../components/AssetThumb.tsx'
import { ChannelLabel, CONTENT_STATUS_UI, ContentStatusChip } from '../components/contentMeta.tsx'
import { StatusLabel as PlanningStatusLabel } from '../../planning/components/status.tsx'
import { formatDate } from '../../../lib/format.ts'
import { useActiveUser } from '../../../lib/useActiveUser.ts'
import { useContentData } from '../lib/useContentData.ts'
import { useContentView } from '../lib/useContentView.ts'
import { usePersistedState } from '../../../lib/usePersistedState.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { userName } from '../../../user-types.ts'
import {
  CONTENT_COLUMNS,
  CONTENT_TERMINAL_STATUSES,
  NO_PIECES,
  applyContentView,
  contentBarSpec,
  contentBoardColumns,
  contentAggregates,
  contentGrid,
  verifyBucket,
  worstSeverity,
  type ContentColumnKey,
  type ContentPost,
} from '../lib/contentView.ts'
import { useColumnAggregates, useColumnWidths } from '../../../lib/gridColumns.ts'
import { rowCountLabel } from '../../../lib/rowCount.ts'
import { CONTENT_STATUS_META, pieceAssets, type ContentAsset, type ContentPiece } from '../content-types.ts'
import { appKey } from '@/lib/storage.ts'

export { resolvePieceOwner } from '../lib/contentView.ts'

export function ContentBoard() {
  const { topic } = useParams({ strict: false }) as { topic?: string }
  const { data } = useContentData()
  const { data: users } = useUsersData()
  const { userId: activeUserId, user: activeUser, filterMine } = useActiveUser()
  const showArchived = useContext(ShowAllContext)
  const navigate = useNavigate()
  const v = useContentView()
  // Posts start COLLAPSED (a product decision, 2026-08-12): a row is a post, and opening every one of them on
  // load makes a 15-post board a 50-row scroll where the thing you came to compare - the posts - is
  // the minority of what is on screen. So the stored list is the EXPANDED ids, not the collapsed
  // ones, under its own key: the old `collapsedPosts` list means the exact opposite, and reading it
  // forward would have opened precisely the posts somebody had shut.
  const [expanded, setExpanded] = usePersistedState<string[]>(
    appKey('content', 'expandedPosts'),
    [],
    (val) => Array.isArray(val) && val.every((x) => typeof x === 'string'),
  )
  // Widths, and what the footer totals, are per-browser user settings - deliberately outside the
  // preset, though the footer's choices are keyed BY the preset you are on (see `gridColumns.ts`).
  const { widths, setWidth } = useColumnWidths(appKey('content'))
  const aggregates = useColumnAggregates(appKey('content'), v.selected)

  if (!data) return null

  const ownerName = (id: string): string => {
    const u = users?.find((x) => x.id === id)
    return u ? userName(u) : id
  }
  const topicOwners = new Map(data.topics.map((t) => [t.id, t.owner]))
  // Scoped to one post when the route is - the bar still applies, so you can filter WITHIN a post.
  const scoped = topic ? data.pieces.filter((p) => p.topic_id === topic) : data.pieces
  const groups = applyContentView(scoped, v.view, {
    topics: topic ? data.topics.filter((t) => t.id === topic) : data.topics,
    topicOwners,
    showArchived,
    mineOnly: filterMine && !!activeUserId,
    activeUserId,
    ownerName,
  })
  const posts = groups.flatMap((g) => g.items)
  const totalPosts = topic ? 1 : data.topics.length
  // The view's own order, not the catalog's - which columns you took AND how you arranged them.
  const columns = v.view.columns.filter((k) => CONTENT_COLUMNS.some((c) => c.key === k))
  const grid = contentGrid(columns, widths)

  const openPiece = (p: ContentPiece): void =>
    void navigate({ to: '/content/$topic/$channel', params: { topic: p.topic_id, channel: p.channel } })
  const openPost = (id: string): void => void navigate({ to: '/content/$topic', params: { topic: id } })

  if (data.topics.length === 0)
    return (
      <div className='mx-auto max-w-3xl px-4 py-16 text-center text-body-sm text-muted-foreground'>
        No content topics yet. A topic is the idea; its pieces are that idea per channel. Create one with{' '}
        <code>topic-upsert</code>, or let the weekly draft pipeline write them.
      </div>
    )

  return (
    // Flush + headingless: see the note in `InitiativesGrid`. The breadcrumb carries the post name
    // when the route is scoped to one.
    // A full-height column: the GRID scrolls, not the page, which is what keeps the header and the
    // footer's totals on screen (see `GridFooter`).
    <PageContainer width='flush' className='flex h-full flex-col'>
      <ViewBar
        view={v}
        spec={{
          ...contentBarSpec(scoped, ownerName, topicOwners, v.view.layout),
          notice: filterMine && activeUser ? `Only ${activeUser.nickname || activeUser.id}'s` : undefined,
        }}
      />

      {v.view.layout === 'board' ? (
        <div className='min-h-0 flex-1 overflow-auto p-3'>
          <ContentKanban posts={posts} view={v.view} onOpen={openPost} />
        </div>
      ) : posts.length === 0 ? (
        <p className='px-4 py-12 text-center text-body-sm text-muted-foreground'>
          Nothing matches this view. Clear a filter, or pick another preset.
        </p>
      ) : (
        <div className='min-h-0 flex-1 overflow-auto'>
          {/* At least as tall as the scrollport - see the note in `CrmAccountsTable`. */}
          <div style={{ minWidth: grid.minWidth }} className='flex min-h-full flex-col'>
            <GridHeader columns={grid.columns} template={grid.template} onResize={setWidth} />
            {groups.map((g) => (
              <div key={g.key}>
                {g.label && (
                  <div className='flex items-center gap-2 border-b border-border bg-bg/50 px-2 py-1.5 text-label font-medium text-muted-foreground'>
                    {g.label}
                    <span className='tabular-nums'>{g.items.length}</span>
                  </div>
                )}
                {g.items.map((post) => (
                  <PostRow
                    key={post.id}
                    post={post}
                    columns={columns}
                    template={grid.template}
                    open={expanded.includes(post.id)}
                    onToggle={() =>
                      setExpanded((prev) =>
                        prev.includes(post.id) ? prev.filter((x) => x !== post.id) : [...prev, post.id],
                      )
                    }
                    onOpenPost={() => openPost(post.id)}
                    onOpenPiece={openPiece}
                  />
                ))}
              </div>
            ))}

            <GridFooter
              columns={grid.columns}
              template={grid.template}
              label={rowCountLabel(posts.length, totalPosts, { one: 'post', many: 'posts' })}
              sources={contentAggregates(posts, columns)}
              store={aggregates}
            />
          </div>
        </div>
      )}
    </PageContainer>
  )
}

/** How many channel glyphs the Channels cell shows before it counts the rest. Six, because that is
 *  every channel there is - the cap only ever fires if the vocabulary grows. */
const CHANNELS_SHOWN = 6

/** One post, with its matching pieces nested under it. The nested rows are the CHANNELS, which is
 *  what a person actually clicks through to - the post row itself opens the post's own page. */
function PostRow({
  post,
  columns,
  template,
  open,
  onToggle,
  onOpenPost,
  onOpenPiece,
}: {
  post: ContentPost
  columns: ContentColumnKey[]
  /** Handed down rather than recomputed: it depends on the reader's own column widths. */
  template: string
  open: boolean
  onToggle: () => void
  onOpenPost: () => void
  onOpenPiece: (p: ContentPiece) => void
}) {
  const feature = post.all.map((p) => pieceAssets(p.metadata).find((a) => a.usage === 'feature')).find(Boolean)
  const Caret = open ? ChevronDown : ChevronRight

  const cell = (key: ContentColumnKey) => {
    switch (key) {
      case 'channels':
        // Glyphs only - the names were the same six words repeated down every row of a narrow
        // column, and a row of icons is what you scan anyway. Each keeps its name as a tooltip.
        return (
          <span className='flex flex-wrap items-center gap-1.5'>
            {post.all.slice(0, CHANNELS_SHOWN).map((p) => (
              <ChannelLabel key={p.id} channel={p.channel} iconOnly />
            ))}
            {post.all.length > CHANNELS_SHOWN && (
              <span className='text-label text-muted-foreground'>+{post.all.length - CHANNELS_SHOWN}</span>
            )}
          </span>
        )
      case 'pieces':
        return (
          <Badge variant={post.published === post.live ? 'success' : 'neutral'} className='py-0 tabular-nums'>
            {post.published}/{post.live}
          </Badge>
        )
      case 'owner':
        return <UserChip userId={post.owner} showName />
      case 'verify': {
        const failing = post.all.filter((p) => verifyBucket(p) === 'failed').length
        const unchecked = post.all.filter((p) => verifyBucket(p) === 'unchecked').length
        if (failing > 0)
          return (
            <span className='inline-flex items-center gap-1 text-label text-danger'>
              <ShieldX className='size-3' /> {failing} with findings
            </span>
          )
        if (unchecked > 0) return <span className='text-label text-muted-foreground'>{unchecked} unchecked</span>
        return (
          <span className='inline-flex items-center gap-1 text-label text-success'>
            <ShieldCheck className='size-3' /> all verified
          </span>
        )
      }
      case 'published':
        return <span className='text-label tabular-nums text-muted-foreground'>{post.published_at ? formatDate(post.published_at) : '·'}</span>
      case 'updated':
        return <span className='text-label tabular-nums text-muted-foreground'>{formatDate(post.updated_at)}</span>
      case 'initiative':
        return <span className='truncate font-mono text-label text-muted-foreground'>{post.id}</span>
    }
  }

  return (
    <div className='border-b border-border-light last:border-b-0'>
      <div
        className='grid items-center gap-2 px-2 py-2 transition-colors hover:bg-accent-tint/40'
        style={{ gridTemplateColumns: template }}>
        <span className='flex min-w-0 items-center gap-1.5'>
          <button
            type='button'
            onClick={onToggle}
            aria-label={open ? `Collapse ${post.title}` : `Expand ${post.title}`}
            aria-expanded={open}
            className='shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent-tint hover:text-text'>
            <Caret className='size-3.5' />
          </button>
          <button type='button' onClick={onOpenPost} className='min-w-0 flex-1 text-left'>
            <span className='line-clamp-1 text-body-sm font-medium text-text hover:text-accent'>{post.title}</span>
          </button>
        </span>
        <AssetCell topicId={post.id} asset={feature} />
        {post.status ? <ContentStatusChip status={post.status} /> : <PlanningStatusLabel status={post.topicStatus} />}
        {columns.map((key) => (
          <span key={key} className='min-w-0'>
            {cell(key)}
          </span>
        ))}
        <button
          type='button'
          onClick={onOpenPost}
          aria-label={`Open ${post.title}`}
          className='justify-self-end rounded p-1 text-muted-foreground transition-colors hover:text-accent'>
          <ChevronRight className='size-4' />
        </button>
      </div>

      {open &&
        post.pieces.map((p) => (
          <button
            key={p.id}
            type='button'
            onClick={() => onOpenPiece(p)}
            className='grid w-full items-center gap-2 border-t border-border-light px-2 py-1.5 text-left transition-colors hover:bg-accent-tint/40'
            style={{ gridTemplateColumns: template }}>
            <span className='flex min-w-0 items-center gap-2 pl-6'>
              <ChannelLabel channel={p.channel} className='text-label' />
              {p.kind === 'canonical' && (
                <Badge variant='accent' className='py-0'>
                  canonical
                </Badge>
              )}
              <span className='line-clamp-1 text-label text-muted-foreground'>{p.title || p.id}</span>
            </span>
            {/* A channel adaptation carries its own art - the LinkedIn image is not the blog hero. */}
            <AssetCell topicId={p.topic_id} asset={pieceAssets(p.metadata).find((a) => a.usage === 'feature')} />
            <ContentStatusChip status={p.status} />
            {columns.map((key) => (
              <span key={key} className='min-w-0 text-label text-muted-foreground'>
                {key === 'owner' ? (
                  <UserChip userId={p.created_by} showName />
                ) : key === 'updated' ? (
                  <span className='tabular-nums'>{formatDate(p.updated_at)}</span>
                ) : key === 'published' ? (
                  <span className='tabular-nums'>{p.published_at ? formatDate(p.published_at) : '·'}</span>
                ) : key === 'verify' && p.verify ? (
                  p.verify.passed ? (
                    <span className='inline-flex items-center gap-1 text-success'>
                      <ShieldCheck className='size-3' /> verified
                    </span>
                  ) : (
                    // Red when something BLOCKS, amber when the verdict failed on warnings alone -
                    // the row has one line, so its colour is the only thing carrying the difference.
                    <span
                      className={cn(
                        'inline-flex items-center gap-1',
                        worstSeverity(p.verify.findings) === 'fail' ? 'text-danger' : 'text-warning',
                      )}>
                      <ShieldX className='size-3' />
                      {p.verify.findings.filter((f) => f.severity === 'fail').length} issue(s)
                    </span>
                  )
                ) : null}
              </span>
            ))}
            <ChevronRight className='size-4 justify-self-end text-muted-foreground' />
          </button>
        ))}
    </div>
  )
}

/**
 * The Asset column's cell: the feature image or video, cropped to a fixed thumbnail so the column
 * reads as a column. The board's CARDS show the asset at its true aspect ratio; a list cell cannot,
 * because a portrait image would set the height of a row whose other nine columns are one line tall.
 *
 * `·` when there is none - the grid's established "readable as empty", the alternative being a hole
 * that reads as a picture still loading.
 */
function AssetCell({ topicId, asset }: { topicId: string; asset: ContentAsset | undefined }) {
  if (!asset) return <span className='text-label text-fg-4'>·</span>
  return (
    <AssetThumb
      topicId={topicId}
      asset={asset}
      className='h-7 w-12 rounded border border-border object-cover'
    />
  )
}

/** The lifecycle board: posts bucketed by their lowest piece status. Read-only by design - see the
 *  file header and `BoardKanban`'s `onDrop`. */
function ContentKanban({
  posts,
  view,
  onOpen,
}: {
  posts: ContentPost[]
  view: Parameters<typeof contentBoardColumns>[0]
  onOpen: (id: string) => void
}) {
  const columns: KanbanColumn[] = contentBoardColumns(view).map((status) => ({
    key: status,
    label: CONTENT_STATUS_META[status].label,
    icon: CONTENT_STATUS_UI[status].icon,
    color: CONTENT_STATUS_UI[status].color,
    terminal: CONTENT_TERMINAL_STATUSES.includes(status),
  }))

  return (
    <BoardKanban
      items={posts}
      columns={columns}
      columnOf={(p) => p.status ?? NO_PIECES}
      idOf={(p) => p.id}
      cardLabel={(p) => p.title}
      renderColumnBadge={(_status, held) => (held.length > 0 ? null : null)}
      renderCard={(post) => {
        const feature = post.all.map((p) => pieceAssets(p.metadata).find((a) => a.usage === 'feature')).find(Boolean)
        return (
          <>
            {/* Bleeds to the card's edges and takes whatever height its own proportions ask for. It
                was a fixed 80px strip with `object-cover`, which centre-cropped every asset to the
                same letterbox - and a card is the one place with room to show the picture as it will
                actually be published. */}
            {feature && (
              <AssetThumb
                topicId={post.id}
                asset={feature}
                className='-mx-2.5 -mt-2.5 mb-2 block h-auto w-[calc(100%+1.25rem)] max-w-none rounded-t border-b border-border'
              />
            )}
            <div className='flex items-start gap-1'>
              <button type='button' onClick={() => onOpen(post.id)} className='min-w-0 flex-1 text-left outline-none'>
                <span className='line-clamp-2 font-medium text-text hover:text-accent'>{post.title}</span>
              </button>
              <UserChip userId={post.owner} />
            </div>
            <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
              {post.pieces.slice(0, 4).map((p) => (
                <ChannelLabel key={p.id} channel={p.channel} className='text-label' />
              ))}
              {post.pieces.length > 4 && (
                <span className='text-label text-muted-foreground'>+{post.pieces.length - 4}</span>
              )}
            </div>
            <div className='mt-1.5 flex items-center gap-2 border-t border-border-light pt-1.5 text-label'>
              <Badge variant={post.published === post.live ? 'success' : 'neutral'} className='py-0 tabular-nums'>
                {post.published}/{post.live} published
              </Badge>
              <span className={cn('ml-auto tabular-nums text-fg-4')}>{formatDate(post.updated_at)}</span>
            </div>
          </>
        )
      }}
    />
  )
}
