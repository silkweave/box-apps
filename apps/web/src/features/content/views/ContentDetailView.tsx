import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import {
  CalendarClock,
  ChevronRight,
  ExternalLink,
  Send,
  ShieldCheck,
  ShieldX,
  TriangleAlert,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { slotComponents } from '../../../lib/slots.ts'
import { approveFindings, deleteContent, upsertContent, useContentData } from '../lib/useContentData.ts'
import { resolvePieceOwner } from './ContentBoard.tsx'
import { confirm, PageContainer, SplitPane, Badge, Checkbox, Button, InlineEdit, UserChip } from '@silkweave/box-ui'
import { AssetsPanel } from '../components/AssetsPanel.tsx'
import { ContentBodyEditor } from '../components/ContentBodyEditorLazy.tsx'
import { TransitionActions } from '../components/TransitionActions.tsx'
import { ChannelLabel, CONTENT_STATUS_UI } from '../components/contentMeta.tsx'
import { StatusLabel as PlanningStatusLabel } from '../../planning/components/status.tsx'
import {
  SEVERITY_DOT,
  SEVERITY_LABEL,
  SEVERITY_ORDER,
  SEVERITY_TONE,
  severityCounts,
  worstSeverity,
} from '../lib/contentView.ts'
import {
  CONTENT_STAGES,
  CONTENT_STATUS_BLURB,
  CONTENT_STATUS_META,
  type ChannelProfile,
  type ContentPiece,
  type ContentStatus,
  type ContentTopic,
  type ContentTransitionSpec,
  type VerifyFinding,
} from '../content-types.ts'
import { formatDateTime } from '../../../lib/format.ts'
import { appKey } from '@/lib/storage.ts'

export function ContentDetailView() {
  const { topic, channel } = useParams({ strict: false }) as { topic?: string; channel?: string }
  const { data } = useContentData()
  const navigate = useNavigate()
  if (!data) return null

  const topicOwners = new Map(data.topics.map((t) => [t.id, t.owner]))

  const id = `${topic}/${channel}`
  const piece = data.pieces.find((p) => p.id === id)
  const profile = data.profiles.find((p) => p.channel === piece?.channel)
  if (!piece)
    return <div className='mx-auto max-w-3xl px-4 py-16 text-center text-body-sm text-muted-foreground'>Piece not found.</div>

  const onDelete = (): void => {
    void confirm({
      title: `Remove "${piece.id}" from the tracker?`,
      message: 'The markdown body on disk stays.',
      confirmLabel: 'Remove',
      danger: true,
    }).then(
      (ok) =>
        void (
          ok &&
          deleteContent(piece.id).then(() =>
            navigate({ to: '/content/$topic', params: { topic: piece.topic_id } }),
          )
        ),
    )
  }

  const commit = (patch: { title?: string; metadata?: string }) => void upsertContent({ ...patch, id: piece.id })

  const setMeta = (key: string, value: string): void => {
    const next = { ...piece.metadata, [key]: value }
    if (value === '') delete next[key]
    commit({ metadata: JSON.stringify(next) })
  }

  const left = (
    <PageContainer width='reading' key={piece.id}>
      <header className='mb-6'>
        <div className='mb-2 flex items-center gap-2'>
          <ChannelLabel channel={piece.channel} className='text-body-sm' />
          <Badge variant={piece.kind === 'canonical' ? 'accent' : 'neutral'} className='py-0'>
            {piece.kind}
          </Badge>
          <Link
            to='/initiatives/$id'
            params={{ id: piece.topic_id }}
            title='Open the initiative'
            className='font-mono text-label text-muted-foreground underline-offset-2 hover:text-text hover:underline'>
            {piece.topic_id}
          </Link>
          {piece.source_id && (
            <span className='text-label text-muted-foreground'>
              ← <span className='font-mono'>{piece.source_id}</span>
            </span>
          )}
          <span className='ml-auto'>
            <UserChip userId={resolvePieceOwner(piece, topicOwners)} showName />
          </span>
        </div>

        <div className='flex items-start justify-between gap-3'>
          <div className='-ml-2 min-w-0 flex-1'>
            <InlineEdit
              defaultValue={piece.title}
              aria-label='Title'
              placeholder='Title / hook'
              inputClassName='h-auto py-1 text-display-sm font-semibold tracking-tight'
              onCommit={(v) => v.trim() !== piece.title && commit({ title: v.trim() })}
            />
          </div>
          <Button variant='outline' size='sm' onClick={onDelete} className='shrink-0 text-danger'>
            <Trash2 />
          </Button>
        </div>
      </header>

      <StatePanel piece={piece} profile={profile} specs={data.transitionSpecs} />
      <AssetsPanel piece={piece} />
      {profile && <RequiredFields piece={piece} profile={profile} onSet={setMeta} />}
      {(piece.channel === 'linkedin-article' || 'announcement_text' in piece.metadata) && (
        <AnnouncementPanel piece={piece} onSet={setMeta} />
      )}
      <VerifyPanel piece={piece} />
      {profile && <PublishPanel piece={piece} profile={profile} />}
      {(() => {
        const topic = data.topics.find((t) => t.id === piece.topic_id)
        return topic ? <TopicPanel topic={topic} pieces={data.pieces} /> : null
      })()}
      {/* Other features (engagement's pod panel) contribute here without content knowing them. */}
      {slotComponents<{ piece: ContentPiece }>('content.piece.panel').map((Panel, i) => (
        <Panel key={i} piece={piece} />
      ))}
    </PageContainer>
  )

  return (
    <SplitPane
      storageKey={appKey('split', 'content')}
      collapseLabel='draft'
      left={left}
      right={<ContentBodyEditor key={piece.id} piece={piece} profile={profile} />}
    />
  )
}

// --- state + transitions -------------------------------------------------------------------------

/**
 * The lifecycle as a track you are somewhere along - four stages since the merge of 2026-08-13
 * (draft → approved → scheduled → published), which is few enough to draw honestly.
 *
 * `archived` is not a step and is never drawn as one: it is an exit, so an archived piece greys the
 * whole track and says so. Drawing it inline would imply you pass through it on the way somewhere.
 */
function StatusWizard({ status }: { status: ContentStatus }) {
  const archived = status === 'archived'
  const at = archived ? -1 : CONTENT_STAGES.indexOf(status)
  return (
    <div className='flex items-end gap-3'>
      <ol className='flex min-w-0 flex-1 items-stretch gap-1.5'>
        {CONTENT_STAGES.map((stage, i) => {
          const done = !archived && i < at
          const current = !archived && i === at
          const { icon: Icon } = CONTENT_STATUS_UI[stage]
          return (
            <li key={stage} className='min-w-0 flex-1' aria-current={current ? 'step' : undefined}>
              <div
                className={cn(
                  'h-1 rounded-full transition-colors',
                  archived ? 'bg-border' : current ? 'bg-accent' : done ? 'bg-accent/40' : 'bg-border',
                )}
              />
              <div className='mt-1.5 flex min-w-0 items-center gap-1'>
                <Icon
                  className={cn(
                    'size-3.5 shrink-0',
                    current ? 'text-accent' : done ? 'text-muted-foreground' : 'text-fg-4',
                  )}
                />
                <span
                  className={cn(
                    'truncate text-label',
                    current ? 'font-medium text-text' : done ? 'text-muted-foreground' : 'text-fg-4',
                  )}>
                  {CONTENT_STATUS_META[stage].label}
                </span>
              </div>
            </li>
          )
        })}
      </ol>
      {archived && (
        <Badge variant='neutral' className='shrink-0 py-0'>
          Archived
        </Badge>
      )}
    </div>
  )
}

/**
 * Where the piece stands and what can be done about it - the top of the page, and the only place the
 * lifecycle moves. The status is READ-ONLY here on purpose (it used to be a dropdown, which made a
 * live LinkedIn send look like a property edit): the state is a consequence of the action you took,
 * so the actions are what you press.
 */
function StatePanel({
  piece,
  profile,
  specs,
}: {
  piece: ContentPiece
  profile?: ChannelProfile
  specs: ContentTransitionSpec[]
}) {
  const armed = piece.status === 'scheduled' && piece.scheduled_at
  const late = armed ? Date.now() - new Date(piece.scheduled_at as string).getTime() : 0
  // A scheduled time in the PAST is the normal state of a piece you just pressed "Publish now" on -
  // that transition stamps `scheduled_at` with this instant, so the piece is due the moment it lands.
  // Calling that "Overdue" read as a fault and worried people (a product decision, 2026-08-13); it is a queue.
  // Genuinely late is a different fact, and it needs the publisher to have missed several runs: the
  // cron is every 5 minutes, so 15 gives it three chances before anyone is told something is wrong.
  const due = armed && late > 0
  const stale = armed && late > 15 * 60_000
  return (
    <section className='mb-6 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <StatusWizard status={piece.status} />
      <p className='mt-3 text-label text-muted-foreground'>{CONTENT_STATUS_BLURB[piece.status]}</p>

      {armed && (
        <p
          className={cn(
            'mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-body-sm',
            stale ? 'border-danger/40 bg-danger-bg/40 text-text' : 'border-border bg-muted/40 text-muted-foreground',
          )}>
          <CalendarClock className={cn('size-4 shrink-0', stale ? 'text-danger' : 'text-info')} />
          {profile?.publish.auto ? (
            stale ? (
              <>
                Scheduled for{' '}
                <span className='font-medium text-text'>{formatDateTime(piece.scheduled_at as string)}</span> and still
                not sent - the publisher runs every 5 minutes, so something is wrong. Check Automation.
              </>
            ) : due ? (
              <>
                Queued - the publisher posts this to {profile.label} on its next run, within ~5 minutes.
              </>
            ) : (
              <>
                Goes out automatically on {profile?.label ?? piece.channel} at{' '}
                <span className='font-medium text-text'>{formatDateTime(piece.scheduled_at as string)}</span>.
              </>
            )
          ) : (
            <>
              Planned for {formatDateTime(piece.scheduled_at as string)} - {profile?.label ?? piece.channel}{' '}
              has no automated publisher, so you post it yourself and record the URL.
            </>
          )}
        </p>
      )}

      {piece.review && (
        <div className='mt-3 rounded-md border border-border bg-muted/40 px-3 py-2'>
          <div className='flex items-center gap-2 text-label text-muted-foreground'>
            Approved by
            {piece.review.by ? <UserChip userId={piece.review.by} showName /> : <span>someone</span>}
            <span>· {formatDateTime(piece.review.at)}</span>
          </div>
          {piece.review.note && (
            <p className='mt-1 whitespace-pre-wrap text-body-sm leading-relaxed text-text'>{piece.review.note}</p>
          )}
        </div>
      )}

      <div className='mt-3'>
        <TransitionActions piece={piece} profile={profile} specs={specs} />
      </div>
    </section>
  )
}

// --- required fields (per-channel profile) -------------------------------------------------------

function RequiredFields({
  piece,
  profile,
  onSet,
}: {
  piece: ContentPiece
  profile: ChannelProfile
  onSet: (key: string, value: string) => void
}) {
  // Union of the channel's required + recommended keys + any metadata keys already set.
  // `assets` is structured (an array) and has its own panel; `announcement_text` is multi-line and
  // gets its own textarea panel - keep both out of the string-fields grid.
  const recommends = profile.recommends ?? []
  const keys = [...new Set([...profile.requires, ...recommends, ...Object.keys(piece.metadata)])].filter(
    (k) => k !== 'assets' && k !== 'announcement_text',
  )
  if (keys.length === 0)
    return (
      <p className='mb-6 text-label text-muted-foreground'>
        No required fields for {profile.label}. {profile.voiceNotes}
      </p>
    )
  return (
    <section className='mb-6'>
      <h2 className='mb-2 text-body-sm font-medium text-text'>Fields</h2>
      <div className='grid grid-cols-1 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm) sm:grid-cols-2'>
        {keys.map((key) => {
          const required = profile.requires.includes(key)
          const recommended = !required && recommends.includes(key)
          const value = typeof piece.metadata[key] === 'string' ? (piece.metadata[key] as string) : ''
          const missing = required && !value
          return (
            <label key={key} className='flex flex-col gap-1'>
              <span className={cn('text-label', missing ? 'text-warning' : 'text-muted-foreground')}>
                {key}
                {required && ' *'}
                {recommended && <span className='text-muted-foreground'> · rec.</span>}
              </span>
              <InlineEdit
                defaultValue={value}
                aria-label={key}
                placeholder={required ? 'required' : recommended ? 'recommended' : 'optional'}
                onCommit={(v) => v !== value && onSet(key, v.trim())}
              />
            </label>
          )
        })}
      </div>
    </section>
  )
}

// --- announcement panel --------------------------------------------------------------------------

/** `metadata.announcement_text` - the feed post that ships alongside a newsletter-article publish
 *  (the browser publisher types it into LinkedIn's share dialog; it doubles as the channel's
 *  same-day companion post). Multi-line, saved on blur via the same metadata merge as Fields. */
function AnnouncementPanel({ piece, onSet }: { piece: ContentPiece; onSet: (key: string, value: string) => void }) {
  const value = typeof piece.metadata.announcement_text === 'string' ? piece.metadata.announcement_text : ''
  return (
    <section className='mb-6 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <h2 className='text-body-sm font-medium text-text'>Announcement post</h2>
      <p className='mt-1 text-label text-muted-foreground'>
        Ships as the author's feed post when the article publishes. Blank line = paragraph break.
      </p>
      <textarea
        key={piece.id}
        defaultValue={value}
        aria-label='Announcement post text'
        placeholder='Tell the network what this edition is about…'
        rows={5}
        className='mt-3 w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-body-sm text-text focus:outline-none focus:ring-1 focus:ring-ring'
        onBlur={(e) => e.target.value.trim() !== value && onSet('announcement_text', e.target.value.trim())}
      />
    </section>
  )
}

// --- verify panel --------------------------------------------------------------------------------

/**
 * The gate's verdict, as a list you tick through. Approve stays disabled until every finding is
 * ticked (see TransitionActions), which is the whole design: the gate is advice a human ACCEPTS, so
 * the way past it is reading it rather than dismissing it. `pass` findings arrive already ticked -
 * there is nothing to decide about a note - so the work is only ever the amber and red rows.
 */
function VerifyPanel({ piece }: { piece: ContentPiece }) {
  const [open, setOpen] = useState(true)
  const v = piece.verify

  // --- optimistic ticks, flushed as one call per burst ---------------------------------------------
  // Ticking is read-then-decide work: you go down the list checking boxes faster than any round trip.
  // So a tick lands in `pending` and paints immediately, and a timer flushes the whole burst ~1s after
  // the last click. That is both the feel (a checkbox that waits for the server visibly lags the
  // cursor) and the correctness: one atomic write per burst instead of N racing read-modify-writes.
  const [pending, setPending] = useState<Record<number, boolean>>({})
  const [saveError, setSaveError] = useState<string | null>(null)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pieceId = piece.id

  // An override is retired ONLY once the stored verdict already agrees with it - never on a timer and
  // never when the request resolves. Dropping it any earlier makes the box fall back to the value the
  // server had before the write, so it visibly unticks and re-ticks a moment later; that flicker was
  // the first version of this panel. Reconciling on agreement has no timing assumption in it at all.
  useEffect(() => {
    setPending((prev) => {
      const next: Record<number, boolean> = {}
      let held = 0
      for (const [key, want] of Object.entries(prev)) {
        if ((v?.findings[Number(key)]?.approved === true) !== want) {
          next[Number(key)] = want
          held++
        }
      }
      // Same object when nothing retired, so this cannot loop on its own state.
      return held === Object.keys(prev).length ? prev : next
    })
  }, [v])

  const flush = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const batch = pendingRef.current
    const idx = Object.keys(batch).map(Number)
    if (idx.length === 0) return
    // Two calls at most - the ticked set and the unticked one - each atomic, each addressed by
    // position so neither can revert a finding somebody else changed.
    for (const on of [true, false]) {
      const indices = idx.filter((i) => batch[i] === on)
      if (indices.length === 0) continue
      void approveFindings({ id: pieceId, approved: on, indices }).catch((err: unknown) => {
        // A failed save must not leave the box showing what the user wanted as though it stuck.
        // Drop those overrides so the row snaps back to the truth, and SAY so - a silent revert is
        // the one outcome worse than the flicker this whole dance exists to avoid.
        setPending((prev) => {
          const next = { ...prev }
          for (const i of indices) delete next[i]
          return next
        })
        setSaveError(err instanceof Error ? err.message : String(err))
      })
    }
  }, [pieceId])

  // Leaving the page must not eat the last click. Flushing on unmount is why the debounce is safe to
  // have at all - the alternative is a change that looks saved and never was.
  useEffect(() => flush, [flush])

  const approvedAt = (index: number, stored: boolean | undefined): boolean => pending[index] ?? stored === true

  const set = (approved: boolean, index?: number): void => {
    setSaveError(null)
    if (index === undefined) {
      // "Tick everything" is one deliberate act, not a burst, so it sends immediately - but it still
      // paints optimistically, over EVERY row. Clearing the overrides here instead would leave the
      // whole list showing stored values until the round trip landed, which is the same lag the
      // per-row debounce exists to avoid, just spread across every box at once.
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setPending(Object.fromEntries((v?.findings ?? []).map((_, i) => [i, approved])))
      void approveFindings({ id: pieceId, approved }).catch((err: unknown) => {
        setPending({})
        setSaveError(err instanceof Error ? err.message : String(err))
      })
      return
    }
    setPending((p) => ({ ...p, [index]: approved }))
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, 1000)
  }

  // Carry each finding's STORED position with it. The list renders worst-first, but a tick addresses
  // the finding by its index in the verdict - sorting must never be able to move somebody's checkbox.
  const findings = (v?.findings ?? [])
    .map((f, index) => ({ f, index, approved: approvedAt(index, f.approved) }))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.f.severity) - SEVERITY_ORDER.indexOf(b.f.severity))
  const counts = severityCounts(v?.findings ?? [])
  // The header's own colour is the worst thing in the list, so a collapsed panel already tells you
  // whether anything BLOCKS - the ratio it used to show could not, since `4/5 passed` reads the same
  // whether the fifth finding is a blocking failure or an advisory note.
  const worst = worstSeverity(v?.findings ?? [])
  const outstanding = findings.filter((f) => !f.approved).length
  const allApproved = findings.length > 0 && outstanding === 0

  return (
    <section className='mb-6 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <div className='flex items-center gap-2'>
        <button
          type='button'
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className='group flex min-w-0 flex-1 items-center gap-2 text-left'
        >
          <ChevronRight
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform group-hover:text-accent', open && 'rotate-90')}
          />
          {v ? (
            v.passed ? (
              <ShieldCheck className='size-4 text-success' />
            ) : (
              <ShieldX className={cn('size-4', worst === 'fail' ? 'text-danger' : 'text-warning')} />
            )
          ) : (
            <TriangleAlert className='size-4 text-muted-foreground' />
          )}
          <h2 className='min-w-0 truncate text-body-sm font-medium text-text'>
            {v ? (v.passed ? 'Verified' : 'Changes requested') : 'Not verified yet'}
          </h2>
          {v && <span className='shrink-0 text-label text-muted-foreground'>{formatDateTime(v.checkedAt)}</span>}
        </button>

        {/* Right rail: the counts, then the tick-everything box. Bare numbers rather than "2 blocking"
            - three coloured digits are read in one glance, and the words are on every row below. */}
        {v && findings.length > 0 && (
          <span className='flex shrink-0 items-center gap-2'>
            <span className='flex items-center gap-1'>
              {SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => (
                <Badge
                  key={s}
                  variant={SEVERITY_TONE[s]}
                  className='min-w-6 justify-center px-1.5 py-0 tabular-nums'
                  title={`${counts[s]} ${SEVERITY_LABEL[s](counts[s])}`}>
                  {counts[s]}
                </Badge>
              ))}
            </span>
            <label
              className='flex cursor-pointer items-center gap-1.5 text-label text-muted-foreground'
              title={allApproved ? 'Untick every finding' : 'Tick every finding off'}>
              <span className='hidden sm:inline'>{allApproved ? 'All accepted' : `${outstanding} to accept`}</span>
              <Checkbox
                checked={allApproved}
                // Some-but-not-all reads as a dash rather than a lie in either direction.
                ref={(el: HTMLInputElement | null) => {
                  if (el) el.indeterminate = !allApproved && outstanding < findings.length
                }}
                onChange={(e) => set(e.target.checked)}
              />
            </label>
          </span>
        )}
      </div>

      {open &&
        (!v ? (
          <p className='mt-2 text-label leading-relaxed text-muted-foreground'>
            The content gate runs in a Claude Code session, not here - it checks voice, the initiative's
            claims ledger, and this channel's constraints, then records the verdict (pass → verified,
            fail → changes requested).
          </p>
        ) : findings.length === 0 ? (
          <p className='mt-2 text-label text-muted-foreground'>No findings recorded.</p>
        ) : (
          <ul className='mt-3 flex flex-col'>
            {saveError && (
              <li className='mb-2 rounded-md border border-danger/40 bg-danger-bg/40 px-3 py-2 text-label text-text'>
                Could not save: {saveError}
              </li>
            )}
            {findings.map(({ f, index, approved }) => (
              <FindingRow
                key={index}
                finding={f}
                approved={approved}
                onSet={(next) => set(next, index)}
              />
            ))}
          </ul>
        ))}
    </section>
  )
}

