// Local mirrors of the chat wire DTOs (apps/server/src/chat/chat.controller.ts). They exist
// because the generated appRouter.d.ts reflects DTO nesting only one level deep, so every nested
// output field degrades to `unknown` - the SPA casts to these at the tRPC boundary in
// useChatData.ts, nowhere else. All timestamps are epoch MILLISECONDS, never ISO strings.

/**
 * A room as the sidebar needs it: identity plus this user's read state.
 *
 * Every number here is in the room's order-key space, which is `ChatMessage.createdAt`. `unread`
 * is the server's COUNT of surviving messages with `createdAt > lastReadAt` - replies included -
 * and it is ADOPTED, never derived: it counts rows this tab may never have fetched, and a hard
 * delete shrinks it with no frame that says by how much. Local moves are incremental only (see
 * applyFrameToRooms in useChatData.ts); nothing may subtract `lastReadAt` from `headAt`.
 */
/** A named channel, or a direct message between exactly two people (Track 14, 2026-09-04). The
 *  discriminator every DM rule branches on, and since 2026-09-07 it is also the whole privacy
 *  model: a channel is readable and writable by EVERY user, a DM only by its two. A DM cannot be
 *  renamed or reshaped, and it is addressed by PERSON rather than by a slug anyone would type. */
export type ChatRoomKind = 'room' | 'dm'

export interface ChatRoom {
  id: string
  /** A DM's slug is `dm:<a>:<b>` with the two user ids sorted - derived, so opening a DM twice
   *  finds the first room instead of creating a duplicate. Never shown to a human: render [peer]
   *  through the user directory instead. */
  slug: string
  /** The DISPLAY name - free-form (capitals, spaces, punctuation), null when nobody set one, in
   *  which case the slug IS the name. Never an address: `chatRoomLabel` decides what is shown,
   *  `slug` is what every route, tool call and link uses. Always null on a DM. */
  name: string | null
  topic: string | null
  /** The room's lucide icon name (kebab-case, from the server's curated list), or null when nobody
   *  picked one - `roomIcon()` in chatRoomIcons.ts maps both cases, defaulting to `hash`. A string
   *  rather than a union: it is wire data, and a build that has not heard of a name must fall back
   *  rather than fail to compile. Always null on a DM, which renders the peer instead. */
  icon: string | null
  /**
   * The newest order key the room has ever ISSUED - the allocator's guard, not MAX(createdAt)
   * over surviving rows. Once the newest message is deleted it points past everything that still
   * exists, so `headAt > lastReadAt` does NOT mean anything is unread. Mirrored so the cached row
   * matches the server's; nothing in the SPA computes from it.
   */
  headAt: number
  /** The createdAt through which this user has read (everything at or before it is read). Null
   *  until they first mark it read - no pointer, so no unread divider may be computed. */
  lastReadAt: number | null
  /** 0 while `lastReadAt` is null: a room nobody has opened does not owe them a badge for its
   *  entire history. */
  unread: number
  kind: ChatRoomKind
  /** DM only: the OTHER member's `users.id`, viewer-relative. Null on a named room. Names and
   *  avatars come from the user directory the SPA already holds - the chat store lives in SQLite
   *  and users live in the warehouse, so the server does not join them. */
  peer: string | null
  /** The newest surviving message in the room, or null in an empty one - what a list row can show
   *  under the name. `preview` is a bounded excerpt with whitespace collapsed (empty for an
   *  attachment-only message), and `at` is that message's createdAt, which unlike `headAt` moves
   *  BACK when the newest message is deleted. */
  lastMessage: { senderId: string; senderName: string; preview: string; at: number } | null
}

/** What `chatMarkRead` answers and what the `member.read` frame carries: the stored pointer (clamped
 *  to the room head, never moved backwards) and the server's recount against it. Adopt both. */
export interface ChatReadState {
  lastReadAt: number
  unread: number
}

/** One uploaded file. Metadata only - the bytes come from GET /api/chat/attachments/:id, which
 *  re-authorizes on every request (the URL is NOT a capability: nothing signed, nothing expiring).
 *  `messageId` is null during the ORPHAN WINDOW, i.e. uploaded but not yet claimed by a post. */
