import { useCallback, useState } from 'react'
import { cn } from '@/lib/utils'
import { Check, ChevronRight, ShieldQuestion, Trash2, X } from 'lucide-react'
import type { ChatCardMeta, ChatDecisionInput } from '../lib/chatTypes.ts'
import { userName } from '../../../user-types.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { Button } from '@silkweave/box-ui'
import { MessageBody } from './MessageBody.tsx'

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * The decision controls under an approval card - a worker's permission request (chat Track 19) or
 * a chat operation held for a human (`kind: 'chat-op'`). One surface for both: the same two
 * buttons, the same mutation, and the server routes the decision to whichever registry holds it.
 *
 * Deliberately NOT a replacement for the message body. The body is markdown written to stand on
 * its own - it names the tool or the operation and quotes the framing - so a client which knows
 * nothing about `meta` still renders a legible account of what was asked. What it can no longer do
 * is ANSWER: the `@nova approve` / `@nova deny <reason>` reply grammar was removed on 2026-09-09
 * (see `parseAgentDirective`), because every shipped client renders these buttons and the footer
 * was costing each card a paragraph of instructions for a path nobody took.
 *
 * Everything here is a state the SERVER settled. There is no optimistic update and no local
 * "approved!" flourish: the mutation returns, the server rewrites the card in place, and the
 * `message.edited` ephemeral repaints this component from the row. Faking the transition locally
 * would let a refused decision (a card from a replaced session, a race lost to a colleague) look
 * accepted for as long as the tab stayed open - on the one surface whose entire job is to record
 * accurately who allowed what.
 */
export function ApprovalCard({
  meta,
  onDecide,
}: {
  meta: ChatCardMeta
  /** Resolves when the server has answered. Rejects with a message worth showing verbatim. */
  onDecide: (input: ChatDecisionInput) => Promise<void>
}) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const decide = useCallback(
    async (action: 'approve' | 'deny'): Promise<void> => {
      setBusy(action)
      setError(null)
      try {
        // The session id travels only for a worker card - a chat-op card has no session to check
        // against, and sending an empty one would read as "a card from a replaced session".
        await onDecide({
          requestId: meta.requestId,
          ...(meta.kind === 'approval' ? { workerSessionId: meta.workerSessionId } : {}),
          action,
        })
      } catch (failure) {
        setError(String(failure))
      } finally {
        setBusy(null)
      }
    },
    [meta, onDecide],
  )

  if (meta.state !== 'pending') return null

  return (
    <div className='mt-1.5 flex flex-wrap items-center gap-2'>
      <Button
        size='sm'
        // A purge is the one approval whose button should look like what it does.
        variant={meta.kind === 'chat-op' ? 'destructive' : 'default'}
        className='h-7 gap-1.5 px-2.5'
        disabled={busy !== null}
        onClick={() => void decide('approve')}>
        <Check className='size-3.5' />
        Approve
      </Button>
      <Button
        size='sm'
        variant='outline'
        className='h-7 gap-1.5 px-2.5'
        disabled={busy !== null}
        onClick={() => void decide('deny')}>
        <X className='size-3.5' />
        Deny
      </Button>
      {/* No "anyone in this room can answer" line since 2026-09-09. It went with the typed reply
          grammar it belonged to: both kinds ARE anyone-in-the-room, so the sentence only ever
          restated what the two live buttons already say, on every card, forever. Somebody who may
          not answer learns it from the server's refusal, which lands in `error`. */}
      {error !== null && <span className='text-label text-destructive'>{error}</span>}
    </div>
  )
}

/**
 * An approval card's message body, framed so it is legible as a decision rather than as nova
 * talking - and COLLAPSED to a single line once it has settled (2026-09-09).
 *
 * A pending card is the loudest thing in a room by design: it blocks a turn, and it renders in
 * full. A settled one is a different object with a different job. A turn may raise up to
 * `APPROVAL_CARDS_PER_TURN` (8) of them, each a full message row carrying the runner's title,
 * description and reason - so a room that has been working reads as a wall of answered questions
 * with the actual conversation buried between them. Worse, the turn streams its text into a
 * placeholder posted BEFORE any card, so everything the agent says after an approval sorts ABOVE
 * the card that unblocked it: the cards are not even in the order they were answered.
 *
 * So: one line, expandable. It is a COLLAPSE and not a hide, and that distinction is the whole
 * design. The settled card is the audit record - `decidedBy` is pinned to a `users.id` precisely
 * so "who allowed that Bash call" is answerable forever - and the session transcript is NOT a
 * fallback for it: a room's worker session is retired an hour after the room goes quiet and
 * forgotten on the next restart (see `AgentSessionDialog`), and a `chat-op` card has no worker
 * session at all. Hiding the row would make the record unreachable from every surface we have.
 *
 * The tint is keyed off `state` in both forms, because "**Approved** by Alice Strand." should
 * still read as a decision when you scroll past it a week later, not dissolve back into ordinary
 * chat.
 */
