import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  AGENT_PLACEHOLDER_BODY,
  type AgentActivityFrame,
  type ChatDecisionInput,
  type ChatMessage,
} from '../lib/chatTypes.ts'
import { Button, confirm } from '@silkweave/box-ui'
import { AgentActivityLine, AgentTurnRecord, AgentTypingDots } from './AgentActivity.tsx'
import { ApprovalBody, ApprovalCard } from './ApprovalCard.tsx'
import { ChatAvatar } from './ChatAvatar.tsx'
import { Reactions, ReactionPicker } from './Reactions.tsx'
import { Composer } from './ComposerLazy.tsx'
import { Attachments } from './Attachments.tsx'
import { MessageBody } from './MessageBody.tsx'

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

/**
 * The hover timestamp lives in the 32px avatar gutter, where a locale that appends "AM" wraps to a
 * second line and silently makes every continuation row taller than the rows around it. Drop the day
 * period rather than widening the gutter or hardcoding a 24-hour clock.
 */
function gutterTime(at: number): string {
  return timeFormat
    .formatToParts(at)
    .filter((part) => part.type !== 'dayPeriod')
    .map((part) => part.value)
    .join('')
    .trim()
}
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

/** Consecutive messages from one sender inside this window collapse into a single block. */
const GROUP_WINDOW_MS = 5 * 60 * 1000

interface MessageListProps {
  messages: ChatMessage[]
  /**
   * The member's read pointer as it stood when the room was opened - a `createdAt`; the divider
   * renders above the first message STRICTLY past it. Null when nothing was unread. Deliberately a
   * key and not an id: the message the pointer names may be deleted while the room is open, and
   * the line must not move while the user is looking at it.
   */
  unreadAfter: number | null
  nextCursor: number | null
  loadingMore: boolean
  onLoadMore: () => void
  /**
   * What the room's agent turn is doing right now, or null when nothing is in flight.
   *
   * Rendered on the HEADER line of the message whose id is `activity.messageId` - the placeholder
   * the turn is filling in. When that message is NOT in the loaded page (an orphan turn, or one
   * whose placeholder has scrolled out) it falls back to a detached line at the tail rather than
   * borrowing the last row's header: that header carries somebody's name and avatar, and hanging
   * "reading WAREHOUSE.md" on it would say that person is doing the work.
   */
  activity: AgentActivityFrame | null
  /** Open the transcript for a turn's worker session. Owned by the view, not by the activity line:
   *  the line vanishes the moment the turn ends, and a dialog inside it would go with it. */
  onViewSession: (workerSessionId: string) => void
  /** The signed-in principal's users.id, or null when unknown - the ONLY thing that decides
   *  whether the edit/delete affordance renders. The server enforces the same rule for real. */
  currentUserId: string | null
  onEdit: (messageId: string, body: string) => Promise<void>
  onDelete: (messageId: string) => Promise<void>
  /** Toggle one of YOUR reactions on any message in the room (Track 10). */
  onReact: (messageId: string, emoji: string, on: boolean) => Promise<void>
  /** Answer an agent approval card (Track 19). Resolves once the SERVER has settled it - the card
   *  repaints from the `message.edited` frame that follows, never from a local guess. */
  onDecide: (input: ChatDecisionInput) => Promise<void>
  /** Replies by thread root id. Absent = never opened (which is NOT "no replies" - that is the
   *  root's `thread` summary being absent). */
  threads: Record<string, ChatMessage[]>
  /** Roots whose thread is open right now. */
  expandedThreads: string[]
  /** Roots whose reply list is in flight. */
  loadingThreads: string[]
  /** Open or close one thread. Opening a thread that has never been opened fetches it. */
  onToggleThread: (rootId: string) => void
  /**
   * The thread the room's ONE composer is aimed at, or null for the room. Lifted out of this
   * component when the reply box moved to the bottom of the room: the composer lives next to the
   * view, so the view owns which thread it is pointing at.
   */
  replyingTo: { rootId: string; senderName: string } | null
  /** Aim the composer at a thread, or back at the room with null. */
  onReplyTo: (target: { rootId: string; senderName: string } | null) => void
}

interface Row {
  message: ChatMessage
  /** Renders the avatar, name and timestamp header. */
  startsGroup: boolean
  /** Day separator text, when this message is the first of a new calendar day. */
  daySeparator: string | null
  showUnreadDivider: boolean
}

