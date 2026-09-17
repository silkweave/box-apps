// The chat data layer: the rooms store (sidebar), the per-room hook, and ONE module-scope
// chatFeed subscription per tab, mirroring changeFeed.ts. Chat deliberately does NOT ride the
// changes bus - its frames carry message payloads and are membership-filtered per principal
// server-side, which the broadcast invalidation feed cannot do - so this module owns its own
// subscription, reconnect loop and cursor.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createDataStore } from '../../../lib/dataStore.ts'
import type { RoomIconName } from './chatRoomIcons.ts'
import { trpc } from '../../../lib/trpc.ts'
import type {
  AgentActivityFrame,
  ChatAgentStatus,
  ChatDecisionInput,
  ChatFeedFrame,
  ChatHistoryPage,
  ChatMessage,
  ChatMessageDeletion,
  ChatReactionEvent,
  ChatReactionGroup,
  ChatReadState,
  ChatRoom,
  ChatRoomDeleteResult,
  ChatThreadPage,
  ChatThreadSummary,
} from './chatTypes.ts'

const RETRY_MS = 5_000
const MARK_READ_DEBOUNCE_MS = 800
/**
 * How long an activity line may sit with no news before the server is asked to settle it.
 *
 * Deliberately a RE-CHECK and not a clear. Silence does not mean the turn ended: the server
 * tolerates ten minutes of it before its own watchdog fires (`TURN_SILENCE_LIMIT_MS`), and one
 * slow tool call - a big warehouse query, a build - emits nothing for far longer than this. A
 * local clear would make the spinner vanish mid-turn and then reappear on the next frame, which
 * reads as "finished - no, still going". So this asks `chatAgentStatus` instead and believes the
 * answer, which also covers the case it was originally written for: a DROPPED terminal frame.
 *
 * The obvious cheaper rule -
 * "clear on any `message.edited` for this message, since finalizing the body doubles as a terminal
 * signal" - stopped being true when turns started streaming on 2026-09-02: a streaming turn edits
 * its placeholder on every checkpoint, up to twice a second, from the first token onward, so that
 * rule would kill the spinner almost immediately and leave the rest of the turn looking finished
 * while it is still working. A spinner that outlives its turn by a minute is a much smaller lie
 * than one that vanishes while the agent is still going, and `chatAgentStatus` settles it for real
 * on the next room open or reconnect.
 */
const ACTIVITY_STALE_MS = 90_000

export interface ChatRoomCreateInput {
  slug: string
  topic?: string
  /** A name from the server's curated icon list; omitted means the default (`hash`). */
  icon?: RoomIconName
  /** Free-form display name. Omitted means the slug is the name. */
  name?: string
}

/**
 * A patch on an existing room. Every field is OPTIONAL and omission means "leave it" - the server
 * reads it that way too, so a dialog sends only what actually changed.
 *
 * One field carries a consequence the caller has to have already warned about: `slug` changes the
 * room's ADDRESS (every saved link, and this tab's own route, stop resolving - navigate on
 * success). `name`, `topic` and `icon` take the empty string as "clear it", which is the wire's
 * way of saying null.
 */
export interface ChatRoomUpdateInput {
  slug?: string
  /** Free-form display name; '' clears it back to "the slug is the name". */
  name?: string
  topic?: string
  icon?: RoomIconName | ''
}

// ---------------------------------------------------------------------------------------------
// The wire boundary. The generated appRouter.d.ts reflects DTO nesting only ONE level deep, so
// nested chat outputs degrade to `unknown` (rooms: unknown[], messages: unknown[], payload,
// nextCursor, topic). The house answer is that the SPA casts - here, once, against the mirrors
// in chatTypes.ts, so no `as` leaks into the hooks below.
const wire = {
  rooms: (): Promise<ChatRoom[]> => trpc.chatRooms.query({}).then((d) => d.rooms as ChatRoom[]),
  // `roots: true` - the GROUPED shape: the timeline is thread roots, each carrying a summary of
  // what is under it, and the replies are fetched per thread by `thread` below. The flat shape is
  // still what every other client gets by default (and what the agent's own memory reads).
  history: (room: string, before?: number): Promise<ChatHistoryPage> =>
    trpc.chatHistory.mutate({ room, before, roots: true }).then((d) => d as ChatHistoryPage),
  thread: (room: string, messageId: string): Promise<ChatThreadPage> =>
    trpc.chatThread.mutate({ room, messageId }).then((d) => d as unknown as ChatThreadPage),
  post: (room: string, body: string, attachmentIds: string[], parentId?: string): Promise<ChatMessage> =>
    // Omitted entirely when empty: the server reads absent as "no attachments", and sending [] is
    // a claim of nothing.
    trpc.chatPost
      .mutate({
        room,
        body,
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        ...(parentId === undefined ? {} : { parentId }),
      })
      .then((d) => d.message as ChatMessage),
  edit: (room: string, messageId: string, body: string): Promise<ChatMessage> =>
    trpc.chatEdit.mutate({ room, messageId, body }).then((d) => d as ChatMessage),
  react: (room: string, messageId: string, emoji: string, on: boolean): Promise<ChatReactionGroup[]> =>
    trpc.chatReact
      .mutate({ room, messageId, emoji, on })
      .then((d) => (d as { reactions: ChatReactionGroup[] }).reactions),
  remove: (room: string, messageId: string): Promise<ChatMessageDeletion> =>
    trpc.chatDelete.mutate({ room, messageId }).then((d) => d as ChatMessageDeletion),
  markRead: (room: string, at: number): Promise<ChatReadState> =>
    trpc.chatMarkRead.mutate({ room, at }).then((d) => d as ChatReadState),
  roomCreate: (input: ChatRoomCreateInput): Promise<ChatRoom> =>
    trpc.chatRoomCreate.mutate(input).then((d) => d as ChatRoom),
  roomUpdate: (room: string, patch: ChatRoomUpdateInput): Promise<ChatRoom> =>
    trpc.chatRoomUpdate.mutate({ room, ...patch }).then((d) => d as ChatRoom),
  // `confirm` repeats the slug because the server demands a second statement of intent for the one
  // irreversible call in chat. The dialog makes the human type it, so this is not a formality the
  // client fills in on their behalf - it passes through what they typed.
  roomDelete: (room: string, confirm: string): Promise<ChatRoomDeleteResult> =>
    trpc.chatRoomDelete.mutate({ room, confirm }).then((d) => d as unknown as ChatRoomDeleteResult),
  // Idempotent by construction: the room's slug derives from the sorted pair of user ids, so a
  // second open finds the first room rather than creating a duplicate. That is why this is safe to
  // call from a picker with no "does one already exist" check in front of it.
  directOpen: (user: string): Promise<ChatRoom> =>
    trpc.chatDirectOpen.mutate({ user }).then((d) => d as ChatRoom),
  agentStatus: (room: string): Promise<ChatAgentStatus> =>
    trpc.chatAgentStatus.mutate({ room }).then((d) => d as ChatAgentStatus),
  agentDecision: (input: { room: string } & ChatDecisionInput): Promise<{ ok: boolean; detail: string }> =>
    trpc.chatAgentDecision.mutate(input).then((d) => d as { ok: boolean; detail: string }),
  frame: (raw: unknown): ChatFeedFrame => raw as ChatFeedFrame,
}

// ---------------------------------------------------------------------------------------------
// The rooms store: the sidebar cache. NOT registered on the changes bus (registerStoreReloads) -
// chat.db writes never emit table:* events; the feed below patches this store directly instead
// of refetching per message.
const roomsStore = createDataStore<ChatRoom[]>(() => wire.rooms())