/** One finding: its light on the left, its checkbox on the right, the message between them. */
function FindingRow({
  finding,
  approved,
  onSet,
}: {
  finding: VerifyFinding
  /** The OPTIMISTIC value - what the panel is about to save, not necessarily what is stored yet. */
  approved: boolean
  onSet: (approved: boolean) => void
}) {
  return (
    <li className='flex items-start gap-2.5 border-b border-border-light py-2 text-label leading-relaxed last:border-b-0'>
      <span
        className={cn('mt-1.5 size-2 shrink-0 rounded-full', SEVERITY_DOT[finding.severity])}
        title={SEVERITY_LABEL[finding.severity](1)}
        aria-label={SEVERITY_LABEL[finding.severity](1)}
      />
      <span className='min-w-0 flex-1'>
        <span className='mr-1.5 font-mono text-muted-foreground'>{finding.lens}</span>
        <span className={cn(finding.severity === 'fail' ? 'text-text' : 'text-muted-foreground')}>{finding.message}</span>
      </span>
      <Checkbox
        className='mt-0.5'
        checked={approved}
        onChange={(e) => onSet(e.target.checked)}
        aria-label={`Accept this ${SEVERITY_LABEL[finding.severity](1)} finding`}
        title='Accept this finding'
      />
    </li>
  )
}

