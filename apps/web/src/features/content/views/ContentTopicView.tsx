import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ExternalLink, Sparkles, Trash2, TriangleAlert, ShieldCheck, ShieldX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { deleteContentTopic, upsertContentTopic, useContentData } from '../lib/useContentData.ts'
import { PageContainer, SplitPane, Badge, Button, confirm, DateInput, InlineEdit, UserPicker } from '@silkweave/box-ui'
import { ChannelGlyph } from '@/lib/channelIcons.tsx'
import { DocEditor } from '../../../components/DocEditor.tsx'
import { StatusSelect } from '../../planning/components/status.tsx'
import { ChannelLabel, ContentStatusChip } from '../components/contentMeta.tsx'
import { GenerateButton } from '../../../components/agent/GenerateCommand.tsx'
import { formatDate, formatDateTime } from '../../../lib/format.ts'
import { CONTENT_CHANNELS, type ContentChannel, type ContentPiece, type ContentTopic } from '../content-types.ts'
import type { PlanningStatus } from '../../planning/planning-types.ts'
import { appKey } from '@/lib/storage.ts'

// The TOPIC page - `/content/$topic`, and the object the whole content module now hangs off.
//
// It is an EDITOR, not a summary: the fields on the left, the briefing doc on the right, its pieces
// underneath. That shape is what the weekly draft pipeline needs on the other end - it writes ten
// ideas per person as `planned` topics with a brief and the channels they are meant for, and a human
// has to be able to sit here, read one, sharpen it, and approve or kill it before any model time is
// spent adapting it per channel.
//
// The review gate is the STATUS, in the planning vocabulary rather than a second one of its own:
// `planned` is an idea nobody has ruled on, `active` is approved, `dropped` is killed-but-kept. And
// approving GENERATES NOTHING (a product decision): the pending-channels row below says what an approved
// topic still owes, and drafting stays a separate, explicit act, so a review click can never quietly
// spend model time.

