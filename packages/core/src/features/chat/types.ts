// Domain types for the team chat store (chat.db, SQLite - NOT the DuckDB warehouse; the rationale
// and the future read-only ATTACH live in docs/BACKLOG.md § Chat). Framework-free: the NestJS
// surface, the tests and any future ops script all consume these through @silkweave/box-core.

/**
 * What a room IS (chat Track 14, migration 012). `room` is a named channel, open to every principal
 * - since migration 015 there is no other kind of channel: every user is in every room, and a room
 * ends only by being deleted. `dm` is a direct message: a room with exactly two members whose slug
 * is derived from the sorted pair of their ids (`dm:<a>:<b>`), so that opening a DM is idempotent
 * and a duplicate is impossible at the schema level (`rooms_slug` is UNIQUE).
 *
 * A kind, not a flag, because it is THE discriminator every access rule branches on: a channel is
 * readable by everyone and a DM by its pair (`READABLE_PREDICATE` / `requireReadableRoom` in
 * store.ts), a DM cannot be renamed or re-topiced, and a plain message in one notifies its peer the
 * way a mention does. Its shape is enforced by the schema itself - a CHECK ties `kind = 'dm'` to
 * the `dm:` slug namespace - never by trusting a caller.
 */
export type ChatRoomKind = 'room' | 'dm'

/**
 * The room appearance vocabulary: the lucide icon names a room may wear, curated rather than open.
 *
 * A CLOSED list on purpose, and it lives here rather than in either client because the field is
 * shared - the web SPA imports exactly these components from `lucide-react`, the Flutter app maps
 * exactly these to `LucideIcons`, and neither can render a name the other invented. Kebab-case is
 * lucide's own canonical spelling, so each client derives its local casing (`PascalCase`,
 * `lowerCamel`) mechanically instead of keeping a translation table. Every name here is verified to
 * exist in BOTH packages; add one only after checking the same.
 *
 * `hash` is the default a client draws when a room carries no icon at all - it is in the list so
 * that "back to the default" is a pick rather than a separate clear affordance.
 */
export const CHAT_ROOM_ICONS = [
  'hash', 'megaphone', 'rocket', 'bug', 'code', 'wrench', 'lightbulb', 'flame', 'sparkles', 'star', 'heart',
  'coffee', 'music', 'camera', 'image', 'palette', 'book', 'bookmark', 'briefcase', 'building', 'calendar',
  'target', 'trophy', 'zap', 'shield', 'lock', 'globe', 'compass', 'map', 'users', 'bot', 'brain', 'beaker',
  'gauge', 'cpu', 'database', 'server', 'terminal', 'package', 'truck', 'banknote', 'credit-card', 'activity',
  'bell', 'inbox', 'mail', 'phone', 'pizza', 'plane', 'party-popper', 'leaf', 'sun', 'moon', 'cloud', 'anchor',
  'key', 'link', 'scissors', 'siren', 'telescope', 'ticket', 'wallet', 'waves', 'newspaper', 'presentation',
  'clipboard-list', 'circle-help', 'flag', 'handshake'
] as const satisfies readonly string[]

/** One of 69 curated lucide names - see CHAT_ROOM_ICONS. */
export type ChatRoomIcon = (typeof CHAT_ROOM_ICONS)[number]

/** Narrow an untrusted string to a known icon. The store validates with this, so an unknown name
 *  never reaches the column and no client has to cope with an unrenderable one. */
export function isChatRoomIcon(value: string): value is ChatRoomIcon {
  return (CHAT_ROOM_ICONS as readonly string[]).includes(value)
}

/** How long a room's display name may be. Generous enough for a sentence fragment, short enough
 *  that a sidebar row and a breadcrumb stay readable. */
export const CHAT_ROOM_NAME_MAX = 64

/**
 * What a room is CALLED: its display name when it has one, its slug otherwise.
 *
 * Here rather than in a client because both clients need it and the fallback is a RULE, not a
 * preference - a room whose name was never set must read as its slug everywhere, or the sidebar
 * and the breadcrumb disagree about what the same room is. A DM has neither (its label is the
 * peer, which only a client can resolve), so callers handle that case before reaching this.
 */
