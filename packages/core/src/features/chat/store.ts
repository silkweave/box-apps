import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { Statement } from 'better-sqlite3'
import { chatPath } from './paths.js'
import { systemUserId } from '../../box-config.js'
import { blobPath, deleteBlob, deleteStaleTmp, listBlobs, sha256Hex, writeBlob } from './blobs.js'
import { emitChatEvent } from './bus.js'
import { CHAT_MIGRATIONS, migrateChat, type ChatMigration } from './migrations.js'
import { groupReactions, isReactionEmoji } from './reactions.js'
import {
  ChatAccessError,
  ChatConflictError,
  ChatNotFoundError,
  ChatValidationError,
  type ChatAttachment,
  type ChatEvent,
  type ChatHistoryPage,
  type ChatMentionRow,
  type ChatAgentSession,
  type ChatMessage,
  type ChatMessageDeletion,
  type ChatMessageMeta,
  type ChatReactionGroup,
  type ChatReadState,
  type ChatRecentMessageRow,
  type ChatRoom,
  type ChatRoomDeletion,
  type ChatRoomIcon,
  CHAT_ROOM_NAME_MAX,
  type ChatRoomKind,
  type ChatRoomSummary,
  type ChatDeviceToken,
  type ChatPushSubscription,
  isChatRoomIcon,
  type ChatSender,
  type ChatThreadPage,
  type ChatThreadSummary
} from './types.js'

interface PushRow {
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  user_agent: string | null
  created_at: number
  last_seen_at: number
}

const toPushSubscription = (row: PushRow): ChatPushSubscription => ({
  userId: row.user_id,
  endpoint: row.endpoint,
  p256dh: row.p256dh,
  auth: row.auth,
  userAgent: row.user_agent,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at
})

interface DeviceTokenRow {
  token: string
  user_id: string
  platform: string
  created_at: number
  last_seen_at: number
}

const toDeviceToken = (row: DeviceTokenRow): ChatDeviceToken => ({
  token: row.token,
  userId: row.user_id,
  platform: row.platform,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at
})

const HISTORY_DEFAULT_LIMIT = 50
const HISTORY_MAX_LIMIT = 200

/**
 * How long an un-posted upload lives before the sweeper reaps it (Track 11's "orphan window").
 * 24 hours, not minutes: the cost of sweeping too EARLY is a refused post for someone whose
 * composer sat open overnight (rude, and it looks like data loss), the cost of sweeping LATE is
 * a little disk - and disk is the cheap side of that trade. During the window the orphan is
 * readable only by its uploader, so a longer window widens nothing security-relevant.
 */
/** Hard cap on one thread's reply list. A thread past this is a channel that should have been
 *  one; the cap keeps a single response bounded rather than pretending to paginate. */
export const THREAD_MAX_REPLIES = 500

/** How many distinct repliers the collapsed row's avatar cluster can name. */
export const THREAD_PARTICIPANT_LIMIT = 8

export const ATTACHMENT_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000

interface AttachmentRow {
  id: string
  message_id: string | null
  uploader_id: string
  filename: string
  mime: string
  bytes: number
  sha256: string
  created_at: number
}

/** attachmentByIdStmt's shape: the row plus its message's room (null for an orphan). */
interface AttachmentJoinRow extends AttachmentRow {
  room_id: string | null
}

const toAttachment = (row: AttachmentRow): ChatAttachment => ({
  id: row.id,
  messageId: row.message_id,
  uploaderId: row.uploader_id,
  filename: row.filename,
  mime: row.mime,
  bytes: row.bytes,
  sha256: row.sha256,
  createdAt: row.created_at
})

/** How many pre-migration snapshots to keep beside chat.db. See pruneMigrationSnapshots. */
const SNAPSHOT_RETENTION = 2

/**
 * The pre-migration snapshot (chat Track 12). Before an EXISTING database runs a pending
 * migration, take a consistent local copy beside the file: `chat.db.pre-<first-pending>.bak`.
 * VACUUM INTO, never a file copy - under WAL a copied .db opens perfectly clean and has silently
 * lost every commit still in the log. A fresh database (no ledger rows yet) is skipped, so dev
 * boots and tests stay clean; an existing snapshot for the same boundary is kept rather than
 * rewritten - it records the state BEFORE the first attempt, which is the one a restore wants.
 */
function snapshotBeforeMigration(db: Database.Database, file: string, migrations: readonly ChatMigration[]): void {
  const ledger = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get()
  if (!ledger) return
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((row) => row.name)
  )
  if (applied.size === 0) return
  const pending = migrations.find((migration) => !applied.has(migration.name))
  if (!pending) return
  const snapshot = `${file}.pre-${pending.name}.bak`
  if (existsSync(snapshot)) return
  db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`)
  pruneMigrationSnapshots(file)
}

/**
 * Keep only the newest {@link SNAPSHOT_RETENTION} pre-migration snapshots beside the database.
 * Without this they accumulate one per migration boundary forever - by 2026-09-10 both dev and the
 * mini were carrying a dozen apiece, and the warehouse equivalents beside them turned `data/` into
 * half a gigabyte of files nothing would ever read. A snapshot is a same-day undo for the migration
 * that just ran; anything older is covered by the nightly GCS backup (docs/WAREHOUSE.md § Backup).
 */
function pruneMigrationSnapshots(file: string): void {
  const directory = dirname(file)
  const prefix = `${basename(file)}.pre-`
  const stale = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.bak'))
    .map((name) => join(directory, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(SNAPSHOT_RETENTION)
  for (const path of stale) rmSync(path, { force: true })
}

/**
 * The one place chat.db is opened, so the pragmas and the migration chain can never disagree
 * between the server, tests and any future script. Chat is SQLite, not DuckDB, on purpose: many
 * tiny writes at interactive latency plus point reads are exactly what the warehouse's
 * single-writer ephemeral-connection design is wrong for - see docs/BACKLOG.md § Chat. Unlike the
 * warehouse this is a LONG-LIVED connection, which is the correct shape for SQLite under WAL.
 */
function openChatDatabase(path: string, migrations: readonly ChatMigration[]): Database.Database {
  const file = resolve(path)
  mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file)

  // WAL lets history reads proceed while a message insert is in flight. NB for backups: recent
  // commits live in chat.db-wal, so back up with VACUUM INTO, never cp (docs/BACKLOG.md § Chat).
  db.pragma('journal_mode = WAL')
  // NORMAL is durable enough under WAL: a crash can lose the last commit, a power cut cannot
  // corrupt the file. Full fsync per commit costs roughly 10x on the write path.
  db.pragma('synchronous = NORMAL')
  // A second connection (a script, a test with two stores) must wait for a writer, not throw.
  db.pragma('busy_timeout = 5000')

  // OFF while migrating: SQLite's supported table-rebuild procedure requires it. ON afterwards,
  // per connection - without it every REFERENCES clause in the schema is decorative.
  db.pragma('foreign_keys = OFF')
  snapshotBeforeMigration(db, file, migrations)
  migrateChat(db, migrations)
  db.pragma('foreign_keys = ON')

  const violations = db.pragma('foreign_key_check') as unknown[]
  if (violations.length > 0) {
    throw new Error(`chat database at ${file} has ${violations.length} foreign key violation(s) after migration`)
  }

  return db
}

interface RoomRow {
  id: string
  slug: string
  topic: string | null
  /** Migration 012. 'room' on every row written before it. Since 015 it is also the whole access
   *  rule: a channel is everybody's, a DM is its pair's. */
  kind: ChatRoomKind
  /** Migration 013. NULL on every row written before it, and on any room nobody has styled. */
  icon: ChatRoomIcon | null
  /** Migration 014. NULL means the slug IS the display name. */
  name: string | null
  /** The order-key guard (migration 010): the newest key this room has issued. See issueKeyStmt. */
  head_at: number
  created_by: string | null
  created_at: number
}

interface SummaryRow extends RoomRow {
  /** NULL when the viewer holds no room_members row here - they have never read, posted in or
   *  been mentioned in the room. */
  last_read_at: number | null
  unread: number
  /** DM only: the member who is not the viewer. NULL on a named room, and NULL when the viewer
   *  holds no member row - which for a readable DM is only ever the agent as a GUEST (see
   *  `isDirectGuest`), and a guest has no peer. See VISIBLE_SELECT. */
  peer: string | null
  /** The newest surviving message in the room, or NULL in an empty one. */
  last_sender_id: string | null
  last_sender_name: string | null
  last_body: string | null
  last_at: number | null
}

/** One `room_members` row by user, as `deleteRoom` reads a DM's pair for the `room.deleted`
 *  audience. The only reader of the table by ROOM: everything else reads it by (room, viewer). */
interface MemberRow {
  user_id: string
}

interface MessageRow {
  id: string
  room_id: string
  sender_id: string
  sender_name: string
  body: string
  /** The order key - issued by the room's guard, not read off the clock. See issueKeyStmt. */
  created_at: number
  edited_at: number | null
  /** Migration 008. NULL on every ordinary message and on every row written before it. */
  meta: string | null
  /** Migration 009. NULL on a root message and on every row written before it. */
  parent_id: string | null
}

interface EventRow {
  id: number
  room_id: string
  type: string
  payload: string
  created_at: number
}

interface MentionJoinRow {
  message_id: string
  room_id: string
  room_slug: string
  room_kind: ChatRoomKind
  sender_id: string
  sender_name: string
  body: string
  created_at: number
  seen_at: number | null
}

interface RecentJoinRow {
  message_id: string
  room_id: string
  room_slug: string
  room_kind: ChatRoomKind
  sender_id: string
  sender_name: string
  body: string
  created_at: number
  /** 0/1 from SQLite - `messages.created_at > room_members.last_read_at`. */
  unread: number
}

function toRoom(row: RoomRow): ChatRoom {
  return {
    id: row.id,
    slug: row.slug,
    topic: row.topic,
    kind: row.kind,
    icon: row.icon,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at
  }
}

function toSummary(row: SummaryRow): ChatRoomSummary {
  return {
    ...toRoom(row),
    headAt: row.head_at,
    // Null, not a fabricated head: someone who has never opened the room HAS no pointer, and
    // inventing one would make the client's unread divider compute a position for it.
    lastReadAt: row.last_read_at,
    unread: row.unread,
    peer: row.peer,
    lastMessage:
      row.last_at === null || row.last_sender_id === null
        ? null
        : {
            senderId: row.last_sender_id,
            senderName: row.last_sender_name ?? row.last_sender_id,
            preview: previewOf(row.last_body ?? ''),
            at: row.last_at
          }
  }
}

/**
 * How much of a body a room LIST may carry. Short on purpose, and the same reasoning as the push
 * payload's own cap in `notifications/delivery.ts`: a preview is a hint about a conversation, not a
 * copy of it, and a sidebar that ships every room's newest message in full is a payload that grows
 * with how talkative the team is. An empty string (an attachment-only message) stays empty - the
 * client decides what a wordless message looks like.
 */
const PREVIEW_CHARS = 140

function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS).trimEnd()}…`
}

function toMessage(row: MessageRow): ChatMessage {
  const message: ChatMessage = {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    body: row.body,
    createdAt: row.created_at,
    editedAt: row.edited_at
  }
  // Assigned only when present, so `meta` is ABSENT (not null) on an ordinary message - the same
  // absence a pre-008 row, a stored pre-008 outbox payload and an unaware client all agree on.
  const meta = parseMeta(row.meta)
  if (meta !== null) message.meta = meta
  // Same rule for the thread parent (009): absent on a root, so a flat client is unaffected.
  if (row.parent_id !== null) message.parentId = row.parent_id
  return message
}

/**
 * Parse a `messages.meta` cell, tolerating anything that is not the shape we wrote.
 *
 * Never throws. A row whose JSON is corrupt (a hand-edit, a future version's shape) degrades to a
 * message with no meta, which every client already renders correctly - the card's body is written
 * to stand on its own precisely so that this degradation is invisible. Throwing here would take
 * out an entire history page over one bad cell.
 */
function parseMeta(raw: string | null): ChatMessageMeta | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const kind = (parsed as { kind?: unknown }).kind
    return typeof kind === 'string' && META_KINDS.has(kind) ? (parsed as ChatMessageMeta) : null
  } catch {
    return null
  }
}

/** Every `meta.kind` this version knows how to render. A row written by a NEWER version with a kind
 *  not listed here degrades to a plain message, exactly like a corrupt cell - see `parseMeta`. */
const META_KINDS: ReadonlySet<string> = new Set<ChatMessageMeta['kind']>(['approval', 'chat-op', 'agent-turn'])

function toEvent(row: EventRow): ChatEvent {
  return {
    id: row.id,
    roomId: row.room_id,
    type: row.type,
    payload: JSON.parse(row.payload) as ChatMessage,
    at: row.created_at
  }
}

function toMentionRow(row: MentionJoinRow): ChatMentionRow {
  return {
    messageId: row.message_id,
    roomId: row.room_id,
    roomSlug: row.room_slug,
    roomKind: row.room_kind,
    senderId: row.sender_id,
    senderName: row.sender_name,
    body: row.body,
    createdAt: row.created_at,
    seenAt: row.seen_at
  }
}

function toRecentRow(row: RecentJoinRow): ChatRecentMessageRow {
  return {
    messageId: row.message_id,
    roomId: row.room_id,
    roomSlug: row.room_slug,
    roomKind: row.room_kind,
    senderId: row.sender_id,
    senderName: row.sender_name,
    body: row.body,
    createdAt: row.created_at,
    unread: row.unread === 1
  }
}

/**
 * The `message.deleted` payload: the row's IDENTITY and position, none of its content. `body` is
 * emptied and `meta`/`attachments` are not copied, because the frame's job is to say which message
 * went (and, through `parentId`, which thread to fix up), never to carry what it said one last time
 * across the wire - deletion wipes the text, and the frame must not be the place it survives.
 */
function toDeletedFrame(row: MessageRow): ChatMessage {
  const frame: ChatMessage = {
    id: row.id,
    roomId: row.room_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    body: '',
    createdAt: row.created_at,
    editedAt: row.edited_at
  }
  if (row.parent_id !== null) frame.parentId = row.parent_id
  return frame
}

interface AgentSessionRow {
  room_id: string
  worker_session_id: string
  streaming_message_id: string | null
  last_worker_seq: number
  turn_started_at: number | null
  turns_this_hour: number
  window_started_at: number
  updated_at: number
}

/** Named once so the point read and the recovery sweep can never drift apart. */
const AGENT_SESSION_COLUMNS = `room_id, worker_session_id, streaming_message_id, last_worker_seq,
         turn_started_at, turns_this_hour, window_started_at, updated_at`

function toAgentSession(row: AgentSessionRow): ChatAgentSession {
  return {
    roomId: row.room_id,
    workerSessionId: row.worker_session_id,
    streamingMessageId: row.streaming_message_id,
    lastWorkerSeq: row.last_worker_seq,
    turnStartedAt: row.turn_started_at,
    turnsThisHour: row.turns_this_hour,
    windowStartedAt: row.window_started_at,
    updatedAt: row.updated_at
  }
}

/**
 * THE readability rule, in its SQL form: a room is readable by a principal unless it is a direct
 * message, and a DM is readable by whoever holds one of its two member rows. Keyed on `kind`
 * alone since migration 015 - every channel is everybody's, and `room_members` is no longer an
 * ACL for one; for a DM it still is, and that is the one place the table means "who is in here".
 * Its TS twin is `ChatStore.requireReadableRoom`. If you are branching on `kind === 'dm'` to
 * decide who may READ anywhere else, you are creating drift: use one of these two.
 *
 * Every statement that embeds it binds the viewer into a LEFT JOIN on `room_members` aliased `m`,
 * and the rooms table aliased `r`.
 *
 * The agent's DM-guest exception (2026-09-04, see `isDirectGuest`) is deliberately NOT in this SQL
 * form. Every statement that embeds the predicate is a LIST, a REPLAY or the BELL for a viewer,
 * and the guest was asked into one room by name: it reads and posts there by slug and holds no
 * feed. The exception lives in the two TS gates only (`requireReadableRoom`, `canReadRoom`), which
 * makes this form strictly NARROWER than its twin: drift in the dangerous direction (SQL admitting
 * someone TS would refuse) is impossible.
 */
const READABLE_PREDICATE = `(r.kind <> 'dm' OR m.user_id IS NOT NULL)`