export interface ChatAttachment {
  id: string
  messageId: string | null
  uploaderId: string
  /** Display name and download filename - never a path. */
  filename: string
  mime: string
  bytes: number
  /** Content address of the bytes on disk; identical uploads share one blob. */
  sha256: string
  createdAt: number
}

export interface ChatMessage {
  id: string
  roomId: string
  senderId: string
  /** Display name at write time (survives renames). */
  senderName: string
  body: string
  /**
   * THE order key: unique per room and strictly increasing in posting order, because the server
   * issues it from a per-room monotonic guard rather than reading the clock. It is the history
   * cursor (`before`), the read pointer (`chatMarkRead.at`, `lastReadAt`) and the sort key. It is
   * NOT identity - that is `id`; dedupe on the one and order on the other.
   */
  createdAt: number
  editedAt: number | null
  /** Present only when the message HAS attachments - the server omits the field otherwise, so
   *  treat undefined and [] the same. */
  attachments?: ChatAttachment[]
  /** Structure beyond the prose (Track 19). Absent on every ordinary message, and on every message
   *  written before migration 008 - the body always stands on its own without it. */
  meta?: ChatMessageMeta
  /** Reactions grouped by emoji (Track 10), palette order. Absent when there are none - treat
   *  undefined and [] the same, like `attachments`. */
  reactions?: ChatReactionGroup[]
  /** The root this message replies to. Absent on a root - threads are exactly one level deep, so
   *  a message either IS a thread's root or hangs off one. */
  parentId?: string
  /** Summary of the thread under this root, when it has one. Only ever present on roots, and only
   *  in the grouped history shape the SPA asks for (`roots: true`). */
  thread?: ChatThreadSummary
}

/** What a collapsed thread row shows. Absent (not zeroed) when a root has no surviving replies. */
export interface ChatThreadSummary {
  replyCount: number
  /** `createdAt` of the newest reply - and, since that IS the order key, how a thread on an old
   *  root can be told to have just been answered. */
  lastReplyAt: number
  /** Distinct repliers, oldest contribution first - the avatar cluster on the toggle. */
  participants: string[]
}

/**
 * What `chatDelete` destroyed. A HARD delete: nothing is left to render, and for a thread root
 * every reply under it went too, whoever wrote them. A repeat delete is a 404, not a no-op - a
 * deleted message is indistinguishable from one that never existed.
 */
export interface ChatMessageDeletion {
  roomId: string
  /** The message the caller named. */
  messageId: string
  /** Every id that went: the named message first, then (for a root) its replies oldest-first -
   *  the same order the `message.deleted` frames are emitted in. */
  deleted: string[]
  /** Attachment blobs whose LAST reference went with these messages. */
  blobs: number
  /** The agent had written in what was deleted, so the room's agent session was dropped and its
   *  next turn starts fresh. Per ROOM, not per thread. */
  agentSessionDropped: boolean
}

/**
 * A worker approval card - the first `meta` shape; `ChatOpApprovalMeta` below is the second.
 *
 * A DURABLE message, deliberately the opposite of `agent.activity`: a decision waiting on a human
 * SHOULD badge the room and SHOULD still be in the transcript tomorrow as the record of who
 * allowed what. `state` only ever moves forward (`pending` -> approved | denied | expired), so a
 * card that settled while this tab was asleep can never be re-answered from it.
 */
export interface ChatApprovalMeta {
  kind: 'approval'
  /** The worker's request id - what the decision mutation is keyed by. */
  requestId: string
  /** Sent back with the decision so a card from a replaced session is refused, not misapplied. */
  workerSessionId: string
  toolName: string
  state: ChatApprovalState
  expiresAt?: number
  /** A `users.id` once a human answered; null when the worker's own timeout or policy did. */
  decidedBy?: string | null
  decidedAt?: number
}

/** A card's lifecycle, shared by both kinds. Only ever moves forward. */
export type ChatApprovalState = 'pending' | 'approved' | 'denied' | 'expired'