/** Force a refetch (mirrors reloadCrm and friends). */
export const reloadChatRooms = (): Promise<ChatRoom[]> => roomsStore.reload()

/** Insert or replace a server-returned summary, keeping the server's ORDER BY slug. */
function adoptRoomSummary(room: ChatRoom): void {
  if (roomsStore.peek() === null) {
    // Sidebar never loaded: set() would no-op, so fetch the real list instead.
    void roomsStore.reload().catch(() => undefined)
    return
  }
  roomsStore.set((cur) => {
    const next = cur.filter((r) => r.id !== room.id)
    next.push(room)
    next.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    return next
  })
}

/** Drop a room from the sidebar. The only way a row leaves now is a DELETE: every user can read
 *  every channel, so nothing else can take a room away from them. */
function dropRoomSummary(roomId: string): void {
  if (roomsStore.peek() === null) return
  roomsStore.set((cur) => cur.filter((r) => r.id !== roomId))
}

/**
 * Adopt a server-issued read state into the sidebar cache: the pointer AND the count, as given.
 * `unread` is a count over rows this tab may never have fetched (replies in threads it never
 * opened, messages past the loaded page), so no local arithmetic reproduces it - and `headAt` is
 * not an upper bound to subtract from, it is the allocator's guard and points past every surviving
 * row once the newest message is deleted.
 *
 * Monotonic on the pointer, as the server is, with one asymmetry that matters. The same markRead
 * commit produces BOTH a `member.read` frame (fanned out to every tab of this user, this one
 * included) and the HTTP response, on two connections with no ordering between them. The frame
 * sits on the same stream as every later `message.created`, so once it has landed the increments
 * that follow it are correct on top of it; it may therefore be adopted at an EQUAL pointer too. The
 * response has no such guarantee: landing after the frame and after a message the frame path has
 * since counted, it would overwrite that count with one taken before the message existed. So a
 * response only applies when it brings a pointer the cache has not seen - the fallback for a frame
 * that never arrived, and nothing more.
 */
function adoptReadState(roomId: string, read: ChatReadState, source: 'frame' | 'response'): void {
  roomsStore.set((cur) =>
    cur.map((r) => {
      if (r.id !== roomId) return r
      // No pointer yet: this is the row's FIRST read state (markRead writes the member row lazily),
      // so there is nothing it could be stale against - adopt it.
      if (r.lastReadAt === null) return { ...r, lastReadAt: read.lastReadAt, unread: read.unread }
      const stale = source === 'frame' ? read.lastReadAt < r.lastReadAt : read.lastReadAt <= r.lastReadAt
      return stale ? r : { ...r, lastReadAt: read.lastReadAt, unread: read.unread }
    }),
  )
}

/**
 * Move a room's badge by ONE from a message frame, never recompute it. `unread` is the server's
 * count of surviving rows past the pointer, and the only local moves that stay honest are the
 * incremental ones: a created message above the pointer is one more, a deleted message above the
 * pointer is one less (`member.read` is the third mover, and adoptReadState handles it). Replies
 * count like roots - the server's COUNT has no parent filter. The pointer never moves backwards,
 * which is what makes the delete side sound: a row above it when it was counted is still above it
 * when it goes, and a row at or below it was never in the count.
 *
 * `headAt` is lifted so the cached row keeps mirroring the server's, and for no other reason:
 * nothing here derives from it (see ChatRoom.headAt for why it cannot).
 */
function applyFrameToRooms(frame: ChatFeedFrame): void {
  if (frame.roomId === null || frame.payload === null) return
  const delta = frame.type === 'message.created' ? 1 : frame.type === 'message.deleted' ? -1 : 0
  if (delta === 0) return
  const rooms = roomsStore.peek()
  if (rooms === null) return // sidebar never loaded: nothing to patch, its first load is fresh
  if (!rooms.some((r) => r.id === frame.roomId)) {
    // A frame for a room the cache lacks means the room was created mid-stream; refetch the
    // summary row rather than invent one. Bursts dedupe on the store's inflight fetch.
    void roomsStore.reload().catch(() => undefined)
    return
  }
  const key = frame.payload.createdAt
  roomsStore.set((cur) =>
    cur.map((r) => {
      if (r.id !== frame.roomId) return r
      const headAt = Math.max(r.headAt, key)
      // No pointer, so nothing is counted against it and there is no badge to move.
      if (r.lastReadAt === null || key <= r.lastReadAt) return headAt === r.headAt ? r : { ...r, headAt }
      return { ...r, headAt, unread: Math.max(0, r.unread + delta) }
    }),
  )
}

// ---------------------------------------------------------------------------------------------
// The feed. One subscription per tab at module scope; hooks register listeners for the frames
// they care about. `feedCursor` is the highest frame id seen and the resume cursor after a drop,
// so a reconnect REPLAYS what was missed instead of silently losing it. It is deliberately not
// persisted to localStorage: history is fetched fresh on room open, and a stale cursor from
// yesterday would replay a huge outbox window into a tab that does not need it. First connect has
// no cursor (start live from now) - hello tells us where that is.

type ChatFrameListener = (frame: ChatFeedFrame) => void
const frameListeners = new Set<ChatFrameListener>()

let feedStarted = false
let feedCursor: number | undefined
let activeSub: { unsubscribe(): void } | undefined
let retryTimer: number | undefined

function scheduleReconnect(): void {
  if (retryTimer !== undefined) return
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined
    connect()
  }, RETRY_MS)
}