export function chatRoomName(room: Pick<ChatRoom, 'name' | 'slug'>): string {
  return room.name ?? room.slug
}

/** Who is writing: a `users.id` principal from the Box's users directory plus its display name at
 *  the time of the write. Chat never keeps its own user table - identity stays in the warehouse
 *  `users`. */
export interface ChatSender {
  id: string
  display: string
}

export interface ChatRoom {
  id: string
  /** The address every procedure takes. For a DM it is DERIVED (`dm:<a>:<b>`, ids sorted) and is
   *  not something a person types - the client addresses it by the peer, and resolves the slug
   *  through `chatDirectOpen`. */
  slug: string
  /**
   * The room's DISPLAY name - free-form, so it may carry capitals, spaces and punctuation the slug
   * grammar cannot ("Dev Team", "Q4 planning"). Null means nobody set one and the slug IS the name,
   * which is every room written before migration 014.
   *
   * It is not an address: nothing looks a room up by it, it is not unique, and the slug stays the
   * one thing every link, tool call and push payload names. Two rooms MAY carry the same display
   * name - that is a human problem, not a data one, and enforcing uniqueness on a label would make
   * a cosmetic edit fail for reasons nobody can see.
   */
  name: string | null
  topic: string | null
  kind: ChatRoomKind
  /**
   * The room's chosen lucide icon, or null for "never picked one" - which every client draws as
   * `hash`. Null rather than a stored default so that a future change of default is a one-line
   * client change rather than a data migration, and so `updateRoom` can tell "leave it" from
   * "clear it" the same way it already does for `topic`.
   */
  icon: ChatRoomIcon | null
  createdBy: string | null
  createdAt: number
}

/**
 * A room as the sidebar needs it: the room's head, the viewer's read pointer, and the unread COUNT.
 *
 * Every number here is in the room's ORDER-KEY space, which since migration 010 is
 * `ChatMessage.createdAt` (see the comment there): `headAt` and `lastReadAt` are createdAt values,
 * and `unread` is the server's count of surviving messages with `createdAt > lastReadAt`. A client
 * must adopt `unread` rather than derive it - there is no arithmetic that reproduces a count over
 * rows it has not seen, and a hard delete can shrink it without any frame that says by how much.
 *
 * There is no `member` flag (retired with migration 015): every channel is everybody's, so the
 * only per-viewer fact a room carries is the read pointer, and "has this person ever read here" is
 * `lastReadAt !== null`.
 */
export interface ChatRoomSummary extends ChatRoom {
  /**
   * The newest order key this room has ever ISSUED - the allocator's head, not MAX(createdAt) over
   * surviving rows. Equal to the newest message's `createdAt` unless that message was since
   * deleted, in which case it points past everything that still exists. It never moves backwards,
   * which is what keeps every cursor and read pointer built on it valid across deletes.
   */
  headAt: number
  /**
   * The createdAt through which this viewer has read - every message at or before it is read - or
   * null when they have never read, posted in or been mentioned in this room, and so hold no
   * pointer yet. Null rather than an invented head, so a client does not compute an unread divider
   * for a room nobody has opened; the first `markRead` writes the row.
   */
  lastReadAt: number | null
  /** Surviving messages with `createdAt > lastReadAt`. Always 0 when `lastReadAt` is null: a
   *  person who has never opened a room is not badged for its entire history. */
  unread: number
  /**
   * DM only: the OTHER member's `users.id` - what the sidebar shows instead of a topic, and what
   * a client resolves to a name and avatar through the user directory it already holds. Carried on
   * the summary rather than looked up per room because a sidebar of N DMs must not cost N member
   * calls. Viewer-relative (it is "the one who is not you"), which is why it lives here and not on
   * `ChatRoom`. Null on a named room.
   */
  peer: string | null
  /**
   * The newest surviving message in the room, or null in an empty one - what a list row shows
   * under the name so a conversation says what it is about without being opened. A DM has no topic,
   * so without this every DM row is a bare name.
   *
   * `preview` is a BOUNDED excerpt with whitespace collapsed, never the full body (see
   * `PREVIEW_CHARS` in store.ts), and it carries nothing about attachments: an attachment-only
   * message previews as an empty string and the client decides what that looks like. Unlike
   * `unread` it does not depend on the viewer holding a read pointer - a preview is a property of
   * the room's content, and a DM is already invisible to anyone outside its pair.
   */
  lastMessage: ChatRoomPreview | null
}