/**
 * A chat-operation approval card: an API client (nova over MCP, a script, a Claude Code session
 * holding somebody's token) asked for a destructive chat operation, and a human in the room has to
 * approve it before the SERVER runs it. No worker session behind it, so no `workerSessionId` -
 * the decision mutation is keyed by `requestId` alone, and the server routes it by that.
 *
 * Its own `kind` so a client built before it existed renders the body (which spells out the reply
 * grammar) rather than buttons wired to a session this card does not have.
 */
export interface ChatOpApprovalMeta {
  kind: 'chat-op'
  requestId: string
  op: 'room-delete'
  /** The target room by ID - a slug can be renamed while the card waits. */
  roomId: string
  /** Short header text, e.g. "Delete #war-room". */
  label: string
  /** The `users.id` that asked. The approver is who executes it. */
  requestedBy: string
  state: ChatApprovalState
  expiresAt: number
  decidedBy?: string | null
  decidedAt?: number
}

/**
 * The durable record of a FINISHED agent turn (mirror of `ChatAgentTurnMeta` in @silkweave/box-core).
 *
 * Not a card: no decision, no buttons. It exists because the live activity frame is an ephemeral
 * the client clears the instant a turn reports `done`, which took the only route to that turn's
 * transcript with it. This is what keeps a finished turn reviewable.
 */
export interface ChatAgentTurnMeta {
  kind: 'agent-turn'
  workerSessionId: string
  startedAt: number
  endedAt: number
  toolCount: number
  state: 'done' | 'error'
}

/** The two meta shapes that render as a decidable CARD. Named so the card components can take
 *  exactly those and let TypeScript refuse a turn record, which carries no decision at all. */
export type ChatCardMeta = ChatApprovalMeta | ChatOpApprovalMeta

export type ChatMessageMeta = ChatCardMeta | ChatAgentTurnMeta

/** What answering a card sends. `workerSessionId` travels only for a worker card (`kind:
 *  'approval'`), where the server refuses a decision for a replaced session. */
export interface ChatDecisionInput {
  requestId: string
  workerSessionId?: string
  action: 'approve' | 'deny'
}

/**
 * What an agent turn is DOING right now - the `agent.activity` ephemeral's payload.
 *
 * Already summarized and sanitized server-side (`packages/core/src/chat/agent-activity.ts`): the
 * label is one safe line and raw tool arguments never cross this wire. Rendering `label` verbatim
 * is the intended use; the arguments live behind the authenticated session viewer instead.
 */
export interface AgentActivityFrame {
  /** The placeholder message this turn is filling in - the row the line hangs under. */
  messageId: string
  /** `done` and `error` are TERMINAL: they are the only thing that clears a spinner. */
  state: 'starting' | 'thinking' | 'tool' | 'writing' | 'waiting' | 'done' | 'error'
  label: string
  toolCount: number
  /** Epoch ms the turn began, so elapsed time is the server's clock and not a client's guess. */
  startedAt: number
  /** The worker session behind this turn - what "View session" opens. */
  workerSessionId: string
}

/**
 * The answer to `chatAgentStatus` - the mid-turn-join read.
 *
 * `agent.activity` is an ephemeral and is never replayed, so opening a room (or reconnecting a
 * dropped feed) while a turn is in flight needs this to learn what the placeholder is doing.
 * `activity` is exactly the ephemeral's payload, so it can be adopted without a second code path.
 */
export interface ChatAgentStatus {
  active: boolean
  activity: AgentActivityFrame | null
}

/**
 * One emoji's worth of reaction on a message.
 *
 * There is no `mine` flag by design: the shape is READER-INDEPENDENT, so one fan-out payload is
 * correct for everybody and an edit frame can carry reactions truthfully. "Did I react" is
 * `users.includes(me)`.
 */
export interface ChatReactionGroup {
  emoji: string
  /** Everyone who reacted with it, oldest first (same-millisecond ties break alphabetically). */
  users: string[]
  count: number
}

