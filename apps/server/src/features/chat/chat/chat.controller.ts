import { createReadStream, existsSync } from 'node:fs'
import { BadRequestException, Body, Catch, ConflictException, Controller, ForbiddenException, Get, NotFoundException, Param, PayloadTooLargeException, Post, Query, Req, Res, UnauthorizedException, UnsupportedMediaTypeException, UseFilters, UseGuards, UseInterceptors, UploadedFile, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { drain, executeRecorded, ChatAccessError, ChatConflictError, ChatNotFoundError, ChatValidationError, CHAT_REACTION_EMOJI, chatOpNeedsApproval, CHAT_ROOM_ICONS, CHAT_ROOM_NAME_MAX, type ChatRoomIcon, systemUserId, chatStore, onChatEvent, parseMentionHandles, readUsers, type AgentActivityFrame, type ChatBusEvent, type ChatEvent, type ChatMessage, type ChatReactionEvent, type Principal } from '@silkweave/box-core'
import { chatAgentStatus, decideApproval } from '../chat-agent.js'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { assertAdmin, type PrincipalRequest } from '../../../auth/auth.decorators.js'
import { requestChatOp } from './chat-op-approvals.js'

/** Keepalive cadence for the feed, mirroring the changes feed: a `ping` frame when the outbox is
 *  quiet, so idle SSE connections aren't reaped by intermediaries and dead ones surface. */
const PING_MS = 45_000

/** Replay page size for a resuming feed - bounded so one reconnect can't monopolize the loop. */
const REPLAY_BATCH = 200

// --- attachments (Track 11): the upload-surface limits. REFUSALS, never truncations - an
// attachment that arrived smaller or different from what was sent is corruption with a 200 on it.
// Both live at the HTTP surface, not in ChatStore, so an admin script or migration can still
// hand the store anything (the store comment says the same from its side).

/** 25 MB. Screenshots are hundreds of KB; this admits a short screen recording and refuses the
 *  "I attached the whole build folder" class, which is what a chat upload cap is actually for. */
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024

/** Image types every browser renders - served inline; everything else is served as a download. */
const ATTACHMENT_INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * The allowlist: images plus the file shapes this team actually trades (logs, exports, recordings,
 * archives). ALLOW, never deny-list: the dangerous set is open-ended and grows with the platform.
 * `text/html` and `image/svg+xml` are the deliberate exclusions - both execute script when a
 * browser renders them from an origin, which would turn "paste a screenshot" into a stored-XSS
 * surface. Two more layers back this up even for a lying declared type: the global
 * X-Content-Type-Options: nosniff (setSecurityHeaders in main.ts) stops the browser second-
 * guessing the served Content-Type, and non-image types go out as Content-Disposition attachment.
 */
const ATTACHMENT_ALLOWED_MIME = new Set([
  ...ATTACHMENT_INLINE_MIME,
  'image/heic', // iPhone camera default; browsers cannot render it, so it serves as a download
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/zip',
  'application/gzip',
  'video/mp4',
  'video/quicktime',
  'audio/mpeg'
])

/** The verbatim size refusal - the one message for the cap, wherever the cap trips. */
const ATTACHMENT_SIZE_REFUSAL = `attachments are capped at ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB - this file is larger`

/** The slice of multer's memory-storage file the upload route touches - structural, because this
 *  codebase deliberately imports no express/multer types (same stance as main.ts and the avatar
 *  proxy's RawResponse). */
interface MultipartUpload {
  originalname: string
  mimetype: string
  size: number
  buffer: Buffer
}

/** The slice of Express's Response the attachment serve route touches: header writes plus the
 *  writable-stream half that createReadStream pipes into. */
interface AttachmentStreamResponse extends NodeJS.WritableStream {
  setHeader(name: string, value: string): void
}

/** The slice the size filter needs to answer a refusal by hand (filters bypass Nest's renderer). */
interface RefusalResponse {
  status(code: number): { json(body: unknown): void }
}

/**
 * Rewrites multer's size abort into the verbatim cap refusal. Multer enforces `limits.fileSize`
 * mid-stream (the request is cut off at the cap rather than buffered whole - that is why the cap
 * belongs in multer and not in a handler-side length check), but its refusal surfaces as a bare
 * "File too large" 413 thrown by the interceptor, BEFORE the handler can say anything better.
 * This filter is the only seam that message passes through, so the user hears the actual cap.
 */
@Catch(PayloadTooLargeException)
class AttachmentSizeFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<RefusalResponse>()
    res.status(413).json({ statusCode: 413, message: ATTACHMENT_SIZE_REFUSAL, error: 'Payload Too Large' })
  }
}

/**
 * A Content-Disposition value that survives hostile filenames. The quoted `filename` fallback is
 * ASCII with quotes/control bytes stripped (a raw `"` or newline in a header is a header-injection
 * shape); the RFC 5987 `filename*` carries the real UTF-8 name, percent-encoded, including the
 * four characters encodeURIComponent leaves bare but 5987 does not allow.
 */
function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file'
  const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

/** Strip a client filename down to display data: no directories (a name is never a path here,
 *  but a `../` in a download prompt is still a lie), no control bytes, bounded length. */
function sanitizeFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex -- matching control characters IS the sanitization
  const clean = base.replace(/[\x00-\x1f\x7f]/g, '').trim()
  return (clean === '' ? 'file' : clean).slice(0, 255)
}

// DTOs document the REST/Swagger surface and drive the generated tRPC input/output types, exactly
// like the sink/content controllers.

