import * as React from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import {
  AlertTriangle,
  Ban,
  Boxes,
  Check,
  CheckCheck,
  CheckCircle2,
  Copy,
  ExternalLink,
  Inbox as InboxIcon,
  Loader2,
  MessageSquare,
  Save as SaveIcon,
  SearchX,
  ShieldCheck,
  Trash2,
  Trophy,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppShell, PageContainer, PageHeader, type NavItem, Badge, Button, confirm, Dialog, DialogContent, DialogDescription, DialogTitle, SegmentedControl, CenteredNote, UserChip } from '@silkweave/box-ui'
import { ChannelGlyph } from '@/lib/channelIcons.tsx'
import { ShowAllContext, ShowAllEye, useShowAll } from '@/lib/showAll.tsx'
// Karma is Engagement's number, so it lives in Engagement's top bar rather than the app's - it was
// on every screen in the app, including the ones where nobody has ever wondered about it.
import { KarmaBadge } from '../components/KarmaBadge.tsx'
import { GenerateButton } from '../../../components/agent/GenerateCommand.tsx'
import { ChannelLabel } from '../../content/components/contentMeta.tsx'
import { useGroupNav } from '../../../lib/nav.ts'
import { useActiveUser } from '../../../lib/useActiveUser.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'
import {
  dismissPodEngagementAll,
  draftPodEngagement,
  recordPodEngagementAll,
  reloadPods,
  usePodsData,
  verifyPodEngagement,
} from '../lib/usePodsData.ts'
import { usePersistedState } from '../../../lib/usePersistedState.ts'
import { useInboxState } from '../lib/useInboxState.ts'
import { trpc } from '../../../lib/trpc.ts'
import { ACTION_ICON, ACTION_META } from '../engagement-types.ts'
import type { ContentChannel } from '../../content/content-types.ts'
import type { PodCard as PodCardT } from '../pods-types.ts'
import { INBOX_CHANNEL_LABEL, type InboxChannel, type InboxData } from '../inbox-types.ts'
import { InternalKarmaSection, QueueCardTile } from './PodsSections.tsx'
import { RepliesSection } from './RepliesSection.tsx'
import { appKey } from '@/lib/storage.ts'

/** The Engagement sections - Inbox is the pod engage-queue, Replies the tactical inbox, Karma
 *  the leaderboards. Reserved ids; an unknown `$section` (e.g. an old /engagement/<channel> link)
 *  falls back to `inbox`. */
type Section = 'inbox' | 'replies' | 'karma'
const SECTIONS: { id: Section; label: string; icon: NavItem['icon'] }[] = [
  { id: 'inbox', label: 'Inbox', icon: InboxIcon },
  { id: 'replies', label: 'Replies', icon: MessageSquare },
  { id: 'karma', label: 'Karma', icon: Trophy },
]

/** How the open queue is grouped: by pod, the post's author, or channel. */
type GroupBy = 'pod' | 'author' | 'channel'
const GROUP_BYS: GroupBy[] = ['pod', 'author', 'channel']
const GROUP_BY_LABEL: Record<GroupBy, string> = { pod: 'Pod', author: 'Author', channel: 'Channel' }

/** One rendered group of pod cards. `bordered` boxes the cluster like Content. */
interface CardGroup {
  key: string
  header: React.ReactNode
  items: PodCardT[]
  bordered?: boolean
}

/** One entrypoint, one rendering. It forked on role until 2026-09-10, when the collaborator tier
 *  and its self-scoped queue were removed. */
export function EngagementView() {
  return <InternalEngagementView />
}

/**
 * The internal Engagement view - three sections behind the `$section` param:
 * `inbox` (default) is the engage-queue: the active user's pod cards, newest first. ALL cross-team
 * amplification runs through pods since 2026-07-17 - the old derived "team matrix" layer (cards
 * straight from published content, no pod) is gone; curate a published piece into a pod
 * (`pod-content-add`) for it to appear here. `replies` is the tactical inbox (things said to/about
 * us; `$channel`/`$itemId` filter + detail). `karma` is the leaderboards. All scoped to the ACTIVE
 * user (top-right menu) where personal.
 */