// --- initiative (the body of work this piece belongs to) -----------------------------------------

/** The linked initiative as a rich row - the mirror of the initiative page's Content list. */
/** The topic this piece adapts - its status, its brief, and how many of its channels have shipped.
 *  Replaced an Initiative panel on 2026-08-12: a piece's parent is a topic now, and the planning
 *  layer no longer has anything to say about content. */
function TopicPanel({ topic, pieces }: { topic: ContentTopic; pieces: ContentPiece[] }) {
  const mine = pieces.filter((p) => p.topic_id === topic.id && p.status !== 'archived')
  const published = mine.filter((p) => p.status === 'published').length
  return (
    <section className='mt-6'>
      <h2 className='mb-2 text-body-sm font-medium text-text'>Topic</h2>
      <Link
        to='/content/$topic'
        params={{ topic: topic.id }}
        title='Open the topic'
        className='flex items-center gap-3 rounded-md border border-border px-3 py-2 transition-colors hover:bg-muted/40'>
        <PlanningStatusLabel status={topic.status} />
        <span className='min-w-0 flex-1'>
          <span className='block truncate text-body-sm text-text'>{topic.title}</span>
          {topic.brief && <span className='block truncate text-label text-muted-foreground'>{topic.brief}</span>}
        </span>
        {mine.length > 0 && (
          <span className='shrink-0 text-label text-muted-foreground tabular-nums'>
            {published}/{mine.length} published
          </span>
        )}
        {topic.owner && <UserChip userId={topic.owner} />}
      </Link>
    </section>
  )
}

