// In-channel approval for DESTRUCTIVE chat operations asked for by an API client (2026-09-02): the
// rule that decides a call needs a human, and what the card that asks them says.
//
// Sibling of `agent-approvals.ts`, and in @silkweave/box-core for the same reason: it is the only package with
// tests, and the rule below is a security boundary rather than a nicety. The chat agent's codex
// config auto-approves every MCP tool call at the engine (`default_tools_approval_mode = "approve"`,
// docs/SERVER.md § The MCP elicitation trap), so for a tool that purges a room the engine-side
// approval surface is NOT a gate, and a role gate was never one either - nova IS an admin, which is
// why the route's `@Roles('admin')` could be dropped on 2026-09-06 without weakening anything. This
// is the guard that puts a person back in the loop, and the only one that does.
//
// The server module `apps/server/src/chat/chat-op-approvals.ts` is the I/O shell - the pending
// registry, the timers, the store - around these pure functions. Nothing here touches the store, the
// clock, or the network.

import type { PrincipalCredential } from '../../auth/principal.js'
import { cardField } from './agent-approvals.js'
import { systemUserId } from '../../box-config.js'
import type { ChatOpKind } from './types.js'

/**
 * Whether a destructive chat operation must be held for an in-channel approval instead of running.
 *
 * The rule keys on HOW the principal authenticated, not on WHICH transport the call arrived over,
 * and the reason is what the request object looks like on each path. An MCP tool call reaches the
 * controller through a stand-in request the adapter synthesizes from the tool's `requestInfo` -
 * headers and an optional url, no method, no `originalUrl` - so "is this MCP?" could only be read
 * off an absence. The credential is a positive fact the auth guard establishes on every request:
 * a signed session cookie is a browser with a person at it; a bearer token is an API client (MCP,
 * the `cli` proxy, a script), and a model cannot choose how the client it drives authenticates.
 *
 * Two things are gated, and the shape is deny-by-default:
 * - anything that is not demonstrably a session - `bearer`, or no credential recorded at all - so a
 *   future transport that forgets to record one is held rather than let through;
 * - the service account itself, whatever it presented. `nova` never sits at a browser, and a session
 *   minted in its name is not a person deciding.
 *
 * The consequence worth knowing: a human's OWN Claude Code session, holding that human's token,
 * is gated too. That is intended - the harness may have auto-approved the tool call, and the card
 * that results is one that same human approves with a click in the room.
 */
export function chatOpNeedsApproval(
  input: { credential: PrincipalCredential | undefined; principalId: string },
  agentId: string = systemUserId()
): boolean {
  return input.credential !== 'session' || input.principalId === agentId
}

/** What the card needs to know about the operation, as far as its prose cares. */
export interface ChatOpCardInput {
  op: ChatOpKind
  /** The target room's slug at request time. Validated by the route's own slug pattern. */
  slug: string
  /** Display name of the principal that asked - prose only; the id lands in `meta.requestedBy`. */
  requestedBy: string
  /** What is at stake, counted at request time so the person deciding can weigh it. Messages
   *  only: since migration 015 a channel has no member list to count - everyone is in it. */
  messages: number
}

/** The short header a client shows over the card, e.g. "Delete #war-room". */
export function chatOpLabel(input: Pick<ChatOpCardInput, 'op' | 'slug'>): string {
  // One operation today. When a second arrives this becomes a switch; until then a switch over a
  // single member is ceremony.
  return `Delete #${input.slug}`
}

/**
 * The body of a chat-op card in its PENDING state.
 *
 * Same contract as `approvalCardBody`, including the removal of the reply-grammar footer on
 * 2026-09-09: a card is answered by pressing a button and by nothing else, so a paragraph of typing
 * instructions was costing every card three lines for a path that no longer exists. The prose
 * states the stakes in numbers rather than adjectives, because "everything" reads as nothing on the
 * fortieth card and "132 messages" does not.
 */
export function chatOpCardBody(input: ChatOpCardInput): string {
  const who = cardField(input.requestedBy) ?? 'Somebody'
  return [
    `**Approval needed - ${chatOpLabel(input)}**`,
    `${who} asked over the API to permanently delete #${input.slug}: ${plural(input.messages, 'message')}. Messages, attachments and history all go with it, and this cannot be undone.`
  ].join('\n\n')
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

/**
 * The line an API caller gets back when its call was held rather than run.
 *
 * Written for a MODEL reading a tool result, and every clause is there because its absence has a
 * failure mode: "nothing has been deleted" (or it reports success); "tell the room, then stop" (or
 * it narrates and keeps working); "you will not be called back" (or it waits for a callback that
 * does not exist); "do not retry" (or it re-issues the call and a second card appears - the server
 * dedupes, but the model should not be trained to hammer a gate); "do not say the room is gone"
 * (the honesty rule, applied to the one outcome it cannot observe).
 */
export function chatOpPendingDetail(input: { op: ChatOpKind; slug: string; timeoutMs: number; already: boolean }): string {
  const minutes = Math.max(1, Math.round(input.timeoutMs / 60_000))
  const where = input.already
    ? `An approval card for deleting #${input.slug} was already waiting in #${input.slug}; no second card was posted.`
    : `An approval card for deleting #${input.slug} is now posted in #${input.slug}.`
  return `Nothing has been deleted. ${where} Only a human in that room can approve it, and it expires unanswered after ${minutes} minutes. Tell the room you have asked, then stop: you will not be called back with the outcome, so do not retry this call, do not poll for the result, and do not say the room is gone.`
}