/** The newest message in a room, as a list row needs it. */
export interface ChatRoomPreview {
  senderId: string
  /** The WRITE-TIME snapshot on the message, like every other sender name in chat. */
  senderName: string
  preview: string
  /** That message's `createdAt` - the room's real last-activity time, unlike `headAt`, which is an
   *  allocator guard and outlives the message it was issued for. */
  at: number
}

/** What `markRead` hands back and what the `member.read` ephemeral carries: the stored pointer
 *  (clamped to the room head, never moved backwards) and the server's recount against it. */
export interface ChatReadState {
  lastReadAt: number
  unread: number
}

/**
 * What deleting a room destroyed. The ONLY way a room ends (since migration 015 there is no leave
 * and no archive - every channel is everybody's until somebody deletes it), and it is a PURGE: the
 * room row goes and SQLite's ON DELETE CASCADE takes its messages, outbox events, mentions and
 * read-pointer rows with it. The counts are returned because they are the only record afterwards;
 * nothing about the room survives to be queried.
 */
export interface ChatRoomDeletion {
  roomId: string
  slug: string
  /** Messages destroyed, counted inside the deleting transaction. */
  messages: number
  /** Attachment blobs whose LAST reference went with the room and were unlinked from disk. */
  blobs: number
}

export interface ChatMessage {
  id: string
  roomId: string
  senderId: string
  senderName: string
  body: string
  /**
   * THE order key (migration 010): unique per room, strictly increasing in posting order, and the
   * currency of every cursor (`history.before`), read pointer (`lastReadAt`) and head (`headAt`).
   *
   * It is an ISSUED time, not a wall-clock reading. The store hands it out from a per-room
   * monotonic guard - `MAX(head + 1, now)` inside the posting transaction - so two posts in one
   * millisecond get consecutive keys, and a clock that steps BACKWARDS keeps issuing keys just
   * past the last one until real time catches up. In that window `createdAt` reads ahead of the
   * wall clock by up to the size of the step. That is the accepted cost of having one time-shaped
   * key instead of a timestamp beside a counter; see `ChatStore.issueKeyStmt` for the mechanism.
   */
  createdAt: number
  editedAt: number | null
  /**
   * Present exactly when the message HAS attachments (Track 11) - metadata only, never bytes; the
   * content is fetched per-request through the authenticated serve route. OPTIONAL rather than an
   * always-present array because outbox payloads are stored JSON: rows written before migration
   * 006 have no field to parse, and an absent key must mean the same thing there as here.
   */
  attachments?: ChatAttachment[]
  /**
   * Machine-readable structure this message carries beyond its prose (chat Track 19).
   *
   * OPTIONAL and absent on every ordinary message, which is the whole compatibility story: rows
   * written before migration 008 have no column to read, stored outbox payloads have no key to
   * parse, and a client that does not know the field renders the body - which is deliberately
   * written to stand on its own - and loses nothing but the buttons.
   */
  meta?: ChatMessageMeta
  /**
   * The message this one replies to (chat threads, migration 009) - always a ROOT, never another
   * reply: the hierarchy is one level deep and `post` re-parents a reply-to-a-reply onto its root.
   *
   * ABSENT rather than null on a root message, matching `meta` and `attachments`: rows written
   * before 009 have no column to read, stored outbox payloads have no key to parse, and a client
   * that does not know the field renders every message in one flat timeline - which is exactly
   * what it did yesterday.
   */
  parentId?: string
  /**
   * The thread hanging off THIS message, when it has one. Present only on root messages, only in
   * responses that asked for the grouped shape (`history({ roots: true })`), and only when at
   * least one reply survives - a summary, never the replies themselves, which are fetched by
   * `thread()` when a reader expands.
   */
  thread?: ChatThreadSummary
  /**
   * The reactions on this message, grouped by emoji (chat Track 10). Absent when there are none,
   * matching `attachments`/`meta`/`parentId`: a pre-011 row, a stored outbox payload and a client
   * that never learned the field all agree that a message without the key has no reactions.
   *
   * READER-INDEPENDENT, which is the decision that makes the rest of the feature simple - see
   * `ChatReactionGroup.users`. Every recipient of a fan-out frame can be sent the SAME payload.
   */
  reactions?: ChatReactionGroup[]
}