// --- publish (how this piece ships) --------------------------------------------------------------

/** Read-only: the path this channel publishes by, and the live link once it has shipped. Acting on
 *  it lives in the transition bar at the top - one place where the lifecycle moves, not two. */
function PublishPanel({ piece, profile }: { piece: ContentPiece; profile: ChannelProfile }) {
  const path = [profile.publish.tool, profile.publish.costNote].filter(Boolean).join(' · ')

  if (piece.status === 'published')
    return (
      <section className='rounded-lg border border-success/30 bg-success-bg/40 p-4'>
        <div className='flex items-center gap-2'>
          <Send className='size-4 text-success' />
          <h2 className='text-body-sm font-medium text-text'>Published</h2>
          {piece.published_at && (
            <span className='text-label text-muted-foreground'>{formatDateTime(piece.published_at)}</span>
          )}
        </div>
        {piece.published_url && (
          <a
            href={piece.published_url}
            target='_blank'
            rel='noreferrer'
            className='mt-2 inline-flex items-center gap-1 break-all text-label text-accent hover:underline'>
            {piece.published_url}
            <ExternalLink className='size-3 shrink-0' />
          </a>
        )}
      </section>
    )

  return (
    <section className='rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <div className='flex items-center gap-2'>
        <Send className='size-4 text-muted-foreground' />
        <h2 className='text-body-sm font-medium text-text'>How this ships</h2>
        <Badge variant={profile.publish.auto ? 'info' : 'neutral'} className='py-0'>
          {profile.publish.auto ? 'automated publisher' : 'you post it'}
        </Badge>
      </div>
      <p className='mt-1 text-label leading-relaxed text-muted-foreground'>
        Path: {path || 'manual'}.{' '}
        {profile.publish.auto ? (
          <>
            Scheduling this piece (or <span className='text-text'>Publish now</span>) hands it to that
            publisher, which posts it for real and records the URL back here.
          </>
        ) : (
          <>
            Nothing is sent from the dashboard - you post it on {profile.label} yourself, then{' '}
            <span className='text-text'>Record published</span> with the live URL, which drives the
            published signal.
          </>
        )}
      </p>
    </section>
  )
}