class ChatRoomDto {
  @ApiProperty() id!: string
  @ApiProperty() slug!: string
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      "The room's DISPLAY name - free-form, may hold capitals, spaces and punctuation the slug cannot. Null means nobody set one: show the slug. NEVER address a room by this - it is not unique and nothing resolves it; `slug` is the address. Always null on a DM, which is labelled by its peer",
  })
  name!: string | null
  @ApiProperty({ required: false, nullable: true }) topic!: string | null
  @ApiProperty({
    enum: ['room', 'dm'],
    description:
      "`room` is a named channel, readable and writable by EVERY user - there is no join step and no member list. `dm` is a direct message: exactly two members, slug derived from the pair (`dm:<a>:<b>`) - render it under its own section, sorted by headAt, showing `peer` rather than slug or topic. A DM cannot be renamed or reshaped (400)",
  })
  kind!: string
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'The room\'s lucide icon name, kebab-case, from the curated CHAT_ROOM_ICONS list in @silkweave/box-core. Null means nobody picked one - draw `hash`. Always null on a DM, which shows the peer\'s avatar instead',
  })
  icon!: string | null
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      "DM only: the OTHER member's users.id (the one who is not you). Resolve the display name and avatar through the user directory you already hold. Null on a named room",
  })
  peer!: string | null
  @ApiProperty({
    description:
      "The room's head: the newest order key (a message createdAt) it has ever issued. Equal to the newest message's createdAt unless that message was since deleted; never moves backwards. 0 for an empty room",
  })
  headAt!: number
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'The createdAt through which this user has read (every message at or before it is read). Null when they have never read here - the pointer is written on the first markRead',
  })
  lastReadAt!: number | null
  @ApiProperty({
    description:
      'A server COUNT of surviving messages with createdAt > lastReadAt. Adopt it, never derive it: a delete shrinks it with no arithmetic a client could reproduce. 0 while lastReadAt is null - a room you have never opened does not owe you its whole history as a badge',
  })
  unread!: number
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'The newest surviving message in the room, or null in an empty one: { senderId, senderName, preview, at }. `preview` is a bounded excerpt (140 chars, whitespace collapsed), empty for an attachment-only message. `at` is that message\'s createdAt - the real last-activity time, unlike headAt, which is an allocator guard that outlives the message it was issued for',
  })
  lastMessage!: { senderId: string; senderName: string; preview: string; at: number } | null
}
class ChatRoomsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [ChatRoomDto] }) rooms!: ChatRoomDto[]
}
class ChatAttachmentDto {
  @ApiProperty() id!: string
  @ApiProperty({ required: false, nullable: true, description: 'Null until a post claims it (the orphan window)' })
  messageId!: string | null
  @ApiProperty() uploaderId!: string
  @ApiProperty({ description: 'Display name and download filename - never a path' }) filename!: string
  @ApiProperty() mime!: string
  @ApiProperty() bytes!: number
  @ApiProperty({ description: 'Content address of the bytes on disk - identical uploads share one blob' })
  sha256!: string
  @ApiProperty() createdAt!: number
}
class ChatMessageDto {
  @ApiProperty() id!: string
  @ApiProperty() roomId!: string
  @ApiProperty() senderId!: string
  @ApiProperty({ description: "The sender's display name at write time (survives renames)" }) senderName!: string
  @ApiProperty() body!: string
  @ApiProperty({
    description:
      'THE order key: epoch ms, unique per room, strictly increasing in posting order - the history cursor currency (`before`), the read pointer currency (`chatMarkRead.at`), and the sort key. Issued by a per-room monotonic guard, not read off the clock: two posts in one millisecond get consecutive values, and after a backwards clock step it runs ahead of wall time until the clock catches up',
  })
  createdAt!: number
  @ApiProperty({ required: false, nullable: true }) editedAt!: number | null
  @ApiProperty({
    required: false,
    description: 'The root message this one replies to. Absent on a root - a thread is one level deep'
  })
  parentId?: string
  @ApiProperty({
    required: false,
    description:
      'Summary of the thread under this root: `{ replyCount, lastReplyAt, participants }`, where lastReplyAt is the newest reply\'s createdAt. Absent when there is none, and only ever present in the grouped shape (`roots: true`)'
  })
  thread?: unknown
  @ApiProperty({
    required: false,
    type: [ChatAttachmentDto],
    description: 'Present only when the message has attachments. Metadata only - bytes come from GET /api/chat/attachments/:id'
  })
  attachments?: ChatAttachmentDto[]
  @ApiProperty({
    required: false,
    description:
      'Reactions grouped by emoji: `[{ emoji, users, count }]`, palette order. Absent when there are none. There is no `mine` flag on purpose - the shape is reader-independent so one fan-out payload is correct for everybody; ask `users.includes(you)`'
  })
  reactions?: unknown
}
class ChatHistoryDto {
  @ApiProperty({ type: [ChatMessageDto], description: 'Oldest-first, ready to render top-down' })
  messages!: ChatMessageDto[]
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'The createdAt to pass as `before` for the next OLDER page; null at the start of the room. A bare number: it stays valid if the message it came from is deleted',
  })
  nextCursor!: number | null
  @ApiProperty({ description: "The room's head - see ChatRoomDto.headAt" }) headAt!: number
}
class ChatPostResultDto {
  @ApiProperty({ description: 'Global outbox id of the committed event - a feed resume cursor' }) cursor!: number
  @ApiProperty({ type: ChatMessageDto }) message!: ChatMessageDto
}
/** The read state after a markRead, and the payload of the `member.read` feed frame. */
class ChatReadStateDto {
  @ApiProperty({ description: 'The stored pointer after clamping (never past headAt, never backwards)' })
  lastReadAt!: number
  @ApiProperty({ description: 'The server recount of surviving messages past that pointer - adopt it' })
  unread!: number
}
/** What a delete destroyed. Hard delete; a thread root cascades to every reply under it. */
class ChatMessageDeletionDto {
  @ApiProperty() roomId!: string
  @ApiProperty({ description: 'The message you named' }) messageId!: string
  @ApiProperty({
    type: [String],
    description:
      'Every message id that went: the named one first, then (for a root) its replies oldest-first. Same order as the message.deleted feed frames',
  })
  deleted!: string[]
  @ApiProperty({ description: 'Attachment blobs whose last reference went with these messages' }) blobs!: number
  @ApiProperty({
    description:
      "True when the agent had written in what was deleted: the room's agent session was dropped, so its next turn starts fresh (per ROOM, not per thread)",
  })
  agentSessionDropped!: boolean
}
/** One frame of the multiplexed live feed. `id` is the global resume cursor; `hello` carries the
 *  subscriber's starting cursor, `ping` is keepalive, `member.read` /
 *  `room.created` / `room.updated` / `room.deleted` / `message.edited` /
 *  `message.deleted` / `mention.created` / `agent.activity` / `reaction.added` / `reaction.removed`
 *  are ephemerals (their `id` is the
 *  current high-water mark, NOT an advance - they have no outbox row and are never replayed),
 *  everything else is an outbox event. Only `message.created` adds a message; `member.read` is the
 *  only frame that carries an unread number, and it is the server's count. `mention.created` is
 *  the one ephemeral with a DURABLE row behind it (the `mentions` table) - the frame is the live
 *  nudge, the row is the record the bell reads. */
class ChatFeedFrameDto {
  @ApiProperty({ description: 'Global outbox id - persist it and resume with `cursor` after a drop' }) id!: number
  @ApiProperty({
    description:
      "'hello' | 'ping' | 'message.created' | 'message.edited' | 'message.deleted' | 'member.read' | 'room.created' | 'room.updated' | 'room.deleted' | 'mention.created' | 'agent.activity' | 'reaction.added' | 'reaction.removed'"
  })
  type!: string
  @ApiProperty({ required: false, nullable: true }) roomId!: string | null
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'message.created / message.edited / mention.created: the stored message (locate it by `payload.id`, order it by `payload.createdAt`). message.deleted: the IDENTITY of the row that went - id, roomId, createdAt, senderId/senderName, parentId - with an empty body and no attachments/meta; one frame per deleted message, a cascade sends the root FIRST then its replies. Null otherwise',
  })
  payload!: ChatMessage | null
  @ApiProperty({
    required: false,
    nullable: true,
    type: ChatReadStateDto,
    description: 'member.read only: the stored pointer and the server recount - adopt both',
  })
  read?: ChatReadStateDto | null
  @ApiProperty({
    required: false,
    nullable: true,
    description: 'agent.activity only: the summarized state of the agent turn anchored at `activity.messageId`',
  })
  activity?: AgentActivityFrame | null
  @ApiProperty({
    required: false,
    nullable: true,
    description:
      "reaction.added / reaction.removed only: `{ messageId, parentId?, userId, emoji, reactions }`. `reactions` is the message's COMPLETE grouped list after the change - adopt it, never increment a local counter, or a dropped frame drifts a number nothing corrects",
  })
  reaction?: ChatReactionEvent | null
  @ApiProperty({ description: 'When the frame was emitted. Not an order key - a message\'s key is payload.createdAt' })
  at!: number
}