export function ContentTopicView() {
  const { topic: topicId } = useParams({ strict: false }) as { topic?: string }
  const { data } = useContentData()
  const navigate = useNavigate()
  if (!data || !topicId) return null

  const topic = data.topics.find((t) => t.id === topicId)
  const pieces = data.pieces.filter((p) => p.topic_id === topicId)
  if (!topic)
    return (
      <div className='mx-auto max-w-3xl px-4 py-16 text-center text-body-sm text-muted-foreground'>
        No topic <code>{topicId}</code>.
      </div>
    )

  const save = (patch: Parameters<typeof upsertContentTopic>[0]) => void upsertContentTopic(patch)

  const remove = async () => {
    const published = pieces.filter((p) => p.status === 'published')
    const ok = await confirm({
      title: `Delete "${topic.title}"?`,
      message:
        `Removes the topic and its ${pieces.length} piece(s) from the tracker.` +
        (published.length > 0
          ? ` ${published.length} of them are PUBLISHED - those posts stay live in public, this only forgets them here.`
          : '') +
        ' The markdown and assets on disk are left alone.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    await deleteContentTopic(topic.id)
    void navigate({ to: '/content' })
  }

  return (
    <SplitPane
      storageKey={appKey('content', 'topicSplit')}
      collapseLabel='brief'
      // Keyed by topic id: the inline fields seed themselves from props on mount, so navigating from
      // one topic to another without a remount would leave the previous topic's title in the box.
      left={<TopicFields key={topic.id} topic={topic} pieces={pieces} onSave={save} onDelete={() => void remove()} />}
      // The briefing doc - `docs/content/<topic>/topic.md`, beside the pieces and assets rather than
      // in a folder of its own. Deliberately the SAME editor the Initiative page uses: a brief and a
      // rationale doc are the same kind of writing, and shipping two markdown surfaces meant the one
      // people used less was the one that stayed worse.
      right={
        <DocEditor
          key={topic.id}
          kind='topic'
          id={topic.id}
          variant='panel'
          placeholder='The take, and the claims ledger every draft has to honor.'
        />
      }
    />
  )
}

function TopicFields({
  topic,
  pieces,
  onSave,
  onDelete,
}: {
  topic: ContentTopic
  pieces: ContentPiece[]
  onSave: (patch: { id: string; [k: string]: unknown }) => void
  onDelete: () => void
}) {
  const ordered = [...pieces].sort((a, b) =>
    a.kind === b.kind ? a.channel.localeCompare(b.channel) : a.kind === 'canonical' ? -1 : 1,
  )
  const live = pieces.filter((p) => p.status !== 'archived')
  const considered = live.length > 0 ? live : pieces
  const published = considered.filter((p) => p.status === 'published')
  const have = new Set(pieces.map((p) => p.channel))
  // What an APPROVED topic still owes. Deliberately computed here rather than fetched: it is a set
  // difference over data already on screen, and the server's `topic-pending-channels` exists for
  // agents, which have no board to read it off.
  const pending: ContentChannel[] = topic.status === 'active' ? topic.target_channels.filter((c) => !have.has(c)) : []

  const toggleChannel = (channel: ContentChannel) => {
    const next = topic.target_channels.includes(channel)
      ? topic.target_channels.filter((c) => c !== channel)
      : [...topic.target_channels, channel]
    onSave({ id: topic.id, target_channels: next.join(',') })
  }

  return (
    <PageContainer width='reading'>
      <header className='mb-6'>
        <div className='mb-2 flex items-center gap-2 text-label text-muted-foreground'>
          <code>{topic.id}</code>
          <span className='ml-auto flex items-center gap-2'>
            {published.length}/{considered.length} published
            <Button variant='ghost' size='sm' onClick={onDelete} aria-label='Delete topic'>
              <Trash2 />
            </Button>
          </span>
        </div>
        <div className='-ml-2'>
          <InlineEdit
            defaultValue={topic.title}
            aria-label='Title'
            placeholder='What is this about?'
            inputClassName='h-auto py-1 text-display-sm font-semibold tracking-tight'
            onCommit={(v) => v.trim() !== topic.title && onSave({ id: topic.id, title: v.trim() })}
          />
        </div>
      </header>

      <div className='mb-6 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-3 text-label text-muted-foreground'>
        <span>Status</span>
        <span className='flex items-center gap-2'>
          <StatusSelect
            value={topic.status}
            onChange={(status: PlanningStatus) => onSave({ id: topic.id, status })}
            className='w-44'
          />
          <span className='text-fg-4'>
            {topic.status === 'planned'
              ? 'an idea nobody has ruled on yet'
              : topic.status === 'active'
                ? 'approved - its channels can be drafted'
                : topic.status === 'dropped'
                  ? 'killed, and kept so it is not re-proposed'
                  : ''}
          </span>
        </span>

        <span>Owner</span>
        <span>
          <UserPicker value={topic.owner} onChange={(id) => onSave({ id: topic.id, owner: id ?? '' })} />
        </span>

        <span>Channels</span>
        <span className='flex flex-wrap gap-1.5'>
          {CONTENT_CHANNELS.map((c) => {
            const on = topic.target_channels.includes(c)
            return (
              <button
                key={c}
                type='button'
                onClick={() => toggleChannel(c)}
                aria-pressed={on}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-label transition-colors',
                  on
                    ? 'border-accent bg-surface text-text'
                    : 'border-border text-muted-foreground hover:border-accent/40 hover:text-text',
                )}>
                <ChannelGlyph channel={c} className='size-3.5' />
                {c}
                {have.has(c) && <span className='text-fg-4'>·drafted</span>}
              </button>
            )
          })}
        </span>

        <span>Target date</span>
        <span>
          <DateInput
            value={topic.due_date ?? ''}
            onChange={(next) => onSave({ id: topic.id, due_date: next })}
            ariaLabel='Target publish date'
          />
        </span>
      </div>

      <label className='mb-6 flex flex-col gap-1 text-label text-muted-foreground'>
        Brief <span className='text-fg-4'>one or two sentences - the argument goes in the doc</span>
        <InlineEdit
          defaultValue={topic.brief}
          multiline
          rows={3}
          placeholder='What is this and why is it worth posting?'
          aria-label='Brief'
          onCommit={(v) => v.trim() !== topic.brief && onSave({ id: topic.id, brief: v.trim() })}
        />
      </label>

      {pending.length > 0 && (
        <div className='mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-surface px-3 py-2 text-label'>
          <Sparkles className='size-4 text-accent' />
          <span className='text-text'>Approved, and {pending.length} channel(s) have no draft yet:</span>
          {pending.map((c) => (
            <Badge key={c} variant='neutral'>
              {c}
            </Badge>
          ))}
          <div className='ml-auto'>
            <GenerateButton
              label='Draft them'
              command={`/draft-content ${topic.id}`}
              title='Draft the channels this topic still owes'
              description={
                <>
                  Writes the canonical post plus an adaptation per pending channel, voice-checked
                  against the topic's brief and claims ledger. It produces <strong>drafts</strong>{' '}
                  only - nothing is published.
                </>
              }
            />
          </div>
        </div>
      )}

      <h2 className='mb-2 text-label uppercase tracking-[0.07em] text-muted-foreground'>Pieces</h2>
      {ordered.length === 0 ? (
        <p className='rounded-lg border border-border bg-surface px-4 py-6 text-center text-body-sm text-muted-foreground'>
          Nothing drafted yet.{' '}
          {topic.status === 'active' ? 'Approved - run /draft-content to adapt it per channel.' : 'Approve it first.'}
        </p>
      ) : (
        <div className='overflow-hidden rounded-xl border border-border bg-surface shadow-(--shadow-sm)'>
          {ordered.map((piece) => (
            <PieceRow key={piece.id} piece={piece} />
          ))}
        </div>
      )}
    </PageContainer>
  )
}

