// The lifecycle as buttons: one per transition the server says this piece can make. This replaced the
// status dropdown (2026-07-30) - a dropdown makes a real, irreversible send look like editing a
// property, which is exactly the trap Dan named: "I don't want to change the status to approved
// because I assume then it will be sent out". Now nothing is implied: you press "Publish now", and
// the dialog tells you whether that sends a post or just records one you made yourself.
//
// A DIALOG IS FOR REQUIRED INPUT OR AN OUTWARD CONSEQUENCE, AND NOTHING ELSE (a product decision, 2026-08-13).
// Every button used to open one, including for moves that asked nothing and undo in a click -
// "Approve" cost click → read → click. Confirming everything is the same as confirming nothing: it
// trains people to dismiss the dialog without reading, and the one dialog that has to survive that is
// the one in front of a real send. So the no-input moves run on the click, and the ones that ask for
// something (or reach outside) still stop. `spec.needsDialog` carries the rule from core.
//
// NOT EVERY AVAILABLE ACTION IS A BUTTON (a product decision, 2026-08-13). A state offers up to six moves, and
// rendering them as six equal buttons makes the next step something you find rather than something
// you see. Each status names the one or two actions that ARE the path forward (PRIMARY_BY_STATUS);
// the rest stay one click away under "More". Nothing is removed - weight is the only thing decided
// here, and availability still comes from the server.
//
// Availability comes from `piece.transitions` (computed by core), labels and intent copy from the
// server's transition catalogue. This file owns only presentation: which icon, which tone, which
// actions lead, and the channel-specific consequence line.

import { useState } from 'react'
import {
  Archive,
  CalendarClock,
  CircleCheck,
  Link2,
  Loader2,
  MoreHorizontal,
  Undo2,
  PencilLine,
  Send,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { transitionContent } from '../lib/useContentData.ts'
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Popover, PopoverContent, PopoverTrigger } from '@silkweave/box-ui'
import { GenerateButton } from '../../../components/agent/GenerateCommand.tsx'
import type {
  ChannelProfile,
  ContentPiece,
  ContentStatus,
  ContentTransitionId,
  ContentTransitionSpec,
} from '../content-types.ts'

/** Icon + button treatment per transition. `tone` drives the button variant, not the semantics. */
const TRANSITION_UI: Record<ContentTransitionId, { icon: LucideIcon; tone: 'primary' | 'outline' | 'ghost' | 'danger' }> = {
  verify: { icon: CircleCheck, tone: 'outline' },
  approve: { icon: CircleCheck, tone: 'primary' },
  schedule: { icon: CalendarClock, tone: 'outline' },
  unschedule: { icon: Undo2, tone: 'outline' },
  'publish-now': { icon: Send, tone: 'primary' },
  'record-published': { icon: Link2, tone: 'primary' },
  reopen: { icon: PencilLine, tone: 'ghost' },
  archive: { icon: Archive, tone: 'ghost' },
}

/**
 * The actions worth a full button IN EACH STATE. Everything else the server offers is real and
 * reachable, just behind "More" - because a row of six equal buttons makes the next step something
 * you have to find rather than something you see. On an approved piece that is "Publish now" and
 * "Schedule"; "Back to draft" and "Archive" are corrections, not the path forward.
 *
 * Availability still comes from the server (`piece.transitions`) - this only decides WEIGHT, and an
 * id here that the piece cannot currently do is simply not rendered.
 */
const PRIMARY_BY_STATUS: Record<ContentStatus, ContentTransitionId[]> = {
  draft: ['verify', 'approve'],
  // Both arming actions are listed: exactly one of them exists per channel (`publish-now` where
  // there is a real sender, `record-published` where a human posts), so this resolves to one button.
  approved: ['publish-now', 'record-published', 'schedule'],
  scheduled: ['schedule', 'unschedule'],
  published: ['archive'],
  archived: ['reopen'],
}

/** Convert an ISO instant to the `datetime-local` input format in the viewer's timezone. */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The consequence line: what this transition means ON THIS CHANNEL. Only the channel knows whether
 * "publish" is a send or a record, and that difference is the whole point of the dialog.
 */
function channelConsequence(id: ContentTransitionId, piece: ContentPiece, profile?: ChannelProfile): string | null {
  const label = profile?.label ?? piece.channel
  const auto = profile?.publish.auto ?? false
  if (id === 'publish-now') {
    return auto
      ? `This posts to ${label} for real, as soon as the publisher next runs (within ~5 minutes). It is public and cannot be undone from here.`
      : `Nothing is sent from here - ${label} has no automated publisher.`
  }
  if (id === 'schedule') {
    return auto
      ? `At that time the publisher posts this to ${label} automatically. Nobody has to be at a keyboard.`
      : `${label} has no automated publisher, so this records your intent only - you still post it yourself, then record the URL.`
  }
  if (id === 'record-published') {
    return `Paste the URL of the post you made on ${label}. This records what already happened; it sends nothing.`
  }
  return null
}