// One-room-and-viewer summary select, reused by the list and single variants. The join is LEFT
// (a viewer who has never opened the room has no row), so every pointer-derived column is nullable.
//
// Unread is a COUNT over surviving messages past the viewer's pointer - since migration 010, and
// deliberately no longer the subtraction `next_seq - 1 - last_read_seq` it used to be. The
// subtraction was what made a hard delete impossible: it counted every key ever issued, so a
// deleted message stayed owed forever. A count answers the question the badge actually asks (how
// many messages are there that I have not read) and shrinks when one of them is deleted. It is
// a covering range scan of `messages_room_created` (room_id = ? AND created_at > ?), asserted by
// test with EXPLAIN QUERY PLAN, so it costs one index walk per room per sidebar read.
//
// Still 0 by decree when there is no row: a person who has never opened a room is not badged for
// its entire history. Their first markRead writes the row (see markReadStmt), and from then on
// the count is real.
//
// `peer` (Track 14) is the DM's other member, read off room_members rather than parsed out of the
// slug: membership is the truth the slug merely encodes, and the pair walk is a two-row range on
// the table's own primary key. It compares against `m.user_id` - the viewer's OWN member row -
// instead of binding the viewer a second time, so the statement keeps its single positional
// parameter and the callers' bind order stays as it was. A viewer with no member row gets NULL
// (`<> NULL` matches nothing), which is also the right answer: a DM's pair are the only two who
// ever see the row at all.
//
// `lastMessage` (2026-09-04) is the row a list needs to say what a conversation is ABOUT without
// opening it - a DM has no topic, so without it every row reads as a bare name. It is joined by id
// rather than read as three correlated subqueries: one ordered lookup on `messages_room_created`
// picks the id, and the join fetches that single row by primary key. The body is truncated in TS
// rather than in SQL, so the cap lives next to the constant that names it.
//
// It does NOT depend on the viewer's row, unlike `unread`: a preview is a property of the room's
// content, and anyone who can see the row can open the room and read every message in it.
//
// Exported for exactly one reader: the test that pins the query plan of the count above.
export const VISIBLE_SELECT = `
  SELECT r.id, r.slug, r.name, r.topic, r.kind, r.icon, r.head_at, r.created_by, r.created_at,
         m.last_read_at,
         lm.sender_id AS last_sender_id, lm.sender_name AS last_sender_name,
         lm.body AS last_body, lm.created_at AS last_at,
         CASE WHEN m.user_id IS NULL THEN 0
              ELSE (SELECT COUNT(*) FROM messages msg
                     WHERE msg.room_id = r.id AND msg.created_at > m.last_read_at) END AS unread,
         CASE WHEN r.kind = 'dm'
              THEN (SELECT p.user_id FROM room_members p
                     WHERE p.room_id = r.id AND p.user_id <> m.user_id) END AS peer
    FROM rooms r LEFT JOIN room_members m ON m.room_id = r.id AND m.user_id = ?
    LEFT JOIN messages lm ON lm.id = (SELECT x.id FROM messages x
                                       WHERE x.room_id = r.id
                                       ORDER BY x.created_at DESC LIMIT 1)`

/**
 * The reserved slug namespace for direct messages, and the derivation. `dm:<a>:<b>` with the two
 * ids SORTED, so that (a, b) and (b, a) name the same room - the whole idempotency of "open a DM
 * with Dan" rests on this one line, and the UNIQUE index on `rooms.slug` turns it into a
 * constraint the database enforces rather than a check a caller could skip.
 *
 * ':' is the separator because it is the one character that can appear in neither operand: user
 * ids are `userSlug` output (`[a-z0-9-]`), and the named-room slug grammar is the same alphabet -
 * so the derivation is unambiguous and no named room can ever be created at a DM's address.
 * `openDirect` refuses an id that carries a ':' anyway, since the argument above is only as good
 * as the alphabet it assumes.
 */
export const DIRECT_SLUG_PREFIX = 'dm:'

/**
 * Refuse an icon name that is not in the curated list (chat/types.ts). Validated in the STORE and
 * not only in the controller, because the column has no CHECK - so this function is the only thing
 * standing between a typo and a room every client renders as a blank square.
 */
function assertRoomIcon(icon: string | null): ChatRoomIcon | null {
  if (icon === null) return null
  if (!isChatRoomIcon(icon)) throw new ChatValidationError(`"${icon}" is not a known room icon`)
  return icon
}

/**
 * Clean an incoming display name, or refuse it.
 *
 * Free-form is not the same as unchecked. Trimmed (leading space is invisible and sorts wrong),
 * control characters stripped (a newline in a sidebar row breaks the row, and a bidi override
 * rewrites the label around it), length-capped, and an empty result collapses to NULL - which is
 * how "clear it" arrives from a client that can only send a string.
 */
function normalizeRoomName(name: string | null): string | null {
  if (name === null) return null
  // eslint-disable-next-line no-control-regex -- matching control characters IS the sanitization
  const clean = name.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e]/g, '').trim()
  if (clean === '') return null
  if (clean.length > CHAT_ROOM_NAME_MAX) {
    throw new ChatValidationError(`a room name is at most ${CHAT_ROOM_NAME_MAX} characters`)
  }
  return clean
}

export function directSlug(a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a]
  return `${DIRECT_SLUG_PREFIX}${first}:${second}`
}

/** The store-side half of the DM namespace rule: a named room may not be created at, or renamed
 *  into, an address `directSlug` could derive. `ChatValidationError` - the slug is wrong for any
 *  caller. The controller's slug regex makes this unreachable over the API; it exists for the
 *  script that does not go through the controller. */
function assertNotDirectSlug(slug: string): void {
  if (slug.startsWith(DIRECT_SLUG_PREFIX)) {
    throw new ChatValidationError(`"${DIRECT_SLUG_PREFIX}" is reserved for direct messages - open one with openDirect`)
  }
}

export class ChatStore {
  readonly db: Database.Database
  /**
   * Where attachment BLOBS live: `chat-uploads/` beside the database file itself, so the store
   * that owns the rows also owns the bytes they refcount - production lands at
   * `<instance>/chat-uploads/` (gitignored in the Box instance, like chat.db), and a test's
   * tmp-dir store gets its own isolated blob dir for free. Derived, not configured: a second
   * knob could point rows and blobs at different places, which is the one state GC cannot
   * reason about.
   */
  readonly uploadsDir: string

  private readonly roomBySlugStmt: Statement
  private readonly memberRowStmt: Statement
  private readonly addMemberStmt: Statement
  private readonly insertRoomStmt: Statement
  private readonly updateRoomStmt: Statement
  private readonly deleteRoomStmt: Statement
  private readonly membersOfStmt: Statement
  private readonly messageCountStmt: Statement
  private readonly attachmentShasByRoomStmt: Statement
  private readonly attachmentsDeleteByRoomStmt: Statement
  private readonly deleteDismissalsForRoomStmt: Statement
  private readonly roomsVisibleStmt: Statement
  private readonly summaryStmt: Statement
  private readonly canReadRoomStmt: Statement
  private readonly issueKeyStmt: Statement
  private readonly insertMessageStmt: Statement
  private readonly insertEventStmt: Statement
  private readonly pageLatestStmt: Statement
  private readonly pageBeforeStmt: Statement
  private readonly pageLatestRootsStmt: Statement
  private readonly pageBeforeRootsStmt: Statement
  private readonly threadSummaryStmt: Statement
  private readonly threadParticipantsStmt: Statement
  private readonly threadRepliesStmt: Statement
  private readonly threadRepliesAllStmt: Statement
  private readonly threadHasSenderStmt: Statement
  private readonly markReadStmt: Statement
  private readonly messageByIdStmt: Statement
  private readonly editMessageStmt: Statement
  private readonly deleteMessageRowStmt: Statement
  private readonly deleteEventStmt: Statement
  private readonly deleteDismissalsForMessageStmt: Statement
  private readonly eventsAfterStmt: Statement
  private readonly latestEventIdStmt: Statement
  private readonly addMentionedMemberStmt: Statement
  private readonly insertMentionStmt: Statement
  private readonly mentionsForStmt: Statement
  private readonly recentForStmt: Statement
  private readonly markMentionSeenOneStmt: Statement
  private readonly markMentionSeenAllStmt: Statement
  private readonly unseenMentionCountStmt: Statement
  private readonly watermarkGetStmt: Statement
  private readonly dismissStmt: Statement
  private readonly dismissedStmt: Statement
  private readonly dismissPruneStmt: Statement
  private readonly watermarkSetStmt: Statement
  private readonly pushUpsertStmt: Statement
  private readonly pushDeleteOwnStmt: Statement
  private readonly pushDeleteStmt: Statement
  private readonly pushForUserStmt: Statement
  private readonly pushSeenStmt: Statement
  private readonly pushPruneStmt: Statement
  private readonly deviceUpsertStmt: Statement
  private readonly deviceDeleteOwnStmt: Statement
  private readonly deviceDeleteStmt: Statement
  private readonly deviceForUserStmt: Statement
  private readonly deviceSeenStmt: Statement
  private readonly devicePruneStmt: Statement
  private readonly roomSlugByIdStmt: Statement
  private readonly directPeerStmt: Statement
  private readonly directGuestStmt: Statement
  private readonly attachmentInsertStmt: Statement
  private readonly attachmentByIdStmt: Statement
  private readonly attachmentsByMessageStmt: Statement
  private readonly attachmentClaimStmt: Statement
  private readonly attachmentRefcountStmt: Statement
  private readonly attachmentOrphansExpiredStmt: Statement
  private readonly attachmentDeleteStmt: Statement
  private readonly attachmentsDeleteByMessageStmt: Statement
  private readonly agentSessionGetStmt: Statement
  private readonly agentSessionUpsertStmt: Statement
  private readonly agentSessionDeleteStmt: Statement
  private readonly agentSessionsStreamingStmt: Statement
  private readonly pendingCardsStmt: Statement
  private readonly checkpointBodyStmt: Statement
  private readonly checkpointCardStmt: Statement
  private readonly agentBodyStmt: Statement
  private readonly reactionsByMessageStmt: Statement
  private readonly reactionAddStmt: Statement
  private readonly reactionRemoveStmt: Statement

