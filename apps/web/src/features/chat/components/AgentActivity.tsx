import { useEffect, useRef, useState } from 'react'
import { CircleAlert, Hand, Loader2, PencilLine, ScrollText, Sparkles, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { WorkerDeckError } from '@workerdeck/client'
import type { SessionInfo } from '@workerdeck/protocol'
import { cn } from '@/lib/utils'
import type { AgentActivityFrame } from '../lib/chatTypes.ts'
import { agentClient } from '../../../lib/agentStore.ts'
import { Button, Dialog, DialogContent, DialogTitle } from '@silkweave/box-ui'
import { SessionPanel } from '@workerdeck/ui'

/**
 * What an agent turn is DOING, rendered in the HEADER of the message it is writing.
 *
 * The channel half of a deliberate split: NAMES here, ARGUMENTS behind the session viewer. The
 * label arrives already summarized and sanitized (`packages/core/src/chat/agent-activity.ts`), so
 * this component renders it verbatim and must never try to say more - widening this line is how a
 * file's contents, a SQL string or a shell command ends up in a room.
 *
 * It sits on the author line (`Nova  10:26  ◌ reading WAREHOUSE.md  9s`) rather than under the
 * bubble, because that line is the one piece of chrome that is already reserved and already
 * scanned - and because the BODY below it is now the typing indicator (`AgentTypingDots`), which
 * an activity line underneath would compete with. The whole cluster is the button that opens the
 * transcript: there is no separate "View session" control to aim at any more.
 *
 * The viewer is a SIBLING (`AgentSessionDialog`, owned by the view) rather than a child of this
 * component, because the line is transient by design: it disappears the instant the turn reports
 * `done`. A dialog mounted inside it would be torn out from under whoever opened it at exactly
 * the moment they went to read what the agent had done.
 */

/** Elapsed seconds, ticking. A turn is the one thing people sit and watch, so it counts in real
 *  time rather than settling for "a few minutes ago". */
function useElapsed(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}

/** `9s`, `1:05`, `12:30`. Seconds below a minute because that is the range where the difference
 *  between 3 and 30 is the whole question a watcher is asking. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Per-state icon and motion. `AgentActivityState` has carried seven states since it shipped and
 * this surface rendered ONE spinner for all of them, which meant a turn BLOCKED on a human looked
 * exactly like a turn working - the single state that needs somebody to act, animated to say the
 * opposite.
 *
 * `spin` is therefore the real payload here, not the glyph: motion means "this is progressing on
 * its own". `waiting` is still, and warning-tinted, because nothing will happen until a person
 * answers. `error` is still for the same reason - it is over.
 */
const STATE_UI: Record<AgentActivityFrame['state'], { icon: LucideIcon; spin: boolean; tone: string }> = {
  starting: { icon: Loader2, spin: true, tone: 'text-muted-foreground' },
  thinking: { icon: Sparkles, spin: false, tone: 'text-muted-foreground' },
  tool: { icon: Wrench, spin: false, tone: 'text-muted-foreground' },
  writing: { icon: PencilLine, spin: false, tone: 'text-muted-foreground' },
  waiting: { icon: Hand, spin: false, tone: 'text-warning' },
  // Terminal states: the frame normally unmounts on both, so these are what a client that is still
  // holding the last frame renders rather than a spinner that will never stop.
  done: { icon: Loader2, spin: false, tone: 'text-muted-foreground' },
  error: { icon: CircleAlert, spin: false, tone: 'text-destructive' },
}

interface AgentActivityLineProps {
  activity: AgentActivityFrame
  /** Open the transcript for this turn's worker session. */
  onViewSession: (workerSessionId: string) => void
  className?: string
}

/**
 * The activity cluster for a message header: icon, label, elapsed, step count.
 *
 * A `button` rather than a div with a sibling control. The affordance people reach for is the
 * spinner itself ("what is it doing?"), so the spinner IS the target, and so are the words next to
 * it. Rendered inline-flex with `items-baseline` off - the header uses baseline alignment for text,
 * which would drop an icon half a line low.
 */
export function AgentActivityLine({ activity, onViewSession, className }: AgentActivityLineProps) {
  const elapsed = useElapsed(activity.startedAt)
  const { icon: Icon, spin, tone } = STATE_UI[activity.state]

  return (
    <button
      type='button'
      onClick={() => onViewSession(activity.workerSessionId)}
      title='Open the agent session'
      className={cn(
        'flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-px text-label transition-colors',
        'hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        tone,
        className,
      )}>
      <Icon className={cn('size-3.5 shrink-0', spin && 'animate-spin')} aria-hidden />
      <span className='min-w-0 truncate'>{activity.label}</span>
      <span className='shrink-0 tabular-nums opacity-70'>{formatElapsed(elapsed)}</span>
      {activity.toolCount > 0 && (
        <span className='shrink-0 opacity-70'>
          {activity.toolCount} {activity.toolCount === 1 ? 'step' : 'steps'}
        </span>
      )}
    </button>
  )
}

/**
 * What a FINISHED turn leaves behind: a quiet control on the HEADER line, linking to its transcript.
 *
 * The counterpart to `AgentActivityLine`, and the reason it exists is that the activity line is
 * transient by design - it disappears the instant the turn reports `done`, and with it went the
 * only route into what the agent had actually done. "Show me that again" is a question people ask
 * AFTER reading the answer, not during, so the affordance has to outlive the turn. It is read from
 * `message.meta`, a durable column, so a reload or a server restart does not take it away.
 *
 * It sits in the SAME SLOT the activity line occupied while the turn was running (next to the
 * avatar and name), rather than under the answer where it used to hang. Two reasons: the running
 * indicator and the thing it turns into are one control in the reader's head, so moving position at
 * the moment it settles reads as a second, different affordance appearing; and under the body it
 * sat between the answer and whatever came next, breaking the column of prose that a room is
 * actually there to read.
 *
 * Deliberately understated: this hangs on EVERY answer nova ever gives, so it has to be ignorable -
 * which is why it is the icon and the word alone since 2026-09-04. The step count and the elapsed
 * time went with the redesign: neither is worth reading after the fact (both are in the transcript
 * the control opens), and the header line now also carries the row's verbs, which need the room.
 * The exception is `error`, which is tinted, because the activity line UNMOUNTED on an errored turn
 * and left the room with nothing at all saying it had failed.
 */
export function AgentTurnRecord({
  turn,
  onViewSession,
  className,
}: {
  turn: { workerSessionId: string; startedAt: number; endedAt: number; toolCount: number; state: 'done' | 'error' }
  onViewSession: (workerSessionId: string) => void
  className?: string
}) {
  const failed = turn.state === 'error'
  return (
    <button
      type='button'
      onClick={() => onViewSession(turn.workerSessionId)}
      title='Open the agent session for this turn'
      className={cn(
        'flex min-w-0 shrink items-center gap-1.5 rounded-sm px-1 py-px text-label transition-colors',
        'hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        failed ? 'text-destructive' : 'text-muted-foreground opacity-70 hover:opacity-100',
        className,
      )}>
      {failed ? <CircleAlert className='size-3 shrink-0' aria-hidden /> : <ScrollText className='size-3 shrink-0' aria-hidden />}
      <span className='shrink-0'>{failed ? 'turn failed' : 'session'}</span>
    </button>
  )
}

/**
 * The bouncing "…" a turn shows until its first real character arrives.
 *
 * Three spans and a staggered CSS animation rather than an animated SVG: it inherits the text
 * colour and the line box, so it sits on the body's own baseline at any font size and needs no
 * separate dark-mode asset. `--animate-agent-dot` is declared in styles/globals.css.
 *
 * WHY IT IS NEEDED AT ALL: the server posts a literal `…` as the placeholder body and replaces it
 * with the answer, so a room watching a turn start sees one static ellipsis - indistinguishable
 * from a message somebody actually sent that reads "…". Motion is the whole signal.
 */
export function AgentTypingDots({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 py-1.5 align-middle', className)}
      role='status'
      aria-label='The agent is working'>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className='size-1.5 rounded-full bg-current opacity-30 motion-safe:animate-agent-dot'
          // Staggered by a third of the cycle, which is what makes it read as a travelling wave
          // rather than three dots pulsing in unison.
          style={{ animationDelay: `${index * 0.16}s` }}
        />
      ))}
    </span>
  )
}

