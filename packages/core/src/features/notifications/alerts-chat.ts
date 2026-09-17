// Deliver alerts into a chat room, as the agent. Registered with alerts as the `chat` transport.
//
// The alerts spine's only sink was Lark. A `chat:<room-slug>` route sends the SAME rendered
// `message` template into a channel instead, which is what an event nobody needs paged for - a
// campaign lead moving stage - actually wants: a durable line in a room people read, not a DM.
//
// Deliberately NOT `postAsAgent` (apps/server/src/features/chat/chat/cards.ts): core cannot import the server.
// The identity rule is copied rather than shared, and it is the same one - nova, display resolved
// through the directory so a rename in Settings travels for free, and NO mentions, ever, so an
// alert can never trigger the chat agent's mention loop.

import { systemUserId } from '../../box-config.js'
import { chatStore } from '../chat/store.js'
import { resolvePrincipalById } from '../../auth/principal.js'
import type { AlertRecord } from '../alerts/types.js'
import type { AlertTransport } from '../alerts/transports.js'

/** `chat:<slug>` -> `<slug>`, or null when the route is not a chat route. */
export function chatRouteSlug(route: string): string | null {
  const match = /^chat:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/.exec(route)
  return match ? match[1] : null
}

async function agentSender(): Promise<{ id: string; display: string }> {
  const principal = await resolvePrincipalById(systemUserId())
  return { id: systemUserId(), display: principal?.display ?? systemUserId() }
}

/**
 * Post one message carrying every alert routed to this room. One message per pass, mirroring the
 * Lark batching rule - a burst of ten leads is one line each under one post, not ten pings.
 *
 * Throws when the room does not exist, which is what the caller wants: the alert row records the
 * error and stays visible in history rather than vanishing into a room nobody created.
 */
export async function deliverAlertsToChat(slug: string, alerts: readonly AlertRecord[]): Promise<void> {
  const store = chatStore()
  if (!store.roomBySlug(slug)) {
    throw new Error(`chat route "chat:${slug}" points at a room that does not exist`)
  }
  const body =
    alerts.length === 1
      ? alerts[0].message
      : alerts.map((a) => `- ${a.message}`).join('\n')

  store.post(slug, await agentSender(), body, [], [], null, null)
}

/** The transport alerts routes `chat:<slug>` through. Registered by NotificationsModule. */
export const CHAT_ALERT_TRANSPORT: AlertTransport = {
  id: 'chat',
  matchRoute: chatRouteSlug,
  deliver: deliverAlertsToChat,
}