function connect(): void {
  activeSub?.unsubscribe()
  const sub = trpc.chatFeed.subscribe(feedCursor === undefined ? {} : { cursor: feedCursor }, {
    onData: (raw) => {
      if (activeSub !== sub) return // a stale stream must not race the one that replaced it
      const frame = wire.frame(raw)
      if (frame.type === 'hello') {
        if (feedCursor !== undefined && frame.id > feedCursor) {
          // The SSE link reconnected internally, re-running the generator with the ORIGINAL
          // input, so this stream started live PAST frames we never received. Resubscribe with
          // our own cursor and let the server replay the gap.
          activeSub = undefined
          sub.unsubscribe()
          connect()
          return
        }
        if (feedCursor === undefined) {
          feedCursor = frame.id // first connect: learn our position
        } else {
          // A reconnect. The outbox replay covers missed MESSAGES, but the per-user ephemerals
          // (member.read, room.created) have no rows to replay - refetch the sidebar so read
          // pointers and the room list converge too.
          void roomsStore.reload().catch(() => undefined)
          // And tell the listeners, because `agent.activity` has no rows to replay EITHER: an open
          // room has to re-read the current turn state or it renders whatever was on screen when
          // the link dropped, forever. Only on a reconnect - a first connect is already covered by
          // the room-open read.
          for (const listener of frameListeners) listener(frame)
        }
        return
      }
      if (frame.type === 'member.read') {
        // A tab of THIS user acked (the server routes these per principal - this tab's own ack
        // arrives here too). The frame's id is a high-water mark, not an advance - do not touch
        // the cursor. It carries the server's stored pointer and recount; both are adopted, and
        // adoptReadState is monotonic, so an out-of-order arrival can never regress the pointer.
        if (frame.roomId !== null && frame.read !== undefined && frame.read !== null) {
          adoptReadState(frame.roomId, frame.read, 'frame')
        }
        return
      }
      if (frame.type === 'room.created') {
        // This user created a room in another tab (the creating tab adopts the summary itself,
        // and then skips this reload because the room is already in its cache).
        const rooms = roomsStore.peek()
        if (rooms !== null && !rooms.some((r) => r.id === frame.roomId)) {
          void roomsStore.reload().catch(() => undefined)
        }
        return
      }
      if (frame.type === 'room.updated') {
        // A room was renamed, re-topiced or re-iconed. The sidebar row changes in ways only the
        // server can compute, so the honest response is a refetch rather than a local guess.
        void roomsStore.reload().catch(() => undefined)
        return
      }
      if (frame.type === 'room.deleted') {
        // The room is GONE - purged, not archived, so there is nothing left to refetch it into.
        // Listeners first: an open room has to stop rendering and route away before the sidebar
        // drops the row out from under it.
        for (const listener of frameListeners) listener(frame)
        void roomsStore.reload().catch(() => undefined)
        return
      }
      if (frame.type === 'mention.created') {
        // Per-user ephemeral: the server routes it to the mentioned principal only. It is the live
        // NUDGE, not the record - the durable row is in chat.db's `mentions` table, which is what
        // the bell refetches. It carries the mentioning message as its payload, so it must not
        // touch the cursor and must not reach applyFrameToRooms: the room already counted that
        // message from its outbox frame, and counting it twice is exactly the phantom unread the
        // ephemeral channel exists to prevent.
        for (const listener of frameListeners) listener(frame)
        return
      }
      if (frame.type === 'agent.activity') {
        // Pure decoration, and the most frequent frame on the wire during a turn: what the agent
        // is doing right now. An ephemeral with no payload, so it must not touch the cursor and
        // must never reach applyFrameToRooms - nobody may be badged because nova read a file. Not
        // replayed either: a client joining mid-turn asks `chatAgentStatus` for the current state
        // instead.
        for (const listener of frameListeners) listener(frame)
        return
      }
      if (frame.type === 'message.edited') {
        // An ephemeral carrying the same row again: it must not touch the cursor and must not
        // reach applyFrameToRooms - an edit is not a new message and cannot make a room unread.
        // Hand it straight to the open room's listener to patch the row in place.
        for (const listener of frameListeners) listener(frame)
        return
      }
      if (frame.type === 'reaction.added' || frame.type === 'reaction.removed') {
        // The cheap ack (Track 10). An ephemeral with no payload and no order key: it must not
        // touch the cursor and must never reach applyFrameToRooms - a reaction that badged the
        // room would make the polite gesture the interrupting one, which is the entire point of
        // the feature. Straight to the open room's listener, which ADOPTS `reaction.reactions`
        // wholesale rather than incrementing anything.
        for (const listener of frameListeners) listener(frame)
        return
      }
      if (frame.type === 'message.deleted') {
        // An ephemeral too (its id is a high-water mark, not an advance), but unlike an edit it
        // DOES move a badge: a surviving-row count shrinks when a row above the pointer stops
        // surviving, and no later refetch is coming to say so. Delivered once per subscription
        // (never replayed - the outbox row went with the message), so the decrement cannot double.
        // The listener removes the row from the open room.
        applyFrameToRooms(frame)
        for (const listener of frameListeners) listener(frame)
        return
      }
      if (frame.type === 'ping') {
        // Not a message - but its id is the stream's high-water mark, and adopting it keeps the
        // replay window tight on the next reconnect.
        if (feedCursor === undefined || frame.id > feedCursor) feedCursor = frame.id
        return
      }
      // Anything left that is not a created message is a type this build does not know - a newer
      // server's ephemeral, most likely. Ignore it EXPLICITLY. It used to fall through to the
      // cursor dedupe below and be dropped there, which happened to work only because an
      // ephemeral's id is a high-water mark we had usually already seen; one that arrived with a
      // fresh id would have advanced the cursor and inflated a room's unread count.
      if (frame.type !== 'message.created') return
      // Replay and live can overlap (and so can our own resubscribes); frame ids are globally
      // ordered, so anything at or below the cursor was already delivered.
      if (feedCursor !== undefined && frame.id <= feedCursor) return
      feedCursor = frame.id
      applyFrameToRooms(frame)
      // Direct Set iteration is safe here: a listener that unsubscribes mid-dispatch is skipped,
      // not crashed on.
      for (const listener of frameListeners) listener(frame)
    },
    // The SSE link retries transient drops itself; these fire on fatal errors (auth expiry,
    // server gone during a deploy) - back off and resubscribe with the cursor kept above.
    onError: () => {
      if (activeSub !== sub) return
      activeSub = undefined
      sub.unsubscribe()
      scheduleReconnect()
    },
    onComplete: () => {
      if (activeSub !== sub) return
      activeSub = undefined
      scheduleReconnect()
    },
  })
  activeSub = sub
}

/**
 * Subscribe to raw feed frames from outside the chat views.
 *
 * The notification bell is app-wide chrome, so it needs the frames on every route, not just under
 * /chat - and it must not open a SECOND chatFeed subscription to get them (two streams per tab
 * would double every replay window and let the two cursors disagree). One feed, many listeners.
 * Returns the unsubscribe function.
 */
export function subscribeChatFrames(listener: (frame: ChatFeedFrame) => void): () => void {
  frameListeners.add(listener)
  return () => {
    frameListeners.delete(listener)
  }
}

/** Start the feed (idempotent). Armed app-wide from the auth gate since the bell landed: chat is
 *  internal-only and needs a principal, but so is every other authenticated surface, and a bell
 *  that only goes live once you visit /chat is not a notification. */
export function startChatFeed(): void {
  if (feedStarted) return
  feedStarted = true
  connect()
}

// ---------------------------------------------------------------------------------------------
// The hooks.

/** Create a room and adopt it into the sidebar immediately - the room.created ephemeral is aimed
 *  at this user's OTHER tabs (and they refetch on it; this tab already has the row, so it skips
 *  the reload). Errors propagate untouched: a duplicate slug is a 409 the dialog renders. */
async function createChatRoom(input: ChatRoomCreateInput): Promise<ChatRoom> {
  const room = await wire.roomCreate(input)
  adoptRoomSummary(room)
  return room
}

/** Open (or re-open) the DM with `user`, and adopt it into the sidebar the same way a create does.
 *  Idempotent - see `wire.directOpen`. */
async function openChatDirect(user: string): Promise<ChatRoom> {
  const room = await wire.directOpen(user)
  adoptRoomSummary(room)
  return room
}

export interface ChatRoomsHandle {
  /** null before the first load; slug-ordered, live-updating (badges bump from feed frames). */
  rooms: ChatRoom[] | null
  error: string | null
  createRoom: (input: ChatRoomCreateInput) => Promise<ChatRoom>
  openDirect: (user: string) => Promise<ChatRoom>
}

export function useChatRooms(): ChatRoomsHandle {
  useEffect(() => {
    startChatFeed()
  }, [])
  const { data, error } = roomsStore.useData()
  return { rooms: data, error, createRoom: createChatRoom, openDirect: openChatDirect }
}