interface AgentSessionDialogProps {
  /** The worker session to show, or null for closed. */
  sessionId: string | null
  onClose: () => void
}

/**
 * What the dialog found out about the session before deciding whether to mount the panel.
 *
 * The panel alone cannot tell a viewer WHY it is not showing anything: its socket answers 404 for
 * a session that has been forgotten, for one the viewer may not read, and (before the relay in
 * agent.mount.ts) for every room session at all, and its client turns all of them into
 * "Reconnecting…" and then "Offline" - indistinguishable from a network problem. So the dialog asks
 * the REST route first, which answers in HTTP, and only mounts the panel on a session that exists.
 */
type SessionView =
  | { kind: 'loading' }
  | { kind: 'found'; session: SessionInfo }
  /** 404: the worker has no such session, or will not show it to this viewer. */
  | { kind: 'gone' }
  /** 401/403: not signed in, or not an internal user. */
  | { kind: 'refused'; status: number }
  | { kind: 'unreachable'; message: string }

const viewFor = (error: unknown): SessionView => {
  if (error instanceof WorkerDeckError) {
    if (error.status === 404) return { kind: 'gone' }
    if (error.status === 401 || error.status === 403) return { kind: 'refused', status: error.status }
    return { kind: 'unreachable', message: error.message }
  }
  return { kind: 'unreachable', message: error instanceof Error ? error.message : 'request failed' }
}