/**
 * One emoji's worth of reaction on a message: what it is, how many, and exactly who.
 *
 * There is deliberately no `mine` flag, and that is load-bearing rather than lazy. `mine` would be
 * reader-dependent, so the `message.edited` ephemeral - which fans one payload out to every reader
 * and REPLACES their copy of the message wholesale - could not carry reactions truthfully, and
 * every edit would either strip its own reactions or lie about whose they are. With `users` the
 * payload is the same for everybody and "did I react" is `users.includes(me)` on the client.
 */
export interface ChatReactionGroup {
  emoji: string
  /** Everyone who reacted with it. Authoritative and complete: a room is a handful of people, so
   *  there is no cap to explain and no truncated-list footgun for a client to get wrong. */
  users: string[]
  /** `users.length`, carried so a client renders the pill without counting an array it may choose
   *  not to hold. */
  count: number
}

/**
 * What a `reaction.added` / `reaction.removed` ephemeral carries.
 *
 * `reactions` is the message's COMPLETE group list after the change, not a delta. A client adopts
 * it rather than incrementing a counter, so a dropped frame, a double-tap and two people racing
 * the same emoji all converge on the server's answer instead of drifting a count that nothing
 * ever corrects. `userId` and `emoji` are still carried because they are what an animation or a
 * "Alice reacted" line needs, not because the state can be rebuilt from them.
 */
export interface ChatReactionEvent {
  messageId: string
  /** The thread root, when the reacted-to message is a reply - so a client holding only the open
   *  thread can decide whether the frame concerns it without an index of every message id. */
  parentId?: string
  /** Who reacted or un-reacted. */
  userId: string
  emoji: string
  reactions: ChatReactionGroup[]
}

/** What a collapsed thread shows: how much is under it, how fresh it is, and who is in it. */
export interface ChatThreadSummary {
  /** Replies under the root. Zero never travels - the summary is absent instead. */
  replyCount: number
  /** `createdAt` of the newest reply - what "last reply 3m ago" reads from, and, because
   *  createdAt IS the order key, how a client can tell that a quiet-looking thread (the timeline
   *  is ordered by the ROOT's createdAt) has just been answered. */
  lastReplyAt: number
  /** Distinct repliers, oldest contribution first, capped - the avatar cluster on the toggle. */
  participants: string[]
}

/**
 * What deleting a message destroyed. A hard delete, and for a thread root a CASCADE: the root and
 * every reply under it go together, with their outbox rows, attachments and mentions - nothing is
 * left behind to render as a tombstone, and nothing survives in `events.payload` to be replayed.
 */
export interface ChatMessageDeletion {
  roomId: string
  /** The message the caller named. */
  messageId: string
  /** Every id that went: the named message first, then (for a root) its replies oldest-first.
   *  The same order the `message.deleted` frames are emitted in. */
  deleted: string[]
  /** Attachment blobs whose LAST reference went with these messages and were unlinked from disk. */
  blobs: number
  /** The room's `agent_sessions` row was dropped because the agent had written in what was
   *  deleted - the next turn in this room starts a fresh worker session. */
  agentSessionDropped: boolean
}