class ChatThreadInputDto {
  @ApiProperty({ description: 'Room slug' }) @IsString() @MinLength(1) room!: string
  @ApiProperty({ description: 'Any message in the thread - a root or a reply; both open the whole thread' })
  @IsString()
  @MinLength(1)
  messageId!: string
}
class ChatThreadDto {
  @ApiProperty({ type: ChatMessageDto, description: 'The thread root, carrying its own summary' })
  parent!: ChatMessageDto
  @ApiProperty({ type: [ChatMessageDto], description: 'Oldest-first. A deleted reply is gone, not a tombstone' })
  replies!: ChatMessageDto[]
}
class ChatHistoryInputDto {
  @ApiProperty({ description: 'Room slug' }) @IsString() @MinLength(1) room!: string
  @ApiProperty({ required: false, description: 'Return messages with createdAt strictly BELOW this (from nextCursor)' })
  @IsOptional() @IsInt() @Min(1)
  before?: number
  @ApiProperty({ required: false, description: 'Page size (default 50, max 200)' })
  @IsOptional() @IsInt() @Min(1)
  limit?: number
  @ApiProperty({
    required: false,
    description:
      'Grouped shape: page over thread ROOTS only, each carrying a summary of the replies under it (fetch those with `chat-thread`). Default false returns every message in createdAt order, replies inline'
  })
  @IsOptional()
  @IsBoolean()
  roots?: boolean
}
class ChatPostInputDto {
  @ApiProperty({ description: 'Room slug' }) @IsString() @MinLength(1) room!: string
  // No @MinLength here anymore: an image-only message posts with an empty body. The "body or
  // attachment, one of them" rule lives in the handler - @ValidateIf was rejected because it
  // switches off EVERY validator on the property, string-ness and the length cap included.
  @ApiProperty({ description: 'Message body. May be empty when attachmentIds is non-empty (an image-only message)' })
  @IsString()
  @MaxLength(8000)
  body!: string
  @ApiProperty({
    required: false,
    type: [String],
    description: 'Ids of your own not-yet-posted uploads (POST /api/chat/attachments) to attach to this message'
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  attachmentIds?: string[]
  @ApiProperty({
    required: false,
    description:
      'Reply in the thread of this message id. Naming a reply re-parents onto its root - threads are one level deep'
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  parentId?: string
}
/** Input for `chatAgentStatus` - the mid-turn-join read. */
class ChatAgentStatusInputDto {
  @ApiProperty({ description: 'Room slug' }) @IsString() @MinLength(1) room!: string
}

/** What an agent turn in this room is doing right now, if one is in flight. */
class ChatAgentStatusResultDto {
  @ApiProperty({ description: 'A turn is in flight in this room right now' }) active!: boolean
  @ApiProperty({
    required: false,
    nullable: true,
    description: 'The same shape the `agent.activity` ephemeral carries, or null when idle',
  })
  activity!: AgentActivityFrame | null
}

/** Input for `chatAgentDecision` - answering an approval card (chat Track 19). */
class ChatAgentDecisionInputDto {
  @ApiProperty({ description: 'Room slug' }) @IsString() @MinLength(1) room!: string
  @ApiProperty({ description: "The card's meta.requestId" }) @IsString() @MinLength(1) requestId!: string
  @ApiProperty({
    required: false,
    description:
      "The card's meta.workerSessionId. Supply it: a card left open on screen from a session that has since been replaced is refused rather than answering a fresh turn's question",
  })
  @IsOptional()
  @IsString()
  workerSessionId?: string
  @ApiProperty({ enum: ['approve', 'deny'] }) @IsIn(['approve', 'deny']) action!: 'approve' | 'deny'
  @ApiProperty({ required: false, description: 'Denials only - the refusal reason handed to the model' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string
}

/** What answering an approval did. `detail` is written to be shown to a human verbatim. */
class ChatAgentDecisionResultDto {
  @ApiProperty({ description: 'The decision reached the worker and the card was settled' }) ok!: boolean
  @ApiProperty({ description: 'One honest line: what happened, or why it could not be recorded' })
  detail!: string
}

class ChatMarkReadInputDto {
  @ApiProperty({ description: 'Room slug' }) @IsString() @MinLength(1) room!: string
  @ApiProperty({
    description:
      'The createdAt of the newest message the client has rendered - everything at or before it is read. Clamped to the room head and never moved backwards server-side',
  })
  @IsInt()
  @Min(0)
  at!: number
}
class ChatEditInputDto {
  @ApiProperty({ description: 'Room slug' }) @IsString() @MinLength(1) room!: string
  @ApiProperty({ description: 'Id of the message to edit (must be your own)' })
  @IsString()
  @MinLength(1)
  messageId!: string
  @ApiProperty({ description: 'The replacement body' }) @IsString() @MinLength(1) @MaxLength(8000) body!: string
}
class ChatReactInputDto {
  @ApiProperty({ description: 'Room slug' }) @IsString() @MinLength(1) room!: string
  @ApiProperty({ description: 'Id of the message to react to - anyone\'s, not just your own' })
  @IsString()
  @MinLength(1)
  messageId!: string
  @ApiProperty({
    description: `One of the fixed palette: ${CHAT_REACTION_EMOJI.join(' ')}. Free text is refused - see CHAT_REACTION_EMOJI`,
  })
  @IsString()
  @MinLength(1)
  emoji!: string
  @ApiProperty({
    required: false,
    description: 'True (the default) adds your reaction, false takes it back. Both are idempotent, so a retry converges',
  })
  @IsOptional()
  @IsBoolean()
  on?: boolean
}
class ChatReactionResultDto {
  @ApiProperty() messageId!: string
  @ApiProperty({
    description: "The message's complete reactions after the change, grouped by emoji in palette order: `[{ emoji, users, count }]`",
  })
  reactions!: unknown
}
class ChatDeleteInputDto {
  @ApiProperty({ description: 'Room slug' }) @IsString() @MinLength(1) room!: string
  @ApiProperty({
    description:
      'Id of the message to delete (your own, unless `moderate`). A thread ROOT takes every reply under it, whoever wrote them. Irreversible, and a repeat answers 404',
  })
  @IsString()
  @MinLength(1)
  messageId!: string
  @ApiProperty({
    required: false,
    description: "Delete somebody ELSE's message. Admins only. There is deliberately no equivalent for edit - see ChatStore.requireMessage",
  })
  @IsOptional()
  @IsBoolean()
  moderate?: boolean
}
class ChatRoomCreateInputDto {
  @ApiProperty({ description: 'Room slug - the ADDRESS, e.g. "general". Lowercase letters, digits and dashes' })
  @IsString()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
  slug!: string
  @ApiProperty({
    required: false,
    description: 'Display name, free-form (e.g. "Dev Team"). Omit and the slug is the name. Trimmed; control characters are stripped',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CHAT_ROOM_NAME_MAX)
  name?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) topic?: string
  @ApiProperty({
    required: false,
    enum: [...CHAT_ROOM_ICONS],
    description: 'A lucide icon name from the curated list. Omit for the default (clients draw `hash`)',
  })
  @IsOptional()
  @IsIn([...CHAT_ROOM_ICONS])
  icon?: ChatRoomIcon
}
class ChatDirectOpenInputDto {
  @ApiProperty({
    description:
      'users.id of the person to message. Idempotent: the existing DM with them is returned if there is one. Unknown, revoked and collaborator ids are refused, and so is your own',
  })
  @IsString()
  @MinLength(1)
  user!: string
}
class ChatRoomUpdateInputDto {
  @ApiProperty({ description: 'Room slug to change' }) @IsString() @MinLength(1) room!: string
  @ApiProperty({ required: false, description: 'New slug. RENAMING CHANGES THE ROOM ADDRESS - every saved link and every client that named the old slug stops resolving. To change only what people SEE, set `name` instead - it costs nothing' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
  slug?: string
  @ApiProperty({
    required: false,
    description: 'New display name, free-form. Pass an empty string to clear it, which makes the slug the name again',
  })
  @IsOptional()
  @IsString()
  @MaxLength(CHAT_ROOM_NAME_MAX)
  name?: string
  @ApiProperty({ required: false, description: 'New topic. Pass an empty string to clear it' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  topic?: string
  @ApiProperty({
    required: false,
    // '' is part of the enum rather than a footnote: it is a legal value on THIS input (it clears
    // the icon), and a generated client type that omits it makes the clear path uncallable.
    enum: [...CHAT_ROOM_ICONS, ''],
    description: "New icon, from the curated list. Pass an empty string to clear it back to the client-drawn default",
  })
  @IsOptional()
  @IsIn([...CHAT_ROOM_ICONS, ''])
  icon?: ChatRoomIcon | ''
}
class ChatRoomDeleteInputDto {
  @ApiProperty({
    description:
      'Room slug to DESTROY. Called over the API this does NOT delete: it posts an approval card into the room and answers `status: pending` - a human there decides. Read the result\'s `detail`',
  })
  @IsString()
  @MinLength(1)
  room!: string
  @ApiProperty({
    description: "Type the room's slug again. A deliberate second statement of intent for the one call here that cannot be undone",
  })
  @IsString()
  @MinLength(1)
  confirm!: string
}
/**
 * Two outcomes on one shape, discriminated by `status`, because the MCP caller cannot be told
 * which one it will get before it calls: `deleted` carries the purge's counts; `pending` carries
 * the approval card's identity and a `detail` written for a model to act on (tell the room, stop).
 */
class ChatRoomDeleteResultDto {
  @ApiProperty({
    enum: ['deleted', 'pending'],
    description:
      '`deleted`: it is gone. `pending`: NOTHING was deleted - an approval card was posted into the room instead, and a human there decides. Read `detail`',
  })
  status!: 'deleted' | 'pending'
  @ApiProperty() roomId!: string
  @ApiProperty() slug!: string
  @ApiProperty({ description: 'One honest line for the caller. For `pending` it says what to do next' }) detail!: string
  @ApiProperty({ required: false, description: 'pending only: the card\'s meta.requestId' }) requestId?: string
  @ApiProperty({ required: false, description: 'pending only: epoch ms after which the card expires unanswered' })
  expiresAt?: number
  @ApiProperty({ required: false, description: 'deleted only: messages destroyed' }) messages?: number
  @ApiProperty({ required: false, description: 'deleted only: attachment blobs whose last reference went with the room' })
  blobs?: number
}
class ChatFeedInputDto {
  @ApiProperty({
    required: false,
    description: 'Global event id to resume AFTER (from a frame id / hello). Omit to start live from now.'
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  cursor?: number
}

/**
 * Chat is personal, room-scoped data with no meaningful anonymous rendering: the principal IS the
 * message's author, its read pointer and its notification target, so there is nothing to render
 * without one. AuthGuard already refuses an unauthenticated request; this keeps the local narrowing
 * (and the honest error) rather than asserting non-null.
 */
function requireChatPrincipal(req: PrincipalRequest): Principal {
  const principal = req.principal
  if (!principal) throw new UnauthorizedException('chat requires a signed-in principal')
  return principal
}

/** Map the store's typed refusals onto real status codes; anything else is a genuine 500. */
function chatCall<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    throw mapChatError(error)
  }
}

/** `chatCall` for a path that awaits - the mapping is the same, the try has to be async to catch. */
async function chatCallAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw mapChatError(error)
  }
}

function mapChatError(error: unknown): unknown {
  if (error instanceof ChatNotFoundError) return new NotFoundException(error.message)
  if (error instanceof ChatAccessError) return new ForbiddenException(error.message)
  if (error instanceof ChatConflictError) return new ConflictException(error.message)
  if (error instanceof ChatValidationError) return new BadRequestException(error.message)
  return error
}

/**
 * Turn the `@handles` in a body into real `users.id` values.
 *
 * The SPLIT is the point: `parseMentionHandles` (core, pure, unit-tested) knows the grammar but not
 * the directory, and this knows the directory but not the grammar. That keeps `ChatStore` free of
 * any dependency on the DuckDB warehouse where `users` actually lives - chat.db stays a
 * self-contained SQLite file, which is what makes the eventual read-only ATTACH honest.
 *
 * Collaborators are filtered out because they cannot reach chat at all, and a revoked user because
 * a mention that grants room access to an account somebody deliberately switched off is a
 * privilege-escalation shape, not a notification. An unresolved handle is simply not a mention:
 * `@lunch` stays literal text, notifies nobody, and grants nothing.
 *
 * NB this runs on the POST path only. Editing a message never re-resolves - an edit must not
 * retroactively grant room access, and must not fire a notification on a channel that is
 * deliberately quiet. See the chat PRD, Track 8.
 */
async function resolveMentions(body: string): Promise<string[]> {
  const handles = parseMentionHandles(body)
  if (handles.length === 0) return []
  const directory = await readUsers()
  const byId = new Map(directory.map((u) => [u.id.toLowerCase(), u]))
  return handles.filter((handle) => {
    const user = byId.get(handle)
    return user !== undefined && user.status !== 'revoked'
  })
}

const toFrame = (ev: ChatEvent): ChatFeedFrameDto => ({
  id: ev.id,
  type: ev.type,
  roomId: ev.roomId,
  payload: ev.payload,
  at: ev.at
})

class ChatBackupResultDto {
  @ApiProperty({ description: 'One-line outcome of the backup' }) summary!: string
}


/**
 * Team chat: the tRPC surface for the dashboard plus `chat-post` over MCP, so the agent is just
 * another writer - same validation, same membership rules, same outbox, no special path. Reads
 * with input are POST + `@Trpc({ kind: 'mutation' })` like the sink/content read pattern (the
 * input-less house queries are the only @Get + @Trpc() queries).
 *
 * The sender of every write is ALWAYS the request principal - never a client-supplied id.
 */
@Controller('chat')
@UseGuards(AuthGuard)
export class ChatController {
  /**
   * tRPC query `chatRooms` / MCP `ChatRooms` - the sidebar: the principal's rooms with unread
   * counts, plus every public room they could join. Over MCP this is the DISCOVERY call: an agent
   * that only has `chat-post` can write to a room it can already name and nothing else.
   */
  @Get('rooms')
  @ApiOkResponse({ type: ChatRoomsDto })
  @Trpc()
  @Mcp({ name: 'chat-rooms' })
  rooms(@Req() req: PrincipalRequest): ChatRoomsDto {
    const principal = requireChatPrincipal(req)
    return { generatedAt: new Date().toISOString(), rooms: chatCall(() => chatStore().roomsVisibleTo(principal.id)) }
  }

  /**
   * tRPC mutation `chatHistory` / MCP `ChatHistory` - one room's messages, paging backwards by
   * createdAt, returned oldest-first.
   *
   * The agent's memory. A turn is seeded with a fixed window of recent messages
   * (`AGENT_SEED_HISTORY`); this is how it reaches past that window when somebody asks about
   * something said last week. Membership-filtered like every other read - an agent sees exactly
   * what the principal it authenticated as may see, which for `nova` is the public rooms plus the
   * ones it has been mentioned into.
   */
  @Post('history')
  @ApiOkResponse({ type: ChatHistoryDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'chat-history' })
  history(@Body() body: ChatHistoryInputDto, @Req() req: PrincipalRequest): ChatHistoryDto {
    const principal = requireChatPrincipal(req)
    return chatCall(() =>
      chatStore().history(body.room, principal.id, { before: body.before, limit: body.limit, roots: body.roots })
    )
  }

  /**
   * tRPC mutation `chatThread` / MCP `chat-thread` - one thread, expanded.
   *
   * The companion to `history({ roots: true })`: the grouped timeline hands back roots plus a
   * count, and this is what a reader (or the agent, following its own conversation) opens when it
   * wants what is actually IN one. Readability is the room's - a thread is a shape over messages
   * the caller can already see, never a second access surface.
   */
  @Post('thread')
  @ApiOkResponse({ type: ChatThreadDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'chat-thread' })
  thread(@Body() body: ChatThreadInputDto, @Req() req: PrincipalRequest): ChatThreadDto {
    const principal = requireChatPrincipal(req)
    return chatCall(() => chatStore().thread(body.room, principal.id, body.messageId)) as ChatThreadDto
  }

  /**
   * tRPC mutation `chatPost` / MCP `chat-post` - send a message. The store commits the message row
   * and its outbox event in one transaction and publishes on the chat bus only after that commit,
   * so what subscribers hear is always what was stored.
   */
  @Post('post')
  @ApiOkResponse({ type: ChatPostResultDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'chat-post' })
  async post(@Body() body: ChatPostInputDto, @Req() req: PrincipalRequest): Promise<ChatPostResultDto> {
    const principal = requireChatPrincipal(req)
    const attachmentIds = body.attachmentIds ?? []
    // The one place the "a message is a body or an attachment" rule lives (the DTO can no longer
    // say it - see the body field's comment). Trimmed: a bare space is not a message either.
    if (body.body.trim() === '' && attachmentIds.length === 0) {
      throw new BadRequestException('a message needs a body or at least one attachment')
    }
    // THE DOUBLE-POST GUARD. A turn's answer is already being written into the room, character by
    // character, by the runtime - so when nova ALSO calls this tool to "post its reply", the room
    // gets the same answer twice. Reported twice against production before the cause was clear
    // (2026-09-02), and it is not an event-delivery duplicate: it is the model reaching for a tool
    // it does not need, because from inside the turn there is nothing to say it already has one.
    //
    // Refused rather than silently dropped: the refusal reaches the model as a tool error, which
    // is the only feedback that teaches it inside the same turn. Scoped as narrowly as the bug -
    // nova only, this room only, only while a turn is actually streaming here - so posting into a
    // DIFFERENT room mid-turn (a real thing an agent is asked to do) still works, and a human's
    // post is never touched.
    if (principal.id === systemUserId()) {
      const room = chatCall(() => chatStore().roomBySlug(body.room))
      const session = room === null ? null : chatStore().agentSession(room.id)
      if (session?.streamingMessageId != null) {
        throw new ConflictException(
          `you are already answering in "${body.room}" - your turn's own text is posted into that channel as you write it, so calling chat-post here would say it twice. Just write the answer. Use chat-post only for a DIFFERENT room.`
        )
      }
    }
    const mentioned = await resolveMentions(body.body)
    const event = chatCall(() =>
      chatStore().post(
        body.room,
        { id: principal.id, display: principal.display },
        body.body,
        mentioned,
        attachmentIds,
        null,
        body.parentId ?? null
      )
    )
    return { cursor: event.id, message: event.payload }
  }

  /**
   * REST `POST /api/chat/attachments` - multipart upload (field name `file`), Track 11. Plain
   * REST on purpose: multipart does not project onto tRPC or MCP, and the serve route below is
   * its REST twin. The result is an ORPHAN attachment - readable only by its uploader until a
   * `chatPost` carrying its id claims it (which is also the moment its room decides who else may
   * read it). Orphans that never get posted are swept after ATTACHMENT_ORPHAN_TTL_MS.
   *
   * Refusals, per the Track 11 spec, are verbatim and total - nothing is ever truncated or
   * transcoded: the size cap (multer aborts the stream at the cap; AttachmentSizeFilter phrases
   * it), the mime allowlist, and the empty file.
   */
  @Post('attachments')
  @ApiOkResponse({ type: ChatAttachmentDto })
  // defParamCharset utf8: busboy decodes Content-Disposition params as latin1 by default, which
  // mangles every non-ASCII filename ("Bildschirmfoto…" arrives as mojibake); utf8 is what every
  // current browser and http client actually sends.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ATTACHMENT_MAX_BYTES, files: 1 }, defParamCharset: 'utf8' }))
  @UseFilters(AttachmentSizeFilter)
  upload(@UploadedFile() file: MultipartUpload | undefined, @Req() req: PrincipalRequest): ChatAttachmentDto {
    const principal = requireChatPrincipal(req)
    if (!file) throw new BadRequestException('no file - send multipart/form-data with the file under the "file" field')
    if (file.size === 0) throw new BadRequestException('the file is empty (0 bytes)')
    const mime = file.mimetype.split(';')[0].trim().toLowerCase()
    if (!ATTACHMENT_ALLOWED_MIME.has(mime)) {
      throw new UnsupportedMediaTypeException(
        `"${mime}" is not an accepted attachment type - accepted: ${[...ATTACHMENT_ALLOWED_MIME].sort().join(', ')}`
      )
    }
    // Opportunistic sweep: every upload reaps yesterday's never-posted orphans first, so the
    // table is self-maintaining with no timer and nothing armed on dev machines (see the store
    // method for the scheduling story).
    const store = chatStore()
    store.sweepOrphanAttachments()
    return store.attachmentCreate(principal.id, {
      filename: sanitizeFilename(file.originalname),
      mime,
      bytes: file.buffer
    })
  }

  /**
   * REST `GET /api/chat/attachments/:id` - stream the bytes. THE serve rule of Track 11: the URL
   * is NOT a capability - nothing signed, nothing expiring - because every request re-runs
   * `ChatStore.attachmentForRead`, which is uploader-only during the orphan window and exactly
   * `canReadRoom` (the live feed's own predicate) once posted. Leave a private room and this URL
   * goes dark for you on the next request.
   *
   * Streamed with @Res passthrough (Nest's JSON renderer cannot pipe a file). The global
   * `X-Content-Type-Options: nosniff` (main.ts) is load-bearing here: with it, the declared
   * Content-Type is FINAL, so even a hostile file admitted by a lying mime claim renders as the
   * type it claimed, never as sniffed HTML. Non-image types additionally go out as downloads.
   */
  @Get('attachments/:id')
  serve(@Param('id') id: string, @Req() req: PrincipalRequest, @Res() res: AttachmentStreamResponse): void {
    const principal = requireChatPrincipal(req)
    const store = chatStore()
    const attachment = chatCall(() => store.attachmentForRead(id, principal.id))
    const path = store.attachmentBlobPath(attachment.sha256)
    // Rows are the truth blobs live by; a row whose blob is gone means something outside this
    // process touched the directory. Answer honestly rather than hanging the stream.
    if (!existsSync(path)) throw new NotFoundException('attachment content is missing from disk')
    res.setHeader('Content-Type', attachment.mime)
    res.setHeader('Content-Length', String(attachment.bytes))
    res.setHeader(
      'Content-Disposition',
      contentDisposition(ATTACHMENT_INLINE_MIME.has(attachment.mime) ? 'inline' : 'attachment', attachment.filename)
    )
    // private+immutable: the content behind an attachment id can never change (it is a content
    // address one row away), so the browser may cache it forever - but only ITS user's cache
    // (`private`), never a shared one, because reads are authorized per principal. A cached copy
    // outliving room membership was weighed and accepted: it is on that user's disk either way,
    // like any chat client's image cache.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
    createReadStream(path).pipe(res)
  }

  /**
   * tRPC mutation `chatAgentStatus` - what the agent turn in this room is doing right now.
   *
   * A READ, POSTed: it takes an input, and the house pattern for those is POST + mutation (only
   * the input-less queries are @Get). It writes nothing and touches no turn.
   *
   * This exists because `agent.activity` is an ephemeral and is never replayed. Open a room while
   * nova is working - or reconnect a dropped feed - and the frames that explained the placeholder
   * are already gone, so without this a late joiner sees a bare "…" until the next one lands, and
   * a turn thinking for thirty seconds sends nothing in that window. Gated on `canReadRoom`, the
   * feed's own predicate, so it can never tell you about a room you cannot read.
   */
  @Post('agent-status')
  @ApiOkResponse({ type: ChatAgentStatusResultDto })
  @Trpc({ kind: 'mutation' })
  agentStatus(@Body() body: ChatAgentStatusInputDto, @Req() req: PrincipalRequest): ChatAgentStatusResultDto {
    const principal = requireChatPrincipal(req)
    const store = chatStore()
    const room = store.roomBySlug(body.room)
    // Unreadable and nonexistent answer identically on purpose: a 404 here would confirm that a
    // private room by that slug exists.
    if (room === null || !store.canReadRoom(room.id, principal.id)) {
      return { active: false, activity: null }
    }
    return chatAgentStatus(room.id)
  }

  /**
   * tRPC mutation `chatAgentDecision` - approve or deny an agent approval card (chat Track 19).
   *
   * **Any internal user in the room may answer**, and that is a decision rather than an oversight:
   * they were trusted enough to be in the room the agent is working for, and tightening this to the
   * person who invoked the turn was rejected outright - the invoker going to lunch must not park
   * the team's agent for thirty minutes. `canReadRoom` is the whole authorization, the same
   * predicate the live feed and the mid-turn status read use.
   *
   * Note what this does NOT re-check: whether the caller can SEE the card. It is the same question
   * - the card is a message in the room, so anyone who can read the room can read it - and asking
   * it twice would mean a second lookup on a path where a double-click race is already the
   * interesting failure. The name written into the transcript is the caller's own display name,
   * resolved from their principal and never taken from the request.
   */
  @Post('agent-decision')
  @ApiOkResponse({ type: ChatAgentDecisionResultDto })
  @Trpc({ kind: 'mutation' })
  agentDecision(
    @Body() body: ChatAgentDecisionInputDto,
    @Req() req: PrincipalRequest
  ): ChatAgentDecisionResultDto {
    const principal = requireChatPrincipal(req)
    const store = chatStore()
    const room = store.roomBySlug(body.room)
    // Unreadable and nonexistent answer identically, exactly as the status read does - a distinct
    // refusal here would confirm that a private room by that slug exists.
    if (room === null || !store.canReadRoom(room.id, principal.id)) {
      return { ok: false, detail: 'nothing is waiting for a decision here' }
    }
    return decideApproval({
      roomId: room.id,
      requestId: body.requestId,
      workerSessionId: body.workerSessionId ?? null,
      action: body.action,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      actor: { id: principal.id, display: principal.display ?? principal.id },
    })
  }

  /** tRPC mutation `chatMarkRead` - advance the member's read pointer (clamped, monotonic) and get
   *  back the stored pointer plus the server's unread recount. */
  @Post('read')
  @ApiOkResponse({ type: ChatReadStateDto })
  @Trpc({ kind: 'mutation' })
  markRead(@Body() body: ChatMarkReadInputDto, @Req() req: PrincipalRequest): ChatReadStateDto {
    const principal = requireChatPrincipal(req)
    return chatCall(() => chatStore().markRead(body.room, principal.id, body.at))
  }

  /**
   * tRPC mutation `chatEdit` - replace your own message's body. Only the sender may edit (the
   * store enforces it), and the update issues NO key and writes NO outbox row, so no member's
   * unread badge moves; it reaches other tabs over the ephemeral bus instead.
   */
  @Post('edit')
  @ApiOkResponse({ type: ChatMessageDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'chat-edit' })
  edit(@Body() body: ChatEditInputDto, @Req() req: PrincipalRequest): ChatMessageDto {
    const principal = requireChatPrincipal(req)
    return chatCall(() => chatStore().editMessage(body.room, body.messageId, principal.id, body.body))
  }

  /**
   * tRPC mutation `chatReact` - put a reaction on a message, or take yours back.
   *
   * The cheap ack, and everything about it is defined by what it does NOT do: it allocates no
   * order key, writes no outbox row, moves nobody's unread badge and never notifies. Reaching the
   * room over the ephemeral bus is the whole delivery story, exactly like `chatEdit`.
   *
   * Idempotent in both directions, so a retried call converges instead of double-counting, and the
   * emoji must be one of `CHAT_REACTION_EMOJI` - free text is refused with a 400 rather than
   * quietly turning the column into a string column.
   */
  @Post('react')
  @ApiOkResponse({ type: ChatReactionResultDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'chat-react' })
  react(@Body() body: ChatReactInputDto, @Req() req: PrincipalRequest): ChatReactionResultDto {
    const principal = requireChatPrincipal(req)
    return chatCall(() => ({
      messageId: body.messageId,
      reactions: chatStore().setReaction(
        body.room,
        body.messageId,
        principal.id,
        body.emoji,
        body.on !== false,
      ),
    }))
  }

  /**
   * tRPC mutation `chatDelete` - HARD-delete your own message; a thread root takes its replies.
   *
   * The row, its outbox row, its attachments and its mentions go in one transaction (see
   * `ChatStore.deleteMessage`), so nothing can replay or render it afterwards. Live clients hear
   * one `message.deleted` frame per deleted message, root first. If nova had written in the thread,
   * the room's agent session is dropped as well - `agentSessionDropped` says so.
   */
  @Post('delete')
  @ApiOkResponse({ type: ChatMessageDeletionDto })
  // Named explicitly: the method cannot be called `delete` without shadowing, and the derived name
  // would otherwise be `chatRemove`.
  @Trpc({ kind: 'mutation', name: 'Chat.delete' })
  @Mcp({ name: 'chat-message-delete' })
  remove(@Body() body: ChatDeleteInputDto, @Req() req: PrincipalRequest): ChatMessageDeletionDto {
    const principal = requireChatPrincipal(req)
    // `moderate` deletes somebody ELSE's message, so it is admin-only again (it was until
    // 2026-09-10, and is once more since 2026-09-13). A decorator cannot express it: the very same
    // route is every member's ordinary self-delete, and only the flag tells them apart. Audited
    // like any other delete, and the flag still has to be passed deliberately.
    if (body.moderate === true) assertAdmin(req, "deleting another person's message")
    return chatCall(() =>
      chatStore().deleteMessage(body.room, body.messageId, principal.id, { anySender: body.moderate === true })
    )
  }

  /** tRPC mutation `chatRoomCreate` - create a room. Every user can read and write it at once. */
  @Post('rooms')
  @ApiOkResponse({ type: ChatRoomDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'chat-room-create' })
  roomCreate(@Body() body: ChatRoomCreateInputDto, @Req() req: PrincipalRequest): ChatRoomDto {
    const principal = requireChatPrincipal(req)
    return chatCall(() =>
      chatStore().createRoom(
        {
          slug: body.slug,
          name: body.name ?? null,
          topic: body.topic ?? null,
          icon: body.icon ?? null,
        },
        { id: principal.id, display: principal.display }
      )
    )
  }

  /**
   * tRPC mutation `chatDirectOpen` / MCP `ChatDirectOpen` - open a direct message with one person
   * (chat Track 14). IDEMPOTENT: the DM's slug derives from the sorted pair of ids, so the second
   * call (from either side) returns the room the first one created, never a duplicate. The answer
   * is the room summary as the caller sees it, `kind: 'dm'` with `peer` set - post into it, read
   * its history and mark it read by that slug exactly like any other room.
   *
   * The peer is validated against the user directory HERE rather than in the store, because users
   * live in the warehouse and chat.db cannot see them. Collaborators are refused because
   * chat is internal-only; a revoked user because a DM would hold a private channel open to an
   * account somebody deliberately switched off. Yourself is refused by the store - a notes-to-self
   * room is a different feature, and this one's rules (two members, notify the other) have no
   * honest answer for it.
   */
  @Post('direct')
  @ApiOkResponse({ type: ChatRoomDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'chat-direct-open' })
  async directOpen(@Body() body: ChatDirectOpenInputDto, @Req() req: PrincipalRequest): Promise<ChatRoomDto> {
    const principal = requireChatPrincipal(req)
    if (body.user === principal.id) throw new BadRequestException('a direct message needs somebody else - that is your own id')
    const peer = (await readUsers()).find((user) => user.id === body.user)
    if (peer === undefined || peer.status === 'revoked') {
      throw new BadRequestException(`cannot message ${body.user} (unknown or revoked)`)
    }
    return chatCall(() => chatStore().openDirect({ id: principal.id, display: principal.display }, body.user))
  }

  /**
   * tRPC mutation `chatRoomUpdate` / MCP `ChatRoomUpdate` - rename a room, set its topic or its
   * icon. Open to anyone who can read the room, which for a channel is everyone.
   *
   * One thing this can do that no other call can undo cheaply, stated on the DTO: a rename changes
   * the address every link and every client used. It is not blocked - a room stuck with a name
   * nobody wanted is worse - but it should not be reached by an agent guessing at a tidy-up. A DM
   * answers 400 for any patch: its address is derived from the pair and it has no topic.
   */
  @Post('room-update')
  @ApiOkResponse({ type: ChatRoomDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'chat-room-update' })
  roomUpdate(@Body() body: ChatRoomUpdateInputDto, @Req() req: PrincipalRequest): ChatRoomDto {
    const principal = requireChatPrincipal(req)
    return chatCall(() =>
      chatStore().updateRoom(body.room, principal.id, {
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        // Empty string clears, like `topic` and `icon` below.
        ...(body.name !== undefined ? { name: body.name === '' ? null : body.name } : {}),
        // An empty string is how a scalar-only MCP surface says "clear it" - there is no way to
        // send an explicit null through a string option, and omitting the field has to keep
        // meaning "leave it alone".
        ...(body.topic !== undefined ? { topic: body.topic === '' ? null : body.topic } : {}),
        // Same empty-string-means-clear convention as `topic` above, and for the same reason.
        ...(body.icon !== undefined ? { icon: body.icon === '' ? null : body.icon } : {}),
      })
    )
  }

  /**
   * tRPC mutation `chatRoomDelete` / MCP `ChatRoomDelete` - DESTROY a room and everything in it.
   *
   * The one irreversible call on this controller, and it carries three separate guards because no
   * single one of them is enough on its own:
   *
   * 1. **`confirm` must repeat the slug** - a second statement of intent, in the caller's own
   *    words. It is the guard that survives a model calling this with a plausible-looking argument
   *    it inferred rather than was given.
   * 2. **A human in the room, unless the caller IS one.** An API client (a bearer token: MCP, the
   *    `cli` proxy, a script - and the service account whatever it presents) does not delete. It
   *    gets an approval card posted into the room and `status: 'pending'` back at once; the
   *    deletion runs only when a human who can read that room approves the card, and THEY are the
   *    actor of record. The first two guards do not put a person in the loop - nova is an admin,
   *    and a model repeats a slug without hesitation - and the engine-side approval cannot either,
   *    since nova's codex config auto-approves MCP calls. `chatOpNeedsApproval` in core holds the
   *    rule and its tests; `chat-op-approvals.ts` holds the request.
   * 3. **Readability** (in the store) - you cannot delete a room you cannot read, and you cannot
   *    approve deleting one either. For a channel that is everybody; for a DM it is the pair, and
   *    the agent's guest pass is deliberately not enough.
   *
   * There is deliberately **no role gate** (dropped 2026-09-06, a product decision: every internal
   * principal manages rooms freely, collaborators are refused chat entirely by
   * `requireChatPrincipal`). It never was the load-bearing guard - nova IS an admin, which is the
   * whole reason guard 2 exists - and in a team this size an admin-only purge just meant asking
   * an admin to press the button somebody else already decided on. Guard 2 is what keeps a MODEL
   * from purging a room; guards 1 and 3 are what keep a person from doing it by accident.
   *
   * This is a PURGE and it is the only way a room ends - there is no archive any more, because
   * archiving was the last member leaving and nobody leaves now. See `ChatStore.deleteRoom`.
   */
  @Post('room-delete')
  @ApiOkResponse({ type: ChatRoomDeleteResultDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'chat-room-delete' })
  async roomDelete(@Body() body: ChatRoomDeleteInputDto, @Req() req: PrincipalRequest): Promise<ChatRoomDeleteResultDto> {
    const principal = requireChatPrincipal(req)
    if (body.confirm !== body.room) {
      throw new BadRequestException(`confirm must repeat the room slug exactly ("${body.room}")`)
    }
    if (chatOpNeedsApproval({ credential: req.credential, principalId: principal.id })) {
      const held = await chatCallAsync(() => requestChatOp({ op: 'room-delete', slug: body.room, requester: principal }))
      return {
        status: 'pending',
        roomId: held.roomId,
        slug: body.room,
        requestId: held.requestId,
        expiresAt: held.expiresAt,
        detail: held.detail,
      }
    }
    const deletion = chatCall(() => chatStore().deleteRoom(body.room, principal.id))
    return {
      status: 'deleted',
      ...deletion,
      detail: `#${deletion.slug} deleted: ${deletion.messages} messages, ${deletion.blobs} attachment blobs unlinked`,
    }
  }

  /**
   * tRPC mutation `chatBackup` / MCP tool `ChatBackup` - snapshot chat.db (VACUUM INTO, through
   * the live store) to the private GCS bucket. Defined in the unified automation-action registry
   * (core/automation/actions.ts - also schedulable there) and run through the execute+record
   * funnel, so every invocation lands in the automation_runs history, exactly like
   * `WarehouseBackup`.
   */
  @Post('backup')
  @ApiOkResponse({ type: ChatBackupResultDto })
  @Trpc({ kind: 'mutation' })
  @Mcp()
  async backup(): Promise<ChatBackupResultDto> {
    const result = await drain(executeRecorded('chat-backup', { trigger: 'manual' }))
    return { summary: result.summary }
  }

  /**
   * tRPC subscription `chatFeed` - ONE multiplexed live stream per client covering every room the
   * principal is a member of. A `cursor` (the global outbox id, Last-Event-ID style) replays what
   * was missed from the outbox before going live; without one the stream starts at now. Every
   * frame is membership-filtered server-side - that is what makes a payload-carrying bus safe.
   */
  @Trpc({ kind: 'subscription', chunk: ChatFeedFrameDto })
  async *feed(@Query() input: ChatFeedInputDto, @Req() req: PrincipalRequest): AsyncGenerator<ChatFeedFrameDto> {
    const principal = requireChatPrincipal(req)
    const store = chatStore()

    // Subscribe BEFORE reading the replay window so no commit can fall between them; the id
    // comparison below dedupes anything that lands in both.
    const queue: ChatBusEvent[] = []
    let wake: (() => void) | undefined
    const off = onChatEvent((ev) => {
      queue.push(ev)
      wake?.()
    })
    try {
      let lastId = input.cursor ?? store.latestEventId()
      // hello carries the starting cursor so a client that connected without one learns where it is.
      yield { id: lastId, type: 'hello', roomId: null, payload: null, at: Date.now() }

      if (input.cursor !== undefined) {
        for (;;) {
          const batch = store.eventsAfter(lastId, principal.id, REPLAY_BATCH)
          for (const ev of batch) {
            lastId = ev.id
            yield toFrame(ev)
          }
          if (batch.length < REPLAY_BATCH) break
        }
      }

      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, PING_MS)
            wake = () => {
              clearTimeout(timer)
              resolve()
            }
          })
          wake = undefined
        }
        if (queue.length === 0) {
          yield { id: lastId, type: 'ping', roomId: null, payload: null, at: Date.now() }
          continue
        }
        while (queue.length > 0) {
          const ev = queue.shift()!
          if ('ephemeral' in ev) {
            // Two routings. A user id is stricter than readability (another member's read pointer
            // is not this subscriber's business); null means the whole room, filtered by the same
            // canReadRoom check the outbox path below uses - that filter is what keeps a
            // payload-carrying bus safe. No outbox row backs either, so the frame id is the
            // current high-water mark (like ping) - it must not advance the client's cursor.
            // `room.deleted` is the one exemption, and it is structural rather than a special
            // case anyone chose: the room row is already gone by the time this arrives, so
            // canReadRoom answers false for EVERYONE and would swallow the only frame that tells
            // an open tab to stop rendering a room that no longer exists. Its audience is decided
            // at emit time instead (ChatStore.deleteRoom): a userId-null one means the room was
            // public and its deletion is not a secret; a private room's is emitted per captured
            // member and still goes through the per-user branch below.
            const exempt = ev.type === 'room.deleted' && ev.userId === null
            if (!exempt && (ev.userId === null ? !store.canReadRoom(ev.roomId, principal.id) : ev.userId !== principal.id)) continue
            yield {
              id: lastId,
              type: ev.type,
              roomId: ev.roomId,
              payload: ev.payload ?? null,
              ...(ev.read ? { read: ev.read } : {}),
              ...(ev.activity ? { activity: ev.activity } : {}),
              ...(ev.reaction ? { reaction: ev.reaction } : {}),
              at: ev.at,
            }
            continue
          }
          if (ev.id <= lastId) continue // already delivered by the replay pass
          // Live readability check per event: public rooms deliver to lurkers too (an open room
          // that silently froze until the next refetch would make the UI lie), rooms the principal
          // cannot read never leak a payload.
          if (!store.canReadRoom(ev.roomId, principal.id)) continue
          lastId = ev.id
          yield toFrame(ev)
        }
      }
    } finally {
      off() // client disconnected (generator return/throw) - stop listening
    }
  }
}