/**
 * The line above the transcript for a session that is no longer running, or the whole body when
 * there is nothing to show. An ENDED session is the NORMAL state of an older turn, not a fault:
 * the chat agent retires a room's session an hour after the room goes quiet, and the copy has to
 * read that way - a person clicking yesterday's answer has not broken anything.
 */
function sessionNote(view: Exclude<SessionView, { kind: 'loading' }>): string | null {
  switch (view.kind) {
    case 'found':
      if (view.session.status === 'closed') {
        return 'This session has ended. The agent retires a room\'s session an hour after the room goes quiet; below is what it did while it ran.'
      }
      if (view.session.status === 'failed') return 'This session failed. Below is what it did before it stopped.'
      if (view.session.status === 'parked') return 'This session is parked, so there is nothing live to watch.'
      return null
    case 'gone':
      return (
        "This turn's session is no longer on the worker. A room's session is retired an hour after the room goes quiet " +
        'and forgotten on the next restart, so for an older turn this is the normal outcome - the answer in the room is ' +
        'the record of what it did. It is also what you would see for a session you are not allowed to read.'
      )
    case 'refused':
      return view.status === 401 ? 'Sign in to view agent sessions.' : 'Agent sessions are only shown to internal users.'
    case 'unreachable':
      return `Could not reach the agent worker: ${view.message}`
  }
}

/** The auth-gated half of the split: the full transcript, arguments included. */
export function AgentSessionDialog({ sessionId, onClose }: AgentSessionDialogProps) {
  const [view, setView] = useState<SessionView>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // One re-check per opening when the panel's own socket gives up: a session that was found and
  // then forgotten (a restart between the click and the attach) flips to `gone` with its
  // explanation instead of sitting on "Offline". Once, because the re-check remounts the panel,
  // and a persistent failure should settle on the panel's own indicator rather than cycle.
  const rechecked = useRef(false)

  useEffect(() => {
    if (sessionId === null) return
    let cancelled = false
    setView({ kind: 'loading' })
    agentClient.getSession(sessionId).then(
      (session) => {
        if (!cancelled) setView({ kind: 'found', session })
      },
      (error: unknown) => {
        if (!cancelled) setView(viewFor(error))
      },
    )
    return () => {
      cancelled = true
    }
  }, [sessionId, attempt])

  useEffect(() => {
    rechecked.current = false
  }, [sessionId])

  const note = view.kind === 'loading' ? null : sessionNote(view)
  // A closed or failed runner keeps its event log until the worker restarts, so an ended turn's
  // transcript is still readable; only a parked one has nothing to attach to (see agent.mount.ts).
  const showPanel = view.kind === 'found' && view.session.status !== 'parked'

  return (
    <Dialog
      open={sessionId !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}>
      <DialogContent className='h-[80vh] w-[calc(100%-2rem)] max-w-4xl gap-2 p-0'>
        <DialogTitle className='px-5 pt-5 text-body font-medium'>Agent session</DialogTitle>
        {view.kind === 'loading' && <p className='px-5 text-label text-muted-foreground'>Opening the session…</p>}
        {note !== null && (
          <div
            className={cn(
              'mx-5 flex items-start gap-2 rounded-md border px-3 py-2 text-label',
              view.kind === 'unreachable' ? 'border-destructive/40 text-destructive' : 'border-border text-muted-foreground',
            )}>
            <span className='min-w-0 flex-1'>{note}</span>
            {view.kind === 'unreachable' && (
              <Button variant='outline' size='xs' className='shrink-0' onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            )}
          </div>
        )}
        {/* readOnly hides the composer, the approval prompts and the session controls (checked
            against @workerdeck/ui's own source - SessionPanel.tsx lines 490/631/666), and
            toolHost={false} refuses to run this session's tool calls in this browser. Neither is
            the control, though: a room reader's socket is a server-side relay that forwards
            nothing inbound (apps/server/src/agent/session-relay.ts). This is a WINDOW onto
            somebody else's turn, not a second place to drive it. */}
        {sessionId !== null && showPanel && (
          <SessionPanel
            key={`${sessionId}:${attempt}`}
            client={agentClient}
            sessionId={sessionId}
            readOnly
            toolHost={false}
            onVitals={(vitals) => {
              if (vitals.connection !== 'offline' || rechecked.current) return
              rechecked.current = true
              setAttempt((n) => n + 1)
            }}
            className='min-h-0 flex-1'
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