/**
 * The first shape `ChatMessage.meta` took: a worker approval card (chat Track 19). The second is
 * `ChatOpApprovalMeta` below; both render through the same client surface.
 *
 * A DURABLE message rather than an ephemeral, deliberately the opposite choice from
 * `agent.activity`: a decision waiting on a human SHOULD badge the room and SHOULD still be there
 * tomorrow as the record of who allowed what. Pollution is bounded by updating the one message in
 * place (body + meta, no new key) as it resolves, and by a per-turn cap on how many may post.
 *
 * `state` is a one-way street: `pending` -> `approved` | `denied` | `expired`. Nothing moves it
 * back, so a card that resolved while a browser was asleep cannot be re-answered by that browser.
 */
export interface ChatApprovalMeta {
  kind: 'approval'
  /** The worker's own request id - what `handle.approve`/`handle.deny` are keyed by. */
  requestId: string
  /** The worker session that raised it. A decision for a session that has since been replaced is
   *  refused rather than sent, so a stale card cannot answer a fresh turn's question. */
  workerSessionId: string
  toolName: string
  state: ChatApprovalState
  /** Epoch ms after which the WORKER resolves this itself. Absent when it never told us. */
  expiresAt?: number
  /** Who answered, once someone did: a `users.id`, or null when the worker's own timeout or
   *  policy resolved it. */
  decidedBy?: string | null
  decidedAt?: number
}

/** A card's lifecycle, shared by every card kind. One-way: `pending` first, then exactly one of the
 *  others, forever. */
export type ChatApprovalState = 'pending' | 'approved' | 'denied' | 'expired'

/** The destructive chat operations that are held for an in-channel approval when an API client
 *  asks for them. One member today; the field exists so a second one is a value, not a new card. */
export type ChatOpKind = 'room-delete'

/**
 * A CHAT-OPERATION approval card: an API client (an agent over MCP, a script, the `cli` proxy)
 * asked for a destructive chat operation, and a human in the room has to say yes before it runs.
 *
 * Its own `kind` rather than a flag on `ChatApprovalMeta`, and the choice is about OLD clients: a
 * client that narrows on `kind === 'approval'` sees an unknown kind and renders the body, so it
 * still reads what was asked (it cannot ANSWER - the typed reply grammar was removed on
 * 2026-09-09). Reusing the worker card's kind would instead hand that client buttons wired to a
 * `workerSessionId` this card does not have.
 *
 * Unlike a worker card, nothing about this card depends on a live agent session: the pending
 * operation is held by the server itself (`apps/server/src/chat/chat-op-approvals.ts`), the
 * decision EXECUTES it, and the actor of record is the approver.
 */
export interface ChatOpApprovalMeta {
  kind: 'chat-op'
  /** Minted by the server when the card is posted - what the decision mutation is keyed by. */
  requestId: string
  op: ChatOpKind
  /** The room the operation targets, by ID: a slug can be renamed while the card waits. */
  roomId: string
  /** Short human label for the client's header line, e.g. "Delete #war-room". */
  label: string
  /** The `users.id` of the principal that asked. The approver is who executes it, not this one. */
  requestedBy: string
  state: ChatApprovalState
  /** Epoch ms after which the server expires the card unanswered. */
  expiresAt: number
  /** Who answered: a `users.id`, or null when the server's own timeout settled it. */
  decidedBy?: string | null
  decidedAt?: number
}

/**
 * The RECORD of a finished agent turn, stamped onto nova's answer when the turn lands.
 *
 * Its whole reason to exist is that the live activity frame is an EPHEMERAL: it is never replayed,
 * and the client clears it the instant the turn reports `done`. So the moment a turn finished, the
 * only route to its transcript vanished with it, and a room could watch nova work but could never
 * afterwards ask what it had actually done. This is the durable half of the same split - names in
 * the channel, arguments behind the auth-gated viewer - and it survives a reload, a reconnect and a
 * server restart because it is a column on the message rather than a frame on a bus.
 *
 * Not an approval card despite sharing the field: it carries no decision and no buttons, and a
 * client that has never heard of this kind renders nova's answer exactly as before and loses only
 * the affordance. That is why it is a third `kind` rather than a flag on an existing one.
 *
 * `workerSessionId` names a row in the worker's registry, which may be GONE - the chat agent closes
 * a room's session after an idle hour. A client must treat "that session has ended" as an ordinary
 * outcome for an old turn, never as an error.
 */