interface DialogState {
  spec: ContentTransitionSpec
  note: string
  time: string
  url: string
  busy: boolean
  error: string | null
}

export function TransitionActions({
  piece,
  profile,
  specs,
}: {
  piece: ContentPiece
  profile?: ChannelProfile
  specs: ContentTransitionSpec[]
}) {
  const [dialog, setDialog] = useState<DialogState | null>(null)
  // A direct-click move has no dialog to hold its spinner or its error, so both live here. The error
  // is worth a line of its own: the server re-checks availability, so a stale tab CAN be refused.
  const [running, setRunning] = useState<ContentTransitionId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const byId = new Map(specs.map((s) => [s.id, s]))
  const available = piece.transitions.map((id) => byId.get(id)).filter((s): s is ContentTransitionSpec => !!s)

  // Findings a human has not ticked off yet. Approve is held disabled while any remain: the gate is
  // advice somebody ACCEPTS, so the way past it is reading it, not dismissing it. A piece with no
  // verdict at all has nothing outstanding, which is deliberately the old `accept-unverified` case -
  // approving an unchecked piece is allowed, it is just no longer a second button pretending to be
  // something else.
  const outstanding = (piece.verify?.findings ?? []).filter((f) => f.approved !== true).length

  // Re-running the gate is a re-read, not the next step, so once a verdict exists `verify` stops
  // being a primary action and joins the More menu rather than competing with Approve for the eye.
  const reverify = piece.verify != null
  const isPrimary = (id: ContentTransitionId): boolean =>
    PRIMARY_BY_STATUS[piece.status].includes(id) && !(reverify && id === 'verify')
  const primary = available.filter((s) => isPrimary(s.id))
  const secondary = available.filter((s) => !isPrimary(s.id))

  const open = (spec: ContentTransitionSpec): void =>
    setDialog({
      spec,
      note: '',
      // Schedule opens on the piece's existing time when it has one, else an hour from now - a
      // sensible slot the operator adjusts, rather than an empty field that means "now".
      time: toLocalInputValue(piece.scheduled_at ?? new Date(Date.now() + 3600_000).toISOString()),
      url: piece.published_url ?? '',
      busy: false,
      error: null,
    })

  const run = (): void => {
    if (!dialog) return
    const { spec, note, time, url } = dialog
    setDialog({ ...dialog, busy: true, error: null })
    void transitionContent({
      id: piece.id,
      transition: spec.id,
      ...(spec.input === 'note' || spec.input === 'note?' ? { note: note.trim() } : {}),
      ...(spec.input === 'time' ? { scheduled_at: new Date(time).toISOString() } : {}),
      ...(spec.input === 'url' ? { published_url: url.trim() } : {}),
    }).then(
      () => setDialog(null),
      (err: unknown) =>
        setDialog((d) => (d ? { ...d, busy: false, error: err instanceof Error ? err.message : String(err) } : d)),
    )
  }

  /** Run a no-input transition straight from the click. Nothing to collect, nothing to warn about. */
  const runDirect = (spec: ContentTransitionSpec): void => {
    setRunning(spec.id)
    setError(null)
    void transitionContent({ id: piece.id, transition: spec.id }).then(
      () => setRunning(null),
      (err: unknown) => {
        setRunning(null)
        setError(err instanceof Error ? err.message : String(err))
      },
    )
  }

  const renderButton = (spec: ContentTransitionSpec, small: boolean) => {
    const { icon: Icon, tone } = TRANSITION_UI[spec.id]
    // The gate runs in a Claude Code session, so it keeps the app-wide "hands off to AI" treatment
    // rather than pretending to be a server-side transition.
    if (spec.runner === 'agent') {
      const label = reverify ? 'Re-verify' : spec.label
      return (
        <GenerateButton
          key={spec.id}
          label={label}
          command={`/verify-content ${piece.id} `}
          title={`${label} this piece`}
          description={
            <>
              {spec.intent}{' '}
              <span className='text-text'>
                Add a note below to steer it - a claim to double-check, a rule you care about.
              </span>
              {reverify && (
                <span className='text-text'>
                  {' '}
                  A fresh verdict REPLACES the current findings, so anything already accepted is
                  re-raised and has to be accepted again.
                </span>
              )}
            </>
          }
          withDirection
          className={small ? 'h-7 w-full justify-start' : 'h-8'}
        />
      )
    }
    // Approve is the one button whose availability is not the whole story: the server offers it
    // throughout the workshop, and the findings decide whether it is usable yet.
    const blocked = spec.id === 'approve' && outstanding > 0
    const busy = running === spec.id
    return (
      <Button
        key={spec.id}
        size={small ? 'xs' : 'sm'}
        variant={tone === 'primary' ? 'default' : tone === 'danger' ? 'destructive' : tone}
        onClick={() => {
          setMoreOpen(false)
          if (spec.needsDialog) open(spec)
          else runDirect(spec)
        }}
        disabled={running !== null || blocked}
        className={small ? 'w-full justify-start' : undefined}
        title={
          blocked
            ? `${outstanding} finding${outstanding === 1 ? '' : 's'} still to accept - tick them off in the verify panel below`
            : spec.intent
        }>
        {busy ? <Loader2 className='animate-spin' /> : <Icon />}
        {spec.label}
      </Button>
    )
  }

  const d = dialog
  const needsNote = d?.spec.input === 'note'
  const canRun =
    !d ||
    (d.spec.input === 'note' ? d.note.trim().length > 0 : d.spec.input === 'url' ? d.url.trim().length > 0 : true)

  return (
    <>
      <div className='flex flex-wrap items-center gap-1.5'>
        {primary.map((s) => renderButton(s, false))}
        {secondary.length > 0 && (
          <>
            <span className='mx-0.5 h-5 w-px bg-border' aria-hidden />
            {/* Controlled, and deliberately NOT closed by the Re-verify item: that one renders its own
                dialog, which would be unmounted with the popover if the click closed it. The
                direct-click items close it themselves (see renderButton). */}
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger
                render={
                  <Button size='sm' variant='ghost' title='More actions'>
                    <MoreHorizontal />
                    More
                  </Button>
                }
              />
              <PopoverContent align='end' className='w-52 gap-1 p-1.5'>
                {secondary.map((s) => renderButton(s, true))}
              </PopoverContent>
            </Popover>
          </>
        )}
      </div>

      {error && (
        <p className='mt-2 rounded-md border border-danger/40 bg-danger-bg/40 px-3 py-2 text-body-sm text-text'>
          {error}
        </p>
      )}

      <Dialog open={!!d} onOpenChange={(next) => !next && setDialog(null)}>
        {d && (
          <DialogContent>
            <DialogTitle>{d.spec.label}</DialogTitle>
            <DialogDescription className='leading-relaxed'>{d.spec.intent}</DialogDescription>
            {(() => {
              const line = channelConsequence(d.spec.id, piece, profile)
              if (!line) return null
              const loud = d.spec.outward && (profile?.publish.auto ?? false) && d.spec.id !== 'record-published'
              return (
                <p
                  className={cn(
                    'rounded-md border px-3 py-2 text-body-sm leading-relaxed',
                    loud ? 'border-warning/40 bg-warning-bg/40 text-text' : 'border-border bg-muted/40 text-muted-foreground',
                  )}>
                  {loud && <TriangleAlert className='mr-1.5 -mt-0.5 inline size-4 text-warning' />}
                  {line}
                </p>
              )
            })()}

            {(d.spec.input === 'note' || d.spec.input === 'note?') && (
              <label className='flex flex-col gap-1.5'>
                <span className='text-label text-muted-foreground'>
                  {needsNote ? 'What needs to change *' : 'Note (optional)'}
                </span>
                <textarea
                  autoFocus
                  value={d.note}
                  onChange={(e) => setDialog({ ...d, note: e.target.value })}
                  rows={4}
                  placeholder={
                    needsNote
                      ? 'Be specific - this is what the next person (or agent) works from.'
                      : 'Anything worth recording with your sign-off.'
                  }
                  className='w-full resize-y rounded-md border border-border bg-bg px-3 py-2 text-body-sm text-text focus:ring-1 focus:ring-ring focus:outline-none'
                />
              </label>
            )}

            {d.spec.input === 'time' && (
              <label className='flex flex-col gap-1.5'>
                <span className='text-label text-muted-foreground'>Goes out at (your local time)</span>
                <input
                  autoFocus
                  type='datetime-local'
                  value={d.time}
                  onChange={(e) => setDialog({ ...d, time: e.target.value })}
                  className='h-9 rounded-md border border-border bg-bg px-3 text-body-sm text-text focus:ring-1 focus:ring-ring focus:outline-none'
                />
              </label>
            )}

            {d.spec.input === 'url' && (
              <label className='flex flex-col gap-1.5'>
                <span className='text-label text-muted-foreground'>Live URL *</span>
                <input
                  autoFocus
                  value={d.url}
                  onChange={(e) => setDialog({ ...d, url: e.target.value })}
                  placeholder='https://… the post you published'
                  className='h-9 rounded-md border border-border bg-bg px-3 text-body-sm text-text focus:ring-1 focus:ring-ring focus:outline-none'
                />
              </label>
            )}

            {d.error && (
              <p className='rounded-md border border-danger/40 bg-danger-bg/40 px-3 py-2 text-body-sm text-text'>
                {d.error}
              </p>
            )}

            <div className='flex items-center justify-end gap-2'>
              <Button variant='ghost' onClick={() => setDialog(null)} disabled={d.busy}>
                Cancel
              </Button>
              <Button onClick={run} disabled={d.busy || !canRun}>
                {d.busy && <Loader2 className='animate-spin' />}
                {d.spec.label}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  )
}
