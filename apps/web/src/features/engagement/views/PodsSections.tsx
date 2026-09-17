import * as React from 'react'
import { ArrowDown, ArrowUp, Check, Copy, ExternalLink, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge, Button, Dialog, DialogContent, DialogDescription, DialogTitle, PageContainer, PageHeader, SegmentedControl, confirm, CenteredNote } from '@silkweave/box-ui'
import { ChannelGlyph } from '@/lib/channelIcons.tsx'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { useContentData } from '../../content/lib/useContentData.ts'
import { usePersistedState } from '../../../lib/usePersistedState.ts'
import { userName, type User } from '../../../user-types.ts'
import {
  addMember,
  deletePod,
  deletePodContent,
  dismissPodEngagementAll,
  removeMember,
  setAutoContentEnabled,
  upsertPod,
  upsertPodContent,
  usePodsData,
} from '../lib/usePodsData.ts'
import {
  POD_STATUS_META,
  pKey,
  type EngagementAction,
  type Pod,
  type PodCard as PodCardT,
  type PodContent,
  type PodsOverview,
  type ParticipantKind,
} from '../pods-types.ts'
import { ACTION_ICON, ACTION_META } from '../engagement-types.ts'
import { appKey } from '@/lib/storage.ts'

// =================================================================================================
// The internal pods sections, re-parented after the nav restructure: the admin CRUD surface renders
// inside Settings → Pods, the karma leaderboards inside Engagement → Karma, and QueueCardTile ("I
// did this") inside the merged Engagement inbox. The old standalone Pods view is gone - its "My
// queue" section merged into the Engagement inbox. See features/engagement/SPEC.md.
// =================================================================================================

const inputCls =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

/** How each pod's content list is grouped: by main post (initiative), channel, or submitter. */
type PodGroupBy = 'post' | 'channel' | 'submitter'
const POD_GROUP_BYS: PodGroupBy[] = ['post', 'channel', 'submitter']
const POD_GROUP_BY_LABEL: Record<PodGroupBy, string> = { post: 'Post', channel: 'Channel', submitter: 'Submitter' }

/**
 * Group a pod's content by the chosen dimension, preserving the incoming (newest-first) order both
 * within and across groups. `post` clusters team pieces by their linked initiative (the main post);
 * collaborator submissions and team pieces with no initiative fall into one "Submitted / no post"
 * group. `submitter` keys on who curated it in (a participant, else "Team").
 */
function groupPodContent(
  content: PodContent[],
  by: PodGroupBy,
  topicTitleOf: (id: string) => string,
  nameOf: (k: ParticipantKind, id: string) => string,
): { key: string; label: string; items: PodContent[] }[] {
  const groups = new Map<string, { label: string; items: PodContent[] }>()
  const push = (key: string, label: string, piece: PodContent) => {
    const g = groups.get(key)
    if (g) g.items.push(piece)
    else groups.set(key, { label, items: [piece] })
  }
  for (const p of content) {
    if (by === 'channel') push(p.channel, p.channel, p)
    else if (by === 'submitter') {
      if (p.submitter_kind && p.submitter_id) push(`${p.submitter_kind}:${p.submitter_id}`, nameOf(p.submitter_kind, p.submitter_id), p)
      else push('team', 'Team', p)
    } else if (p.topic_id) push(p.topic_id, topicTitleOf(p.topic_id), p)
    else push('_submitted', 'Submitted / no post', p)
  }
  return [...groups.entries()].map(([key, g]) => ({ key, label: g.label, items: g.items }))
}

// =================================================================================================
// Participant name resolution
// =================================================================================================

export function useNameResolver(_data: PodsOverview, users: User[]) {
  return React.useCallback(
    (_kind: ParticipantKind, id: string): string => users.find((u) => u.id === id)?.nickname ?? id,
    [users],
  )
}

// =================================================================================================
// Queue card tile - one "I did this" pod card, rendered by the merged Engagement inbox
// =================================================================================================