export interface ChatAgentTurnMeta {
  kind: 'agent-turn'
  workerSessionId: string
  /** Epoch ms the turn started, so a reader can see what it cost without a live timer. */
  startedAt: number
  endedAt: number
  /** Tool calls this turn made. Monotonic, from the same tracker the activity line reads. */
  toolCount: number
  /** How it ended. `error` is the case the ephemeral could never report: the line UNMOUNTED on it,
   *  so an errored turn used to leave nothing behind saying it had errored. */
  state: 'done' | 'error'
}

export type ChatMessageMeta = ChatApprovalMeta | ChatOpApprovalMeta | ChatAgentTurnMeta

/**
 * One upload's metadata (chat Track 11). The bytes live on disk under `<instance>/chat-uploads/`,
 * content-addressed by `sha256`; this row is what keeps them alive (blob GC refcounts rows by
 * sha256) and what authorization is decided on: `messageId` null = the ORPHAN window, readable
 * only by `uploaderId`; otherwise readable by exactly whoever can read the message's room
 * (`ChatStore.attachmentForRead`, which routes through `canReadRoom`).
 */
export interface ChatAttachment {
  id: string
  /** Null during the orphan window - uploaded but not yet claimed by a post. */
  messageId: string | null
  uploaderId: string
  /** The client's original name - display data and the download filename, never a disk path. */
  filename: string
  mime: string
  bytes: number
  sha256: string
  createdAt: number
}

/** A COMMITTED outbox row. `id` is the global resume cursor for the live feed. `at` is the row's
 *  key in the room's order space - for `message.created` it equals `payload.createdAt`, because
 *  the outbox row is written in the posting transaction under the message's own issued key. */
export interface ChatEvent {
  id: number
  roomId: string
  type: string
  payload: ChatMessage
  at: number
}

/**
 * An outbox-less event for one user's other tabs (read-pointer moved, room created, you were
 * mentioned) or for a room's readers (a message was edited or deleted). Deliberately NOT an outbox
 * row, and the reason survived the move from a counter to a time key: an outbox row is a
 * `message.created` to every client, so a `room.created`, `member.read`, `message.edited` or
 * `mention.created` row would be ingested as a message that does not exist - the trap called out
 * in the chat PRD, Track 2. Everything but the message itself travels here.
 *
 * No outbox row also means no replay on reconnect, which is fine for every type here: the state
 * most of them announce (read pointers, the room list, the edited state of a message, the fact of
 * a deletion) is refetched wholesale by a reconnecting client, where a missed MESSAGE could only
 * come from the outbox - and a deleted message's outbox row is deleted with it, so replay can never
 * resurrect one. `mention.created` alone has a DURABLE row of its own - the `mentions` table,
 * written in the posting transaction - so the bell refetches that; the ephemeral is only the live
 * nudge, never the record.
 */
