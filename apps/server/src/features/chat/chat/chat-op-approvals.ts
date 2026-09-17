import { randomUUID } from 'node:crypto'
import { systemUserId, APPROVAL_TIMEOUT_MS, ChatAccessError, ChatNotFoundError, chatOpCardBody, chatOpLabel, chatOpPendingDetail, chatStore, resolvedCardBody, type ApprovalOutcome, type ChatOpApprovalMeta, type ChatOpKind, type ChatRoomDeletion } from '@silkweave/box-core'
import { postAsAgent, writeCard } from './cards.js'

/**
 * The server-held side of an in-channel approval for a DESTRUCTIVE chat operation (2026-09-02).
 *
 * `ChatRoomDelete` over MCP is auto-approved at the engine (nova's codex config) and asks the caller
 * to repeat the slug (a model will). Neither puts a person in the loop, so this does: when `chatOpNeedsApproval` says the caller is an API client, the
 * controller posts an approval card into the room instead of deleting, returns at once, and the
 * operation waits HERE until somebody in the room answers.
 *
 * ## What this is NOT
 *
 * It is not the chat agent's approval machinery. A worker card (`agent/chat-agent.ts`) is keyed to
 * a live `SessionHandle` and a live turn, and answering it means sending a frame down a socket.
 * A chat-op card has neither: it can be raised in a room with no agent session at all - by a
 * human's own Claude Code session holding that human's token, say - and answering it means the
 * SERVER performing the operation. The two share the card format and the decision endpoint
 * (routed in `decideApproval`), and nothing else.
 *
 * ## The three decisions that shape it
 *
 * **Two-phase and non-blocking.** The tool call returns `pending` immediately. Holding the HTTP
 * connection open for up to thirty minutes would hit the engine's tool timeout, pin a Nest worker,
 * and give the model nothing useful to say in the channel meanwhile.
 *
 * **The decision EXECUTES.** There is no ticket for the caller to redeem afterwards: a redeemable
 * approval is a second chance for the model to act on a stale one, and needs its own expiry.
 * Approve runs `deleteRoom`; deny and timeout settle the card and forget the request.
 *
 * **The actor of record is the approver.** `deleteRoom(slug, approverId)`, which also means the
 * store's membership rule applies to THEM - you cannot approve destroying a room you were never in.
 * MEMBERSHIP is the whole rule: the route's own admin gate was dropped on 2026-09-06 and roles
 * themselves on 2026-09-10, so a card the members of a room can answer grants exactly the
 * permission those members already hold through the route. The card is a check on the CALLER being
 * a model, not on who the approver is.
 *
 * ## Where the pending operation lives
 *
 * In memory, and a restart is handled the way worker cards handle it: at boot every `chat-op` card
 * still saying `pending` is settled as expired (`startChatOpApprovals`), because the request it
 * names died with the last process. A durable row was considered and not added - the window is
 * thirty minutes, re-asking costs one tool call, and a second source of truth for a pending purge
 * is a second place to get one wrong.
 */

interface PendingChatOp {
  requestId: string
  op: ChatOpKind
  roomId: string
  /** The slug at request time, for prose and logs. The operation re-resolves the room by ID. */
  slug: string
  requestedBy: string
  /** Null while the card is being written - the post resolves a display name against the warehouse.
   *  `at` is the card message's createdAt, its order key in the room. */
  card: { messageId: string; at: number; body: string } | null
  expiresAt: number
  timer: ReturnType<typeof setTimeout> | null
}

/** Keyed by request id. Insertion order is oldest-first, but the card's position in the room is
 *  what "oldest" means to a reader, and that is what `chatOpOldestCard` compares. */
const pending = new Map<string, PendingChatOp>()

/** Set by `stopChatOpApprovals`; a request whose card lands after shutdown began arms nothing. */
let stopped = false

/** What a held call gets back: enough for the caller to name the card, and one line to act on. */
export interface ChatOpHeld {
  roomId: string
  requestId: string
  expiresAt: number
  detail: string
}

/** What a decision attempt did, in one line the caller can hand straight to a human. */
export interface ChatOpDecisionResult {
  ok: boolean
  detail: string
}

/**
 * Hold a destructive operation for approval: post the card, remember the request, start the clock.
 *
 * Preconditions mirror the direct path's, so the gated path refuses exactly what `deleteRoom`
 * would - a missing room, or a DM the requester is not one half of - and discloses nothing more
 * than the store does.
 *
 * Idempotent per room and operation: a repeat call while a card is waiting returns that card, so a
 * model that retries does not badge the room twice.
 */
