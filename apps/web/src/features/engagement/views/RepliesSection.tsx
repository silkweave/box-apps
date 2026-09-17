import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { cn } from '@/lib/utils'
import { PageContainer, CenteredNote } from '@silkweave/box-ui'
import { channelIcon, type ChannelIconComponent } from '@/lib/channelIcons.tsx'
import { ShowAllContext } from '@/lib/showAll.tsx'
import { InboxItemDetail } from '../components/inbox/InboxItemDetail'
import { InboxItemRow } from '../components/inbox/InboxItemRow'
import { InboxZero } from '../components/inbox/InboxZero'
import type { UseInboxState } from '../lib/useInboxState'
import {
  INBOX_CHANNEL_LABEL,
  KIND_LABEL,
  type InboxChannel,
  type InboxData,
  type InboxItem,
  type InboxKind,
} from '../inbox-types'

// =================================================================================================
// Replies (Engagement → Replies) - the tactical inbox of things people said to/about us (replies,
// mentions, PR reviews, comments) across channels. Formerly the standalone Inbox view; renamed and
// re-parented under Engagement in the nav restructure. The item detail at
// /engagement/replies/$channel/$itemId is the landing target of the Lark alert cards (old
// /inbox/... links redirect there). Data + done-state are owned by the parent Engagement view (it
// needs the open count for the sidebar); this section is presentational. See features/engagement/SPEC.md.
// =================================================================================================

type Filter = 'all' | InboxChannel

export function RepliesSection({
  channel,
  itemId,
  data,
  error,
  inbox,
}: {
  channel?: InboxChannel
  itemId?: string
  data: InboxData | null
  error: string | null
  inbox: UseInboxState
}) {
  const { state, available, markDone, reopen } = inbox
  // The parent Engagement shell owns the shared show/hide-done toggle (sidebar eye + top bar).
  const showHandled = React.useContext(ShowAllContext)
  const navigate = useNavigate()
  const filter: Filter = channel ?? 'all'
  const setFilter = (f: Filter) =>
    void navigate(
      f === 'all'
        ? { to: '/engagement/$section', params: { section: 'replies' } }
        : { to: '/engagement/$section/$channel', params: { section: 'replies', channel: f } },
    )
  const openDetail = (it: InboxItem) =>
    void navigate({
      to: '/engagement/$section/$channel/$itemId',
      params: { section: 'replies', channel: it.channel, itemId: it.id },
    })

  if (error)
    return (
      <CenteredNote>
        Failed to load the replies: {error}
        <br />
        Is the backend (<code>@silkweave/box-server</code>) running?
      </CenteredNote>
    )
  if (!data) return <CenteredNote>Loading…</CenteredNote>

  const items = data.items
  const isDone = (it: InboxItem) => state.items[it.id] != null
  const open = items.filter((it) => !isDone(it))
  const handled = items.filter(isDone)

  const inFilter = (it: InboxItem) => filter === 'all' || it.channel === filter
  const openVisible = open.filter(inFilter)
  const handledVisible = handled.filter(inFilter)

  const channels = [...new Set(items.map((i) => i.channel))]

  // Detail page - the landing target of the Lark alert cards' "Open in dashboard" button.
  if (itemId) {
    const item = items.find((i) => i.id === itemId)
    return item ? (
      <InboxItemDetail
        item={item}
        done={isDone(item)}
        onDone={markDone}
        onReopen={reopen}
        onBack={() => setFilter(filter)}
      />
    ) : (
      <CenteredNote>
        Item <code>{itemId}</code> not found - it may predate the events window or the next data pull
        hasn't landed yet.
      </CenteredNote>
    )
  }

  // Group the visible open items by channel, then by kind.
  const byChannel = channels
    .filter((c) => filter === 'all' || c === filter)
    .map((c) => ({ channel: c, groups: groupByKind(openVisible.filter((i) => i.channel === c)) }))
    .filter((g) => g.groups.length > 0)

  const chip = (id: Filter, label: string, count: number, Icon?: ChannelIconComponent) => {
    const active = filter === id
    return (
      <button
        key={id}
        type='button'
        onClick={() => setFilter(id)}
        aria-pressed={active}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-label transition-colors',
          active
            ? 'border-accent bg-accent-tint text-accent'
            : 'border-border bg-bg text-muted-foreground hover:border-accent/40 hover:text-text',
        )}>
        {Icon && <Icon className='size-3' />}
        {label}
        {count > 0 && <span className='tabular-nums'>{count}</span>}
      </button>
    )
  }

  return (
    <PageContainer width='reading'>
      <div className='mb-6 flex flex-wrap items-center gap-1.5'>
        {chip('all', 'All', open.length)}
        {channels.map((c) => chip(c, INBOX_CHANNEL_LABEL[c], open.filter((i) => i.channel === c).length, channelIcon(c)))}
        {!available && (
          <span className='ml-auto text-label text-warning'>backend unreachable - changes won't save</span>
        )}
      </div>

      {openVisible.length === 0 ? (
        <InboxZero handledCount={handled.length} neverHadItems={items.length === 0} />
      ) : (
        <div className='space-y-9'>
          {byChannel.map(({ channel: ch, groups }) => (
            <section key={ch}>
              <h2 className='mb-3 flex items-center gap-2 text-heading-2 font-semibold text-text'>
                {INBOX_CHANNEL_LABEL[ch]}
                <span className='text-body-sm font-normal text-muted-foreground'>
                  {groups.reduce((n, g) => n + g.items.length, 0)}
                </span>
              </h2>
              {groups.map(({ kind, items: list }) => (
                <div key={kind} className='mt-4'>
                  <h3 className='mb-2 text-label uppercase tracking-[0.07em] text-muted-foreground'>{KIND_LABEL[kind]}</h3>
                  <div className='space-y-2.5'>
                    {list.map((it) => (
                      <InboxItemRow key={it.id} item={it} onDone={markDone} onOpen={openDetail} />
                    ))}
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}

      {showHandled && handledVisible.length > 0 && (
        <section className='mt-10 border-t border-border pt-6'>
          <h3 className='mb-3 text-label uppercase tracking-[0.07em] text-muted-foreground'>Done</h3>
          <div className='space-y-2.5'>
            {handledVisible.map((it) => (
              <InboxItemRow key={it.id} item={it} done onReopen={reopen} onOpen={openDetail} />
            ))}
          </div>
        </section>
      )}
    </PageContainer>
  )
}

function groupByKind(items: InboxItem[]): { kind: InboxKind; items: InboxItem[] }[] {
  const order: InboxKind[] = [
    'pr-review',
    'pr-review-comment',
    'issue-comment',
    'mention',
    'hn-comment',
    'hn-mention',
    'reddit-post-reply',
    'reddit-comment-reply',
    'reddit-mention',
  ]
  const m = new Map<InboxKind, InboxItem[]>()
  for (const it of items) (m.get(it.kind) ?? m.set(it.kind, []).get(it.kind)!).push(it)
  // Known kinds first in display order, then any unlisted kind (defensive - a new kind should
  // still render rather than silently vanish) in first-seen order.
  const ordered = [...order, ...[...m.keys()].filter((k) => !order.includes(k))]
  return ordered.filter((k) => m.has(k)).map((kind) => ({ kind, items: m.get(kind)! }))
}