export interface ChatEphemeralEvent {
  ephemeral: true
  type:
    | 'member.read'
    | 'room.created'
    // The room's shape changed (slug, name, topic, icon) or it was destroyed. Both fan out to
    // READERS, like message.edited, because both change what an OPEN room should be rendering -
    // a renamed channel whose header still shows the old slug is the same lie a frozen feed tells.
    // `room.deleted` is the one type the feed delivers WITHOUT re-checking canReadRoom: the room
    // is already gone by then, so that check would drop the very event that says so. See the
    // exemption in chat.controller.ts's feed, and `ChatStore.deleteRoom` for how the audience is
    // decided at emit time instead (everyone for a channel; the captured pair for a DM).
    | 'room.updated'
    | 'room.deleted'
    | 'message.edited'
    | 'message.deleted'
    | 'mention.created'
    | 'agent.activity'
    // A reaction landed or was taken back (Track 10). Fans out to READERS like message.edited,
    // because it changes what an open room should be rendering. It allocates no order key, writes
    // no outbox row and NEVER notifies - it is the gesture you make instead of interrupting
    // somebody, so a bell row or a push for one would defeat the whole point of the feature.
    | 'reaction.added'
    | 'reaction.removed'
  roomId: string
  /**
   * Routing, not payload. A user id is the ONLY principal whose feed connections may receive this
   * (stricter than readability - another member's read pointer is nobody else's business). `null`
   * means fan out to the room's READERS, and the server applies exactly the same `canReadRoom`
   * filter it already applies to outbox events before yielding anything.
   *
   * `mention.created` is per-user too, one emit per mentioned user: who was mentioned is nobody
   * else's business, and the room already learned about the message from its outbox event.
   *
   * "READERS" is everyone for a channel and the pair for a DM (plus the agent as a DM guest) -
   * never "people holding a read pointer": somebody watching a room they have not marked read must
   * see an edit or a delete land, or their open room shows stale bodies and undeleted ghosts - the
   * same lie a frozen feed tells, on a quieter path.
   */
  userId: string | null
  /**
   * The message row for `message.edited` (the stored row, wholesale) and `mention.created` (the
   * mentioning message, emitted AFTER its outbox event so the receiver has already ingested it).
   *
   * For `message.deleted` it IDENTIFIES the row that went and says nothing of what it said: `id`,
   * `roomId`, `createdAt`, `senderId`/`senderName` and `parentId` are the stored values, `body`
   * is empty, and `attachments`/`meta` are absent. A cascade emits one frame per deleted message,
   * ROOT FIRST and then its replies oldest-first, so a client that drops the root (and the thread
   * under it) on the first frame finds nothing to do for the rest. Null for every other type.
   */
  payload?: ChatMessage | null
  /**
   * `reaction.added` / `reaction.removed` only: which message, who, which emoji, and the message's
   * complete group list after the change. See `ChatReactionEvent`.
   */
  reaction?: ChatReactionEvent | null
  /**
   * `member.read` only: the stored pointer after the clamp and the server's recount. Carried so
   * the user's other tabs ADOPT a number instead of extrapolating one - unread is a count over
   * rows a tab may never have fetched, and no client-side arithmetic reproduces it.
   */
  read?: ChatReadState | null
  /**
   * `agent.activity` only: what the agent turn anchored at `activity.messageId` is doing now.
   *
   * Progress is an EPHEMERAL rather than a message on purpose. It is high-frequency and disposable,
   * and only a `message.created` may badge a room - nobody should be badged because nova read a
   * file. It carries no history and is not replayed: a client joining mid-turn asks for the
   * current state instead, which is why nothing here needs to be durable.
   *
   * Already summarized and sanitized server-side (see `agent-activity.ts`); raw tool arguments
   * never reach this wire.
   */
  activity?: AgentActivityFrame | null
  /** When the frame was emitted. Not an order key: the message's key is `payload.createdAt`. */
  at: number
}

/** The `agent.activity` payload. `messageId` is the placeholder this turn is filling in. */
export interface AgentActivityFrame {
  messageId: string
  state: 'starting' | 'thinking' | 'tool' | 'writing' | 'waiting' | 'done' | 'error'
  label: string
  toolCount: number
  startedAt: number
  /** The worker session behind this turn - what "view the live session" opens. */
  workerSessionId: string
}

/**
 * One room's conversation with the chat agent (chat Track 15) - the `agent_sessions` row.
 *
 * The DURABLE half of a thing whose live half is a websocket. The server module holds a
 * `SessionHandle` per room in memory; this is what is left when the process dies, and it is
 * exactly what restart recovery needs to pick the turn back up: which worker session to
 * re-attach, from which seq, and which message was being written into.
 */
export interface ChatAgentSession {
  roomId: string
  /** Names a session in the WORKER's registry, not a row here - it can vanish under us. */
  workerSessionId: string
  /** Non-null exactly while a turn is mid-flight: the message whose body it is filling in. */
  streamingMessageId: string | null
  /** Resume point for `attach({ afterSeq })` after a server restart. */
  lastWorkerSeq: number
  turnStartedAt: number | null
  turnsThisHour: number
  windowStartedAt: number
  updatedAt: number
}