export function ApprovalBody({ meta, body }: { meta: ChatCardMeta; body: string }) {
  const [expanded, setExpanded] = useState(false)
  const chatOp = meta.kind === 'chat-op'
  const settled = meta.state !== 'pending'

  if (settled && !expanded) return <ApprovalSummary meta={meta} expanded={false} onToggle={() => setExpanded(true)} />

  return (
    <div
      className={cn(
        'mt-1 max-w-2xl overflow-hidden rounded-lg border',
        meta.state === 'pending' && (chatOp ? 'border-destructive/40' : 'border-warning/40'),
        meta.state === 'approved' && 'border-success/40',
        meta.state === 'denied' && 'border-destructive/40',
        meta.state === 'expired' && 'border-border',
      )}>
      <div
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 text-label font-medium',
          meta.state === 'pending' && (chatOp ? 'bg-destructive/[0.07] text-destructive' : 'bg-warning/[0.09] text-warning'),
          meta.state === 'approved' && 'bg-success/[0.07] text-success',
          meta.state === 'denied' && 'bg-destructive/[0.07] text-destructive',
          meta.state === 'expired' && 'bg-muted/60 text-muted-foreground',
        )}>
        {settled ? (
          // The expanded card keeps its summary AS the header, so the control that opened it is the
          // control that closes it - and the row never loses the line saying who answered.
          <ApprovalSummary meta={meta} expanded onToggle={() => setExpanded(false)} inHeader />
        ) : (
          <>
            {chatOp ? <Trash2 className='size-3.5 shrink-0' aria-hidden /> : <ShieldQuestion className='size-3.5 shrink-0' aria-hidden />}
            <span className='min-w-0 truncate'>{chatOp ? meta.label : meta.toolName}</span>
          </>
        )}
      </div>
      {/* `approval-prose` (globals.css) holds every descendant - paragraphs, inline code and the
          shiki block alike - at the header's own size. The rule the design turns on: nothing inside
          a card may be BIGGER than the card's own title, or the card reads as the message rather
          than as a footnote on one. */}
      <div className='approval-prose border-t px-2.5 py-2'>
        <MessageBody body={cardProse(body)} />
      </div>
    </div>
  )
}

/**
 * A settled card's body minus its closing status line.
 *
 * Mirrors `approvalCardProse` in `@silkweave/box-core` (the source of truth - this package does not depend on
 * it, exactly like `chatTypes.ts` mirrors the wire DTOs). The line stays in the STORED body, which
 * is the durable audit record and has to read correctly in a raw dump; it is dropped here because
 * the card's own header already says "Approved by Alice Strand" three lines above it.
 */
function cardProse(body: string): string {
  const parts = body.split('\n\n')
  const last = parts.at(-1)
  if (last !== undefined && /^\*\*(Approved|Denied|Expired|Pending)\b/.test(last)) parts.pop()
  return parts.join('\n\n').trim()
}

/**
 * The one line a settled card collapses to: what was asked, how it went, who said so, and when.
 *
 * Everything a reader scanning past needs, and nothing they do not - the runner's title,
 * description and decision reason are one click away rather than in the transcript forever. The
 * name is resolved LIVE against the users directory rather than read out of the body's prose,
 * for the same reason the avatar is: `decidedBy` is the durable identifier and a display name is
 * a mutable label. It falls back to the raw id, which is still an answer.
 */
function ApprovalSummary({
  meta,
  expanded,
  onToggle,
  inHeader = false,
}: {
  meta: ChatCardMeta
  expanded: boolean
  onToggle: () => void
  /** Rendered INSIDE an expanded card's header strip, which already owns the tint and the padding. */
  inHeader?: boolean
}) {
  const { data: users } = useUsersData()
  const chatOp = meta.kind === 'chat-op'
  const decidedBy = meta.decidedBy ?? null
  const known = decidedBy === null ? undefined : users?.find((u) => u.id === decidedBy)
  const who = decidedBy === null ? null : known !== undefined ? userName(known) : decidedBy
  // `expired` never carries a decider - nobody answered, which is exactly what it has to say.
  const outcome =
    meta.state === 'expired'
      ? 'Expired'
      : meta.state === 'approved'
        ? who === null
          ? 'Approved'
          : `Approved by ${who}`
        : who === null
          ? 'Denied'
          : `Denied by ${who}`

  return (
    <button
      type='button'
      onClick={onToggle}
      aria-expanded={expanded}
      title={expanded ? 'Collapse this approval' : 'Show what was asked'}
      className={cn(
        'flex min-w-0 max-w-full items-center gap-1.5 rounded-sm text-label transition-colors',
        'focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        inHeader
          ? 'w-full text-current'
          : 'mt-0.5 px-1 py-px text-muted-foreground hover:bg-muted',
      )}>
      <ChevronRight className={cn('size-3 shrink-0 transition-transform', expanded && 'rotate-90')} aria-hidden />
      {chatOp ? <Trash2 className='size-3.5 shrink-0' aria-hidden /> : <ShieldQuestion className='size-3.5 shrink-0' aria-hidden />}
      <span className='min-w-0 truncate'>{chatOp ? meta.label : meta.toolName}</span>
      <span
        className={cn(
          'shrink-0 font-medium',
          // Inside the header the whole strip is already tinted by state, so a second colour here
          // would fight it. Standing alone in the transcript, the colour IS the signal.
          !inHeader && meta.state === 'approved' && 'text-success',
          !inHeader && meta.state === 'denied' && 'text-destructive',
        )}>
        {outcome}
      </span>
      {meta.decidedAt !== undefined && (
        <span className='shrink-0 tabular-nums opacity-70'>{timeFormat.format(meta.decidedAt)}</span>
      )}
    </button>
  )
}