interface RoomViewState {
  /** Which room this state belongs to - the guard that keeps a stale async response or a
   *  mid-switch render from ever showing under the wrong slug. */
  slug: string | null
  room: ChatRoom | null
  messages: ChatMessage[]
  /** What the agent turn in this room is doing, or null when no turn is in flight. */
  activity: AgentActivityFrame | null
  /** LOCAL receipt time of that activity (not the server's `at`), so the staleness age-out is
   *  measured on the same clock it is compared against. 0 when there is no activity. */
  activityAt: number
  unreadAfter: number | null
  nextCursor: number | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  /**
   * Ids deleted during THIS room-open - by a `message.deleted` frame, or by this tab's own delete
   * response. The ledger exists for one race: a page the server read BEFORE a delete can land here
   * AFTER the delete's frame did, and the frame found nothing to remove, so the page would put the
   * row back. Every server page (the open read, older pages, thread expands) is filtered against
   * it before merging. With tombstones that race took care of itself ("live entries win" kept the
   * tombstone); with hard deletion it needs this. Reset with the rest of the view on a slug switch,
   * and never large - it holds only deletes witnessed while this room was open.
   */
  removed: string[]
  /**
   * Replies, by thread root id. A root with no entry has simply never been expanded - which is
   * NOT the same as having no replies (that is `message.thread` being absent on the root), and
   * keeping the two apart is what lets a collapsed thread show a count without fetching anything.
   */
  threads: Record<string, ChatMessage[]>
  /**
   * Which threads are open right now. Deliberately per-ROOM-OPEN state and nothing more: it is
   * reset by the slug switch, so every room opens with every thread collapsed, and a thread that
   * receives a message while you are looking at the room opens itself (see the frame handler).
   */
  expanded: string[]
  /** Roots whose reply list is in flight - the toggle shows it rather than looking inert. */
  loadingThreads: string[]
}

const emptyView = (slug: string | null): RoomViewState => ({
  slug,
  room: null,
  messages: [],
  activity: null,
  activityAt: 0,
  unreadAfter: null,
  nextCursor: null,
  loading: slug !== null,
  loadingMore: false,
  error: null,
  removed: [],
  threads: {},
  expanded: [],
  loadingThreads: [],
})

/** Apply one message to the thread map: replies land under their root, roots are ignored. */
function upsertReply(threads: Record<string, ChatMessage[]>, msg: ChatMessage): Record<string, ChatMessage[]> {
  const root = msg.parentId
  if (root === undefined) return threads
  // An unloaded thread is left unloaded: writing a lone reply into it would render a thread
  // claiming to hold one message when the server has twenty, and the expand fetch replaces the
  // list wholesale anyway.
  const current = threads[root]
  if (current === undefined) return threads
  return { ...threads, [root]: upsertMessage(current, msg) }
}

/**
 * Fold a new reply into its root's summary, so a collapsed thread's count and "last reply" move
 * live rather than at the next history fetch.
 *
 * Reconstructed locally instead of refetching the page: the server computes the same three
 * numbers from the same rows, and a refetch per reply would be one request per keystroke-sized
 * event on a busy thread. An id already in the thread (a re-delivered frame, our own echo) is not
 * counted twice.
 */
function foldReplyIntoSummary(messages: ChatMessage[], reply: ChatMessage, known: boolean): ChatMessage[] {
  const root = reply.parentId
  if (root === undefined) return messages
  const index = messages.findIndex((m) => m.id === root)
  if (index < 0) return messages
  const target = messages[index]
  const previous = target.thread
  const participants =
    previous !== undefined && previous.participants.includes(reply.senderId)
      ? previous.participants
      : [...(previous?.participants ?? []), reply.senderId]
  const next = [...messages]
  next[index] = {
    ...target,
    thread: {
      replyCount: (previous?.replyCount ?? 0) + (known ? 0 : 1),
      lastReplyAt: Math.max(previous?.lastReplyAt ?? 0, reply.createdAt),
      participants,
    },
  }
  return next
}

/** Insert one live/echoed message, id-deduped (the post response and its feed frame are the same
 *  row) and createdAt-ordered. Replace-by-id keeps this correct for message.edited later. */
function upsertMessage(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  const i = list.findIndex((m) => m.id === msg.id)
  if (i >= 0) {
    const next = [...list]
    next[i] = msg
    return next
  }
  if (list.length === 0 || msg.createdAt > list[list.length - 1].createdAt) return [...list, msg] // in-order fast path
  const next = [...list, msg]
  next.sort((a, b) => a.createdAt - b.createdAt)
  return next
}

/**
 * Put a reaction frame's grouped list onto the message it names, wherever that message is held.
 *
 * Both places have to be tried, and neither can be skipped on the strength of `parentId`: the
 * timeline holds roots, `threads[root]` holds an expanded thread's replies, and a ROOT that is
 * open in a thread view is in both at once - patching only one leaves the other showing yesterday's
 * count for as long as the room stays open. Everything else is left alone, so a frame for a message
 * this client has never fetched is a no-op rather than a phantom row.
 */
function applyReactions(state: RoomViewState, hit: ChatReactionEvent): RoomViewState {
  const patch = (m: ChatMessage): ChatMessage =>
    m.id === hit.messageId
      ? // Absent rather than an empty array when the last one is taken back, matching what the
        // server sends and what every other optional field on a message does.
        hit.reactions.length > 0
        ? { ...m, reactions: hit.reactions }
        : (({ reactions: _dropped, ...rest }) => rest)(m)
      : m
  const root = hit.parentId
  const replies = root === undefined ? undefined : state.threads[root]
  return {
    ...state,
    messages: state.messages.map(patch),
    ...(replies === undefined ? {} : { threads: { ...state.threads, [root!]: replies.map(patch) } }),
  }
}

/** A server page minus what this room-open has already seen deleted - see RoomViewState.removed. */
function survivors(page: ChatMessage[], removed: string[]): ChatMessage[] {
  return removed.length === 0 ? page : page.filter((m) => !removed.includes(m.id))
}

/** The collapsed row's numbers, rebuilt from a COMPLETE reply list. Undefined for an empty one:
 *  zero never travels on the wire either, the summary is absent instead. */
function summarize(replies: ChatMessage[]): ChatThreadSummary | undefined {
  if (replies.length === 0) return undefined
  const participants: string[] = []
  let lastReplyAt = 0
  for (const reply of replies) {
    if (!participants.includes(reply.senderId)) participants.push(reply.senderId)
    if (reply.createdAt > lastReplyAt) lastReplyAt = reply.createdAt
  }
  return { replyCount: replies.length, lastReplyAt, participants }
}

/** A root with its summary replaced - or REMOVED, when there is none: the field is absent rather
 *  than undefined on the wire, and the renderer keys on presence. */
function withThread(root: ChatMessage, thread: ChatThreadSummary | undefined): ChatMessage {
  if (thread !== undefined) return { ...root, thread }
  if (root.thread === undefined) return root
  const bare = { ...root }
  delete bare.thread
  return bare
}

function setThreadSummary(messages: ChatMessage[], rootId: string, thread: ChatThreadSummary | undefined): ChatMessage[] {
  const index = messages.findIndex((m) => m.id === rootId)
  if (index < 0) return messages
  const next = [...messages]
  next[index] = withThread(messages[index], thread)
  return next
}

/**
 * Drop one deleted message from whichever list holds it, and keep the thread bookkeeping honest.
 *
 * IDEMPOTENT, and it has to be: the deleting tab applies this from the `chatDelete` response AND
 * again from the `message.deleted` frame the server fans out to every reader (itself included),
 * and a cascade sends one frame per reply after the root's. Every second pass must find nothing to
 * do rather than count a removal twice.
 *
 * A ROOT takes its thread with it - the reply list, the expanded flag, the in-flight fetch (whose
 * answer fetchThread then discards). The reply frames that follow name a root that is no longer
 * here and fall through every branch below.
 *
 * A REPLY moves its root's summary. When the thread is loaded the list is complete (the expand
 * fetch returns every surviving reply), so the summary is rebuilt from what is left - which is
 * exactly what makes a repeat a no-op. When it is not loaded there is nothing to rebuild from, so
 * the count is decremented blindly; only the frame path reaches this branch (the response path
 * cannot name a reply this tab has never rendered), so it runs once, and the next expand replaces
 * the summary from the server anyway.
 */