export function QueueCardTile({
  card,
  author,
  onOpen,
  onVerify,
}: {
  card: PodCardT
  /** Author chip (avatar / name), passed in when the surrounding group doesn't already carry it. */
  author?: React.ReactNode
  /** Open the card's detail dialog (draft comment, verify, record, dismiss). */
  onOpen?: () => void
  /** Open the detail dialog AND kick the verify run immediately. */
  onVerify?: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const run = (fn: () => Promise<void>) => {
    setBusy(true)
    void fn()
      .catch((e) => window.alert(String(e)))
      .finally(() => setBusy(false))
  }
  const not = async () => {
    if (
      !(await confirm({
        title: 'Remove this post from your queue?',
        message: "It won't count as an engagement.",
        confirmLabel: 'Remove it',
        danger: true,
      }))
    )
      return
    run(() => dismissPodEngagementAll(card))
  }
  const copy = () => {
    if (!card.advice?.draft_comment) return
    void navigator.clipboard.writeText(card.advice.draft_comment).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } } : undefined}
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 shadow-(--shadow-sm) transition-colors hover:border-accent/40',
        onOpen && 'cursor-pointer',
      )}>
      <div className='flex items-center gap-2'>
        <Badge variant='neutral' className='py-0 uppercase'>
          <ChannelGlyph channel={card.channel} className='size-3 shrink-0' />
          {card.channel}
        </Badge>
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
        {card.draft_comment && (
          <Badge variant='success' className='py-0'>
            draft ready
          </Badge>
        )}
        <span className='ml-auto flex items-center gap-2'>
          {author}
          <span className={cn('text-label tabular-nums text-muted-foreground', card.days_left <= 3 && 'text-warning')}>
            {card.days_left}d left
          </span>
        </span>
      </div>
      <a
        href={card.url}
        target='_blank'
        rel='noreferrer'
        onClick={(e) => e.stopPropagation()}
        className='inline-flex items-start gap-1.5 text-body-sm font-medium leading-snug text-text hover:text-accent'
      >
        <ExternalLink className='mt-0.5 size-3.5 shrink-0 text-muted-foreground' />
        <span className='line-clamp-2'>{card.title || card.url}</span>
      </a>
      {card.advice?.hint && <p className='text-label text-muted-foreground'>Suggested: {card.advice.hint}</p>}
      {card.advice?.draft_comment && (
        <div className='rounded-md border border-border bg-bg p-2 text-label text-muted-foreground'>
          <p className='line-clamp-3 whitespace-pre-wrap'>{card.advice.draft_comment}</p>
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              copy()
            }}
            className='mt-1 inline-flex items-center gap-1 text-accent hover:underline'
          >
            {copied ? <Check className='size-3' /> : <Copy className='size-3' />} {copied ? 'Copied' : 'Copy comment'}
          </button>
        </div>
      )}
      <div className='mt-1 flex items-center gap-2'>
        <Button
          size='sm'
          variant='outline'
          onClick={(e) => {
            e.stopPropagation()
            window.open(card.url, '_blank', 'noopener')
          }}>
          <ExternalLink className='size-3.5' /> View Thread
        </Button>
        {onVerify && (
          <Button size='sm' disabled={busy} onClick={(e) => { e.stopPropagation(); onVerify() }}>
            <ShieldCheck className='size-3.5' /> Verify
          </Button>
        )}
        <Button size='sm' variant='ghost' disabled={busy} onClick={(e) => { e.stopPropagation(); not() }}>
          Remove from Queue
        </Button>
      </div>
    </div>
  )
}

// =================================================================================================
// Pods admin section (Settings → Pods)
// =================================================================================================

/** Self-contained wrapper for Settings: loads the pods overview + users, renders the admin CRUD. */
export function PodsAdminSection() {
  const { data, error } = usePodsData()
  const { data: users } = useUsersData()

  if (error) {
    return (
      <CenteredNote>
        Failed to reach the API: {error}
        <br />
        Start the backend: <code>pnpm dev</code>.
      </CenteredNote>
    )
  }
  if (!data) return <CenteredNote>Loading…</CenteredNote>
  return <PodsSection data={data} users={users ?? []} />
}