  constructor(path: string, migrations: readonly ChatMigration[] = CHAT_MIGRATIONS) {
    this.db = openChatDatabase(path, migrations)
    this.uploadsDir = join(dirname(resolve(path)), 'chat-uploads')

    this.roomBySlugStmt = this.db.prepare(
      'SELECT id, slug, name, topic, kind, icon, head_at, created_by, created_at FROM rooms WHERE slug = ?'
    )
    // The ONE read of room_members as an ACL: is this user one of a DM's pair? Every other read
    // of the table is for a pointer. See `isDirectMember`.
    this.memberRowStmt = this.db.prepare('SELECT 1 AS present FROM room_members WHERE room_id = ? AND user_id = ?')
    // The head-seeded pointer row: written by `post` (after the key is issued, so the poster's own
    // words are born read), by `createRoom` for its creator and by `openDirect` for a DM's pair.
    // The seed is the room's CURRENT HEAD, read from the guard inside the caller's transaction -
    // seeding at 0 would badge a first-time poster with the room's entire history. OR IGNORE is
    // the other half of the rule: an EXISTING pointer is never touched by posting - only markRead
    // moves it. Idempotent, so the second post is a no-op.
    this.addMemberStmt = this.db.prepare(
      `INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at, last_read_at)
       VALUES (@roomId, @userId, @now, (SELECT head_at FROM rooms WHERE id = @roomId))`
    )
    this.insertRoomStmt = this.db.prepare(
      `INSERT INTO rooms (id, slug, name, topic, kind, icon, created_by, created_at, updated_at)
       VALUES (@id, @slug, @name, @topic, @kind, @icon, @createdBy, @now, @now)`
    )
    // Reshape a room in place. `head_at` and `created_*` are deliberately NOT settable: the guard
    // is the room's identity as far as every cursor and pointer in the system is concerned, and
    // rewinding it would let a new message be issued a key somebody already holds as "read" (the
    // same trap the issueKeyStmt comment describes, reached from the other side).
    this.updateRoomStmt = this.db.prepare(
      `UPDATE rooms SET slug = @slug, name = @name, topic = @topic, icon = @icon, updated_at = @now
        WHERE id = @id`
    )
    // The purge. Everything hanging off rooms(id) is declared ON DELETE CASCADE (messages, events,
    // mentions, room_members), so this one statement takes them all - but ONLY those: attachments
    // reference messages(id) with no cascade, and agent_sessions references rooms(id) with none
    // either, so both are deleted by hand FIRST or this fails the foreign-key check. That FK gap
    // is a feature here: it makes forgetting the blob GC a loud error rather than a silent leak.
    this.deleteRoomStmt = this.db.prepare('DELETE FROM rooms WHERE id = ?')
    // A DM's pair, captured by `deleteRoom` before the row goes - the `room.deleted` audience.
    this.membersOfStmt = this.db.prepare('SELECT user_id FROM room_members WHERE room_id = ? ORDER BY user_id')
    this.messageCountStmt = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id = ?')
    // Collected BEFORE the delete: after it there is no message row left to join through, and the
    // blobs would be stranded on disk with no row anywhere pointing at them.
    this.attachmentShasByRoomStmt = this.db.prepare(
      'SELECT a.sha256 AS sha256 FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.room_id = ?'
    )
    this.attachmentsDeleteByRoomStmt = this.db.prepare(
      'DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE room_id = ?)'
    )
    // Bell hygiene, as deleteMessage does per message: a dismissal tombstone for an item that can
    // never appear again is dead weight, and nothing but the clear watermark ever removes one.
    // Run BEFORE the room delete - the message ids come from rows the cascade is about to take.
    // Migration 015's purge prunes the same way, so the two agree table for table.
    this.deleteDismissalsForRoomStmt = this.db.prepare(
      `DELETE FROM notification_dismissals
        WHERE item_id IN (SELECT 'mention:' || id FROM messages WHERE room_id = ?)
           OR item_id IN (SELECT 'message:' || id FROM messages WHERE room_id = ?)`
    )

    // Both take the viewer id FIRST (it is bound into VISIBLE_SELECT's LEFT JOIN), then their
    // own filter. Getting that order wrong silently returns another user's read state.
    this.roomsVisibleStmt = this.db.prepare(`${VISIBLE_SELECT} WHERE ${READABLE_PREDICATE} ORDER BY r.slug`)
    this.summaryStmt = this.db.prepare(`${VISIBLE_SELECT} WHERE r.id = ?`)
    this.canReadRoomStmt = this.db.prepare(
      `SELECT 1 FROM rooms r LEFT JOIN room_members m ON m.room_id = r.id AND m.user_id = ?
        WHERE r.id = ? AND ${READABLE_PREDICATE}`
    )

    // THE ORDER-KEY ISSUER (migration 010). One read-modify-write, inside the posting transaction,
    // so issuing is atomic by construction and a rollback takes the bump back with it.
    //
    // The key is `created_at`, and it is ISSUED rather than observed: `MAX(head_at + 1, now)`.
    // In the common case the guard is behind the clock and the key is simply `now`. Two posts in
    // the same millisecond get `now` and `now + 1`. A clock that has stepped BACKWARDS (an NTP
    // correction, a VM resume) finds the guard ahead of it and issues `head_at + 1`, so the order
    // survives and the uniqueness survives - at the price that keys issued in that window read
    // ahead of real time by up to the size of the step. That is the trade chosen in place of a
    // counter beside a timestamp: one time-shaped key, and `createdAt` on the wire is it.
    //
    // DB-side, not `Math.max(Date.now(), last + 1)` in this process: a second ChatStore on the
    // same file (a script beside the server - the tests document that shape) would hold its own
    // idea of `last`, and the two would happily issue the same key. The row is the only place
    // both can see.
    //
    // Rejected, as MAX(seq) + 1 was before it: seeding the guard from MAX(created_at) over
    // surviving rows. Deleting the newest message would rewind the guard, and the next message
    // could be issued a key somebody already holds as their read pointer - born read, invisible.
    // The guard only ever moves forward, so a deleted message's key is retired, never reused.
    this.issueKeyStmt = this.db.prepare(
      'UPDATE rooms SET head_at = MAX(head_at + 1, ?) WHERE id = ? RETURNING head_at'
    )
    this.insertMessageStmt = this.db.prepare(
      `INSERT INTO messages (id, room_id, sender_id, sender_name, body, created_at, edited_at, meta, parent_id)
       VALUES (@id, @roomId, @senderId, @senderName, @body, @createdAt, @editedAt, @meta, @parentId)`
    )
    // The outbox row is keyed by the message's own created_at (UNIQUE per room, like the message),
    // which is what lets deleteMessage remove it with a point read instead of a payload scan.
    this.insertEventStmt = this.db.prepare(
      `INSERT INTO events (room_id, type, payload, actor_id, created_at)
       VALUES (@roomId, @type, @payload, @actorId, @createdAt)`
    )

    // Both walk the (room_id, created_at) unique index backwards (newest first); history()
    // reverses the page into the oldest-first response order. The cursor is a bare `created_at`
    // compared with `<`, so it stays valid when the message it was taken from is deleted.
    this.pageLatestStmt = this.db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT ?')
    this.pageBeforeStmt = this.db.prepare(
      'SELECT * FROM messages WHERE room_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?'
    )

    // Threads (009). The timeline is ROOTS ONLY when a client asks for the grouped shape; the
    // flat statements above stay exactly as they were, because the agent, the MCP surface and any
    // client that never learned about threads must keep seeing every message in key order.
    this.pageLatestRootsStmt = this.db.prepare(
      'SELECT * FROM messages WHERE room_id = ? AND parent_id IS NULL ORDER BY created_at DESC LIMIT ?'
    )
    this.pageBeforeRootsStmt = this.db.prepare(
      'SELECT * FROM messages WHERE room_id = ? AND parent_id IS NULL AND created_at < ? ORDER BY created_at DESC LIMIT ?'
    )
    // No deleted-state filter anywhere in the thread reads any more: a deleted reply is a row
    // that does not exist, so the summary, the participants and the list agree by construction.
    this.threadSummaryStmt = this.db.prepare(
      'SELECT COUNT(*) AS reply_count, MAX(created_at) AS last_at FROM messages WHERE parent_id = ?'
    )
    this.threadParticipantsStmt = this.db.prepare(
      'SELECT sender_id FROM messages WHERE parent_id = ? GROUP BY sender_id ORDER BY MIN(created_at) LIMIT ?'
    )
    this.threadRepliesStmt = this.db.prepare('SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at LIMIT ?')
    // Uncapped, for the cascade: THREAD_MAX_REPLIES bounds what a reader is shown, not what a
    // thread can hold, and a delete that stopped at the cap would strand replies under a root
    // that no longer exists (which the parent_id constraint would refuse anyway, loudly).
    this.threadRepliesAllStmt = this.db.prepare('SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at')
    this.threadHasSenderStmt = this.db.prepare(
      `SELECT 1 AS hit FROM messages
        WHERE sender_id = @senderId AND (id = @rootId OR parent_id = @rootId)
        LIMIT 1`
    )

    // The read pointer, as an UPSERT (migration 015): a first markRead in a room CREATES the row,
    // seeded at the acked key, and a later one advances it. Before 015 a missing row was a
    // refusal ("join first"), because the row was also a subscription and a scroll must not
    // subscribe anybody; with every channel everybody's there is nothing left to opt into, and
    // the row is simply where this person's pointer lives. Both writes are clamped to the room's
    // head (a client cannot read ahead of what has been issued) and the update is monotonic (a
    // stale tab acking an old key must not regress the newer one) - `excluded.last_read_at` is
    // the already-clamped seed, so one MIN serves both arms.
    this.markReadStmt = this.db.prepare(
      `INSERT INTO room_members (room_id, user_id, joined_at, last_read_at)
       VALUES (@roomId, @userId, @now, MIN(@at, (SELECT head_at FROM rooms WHERE id = @roomId)))
       ON CONFLICT (room_id, user_id) DO UPDATE
          SET last_read_at = MAX(room_members.last_read_at, excluded.last_read_at)
       RETURNING last_read_at`
    )

    // Edit is an UPDATE on the existing row and nothing else: no key is issued and nothing is
    // written to `events`, because an outbox row IS a `message.created` to every client (the chat
    // PRD's Track 2 trap - a phantom message in every timeline and every badge). The edit fans out
    // over the ephemeral bus, and a client that misses one converges on its next history fetch.
    this.messageByIdStmt = this.db.prepare('SELECT * FROM messages WHERE id = ? AND room_id = ?')
    this.editMessageStmt = this.db.prepare(
      'UPDATE messages SET body = ?, edited_at = ? WHERE id = ? RETURNING *'
    )
    // Hard delete (migration 010): the row goes, and with it - by hand, in deleteMessage - its
    // outbox row, its attachments and its dismissal tombstones; its mentions go by the
    // `ON DELETE CASCADE` on mentions.message_id, enforced on this connection. No tombstone is
    // left: unread is a COUNT, cursors are bare keys compared with `<`, and the guard never
    // rewinds, so nothing structural needs the row to stay.
    this.deleteMessageRowStmt = this.db.prepare('DELETE FROM messages WHERE id = ?')
    // THE FIX for the leak this change was made for: the outbox payload is the whole message,
    // body included, and until this statement existed nothing ever removed it - so a "deleted"
    // message's text sat in `events.payload` indefinitely and a client resuming from an older
    // cursor replayed it straight back onto the screen. Point read on (room_id, created_at),
    // which is the message's own key and the outbox's unique index.
    this.deleteEventStmt = this.db.prepare('DELETE FROM events WHERE room_id = ? AND created_at = ?')
    // Bell hygiene: a tombstone for an item that can no longer appear is dead weight, and the
    // clear-watermark prune only ever reaches the ones a "clear all" has passed.
    this.deleteDismissalsForMessageStmt = this.db.prepare(
      'DELETE FROM notification_dismissals WHERE item_id IN (?, ?)'
    )

    // Feed replay: everything after the global cursor, ALREADY filtered to the rooms the user can
    // read - READABLE_PREDICATE is the server-side authorization that makes a payload-carrying
    // bus safe (every channel, plus the DMs they are in). The join to room_members is LEFT and on
    // its primary key, so it can never duplicate an event row. Deliberately NOT a per-connection
    // "watching room X" subscription: feed authorization has to stay a pure function of (event,
    // principal) or replay after a drop cannot know which rooms were being watched during the gap
    // - which would re-freeze the room inside every reconnect.
    this.eventsAfterStmt = this.db.prepare(
      `SELECT e.id, e.room_id, e.type, e.payload, e.created_at
         FROM events e
         JOIN rooms r ON r.id = e.room_id
         LEFT JOIN room_members m ON m.room_id = e.room_id AND m.user_id = ?
        WHERE e.id > ? AND ${READABLE_PREDICATE} ORDER BY e.id LIMIT ?`
    )
    // MAX here is a read-only high-water mark ("start the feed from now"), which a deleted row
    // cannot corrupt - unlike using MAX to ISSUE, which the comment on issueKeyStmt forbids.
    this.latestEventIdStmt = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events')

    // --- mentions + the notification bell ---------------------------------------------------

    // The mention-seeded pointer. A SECOND statement rather than a seed parameter on
    // addMemberStmt, so "a fresh pointer starts at the room's HEAD" keeps living in exactly one
    // statement and this one owns the one deliberate exception: the seed is one key BEFORE the
    // mentioning message, so the message that names you is born UNREAD. Head-seeding here would
    // badge nothing and leave no trace of why the bell rang. OR IGNORE carries the same guarantee
    // as addMemberStmt: an EXISTING pointer is never touched - a mention must not reset a
    // backlog, and markRead stays the only thing that moves an existing pointer.
    this.addMentionedMemberStmt = this.db.prepare(
      `INSERT OR IGNORE INTO room_members (room_id, user_id, joined_at, last_read_at)
       VALUES (@roomId, @userId, @now, @lastReadAt)`
    )
    // The durable record behind the bell. NOT an events row: an outbox row is a `message.created`
    // to every client, so it would put a phantom message in every timeline and every badge. The
    // live nudge is the mention.created ephemeral, after commit. `created_at` is a write-time
    // copy of the message's key (same transaction, so it cannot drift).
    this.insertMentionStmt = this.db.prepare(
      `INSERT INTO mentions (message_id, user_id, room_id, created_at, seen_at)
       VALUES (@messageId, @userId, @roomId, @createdAt, NULL)`
    )
    // The bell's mention stratum. The body joins from messages at read time (never copied), and
    // the mention row itself cascades away with its message, so a deleted message leaves no
    // mention behind - no second bookkeeping write. The readability filter is READABLE_PREDICATE
    // - the one rule REUSED, not a third copy: the bell must not serve a DM's words to anyone the
    // room itself would refuse (today that is only the agent as a guest, whose pass is the mention
    // row and who reads the room by slug rather than through a bell of its own). Keys are unique
    // per room, so the message id only breaks a cross-room tie, deterministically.
    this.mentionsForStmt = this.db.prepare(
      `SELECT mn.message_id, mn.room_id, r.slug AS room_slug, r.kind AS room_kind,
              msg.sender_id, msg.sender_name, msg.body, mn.created_at, mn.seen_at
         FROM mentions mn
         JOIN messages msg ON msg.id = mn.message_id
         JOIN rooms r ON r.id = mn.room_id
         LEFT JOIN room_members m ON m.room_id = mn.room_id AND m.user_id = mn.user_id
        WHERE mn.user_id = ? AND ${READABLE_PREDICATE}
        ORDER BY mn.created_at DESC, mn.message_id DESC LIMIT ?`
    )
    // The badge must equal what the list shows as unseen, so the count carries exactly the
    // filters of mentionsForStmt (readability applied) plus seen_at IS NULL.
    this.unseenMentionCountStmt = this.db.prepare(
      `SELECT COUNT(*) AS n
         FROM mentions mn
         JOIN messages msg ON msg.id = mn.message_id
         JOIN rooms r ON r.id = mn.room_id
         LEFT JOIN room_members m ON m.room_id = mn.room_id AND m.user_id = mn.user_id
        WHERE mn.user_id = ? AND mn.seen_at IS NULL AND ${READABLE_PREDICATE}`
    )
    // The bell's recent-messages stratum: every room the user can READ, minus their own words.
    // Before migration 015 this was an INNER JOIN on room_members - "rooms you subscribed to" -
    // which kept the bell from being the firehose of every public room. With the row now meaning
    // only "has a read pointer here", that join would filter on which rooms this person happened
    // to have opened once, which is nobody's idea of a subscription; so it is READABLE_PREDICATE
    // like the mention stratum, and the bell carries every channel. That is a deliberate widening,
    // accepted with the decision that every user is in every room. `unread` is the sidebar's rule
    // per row, including its "no row, nothing owed" arm, so the bell and the badge agree. This
    // list spans rooms, and created_at is unique only WITHIN one, so the room id breaks a
    // cross-room tie for a deterministic order - a display order, never a cursor.
    this.recentForStmt = this.db.prepare(
      `SELECT msg.id AS message_id, msg.room_id, r.slug AS room_slug, r.kind AS room_kind,
              msg.sender_id, msg.sender_name, msg.body, msg.created_at,
              CASE WHEN m.user_id IS NULL THEN 0 ELSE msg.created_at > m.last_read_at END AS unread
         FROM messages msg
         JOIN rooms r ON r.id = msg.room_id
         LEFT JOIN room_members m ON m.room_id = msg.room_id AND m.user_id = ?
        WHERE msg.sender_id <> ? AND ${READABLE_PREDICATE}
        ORDER BY msg.created_at DESC, msg.room_id DESC LIMIT ?`
    )
    // seen_at IS NULL makes both idempotent: a repeat call finds nothing to stamp, so seen_at
    // keeps meaning "when the bell first showed it" rather than "the last time anything asked".
    this.markMentionSeenAllStmt = this.db.prepare(
      'UPDATE mentions SET seen_at = ? WHERE user_id = ? AND seen_at IS NULL'
    )
    this.markMentionSeenOneStmt = this.db.prepare(
      'UPDATE mentions SET seen_at = ? WHERE user_id = ? AND message_id = ? AND seen_at IS NULL'
    )
    this.watermarkGetStmt = this.db.prepare(
      'SELECT seen_through FROM notification_reads WHERE user_id = ? AND source = ?'
    )
    // MAX in the DO UPDATE is what makes the watermark monotonic - the same rule markReadStmt
    // enforces for the room pointer: a stale tab writing an old high-water mark must not
    // resurrect a badge a newer tab already cleared.
    this.watermarkSetStmt = this.db.prepare(
      `INSERT INTO notification_reads (user_id, source, seen_through) VALUES (?, ?, ?)
       ON CONFLICT (user_id, source) DO UPDATE
          SET seen_through = MAX(excluded.seen_through, notification_reads.seen_through)`
    )

    // Dismissal is a per-user, per-item tombstone keyed by the BELL's item id, so one statement
    // covers chat rows and warehouse rows alike. OR IGNORE: dismissing twice (two tabs, a double
    // click) is a no-op that keeps the ORIGINAL timestamp rather than restamping.
    this.dismissStmt = this.db.prepare(
      `INSERT OR IGNORE INTO notification_dismissals (user_id, item_id, dismissed_at) VALUES (?, ?, ?)`
    )
    this.dismissedStmt = this.db.prepare(
      'SELECT item_id FROM notification_dismissals WHERE user_id = ?'
    )
    // "Clear all" is a WATERMARK, not N tombstones - so it also subsumes every tombstone older
    // than it, and this prune keeps the table from growing without bound one dismissal at a time.
    //
    // Note WHICH timeline this compares. The bell filters an item by the ITEM's timestamp
    // (`item.at <= watermark`), but a tombstone only knows when it was WRITTEN. That is still
    // sound, and conservatively so: you can only dismiss something that already exists, so
    // dismissed_at >= item.at always, and therefore `watermark >= dismissed_at` implies
    // `watermark >= item.at`. Pruning can lag, but it can never drop a tombstone that is still
    // doing work - which would resurrect a dismissed row.
    this.dismissPruneStmt = this.db.prepare(
      'DELETE FROM notification_dismissals WHERE user_id = ? AND dismissed_at <= ?'
    )

    // --- Web Push subscriptions (Track 9) ---
    // Upsert on the endpoint: a re-subscribe (same browser, new keys after the push service
    // rotates them, or the same browser signed in as someone else) REPLACES the row rather than
    // duplicating it - the endpoint can only deliver to one device, so the latest claim wins.
    // created_at survives the update; last_seen_at resets because new keys are unproven.
    this.pushUpsertStmt = this.db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at)
       VALUES (@userId, @endpoint, @p256dh, @auth, @userAgent, @now, @now)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, last_seen_at = excluded.last_seen_at`
    )
    // The user-facing unsubscribe: scoped to the caller so one user cannot revoke another's.
    this.pushDeleteOwnStmt = this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    // The transport's prune on 404/410: by endpoint alone - the push service just said it is gone.
    this.pushDeleteStmt = this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
    this.pushForUserStmt = this.db.prepare(
      `SELECT user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at
       FROM push_subscriptions WHERE user_id = ?`
    )
    this.pushSeenStmt = this.db.prepare('UPDATE push_subscriptions SET last_seen_at = ? WHERE endpoint = ?')
    this.pushPruneStmt = this.db.prepare('DELETE FROM push_subscriptions WHERE last_seen_at < ?')

    // --- Native-app device tokens (mobile FCM transport). Same shape as the Web Push block:
    // upsert on the token (the latest claim wins - a reinstalled app or a device signed in as
    // someone else replaces the row), unregister scoped to the caller, delete-by-token for the
    // transport's UNREGISTERED prune. ---
    this.deviceUpsertStmt = this.db.prepare(
      `INSERT INTO device_tokens (token, user_id, platform, created_at, last_seen_at)
       VALUES (@token, @userId, @platform, @now, @now)
       ON CONFLICT (token) DO UPDATE SET
         user_id = excluded.user_id, platform = excluded.platform, last_seen_at = excluded.last_seen_at`
    )
    this.deviceDeleteOwnStmt = this.db.prepare('DELETE FROM device_tokens WHERE token = ? AND user_id = ?')
    this.deviceDeleteStmt = this.db.prepare('DELETE FROM device_tokens WHERE token = ?')
    this.deviceForUserStmt = this.db.prepare(
      'SELECT token, user_id, platform, created_at, last_seen_at FROM device_tokens WHERE user_id = ?'
    )
    this.deviceSeenStmt = this.db.prepare('UPDATE device_tokens SET last_seen_at = ? WHERE token = ?')
    this.devicePruneStmt = this.db.prepare('DELETE FROM device_tokens WHERE last_seen_at < ?')

    this.roomSlugByIdStmt = this.db.prepare('SELECT slug FROM rooms WHERE id = ?')
    // The notification seam's one question per committed message (Track 14): is this room a DM,
    // and if so who is the OTHER member? Answered in one statement so the seam holds no room-kind
    // logic of its own. The kind filter is on `rooms`, the pair walk is a range on room_members'
    // primary key - a point read per message.created on the bus, which is noise.
    //
    // The EXISTS is the viewer's OWN member row: "the other member" is only a meaningful answer
    // from INSIDE the pair. Without it, a user id that is not in the room (the agent as a guest,
    // see `isDirectGuest`) would get back whichever of the two members the scan met first - a
    // nondeterministic "peer" for someone who has none. NULL there is also what VISIBLE_SELECT's
    // `peer` column already answers for a non-member viewer, so the two agree by construction.
    // Bound (roomId, userId, userId): positional, and the one caller is `directPeer` below.
    this.directPeerStmt = this.db.prepare(
      `SELECT p.user_id AS user_id FROM rooms r JOIN room_members p ON p.room_id = r.id
        WHERE r.id = ? AND r.kind = 'dm' AND p.user_id <> ?
          AND EXISTS (SELECT 1 FROM room_members me WHERE me.room_id = r.id AND me.user_id = ?)`
    )
    // The agent's guest pass into a DM between two humans (2026-09-04): does a SURVIVING message in
    // this DM mention this user? The mention row is the grant - it is written by `post` for the
    // agent alone in a DM (every other DM mention is intersected with the member set), and it
    // cascades away with its message, so deleting the ask is what revokes the pass. No new table
    // and no new column: the durable record the bell already keeps is exactly "somebody in this
    // room asked for you", which is the whole authorization. The kind filter is what keeps this a
    // DM rule - a channel is readable by everyone, and this statement is never consulted there.
    // Served by `mentions_user` (user_id, created_at) filtered on room_id: the agent's mentions
    // over all time are a few hundred rows, and only the agent ever reaches this read.
    this.directGuestStmt = this.db.prepare(
      `SELECT 1 AS hit FROM rooms r JOIN mentions g ON g.room_id = r.id
        WHERE r.id = ? AND r.kind = 'dm' AND g.user_id = ? LIMIT 1`
    )

    // --- attachments (Track 11). Rows here, bytes in uploadsDir; the rules live on the methods. ---

    this.attachmentInsertStmt = this.db.prepare(
      `INSERT INTO attachments (id, message_id, uploader_id, filename, mime, bytes, sha256, created_at)
       VALUES (@id, NULL, @uploaderId, @filename, @mime, @bytes, @sha256, @createdAt)`
    )
    // The serve path's one read: the row plus its message's room, LEFT-joined because an orphan
    // has no message yet. Everything attachmentForRead decides on arrives in this single read.
    this.attachmentByIdStmt = this.db.prepare(
      `SELECT a.id, a.message_id, a.uploader_id, a.filename, a.mime, a.bytes, a.sha256, a.created_at,
              msg.room_id
         FROM attachments a LEFT JOIN messages msg ON msg.id = a.message_id
        WHERE a.id = ?`
    )
    // Ordered by (created_at, id) so a message's attachments render in upload order, ties broken
    // deterministically - never by rowid, which VACUUM can renumber.
    this.attachmentsByMessageStmt = this.db.prepare(
      `SELECT id, message_id, uploader_id, filename, mime, bytes, sha256, created_at
         FROM attachments WHERE message_id = ? ORDER BY created_at, id`
    )

    // --- Reactions (Track 10, migration 011).
    // Oldest first, ties broken on user_id. `users` is shown to people, and a list that reshuffles
    // between two reads reads as activity that did not happen - so within one millisecond the
    // order is alphabetical rather than by arrival. Sub-millisecond "who was first" is not a fact
    // worth an extra column; a stable list is.
    this.reactionsByMessageStmt = this.db.prepare(
      `SELECT user_id AS userId, emoji FROM message_reactions WHERE message_id = ? ORDER BY created_at, user_id`
    )
    // OR IGNORE is the idempotence: the PK is all three columns, so a double-tap (two tabs, a
    // retried request, a fat-fingered double click) changes nothing and reports 0 changes rather
    // than raising a constraint error the caller would have to pattern-match.
    this.reactionAddStmt = this.db.prepare(
      'INSERT OR IGNORE INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)'
    )
    // Un-reacting is a DELETE, and removing what is not there is 0 changes, not an error - the
    // same convergence argument from the other side.
    this.reactionRemoveStmt = this.db.prepare(
      'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?'
    )
    // The CLAIM - the only statement that ever sets message_id. All three preconditions live in
    // the WHERE clause so the claim is atomic: the row must exist, belong to the CLAIMANT (you
    // can only post your own uploads - anything looser would let a guessed id graft someone
    // else's file onto your message), and still be an orphan (a second claim would silently
    // re-parent an attachment that another room may already be reading). Zero changes = refused;
    // post() diagnoses which precondition failed for an honest error.
    this.attachmentClaimStmt = this.db.prepare(
      `UPDATE attachments SET message_id = @messageId
        WHERE id = @id AND uploader_id = @uploaderId AND message_id IS NULL`
    )
    // Blob GC's ONLY question: how many rows still reference this content? Derived from the rows
    // every time, never a stored counter - counters drift, and a drifted refcount either leaks
    // blobs forever or deletes one somebody still references.
    this.attachmentRefcountStmt = this.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE sha256 = ?')
    this.attachmentOrphansExpiredStmt = this.db.prepare(
      'SELECT id, sha256 FROM attachments WHERE message_id IS NULL AND created_at < ?'
    )
    this.attachmentDeleteStmt = this.db.prepare('DELETE FROM attachments WHERE id = ?')
    this.attachmentsDeleteByMessageStmt = this.db.prepare('DELETE FROM attachments WHERE message_id = ?')

    // --- The chat agent's per-room row (Track 15, migration 007).
    this.agentSessionGetStmt = this.db.prepare(`SELECT ${AGENT_SESSION_COLUMNS} FROM agent_sessions WHERE room_id = ?`)
    // One statement for create AND update: every caller here holds the whole row (it was read a
    // moment earlier or is being born), so a partial-update surface would only invite two writers
    // to disagree about which columns they own.
    this.agentSessionUpsertStmt = this.db.prepare(
      `INSERT INTO agent_sessions
         (room_id, worker_session_id, streaming_message_id, last_worker_seq,
          turn_started_at, turns_this_hour, window_started_at, updated_at)
       VALUES (@roomId, @workerSessionId, @streamingMessageId, @lastWorkerSeq,
               @turnStartedAt, @turnsThisHour, @windowStartedAt, @updatedAt)
       ON CONFLICT (room_id) DO UPDATE SET
         worker_session_id    = excluded.worker_session_id,
         streaming_message_id = excluded.streaming_message_id,
         last_worker_seq      = excluded.last_worker_seq,
         turn_started_at      = excluded.turn_started_at,
         turns_this_hour      = excluded.turns_this_hour,
         window_started_at    = excluded.window_started_at,
         updated_at           = excluded.updated_at`
    )
    this.agentSessionDeleteStmt = this.db.prepare('DELETE FROM agent_sessions WHERE room_id = ?')
    // Boot-time only (restart recovery). A full scan of messages, deliberately unindexed: it runs
    // ONCE per process against a table whose `meta` is NULL on all but a handful of rows, and an
    // index would cost a write on every message forever to save a scan that happens at startup.
    this.pendingCardsStmt = this.db.prepare(
      // `json_valid` FIRST, and it is not belt-and-braces: `json_extract` THROWS on a malformed
      // cell, and this statement runs inside restart recovery's catch-all - so one corrupt row
      // would silently disable the entire sweep and leave every orphaned card pending forever.
      // SQLite evaluates AND left-to-right here, so the guard actually shields the extracts.
      `SELECT * FROM messages
        WHERE meta IS NOT NULL AND json_valid(meta)
          AND json_extract(meta, '$.kind') = ?
          AND json_extract(meta, '$.state') = 'pending'`
    )
    this.agentSessionsStreamingStmt = this.db.prepare(
      `SELECT ${AGENT_SESSION_COLUMNS} FROM agent_sessions WHERE streaming_message_id IS NOT NULL`
    )
    // The agent's write path - see checkpointBody. Sender, room and id are ALL in the WHERE
    // clause, so the authorization is the statement rather than a check some caller might skip.
    // Note what is NOT set: edited_at (an agent message must never wear an "(edited)" marker it
    // did not earn), and nothing in the outbox. A placeholder somebody deleted mid-turn simply
    // matches nothing - the delete wins, silently, which is the contract every caller holds.
    // The read half, authorized identically, so restart recovery can see what a turn had already
    // streamed before overwriting it.
    this.agentBodyStmt = this.db.prepare(
      `SELECT body FROM messages
        WHERE id = @messageId AND sender_id = @senderId AND room_id = @roomId`
    )
    this.checkpointBodyStmt = this.db.prepare(
      `UPDATE messages SET body = @body
        WHERE id = @messageId AND sender_id = @senderId AND room_id = @roomId
        RETURNING *`
    )
    // The approval card's update path (Track 19): body AND meta together, authorized by the same
    // sender+room+id clause, and setting no edited_at for the same reason - a card that says
    // "approved by alice" is the card doing its job, not somebody editing the agent's words.
    this.checkpointCardStmt = this.db.prepare(
      `UPDATE messages SET body = @body, meta = @meta
        WHERE id = @messageId AND sender_id = @senderId AND room_id = @roomId
        RETURNING *`
    )
  }

  close(): void {
    this.db.close()
  }

  /**
   * Snapshot the live database to `path` with VACUUM INTO - the only correct copy under WAL
   * (recent commits live in chat.db-wal, so a plain file copy opens clean and has silently lost
   * the last hour). Serializes with live writes on this connection; the target must not already
   * exist (SQLite refuses to overwrite, and that refusal is kept).
   */
  backupTo(path: string): void {
    this.db.exec(`VACUUM INTO '${resolve(path).replaceAll("'", "''")}'`)
  }

  // --- Web Push subscriptions (Track 9). All principal scoping is the CALLER's job for reads,
  // and baked into the statement for the one mutation where it matters (pushUnsubscribe). ---

  /** Idempotent subscribe: the endpoint is the identity, the latest claim wins. */
  pushSubscribe(
    userId: string,
    sub: { endpoint: string; p256dh: string; auth: string; userAgent?: string | null }
  ): ChatPushSubscription {
    this.pushUpsertStmt.run({
      userId,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      userAgent: sub.userAgent ?? null,
      now: Date.now()
    })
    return this.pushSubscriptionsFor(userId).find((row) => row.endpoint === sub.endpoint)!
  }

  /** Remove ONE of the caller's own subscriptions. Returns whether a row went away. */
  pushUnsubscribe(userId: string, endpoint: string): boolean {
    return this.pushDeleteOwnStmt.run(endpoint, userId).changes > 0
  }

  /** Every subscription for a user - the send fan-out, and the "is this browser on?" check. */
  pushSubscriptionsFor(userId: string): ChatPushSubscription[] {
    return (this.pushForUserStmt.all(userId) as PushRow[]).map(toPushSubscription)
  }

  /** The transport's prune: the push service answered 404/410, the subscription is GONE. */
  pushSubscriptionDelete(endpoint: string): void {
    this.pushDeleteStmt.run(endpoint)
  }

  /** Stamped on every successful send, so a stale subscription is identifiable. */
  pushSubscriptionSeen(endpoint: string, at: number): void {
    this.pushSeenStmt.run(at, endpoint)
  }

  /** Drop subscriptions unseen since `cutoff` (epoch ms). Returns how many went. */
  pushPruneUnseenSince(cutoff: number): number {
    return this.pushPruneStmt.run(cutoff).changes
  }

  // --- Native-app device tokens (mobile FCM transport). Caller scoping rules mirror the Web
  // Push block above. ---

  /** Idempotent register: the token is the identity, the latest claim wins. */
  deviceTokenRegister(userId: string, token: string, platform: string): ChatDeviceToken {
    this.deviceUpsertStmt.run({ token, userId, platform, now: Date.now() })
    return this.deviceTokensFor(userId).find((row) => row.token === token)!
  }

  /** Remove ONE of the caller's own device tokens. Returns whether a row went away. */
  deviceTokenUnregister(userId: string, token: string): boolean {
    return this.deviceDeleteOwnStmt.run(token, userId).changes > 0
  }

  /** Every device token for a user - the send fan-out. */
  deviceTokensFor(userId: string): ChatDeviceToken[] {
    return (this.deviceForUserStmt.all(userId) as DeviceTokenRow[]).map(toDeviceToken)
  }

  /** The transport's prune: FCM answered UNREGISTERED/NOT_FOUND, the token is GONE. */
  deviceTokenDelete(token: string): void {
    this.deviceDeleteStmt.run(token)
  }

  /** Stamped on every successful send, so a stale token is identifiable. */
  deviceTokenSeen(token: string, at: number): void {
    this.deviceSeenStmt.run(at, token)
  }

  /** Drop device tokens unseen since `cutoff` (epoch ms). Returns how many went. */
  deviceTokenPruneUnseenSince(cutoff: number): number {
    return this.devicePruneStmt.run(cutoff).changes
  }

  /** Resolve a room id to its slug (deep links in notifications). Null for an unknown room. */
  roomSlugById(roomId: string): string | null {
    return (this.roomSlugByIdStmt.get(roomId) as { slug: string } | undefined)?.slug ?? null
  }

  /**
   * The OTHER member of a DM, from one member's point of view - or null when `roomId` is not a DM
   * (a named room, an unknown id), when `userId` is not one of its two members (a third person,
   * or the agent as a GUEST - see `isDirectGuest` - neither of whom has a peer), or when `userId`
   * is its only member (which the two-member invariant makes unreachable, but the statement
   * answers honestly rather than assuming).
   *
   * Exists for the notification seam (Track 14): a message in a DM notifies its peer the way a
   * mention does, and this is the one read that decision needs. It is also the chat agent's DM
   * door (`resolveAgentTrigger`): a DM is a conversation WITH the agent exactly when the sender's
   * peer is the agent, which is why a DM between two humans that the agent has been asked into
   * never reads as one - the human's peer is the other human. NO authorization, like `message()`
   * - the caller is the server reacting to a committed bus event, not a principal.
   */
  directPeer(roomId: string, userId: string): string | null {
    return (this.directPeerStmt.get(roomId, userId, userId) as { user_id: string } | undefined)?.user_id ?? null
  }

  // --- attachments (Track 11) -------------------------------------------------------------------

  /**
   * Store an upload: blob first, row second, all synchronous - so a committed row NEVER references
   * bytes that are not on disk (the failure the other order allows), while the reverse (a blob
   * whose insert then failed) is mere garbage that the sweeper's reconcile pass collects. Every
   * row is born an ORPHAN (message_id NULL): the post that references it claims it later, inside
   * its own transaction. Dedup falls out of content addressing - a re-upload of known bytes is a
   * new ROW (its own filename/uploader/window) over the existing blob, and writeBlob is a no-op.
   *
   * Size caps and mime allowlists deliberately do NOT live here: they are HTTP-surface refusals
   * (the controller answers them verbatim), and the store must stay able to hold whatever an
   * admin script or a future migration hands it.
   */
  attachmentCreate(uploaderId: string, file: { filename: string; mime: string; bytes: Buffer }): ChatAttachment {
    const sha256 = sha256Hex(file.bytes)
    writeBlob(this.uploadsDir, sha256, file.bytes)
    const row: AttachmentRow = {
      id: randomUUID(),
      message_id: null,
      uploader_id: uploaderId,
      filename: file.filename,
      mime: file.mime,
      bytes: file.bytes.byteLength,
      sha256,
      created_at: Date.now()
    }
    this.attachmentInsertStmt.run({
      id: row.id,
      uploaderId: row.uploader_id,
      filename: row.filename,
      mime: row.mime,
      bytes: row.bytes,
      sha256: row.sha256,
      createdAt: row.created_at
    })
    return toAttachment(row)
  }

  /** Plain metadata lookup, NO authorization - internal plumbing and tests. The serve path must
   *  use attachmentForRead, which is the rule. */
  attachmentById(id: string): ChatAttachment | null {
    const row = this.attachmentByIdStmt.get(id) as AttachmentJoinRow | undefined
    return row ? toAttachment(row) : null
  }

  /** Every attachment for one message, in upload order. */
  attachmentsForMessage(messageId: string): ChatAttachment[] {
    return (this.attachmentsByMessageStmt.all(messageId) as AttachmentRow[]).map(toAttachment)
  }

  /** Every reaction on one message, grouped by emoji in palette order. Empty when there are none.
   *  Reader-INDEPENDENT by design - see `ChatReactionGroup`. */
  reactionsForMessage(messageId: string): ChatReactionGroup[] {
    return groupReactions(this.reactionsByMessageStmt.all(messageId) as { userId: string; emoji: string }[])
  }

  /**
   * React to a message, or take a reaction back. Returns the message's complete groups afterwards.
   *
   * Authorized by READABILITY, the same gate `post` uses: if you can write a message into this
   * room you can certainly ack one, and somebody who has never opened a channel is already
   * allowed to do the louder thing. Not by senderhood - that gate is for editing and deleting,
   * and a reaction on only your own messages would be a strange feature.
   *
   * Three things this does NOT do, and each is the point of the track rather than an omission:
   *
   * - **It allocates no order key and writes no outbox row.** The invariant is that only
   *   `message.created` may ever move a room's allocator; a reaction that badged the room would
   *   make the polite gesture the one that interrupts three people, which is the whole thing this
   *   exists to avoid. There is a store test asserting the head does not move.
   * - **It never notifies.** No mention row, no bell, no push.
   * - **It does not touch the message.** No `edited_at`, no new body: a message somebody reacted
   *   to has not been edited, and stamping it would say so on every client.
   *
   * Idempotent in both directions (`INSERT OR IGNORE` / a DELETE that matches nothing), so a retry
   * after a dropped response converges instead of double-counting. The fan-out is skipped when
   * nothing actually changed - a double-tap is silent rather than a frame every reader must
   * process to learn that the state they hold is the state they hold.
   */
  setReaction(
    slug: string,
    messageId: string,
    userId: string,
    emoji: string,
    on: boolean
  ): ChatReactionGroup[] {
    if (this.db.inTransaction) {
      throw new Error('ChatStore.setReaction must not run inside an enclosing transaction (publish-after-commit)')
    }
    // The palette gate, server-side and not merely in the picker: `emoji` arrives from a client
    // over tRPC/MCP, and without this the column accepts whatever anybody sends.
    if (!isReactionEmoji(emoji)) {
      throw new ChatValidationError(`"${emoji}" is not a reaction this chat offers`)
    }
    const result = this.transaction(() => {
      const room = this.requireReadableRoom(slug, userId)
      const row = this.messageByIdStmt.get(messageId, room.id) as MessageRow | undefined
      if (!row) throw new ChatNotFoundError(`no message "${messageId}" in "${slug}"`)
      const changes = on
        ? this.reactionAddStmt.run(messageId, userId, emoji, Date.now()).changes
        : this.reactionRemoveStmt.run(messageId, userId, emoji).changes
      return { row, changed: changes > 0, reactions: this.reactionsForMessage(messageId) }
    })
    if (result.changed) {
      emitChatEvent({
        ephemeral: true,
        type: on ? 'reaction.added' : 'reaction.removed',
        roomId: result.row.room_id,
        // Null: the room's READERS, exactly like message.edited. Who reacted is not private the
        // way a read pointer is - the pill names them on every client that renders it.
        userId: null,
        reaction: {
          messageId,
          ...(result.row.parent_id !== null ? { parentId: result.row.parent_id } : {}),
          userId,
          emoji,
          reactions: result.reactions
        },
        at: Date.now()
      })
    }
    return result.reactions
  }

  /** Where this attachment's bytes live on disk. Path only - existence is the caller's check
   *  (the serve route answers a missing blob with its own refusal). */
  attachmentBlobPath(sha256: string): string {
    return blobPath(this.uploadsDir, sha256)
  }

  /**
   * THE authorization rule for serving an attachment - the reason its URL is not a capability.
   * Nothing is signed and nothing expires, because every single request re-answers the same
   * question the live feed answers, with the same predicate:
   *
   *   - posted attachment: readable by exactly whoever `canReadRoom` admits to its message's
   *     room, decided NOW - a DM's screenshots are as closed to a third person as its words;
   *   - orphan (no message yet, so no room for canReadRoom to consult): readable ONLY by its
   *     uploader - the composer preview needs it, nobody else has any business with it;
   *   - a deleted message's attachment answers NOT FOUND because its row is gone: deleteMessage
   *     hard-deletes attachment rows in the same transaction as the message, and the
   *     `REFERENCES messages(id)` with no cascade means a message cannot be deleted while a row
   *     still points at it - so there is no third branch for the read side to remember.
   *
   * A signed public URL was ruled out in the Track 11 spec: it would be a second, weaker auth
   * system beside the one chat already has, and its lifetime would outlive any change to who may
   * read the room made after it was minted.
   */
  attachmentForRead(id: string, userId: string): ChatAttachment {
    const row = this.attachmentByIdStmt.get(id) as AttachmentJoinRow | undefined
    if (!row) throw new ChatNotFoundError(`no attachment "${id}"`)
    if (row.message_id === null) {
      if (row.uploader_id !== userId) {
        throw new ChatAccessError('an attachment that has not been posted is readable only by its uploader')
      }
      return toAttachment(row)
    }
    // room_id cannot be null here: message_id is set and REFERENCES messages(id) is enforced on
    // this connection, so the join always lands. The ! is that invariant, not optimism.
    if (!this.canReadRoom(row.room_id!, userId)) {
      throw new ChatAccessError('this attachment belongs to a room you cannot read')
    }
    return toAttachment(row)
  }

  /**
   * Reap orphans older than `ttlMs` and reconcile the blob directory. Returns how many rows went.
   *
   * Scheduling: called opportunistically from the upload route (every upload sweeps first), which
   * keeps the table self-maintaining with no timer. A `chat-attachments-sweep` entry in the
   * automation-action registry (core/automation/actions.ts, beside `chat-backup`) would be the
   * belt-and-braces for an instance nobody uploads to - deliberately NOT added here, and nothing
   * arms a schedule: AUTOMATION_ENABLED stays unset on dev machines.
   *
   * Two passes, and the order matters:
   *  1. TRANSACTION: delete expired orphan rows. Rows first, always - a blob must never die
   *     before every row referencing it is durably gone, or a rollback would leave rows pointing
   *     at nothing.
   *  2. After commit: refcount-check each candidate sha and delete the unreferenced blobs, then
   *     reconcile the directory against the rows - unreferenced blobs (an insert that failed
   *     after its blob write, a crash between commit and unlink) and stale temp files are
   *     garbage by definition, because rows are the only thing that keeps content alive.
   *
   * The whole sequence is synchronous, so IN-PROCESS nothing can interleave between the commit
   * and the unlinks (better-sqlite3 and the fs calls never yield the event loop). Cross-process
   * the unlink could in principle race a second WRITER's upload of the same content; the system
   * has exactly one chat.db writer (the server - scripts go through it), and attachmentCreate
   * writes the blob before the row, so even that race ends with the next sweep re-collecting,
   * never with a served 404 for a live row... unless a second writer appears, which is the
   * assumption to revisit if one ever does.
   */
  sweepOrphanAttachments(ttlMs: number = ATTACHMENT_ORPHAN_TTL_MS): number {
    const cutoff = Date.now() - ttlMs
    const expired = this.transaction(() => {
      const rows = this.attachmentOrphansExpiredStmt.all(cutoff) as { id: string; sha256: string }[]
      for (const row of rows) this.attachmentDeleteStmt.run(row.id)
      return rows
    })
    this.gcAttachmentBlobs(expired.map((row) => row.sha256))

    // Reconcile: anything on disk that no row references is garbage (see the method comment).
    // The temp-file cutoff reuses the orphan TTL - generous, but a temp file is bytes, not rows,
    // and a synchronous write that started a day ago is not still running.
    const onDisk = listBlobs(this.uploadsDir, cutoff)
    for (const sha of onDisk.blobs) {
      if ((this.attachmentRefcountStmt.get(sha) as { n: number }).n === 0) deleteBlob(this.uploadsDir, sha)
    }
    for (const rel of onDisk.staleTmp) deleteStaleTmp(this.uploadsDir, rel)

    return expired.length
  }

  /** Refcount-gated blob deletion: a blob dies exactly when NO row references its sha anymore.
   *  Called strictly AFTER the transaction that deleted the rows committed - never inside it,
   *  where a rollback would resurrect the rows but not the bytes. */
  private gcAttachmentBlobs(sha256s: readonly string[]): number {
    let unlinked = 0
    for (const sha of new Set(sha256s)) {
      if ((this.attachmentRefcountStmt.get(sha) as { n: number }).n === 0) {
        deleteBlob(this.uploadsDir, sha)
        unlinked += 1
      }
    }
    return unlinked
  }

  /**
   * Run `fn` in an IMMEDIATE transaction. IMMEDIATE rather than the default deferred because every
   * mutation here READS before it WRITES (the room row, the viewer's pointer row, head_at), and a deferred
   * transaction that upgrades a read snapshot to a write fails with SQLITE_BUSY *after* doing the
   * work instead of waiting at BEGIN.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  roomBySlug(slug: string): ChatRoom | null {
    const row = this.roomBySlugStmt.get(slug) as RoomRow | undefined
    return row ? toRoom(row) : null
  }

  /**
   * Is `userId` one of this DM's pair? The one question `room_members` still answers as an ACL,
   * and it is asked only about a DM: for a channel the table holds read pointers and nothing
   * about who may be there. Private on purpose - a public "isMember" invited every caller to
   * gate on it, which is exactly the meaning migration 015 retired.
   */
  private isDirectMember(roomId: string, userId: string): boolean {
    return this.memberRowStmt.get(roomId, userId) !== undefined
  }

  /**
   * The sidebar query: every room the user can READ - every channel, and the DMs they are in -
   * each with THEIR read pointer and unread count (null and 0 in a room they have never opened).
   * One list, deliberately not one per kind: two would mean two caches and a seam where ordering
   * and dedupe drift.
   */
  roomsVisibleTo(userId: string): ChatRoomSummary[] {
    return (this.roomsVisibleStmt.all(userId) as SummaryRow[]).map(toSummary)
  }

  /**
   * The readability rule by room id - the feed's per-event filter. Kept in the store (rather than
   * inline in the controller) so the one rule stays testable and cannot drift from the SQL. The
   * agent's DM-guest pass is OR-ed on here exactly as `requireReadableRoom` does it by slug, so the
   * two TS gates answer identically (the SQL form alone omits it - see READABLE_PREDICATE).
   */
  canReadRoom(roomId: string, userId: string): boolean {
    return this.canReadRoomStmt.get(userId, roomId) !== undefined || this.isDirectGuest(roomId, userId)
  }

  /**
   * THE ONE EXCEPTION to "a DM has exactly two members and nobody else can read it" (2026-09-04):
   * the agent may READ and POST in a direct message between two humans while a surviving message
   * in it mentions the agent. A guest, not a member - which is the whole design:
   *
   * - **Membership stays the human pair.** `directPeer`, the summary's `peer`, the DM door of the
   *   agent trigger and both clients' labels all rest on room_members holding exactly two rows
   *   for a DM; a third row would make "the other member" nondeterministic and turn a DM WITH nova
   *   indistinguishable from a DM nova was asked into. So in a DM `post` never seeds a sender's
   *   pointer, never seeds one by mention, and `markRead` refuses to create one: `openDirect` is
   *   the only writer of a DM's member rows.
   * - **The grant is the mention row, and only the agent's.** Written by `post` in the mentioning
   *   transaction, so the summons (`mention.created`) can never fire before the pass exists;
   *   cascaded away with the message, so deleting the ask revokes it. The trust model is the one
   *   mentioning already has everywhere: only someone who can post in the DM can mention in it,
   *   so only one of the two people it belongs to can let the agent in. Mentioning any OTHER
   *   non-member in a DM stays inert (no row, no grant, no nudge), and no path here can ever add a
   *   third human.
   * - **No pointer.** No unread, no sidebar row, no bell, no feed: the agent is told where it is by
   *   its seed and reads the room by slug. `markRead` refuses it (the one room where a first
   *   markRead does NOT create a row), and `deleteRoom` refuses it - a guest may not purge the
   *   conversation it was asked into.
   *
   * Rejected: unconditional read for the agent in every `kind = 'dm'` room - that would let any
   * turn, asked from any channel, read every private conversation in the system. Rejected: real
   * membership on mention - see the first bullet; every consumer of the two-member invariant would
   * need an "unless it is the agent" branch, and the agent's own DM door would claim every message
   * a human wrote in their DM with each other.
   *
   * Cheap by construction: the room read is a primary-key point read, and the statement runs only
   * when the viewer IS the agent and the room IS a DM.
   */
  private isDirectGuest(roomId: string, userId: string): boolean {
    if (userId !== systemUserId()) return false
    return this.directGuestStmt.get(roomId, userId) !== undefined
  }

  /**
   * Create a channel. Open to everyone from the moment it exists: there is no visibility to pick
   * (migration 015), and the creator's only privilege is a read pointer seeded at the room's head
   * - which on a brand-new room is 0, byte-identical to the column default.
   */
  createRoom(
    input: {
      slug: string
      name?: string | null
      topic?: string | null
      icon?: ChatRoomIcon | null
    },
    creator: ChatSender
  ): ChatRoomSummary {
    if (this.db.inTransaction) {
      throw new Error('ChatStore.createRoom must not run inside an enclosing transaction (publish-after-commit)')
    }
    // The controller's slug regex already has no ':' in it; this is the same rule for a caller that
    // does not pass through the controller (a script, a test), so the DM namespace stays derivable.
    assertNotDirectSlug(input.slug)
    const summary = this.transaction(() => {
      if (this.roomBySlugStmt.get(input.slug)) throw new ChatConflictError(`room "${input.slug}" already exists`)
      const id = randomUUID()
      const now = Date.now()
      this.insertRoomStmt.run({
        id,
        slug: input.slug,
        name: normalizeRoomName(input.name ?? null),
        topic: input.topic ?? null,
        kind: 'room',
        icon: assertRoomIcon(input.icon ?? null),
        createdBy: creator.id,
        now
      })
      // The creator's pointer: head_at is 0 on a brand-new room, so the head seed lands at 0.
      // Kept so the creator reads as having opened their own room (`lastReadAt` non-null) rather
      // than as a stranger to it.
      this.addMemberStmt.run({ roomId: id, userId: creator.id, now })
      return toSummary(this.summaryStmt.get(creator.id, id) as SummaryRow)
    })
    // Ephemeral, not an outbox row (see ChatEphemeralEvent): an outbox row would be a phantom
    // message. Routed to the room's READERS (userId null), which for a channel is everyone - a new
    // room appears live in every sidebar, because everyone is in it.
    emitChatEvent({
      ephemeral: true,
      type: 'room.created',
      roomId: summary.id,
      userId: null,
      at: summary.createdAt
    })
    return summary
  }

  /**
   * Open a direct message with `peerId` - find the existing one, or create it (chat Track 14).
   *
   * IDEMPOTENT BY ADDRESS. The slug is `directSlug(opener, peer)` - the sorted pair - so
   * `open(a, b)` and `open(b, a)` resolve to one room, and the second call returns the first call's
   * room instead of a duplicate (the bug every DM implementation ships first). Two guarantees keep
   * that true under concurrency, and they are layered on purpose:
   *
   * 1. The find-or-create runs inside an IMMEDIATE transaction, which takes the write lock at
   *    BEGIN: a second connection racing the same pair waits at its own BEGIN (busy_timeout) and
   *    then FINDS the row the first one committed. No interleaving between the SELECT and the
   *    INSERT is possible.
   * 2. `rooms_slug` is UNIQUE, so a writer that skips the transaction (a script inserting rows
   *    by hand) hits a constraint error rather than a second room for the same two people. The
   *    schema, not the SELECT, is what makes a duplicate impossible.
   *
   * Both member rows are written at the room's head (0 on a new room), the same seed `createRoom`
   * uses for its creator - and they are ASSERTED on every open (`INSERT OR IGNORE`), not only on
   * create. Normally a no-op: nothing in this store ever deletes a member row short of deleting
   * the room. If a row is ever missing anyway (a hand edit), the next open repairs the invariant
   * instead of handing back a one-member "DM". These two rows are the DM's whole ACL - the one
   * place `room_members` still means "who is in here" rather than "where is my pointer" - which
   * is why this is their only writer: `post` and `markRead` seed a pointer in a channel and
   * never in a DM.
   *
   * REFUSED: a DM with yourself. A notes-to-self room would have one member and no peer, so every
   * rule here (two members, notify the other one, `peer` on the summary) would need a second
   * branch for it; that is a different feature wearing this one's slug. `ChatValidationError`, a
   * 400 - the input is wrong for anyone who sends it. Also refused: an id carrying ':' (see
   * `DIRECT_SLUG_PREFIX` - the derivation is only unambiguous within the id alphabet).
   *
   * The peer is a `users.id` validated by the CALLER against the directory - users live in the
   * warehouse, and this store cannot see them.
   *
   * Emits `room.created` to the room's readers ONLY when a room was actually created - which for a
   * DM means exactly the two of them, so the peer's sidebar grows live. A re-open emits nothing:
   * nothing changed.
   */
  openDirect(opener: ChatSender, peerId: string): ChatRoomSummary {
    if (this.db.inTransaction) {
      throw new Error('ChatStore.openDirect must not run inside an enclosing transaction (publish-after-commit)')
    }
    if (peerId === opener.id) throw new ChatValidationError('a direct message needs two different people')
    for (const id of [opener.id, peerId]) {
      if (id === '' || id.includes(':')) throw new ChatValidationError(`"${id}" is not a user id a direct message can address`)
    }
    const slug = directSlug(opener.id, peerId)
    const result = this.transaction(() => {
      const now = Date.now()
      let room = this.roomBySlugStmt.get(slug) as RoomRow | undefined
      const created = room === undefined
      if (room === undefined) {
        this.insertRoomStmt.run({
          id: randomUUID(),
          slug,
          topic: null,
          // A DM has no display name either: its label is the OTHER person, resolved per viewer
          // against the user directory, so a stored name could only ever be right for one of them.
          name: null,
          kind: 'dm',
          // A DM has no icon and never will: its list row shows the peer's avatar, which is a
          // person rather than an appearance choice either member gets to make for the other.
          icon: null,
          createdBy: opener.id,
          now
        })
        room = this.roomBySlugStmt.get(slug) as RoomRow
      }
      // Head-seeded like every other pointer; on a fresh room the head is 0. OR IGNORE keeps an
      // existing member's pointer untouched - re-opening a DM must not mark it read.
      this.addMemberStmt.run({ roomId: room.id, userId: opener.id, now })
      this.addMemberStmt.run({ roomId: room.id, userId: peerId, now })
      return { created, summary: toSummary(this.summaryStmt.get(opener.id, room.id) as SummaryRow) }
    })
    if (result.created) {
      emitChatEvent({
        ephemeral: true,
        type: 'room.created',
        roomId: result.summary.id,
        userId: null,
        at: result.summary.createdAt
      })
    }
    return result.summary
  }

  /**
   * Rename a room, set its display name, topic or icon. Open to anyone who can read the room.
   *
   * ANYONE, not the creator and not an admin role: `created_by` is a historical fact that a
   * departed creator takes with them, this store has no idea what a role is, and since migration
   * 015 there is no membership to gate on either - every channel is everybody's, so the only gate
   * left is readability, which a channel grants to every principal. A caller that wants a stricter
   * rule layers it on top rather than teaching this file about principals.
   *
   * The edge worth naming: **renaming changes the address.** Slugs are how every client, every MCP
   * call and every saved link names a room, so a rename breaks all of them at once. It is still
   * allowed, because the alternative - a room stuck with a name nobody wanted - is worse; the
   * conflict check keeps it from colliding with a live room.
   *
   * A DM is refused outright (Track 14) rather than field by field: its slug is derived (a rename
   * would break the idempotent address), and it shows the other person rather than a name, topic
   * or icon, so there is nothing for this call to legitimately change. One refusal is one rule;
   * per-field refusals are a checklist the next field forgets. `ChatValidationError` - the input
   * is wrong for either of its two members.
   */
  updateRoom(
    slug: string,
    userId: string,
    patch: {
      slug?: string
      name?: string | null
      topic?: string | null
      icon?: ChatRoomIcon | null
    }
  ): ChatRoomSummary {
    if (this.db.inTransaction) {
      throw new Error('ChatStore.updateRoom must not run inside an enclosing transaction (publish-after-commit)')
    }
    if (patch.slug !== undefined) assertNotDirectSlug(patch.slug)
    const summary = this.transaction(() => {
      const room = this.requireReadableRoom(slug, userId)
      if (room.kind === 'dm') {
        throw new ChatValidationError('a direct message has no name, topic or icon to change')
      }
      const nextSlug = patch.slug ?? room.slug
      if (nextSlug !== room.slug && this.roomBySlugStmt.get(nextSlug)) {
        throw new ChatConflictError(`room "${nextSlug}" already exists`)
      }
      this.updateRoomStmt.run({
        id: room.id,
        slug: nextSlug,
        // `undefined` means "leave it"; an explicit null means "clear it". A bare `??` would
        // conflate the two and make clearing a topic impossible.
        // Same undefined/null split as `topic`, and the same reason: omitted leaves it, an explicit
        // null drops back to the slug being the name.
        name: patch.name === undefined ? room.name : normalizeRoomName(patch.name),
        topic: patch.topic === undefined ? room.topic : patch.topic,
        // Same undefined/null split as `topic`: omitted leaves it, an explicit null clears it back
        // to the client-drawn default.
        icon: patch.icon === undefined ? room.icon : assertRoomIcon(patch.icon),
        now: Date.now()
      })
      return toSummary(this.summaryStmt.get(userId, room.id) as SummaryRow)
    })
    // To READERS, like message.edited: an open room whose header still shows the old name is the
    // same lie a frozen feed tells.
    emitChatEvent({ ephemeral: true, type: 'room.updated', roomId: summary.id, userId: null, at: Date.now() })
    return summary
  }

  /**
   * Destroy a room and everything in it. IRREVERSIBLE, and since migration 015 the ONLY way a room
   * ends: there is no leave and no archive, because every channel is everybody's until it is gone.
   *
   * Open to anyone who can read the room - which for a channel is everyone, and for a DM is its
   * pair and NOT the agent as a guest (`isDirectGuest`): a guest was asked in to answer a question,
   * not to purge the conversation, so the DM branch asks for a member row. A caller that wants a
   * stricter rule for channels (the server does: an API client's delete is held for an in-channel
   * approval) layers it on top rather than teaching this file about principals.
   *
   * `DELETE FROM rooms` cascades to messages (and through them reactions), events, mentions and
   * read-pointer rows; attachments, dismissal tombstones and the agent-session row have no cascade
   * and are deleted first (see `deleteRoomStmt`); the blobs are unlinked after commit by the same
   * refcount rule `deleteMessage` uses, so a screenshot posted in two rooms survives losing one.
   * Migration 015's purge of an abandoned private channel takes exactly this set, by hand.
   *
   * ## Why the outbox rows go, and why that is safe
   *
   * The feed's resume cursor is `events.id`, a GLOBAL autoincrement, and this deletes a scattered
   * subset of it. That is fine: a resuming client asks for `id > cursor` and gets what still
   * exists, so deleted rows are simply absent - never renumbered, never reordered (AUTOINCREMENT
   * guarantees the ids are never handed out again). The room's order-key guard dies with the
   * room it belonged to, and with it every cursor and pointer that was expressed in its space.
   *
   * ## Why the event is routed at EMIT time
   *
   * Every other ephemeral is filtered by `canReadRoom` when the feed yields it. That check reads
   * the rooms table, and by the time this event is published the row is gone - so the check would
   * drop the one message that says the room is gone, and every open tab would keep rendering it.
   * The audience is therefore decided HERE, while the room still exists: a channel's deletion is
   * not a secret and fans out to everyone (`userId: null`, with a matching exemption in the feed);
   * a DM's is told only to the pair captured a moment ago - the one case where the audience has to
   * be read off `room_members`, and the reason `membersOfStmt` still exists.
   */
  deleteRoom(slug: string, actorId: string): ChatRoomDeletion {
    if (this.db.inTransaction) {
      throw new Error('ChatStore.deleteRoom must not run inside an enclosing transaction (publish-after-commit)')
    }
    const result = this.transaction(() => {
      const room = this.requireReadableRoom(slug, actorId)
      if (room.kind === 'dm' && !this.isDirectMember(room.id, actorId)) {
        throw new ChatAccessError('only the two people in a direct message can delete it')
      }
      const audience = room.kind === 'dm' ? (this.membersOfStmt.all(room.id) as MemberRow[]).map((row) => row.user_id) : null
      const messages = (this.messageCountStmt.get(room.id) as { n: number }).n
      const shas = (this.attachmentShasByRoomStmt.all(room.id) as { sha256: string }[]).map((row) => row.sha256)
      this.attachmentsDeleteByRoomStmt.run(room.id)
      this.deleteDismissalsForRoomStmt.run(room.id, room.id)
      this.agentSessionDeleteStmt.run(room.id)
      this.deleteRoomStmt.run(room.id)
      return { roomId: room.id, slug: room.slug, audience, messages, shas }
    })
    // After commit, never inside it - a rollback must resurrect the rows, and the bytes had better
    // still be there when it does. Same ordering rule as deleteMessage.
    const blobs = this.gcAttachmentBlobs(result.shas)
    const at = Date.now()
    const announce = (userId: string | null): void => {
      emitChatEvent({ ephemeral: true, type: 'room.deleted', roomId: result.roomId, userId, at })
    }
    if (result.audience === null) announce(null)
    else for (const userId of result.audience) announce(userId)
    return {
      roomId: result.roomId,
      slug: result.slug,
      messages: result.messages,
      blobs
    }
  }

  /**
   * Server-authoritative send: the sender is always the authenticated principal, never a
   * client-supplied id, and the message row and its outbox event commit in ONE transaction -
   * there is no window in which a message exists without its event or an event without its
   * message. That invariant is what lets the agent be just another writer with no special path.
   *
   * The bus publish happens strictly AFTER the transaction commits (and is refused under an
   * enclosing transaction): publishing from inside would announce an event a rollback then
   * erases.
   *
   * `mentionedUserIds` are REAL Box user ids, already resolved by the caller (the controller
   * intersects parseMentionHandles with the user directory - the store cannot, users live in the
   * warehouse). Their rows ride this same transaction: a mention that survived a rolled-back post
   * would notify someone about a message that never landed.
   *
   * `attachmentIds` are the sender's own un-posted uploads (Track 11), CLAIMED inside this same
   * transaction - the moment message_id lands is the moment the attachment stops being an orphan
   * and its readability flips from uploader-only to the room's readers, so it must be atomic with
   * the message the room is reading it through. A refused claim (unknown or swept id, someone
   * else's upload, already posted) rolls the WHOLE post back: a message that silently dropped the
   * screenshot it was about would be worse than no message.
   */
  post(
    slug: string,
    sender: ChatSender,
    body: string,
    mentionedUserIds: readonly string[] = [],
    attachmentIds: readonly string[] = [],
    meta: ChatMessageMeta | null = null,
    parentId: string | null = null
  ): ChatEvent {
    if (this.db.inTransaction) {
      throw new Error('ChatStore.post must not run inside an enclosing transaction (publish-after-commit)')
    }
    // Deduped, and NEVER the sender: you do not notify yourself, and the sender's pointer is the
    // ordinary head seed below (their own words born read). Computed up front so the row writes
    // and the post-commit fan-out agree on one list.
    let mentioned = [...new Set(mentionedUserIds)].filter((id) => id !== sender.id)
    const attaching = [...new Set(attachmentIds)]
    const event = this.transaction(() => {
      const room = this.requireReadableRoom(slug, sender.id)
      const now = Date.now()
      // In a DM a mention can address only who is already there (Track 14): a mention row is a
      // bell entry and, in a DM, the agent's guest pass, so writing one for a third person would
      // hand a 1:1 to whoever somebody wrote "@dan, ask" to in the wrong window. So the mention
      // set is intersected with the pair: mentioning your peer still writes the bell row and
      // still summons the agent when the peer IS the agent; mentioning anyone else is inert text -
      // no row, no nudge. Reassigned inside the transaction so the row writes and the post-commit
      // fan-out below agree on one list.
      //
      // ONE exception, and it is the agent alone (2026-09-04): "@nova, do X" in a DM between two
      // people has to work, so the agent's mention survives the intersection as a REAL mention -
      // the row is written and the summons is emitted - but the pointer seed below is skipped for
      // every DM mention, so it lands as a GUEST pass and never as a third member row. The rule,
      // its reasons and what it refuses are on `isDirectGuest`.
      if (room.kind === 'dm') {
        mentioned = mentioned.filter((id) => id === systemUserId() || this.isDirectMember(room.id, id))
      }

      // Resolve the thread parent INSIDE the transaction, before anything is allocated: a reply
      // to a message that is not in this room, or does not exist, is a refusal and not a
      // top-level message posted by accident. Replying to a REPLY re-parents onto its root, so
      // the hierarchy stays one level deep (Slack's rule) and "the timeline is the roots" holds.
      let parent: string | null = null
      if (parentId !== null) {
        const target = this.messageByIdStmt.get(parentId, room.id) as MessageRow | undefined
        if (!target) throw new ChatNotFoundError(`no message "${parentId}" in "${slug}" to reply to`)
        parent = target.parent_id ?? target.id
      }

      // The key: issued by the room's guard against `now`, never `now` itself - see issueKeyStmt.
      // It is the message's createdAt, its outbox row's key, its mentions' key, and the seed for
      // every pointer written below, so it is read exactly once here.
      const { head_at: createdAt } = this.issueKeyStmt.get(now, room.id) as { head_at: number }
      // Posting seeds your read pointer. This runs AFTER the key is issued on purpose - the head
      // seed then includes the message being written, so a first-time poster's OWN words are born
      // read. Seeding first would hand every new poster a phantom badge for their own message
      // (and `nova` would accumulate them forever). An EXISTING pointer is untouched by OR IGNORE:
      // a backlog survives posting blind.
      //
      // Never in a DM. Its two member rows are written by `openDirect` and by nothing else: for
      // either of the pair this would be the OR IGNORE no-op anyway, and for the one other sender
      // the gate admits - the agent as a guest (`isDirectGuest`) - it would be the third member
      // row that breaks every two-member rule in this file.
      if (room.kind !== 'dm') this.addMemberStmt.run({ roomId: room.id, userId: sender.id, now })
      const message: ChatMessage = {
        id: randomUUID(),
        roomId: room.id,
        senderId: sender.id,
        senderName: sender.display,
        body,
        createdAt,
        editedAt: null
      }
      // Assigned before the insert AND before the outbox payload is stringified, so the live
      // frame, the stored row and every later history page agree forever about what this message
      // carried. Writing it afterwards would hand the room a card with no buttons until refetch.
      if (meta !== null) message.meta = meta
      // Same rule, same reason: on the payload before it is stringified, so the live frame and
      // every later history page agree about which thread this message belongs to.
      if (parent !== null) message.parentId = parent
      this.insertMessageStmt.run({
        ...message,
        meta: meta === null ? null : JSON.stringify(meta),
        parentId: parent
      })
      // Claim the attachments now that the message row exists (attachments.message_id REFERENCES
      // messages(id), enforced immediately on this connection). The claim statement's WHERE
      // clause IS the authorization - own upload, still orphaned - so zero changes means refused,
      // and the second read below only exists to say WHY honestly. Assigned onto `message`
      // BEFORE the outbox payload is stringified, so the event and history agree forever about
      // what this message carried.
      if (attaching.length > 0) {
        for (const attachmentId of attaching) {
          const claimed = this.attachmentClaimStmt.run({
            messageId: message.id,
            id: attachmentId,
            uploaderId: sender.id
          })
          if (claimed.changes === 0) {
            const existing = this.attachmentByIdStmt.get(attachmentId) as AttachmentJoinRow | undefined
            if (!existing) {
              throw new ChatNotFoundError(
                `no attachment "${attachmentId}" - it was never uploaded, or sat unposted past the orphan window and was swept`
              )
            }
            if (existing.uploader_id !== sender.id) {
              throw new ChatAccessError('only the uploader can attach their upload to a message')
            }
            throw new ChatConflictError(`attachment "${attachmentId}" is already attached to a message`)
          }
        }
        message.attachments = this.attachmentsForMessage(message.id)
      }
      // Being @-mentioned seeds your read pointer so the message that names you is born UNREAD -
      // the one write here that is about the mentioned person's badge rather than the bell.
      // After the message insert because mentions.message_id REFERENCES messages(id) and this
      // connection enforces foreign keys immediately.
      for (const userId of mentioned) {
        // Seeded at createdAt - 1, NOT addMemberStmt's head seed: the head IS createdAt here (the
        // issue above moved it), which would mark the mentioning message itself read. One key
        // before it makes exactly that message the unread item - so somebody who has never
        // opened the room sees a badge of 1 for exactly the message that asked for them, and no
        // badge for the room's whole history. Sound because keys are unique per room: nothing
        // else can sit between createdAt - 1 and createdAt.
        //
        // Not in a DM: a mention there never writes a pointer (the filter above admits only the
        // pair, for whom this is a no-op, and the agent, for whom the mention row alone IS the
        // grant - a guest pass, see `isDirectGuest`). The row below is written for both.
        if (room.kind !== 'dm') {
          this.addMentionedMemberStmt.run({ roomId: room.id, userId, now, lastReadAt: createdAt - 1 })
        }
        this.insertMentionStmt.run({ messageId: message.id, userId, roomId: room.id, createdAt })
      }
      const info = this.insertEventStmt.run({
        roomId: room.id,
        type: 'message.created',
        payload: JSON.stringify(message),
        actorId: sender.id,
        createdAt
      })
      return {
        id: Number(info.lastInsertRowid),
        roomId: room.id,
        type: 'message.created',
        payload: message,
        at: createdAt
      }
    })
    emitChatEvent(event)
    // Strictly AFTER the outbox event, so a client that receives both has already ingested the
    // message the mention points at. One per mentioned user, routed by userId like member.read -
    // who was mentioned is nobody else's business. Row-less on the OUTBOX: the mentions table is
    // the durable record, so a missed ephemeral converges on the next bell fetch.
    for (const userId of mentioned) {
      emitChatEvent({
        ephemeral: true,
        type: 'mention.created',
        roomId: event.roomId,
        userId,
        payload: event.payload,
        at: event.at
      })
    }
    return event
  }

  /**
   * One room's messages, paging BACKWARDS from `before` but returned OLDEST-FIRST so the client
   * appends/prepends without sorting. `nextCursor` is the `before` for the next older page; null
   * means this page reaches the start of the room.
   */
  history(
    slug: string,
    userId: string,
    query: { before?: number; limit?: number; roots?: boolean } = {}
  ): ChatHistoryPage {
    const room = this.requireReadableRoom(slug, userId)

    const limit = Math.max(1, Math.min(query.limit ?? HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT))
    // `roots` is OPT-IN, and that is the whole compatibility story for threads: the default page
    // is every message in key order exactly as before, so the agent's memory, the MCP surface and
    // any client that has not learned about threads keep seeing replies inline rather than
    // silently losing them. A client that asks for roots gets a timeline of parents, each
    // carrying a summary of the thread under it, and fetches the replies with `thread()`.
    const roots = query.roots === true
    // One extra row is fetched purely to learn whether an older page exists.
    const rows = (
      query.before === undefined
        ? (roots ? this.pageLatestRootsStmt : this.pageLatestStmt).all(room.id, limit + 1)
        : (roots ? this.pageBeforeRootsStmt : this.pageBeforeStmt).all(room.id, query.before, limit + 1)
    ) as MessageRow[]
    const hasOlder = rows.length > limit
    const page = rows.slice(0, limit).reverse().map(toMessage)
    // One indexed point read per message, not a variable-arity IN (which better-sqlite3 cannot
    // prepare once). At most 200 reads against attachments_message - noise next to the page scan.
    // Assigned only when non-empty, matching the outbox payloads' shape (absent = none).
    for (const message of page) {
      const attachments = this.attachmentsForMessage(message.id)
      if (attachments.length > 0) message.attachments = attachments
      // Reactions arrive WITH history (Track 10), so a reload does not lose them - they live in
      // their own table and are not in the stored outbox payload the live feed replays. Same
      // absent-when-empty rule as attachments, and one more indexed point read per message.
      const reactions = this.reactionsForMessage(message.id)
      if (reactions.length > 0) message.reactions = reactions
      // Only in the grouped shape: in the flat one the replies are already in the page, and
      // hanging a summary off a root there would render the same messages twice.
      if (roots) {
        const summary = this.threadSummary(message.id)
        if (summary !== null) message.thread = summary
      }
    }

    return {
      messages: page,
      nextCursor: hasOlder ? page[0].createdAt : null,
      // From the guard, not MAX(messages.created_at): the head must not rewind when the newest
      // message is deleted, or a client would take a stale head for "nothing new since".
      headAt: room.head_at
    }
  }

  /**
   * One thread, expanded: the root plus every reply under it, oldest-first.
   *
   * Readability is the ROOM's, checked the same way every other read is - a thread is not a
   * separate access surface, it is a shape over messages the caller can already see. `messageId`
   * may name a reply as easily as a root: it resolves to the root either way, so a deep link to
   * any message in a thread opens the whole thread.
   */
  thread(slug: string, userId: string, messageId: string): ChatThreadPage {
    const room = this.requireReadableRoom(slug, userId)
    const target = this.messageByIdStmt.get(messageId, room.id) as MessageRow | undefined
    if (!target) throw new ChatNotFoundError(`no message "${messageId}" in "${slug}"`)
    const rootRow =
      target.parent_id === null
        ? target
        : ((this.messageByIdStmt.get(target.parent_id, room.id) as MessageRow | undefined) ?? target)

    const parent = toMessage(rootRow)
    const summary = this.threadSummary(parent.id)
    if (summary !== null) parent.thread = summary
    const replies = (this.threadRepliesStmt.all(parent.id, THREAD_MAX_REPLIES) as MessageRow[]).map(toMessage)
    for (const message of [parent, ...replies]) {
      const attachments = this.attachmentsForMessage(message.id)
      if (attachments.length > 0) message.attachments = attachments
      const reactions = this.reactionsForMessage(message.id)
      if (reactions.length > 0) message.reactions = reactions
    }
    return { parent, replies }
  }

  /**
   * The collapsed-thread summary for one root, or null when nothing survives under it.
   *
   * Null rather than a zero count on purpose: `ChatMessage.thread` is absent on a message with no
   * thread, so "has a thread" is one presence check for every client, and a thread whose only
   * reply was deleted goes back to reading as an ordinary message instead of an empty disclosure
   * triangle nobody can open.
   */
  private threadSummary(rootId: string): ChatThreadSummary | null {
    const row = this.threadSummaryStmt.get(rootId) as { reply_count: number; last_at: number | null }
    if (row.reply_count === 0 || row.last_at === null) return null
    const participants = (this.threadParticipantsStmt.all(rootId, THREAD_PARTICIPANT_LIMIT) as {
      sender_id: string
    }[]).map((p) => p.sender_id)
    return { replyCount: row.reply_count, lastReplyAt: row.last_at, participants }
  }

  /**
   * One message by id, scoped to its room. Null when it is not there.
   *
   * A raw point read with NO membership check, which is why it is not the history path: its one
   * caller is the chat agent's trigger, which is deciding whether a reply is aimed at IT and has
   * no principal to authorize as. Every reader-facing path goes through `requireReadableRoom`.
   */
  message(roomId: string, messageId: string): ChatMessage | null {
    const row = this.messageByIdStmt.get(messageId, roomId) as MessageRow | undefined
    return row ? toMessage(row) : null
  }

  /**
   * Has `senderId` written anything in this thread - the root itself, or any reply under it?
   *
   * Exists for exactly one rule, and it is a product rule rather than a storage one: a reply in a
   * thread the agent is already part of reaches the agent WITHOUT an @mention, because having to
   * re-summon it in its own thread is the conversational equivalent of re-introducing yourself
   * every sentence. The server asks this before it treats a reply as an ask - see chat-agent.ts.
   */
  threadHasSender(rootId: string, senderId: string): boolean {
    return this.threadHasSenderStmt.get({ rootId, senderId }) !== undefined
  }

  /**
   * Advance this user's read pointer in a room to `at` (a message's createdAt - everything at or
   * before it is read), creating the pointer if this is the first time they have marked the room
   * read. Returns the STORED pointer, clamped to the room head and never moved backwards, plus the
   * server's recount of what is still unread past it.
   *
   * The lazy row is the whole point of migration 015 for a client: there is no join step, so
   * opening a channel for the first time and scrolling to the bottom is what makes unread work in
   * it from then on. Before, a missing row was a 403 ("join first"), because the row was also a
   * subscription. The one room where a first markRead still refuses is a DM the caller is not one
   * of the pair of - the agent as a guest - because a third row there would break the two-member
   * invariant every DM rule rests on (`isDirectGuest`).
   *
   * The recount travels because unread is a COUNT (see VISIBLE_SELECT): a tab cannot derive it
   * from the pointer and the head, since a delete between them shrinks it invisibly. Read through
   * the same summary statement the sidebar uses, in the same transaction as the write, so the
   * number the tabs adopt is exactly the number the next `chatRooms` would show.
   */
  markRead(slug: string, userId: string, at: number): ChatReadState {
    if (this.db.inTransaction) {
      throw new Error('ChatStore.markRead must not run inside an enclosing transaction (publish-after-commit)')
    }
    const result = this.transaction(() => {
      const room = this.requireReadableRoom(slug, userId)
      if (room.kind === 'dm' && !this.isDirectMember(room.id, userId)) {
        throw new ChatAccessError('a guest in a direct message holds no read pointer')
      }
      const row = this.markReadStmt.get({ roomId: room.id, userId, now: Date.now(), at }) as { last_read_at: number }
      const summary = this.summaryStmt.get(userId, room.id) as SummaryRow
      return { roomId: room.id, read: { lastReadAt: row.last_read_at, unread: summary.unread } }
    })
    // Ephemeral fan-out so the user's OTHER tabs drop their badge now instead of at the next
    // refetch. Emitted with the STORED state (post-clamp, monotonic, recounted), so a stale tab
    // acking an old key broadcasts the newer pointer, never a regression.
    emitChatEvent({
      ephemeral: true,
      type: 'member.read',
      roomId: result.roomId,
      userId,
      read: result.read,
      at: Date.now()
    })
    return result.read
  }

  /**
   * Replace a message's body. Only the SENDER may edit, which is stricter than membership on
   * purpose - the room check says you can be here, the sender check says it is yours. A deleted
   * message is not editable because it is not there: `requireMessage` answers not-found.
   *
   * No key is issued and no outbox row is written; the update is announced to the room's readers
   * over the ephemeral bus after commit. See the statement comments above.
   */
  editMessage(slug: string, messageId: string, userId: string, body: string): ChatMessage {
    if (this.db.inTransaction) {
      throw new Error('ChatStore.editMessage must not run inside an enclosing transaction (publish-after-commit)')
    }
    const result = this.transaction(() => {
      const room = this.requireReadableRoom(slug, userId)
      this.requireMessage(room, messageId, userId)
      const row = this.editMessageStmt.get(body, Date.now(), messageId) as MessageRow
      const message = toMessage(row)
      // Editing never touches attachments (like mentions, they resolve at POST time only), but
      // the ephemeral payload REPLACES the client's copy of the message wholesale - so it must
      // carry them, or every edit would visually strip its own screenshots.
      const attachments = this.attachmentsForMessage(messageId)
      if (attachments.length > 0) message.attachments = attachments
      // Reactions for exactly the same reason, and they can be carried truthfully only because
      // `ChatReactionGroup` has no reader-dependent field - one payload is correct for every
      // recipient of the fan-out. See the note on `ChatMessage.reactions`.
      const reactions = this.reactionsForMessage(messageId)
      if (reactions.length > 0) message.reactions = reactions
      return message
    })
    this.emitMessageEphemeral('message.edited', result)
    return result
  }

  /**
   * HARD-delete a message, and for a thread root the whole thread under it (migration 010).
   *
   * Nothing survives that could render, replay or recover it: the row, its outbox row (the leak
   * this change was made for - see deleteEventStmt), its attachments (rows now, unreferenced
   * blobs after commit) and its bell tombstones go in one transaction, and its mentions go by
   * the cascade on mentions.message_id. Nothing structural needs a tombstone any more: unread is
   * a count over surviving rows, a history cursor is a bare key compared with `<`, and the room's
   * guard never rewinds, so a retired key can never be issued again.
   *
   * ## The cascade
   *
   * Deleting a ROOT deletes every reply under it, whoever wrote them - the authorization is the
   * root's (the sender, or a moderator), and a reply is not consulted. The decision: a thread is
   * one unit, and a headless thread has nowhere to render. Done EXPLICITLY, replies first, rather
   * than by an `ON DELETE CASCADE` on parent_id, for two reasons: the constraint is enforced
   * immediately on this connection (deleting the root first would fail), and a database-level
   * cascade would silently skip the per-message bookkeeping - the outbox row and the attachment
   * rows have no cascade of their own, on purpose, so that forgetting them is a loud foreign-key
   * error rather than a quiet leak.
   *
   * ## The agent's context
   *
   * If the agent wrote any of what went, the room's `agent_sessions` row is deleted too, so the
   * next turn starts a fresh worker session instead of continuing a conversation whose visible
   * half no longer exists. Note the blast radius: the session is per ROOM (one conversation per
   * channel is the scope decision), so this resets the agent's continuity for the whole room,
   * not just the thread - and with the row goes the room's turn budget. The worker's own
   * transcript lives in ANOTHER process; this only drops the pointer to it, and the server module
   * that holds the live handle reacts to the `message.deleted` frame (chat-agent.ts) by retiring
   * the session on the worker side.
   *
   * ## What is announced
   *
   * One `message.deleted` ephemeral per deleted message, root FIRST and then the replies
   * oldest-first, each carrying an identity-only payload (see `toDeletedFrame`). Per message
   * rather than one frame listing ids so that a single delete and a cascade need one client
   * handler between them; root-first so a client that drops the root and its thread on the first
   * frame finds nothing left to do for the rest. All after commit - a rollback must not have been
   * announced.
   *
   * Not idempotent, and cannot be: a deleted message is indistinguishable from one that never
   * existed, so a repeat delete answers not-found like any other unknown id.
   */
  deleteMessage(
    slug: string,
    messageId: string,
    userId: string,
    options: { anySender?: boolean } = {}
  ): ChatMessageDeletion {
    if (this.db.inTransaction) {
      throw new Error('ChatStore.deleteMessage must not run inside an enclosing transaction (publish-after-commit)')
    }
    const result = this.transaction(() => {
      const room = this.requireReadableRoom(slug, userId)
      const target = this.requireMessage(room, messageId, userId, options.anySender ?? false)
      const replies = target.parent_id === null ? (this.threadRepliesAllStmt.all(target.id) as MessageRow[]) : []
      const shas: string[] = []
      // Replies before the root: parent_id REFERENCES messages(id) is enforced as each statement
      // runs, and attachments.message_id likewise - so the order inside each iteration matters
      // too (attachment rows before the message row).
      for (const row of [...replies, target]) {
        for (const attachment of this.attachmentsForMessage(row.id)) shas.push(attachment.sha256)
        this.attachmentsDeleteByMessageStmt.run(row.id)
        this.deleteEventStmt.run(row.room_id, row.created_at)
        this.deleteDismissalsForMessageStmt.run(`mention:${row.id}`, `message:${row.id}`)
        this.deleteMessageRowStmt.run(row.id)
      }
      const agentInvolved = [target, ...replies].some((row) => row.sender_id === systemUserId())
      if (agentInvolved) this.agentSessionDeleteStmt.run(room.id)
      return { roomId: room.id, rows: [target, ...replies], shas, agentInvolved }
    })
    // After commit, never inside it: a rollback must resurrect the rows, and the bytes had
    // better still be there when it does.
    const blobs = this.gcAttachmentBlobs(result.shas)
    for (const row of result.rows) this.emitMessageEphemeral('message.deleted', toDeletedFrame(row))
    return {
      roomId: result.roomId,
      messageId,
      deleted: result.rows.map((row) => row.id),
      blobs,
      agentSessionDropped: result.agentInvolved
    }
  }

  // --- The chat agent (Track 15). The server module owns the sockets and the lifecycle; what
  // lives here is the durable row behind them and the one write path an agent turn uses.

  /** This room's agent session row, or null if the room has never talked to the agent. */
  agentSession(roomId: string): ChatAgentSession | null {
    const row = this.agentSessionGetStmt.get(roomId) as AgentSessionRow | undefined
    return row ? toAgentSession(row) : null
  }

  /** Create or replace a room's agent session row wholesale. `updatedAt` is stamped here. */
  agentSessionSave(session: Omit<ChatAgentSession, 'updatedAt'>): ChatAgentSession {
    const saved: ChatAgentSession = { ...session, updatedAt: Date.now() }
    this.agentSessionUpsertStmt.run(saved)
    return saved
  }

  /** Forget a room's agent session - the handle died, or the session was closed for idleness. */
  agentSessionDelete(roomId: string): void {
    this.agentSessionDeleteStmt.run(roomId)
  }

  /** Every room that was mid-turn. Restart recovery's only question, asked once at boot. */
  agentSessionsStreaming(): ChatAgentSession[] {
    return (this.agentSessionsStreamingStmt.all() as AgentSessionRow[]).map(toAgentSession)
  }

  /**
   * Every card of one kind still claiming to be pending. Asked once per kind, at boot.
   *
   * After a restart every one of them is LYING: what they name lived in the last process's memory
   * - a worker socket for an `approval` card, the held operation for a `chat-op` card - and nothing
   * here can answer it any more. A card left saying "pending" is worse than one saying "expired" -
   * it renders live buttons that answer nothing, forever. Each kind's owner sweeps its own, which
   * is why this takes the kind rather than returning everything.
   */
  pendingCards(kind: ChatMessageMeta['kind']): ChatMessage[] {
    return (this.pendingCardsStmt.all(kind) as MessageRow[]).map(toMessage)
  }

  /**
   * How many messages a room holds - the same count `deleteRoom` reports, so a card that says
   * "132 messages" and the purge that follows agree.
   */
  messageCount(roomId: string): number {
    return (this.messageCountStmt.get(roomId) as { n: number }).n
  }

  /**
   * Write an agent message's body in place, without any of the things an EDIT means.
   *
   * The one write path a turn uses, for both its periodic checkpoints and its final text, and it
   * exists as its own method rather than reusing `editMessage` for two independent reasons:
   *
   * 1. `editMessage` stamps `edited_at`, and the clients render "(edited)" off `editedAt !== null`
   *    - so every agent answer would wear an edit marker it did not earn, on every message,
   *    forever.
   * 2. `editMessage`'s authorization is a USER acting on their own words through an HTTP route.
   *    This is the server writing into a message it created moments ago on nobody's behalf. Two
   *    different questions; conflating them would put the user-facing route's rules in the middle
   *    of the streaming loop.
   *
   * Deliberately server-internal and on NO HTTP surface. `roomId` and `senderId` are both matched
   * in the statement, so a caller cannot rewrite another sender's message or reach into another
   * room by passing a guessed id; a deleted placeholder matches nothing (someone deleted it
   * mid-turn, and the delete must win).
   *
   * Emits NOTHING - not an outbox row (an outbox row is a `message.created` to every client, the
   * invariant the whole ephemeral family exists to protect) and not an ephemeral. Announcing the
   * new body is the caller's business, because a checkpoint every few seconds and a finalize are
   * the same write with very different fan-out.
   *
   * Returns the stored row, or null when nothing matched.
   */
  /**
   * The body of a message this sender wrote in this room, or null if there is no such live message.
   *
   * The counterpart to `checkpointBody` and authorized by the same statement shape, so it cannot
   * read another sender's words or reach into another room. It exists for exactly one caller:
   * restart recovery, which must know whether a streaming placeholder still holds "…" or already
   * holds an answer the room was reading.
   */
  agentBody(roomId: string, messageId: string, senderId: string): string | null {
    const row = this.agentBodyStmt.get({ roomId, messageId, senderId }) as { body: string } | undefined
    return row?.body ?? null
  }

  /**
   * Delete an agent placeholder that never got written into. Returns true if a row went.
   *
   * The approval card's other half (2026-09-09). When a card is posted mid-turn the server closes
   * the row the turn was writing into and opens a fresh one BELOW the card, so the decision sits
   * where it happened. If the row being closed is still the untouched "…" it must not be left
   * standing: an empty typing bubble above the card, which the turn's next sentence would then
   * fill in - putting the text back above the decision, which is the exact bug the split exists to
   * fix. Two cards in a row would strand one per card.
   *
   * NOT `deleteMessage`, and the difference is the whole reason this exists. That one drops the
   * room's `agent_sessions` row whenever the agent wrote any of what went - correct for a human
   * deleting nova's answer (the visible half of the conversation is gone, so the worker's half
   * should go too), catastrophic here: it would take the LIVE turn's budget counters and session
   * pointer with it, mid-turn, every time a card was posted.
   *
   * Guarded on all five of room, id, sender, exact body and childlessness, so it can only ever
   * reach a placeholder this server posted moments ago and nobody has touched. `body` is passed in
   * rather than hardcoded because the placeholder string belongs to the agent module that writes
   * it, not to the store.
   *
   * Announces `message.deleted`, exactly as `deleteMessage` does and for the same reason: a client
   * holding the row has to drop it, and its unread arithmetic keys off that frame.
   */
  discardAgentPlaceholder(roomId: string, messageId: string, senderId: string, body: string): boolean {
    if (this.db.inTransaction) {
      throw new Error('ChatStore.discardAgentPlaceholder must not run inside an enclosing transaction')
    }
    const row = this.transaction(() => {
      const target = this.messageByIdStmt.get(messageId, roomId) as MessageRow | undefined
      if (target === undefined || target.sender_id !== senderId || target.body !== body) return null
      // A placeholder somebody replied to, or that somehow carries an attachment, is no longer a
      // placeholder - it is a message in a conversation, and deleting it would take the reply's
      // parent out from under it (or orphan a blob).
      if ((this.threadRepliesAllStmt.all(target.id) as MessageRow[]).length > 0) return null
      if (this.attachmentsForMessage(target.id).length > 0) return null
      this.deleteEventStmt.run(target.room_id, target.created_at)
      this.deleteDismissalsForMessageStmt.run(`mention:${target.id}`, `message:${target.id}`)
      this.deleteMessageRowStmt.run(target.id)
      return target
    })
    // After commit, never inside it - the publish-after-commit rule the whole ephemeral family holds.
    if (row === null) return false
    this.emitMessageEphemeral('message.deleted', toDeletedFrame(row))
    return true
  }

  checkpointBody(roomId: string, messageId: string, senderId: string, body: string): ChatMessage | null {
    const row = this.checkpointBodyStmt.get({ roomId, messageId, senderId, body }) as MessageRow | undefined
    return row ? toMessage(row) : null
  }

  /**
   * Move an approval card to its next state: body and meta together, in one write (Track 19).
   *
   * The two must move together or the room reads a lie - a body saying "approved by alice" beside
   * a meta still saying `pending` is a card that renders live buttons under a settled decision.
   * Same authorization, same no-edited_at rule and same silent-on-refusal contract as
   * `checkpointBody`, for the same reasons.
   *
   * The CALLER owns the one-way rule (`pending` -> resolved, never back). It is not enforced here
   * because the statement would have to parse JSON to check it, and the caller - the single
   * server module that owns the request - is where the live decision actually is.
   */
  checkpointCard(
    roomId: string,
    messageId: string,
    senderId: string,
    body: string,
    meta: ChatMessageMeta
  ): ChatMessage | null {
    const row = this.checkpointCardStmt.get({
      roomId,
      messageId,
      senderId,
      body,
      meta: JSON.stringify(meta)
    }) as MessageRow | undefined
    return row ? toMessage(row) : null
  }

  /**
   * Feed replay: every event with a global id after `cursor` in rooms the user can read, oldest
   * first. READABLE_PREDICATE is the room-scoped authorization.
   */
  eventsAfter(cursor: number, userId: string, limit: number): ChatEvent[] {
    return (this.eventsAfterStmt.all(userId, cursor, limit) as EventRow[]).map(toEvent)
  }

  /** Highest global event id written, or 0 on an empty outbox - the live high-water mark. */
  latestEventId(): number {
    return (this.latestEventIdStmt.get() as { id: number }).id
  }

  /**
   * The bell's mention stratum: this user's mentions, newest first, joined to their message and
   * room. A deleted message's mention disappears with it (the row cascades), and so does a
   * mention in a room the user cannot READ - READABLE_PREDICATE reused, not copied: the bell must
   * not serve words the room itself would refuse.
   */
  mentionsFor(userId: string, limit: number): ChatMentionRow[] {
    return (this.mentionsForStmt.all(userId, limit) as MentionJoinRow[]).map(toMentionRow)
  }

  /**
   * The bell's recent-messages stratum: what happened lately in every room the user can read -
   * every channel and their own DMs - minus their own words. Readability rather than a
   * subscription since migration 015, because there is no subscription any more: see the note on
   * `recentForStmt` for the widening that implies. `unread` is the sidebar's rule applied per row.
   */
  recentMessagesFor(userId: string, limit: number): ChatRecentMessageRow[] {
    return (this.recentForStmt.all(userId, userId, limit) as RecentJoinRow[]).map(toRecentRow)
  }

  /**
   * Stamp seen_at on this user's unseen mentions - all of them, or one message's when given.
   * Idempotent via the seen_at IS NULL guard (a restamp would turn "when the bell first showed
   * it" into "the last time anything asked"). Returns the number of rows actually stamped. A
   * single UPDATE, so no transaction and no ephemeral here: the bell's other tabs converge on
   * their next fetch, and per-row seen state is not worth a live fan-out (unlike the room badge,
   * nothing else on screen derives from it).
   */
  markMentionsSeen(userId: string, messageId?: string): number {
    const now = Date.now()
    const info =
      messageId === undefined
        ? this.markMentionSeenAllStmt.run(now, userId)
        : this.markMentionSeenOneStmt.run(now, userId, messageId)
    return info.changes
  }

  /** The bell's badge: unseen mentions under exactly mentionsFor's filters, so the count always
   *  equals what the list would show. */
  unseenMentionCount(userId: string): number {
    return (this.unseenMentionCountStmt.get(userId) as { n: number }).n
  }

  /** The per-(user, source) notification watermark - 0 when never set, meaning "nothing seen". */
  notificationWatermark(userId: string, source: string): number {
    const row = this.watermarkGetStmt.get(userId, source) as { seen_through: number } | undefined
    return row?.seen_through ?? 0
  }

  /** UPSERT the watermark, MONOTONIC (MAX in the upsert): a stale tab acking an old high-water
   *  mark must never resurrect a badge - markRead's rule, applied to cross-engine sources. */
  setNotificationWatermark(userId: string, source: string, seenThrough: number): void {
    this.watermarkSetStmt.run(userId, source, seenThrough)
  }

  /**
   * Dismiss ONE bell item. `itemId` is the bell's own id (`mention:<id>` / `message:<id>` /
   * `alert:<id>`), which is what lets a single verb work across both engines.
   *
   * Dismissing is stronger than seeing and does NOT imply the message was read: it never touches
   * `room_members.last_read_at`. Throwing a notification away must not mark a room read - the
   * sidebar badge answers a different question, and only opening a room may clear it.
   */
  dismissNotification(userId: string, itemId: string): void {
    this.dismissStmt.run(userId, itemId, Date.now())
  }

  /** Every item id this user has dismissed and that the clear-watermark has not already subsumed. */
  dismissedNotifications(userId: string): string[] {
    return (this.dismissedStmt.all(userId) as { item_id: string }[]).map((r) => r.item_id)
  }

  /**
   * Clear the whole bell: everything at or before `through` is dismissed by watermark.
   *
   * A watermark rather than a tombstone per row, for two reasons. It is O(1) instead of O(items),
   * and - the real one - it covers items the client never saw. Writing one row per VISIBLE item
   * would leave anything just past the feed limit to reappear the moment something scrolled it
   * into range, which is not what "clear all" means to the person who pressed it.
   *
   * The prune runs in the same transaction: once the watermark passes them, existing tombstones
   * are redundant, and this is the only thing that ever shrinks that table.
   */
  clearNotifications(userId: string, through: number): void {
    this.transaction(() => {
      this.watermarkSetStmt.run(userId, 'dismiss', through)
      // Prune against the STORED watermark, not the argument: setNotificationWatermark is
      // monotonic, so a stale caller's smaller `through` must not delete tombstones that the
      // real (higher) watermark does not actually cover.
      this.dismissPruneStmt.run(userId, this.notificationWatermark(userId, 'dismiss'))
    })
  }

  private requireRoomRow(slug: string): RoomRow {
    const row = this.roomBySlugStmt.get(slug) as RoomRow | undefined
    if (!row) throw new ChatNotFoundError(`no room "${slug}"`)
    return row
  }

  /** The message, if it is in this room AND this user wrote it. Ownership is the authorization for
   *  a mutation of someone's own words; membership (checked separately) only opens the door. */
  /**
   * The message, plus the authorship rule.
   *
   * `anySender` is the MODERATION door and is only ever set from a role-gated controller path. It
   * exists for delete and NOT for edit, which is a deliberate asymmetry rather than an omission:
   * a deleted message renders as "This message was deleted" and says plainly that something was
   * removed, while an edited one keeps its author's name and avatar over words they did not write,
   * marked with nothing but "(edited)". Deleting somebody else's message is moderation; editing it
   * is forgery, and no ops need has been worth building that.
   */
  private requireMessage(room: RoomRow, messageId: string, userId: string, anySender = false): MessageRow {
    const row = this.messageByIdStmt.get(messageId, room.id) as MessageRow | undefined
    if (!row) throw new ChatNotFoundError(`no message "${messageId}" in "${room.slug}"`)
    if (!anySender && row.sender_id !== userId) {
      throw new ChatAccessError('only the sender can edit or delete a message')
    }
    return row
  }

  /** Fan a row out to the room's READERS (userId null = the server applies canReadRoom). The
   *  payload carries the message's OWN createdAt, so a client can locate the row it names. */
  private emitMessageEphemeral(type: 'message.edited' | 'message.deleted', message: ChatMessage): void {
    emitChatEvent({
      ephemeral: true,
      type,
      roomId: message.roomId,
      userId: null,
      payload: message,
      at: Date.now()
    })
  }

  /**
   * Room lookup and the read gate in one step - THE readability rule in its TS form (the SQL twin
   * is READABLE_PREDICATE). A channel is readable by any principal, and only a DM consults
   * room_members, so this is the single place the channel/DM branch lives. Every store method
   * that takes a slug opens with it.
   *
   * Plus the one exception, OR-ed on after membership and consulted only when membership says no:
   * the agent as a guest in a DM it has been mentioned into (`isDirectGuest`). The same OR is on
   * `canReadRoom`, so the two TS gates cannot disagree.
   */
  private requireReadableRoom(slug: string, userId: string): RoomRow {
    const room = this.requireRoomRow(slug)
    if (room.kind === 'dm' && !this.isDirectMember(room.id, userId) && !this.isDirectGuest(room.id, userId)) {
      throw new ChatAccessError(`"${slug}" is a direct message between two other people`)
    }
    return room
  }
}

// --- process-wide store ---------------------------------------------------------------------------

let store: ChatStore | null = null

/** The lazily opened process-wide store at chatPath(). Tests construct ChatStore directly. */
export function chatStore(): ChatStore {
  store ??= new ChatStore(chatPath())
  return store
}

/** Close the process-wide store (server shutdown). Safe to call when never opened. */
export function closeChatStore(): void {
  store?.close()
  store = null
}