/**
 * What a `reaction.added` / `reaction.removed` frame carries.
 *
 * `reactions` is the message's COMPLETE list after the change, not a delta - adopt it rather than
 * incrementing, or a dropped frame drifts a count that nothing ever corrects.
 */
export interface ChatReactionEvent {
  messageId: string
  /** The thread root, when the reacted-to message is a reply. */
  parentId?: string
  userId: string
  emoji: string
  reactions: ChatReactionGroup[]
}

/** One frame of the multiplexed live feed. `id` is the global outbox id - the resume cursor after
 *  a drop. `type` is 'hello' | 'ping' | 'message.created' | 'message.edited' | 'message.deleted' |
 *  'member.read' | 'room.created' | 'room.updated' |
 *  'room.deleted' | 'mention.created' | 'agent.activity'; consumers must ignore unknown types
 *  instead of crashing.
 *  Everything except 'message.created' is an EPHEMERAL: no outbox row backs it, its `id` is a
 *  high-water mark (never an advance), and it is not replayed after a drop. Exactly three types
 *  may touch a room's unread: a created message (+1 above the pointer), a deleted one (-1 above
 *  the pointer) and `member.read`, which carries the server's own number. A missed edit or delete
 *  converges on the next history fetch. */
export interface ChatFeedFrame {
  id: number
  type: string
  /** null for hello/ping. NB: the room's id, not its slug. */
  roomId: string | null
  /**
   * `message.created` / `message.edited` / `mention.created`: the stored row. `message.deleted`:
   * the IDENTITY of the row that went - id, roomId, createdAt, senderId/senderName, parentId - with
   * an empty body and no attachments or meta. It means "remove this", never "render this as
   * removed". Null on every other type.
   */
  payload: ChatMessage | null
  /** `member.read` only: the stored pointer and the server recount, to be adopted wholesale. */
  read?: ChatReadState | null
  /** `agent.activity` only, null or absent on every other type. */
  activity?: AgentActivityFrame | null
  /** `reaction.added` / `reaction.removed` only. Carries the message's complete grouped list. */
  reaction?: ChatReactionEvent | null
  /** When the frame was emitted. Not an order key - a message's key is `payload.createdAt`. */
  at: number
}

/**
 * The answer to `chatRoomDelete`, and the `status` is not a formality: a call from a browser
 * session deletes (`deleted`), while a call from any API client is HELD and answers `pending` with
 * an approval card posted into the room instead. The SPA only ever sees `deleted` - it is a session
 * - but it must not assume it, because assuming it would report a purge that has not happened.
 */
export interface ChatRoomDeleteResult {
  status: 'deleted' | 'pending'
  roomId: string
  slug: string
  /** One honest line, written for the caller. For `pending` it says what happens next. */
  detail: string
  /** `deleted` only. */
  messages?: number
  blobs?: number
}

/** One expanded thread: its root plus every reply that exists, oldest-first. A deleted reply is
 *  gone, not a tombstone. */
export interface ChatThreadPage {
  parent: ChatMessage
  replies: ChatMessage[]
}

export interface ChatHistoryPage {
  /** Oldest-first, ready to render top-down. */
  messages: ChatMessage[]
  /** A `createdAt` to pass as `before` for the next OLDER page; null when this page reaches the
   *  start of the room. A bare key, not a row: it stays valid when the message it was taken from
   *  is deleted, because paging asks for `createdAt < before` and nothing else. */
  nextCursor: number | null
  /** The room's head - see `ChatRoom.headAt`. */
  headAt: number
}

/**
 * The body an agent turn posts as its placeholder, before it has written anything.
 *
 * A local mirror of `PLACEHOLDER_BODY` in apps/server/src/agent/chat-agent.ts, and the ONLY thing
 * that distinguishes "nova is still working" from "nova said the word …". Kept as a constant so the
 * coupling is greppable from both ends: if the server ever changes what it posts, the typing
 * indicator degrades to rendering a literal ellipsis rather than breaking, and this comment is
 * where the next person looks.
 */
export const AGENT_PLACEHOLDER_BODY = '…'