function PodsSection({ data, users }: { data: PodsOverview; users: User[] }) {
  const [podDialog, setPodDialog] = React.useState<{ mode: 'new' } | { mode: 'edit'; pod: Pod } | null>(null)
  const [memberFor, setMemberFor] = React.useState<Pod | null>(null)
  const [contentFor, setContentFor] = React.useState<{ pod: Pod; piece?: PodContent } | null>(null)
  const nameOf = useNameResolver(data, users)
  // A team piece's main post is a content TOPIC (pod_content.topic_id); resolve its title.
  const content = useContentData()
  const topicTitleOf = React.useCallback(
    (id: string) => content.data?.topics.find((t) => t.id === id)?.title ?? id,
    [content.data],
  )
  const isPodGroupBy = (v: unknown): v is PodGroupBy => POD_GROUP_BYS.includes(v as PodGroupBy)
  const [groupBy, setGroupBy] = usePersistedState<PodGroupBy>(appKey('pods', 'groupBy'), 'post', isPodGroupBy)

  return (
    <PageContainer width='wide'>
      <PageHeader
        title='Pods'
        description="Topic networks of internal + external participants who amplify each other's content."
        actions={
          <>
            <SegmentedControl
              label='Group by'
              value={groupBy}
              options={POD_GROUP_BYS.map((g) => ({ value: g, label: POD_GROUP_BY_LABEL[g] }))}
              onChange={setGroupBy}
            />
            <Button size='sm' onClick={() => setPodDialog({ mode: 'new' })}>
              <Plus /> New pod
            </Button>
          </>
        }
      />

      {data.autoContent && (
        <div className='mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-(--shadow-sm)'>
          <div className='text-body-sm text-text'>
            Auto-add published content
            <p className='mt-0.5 text-label text-muted-foreground'>
              Pieces published on {data.autoContent.channels.join(', ')} land in{' '}
              <span className='font-medium'>{data.pods.find((p) => p.id === data.autoContent?.pod)?.title ?? data.autoContent.pod}</span>{' '}
              automatically.
            </p>
          </div>
          <label className='inline-flex cursor-pointer items-center gap-2 text-body-sm text-muted-foreground'>
            <input
              type='checkbox'
              checked={data.autoContent.enabled}
              onChange={(e) => void setAutoContentEnabled(e.target.checked)}
              className='accent-(--accent)'
            />
            Enabled
          </label>
        </div>
      )}

      {data.pods.length === 0 ? (
        <div className='grid place-items-center rounded-lg border border-dashed border-border py-16 text-center text-body-sm text-muted-foreground'>
          No pods yet. Create one to start grouping people around a topic.
        </div>
      ) : (
        <div className='flex flex-col gap-4'>
          {data.pods.map((pod) => (
            <PodCard
              key={pod.id}
              pod={pod}
              data={data}
              nameOf={nameOf}
              groupBy={groupBy}
              topicTitleOf={topicTitleOf}
              onEdit={() => setPodDialog({ mode: 'edit', pod })}
              onAddMember={() => setMemberFor(pod)}
              onAddContent={() => setContentFor({ pod })}
              onEditContent={(piece) => setContentFor({ pod, piece })}
            />
          ))}
        </div>
      )}

      <PodDialog
        key={podDialog?.mode === 'edit' ? podDialog.pod.id : 'new'}
        state={podDialog}
        users={users}
        existingIds={data.pods.map((p) => p.id)}
        onClose={() => setPodDialog(null)}
      />
      {memberFor && <MemberDialog pod={memberFor} data={data} users={users} onClose={() => setMemberFor(null)} />}
      {contentFor && (
        <ContentDialog
          pod={contentFor.pod}
          piece={contentFor.piece}
          onClose={() => setContentFor(null)}
        />
      )}
    </PageContainer>
  )
}