export function MessageList({
  messages,
  unreadAfter,
  nextCursor,
  loadingMore,
  onLoadMore,
  activity,
  onViewSession,
  currentUserId,
  onEdit,
  onDelete,
  onReact,
  onDecide,
  threads,
  expandedThreads,
  loadingThreads,
  onToggleThread,
  replyingTo,
  onReplyTo,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const firstId = messages[0]?.id
  // The newest thing on screen, timeline or thread. A reply lands in an OPEN thread without
  // touching the timeline's tail, so keying this on `messages.at(-1)` alone would leave a live
  // thread scrolling off the bottom of the room while it filled in - which is exactly what a
  // streaming agent turn now does, since its answer is a reply.
  const latestId = useMemo(() => {
    let newest = messages.at(-1)
    for (const rootId of expandedThreads) {
      const tail = threads[rootId]?.at(-1)
      if (tail !== undefined && (newest === undefined || tail.createdAt > newest.createdAt)) newest = tail
    }
    return newest?.id
  }, [messages, threads, expandedThreads])

  // WHERE THE COMPOSER IS AIMED, and the id of the block that has to stay glued to the bottom of
  // this box while it is. Read in three places below, so it is resolved once here.
  const replyRootId = replyingTo?.rootId ?? null
  // The root+thread blocks, by root id. Needed because "put the reply bar directly under what I am
  // replying to" is a measurement, and only the DOM knows how tall a thread is.
  const blockRefs = useRef(new Map<string, HTMLDivElement>())
  // Both grown only while the composer is aimed at a thread - see `alignReplyTarget`.
  const headSpacerRef = useRef<HTMLDivElement>(null)
  const tailSpacerRef = useRef<HTMLDivElement>(null)
  const setBlockRef = useCallback((rootId: string, node: HTMLDivElement | null): void => {
    if (node === null) blockRefs.current.delete(rootId)
    else blockRefs.current.set(rootId, node)
  }, [])

  /**
   * Park the reply target's LAST line against the bottom edge of the scroller, so the composer -
   * which owns the strip immediately below this box - reads as hanging off the thread it is
   * aimed at. Replying to something you cannot see is how a reply lands in the wrong place.
   *
   * Instant, always. Every scroll in this room is (2026-09-04): a smooth scroll here animates the
   * thing you are trying to look at away from under the cursor, and lands late enough that the
   * next measurement reads a position the reader is no longer at.
   */
  const alignReplyTarget = useCallback((): boolean => {
    const el = scrollRef.current
    const head = headSpacerRef.current
    const tail = tailSpacerRef.current
    if (el === null) return false
    // Always measure from a clean slate: a spacer's own height must never feed back into the
    // number that decides how tall it should be.
    if (head !== null) head.style.height = '0px'
    if (tail !== null) tail.style.height = '0px'
    const block = replyRootId === null ? undefined : blockRefs.current.get(replyRootId)
    if (block === undefined) return false

    // Scrolling alone cannot always land the target on the bottom edge: a thread in the middle of
    // a short room has no transcript under it to scroll past, and one near the TOP has nothing
    // above it to scroll away. So PAD FIRST, ALIGN, THEN TRIM: a full viewport of slack on each
    // side makes the alignment always reachable in one measurement (it also cancels `justify-end`,
    // which otherwise silently swallows the first slice of head padding by pinning a short room to
    // the bottom of the canvas), and giving back whatever went unused leaves no visible gap.
    const slack = el.clientHeight
    if (head !== null) head.style.height = `${slack}px`
    if (tail !== null) tail.style.height = `${slack}px`
    el.scrollTop += block.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom

    if (head !== null) {
      // Shrinking above the fold moves the content up by the same amount, so the scroll position
      // has to give back exactly what the spacer did.
      const unused = Math.min(slack, el.scrollTop)
      head.style.height = `${slack - unused}px`
      el.scrollTop -= unused
    }
    if (tail !== null) {
      const unused = Math.min(slack, el.scrollHeight - el.clientHeight - el.scrollTop)
      tail.style.height = `${slack - unused}px`
    }
    return true
  }, [replyRootId])

  // Follow the tail on new messages. Keyed on the last id rather than length so prepending an older
  // page does not yank the view back to the bottom. While the composer is aimed at a thread the
  // TARGET is the anchor instead of the tail - a reply arriving three threads down must not drag
  // the view off what you are in the middle of answering.
  useLayoutEffect(() => {
    if (alignReplyTarget()) return
    const el = scrollRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [latestId, alignReplyTarget])

  // Re-align when the target itself changes shape: aiming at a different thread, and the replies
  // of a thread that was still loading when it was aimed at (they arrive a frame later and are
  // exactly the height the alignment depends on).
  const replyThreadCount = replyRootId === null ? 0 : (threads[replyRootId]?.length ?? 0)
  useLayoutEffect(() => {
    alignReplyTarget()
  }, [alignReplyTarget, replyThreadCount])

  // Whether the reader is parked at the tail. Read on scroll rather than computed on demand,
  // because the answer is needed AFTER a resize has already changed the geometry it depends on.
  const atBottomRef = useRef(true)
  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (el === null) return
    // A few pixels of slack: sub-pixel layout and a smooth scroll that has not quite landed both
    // leave a gap that is not the reader having scrolled away.
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 64
  }, [])

  // The composer OWNS the bottom of this column, so anything that changes its height - the
  // "Replying to" banner appearing, an attachment chip, a draft growing to three lines - shrinks
  // this box from below. The browser keeps scrollTop, which means the newest message silently
  // slides out of view exactly when the user is about to answer it. Re-pin instead: if they were
  // at the tail before the resize, they are at the tail after it.
  useEffect(() => {
    const el = scrollRef.current
    if (el === null) return
    const observer = new ResizeObserver(() => {
      // Instant, not smooth: this is a layout correction, not a movement anyone asked for, and a
      // smooth scroll here reads as the room drifting on its own.
      // The "Replying to" banner is itself one of these resizes, so the anchor has to win here or
      // the alignment we just computed is undone by the banner that announced it.
      if (alignReplyTarget()) return
      if (atBottomRef.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [alignReplyTarget])

  // Scroll anchoring for loadOlder: prepending a page grows the content ABOVE the viewport, which
  // by default shoves what the user was reading down and off. Capture the geometry at click,
  // restore distance-from-old-content once the older page has rendered. Done by hand (with the
  // browser's own anchoring disabled via overflow-anchor below) rather than trusting native scroll
  // anchoring: Safari has none, and Chrome suppresses it at scrollTop 0 - which is exactly where a
  // user who just clicked "Load older messages" is.
  const anchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null)
  const loadOlderAnchored = useCallback((): void => {
    const el = scrollRef.current
    if (el) anchorRef.current = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }
    onLoadMore()
  }, [onLoadMore])
  useLayoutEffect(() => {
    // Runs when the top of the list changes; a pending anchor means it changed by a prepend.
    const el = scrollRef.current
    const anchor = anchorRef.current
    if (el === null || anchor === null) return
    anchorRef.current = null
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight)
  }, [firstId])

  const rows = useMemo(
    () =>
      buildRows(
        messages,
        unreadAfter,
        (m) => m.thread !== undefined || expandedThreads.includes(m.id)
      ),
    [messages, unreadAfter, expandedThreads],
  )
  /**
   * Open a thread, and optionally aim the room's composer at it.
   *
   * Auto-expansion (a reply landing while you watch) shows the REPLIES; asking to WRITE is a
   * separate gesture, and this is where it lands. At most one thread is ever the target, which is
   * now structural rather than a rule: there is one composer.
   */
  const openThread = useCallback(
    (root: ChatMessage, focus: boolean): void => {
      const open = expandedThreads.includes(root.id)
      // "Reply" on an already-open thread must not close it - it means "let me write", so it only
      // toggles when the gesture was the toggle itself.
      if (!open || !focus) onToggleThread(root.id)
      if (focus) {
        onReplyTo({ rootId: root.id, senderName: root.senderName })
        return
      }
      // Collapsing the thread you were writing into puts the composer back on the room: a target
      // you cannot see is how a reply gets posted into the wrong place.
      if (open && replyingTo?.rootId === root.id) onReplyTo(null)
    },
    [expandedThreads, onToggleThread, onReplyTo, replyingTo],
  )
  // The turn's OWN placeholder, when that row is on screen. Only then does the activity go on a
  // message header: the header carries a name and an avatar, so hanging "reading WAREHOUSE.md" on
  // somebody else's row would say that PERSON is doing the work.
  // Searched across the loaded THREADS too, not just the timeline: since threads shipped, the
  // agent's placeholder is a reply, so the turn's own row is almost never in `messages`. Missing
  // it here would put every turn's activity on the detached tail line instead of on the message
  // it is actually writing.
  const ownedAnchorId =
    activity === null
      ? null
      : ([...messages, ...Object.values(threads).flat()].find((m) => m.id === activity.messageId)?.id ?? null)
  // An orphan turn (no placeholder of its own, or one that has scrolled out of the loaded page)
  // still has to be visible, so it falls back to a detached line at the tail - attributed to
  // nobody, which is exactly what is true about it.
  const detached = activity !== null && ownedAnchorId === null

  return (
    <div ref={scrollRef} onScroll={onScroll} className='min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]'>
      {/* min-h-full + justify-end pins a short history to the BOTTOM of the canvas, the way every
          chat behaves: a room with three messages in it should read as three messages just said,
          not as three messages stranded at the top of an empty page. Once the content outgrows the
          viewport this has no effect and normal top-down scrolling takes over. */}
      <div className='flex min-h-full flex-col justify-end py-4'>
        {/* The head spacer - see the tail one at the bottom of this list. */}
        <div ref={headSpacerRef} aria-hidden style={{ height: 0 }} />

        {nextCursor !== null && (
          <div className='flex justify-center px-3 pb-3 sm:px-4'>
            <Button variant='outline' size='sm' onClick={loadOlderAnchored} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load older messages'}
            </Button>
          </div>
        )}

        {messages.length === 0 && (
          <p className='py-12 text-center text-body-sm text-muted-foreground'>
            No messages yet. Say something to get started.
          </p>
        )}

        {rows.map(({ message, startsGroup, daySeparator, showUnreadDivider }) => (
          <div key={message.id}>
            {daySeparator && <Separator label={daySeparator} />}
            {showUnreadDivider && <Separator label='New messages' tone='accent' />}
            {/* The root and its thread are ONE block while the composer is aimed at them: tinted
                and ruled so the room says what the reply is going to attach to, and measured as a
                unit by `alignReplyTarget` so the input sits directly under its last line. The tint
                is transient by construction - it lives exactly as long as reply mode - which is
                why an accent surface is safe here and was not for @-mentions. */}
            <div
              ref={(node) => setBlockRef(message.id, node)}
              className={cn(
                'transition-colors',
                // A left rule rather than a ring: a thread can be taller than the viewport, and a
                // ring's edges are then both off-screen, leaving nothing on screen saying WHICH
                // thread the composer is aimed at.
                replyRootId === message.id && 'border-l-2 border-l-accent bg-accent/[0.07] py-0.5',
              )}>
              <MessageRow
                message={message}
                startsGroup={startsGroup}
                mine={currentUserId !== null && message.senderId === currentUserId}
                currentUserId={currentUserId}
                activity={activity !== null && message.id === ownedAnchorId ? activity : null}
                onViewSession={onViewSession}
                onEdit={onEdit}
                onDelete={onDelete}
                onReact={onReact}
                onDecide={onDecide}
                onReply={() => openThread(message, true)}
                threadToggle={{
                  open: expandedThreads.includes(message.id),
                  loading: loadingThreads.includes(message.id),
                  onToggle: () => openThread(message, false),
                }}
              />
              <Thread
                root={message}
                replies={threads[message.id]}
                open={expandedThreads.includes(message.id)}
                loading={loadingThreads.includes(message.id)}
                composing={replyingTo?.rootId === message.id}
                onToggle={() => openThread(message, false)}
                onCompose={() => openThread(message, true)}
                activity={activity}
                activityAnchorId={ownedAnchorId}
                currentUserId={currentUserId}
                onViewSession={onViewSession}
                onEdit={onEdit}
                onDelete={onDelete}
                onReact={onReact}
                onDecide={onDecide}
              />
            </div>
          </div>
        ))}

        {/* The tail spacer. Heights are set imperatively (never in React state) because they are
            measurements of the scroll geometry, and re-rendering to change one would invalidate
            the very geometry that produced it. */}
        <div ref={tailSpacerRef} aria-hidden style={{ height: 0 }} />

        {detached && activity !== null && (
          // Indented to the message body's column (the 32px avatar gutter plus its gap) so it
          // lines up with the transcript, but deliberately not inside any row.
          <AgentActivityLine
            activity={activity}
            onViewSession={onViewSession}
            className='mx-3 mt-1 sm:mx-4'
          />
        )}
      </div>
    </div>
  )
}

interface MessageRowProps {
  message: ChatMessage
  startsGroup: boolean
  /** Whether the signed-in principal wrote this - the edit/delete affordance renders only then. */
  mine: boolean
  /** Who is looking. `mine` already answers "did I write this"; this is needed separately because
   *  a reaction pill asks "am I in it" about OTHER people's messages too. */
  currentUserId: string | null
  /** The turn anchored HERE, or null. Non-null puts the activity cluster on the header line and
   *  swaps a still-empty body for the typing indicator. */
  activity: AgentActivityFrame | null
  onViewSession: (workerSessionId: string) => void
  onEdit: (messageId: string, body: string) => Promise<void>
  onDelete: (messageId: string) => Promise<void>
  /** Toggle one of YOUR reactions on any message in the room (Track 10). */
  onReact: (messageId: string, emoji: string, on: boolean) => Promise<void>
  onDecide: (input: ChatDecisionInput) => Promise<void>
  /** Open (or close) this message's thread. Present on every row - replying to a REPLY is a reply
   *  in the same thread, because the server re-parents onto the root. */
  onReply: () => void
  /** The collapsed-thread toggle's live state, when this row is a root that HAS a thread. Null on
   *  a reply and on a root nobody has answered - there is nothing to toggle in either case. */
  threadToggle?: { open: boolean; loading: boolean; onToggle: () => void } | null
  /** A reply INSIDE a thread: smaller avatar and a tighter gutter, so the eye reads the block as
   *  subordinate to its root rather than as more room. */
  compact?: boolean
}

function MessageRow({
  message,
  startsGroup,
  mine,
  currentUserId,
  activity,
  onViewSession,
  onEdit,
  onDelete,
  onReact,
  onDecide,
  onReply,
  threadToggle,
  compact = false,
}: MessageRowProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // TOUCH reveal for the hover toolbar. There is no hover on a phone, and an always-on row of
  // verbs under every message is exactly the noise the toolbar exists to remove - so a long press
  // is the gesture, the way it is in every native messenger. Pointer events rather than touch
  // events so a stylus and a trackpad long-press behave the same.
  const [pressed, setPressed] = useState(false)
  // While the emoji palette is open the toolbar must stay put even though the pointer has left the
  // row to reach it.
  const [pickerOpen, setPickerOpen] = useState(false)
  const rowRef = useRef<HTMLDivElement | null>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelLongPress = useCallback(() => {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }, [])
  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === 'mouse') return
      cancelLongPress()
      pressTimer.current = setTimeout(() => setPressed(true), 450)
    },
    [cancelLongPress],
  )
  // Any press that is not inside this row puts the toolbar away again - the phone equivalent of
  // the pointer leaving. Registered only while it is showing, so idle rows cost nothing.
  useEffect(() => {
    if (!pressed) return
    const dismiss = (event: Event) => {
      if (rowRef.current?.contains(event.target as Node) === true) return
      setPressed(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [pressed])
  useEffect(() => cancelLongPress, [cancelLongPress])
  const showActions = pressed || pickerOpen
  const actionable = mine
  // Narrowed by `kind` rather than by presence: `meta` is an open union by design, and a future
  // shape must render as an ordinary message here rather than as a broken approval card. Both
  // card kinds go through one surface - a worker's permission request and a chat operation held
  // for a human differ in what they ask, not in how they are answered.
  const approval =
    message.meta !== undefined && (message.meta.kind === 'approval' || message.meta.kind === 'chat-op')
      ? message.meta
      : null
  // A turn in flight always gets its own header, even when it would otherwise have folded into the
  // sender's previous block: the header is where the activity cluster lives, and a folded row has
  // no header to put it on. The cost is one extra avatar for the length of the turn.
  // The durable trace of a turn that has ENDED. Mutually exclusive with `activity` in practice
  // (the record is stamped by the same write that ends the turn), but rendered independently so a
  // reload, a reconnect or a restart still leaves the transcript reachable - which is the whole
  // point of it being a column rather than a frame.
  const turn = message.meta !== undefined && message.meta.kind === 'agent-turn' ? message.meta : null
  // A turn needs a header whether it is RUNNING or FINISHED: the header is the one line both the
  // activity cluster and the session record live on, and a row folded into the sender's previous
  // block has no header to put either on. Before the record moved up here, `activity !== null` was
  // enough - a finished turn kept its record under the body, which any folded row still had.
  // A SETTLED card never gets one, whatever the grouping says. It collapses to a single line
  // (see ApprovalBody), and an avatar + "Nova 10:26" above that line is three times the chrome of
  // the content it introduces - which is the clutter the collapse exists to remove. It is also
  // redundant: every card in a room is nova's, and the collapsed line carries its own decision
  // time. A PENDING card keeps its header, because a card blocking a turn should read as loud.
  const settledCard = approval !== null && approval.state !== 'pending'
  const header = (startsGroup && !settledCard) || activity !== null || turn !== null
  // The placeholder is a literal `…`, so a room watching a turn start would otherwise see a static
  // ellipsis. Swap it for motion until the first real character lands - `deliver` replaces the body
  // wholesale, so this flips exactly once.
  const typing = activity !== null && message.body.trim() === AGENT_PLACEHOLDER_BODY

  // Takes the body from the editor rather than reading state: Composer owns the draft now.
  // Deliberately does NOT catch - Composer renders the failure inline and keeps the draft, which is
  // the whole reason it tracks its own sending state.
  const save = useCallback(
    async (body: string): Promise<void> => {
      const next = body.trim()
      // An unchanged body is a no-op, not an edit - it would otherwise stamp `edited_at` and hang
      // an "(edited)" marker on a message nobody touched. Worth keeping now that the round-trip
      // through TipTap can normalize markdown without changing meaning.
      if (next.length === 0 || next === message.body) {
        setEditing(null)
        return
      }
      await onEdit(message.id, next)
      setEditing(null)
    },
    [message.body, message.id, onEdit],
  )

  const remove = useCallback(async (): Promise<void> => {
    // A root with replies takes the whole thread with it, other people's replies included - the
    // server cascades on the root's authorization alone. That has to be said BEFORE the click,
    // because nothing afterwards can undo it and nothing is left to show what went.
    const cascade = message.thread !== undefined
    if (
      !(await confirm({
        title: cascade ? 'Delete this message and its thread?' : 'Delete this message?',
        message: cascade
          ? 'This message has replies, and deleting it deletes every reply under it - including ones other people wrote. Everyone in the room stops seeing all of it. This cannot be undone.'
          : 'Everyone in the room stops seeing it. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onDelete(message.id)
    } catch (failure) {
      setError(String(failure))
    } finally {
      setBusy(false)
    }
  }, [message.id, message.thread, onDelete])

  return (
    <div
      ref={rowRef}
      className={cn(
        'group relative flex gap-2 py-0.5 transition-colors hover:bg-muted/40 sm:gap-2.5',
        compact ? 'px-2' : 'px-3 sm:px-4',
        header && 'mt-2 pt-1',
      )}
      onPointerDown={onPointerDown}
      onPointerUp={cancelLongPress}
      onPointerMove={cancelLongPress}
      onPointerCancel={cancelLongPress}>
      {/* THE ACTION OVERLAY. Floating, and deliberately so: react/reply/edit/delete are things you
          can DO to a message, not things it says, so they must cost zero layout - neither a
          reserved strip under every row (what shipped before 2026-09-04) nor a grouped row that
          grows a header line and shoves the transcript around under the cursor (tried the same
          day, worse).
          
          It rides the row's TOP-RIGHT corner, out over the empty gutter to the right of the text
          where it covers nothing anybody is reading, and it is OPAQUE with a border and a shadow -
          it sits over the row above, so anything less reads as a rendering fault.
          
          Revealed by hover, by focus-within for the keyboard, and by a LONG PRESS on touch (see
          `pressed`) - a phone has none of the first two. It pins itself open while the emoji
          palette is up, because reaching the palette means leaving the row. */}
      <div
        className={cn(
          'absolute -top-3 right-2 z-30 items-center gap-0.5 rounded-md border border-border bg-bg p-0.5 shadow-md group-focus-within:flex sm:group-hover:flex',
          showActions ? 'flex' : 'hidden',
        )}>
        <ReactionPicker
          reactions={message.reactions}
          currentUserId={currentUserId}
          onReact={(emoji, on) => onReact(message.id, emoji, on)}
          onOpenChange={setPickerOpen}
          className='flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none'
        />
        <Button
          variant='ghost'
          size='sm'
          className='h-6 px-1.5 text-label text-muted-foreground'
          disabled={busy}
          onClick={onReply}>
          Reply
        </Button>
        {actionable && (
          <>
            <Button
              variant='ghost'
              size='sm'
              className='h-6 px-1.5 text-label text-muted-foreground'
              disabled={busy}
              onClick={() => {
                setError(null)
                setEditing(message.body)
              }}>
              Edit
            </Button>
            <Button
              variant='ghost'
              size='sm'
              className='h-6 px-1.5 text-label text-destructive'
              disabled={busy}
              onClick={() => void remove()}>
              Delete
            </Button>
          </>
        )}
      </div>

      <div className={cn('shrink-0 pt-0.5', compact ? 'w-6' : 'w-8')}>
        {header ? (
          <ChatAvatar senderId={message.senderId} senderName={message.senderName} size={compact ? 'sm' : 'md'} />
        ) : (
          <span className='block text-right text-[0.625rem] leading-5 whitespace-nowrap tabular-nums text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100'>
            {gutterTime(message.createdAt)}
          </span>
        )}
      </div>

      <div className='min-w-0 flex-1'>
        {header && (
          // `items-center`, not baseline: the activity cluster carries an icon, and baseline
          // alignment would hang it half a line below the name it sits next to. The name and time
          // keep their own baseline relationship inside their own box.
          <div className='flex min-w-0 items-center gap-2'>
            <span className='text-body font-semibold'>{message.senderName}</span>
            <span className='text-label tabular-nums text-muted-foreground'>{timeFormat.format(message.createdAt)}</span>
            {/* One slot, two states. While the turn runs this is the live cluster; the moment it
                ends the same position carries the durable record, so the control does not appear to
                move when the turn settles. Never both - `activity` is cleared by the same write
                that stamps the record. */}
            {activity !== null ? (
              <AgentActivityLine activity={activity} onViewSession={onViewSession} className='min-w-0 flex-1' />
            ) : turn !== null ? (
              <AgentTurnRecord turn={turn} onViewSession={onViewSession} />
            ) : null}
          </div>
        )}

        {editing !== null ? (
          // The rich editor, not a raw-markdown textarea (changed 2026-08-26). Editing is where
          // people reach for @-mentions and formatting most often - fixing a name you got wrong is
          // the single most common edit - so the edit surface has to be the same one that can
          // produce them. The cost, accepted: the body round-trips through TipTap, so markdown gets
          // normalized on save even when nothing was changed. See Composer's `initialBody`.
          <Composer
            placeholder='Edit this message'
            disabled={busy}
            initialBody={editing}
            onCancel={() => setEditing(null)}
            onSend={save}
          />
        ) : (
          <>
            {/* An approval card is a message with structure, not a different KIND of thing - which
                is why the fallback below is the ordinary body, and why a client that has never
                heard of `meta` loses the buttons and nothing else. */}
            {approval !== null ? (
              <>
                <ApprovalBody meta={approval} body={message.body} />
                <ApprovalCard meta={approval} onDecide={onDecide} />
              </>
            ) : typing ? (
              <AgentTypingDots className='text-muted-foreground' />
            ) : (
              <MessageBody body={message.body} />
            )}
            {message.attachments !== undefined && message.attachments.length > 0 && (
              <Attachments attachments={message.attachments} />
            )}
            {message.editedAt !== null && <span className='text-label text-muted-foreground'>(edited)</span>}
            {/* THE DURABLE LINE. Only what is a FACT about the message - how many replies it
                has, and what people have said with an emoji. Both are permanent and visible to
                everyone, so they occupy real layout. The verbs used to live here too, revealed on
                hover, which meant every message reserved a line of empty space for a toolbar that
                was not there (2026-09-04): a room full of plain messages read as a ladder of gaps.
                Now the whole row is CONDITIONAL - no thread and no reactions renders nothing at
                all - and the verbs hang off the row instead (below). */}
            {(threadToggle != null || (message.reactions !== undefined && message.reactions.length > 0)) && (
              <div className='mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5'>
                {threadToggle != null && message.thread !== undefined && (
                  <button
                    type='button'
                    onClick={threadToggle.onToggle}
                    aria-expanded={threadToggle.open}
                    className='flex items-center gap-1.5 rounded px-1.5 py-0.5 text-label text-accent transition-colors hover:bg-muted/60'>
                    <ChevronRight
                      className={cn('size-3.5 transition-transform', threadToggle.open && 'rotate-90')}
                      aria-hidden
                    />
                    <span className='flex -space-x-1.5'>
                      {message.thread.participants.slice(0, 3).map((id) => (
                        <ChatAvatar key={id} senderId={id} senderName={id} size='xs' />
                      ))}
                    </span>
                    <span className='font-medium'>
                      {message.thread.replyCount} {message.thread.replyCount === 1 ? 'reply' : 'replies'}
                    </span>
                    {threadToggle.loading && <span className='text-muted-foreground'>loading…</span>}
                  </button>
                )}
                <Reactions
                  reactions={message.reactions}
                  currentUserId={currentUserId}
                  onReact={(emoji, on) => onReact(message.id, emoji, on)}
                />
              </div>
            )}

          </>
        )}

        {error !== null && <p className='text-label text-destructive'>{error}</p>}
      </div>
    </div>
  )
}

interface ThreadProps {
  root: ChatMessage
  /** Undefined = never opened. An empty array is a thread that WAS opened and holds nothing. */
  replies: ChatMessage[] | undefined
  open: boolean
  loading: boolean
  /** The room's composer is aimed at this thread - at most one thread in the room ever is. */
  composing: boolean
  onToggle: () => void
  /** Aim the room's composer here (opening the thread if it was closed). */
  onCompose: () => void
  activity: AgentActivityFrame | null
  activityAnchorId: string | null
  currentUserId: string | null
  onViewSession: (workerSessionId: string) => void
  onEdit: (messageId: string, body: string) => Promise<void>
  onDelete: (messageId: string) => Promise<void>
  /** Toggle one of YOUR reactions on any message in the room (Track 10). */
  onReact: (messageId: string, emoji: string, on: boolean) => Promise<void>
  onDecide: (input: ChatDecisionInput) => Promise<void>
}

/**
 * The replies under one root, when the thread is OPEN. The collapsed summary that opens it lives
 * on the root's own last line since 2026-09-03 - see MessageRow - so this renders nothing at all
 * for a closed thread.
 *
 * Everything stays on ONE surface rather than in a side panel, deliberately: a thread here is a
 * fold in the transcript, not a second place to look. The rules it encodes -
 *
 * - COLLAPSED on arrival. Opening a room must read as the room, not as every conversation it has
 *   ever held expanded at once.
 * - OPEN on new activity. A reply that lands while you are looking at the room opens its thread
 *   (`useChatRoom`'s frame handler does that), because a thread that silently swallows what just
 *   happened is worse than no thread.
 * - A root with no replies renders NOTHING here until somebody hits Reply, which opens the
 *   composer alone. A permanently visible "0 replies" affordance on every message is noise.
 */
function Thread({
  replies,
  open,
  loading,
  composing,
  onCompose,
  activity,
  activityAnchorId,
  currentUserId,
  onViewSession,
  onEdit,
  onDelete,
  onReact,
  onDecide,
}: ThreadProps) {
  // The COLLAPSED toggle moved onto the root's last line (2026-09-03) - see MessageRow. What is
  // left here is the expanded half alone, so a closed thread renders nothing at all rather than an
  // empty rule down the gutter.
  if (!open) return null

  const rows = buildRows(replies ?? [], null)
  // An EMPTY expanded thread is what "Reply" leaves behind when the reply is then cancelled: the
  // gesture opens the thread so the composer has somewhere to aim, and cancelling only clears the
  // aim. Rendering it anyway left a rule down the gutter and a "Reply in thread" button hanging
  // under a message nobody had answered - an affordance for a thread that does not exist. So an
  // open thread with nothing in it renders only while it is being written into (or while its
  // replies are still on the wire), and is otherwise invisible until somebody actually replies.
  if (rows.length === 0 && !composing && !loading) return null

  return (
    // The rule sits under the ROOT'S AVATAR (12px page padding + half the 32px gutter), so it
    // reads as a line dropping out of the person who spoke, and everything in the thread hangs to
    // the right of it. Getting this wrong in either direction is what made the first pass hard to
    // read: the toggle sat out at the body column with nothing connecting it to its root, while
    // the replies sat left of it, at the same depth as the room itself.
    <div className='ml-7 border-l-2 border-l-border/70 pl-1 sm:ml-8 sm:pl-2'>
      {open && (
        <>
          {rows.map(({ message, startsGroup }) => (
            <MessageRow
              key={message.id}
              message={message}
              startsGroup={startsGroup}
              mine={currentUserId !== null && message.senderId === currentUserId}
              currentUserId={currentUserId}
              activity={activity !== null && message.id === activityAnchorId ? activity : null}
              onViewSession={onViewSession}
              onEdit={onEdit}
              onDelete={onDelete}
              onReact={onReact}
              onDecide={onDecide}
              // Replying from inside a thread stays in that thread - the server re-parents onto
              // the root, so there is no second level to fall into.
              onReply={onCompose}
              compact
            />
          ))}
          {/* The way back into a thread that opened itself. Hidden while the composer is already
              aimed here - the banner above the input is saying so, and a second affordance for a
              state you are already in is noise. */}
          {!composing && (
            <button
              type='button'
              onClick={onCompose}
              className='rounded px-2 py-1 text-label text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground'>
              Reply in thread
            </button>
          )}
        </>
      )}
    </div>
  )
}

function Separator({ label, tone = 'muted' }: { label: string; tone?: 'muted' | 'accent' }) {
  const accent = tone === 'accent'

  return (
    <div className='flex items-center gap-3 px-3 py-2 sm:px-4' role='separator' aria-label={label}>
      <span className={cn('h-px flex-1', accent ? 'bg-accent/50' : 'bg-border')} />
      <span
        className={cn(
          'text-label font-medium',
          accent ? 'text-accent' : 'rounded-full border border-border px-2 py-0.5 text-muted-foreground',
        )}>
        {label}
      </span>
      <span className={cn('h-px flex-1', accent ? 'bg-accent/50' : 'bg-border')} />
    </div>
  )
}

/**
 * A card that has been answered. Invisible to GROUPING (see below) and headerless in `MessageRow`:
 * it collapses to one line, so it is a marginal note in the transcript rather than a message.
 */
const isSettledCard = (m: ChatMessage): boolean =>
  m.meta !== undefined && (m.meta.kind === 'approval' || m.meta.kind === 'chat-op') && m.meta.state !== 'pending'

function buildRows(messages: ChatMessage[], unreadAfter: number | null, threaded?: (m: ChatMessage) => boolean): Row[] {
  return messages.map((message, index) => {
    const previous = index === 0 ? null : messages[index - 1]!
    // Grouping looks PAST a settled card, which is why this is not just `previous`. A collapsed
    // card is a one-line note with no header of its own, so leaving it in the chain would let it
    // vouch for the row after it: a human speaks, nova's answered card lands, and nova's next
    // message renders headerless - hanging under somebody else's name with no author at all.
    let groupPrev: ChatMessage | null = null
    for (let i = index - 1; i >= 0; i--) {
      const candidate = messages[i]!
      if (isSettledCard(candidate)) continue
      groupPrev = candidate
      break
    }
    const daySeparator = previous && sameDay(previous.createdAt, message.createdAt) ? null : dayLabel(message.createdAt)
    // STRICTLY past the pointer: `unreadAfter` is the last message read, not the first unread, so
    // `>=` here would draw the line one message too early - above something already seen.
    const showUnreadDivider =
      unreadAfter !== null && message.createdAt > unreadAfter && (previous === null || previous.createdAt <= unreadAfter)

    // A separator of either kind interrupts the block: continuing a group across a horizontal rule
    // would leave the first message under it with no author. Computed from the list as it stands,
    // so a deleted message between two of one person's rows costs nothing here: the survivor after
    // the gap simply sees the survivor before it as `previous`.
    const startsGroup =
      groupPrev === null ||
      daySeparator !== null ||
      showUnreadDivider ||
      groupPrev.senderId !== message.senderId ||
      message.createdAt - groupPrev.createdAt > GROUP_WINDOW_MS ||
      // A thread block between two of one person's messages is a visual interruption exactly like
      // a separator: without this the message AFTER a thread renders headerless, hanging under the
      // thread's last reply with no name and no avatar.
      (threaded !== undefined && threaded(groupPrev))

    return { message, startsGroup, daySeparator, showUnreadDivider }
  })
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

function dayLabel(at: number): string {
  const day = new Date(at).toDateString()
  const now = Date.now()
  if (day === new Date(now).toDateString()) return 'Today'
  if (day === new Date(now - 86_400_000).toDateString()) return 'Yesterday'
  return dayFormat.format(at)
}