function removeMessage(state: RoomViewState, id: string, parentId: string | undefined): RoomViewState {
  const removed = state.removed.includes(id) ? state.removed : [...state.removed, id]
  if (parentId === undefined) {
    return {
      ...state,
      removed,
      messages: state.messages.filter((m) => m.id !== id),
      threads: Object.fromEntries(Object.entries(state.threads).filter(([root]) => root !== id)),
      expanded: state.expanded.filter((root) => root !== id),
      loadingThreads: state.loadingThreads.filter((root) => root !== id),
    }
  }
  const loaded = state.threads[parentId]
  if (loaded !== undefined) {
    const replies = loaded.filter((m) => m.id !== id)
    return {
      ...state,
      removed,
      threads: { ...state.threads, [parentId]: replies },
      messages: setThreadSummary(state.messages, parentId, summarize(replies)),
    }
  }
  const previous = state.messages.find((m) => m.id === parentId)?.thread
  if (previous === undefined) return { ...state, removed }
  const replyCount = previous.replyCount - 1
  return {
    ...state,
    removed,
    messages: setThreadSummary(state.messages, parentId, replyCount > 0 ? { ...previous, replyCount } : undefined),
  }
}

/** Where a message lives in this view: the timeline (no parent), a loaded thread (its root), or
 *  nowhere this tab can see. What the delete response needs to route each id it names. */
function locate(state: RoomViewState, id: string): { parentId: string | undefined } | null {
  if (state.messages.some((m) => m.id === id)) return { parentId: undefined }
  for (const [root, replies] of Object.entries(state.threads)) {
    if (replies.some((m) => m.id === id)) return { parentId: root }
  }
  return null
}

/**
 * Adopt one committed row into whichever list owns it - the timeline for a root, the thread map
 * for a reply. The edit round-trip lands here (the delete one has no row to adopt - see
 * removeMessage), and routing by `parentId` is what stops an edited reply from being duplicated
 * into the timeline as a second copy of itself.
 */
function adoptRow(state: RoomViewState, message: ChatMessage): RoomViewState {
  return message.parentId === undefined
    ? { ...state, messages: upsertMessage(state.messages, message) }
    : { ...state, threads: upsertReply(state.threads, message) }
}

/** Merge a history page under whatever already arrived live (the open race, the paging race).
 *  Identity is `id` and order is `createdAt` - two columns, so it dedupes on one and sorts on the
 *  other. Live entries win, which is what keeps an edit that landed during the fetch from being
 *  undone by the page's older copy of the row. */
function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (existing.length === 0) return incoming
  const seen = new Set(existing.map((m) => m.id))
  const merged = [...existing]
  for (const m of incoming) {
    if (!seen.has(m.id)) merged.push(m)
  }
  merged.sort((a, b) => a.createdAt - b.createdAt)
  return merged
}

export interface ChatRoomHandle {
  /** The room summary as the sidebar has it (topic, read state AT open). It comes from the rooms
   *  cache: opening a room is just reading it. */
  room: ChatRoom | null
  /** Convenience alias of room.topic for the header - null until the summary resolves. */
  topic: string | null
  /**
   * Patch the room: name, topic, icon. Resolves to the new summary, whose `slug` is what the
   * caller must navigate to - a rename moves the room's address, and this hook does not own the
   * router.
   */
  updateRoom: (patch: ChatRoomUpdateInput) => Promise<ChatRoom>
  /**
   * DESTROY the room. Irreversible, and the server demands `confirm` repeat the slug - so the
   * caller passes what the human typed, not a copy of the slug it already holds. The row is
   * dropped from the sidebar on success and the caller navigates away; every other client hears
   * `room.deleted` on the feed.
   */
  deleteRoom: (confirm: string) => Promise<ChatRoomDeleteResult>
  /** Oldest-first, createdAt-ordered, deduped by id. */
  messages: ChatMessage[]
  /** FROZEN at open: the read pointer as it stood then, or null if nothing was unread. Render the
   *  divider above the first message with createdAt STRICTLY greater than it - the pointer names
   *  the last message read, not the first unread. It never moves while the room is open - not for
   *  arriving messages, not when mark-read fires. */
  unreadAfter: number | null
  /**
   * What the agent turn in this room is doing right now, or null when nothing is in flight.
   *
   * Render it against the message whose id is `activity.messageId` - the placeholder the turn is
   * filling in. It is live-only decoration: never persisted, never replayed, and it must never
   * influence unread state.
   */
  activity: AgentActivityFrame | null
  /** null once the oldest page has been reached. */
  nextCursor: number | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  loadOlder: () => void
  /** `attachmentIds` claims already-uploaded orphans for this post. Declared here because the
   *  Composer passes it - a one-arg declaration still typechecks (fewer params are assignable) and
   *  would let an adapter like `onSend={(body) => send(body)}` silently drop every id. */
  send: (body: string, attachmentIds?: string[]) => Promise<void>
  /** Replace your own message's body. Server-enforced: only the sender may. */
  editMessage: (messageId: string, body: string) => Promise<void>
  /** HARD-delete your own message: the row vanishes here, it does not render as deleted. A thread
   *  root takes every reply under it, whoever wrote them - the server cascades. */
  deleteMessage: (messageId: string) => Promise<void>
  /**
   * Put a reaction on any message in this room, or take yours back (Track 10).
   *
   * Anyone's message, not just your own: the server gates on room READABILITY, the same gate
   * posting uses. Resolves once the server's grouped list has been adopted.
   */
  react: (messageId: string, emoji: string, on: boolean) => Promise<void>
  /**
   * Answer an agent approval card (Track 19). Any member of the room may - the server decides.
   *
   * REJECTS on a refusal rather than resolving with `{ ok: false }`, because every caller's honest
   * reaction to "that card belongs to an earlier session" is the same one it has to the request
   * failing outright: show the line, leave the card alone. Nothing is applied locally either way -
   * the server rewrites the card and the `message.edited` frame repaints it.
   */
  decideApproval: (input: ChatDecisionInput) => Promise<void>
  /** Replies by thread root id. A missing entry means "never opened", NOT "no replies" - the
   *  count lives on the root's `thread` summary and needs no fetch. */
  threads: Record<string, ChatMessage[]>
  /** Roots whose thread is open. Empty on every room open (collapsed by default); a thread that
   *  receives a message while the room is open adds itself. */
  expandedThreads: string[]
  /** Roots whose reply list is being fetched right now. */
  loadingThreads: string[]
  /** Open or close a thread, fetching its replies the first time. */
  toggleThread: (rootId: string) => void
  /** Post a reply into a thread. Naming a reply as the root is safe - the server re-parents. */
  replyInThread: (rootId: string, body: string, attachmentIds?: string[]) => Promise<void>
}