function PodCard({
  pod,
  data,
  nameOf,
  groupBy,
  topicTitleOf,
  onEdit,
  onAddMember,
  onAddContent,
  onEditContent,
}: {
  pod: Pod
  data: PodsOverview
  nameOf: (k: ParticipantKind, id: string) => string
  groupBy: PodGroupBy
  topicTitleOf: (id: string) => string
  onEdit: () => void
  onAddMember: () => void
  onAddContent: () => void
  onEditContent: (piece: PodContent) => void
}) {
  const members = data.members.filter((m) => m.pod_id === pod.id)
  const content = data.content.filter((c) => c.pod_id === pod.id)
  const contentGroups = groupPodContent(content, groupBy, topicTitleOf, nameOf)
  const cardCount = data.cards.filter((c) => c.pod_id === pod.id).length
  const statusMeta = POD_STATUS_META[pod.status]

  return (
    <div className='rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex items-center gap-2'>
            <h2 className='font-medium text-text'>{pod.title || pod.id}</h2>
            <span className={cn('text-label', statusMeta.tone)}>{statusMeta.label}</span>
          </div>
          {pod.description && <p className='mt-0.5 line-clamp-2 text-body-sm text-muted-foreground'>{pod.description}</p>}
          <p className='mt-1 text-label text-fg-4'>
            <code>{pod.id}</code>
            {pod.owner && <> · owner {pod.owner}</>} · {cardCount} open card{cardCount === 1 ? '' : 's'}
          </p>
        </div>
        <div className='flex shrink-0 items-center gap-1'>
          <Button size='sm' variant='ghost' onClick={onEdit}>
            Edit
          </Button>
          <button
            type='button'
            title='Delete pod'
            aria-label='Delete pod'
            onClick={() =>
              void confirm({
                title: `Delete pod "${pod.title || pod.id}"?`,
                message: 'Its members, content, and engagements go with it.',
                confirmLabel: 'Delete pod',
                danger: true,
              }).then((ok) => void (ok && deletePod(pod.id)))
            }
            className='rounded p-1.5 text-muted-foreground hover:bg-danger/10 hover:text-danger'
          >
            <Trash2 className='size-4' />
          </button>
        </div>
      </div>

      {/* members */}
      <div className='mt-3'>
        <div className='mb-1.5 flex items-center justify-between'>
          <span className='text-label font-medium text-muted-foreground'>Members ({members.length})</span>
          <Button size='sm' variant='ghost' onClick={onAddMember}>
            <UserPlus className='size-3.5' /> Add
          </Button>
        </div>
        {members.length === 0 ? (
          <p className='text-label text-fg-4'>No members yet.</p>
        ) : (
          <div className='flex flex-wrap gap-1.5'>
            {members.map((m) => (
              <span
                key={pKey(m.participant_kind, m.participant_id)}
                className='group inline-flex items-center gap-1 rounded-full border border-border bg-bg py-0.5 pl-2 pr-1 text-label'
              >
                <span className='text-text'>{nameOf(m.participant_kind, m.participant_id)}</span>
                {m.role === 'admin' && <span className='text-fg-4'>admin</span>}
                <button
                  type='button'
                  aria-label='Remove member'
                  onClick={() => void removeMember(pod.id, m.participant_kind, m.participant_id)}
                  className='rounded-full p-0.5 text-fg-4 opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger group-hover:opacity-100'
                >
                  <Trash2 className='size-3' />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* content */}
      <div className='mt-3'>
        <div className='mb-1.5 flex items-center justify-between'>
          <span className='text-label font-medium text-muted-foreground'>Content ({content.length})</span>
          <Button size='sm' variant='ghost' onClick={onAddContent}>
            <Plus className='size-3.5' /> Add
          </Button>
        </div>
        {content.length === 0 ? (
          <p className='text-label text-fg-4'>No content curated into this pod yet.</p>
        ) : (
          <div className='flex flex-col gap-2.5'>
            {contentGroups.map((g) => (
              <div key={g.key}>
                <div className='mb-1 flex items-center gap-2 text-label text-fg-4'>
                  <span className='font-medium uppercase tracking-wide'>{g.label}</span>
                  <span className='tabular-nums'>{g.items.length}</span>
                </div>
                <div className='flex flex-col divide-y divide-border rounded-md border border-border'>
                  {g.items.map((piece) => (
                    <PodContentRow
                      key={piece.id}
                      piece={piece}
                      showChannel={groupBy !== 'channel'}
                      onEditContent={onEditContent}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** One curated pod-content row. `showChannel` hides the channel badge when the group already keys
 *  on channel (avoids repeating it in every row). */
function PodContentRow({
  piece,
  showChannel,
  onEditContent,
}: {
  piece: PodContent
  showChannel: boolean
  onEditContent: (piece: PodContent) => void
}) {
  return (
    <div className='flex items-center gap-2 px-2.5 py-2'>
      {showChannel && (
        <Badge variant='neutral' className='shrink-0 uppercase'>
          <ChannelGlyph channel={piece.channel} className='size-3 shrink-0' />
          {piece.channel}
        </Badge>
      )}
      <div className='min-w-0 flex-1'>
        <a href={piece.url} target='_blank' rel='noreferrer' className='line-clamp-1 text-body-sm text-text hover:text-accent hover:underline'>
          {piece.title || piece.url}
        </a>
        <p className='line-clamp-1 text-label text-fg-4'>
          team ·{' '}
          {piece.advice
            ? `${
                (piece.advice.actions ?? (piece.advice.action ? [piece.advice.action] : []))
                  .map((a) => ACTION_META[a]?.label ?? a)
                  .join(' + ') || 'channel-default'
              } advice set`
            : 'no advice'}
        </p>
      </div>
      <button type='button' aria-label='Edit content' onClick={() => onEditContent(piece)} className='rounded p-1 text-muted-foreground hover:bg-accent-tint hover:text-accent'>
        <span className='text-label'>Edit</span>
      </button>
      <button
        type='button'
        aria-label='Remove content'
        onClick={() =>
          void confirm({
            title: 'Remove this piece from the pod?',
            confirmLabel: 'Remove it',
            danger: true,
          }).then((ok) => void (ok && deletePodContent(piece.id)))
        }
        className='rounded p-1 text-muted-foreground hover:bg-danger/10 hover:text-danger'
      >
        <Trash2 className='size-3.5' />
      </button>
    </div>
  )
}

function PodDialog({
  state,
  users,
  existingIds,
  onClose,
}: {
  state: { mode: 'new' } | { mode: 'edit'; pod: Pod } | null
  users: User[]
  existingIds: string[]
  onClose: () => void
}) {
  const editing = state?.mode === 'edit' ? state.pod : null
  const [title, setTitle] = React.useState(editing?.title ?? '')
  const [description, setDescription] = React.useState(editing?.description ?? '')
  const [owner, setOwner] = React.useState(editing?.owner ?? '')
  const [status, setStatus] = React.useState(editing?.status ?? 'active')
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const open = state !== null
  const id = editing ? editing.id : slugify(title)
  const duplicate = !editing && !!id && existingIds.includes(id)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return setError('A title is required (it seeds the id).')
    if (!id) return setError('The title must contain a letter or digit.')
    if (duplicate) return setError(`A pod with id "${id}" already exists.`)
    setSaving(true)
    void upsertPod({ id, title: title.trim(), description: description.trim(), owner, status })
      .then(onClose)
      .catch((err) => {
        setSaving(false)
        setError(String(err))
      })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-w-md'>
        <DialogTitle>{editing ? 'Edit pod' : 'New pod'}</DialogTitle>
        <DialogDescription>
          {editing ? <code className='text-label'>id: {editing.id}</code> : 'A topic network. The title seeds the id.'}
        </DialogDescription>
        <form onSubmit={submit} className='mt-2 flex flex-col gap-3'>
          <label className='flex flex-col gap-1 text-label text-muted-foreground'>
            Title{!editing && id && <code className='text-fg-4'>id: {id}</code>}
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input autoFocus value={title} onChange={(e) => { setTitle(e.target.value); setError(null) }} placeholder='e.g. Mastermind' className={inputCls} />
          </label>
          <label className='flex flex-col gap-1 text-label text-muted-foreground'>
            Description
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder='The pod ambition / topic' className={inputCls} />
          </label>
          <div className='grid grid-cols-2 gap-2'>
            <label className='flex flex-col gap-1 text-label text-muted-foreground'>
              Owner
              <select value={owner} onChange={(e) => setOwner(e.target.value)} className={inputCls}>
                <option value=''>(none)</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {userName(u)}
                  </option>
                ))}
              </select>
            </label>
            <label className='flex flex-col gap-1 text-label text-muted-foreground'>
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value as Pod['status'])} className={inputCls}>
                <option value='active'>Active</option>
                <option value='paused'>Paused</option>
                <option value='archived'>Archived</option>
              </select>
            </label>
          </div>
          {error && <p className='text-label text-danger'>{error}</p>}
          <div className='mt-1 flex items-center justify-end gap-2'>
            <Button type='button' variant='ghost' size='sm' onClick={onClose}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={saving || !title.trim() || duplicate}>
              {saving ? 'Saving…' : editing ? 'Save' : 'Create pod'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function MemberDialog({ pod, data, users, onClose }: { pod: Pod; data: PodsOverview; users: User[]; onClose: () => void }) {
  const existing = new Set(data.members.filter((m) => m.pod_id === pod.id).map((m) => pKey(m.participant_kind, m.participant_id)))
  const candidateUsers = users.filter((u) => !existing.has(pKey('user', u.id)))

  const add = (kind: ParticipantKind, id: string) => void addMember(pod.id, kind, id)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-w-md'>
        <DialogTitle>Add members to {pod.title || pod.id}</DialogTitle>
        <DialogDescription>Add people from the directory to this pod.</DialogDescription>
        <div className='mt-2 flex flex-col gap-4'>
          <div>
            {candidateUsers.length === 0 ? (
              <p className='text-label text-fg-4'>All users are already members.</p>
            ) : (
              <div className='flex flex-wrap gap-1.5'>
                {candidateUsers.map((u) => (
                  <button key={u.id} type='button' onClick={() => add('user', u.id)} className='rounded-full border border-border bg-bg px-2.5 py-1 text-label text-text hover:border-accent hover:text-accent'>
                    + {userName(u)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className='mt-4 flex justify-end'>
          <Button size='sm' variant='ghost' onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ContentDialog({ pod, piece, onClose }: { pod: Pod; piece?: PodContent; onClose: () => void }) {
  const [channel, setChannel] = React.useState(piece?.channel ?? 'x')
  const [url, setUrl] = React.useState(piece?.url ?? '')
  const [title, setTitle] = React.useState(piece?.title ?? '')
  // '' = no override: the channel default from config/pods.json applies (possibly several actions).
  const [action, setAction] = React.useState<EngagementAction | ''>(piece?.advice?.action ?? '')
  const [hint, setHint] = React.useState(piece?.advice?.hint ?? '')
  const [draftComment, setDraftComment] = React.useState(piece?.advice?.draft_comment ?? '')
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return setError('A post URL is required.')
    setSaving(true)
    void upsertPodContent({
      id: piece?.id,
      pod_id: pod.id,
      source: piece?.source ?? 'team',
      channel,
      url: url.trim(),
      title: title.trim(),
      advice: {
        ...piece?.advice, // keep an actions-list override set over MCP
        action: action || undefined,
        hint: hint.trim() || undefined,
        draft_comment: draftComment.trim() || undefined,
      },
    })
      .then(onClose)
      .catch((err) => {
        setSaving(false)
        setError(String(err))
      })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-w-md'>
        <DialogTitle>{piece ? 'Edit pod content' : `Add content to ${pod.title || pod.id}`}</DialogTitle>
        <DialogDescription>The post members should engage with, plus the procured advice.</DialogDescription>
        <form onSubmit={submit} className='mt-2 flex flex-col gap-3'>
          <div className='grid grid-cols-3 gap-2'>
            <label className='col-span-1 flex flex-col gap-1 text-label text-muted-foreground'>
              Channel
              <select value={channel} onChange={(e) => setChannel(e.target.value)} className={inputCls}>
                <option value='x'>x</option>
                <option value='linkedin'>linkedin</option>
                <option value='reddit'>reddit</option>
                <option value='blog'>blog</option>
                <option value='hackernews'>hackernews</option>
              </select>
            </label>
            <label className='col-span-2 flex flex-col gap-1 text-label text-muted-foreground'>
              Extra expected action (the channel default always applies)
              <select value={action} onChange={(e) => setAction(e.target.value as EngagementAction | '')} className={inputCls}>
                <option value=''>None - channel default only</option>
                {(['like', 'react', 'comment', 'repost', 'crosspost'] as EngagementAction[]).map((a) => (
                  <option key={a} value={a}>
                    {ACTION_META[a].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className='flex flex-col gap-1 text-label text-muted-foreground'>
            Post URL
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input autoFocus value={url} onChange={(e) => { setUrl(e.target.value); setError(null) }} placeholder='https://…' className={inputCls} />
          </label>
          <label className='flex flex-col gap-1 text-label text-muted-foreground'>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder='Short label' className={inputCls} />
          </label>
          <label className='flex flex-col gap-1 text-label text-muted-foreground'>
            Advice hint
            <input value={hint} onChange={(e) => setHint(e.target.value)} placeholder='e.g. Like and repost this' className={inputCls} />
          </label>
          <label className='flex flex-col gap-1 text-label text-muted-foreground'>
            Pre-drafted comment <span className='text-fg-4'>(for comment actions)</span>
            <textarea value={draftComment} onChange={(e) => setDraftComment(e.target.value)} rows={3} placeholder='A comment members can copy…' className={inputCls} />
          </label>
          {error && <p className='text-label text-danger'>{error}</p>}
          <div className='mt-1 flex items-center justify-end gap-2'>
            <Button type='button' variant='ghost' size='sm' onClick={onClose}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={saving || !url.trim()}>
              {saving ? 'Saving…' : piece ? 'Save' : 'Add content'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// =================================================================================================
// Karma section (Engagement → Karma, internal rendering)
// =================================================================================================

/** Self-contained wrapper for the Engagement view: global + per-pod leaderboards. */
export function InternalKarmaSection() {
  const { data, error } = usePodsData()
  const { data: users } = useUsersData()

  if (error) {
    return (
      <CenteredNote>
        Failed to reach the API: {error}
        <br />
        Start the backend: <code>pnpm dev</code>.
      </CenteredNote>
    )
  }
  if (!data) return <CenteredNote>Loading…</CenteredNote>
  return <KarmaSection data={data} users={users ?? []} />
}

function KarmaSection({ data, users }: { data: PodsOverview; users: User[] }) {
  const nameOf = useNameResolver(data, users)
  const global = data.karma.filter((k) => k.pod_id === null)
  const podsWithKarma = data.pods.filter((p) => data.karma.some((k) => k.pod_id === p.id))

  return (
    <PageContainer width='wide'>
      <PageHeader
        title='Karma'
        description='Verified-engagement score per participant: given (engaging others) and received (their own posts). Non-gated - a visibility measure, not a gate.'
      />

      {global.length === 0 ? (
        <div className='grid place-items-center rounded-lg border border-dashed border-border py-16 text-center text-body-sm text-muted-foreground'>
          No verified engagements yet.
        </div>
      ) : (
        <div className='flex flex-col gap-6'>
          <KarmaTable title='Global' rows={global.map((k) => ({ label: nameOf(k.participant_kind, k.participant_id), kind: k.participant_kind, given: k.given, received: k.received }))} />
          {podsWithKarma.map((pod) => {
            const rows = data.karma
              .filter((k) => k.pod_id === pod.id)
              .sort((a, b) => b.given - a.given || b.received - a.received)
              .map((k) => ({ label: nameOf(k.participant_kind, k.participant_id), kind: k.participant_kind, given: k.given, received: k.received }))
            return <KarmaTable key={pod.id} title={pod.title || pod.id} rows={rows} />
          })}
        </div>
      )}
    </PageContainer>
  )
}

function KarmaTable({ title, rows }: { title: string; rows: { label: string; kind: ParticipantKind; given: number; received: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.given))
  return (
    <div>
      <h2 className='mb-2 text-body-sm font-medium text-muted-foreground'>{title}</h2>
      <div className='flex flex-col divide-y divide-border rounded-lg border border-border'>
        {rows.map((r, i) => (
          <div key={`${r.label}-${i}`} className='flex items-center gap-3 px-3 py-2'>
            <span className='w-5 shrink-0 text-right text-label text-fg-4'>{i + 1}</span>
            <span className='w-40 shrink-0 truncate text-body-sm text-text'>
              {r.label}
            </span>
            <div className='h-2 flex-1 overflow-hidden rounded-full bg-bg'>
              <div className='h-full rounded-full bg-accent' style={{ width: `${(r.given / max) * 100}%` }} />
            </div>
            <span className='inline-flex w-12 shrink-0 items-center justify-end text-body-sm font-medium text-text' title={`${r.given} given`}>
              {r.given}
              <ArrowUp className='size-3 text-fg-4' />
            </span>
            <span className='inline-flex w-12 shrink-0 items-center justify-end text-body-sm font-medium text-text' title={`${r.received} received`}>
              {r.received}
              <ArrowDown className='size-3 text-fg-4' />
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
