// Chat's widening rule for agent-session access: a room's readers may read that room's @nova turn.
//
// Core owns the verdict type and the ownership rule (`agent-session.ts`); this file is the one
// thing chat adds to it, registered by chat's server module. Until 2026-09-13 core's agent host
// imported `chatStore` directly for the predicate, so deleting the chat feature broke a file
// outside every feature directory.
//
// Nothing here touches the store: `canReadRoom` is injected, so the rule is pinned by vitest
// against an in-memory predicate rather than by careful production.

import { AGENT_SESSION_APP, type AgentSessionRecord, type AgentSessionRule } from '../../agent-session.js'
import { systemUserId } from '../../box-config.js'

/**
 * The chat room a worker session was created FOR, or null for any other session.
 *
 * Read from the meta the chat agent stamps at create (`ensureSession` in chat-agent.ts:
 * `{ app: AGENT_SESSION_APP, user: 'nova', room, roomSlug }`). All three keys are required, and `user` is the
 * one that makes the identification trustworthy: a browser can pass any `meta.room` it likes on
 * its own create, but `gateCreate` overwrites `meta.user` with the signed-in principal, so only
 * the agent's own account can produce a record that reads as one of its room sessions. A person
 * cannot relabel their sidebar session as a room's and thereby publish it to that room.
 */
export function agentRoomOf(session: AgentSessionRecord, agentId: string = systemUserId()): string | null {
  const meta = session.meta
  if (!meta || meta.app !== AGENT_SESSION_APP || meta.user !== agentId) return null
  return typeof meta.room === 'string' && meta.room !== '' ? meta.room : null
}

/**
 * "A room's readers may read that room's agent turn", as a rule core can register.
 *
 * Whoever `canReadRoom` admits to the room is already entitled to watch the turn happen in the
 * channel, so they are entitled to read its transcript. A private room's turns stay private
 * because the predicate is the chat store's own, not a re-derivation. Every other session abstains
 * (null), which core turns into `none` unless some other rule claims it.
 */
export function chatRoomSessionRule(canReadRoom: (roomId: string, userId: string) => boolean): AgentSessionRule {
  return (user, session) => {
    const room = agentRoomOf(session)
    if (room === null || !canReadRoom(room, user)) return null
    return { kind: 'reader', room }
  }
}
