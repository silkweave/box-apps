// The in-process chat event bus: ChatStore publishes each COMMITTED outbox row here (plus the
// outbox-less per-user ephemerals - see ChatEphemeralEvent in types.ts) and the server's chatFeed
// subscription fans it out to connected clients.
//
// Deliberately NOT the changes.ts bus. That one is payload-free by design ("events are invalidation
// hints only - no payloads, no row data - so fanning them out to any authenticated principal leaks
// nothing"), and chat events carry actual message bodies, which are room-scoped personal data. A
// separate bus keeps that guarantee intact; safety here comes from the SERVER filtering each
// subscriber's stream by room membership before anything is yielded.

import type { ChatBusEvent } from './types.js'

type ChatListener = (ev: ChatBusEvent) => void

const listeners = new Set<ChatListener>()

/** Emit a committed chat event to every subscriber. Never throws (a bad listener can't break, or
 *  roll back the perception of, a write that has already committed). */
export function emitChatEvent(ev: ChatBusEvent): void {
  for (const listener of listeners) {
    try {
      listener(ev)
    } catch {
      /* subscriber errors never propagate into the write path */
    }
  }
}

/** Subscribe to chat events; returns the unsubscribe function. */
export function onChatEvent(listener: ChatListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