export function useChatRoom(slug: string | null): ChatRoomHandle {
  const [state, setState] = useState<RoomViewState>(() => emptyView(slug))
  // On a slug switch the reset effect has not run yet - never render the previous room's state
  // under the new slug for even one frame.
  const view = state.slug === slug ? state : emptyView(slug)
  const stateRef = useRef(view)
  stateRef.current = view
  /** Highest createdAt acked (or accepted as already-read) this open - the debounce floor. */
  const readSentRef = useRef(0)
  /**
   * Bumped by every applied `agent.activity` frame. The `chatAgentStatus` answer is an HTTP
   * response and the frames are SSE, so the two are UNORDERED: a status computed while a turn was
   * running can land after the `done` frame that ended it and resurrect a spinner nothing will
   * ever clear again (and the mirror case, a pre-turn status landing after the turn's first frames
   * and blanking them). Comparing the counter across the round-trip discards exactly the answers
   * that were overtaken.
   */
  const activityEpochRef = useRef(0)
  /** The room-open effect's status reader, so the staleness timer below can reach it. */
  const refreshStatusRef = useRef<() => void>(() => undefined)
  /** Issue number of the newest `chatAgentStatus` read. Two can be in flight (room open racing a
   *  reconnect hello, a hello racing the staleness timer) and HTTP does not promise to return them
   *  in order, so only the newest one's answer may be applied. */
  const statusReqRef = useRef(0)
  const readTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    readSentRef.current = 0
    setState(emptyView(slug))
    if (slug === null) return
    startChatFeed()
    const roomSlug: string = slug
    let cancelled = false
    let roomId: string | null = null

    // Registered BEFORE the history fetch so no message can fall between them: anything that
    // lands while history is in flight merges with the page by id (and a delete that lands then
    // is remembered in `removed`, so the page cannot undo it). Until the summary resolves roomId
    // is unknown and frames are dropped - those messages are in the history read, which happens
    // after.
    /** Adopt the server's view of the turn. Room-scoped and slug-guarded like every other write
     *  here, and it CLEARS as readily as it sets: an idle answer is what ends a spinner left over
     *  from a turn whose terminal frame we missed. */
    const refreshStatus = (): void => {
      const epoch = activityEpochRef.current
      const request = ++statusReqRef.current
      wire
        .agentStatus(roomSlug)
        .then((status) => {
          if (cancelled) return
          // A newer read was issued after this one; its answer is the current one by definition,
          // even if it arrives first.
          if (statusReqRef.current !== request) return
          // A live frame landed while this was in flight: it is strictly newer than the snapshot
          // the server took, so the snapshot is a lie now. Drop it.
          if (activityEpochRef.current !== epoch) return
          // The same terminal rule the frame path applies - the two adoption paths must not
          // disagree about what `done` means.
          const reported = status.active ? status.activity : null
          const next = reported !== null && reported.state !== 'done' && reported.state !== 'error' ? reported : null
          setState((s) =>
            s.slug !== roomSlug
              ? s
              : next === null
                ? s.activity === null
                  ? s
                  : { ...s, activity: null, activityAt: 0 }
                : { ...s, activity: next, activityAt: Date.now() },
          )
        })
        .catch(() => {
          // A failed read must RE-ARM rather than give up. This is the only remaining path on
          // which a spinner could stick forever: the terminal frame was dropped, and the 90s
          // re-check that exists to notice then failed too - a correlated pair, since a server
          // blip causes both. Touching `activityAt` re-runs the staleness effect and schedules
          // another attempt; nothing else about the line changes.
          if (cancelled) return
          setState((s) => (s.slug === roomSlug && s.activity !== null ? { ...s, activityAt: Date.now() } : s))
        })
    }
    refreshStatusRef.current = refreshStatus

    const onFrame = (frame: ChatFeedFrame): void => {
      // A reconnect hello, forwarded by the dispatcher precisely so this can happen: ephemerals
      // are not replayed, so the activity we are rendering may be minutes stale. It carries no
      // roomId, so it has to be handled above the room guard.
      if (frame.type === 'hello') {
        refreshStatus()
        return
      }
      if (roomId === null || frame.roomId !== roomId) return
      if (frame.type === 'room.deleted') {
        // The room this view is rendering has been purged. There is nothing to refetch and nothing
        // to page - reported as an error state rather than by silently freezing, because a
        // transcript that keeps accepting scroll and a composer that keeps accepting text are both
        // lying about a room that no longer exists.
        setState((s) =>
          s.slug === roomSlug
            ? { ...s, loading: false, loadingMore: false, activity: null, activityAt: 0, error: 'This channel was deleted' }
            : s,
        )
        return
      }
      if (frame.type === 'agent.activity') {
        const activity = frame.activity ?? null
        if (activity === null) return
        // `done` and `error` are the ONLY things that clear the line - see ACTIVITY_STALE_MS for
        // why the finalize edit cannot be used as a terminal signal any more.
        const terminal = activity.state === 'done' || activity.state === 'error'
        activityEpochRef.current += 1
        setState((s) =>
          s.slug !== roomSlug
            ? s
            : terminal
              ? s.activity === null
                ? s
                : { ...s, activity: null, activityAt: 0 }
              : { ...s, activity, activityAt: Date.now() },
        )
        return
      }
      if (frame.type === 'reaction.added' || frame.type === 'reaction.removed') {
        // ADOPT, never increment. The frame carries the message's complete grouped list after the
        // change, so a dropped frame, a double-tap and two people racing the same emoji all
        // converge on the server's answer instead of drifting a local counter nothing corrects.
        const hit = frame.reaction
        if (!hit) return
        setState((s) => (s.slug === roomSlug ? applyReactions(s, hit) : s))
        return
      }
      if (frame.type === 'message.deleted') {
        // Identity only - id, createdAt, parentId - and it means the row is GONE, not that it
        // should render as gone. One frame per deleted message, root first: dropping the root
        // takes its thread, so the reply frames that follow find nothing (see removeMessage).
        const gone = frame.payload
        if (gone === null) return
        setState((s) => (s.slug === roomSlug ? removeMessage(s, gone.id, gone.parentId) : s))
        return
      }
      // message.created appends; message.edited replaces by id (upsertMessage is replace-by-id,
      // so both are the same call). Any other type is ignored here - never crash, never render a
      // blank row.
      const known = frame.type === 'message.created' || frame.type === 'message.edited'
      if (!known || frame.payload === null) return
      const msg = frame.payload
      setState((s) => {
        if (s.slug !== roomSlug) return s
        // A ROOT (or any message from a client that does not thread) goes in the timeline, exactly
        // as before.
        if (msg.parentId === undefined) return { ...s, messages: upsertMessage(s.messages, msg) }
        const root = msg.parentId
        const alreadyHere = (s.threads[root] ?? []).some((m) => m.id === msg.id)
        return {
          ...s,
          threads: upsertReply(s.threads, msg),
          // Only a NEW reply moves the count; an edit frame carries the same row again and must
          // not inflate it.
          messages:
            frame.type === 'message.created'
              ? foldReplyIntoSummary(s.messages, msg, alreadyHere)
              : s.messages,
          // The rule asked for: threads open COLLAPSED when you arrive, and anything that
          // happens while you are here opens itself. Watching a thread you have open stay silent
          // because it collapsed on you is the one behaviour that would make this feature feel
          // broken. Only for a new message - an edit to an old reply is not new activity.
          expanded:
            frame.type === 'message.created' && !s.expanded.includes(root)
              ? [...s.expanded, root]
              : s.expanded,
        }
      })
    }
    frameListeners.add(onFrame)

    void (async () => {
      try {
        // The summary comes from the sidebar, which lists every room this user can read - so
        // there is nothing to fetch and nothing to create. `chatRooms` is loaded by the layout
        // above us; reload only if this tab somehow has no cache yet.
        const room =
          (roomsStore.peek() ?? (await roomsStore.reload())).find((r) => r.slug === roomSlug) ?? null
        if (cancelled) return
        if (room === null) throw new Error(`no room "${roomSlug}"`)
        roomId = room.id
        // Mid-turn join: ask what the room's agent is doing right now, since nothing replays it.
        refreshStatus()
        // Null until this user first marks the room read - start the debounce from the bottom.
        readSentRef.current = room.lastReadAt ?? 0
        setState((s) =>
          s.slug === roomSlug
            ? {
                ...s,
                room,
                // The divider sits above the first message PAST the pointer, so the frozen value
                // is the pointer itself and the renderer compares with `>`. Gated on the server's
                // count: a pointer with nothing surviving past it draws no line.
                unreadAfter: room.unread > 0 && room.lastReadAt !== null ? room.lastReadAt : null,
              }
            : s,
        )
        const page = await wire.history(roomSlug)
        if (cancelled) return
        setState((s) =>
          s.slug === roomSlug
            ? {
                ...s,
                loading: false,
                nextCursor: page.nextCursor,
                messages: mergeMessages(s.messages, survivors(page.messages, s.removed)),
              }
            : s,
        )
      } catch (error) {
        if (!cancelled) setState((s) => (s.slug === roomSlug ? { ...s, loading: false, error: String(error) } : s))
      }
    })()

    return () => {
      cancelled = true
      refreshStatusRef.current = () => undefined
      frameListeners.delete(onFrame)
    }
  }, [slug])

  // The newest message this tab holds, timeline or loaded thread - what markRead sends as `at`.
  // Threads have to count: the server's unread is over every surviving row, replies included, and
  // a reply that just landed in an open thread is usually newer than every root on screen. Acking
  // the timeline's tail alone would leave it unread until something newer reached the timeline.
  let tailAt = view.messages.length > 0 ? view.messages[view.messages.length - 1].createdAt : 0
  for (const replies of Object.values(view.threads)) {
    const tail = replies[replies.length - 1]
    if (tail !== undefined && tail.createdAt > tailAt) tailAt = tail.createdAt
  }
  const room = view.room

  // The staleness re-check. A turn that has gone quiet gets settled by the SERVER rather than by a
  // guess here - see ACTIVITY_STALE_MS. Re-armed on every activity update, so a turn that keeps
  // reporting never reaches it, and a turn that stays silent is re-asked about once every window
  // until the answer is "idle" (which clears the line and disarms this, since `activity` is then
  // null).
  const activity = view.activity
  const activityAt = view.activityAt
  useEffect(() => {
    if (activity === null || slug === null) return
    const timer = window.setTimeout(
      () => refreshStatusRef.current(),
      Math.max(0, activityAt + ACTIVITY_STALE_MS - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [slug, activity, activityAt])

  // Mark-read: debounced behind the rendered tail (one call per burst, not per message), gated on
  // tab visibility (hidden = not looking), and re-armed when the tab becomes visible again.
  useEffect(() => {
    if (slug === null || room === null || view.loading || tailAt === 0) return
    if (tailAt <= readSentRef.current) return
    const roomSlug: string = slug
    const roomId = room.id
    const flush = (): void => {
      readTimerRef.current = undefined
      if (document.visibilityState !== 'visible') return // onVisibility below re-arms
      if (tailAt <= readSentRef.current) return
      readSentRef.current = tailAt
      // No optimistic patch: the number that replaces the badge is the server's recount, which
      // this tab cannot guess (it may hold replies it never fetched), and the badge of the room
      // being read is hidden by the layout anyway. The answer lands twice - as the `member.read`
      // frame and as this response - and adoptReadState says which one wins.
      wire
        .markRead(roomSlug, tailAt)
        .then((read) => adoptReadState(roomId, read, 'response'))
        .catch(() => void roomsStore.reload().catch(() => undefined)) // un-lie the badge
    }
    const arm = (): void => {
      if (readTimerRef.current === undefined) readTimerRef.current = window.setTimeout(flush, MARK_READ_DEBOUNCE_MS)
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible' && tailAt > readSentRef.current) arm()
    }
    arm()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      if (readTimerRef.current !== undefined) {
        clearTimeout(readTimerRef.current)
        readTimerRef.current = undefined
      }
    }
  }, [slug, room, view.loading, tailAt])

  const send = useCallback(
    async (body: string, attachmentIds: string[] = []): Promise<void> => {
      if (slug === null) throw new Error('no room open')
      const roomSlug: string = slug
      const message = await wire.post(roomSlug, body, attachmentIds)
      // Local echo from the COMMITTED row - no temp ids, so the feed's copy of the same message
      // dedupes by id. The post result's outbox cursor is deliberately not adopted as the
      // feed cursor: it can be ahead of frames still in flight from other rooms, and adopting it
      // would make the overlap dedupe silently drop them.
      setState((s) => (s.slug === roomSlug ? { ...s, messages: upsertMessage(s.messages, message) } : s))
    },
    [slug],
  )

  // Adopts the COMMITTED row the server returns, exactly like send: the matching ephemeral
  // arriving a beat later carries the same row and dedupes by id in upsertMessage. Errors
  // propagate to the caller (the row is left untouched, so a refused edit simply stays as it was).
  const editMessage = useCallback(
    async (messageId: string, body: string): Promise<void> => {
      if (slug === null) throw new Error('no room open')
      const roomSlug: string = slug
      const message = await wire.edit(roomSlug, messageId, body)
      setState((s) => (s.slug === roomSlug ? adoptRow(s, message) : s))
    },
    [slug],
  )

  // Applies the deletion the server REPORTS - every id in `deleted`, root first for a cascade -
  // rather than waiting for the frames, which arrive on the other connection and may not arrive at
  // all if the feed is mid-reconnect. The frames then repeat the work and find nothing (see
  // removeMessage). A 404 propagates like any other refusal: the message was already gone, and
  // the frame that says so removes the row.
  const deleteMessage = useCallback(
    async (messageId: string): Promise<void> => {
      if (slug === null) throw new Error('no room open')
      const roomSlug: string = slug
      const deletion = await wire.remove(roomSlug, messageId)
      setState((s) => {
        if (s.slug !== roomSlug) return s
        let next = s
        for (const id of deletion.deleted) {
          const where = locate(next, id)
          if (where !== null) next = removeMessage(next, id, where.parentId)
        }
        return next
      })
    },
    [slug],
  )

  /**
   * React to any message in the room, or take yours back.
   *
   * Deliberately NOT optimistic, which is a departure from the reflex for a one-click gesture. The
   * server is on the tailnet and answers this in single-digit milliseconds, so the felt gain is
   * nil - and the cost would be real: an optimistic pill has to invent the post-click group list,
   * which is exactly the local-arithmetic-over-server-state that `adopt, never increment` exists
   * to keep out of this feature. One rule everywhere is worth more than one frame of latency.
   *
   * The matching ephemeral arrives a beat later carrying the same list and is idempotent, so the
   * two cannot disagree. A refusal (an emoji this build offers and the server does not) propagates
   * with the row untouched.
   */
  const react = useCallback(
    async (messageId: string, emoji: string, on: boolean): Promise<void> => {
      if (slug === null) throw new Error('no room open')
      const roomSlug: string = slug
      const reactions = await wire.react(roomSlug, messageId, emoji, on)
      setState((s) => {
        if (s.slug !== roomSlug) return s
        const where = locate(s, messageId)
        return applyReactions(s, {
          messageId,
          ...(where?.parentId === undefined ? {} : { parentId: where.parentId }),
          userId: '',
          emoji,
          reactions,
        })
      })
    },
    [slug],
  )

  const loadOlder = useCallback((): void => {
    const s = stateRef.current
    if (slug === null || s.slug !== slug || s.loading || s.loadingMore || s.nextCursor === null) return
    const roomSlug: string = slug
    const before = s.nextCursor
    setState((cur) => (cur.slug === roomSlug ? { ...cur, loadingMore: true } : cur))
    wire
      .history(roomSlug, before)
      .then((page) => {
        setState((cur) =>
          cur.slug === roomSlug
            ? {
                ...cur,
                loadingMore: false,
                nextCursor: page.nextCursor,
                messages: mergeMessages(cur.messages, survivors(page.messages, cur.removed)),
              }
            : cur,
        )
      })
      .catch((error) => {
        // nextCursor stays where it was, so scrolling up again simply retries the page.
        setState((cur) => (cur.slug === roomSlug ? { ...cur, loadingMore: false, error: String(error) } : cur))
      })
  }, [slug])

  /** Rename / re-topic / re-scope / re-icon the room. The sidebar row is adopted from the response
   *  and the open view follows it, so a rename is visible here before the `room.updated` frame
   *  arrives; the frame's refetch is what carries it to everyone else. */
  const updateRoom = useCallback(
    async (patch: ChatRoomUpdateInput): Promise<ChatRoom> => {
      if (slug === null) throw new Error('no room open')
      const updated = await wire.roomUpdate(slug, patch)
      adoptRoomSummary(updated)
      // Keyed on the ROOM ID, not the slug: a rename means the state's slug is the OLD one, and
      // comparing slugs here would silently skip the update that renamed it.
      setState((s) => (s.room !== null && s.room.id === updated.id ? { ...s, room: updated } : s))
      return updated
    },
    [slug],
  )

  /** Purge the room. Only the local cache is patched here - the server's `room.deleted` reaches
   *  every other client, including this user's other tabs. */
  const deleteRoom = useCallback(
    async (confirm: string): Promise<ChatRoomDeleteResult> => {
      if (slug === null) throw new Error('no room open')
      const result = await wire.roomDelete(slug, confirm)
      // Only on a real delete: `pending` means an approval card was posted and the room still
      // exists, so dropping the row would hide a room that is still there.
      if (result.status === 'deleted') dropRoomSummary(result.roomId)
      return result
    },
    [slug],
  )

  /**
   * Open or close one thread. Purely the expanded FLAG - fetching is the effect below, because a
   * thread also opens without anybody clicking (a reply arriving while the room is open), and two
   * separate paths into "load the replies" is how one of them ends up never loading them.
   */
  const toggleThread = useCallback(
    (rootId: string): void => {
      if (slug === null) return
      const roomSlug: string = slug
      setState((s) =>
        s.slug !== roomSlug
          ? s
          : {
              ...s,
              expanded: s.expanded.includes(rootId)
                ? s.expanded.filter((id) => id !== rootId)
                : [...s.expanded, rootId],
            },
      )
    },
    [slug],
  )

  /**
   * Load the replies of any thread that is open and has none loaded.
   *
   * Declarative on purpose: "an open thread shows its replies" is one rule with one implementation,
   * whether the thread was opened by a click, by a reply landing in it, or by this tab reconnecting
   * with it already open. `loadingThreads` is the in-flight guard, so a re-render mid-fetch cannot
   * start a second one.
   */
  const fetchThread = useCallback(
    (roomSlug: string, rootId: string): void => {
      setState((s) => (s.slug === roomSlug ? { ...s, loadingThreads: [...s.loadingThreads, rootId] } : s))
      wire
        .thread(roomSlug, rootId)
        .then((page) => {
          setState((s) => {
            if (s.slug !== roomSlug) return s
            const loadingThreads = s.loadingThreads.filter((id) => id !== rootId)
            // The root went while this was in flight (a delete frame, or our own delete): the
            // page is a read of rows that no longer exist, and adopting it would put the root
            // back in the timeline.
            if (s.removed.includes(rootId)) return { ...s, loadingThreads }
            // The server page is the truth for the list, but anything that arrived live while it
            // was in flight must survive - same race, same answer, as the room's own history merge.
            const replies = mergeMessages(s.threads[rootId] ?? [], survivors(page.replies, s.removed))
            return {
              ...s,
              loadingThreads,
              threads: { ...s.threads, [rootId]: replies },
              // The root row is refreshed from the same read, so a summary that drifted (a delete
              // this tab never saw) is corrected by the act of opening the thread - but the
              // summary itself is REBUILT from the list just adopted rather than taken from the
              // page: the two agree unless a reply was deleted while the read was in flight, and
              // then the list is right and the page's count is not.
              messages: upsertMessage(s.messages, withThread(page.parent, summarize(replies))),
            }
          })
        })
        .catch((error) => {
          setState((s) =>
            s.slug !== roomSlug
              ? s
              : {
                  ...s,
                  loadingThreads: s.loadingThreads.filter((id) => id !== rootId),
                  expanded: s.expanded.filter((id) => id !== rootId),
                  // A root deleted mid-fetch answers 404. That is the delete landing, not a
                  // failure to report - and `error` here takes the whole room down.
                  error: s.removed.includes(rootId) ? s.error : String(error),
                },
          )
        })
    },
    [],
  )

  // Keyed on the SHAPE of the two maps rather than the maps themselves: their contents change on
  // every live message, and re-running this on each one would be pointless work.
  const expandedKey = view.expanded.join(',')
  const loadedKey = Object.keys(view.threads).join(',')
  useEffect(() => {
    if (slug === null) return
    const roomSlug: string = slug
    const s = stateRef.current
    for (const rootId of s.expanded) {
      if (s.threads[rootId] !== undefined || s.loadingThreads.includes(rootId)) continue
      fetchThread(roomSlug, rootId)
    }
  }, [slug, expandedKey, loadedKey, fetchThread])

  /** Reply into a thread. Same post path as `send`, plus the parent - and the reply is folded into
   *  the root's summary locally so the collapsed row is right even before the feed frame lands. */
  const replyInThread = useCallback(
    async (rootId: string, body: string, attachmentIds: string[] = []): Promise<void> => {
      if (slug === null) throw new Error('no room open')
      const roomSlug: string = slug
      const message = await wire.post(roomSlug, body, attachmentIds, rootId)
      setState((s) => {
        if (s.slug !== roomSlug) return s
        const root = message.parentId ?? rootId
        const alreadyHere = (s.threads[root] ?? []).some((m) => m.id === message.id)
        return {
          ...s,
          // Seeded rather than skipped when the thread was never opened: you just replied into it,
          // so it is open now and it must show what you wrote.
          threads: { ...s.threads, [root]: upsertMessage(s.threads[root] ?? [], message) },
          messages: foldReplyIntoSummary(s.messages, message, alreadyHere),
          expanded: s.expanded.includes(root) ? s.expanded : [...s.expanded, root],
        }
      })
    },
    [slug],
  )

  const decideApproval = useCallback(
    async (input: ChatDecisionInput): Promise<void> => {
      if (slug === null) throw new Error('no room open')
      const result = await wire.agentDecision({ room: slug, ...input })
      // The server's refusals are the interesting ones (a lost double-click race, a card from a
      // replaced session), and they arrive as a 200 with ok:false. Surfacing them the same way a
      // transport failure surfaces keeps the card's one rule intact: nothing changes on screen
      // until the server says it changed.
      if (!result.ok) throw new Error(result.detail)
    },
    [slug],
  )

  return {
    room: view.room,
    topic: view.room?.topic ?? null,
    updateRoom,
    deleteRoom,
    messages: view.messages,
    activity: view.activity,
    unreadAfter: view.unreadAfter,
    nextCursor: view.nextCursor,
    loading: view.loading,
    loadingMore: view.loadingMore,
    error: view.error,
    loadOlder,
    send,
    editMessage,
    deleteMessage,
    react,
    decideApproval,
    threads: view.threads,
    expandedThreads: view.expanded,
    loadingThreads: view.loadingThreads,
    toggleThread,
    replyInThread,
  }
}
