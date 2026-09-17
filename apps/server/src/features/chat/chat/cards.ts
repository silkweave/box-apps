import { systemUserId, chatStore, emitChatEvent, resolvePrincipalById, type ChatMessage, type ChatMessageMeta } from '@silkweave/box-core'

/**
 * The write path shared by every card nova posts into a channel - the worker approval cards the
 * chat agent raises (`agent/chat-agent.ts`) and the chat-op approval cards the server raises on an
 * API client's behalf (`chat-op-approvals.ts`).
 *
 * Its own module because the two owners must not import each other: the agent routes decisions to
 * the chat-op registry, so the registry cannot reach back into the agent for a helper. And the
 * helpers are worth sharing rather than copying - `writeCard` is an authorized write with a
 * fan-out contract, and two copies of that are two places for the contract to drift.
 */

/** nova's display name, resolved through the same directory rule the chat controller uses for a
 *  signed-in poster - never hard-coded, so a rename in Settings travels here for free. */
export async function agentDisplay(): Promise<string> {
  const principal = await resolvePrincipalById(systemUserId())
  return principal?.display ?? systemUserId()
}

/**
 * Post as nova: an ordinary message, optionally carrying card structure.
 *
 * Mentions are deliberately NOT resolved: nova's words never mint a mention, which is the second
 * layer of the chat agent's loop guard (see `agentTriggerFor`). It held for the card bodies that
 * used to spell out `@nova approve`, and it still holds for anything a runner's framing quotes.
 */
export async function postAsAgent(
  slug: string,
  body: string,
  meta: ChatMessageMeta | null = null,
  parentId: string | null = null
): Promise<ChatMessage> {
  const event = chatStore().post(
    slug,
    { id: systemUserId(), display: await agentDisplay() },
    body,
    [],
    [],
    meta,
    parentId
  )
  return event.payload
}

/**
 * Rewrite a card in place - body and meta in one write - and tell the room.
 *
 * The same `message.edited` announcement the agent's `finalize` uses, for the same reason: both
 * shipped clients already replace-by-id on it and neither renders "(edited)" when `editedAt` is
 * null. So a card settling costs no new key, no badge, and no second message - which is what makes
 * a durable card affordable in a working channel.
 *
 * Authorized by the statement (`checkpointCard` matches room, message AND sender), so a guessed id
 * cannot rewrite anybody else's words; a card that does not match is silently left alone. Never
 * throws: every caller is inside a timer or an event callback where a throw has nowhere to go.
 */
export function writeCard(slug: string, messageId: string, body: string, meta: ChatMessageMeta): void {
  try {
    const store = chatStore()
    const room = store.roomBySlug(slug)
    if (!room) return
    const stored = store.checkpointCard(room.id, messageId, systemUserId(), body, meta)
    if (stored === null) return
    emitChatEvent({
      ephemeral: true,
      type: 'message.edited',
      roomId: stored.roomId,
      userId: null,
      payload: stored,
      at: Date.now(),
    })
  } catch {
    /* a card that failed to update is stale, not fatal; never throw out of an event callback */
  }
}