function InternalEngagementView() {
  const groupNav = useGroupNav('engagement')
  const navigate = useNavigate()
  const params = useParams({ strict: false }) as { section?: string; channel?: string; itemId?: string }
  const section: Section = (SECTIONS.find((s) => s.id === params.section)?.id ?? 'inbox') as Section
  const { userId } = useActiveUser()
  const { data: podsData } = usePodsData()

  // Replies data + done-state live here (not in the section) so the sidebar count stays cheap and
  // consistent with what the section shows. Fetched per mount, like the old standalone Inbox view.
  const [inboxData, setInboxData] = React.useState<InboxData | null>(null)
  const [inboxError, setInboxError] = React.useState<string | null>(null)
  const inboxState = useInboxState()
  React.useEffect(() => {
    trpc.inboxData
      .query({})
      .then((d) => setInboxData(d as unknown as InboxData))
      .catch((e) => setInboxError(String(e)))
  }, [])

  const podOpen =
    podsData && userId
      ? podsData.cards.filter((c) => c.participant_kind === 'user' && c.participant_id === userId).length
      : 0
  const repliesOpen = inboxData ? inboxData.items.filter((i) => !inboxState.state.items[i.id]).length : 0
  // Handled replies hide by default; the shared toggle (sidebar eye + top-bar action, replies
  // section only) reveals them. RepliesSection reads it via ShowAllContext.
  const [showHandled, setShowHandled] = useShowAll('engagement')
  const handledCount = inboxData ? inboxData.items.length - repliesOpen : 0

  const navItems: NavItem[] = SECTIONS.map((s) => ({
    id: s.id,
    label: s.label,
    icon: s.icon,
    count: s.id === 'inbox' ? podOpen || undefined : s.id === 'replies' ? repliesOpen || undefined : undefined,
  }))
  const onSelect = (id: string) =>
    void navigate(id === 'inbox' ? { to: '/engagement' } : { to: '/engagement/$section', params: { section: id } })

  const crumbs = [{ label: 'Engagement' }, { label: SECTIONS.find((s) => s.id === section)?.label ?? 'Inbox' }]
  if (section === 'replies' && params.channel) crumbs.push({ label: INBOX_CHANNEL_LABEL[params.channel as InboxChannel] ?? params.channel })

  let body: React.ReactNode
  if (section === 'replies') {
    body = (
      <RepliesSection
        channel={params.channel as InboxChannel | undefined}
        itemId={params.itemId}
        data={inboxData}
        error={inboxError}
        inbox={inboxState}
      />
    )
  } else if (section === 'karma') {
    body = <InternalKarmaSection />
  } else {
    body = <PodInboxSection />
  }

  const toggleProps = {
    shown: showHandled,
    onToggle: () => setShowHandled((v) => !v),
    hiddenCount: handledCount,
    noun: 'done',
  }
  return (
    <AppShell
      items={navItems}
      activeId={section}
      onSelect={onSelect}
      groupNav={groupNav}
      topbar={{ crumbs, actions: <KarmaBadge /> }}
      groupAction={section === 'replies' && <ShowAllEye {...toggleProps} />}
>
      <ShowAllContext.Provider value={showHandled}>{body}</ShowAllContext.Provider>
    </AppShell>
  )
}

// =================================================================================================
// Inbox section - the active user's pod engage-queue
// =================================================================================================

/**
 * The engage-queue: the active user's pod cards ("I did this"/"Not this one"), one newest-first
 * list. Cards are derived from what's NOT yet recorded, so acting on a card makes it disappear.
 * NOTE: this queue is scoped to the ACTIVE user (top-right menu) while the topbar karma badge is
 * principal-scoped - they can disagree when impersonating another user.
 */