/** What actually travels on the chat bus: committed outbox rows plus per-user ephemerals. */
export type ChatBusEvent = ChatEvent | ChatEphemeralEvent

/** One Web Push subscription row (chat Track 9). The endpoint is the identity - the browser
 *  mints one per (profile, origin, service-worker registration) - and p256dh/auth are the keys
 *  the payload is encrypted to. A subscription is a capability: treat rows as prunable, never
 *  as durable identity. */
export interface ChatPushSubscription {
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  userAgent: string | null
  createdAt: number
  lastSeenAt: number
}

/** One native-app push token row (the mobile FCM transport). The token is the identity - FCM
 *  mints one per app install - and, like a Web Push subscription, a row is a CAPABILITY (the
 *  payload preview leaves the tailnet): prunable, never durable identity. */
export interface ChatDeviceToken {
  token: string
  userId: string
  platform: string
  createdAt: number
  lastSeenAt: number
}

/**
 * One row of the bell's MENTION stratum, as `ChatStore.mentionsFor` returns it: the mention join
 * with its message and room. `seenAt` null = unseen; `createdAt` is the message's order key (the
 * mention row carries a copy, written in the same transaction). The body comes from `messages` at
 * read time, and the join is what makes a deleted message's mention vanish with it.
 */
export interface ChatMentionRow {
  messageId: string
  roomId: string
  roomSlug: string
  /** So the bell can title a DM by its sender rather than by a slug nobody typed (`#dm:a:b`). */
  roomKind: ChatRoomKind
  senderId: string
  senderName: string
  body: string
  createdAt: number
  seenAt: number | null
}

/**
 * One row of the bell's RECENT-MESSAGES stratum, as `ChatStore.recentMessagesFor` returns it:
 * traffic in every room the user can READ (every channel, plus their own DMs - since migration
 * 015 there is no subscription to narrow it by), minus their own words. `unread` is the sidebar's
 * rule applied per row: `createdAt` past the viewer's read pointer, and false in a room they hold
 * no pointer for, exactly as the badge there reads 0.
 */
export interface ChatRecentMessageRow {
  messageId: string
  roomId: string
  roomSlug: string
  /** See `ChatMentionRow.roomKind`. */
  roomKind: ChatRoomKind
  senderId: string
  senderName: string
  body: string
  createdAt: number
  unread: boolean
}

/** One thread, fully expanded: the root plus every reply, oldest-first. */
export interface ChatThreadPage {
  /** The root message. Carries its own `thread` summary, so a client that opened a thread by id
   *  alone (a deep link, a notification) has everything the collapsed row would have shown. */
  parent: ChatMessage
  /** Oldest-first. Every reply that exists: a deleted one is gone, not a tombstone. */
  replies: ChatMessage[]
}

export interface ChatHistoryPage {
  /** Oldest-first, so a client can append/prepend without sorting. */
  messages: ChatMessage[]
  /** The `createdAt` to pass as `before` for the next OLDER page; null when this page reaches the
   *  start of the room. A cursor is a number, not a row: it stays valid when the message it was
   *  taken from is deleted, because paging asks for `createdAt < before` and nothing else. */
  nextCursor: number | null
  /** The room's head - see `ChatRoomSummary.headAt`. */
  headAt: number
}

// Typed refusals so the HTTP surface can map them to real status codes (400/403/404/409) instead
// of a generic 500, while core stays free of Nest.

export class ChatNotFoundError extends Error {}
export class ChatAccessError extends Error {}
export class ChatConflictError extends Error {}
/** The input itself is wrong, whoever sent it and whatever they may do here - a 400, not a 409.
 *  Today: an emoji outside the reaction palette (Track 10), a DM opened with yourself, and the one
 *  room operation a DM does not have (`updateRoom` - Track 14): naming a DM there is a wrong input
 *  regardless of who the caller is or what state the room is in, which is what separates it from
 *  a 403 (who you are) and a 409 (what state it is in). */
export class ChatValidationError extends Error {}