/** One channel of the topic: where it is in the lifecycle, and the two facts that decide whether it
 *  needs you - the verify verdict and whether it has a published URL.
 *
 *  Two lines rather than one column-aligned row: this list lives in a split pane about 500px wide,
 *  and a single row there spent everything it had on the channel name and the chips, truncating the
 *  title to "Th…". The title is the thing you are scanning for, so it gets its own line. */
function PieceRow({ piece }: { piece: ContentPiece }) {
  const scheduled = piece.status === 'scheduled' && piece.scheduled_at
  return (
    <Link
      to='/content/$topic/$channel'
      params={{ topic: piece.topic_id, channel: piece.channel }}
      className='block border-b border-border px-4 py-2.5 transition-colors last:border-0 hover:bg-surface-hover'>
      <span className='flex items-center gap-2'>
        <ChannelLabel channel={piece.channel} className='text-body-sm text-text' />
        {piece.kind === 'canonical' && (
          <Badge variant='accent' className='py-0'>
            canonical
          </Badge>
        )}
        <span className='ml-auto flex shrink-0 items-center gap-2'>
          <VerifyChip piece={piece} />
          <ContentStatusChip status={piece.status} />
          {piece.published_url && (
            <ExternalLink className='size-3.5 text-muted-foreground' aria-label='Has a published URL' />
          )}
        </span>
      </span>
      <span className='mt-0.5 block truncate text-body-sm text-text'>
        {piece.title || <span className='text-fg-4'>untitled</span>}
      </span>
      <span className='block truncate text-label text-muted-foreground'>
        {scheduled ? `scheduled ${formatDateTime(piece.scheduled_at!)}` : null}
        {piece.published_at ? `published ${formatDate(piece.published_at)}` : null}
        {!scheduled && !piece.published_at ? `updated ${formatDate(piece.updated_at)}` : null}
      </span>
    </Link>
  )
}

/** Checked-and-passed / checked-and-failed / never checked. "Not checked" is the normal state of a
 *  draft nobody has run the gate on yet and must not read like a failure, so only the middle one gets
 *  a colour. The count beside it is what is left to ACCEPT, not the total: a verdict is worked through
 *  by ticking findings off, so the number that matters is the one still standing between the piece and
 *  Approve. (A fourth state, "accepted without the gate", existed for one day - see the waiver note in
 *  `content-types.ts`.) */
function VerifyChip({ piece }: { piece: ContentPiece }) {
  if (!piece.verify) return <span className='shrink-0 text-label text-fg-4'>not checked</span>
  const failed = !piece.verify.passed
  const Icon = failed ? ShieldX : ShieldCheck
  const outstanding = (piece.verify.findings ?? []).filter((f) => f.approved !== true).length
  return (
    <span className={cn('flex shrink-0 items-center gap-1 text-label', failed ? 'text-danger' : 'text-success')}>
      <Icon className='size-3.5' />
      {failed ? 'failed' : 'verified'}
      {outstanding > 0 && (
        <span className='inline-flex items-center gap-0.5 text-muted-foreground' title={`${outstanding} still to accept`}>
          <TriangleAlert className='size-3' />
          {outstanding}
        </span>
      )}
    </span>
  )
}