function PodInboxSection() {
  const { userId, user } = useActiveUser()
  const { data: podsData, error } = usePodsData()
  const { data: users } = useUsersData()
  const isGroupBy = (v: unknown): v is GroupBy => GROUP_BYS.includes(v as GroupBy)
  const [groupBy, setGroupBy] = usePersistedState<GroupBy>(appKey('engagement', 'groupBy'), 'pod', isGroupBy)
  const [channelFilter, setChannelFilter] = React.useState<string | null>(null)
  const [selectedId, setSelectedId] = React.useState<{ pod_content_id: string; verify?: boolean } | null>(null)

  // Drafts land from OUTSIDE this tab (the /engage skill over MCP), so poll while the inbox is
  // mounted - a saved draft shows up within ~5s ("draft ready" badge / dialog) without a manual
  // refresh. Skipped while the tab is hidden.
  React.useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) void reloadPods().catch(() => {})
    }, 5_000)
    return () => clearInterval(t)
  }, [])

  // The open queue, newest published first (the server order is freshest-first already).
  const cards: PodCardT[] = React.useMemo(
    () =>
      userId
        ? (podsData?.cards ?? []).filter((c) => c.participant_kind === 'user' && c.participant_id === userId)
        : [],
    [podsData, userId],
  )

  const channels = [...new Set(cards.map((c) => c.channel))].sort()
  const scoped = channelFilter ? cards.filter((c) => c.channel === channelFilter) : cards

  // The author chip: the submitting user's avatar; a curated piece with no submitter falls back to
  // its pod's title.
  const authorOf = React.useCallback(
    (card: PodCardT): { key: string; label: string; header: React.ReactNode } => {
      if (!card.author_kind || !card.author_id) {
        const title = podsData?.pods.find((p) => p.id === card.pod_id)?.title || card.pod_id
        return { key: `pod:${card.pod_id}`, label: title, header: <span className='text-body-sm font-medium text-text'>{title}</span> }
      }
      const label = users?.find((u) => u.id === card.author_id)?.nickname ?? card.author_id
      return { key: `user:${card.author_id}`, label, header: <UserChip userId={card.author_id} showName /> }
    },
    [podsData, users],
  )

  // Group the open queue by the persisted choice, preserving the newest-first order both within
  // and across groups.
  const groups: CardGroup[] = React.useMemo(() => {
    if (groupBy === 'author') {
      const map = new Map<string, { label: string; header: React.ReactNode; items: PodCardT[] }>()
      for (const card of scoped) {
        const a = authorOf(card)
        const g = map.get(a.key)
        if (g) g.items.push(card)
        else map.set(a.key, { label: a.label, header: a.header, items: [card] })
      }
      return [...map.entries()]
        .sort(([, a], [, b]) => a.label.localeCompare(b.label))
        .map(([key, g]) => ({ key, header: g.header, items: g.items }))
    }

    if (groupBy === 'channel') {
      return [...new Set(scoped.map((c) => c.channel))]
        .sort()
        .map((ch) => ({
          key: ch,
          header: <ChannelLabel channel={ch as ContentChannel} />,
          items: scoped.filter((c) => c.channel === ch),
        }))
    }

    // pod: one bordered container per pod.
    const map = new Map<string, CardGroup>()
    for (const card of scoped) {
      const g = map.get(card.pod_id)
      if (g) {
        g.items.push(card)
        continue
      }
      const title = podsData?.pods.find((p) => p.id === card.pod_id)?.title || card.pod_id
      map.set(card.pod_id, {
        key: card.pod_id,
        bordered: true,
        header: (
          <>
            <Boxes className='size-4 text-muted-foreground' />
            <h2 className='text-body-sm font-medium text-text'>{title}</h2>
          </>
        ),
        items: [card],
      })
    }
    return [...map.values()]
  }, [scoped, groupBy, podsData, authorOf])

  const liveSelected = selectedId
    ? (cards.find((c) => c.pod_content_id === selectedId.pod_content_id) ?? null)
    : null
  const lastSelectedRef = React.useRef<PodCardT | null>(null)
  if (liveSelected) lastSelectedRef.current = liveSelected

  if (error) {
    return (
      <CenteredNote>
        Failed to reach the API: {error}
        <br />
        Start the backend: <code>pnpm dev</code>.
      </CenteredNote>
    )
  }
  if (!userId) {
    return (
      <CenteredNote>
        No active user - the engagement queue is personal.
        <br />
        Pick yourself in the top-right user menu to see the posts waiting for your support.
      </CenteredNote>
    )
  }
  if (!podsData) return <CenteredNote>Loading…</CenteredNote>

  return (
    <PageContainer width='wide'>
      <PageHeader
        title='Inbox'
        description={
          <>
            Pod posts waiting for {user?.nickname || userId} to amplify them. Posts reach this queue
            through your pods; acting on a card (or opting out) makes it disappear, and cards age out
            after their window.
          </>
        }
      />

      <div className='mb-6 flex flex-wrap items-center gap-1.5'>
        <ChannelChip label='All' active={channelFilter === null} count={cards.length} onClick={() => setChannelFilter(null)} />
        {channels.map((ch) => (
          <ChannelChip
            key={ch}
            label={ch}
            channel={ch}
            active={channelFilter === ch}
            count={cards.filter((c) => c.channel === ch).length}
            onClick={() => setChannelFilter(channelFilter === ch ? null : ch)}
          />
        ))}
        <span className='ml-auto'>
          <SegmentedControl
            label='Group by'
            value={groupBy}
            options={GROUP_BYS.map((g) => ({ value: g, label: GROUP_BY_LABEL[g] }))}
            onChange={setGroupBy}
          />
        </span>
      </div>

      {scoped.length === 0 ? (
        <div className='rounded-lg border border-border bg-surface px-6 py-12 text-center text-body-sm text-muted-foreground'>
          <CheckCheck className='mx-auto mb-2 size-6 text-success' />
          All caught up - nothing waiting for you{channelFilter ? ` on ${channelFilter}` : ''}.
        </div>
      ) : (
        <div className='flex flex-col gap-5'>
          {groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <section key={g.key} className={cn(g.bordered && 'rounded-xl border border-border p-3 sm:p-4')}>
                <div className='mb-3 flex items-center gap-2'>
                  {g.header}
                  <span className='text-label text-muted-foreground tabular-nums'>{g.items.length}</span>
                </div>
                <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                  {g.items.map((card) => (
                    <QueueCardTile
                      key={card.pod_content_id}
                      card={card}
                      author={groupBy === 'author' ? undefined : authorOf(card).header}
                      onOpen={() => setSelectedId({ pod_content_id: card.pod_content_id })}
                      onVerify={() => setSelectedId({ pod_content_id: card.pod_content_id, verify: true })}
                    />
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}

      <PodCardDialog
        // Resolve from the live card list so a saved draft / reload shows up while the dialog is
        // open, but keep the last snapshot when a confirmed verify removes the card mid-dialog -
        // the "Confirmed and recorded" state must stay visible until the user closes it.
        card={selectedId ? (liveSelected ?? lastSelectedRef.current) : null}
        autoVerify={selectedId?.verify ?? false}
        authorOf={authorOf}
        onClose={() => setSelectedId(null)}
      />
    </PageContainer>
  )
}

/**
 * Card detail dialog - the post link, the expected action, the participant's own comment draft
 * (or the /engage snippet to generate one), and the actions. Verify kicks the deterministic
 * `pod-engagement-verify` backend op that checks from the engager's own session (detached run -
 * closing the dialog never kills it) and records + awards karma on `confirmed`; "Record manually"
 * stays as the attestation fallback; Dismiss opts out.
 */
function PodCardDialog({
  card,
  autoVerify = false,
  authorOf,
  onClose,
}: {
  card: PodCardT | null
  /** Kick the verify run as soon as the dialog opens (the tile's Verify button). */
  autoVerify?: boolean
  authorOf: (card: PodCardT) => { key: string; label: string; header: React.ReactNode }
  onClose: () => void
}) {
  const [note, setNote] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [verifying, setVerifying] = React.useState(false)
  const [progress, setProgress] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<{ verdict: 'confirmed' | 'not_found' | 'unknown'; detail: string } | null>(null)
  const [copied, setCopied] = React.useState<'draft' | null>(null)
  const [draftText, setDraftText] = React.useState('')
  const [savingDraft, setSavingDraft] = React.useState(false)
  const id = card?.pod_content_id
  const storedDraft = card?.draft_comment ?? ''
  const verifyRef = React.useRef<() => void>(() => {})
  React.useEffect(() => {
    setNote('')
    setResult(null)
    setProgress(null)
    setCopied(null)
    setDraftText(storedDraft)
    if (id && autoVerify) verifyRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset + optional kick on card change only
  }, [id])
  // A draft can land WHILE the dialog is open (the /engage skill saves over MCP; the inbox polls).
  // Adopt it only when the box is empty or still shows the previous stored value - never clobber
  // text the user is mid-typing.
  const prevStoredRef = React.useRef(storedDraft)
  React.useEffect(() => {
    setDraftText((cur) => (cur.trim() === '' || cur === prevStoredRef.current ? storedDraft : cur))
    prevStoredRef.current = storedDraft
  }, [storedDraft])
  if (!card) return null

  const remaining = card.actions.filter((a) => !card.done_actions.includes(a))
  const imperative = remaining.map((a) => ACTION_META[a]?.imperative ?? a).join(' + ')
  const confirmWhat = remaining.map((a) => ACTION_META[a]?.label.toLowerCase() ?? a).join(' + ')
  const wantsComment = card.actions.includes('comment')
  // The /engage skill writes drafts under the comment action; mirror that here.
  const draftAction = wantsComment ? ('comment' as const) : card.actions[0]
  // Once the comment is verified, the box shows the REAL posted comment (captured as evidence) -
  // read-only, since the engagement row is now verified and can't be redrafted.
  const commentDone = card.done_actions.includes(draftAction)
  const engageCommand = `/engage ${card.pod_content_id}`

  // Commit-on-blur like every other editable field in the app; also fired on dialog close so an
  // edit is never lost. Saving EMPTY clears the stored draft - the card returns to "no draft yet"
  // and the /engage handoff, so a fresh draft-gen run is one clear away.
  const commitDraft = () => {
    if (commentDone) return // verified - nothing to save or clear anymore
    const text = draftText.trim()
    if (text === storedDraft.trim()) return
    setSavingDraft(true)
    void draftPodEngagement(card.pod_content_id, card.participant_kind, card.participant_id, draftAction, text)
      .catch((e) => window.alert(String(e)))
      .finally(() => setSavingDraft(false))
  }

  const copy = (kind: 'draft', text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    })
  }
  const run = (fn: () => Promise<void>) => {
    setBusy(true)
    void fn()
      .then(onClose)
      .catch((e) => window.alert(String(e)))
      .finally(() => setBusy(false))
  }
  const verify = () => {
    setVerifying(true)
    setResult(null)
    verifyPodEngagement(card, setProgress)
      .then(setResult)
      .catch((e) => setResult({ verdict: 'unknown', detail: String((e as Error).message ?? e) }))
      .finally(() => {
        setVerifying(false)
        setProgress(null)
      })
  }
  verifyRef.current = verify
  const recordManually = async () => {
    if (
      !(await confirm({
        title: `Confirm you did: ${confirmWhat}?`,
        message: 'This records a manual attestation without a browser check.',
        confirmLabel: 'Record it',
      }))
    )
      return
    run(() => recordPodEngagementAll(card, note.trim() || undefined))
  }
  const dismiss = async () => {
    if (
      !(await confirm({
        title: 'Remove this post from your queue?',
        message: "It won't count as an engagement. (To just close the card dialog and keep the post, hit Cancel.)",
        confirmLabel: 'Remove it',
        danger: true,
      }))
    )
      return
    run(() => dismissPodEngagementAll(card, note.trim() || undefined))
  }

  const confirmed = result?.verdict === 'confirmed'

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return
        commitDraft() // Esc / backdrop close must not eat an unsaved draft edit
        onClose()
      }}>
      <DialogContent>
        <DialogTitle>{card.title || card.pod_content_id}</DialogTitle>
        <DialogDescription className='flex flex-wrap items-center gap-x-3 gap-y-1'>
          {authorOf(card).header}
          <ChannelLabel channel={card.channel as ContentChannel} />
          {card.published_at && <span>published {card.published_at.slice(0, 10)}</span>}
        </DialogDescription>

        <div className='flex flex-col gap-3 text-body-sm text-text'>
          <div className='flex flex-wrap items-center gap-1.5'>
            {card.actions.map((a) => {
              const isDone = card.done_actions.includes(a)
              const Icon = ACTION_ICON[a]
              return (
                <Badge
                  key={a}
                  variant={isDone ? 'success' : 'accent'}
                  title={`${ACTION_META[a]?.label ?? a}${isDone ? ' - done' : ''}`}
                  className='inline-flex items-center gap-0.5 py-0.5'>
                  {isDone && <Check className='size-3' />}
                  {Icon ? <Icon className='size-3' aria-label={ACTION_META[a]?.label ?? a} /> : (ACTION_META[a]?.label ?? a)}
                </Badge>
              )
            })}
          </div>
          <p>
            <span className='font-medium'>{imperative}</span>
            <span className='text-muted-foreground'>
              {' '}
              - then hit Verify to confirm it from your own session. {card.days_left}d left before
              this card ages out.
            </span>
          </p>
          <a
            href={card.url}
            target='_blank'
            rel='noreferrer'
            className='inline-flex items-center gap-1.5 text-accent hover:underline'>
            <ExternalLink className='size-3.5' /> Open the post
          </a>
          {card.advice?.hint && <p className='text-label text-muted-foreground'>Suggested: {card.advice.hint}</p>}

          {wantsComment && (
          <div className={cn('rounded-md border bg-bg p-2.5', storedDraft ? 'border-border' : 'border-dashed border-border')}>
            <div className='mb-1.5 flex items-center gap-2'>
              <Badge variant={commentDone || storedDraft ? 'success' : 'neutral'} className='py-0'>
                {commentDone ? 'verified comment' : storedDraft ? 'your draft' : 'no draft yet'}
              </Badge>
              <span className='ml-auto flex items-center gap-3'>
                {(commentDone ? storedDraft : draftText.trim()) && (
                  <button
                    type='button'
                    onClick={() => copy('draft', commentDone ? storedDraft : draftText)}
                    className='inline-flex items-center gap-1 text-label text-accent hover:underline'>
                    {copied === 'draft' ? <Check className='size-3' /> : <Copy className='size-3' />}
                    {copied === 'draft' ? 'Copied' : 'Copy'}
                  </button>
                )}
                {commentDone ? null : savingDraft ? (
                  <span className='inline-flex items-center gap-1 text-label text-muted-foreground'>
                    <Loader2 className='size-3 animate-spin' /> Saving…
                  </span>
                ) : draftText.trim() !== storedDraft.trim() ? (
                  <button
                    type='button'
                    onClick={commitDraft}
                    className='inline-flex items-center gap-1 text-label text-accent hover:underline'>
                    {draftText.trim() ? <SaveIcon className='size-3' /> : <Trash2 className='size-3' />}
                    {draftText.trim() ? 'Save' : 'Clear draft'}
                  </button>
                ) : storedDraft ? (
                  <span className='text-label text-muted-foreground'>Saved</span>
                ) : null}
              </span>
            </div>
            {commentDone ? (
              <p className='whitespace-pre-wrap rounded-md border border-border bg-surface px-2.5 py-1.5 text-body-sm text-text'>
                {storedDraft || 'Comment verified (no text captured).'}
              </p>
            ) : (
            <textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onBlur={commitDraft}
              placeholder='Write your comment here, or generate one in your voice with the command below.'
              rows={4}
              className='w-full resize-y rounded-md border border-border bg-surface px-2.5 py-1.5 text-body-sm text-text placeholder:text-muted-foreground focus:outline-none focus-visible:border-ring'
            />
            )}
            {!storedDraft && !draftText.trim() && (
              <div className='mt-1.5 flex min-w-0 items-center gap-2'>
                <GenerateButton
                  label='Draft with Claude'
                  command={engageCommand}
                  title='Draft this engagement comment'
                  description={
                    <>
                      Reads the post behind this card, works out a comment worth posting, and writes it
                      in your own voice onto the card. It saves a <strong>draft</strong> only - it never
                      posts, comments, reacts or likes.
                    </>
                  }
                />
              </div>
            )}
          </div>
          )}

          {!confirmed && (
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder='Optional note (manual-record remark, or why you are dismissing)'
              rows={2}
              className='w-full resize-none rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text placeholder:text-muted-foreground focus:outline-none focus-visible:border-ring'
            />
          )}
          {verifying && progress && (
            <p className='flex items-start gap-1.5 text-body-sm text-muted-foreground'>
              <Loader2 className='mt-0.5 size-3.5 shrink-0 animate-spin' /> {progress}
            </p>
          )}
          {result && <VerdictBanner result={result} />}
        </div>

        <div className='flex items-center justify-end gap-2'>
          {confirmed ? (
            <Button onClick={onClose}>
              <CheckCircle2 className='size-4' /> Done
            </Button>
          ) : (
            <>
              <Button variant='ghost' disabled={busy || verifying} onClick={dismiss}>
                <Ban className='size-4' /> Remove from queue
              </Button>
              <Button variant='outline' disabled={busy || verifying} onClick={recordManually}>
                Record manually
              </Button>
              <Button disabled={busy || verifying} onClick={verify}>
                {verifying ? <Loader2 className='size-4 animate-spin' /> : <ShieldCheck className='size-4' />}
                {verifying ? 'Checking…' : 'Verify'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Inline verdict of the last verify run: confirmed (recorded + karma), not_found (do it, retry),
 *  or unknown (browser unreachable / DOM drift - record manually as the fallback). */
function VerdictBanner({ result }: { result: { verdict: 'confirmed' | 'not_found' | 'unknown'; detail: string } }) {
  const styles = {
    confirmed: { icon: CheckCircle2, cls: 'border-success/30 bg-success-bg text-success', title: 'Confirmed and recorded' },
    not_found: { icon: SearchX, cls: 'border-warning/30 bg-warning-bg text-warning', title: 'Not found yet' },
    unknown: { icon: AlertTriangle, cls: 'border-danger/30 bg-danger-bg text-danger', title: 'Could not verify' },
  }[result.verdict]
  const Icon = styles.icon
  return (
    <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2', styles.cls)}>
      <Icon className='mt-0.5 size-4 shrink-0' />
      <div className='min-w-0'>
        <p className='font-medium'>{styles.title}</p>
        <p className='mt-0.5 text-body-sm opacity-90'>{result.detail}</p>
      </div>
    </div>
  )
}

function ChannelChip({ label, channel, active, count, onClick }: { label: string; channel?: string; active: boolean; count: number; onClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-label transition-colors',
        active
          ? 'border-accent bg-accent-tint text-accent'
          : 'border-border bg-bg text-muted-foreground hover:border-accent/40 hover:text-text',
      )}>
      {channel && <ChannelGlyph channel={channel} className='size-3 shrink-0' />}
      {label}
      {count > 0 && <span className='tabular-nums'>{count}</span>}
    </button>
  )
}