export async function requestChatOp(input: {
  op: ChatOpKind
  slug: string
  requester: { id: string; display: string }
}): Promise<ChatOpHeld> {
  const store = chatStore()
  const room = store.roomBySlug(input.slug)
  if (room === null) throw new ChatNotFoundError(`no room "${input.slug}"`)
  if (!store.canReadRoom(room.id, input.requester.id)) {
    throw new ChatAccessError(`"${input.slug}" is not yours to read`)
  }

  const already = heldFor(room.id, input.op)
  if (already !== null) {
    return {
      roomId: room.id,
      requestId: already.requestId,
      expiresAt: already.expiresAt,
      detail: chatOpPendingDetail({ op: input.op, slug: room.slug, timeoutMs: APPROVAL_TIMEOUT_MS, already: true }),
    }
  }

  // Reserved BEFORE the post, with no card yet. The post awaits a directory read, and a second call
  // arriving inside that window must find this entry rather than posting a card of its own.
  const entry: PendingChatOp = {
    requestId: randomUUID(),
    op: input.op,
    roomId: room.id,
    slug: room.slug,
    requestedBy: input.requester.id,
    card: null,
    expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
    timer: null,
  }
  pending.set(entry.requestId, entry)

  const body = chatOpCardBody({
    op: input.op,
    slug: room.slug,
    requestedBy: input.requester.display,
    messages: store.messageCount(room.id),
  })
  let card
  try {
    card = await postAsAgent(room.slug, body, metaFor(entry, 'pending'))
  } catch (error) {
    pending.delete(entry.requestId)
    // The one refusal with a next step: the card is posted AS nova, and a private room nova has not
    // been mentioned into is one it cannot post to. Saying which fix works beats a bare 403.
    if (error instanceof ChatAccessError) {
      throw new ChatAccessError(
        `the approval card could not be posted: ${systemUserId()} cannot write in "${room.slug}" - mention @${systemUserId()} there and ask again`
      )
    }
    throw error
  }
  entry.card = { messageId: card.id, at: card.createdAt, body }
  // Shutdown began while the card was being written: arm nothing, and let the boot sweep settle
  // the card. A timer armed now would be the one this module promised never to leak.
  if (!stopped) arm(entry, APPROVAL_TIMEOUT_MS)
  return {
    roomId: room.id,
    requestId: entry.requestId,
    expiresAt: entry.expiresAt,
    detail: chatOpPendingDetail({ op: input.op, slug: room.slug, timeoutMs: APPROVAL_TIMEOUT_MS, already: false }),
  }
}

/** Whether a request id names a chat-op card (posted or still posting). The decision router asks
 *  this before assuming an id is a worker's. */
export function hasChatOp(requestId: string): boolean {
  return pending.has(requestId)
}


/**
 * Answer a chat-op card. **Fully synchronous, and that is load-bearing** for the same reason
 * `chatAgentDecide` is: two people clicking Approve in the same second must not both reach
 * `deleteRoom`. Nothing here awaits, so the entry is found and removed inside one turn of the event
 * loop and the second caller finds nothing.
 *
 * A refusal leaves the card OPEN - "join first", "the deletion failed" - because
 * every one of those is about this attempt, not about the request. Settling the card on a lurker's
 * misclick would let the wrong person close a question that was asked of the right ones.
 */
export function decideChatOp(input: {
  roomId: string
  requestId: string
  action: 'approve' | 'deny'
  reason?: string
  actor: { id: string; display: string }
}): ChatOpDecisionResult {
  const entry = pending.get(input.requestId)
  // A card from another room cannot be answered through this room's endpoint, and answers
  // identically to "no such card" so the endpoint discloses nothing about other rooms.
  if (entry === undefined || entry.roomId !== input.roomId) {
    return { ok: false, detail: 'nothing is waiting for a decision here' }
  }
  if (entry.card === null) return { ok: false, detail: 'that card is still being posted - try again in a moment' }

  const store = chatStore()
  const slug = store.roomSlugById(entry.roomId)
  if (slug === null) {
    // Deleted underneath us - by a session-authenticated admin, say. The card went with the room,
    // so there is nothing to settle; only the entry is stale.
    forget(entry)
    return { ok: false, detail: 'that room no longer exists' }
  }

  const reason = (input.reason ?? '').trim()
  if (input.action === 'deny') {
    forget(entry)
    settle(entry, slug, {
      state: 'denied',
      decidedBy: input.actor.id,
      decidedByDisplay: input.actor.display,
      reason,
    })
    return { ok: true, detail: 'denied' }
  }

  // BEFORE the entry is removed, so a refused attempt leaves the card exactly as it was.
  if (!store.canReadRoom(entry.roomId, input.actor.id)) {
    return { ok: false, detail: `#${slug} is not yours to read, so it is not yours to destroy` }
  }

  forget(entry)
  let deletion: ChatRoomDeletion
  try {
    // The approver is the actor: their readability is what the store checks, and their id is what
    // the log below records. Nothing is written into the card first - the room, card included, is
    // about to go, and stamping "approved" onto it would only matter if the delete then failed,
    // which is the case where the stamp would have to be taken back.
    deletion = store.deleteRoom(slug, input.actor.id)
  } catch (error) {
    if (error instanceof ChatNotFoundError) return { ok: false, detail: 'that room no longer exists' }
    // Nothing was destroyed, so the question is still open: put the request back with whatever
    // time it had left, and say why this attempt did not take.
    restore(entry)
    return { ok: false, detail: `the deletion failed, so the card is still open: ${reasonOf(error)}` }
  }
  // The room's transcript is gone, card and all, so this line is the record of who approved what.
  console.log(
    `  chat: #${slug} deleted - approved by ${input.actor.id}, requested by ${entry.requestedBy} over the API (${deletion.messages} messages, ${deletion.blobs} blobs unlinked)`
  )
  return { ok: true, detail: `approved - #${slug} is gone (${deletion.messages} messages)` }
}

/**
 * Settle every chat-op card the last process left pending. Called once at boot, before anything
 * can post a new one.
 *
 * Same argument as the worker cards' sweep: the request a card names lived in the last process's
 * memory, and a card still offering buttons that answer nothing is the failure the durable card
 * was chosen to avoid. Best-effort and its own try - a failure here must not stop the server
 * booting.
 */
export function startChatOpApprovals(): void {
  try {
    const store = chatStore()
    for (const card of store.pendingCards('chat-op')) {
      const meta = card.meta
      if (meta === undefined || meta.kind !== 'chat-op') continue
      const slug = store.roomSlugById(card.roomId)
      if (slug === null) continue
      writeCard(slug, card.id, resolvedCardBody(card.body, { state: 'expired', decidedBy: null }), {
        ...meta,
        state: 'expired',
        decidedBy: null,
        decidedAt: Date.now(),
      })
    }
  } catch {
    /* best-effort: a corrupt row or a closed store must not stop the server booting */
  }
}

/**
 * Stop every timer. Nothing is settled here - the process is going away and the boot sweep is what
 * settles a card it leaves behind - but a timer left armed is a write into a store that is being
 * closed underneath it. Every timer is also `unref`'d, so none can hold the process open on its own.
 */
export function stopChatOpApprovals(): void {
  stopped = true
  for (const entry of pending.values()) {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
  }
  pending.clear()
}

function heldFor(roomId: string, op: ChatOpKind): PendingChatOp | null {
  for (const entry of pending.values()) {
    if (entry.roomId === roomId && entry.op === op) return entry
  }
  return null
}

function metaFor(entry: PendingChatOp, state: ChatOpApprovalMeta['state'], decidedBy?: string | null): ChatOpApprovalMeta {
  return {
    kind: 'chat-op',
    requestId: entry.requestId,
    op: entry.op,
    roomId: entry.roomId,
    label: chatOpLabel({ op: entry.op, slug: entry.slug }),
    requestedBy: entry.requestedBy,
    state,
    expiresAt: entry.expiresAt,
    ...(state === 'pending' ? {} : { decidedBy: decidedBy ?? null, decidedAt: Date.now() }),
  }
}

function arm(entry: PendingChatOp, afterMs: number): void {
  entry.timer = setTimeout(() => expire(entry), afterMs)
  // A pending card must never hold the process open - the same rule every chat timer follows.
  entry.timer.unref?.()
}

function expire(entry: PendingChatOp): void {
  // Answered, or restored as a different object, while the timer was in flight: not ours to settle.
  if (pending.get(entry.requestId) !== entry) return
  forget(entry)
  const slug = chatStore().roomSlugById(entry.roomId)
  if (slug === null) return
  settle(entry, slug, { state: 'expired', decidedBy: null })
}

/** Rewrite the card for its settled state. The entry must already be forgotten. */
function settle(entry: PendingChatOp, slug: string, outcome: ApprovalOutcome): void {
  if (entry.card === null) return
  writeCard(slug, entry.card.messageId, resolvedCardBody(entry.card.body, outcome), metaFor(entry, outcome.state, outcome.decidedBy))
}

function forget(entry: PendingChatOp): void {
  if (entry.timer !== null) clearTimeout(entry.timer)
  entry.timer = null
  pending.delete(entry.requestId)
}

/** Put a request back after an approve that did not take, with the time it had left. */
function restore(entry: PendingChatOp): void {
  pending.set(entry.requestId, entry)
  if (!stopped) arm(entry, Math.max(0, entry.expiresAt - Date.now()))
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
