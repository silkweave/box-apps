import { systemUserId, chatStore, onChatEvent, type ChatBusEvent, type ChatMessage } from '@silkweave/box-core'

/**
 * The delivery seam - where a notification stops being a row and becomes a nudge on a device.
 *
 * The seam was built transport-less on purpose (the bell already works by POLLING its own store
 * over the live feed) so that adding a transport is a registration, not a new concern threaded
 * through the store, the controller and the bus. That held: the first real transport - web push,
 * chat Track 9, 2026-08-30 - lives entirely in push.ts and registers here at module init. The
 * next one (the native app's APNs/FCM transport) does the same and receives the identical struct.
 *
 * WHY this is a server file and not a core one. `packages/core` owns storage and domain rules;
 * chat.db must stay a self-contained SQLite file with no idea that HTTP, VAPID keys or a push
 * service exist. Delivery is transport, and transport lives with the process that owns the network.
 *
 * WHY it hangs off the chat bus rather than being called from `ChatStore.post`. The store publishes
 * strictly AFTER its transaction commits, and refuses to run inside an enclosing one - so anything
 * listening here is guaranteed to be reacting to something that is durably true. Calling a
 * transport from inside the write path would let a slow or failing push hold a SQLite write
 * transaction open, which is the one thing a single-writer file database must never do.
 *
 * ## The payload decision (taken 2026-08-30)
 *
 * The dashboard is tailnet-only; web push is not - the browser holds its own connection to its
 * push service and the send is outbound, so a pushed mention lands on a machine nowhere near the
 * tailnet. The body-less conservative option was considered and DECLINED: the payload carries the
 * full 120-char preview, because a nudge you have to open the app to understand is a nudge people
 * turn off. What follows is that a subscription is a capability - see push.ts for the prune rules,
 * and Track 11's upload URLs must never appear in a preview.
 */

/** What a transport is handed. Deliberately small, and deliberately free of web-push concepts so
 *  a future APNs/FCM transport needs nothing added: `preview` is a bounded excerpt, never the full
 *  message, so a transport cannot accidentally widen the blast radius. */
export interface NotificationDelivery {
  /** The `users.id` to reach. */
  userId: string
  /**
   * `mention`: somebody wrote your @handle. `dm`: somebody wrote to you in a direct message (chat
   * Track 14) - the first and only plain message that pushes, because a DM is addressed to you the
   * way a mention is. The transports shape the copy per kind; nothing else here differs.
   */
  kind: 'mention' | 'dm'
  /** Room slug - enough to deep-link. For a DM it is the derived `dm:<a>:<b>`, which is why the
   *  transports must not print it in a title. */
  roomSlug: string | null
  /** Display name of whoever caused it. */
  actor: string
  /** `users.id` of whoever caused it - lets a transport resolve an avatar. Null if unknown. */
  actorId: string | null
  /** The mentioning message's id - lets a transport offer "mark read" against the bell. */
  messageId: string | null
  /** A SHORT preview. A transport that leaves the tailnet should think hard before sending it.
   *  Built from `message.body` and NOTHING else: attachments (Track 11, shipped) have no field
   *  here by design - not a URL, not a filename, not a count. A URL in a push payload outlives
   *  the notification on whatever lock screen it landed on; keep this struct too narrow to
   *  carry one. */
  preview: string
  at: number
}

export interface NotificationTransport {
  name: string
  deliver: (delivery: NotificationDelivery) => Promise<void>
}

const transports: NotificationTransport[] = []

/** Register a delivery transport (web push, a Lark card, whatever comes next). Idempotent by name
 *  so a hot-reloaded module cannot double-register and send everything twice. */
export function registerNotificationTransport(transport: NotificationTransport): void {
  const existing = transports.findIndex((t) => t.name === transport.name)
  if (existing >= 0) transports[existing] = transport
  else transports.push(transport)
}

/** Fan one notification out to every registered transport. Never throws and never rejects: a
 *  failing transport must not break the others, and it must never propagate into the chat bus,
 *  whose publisher is reacting to an already-committed write. */
export async function deliverNotification(delivery: NotificationDelivery): Promise<void> {
  await Promise.all(
    transports.map(async (t) => {
      try {
        await t.deliver(delivery)
      } catch {
        /* a transport's failure is its own problem - see the class comment */
      }
    }),
  )
}

/** How much of a message body a transport may see. Short on purpose - see the payload question. */
const PREVIEW_CHARS = 120

let listening = false

/**
 * Start translating chat-bus events into deliveries. Called once at module init from
 * NotificationsModule.
 *
 * Two events qualify, and they are the two chat events ADDRESSED to a person:
 *
 * - `mention.created` - somebody wrote your handle. The original rule (Track 9).
 * - `message.created` IN A DIRECT MESSAGE (Track 14) - delivered to the other member, never the
 *   sender. This is the one explicit exception to "mentions push, plain messages do not": a DM is
 *   addressed to its peer by construction, so a message there IS the mention. Everywhere else a
 *   plain message still does not push - the bell carries it, the sidebar counts it, and a device
 *   notification for every message in every subscribed room is how a team turns notifications off.
 *
 * The two paths are deduplicated: a mention INSIDE a DM by one of its members (of the peer, or of
 * the agent - the store admits no other mention there) is skipped here, because the
 * `message.created` frame that precedes it on the bus already produced the DM nudge, and two
 * notifications for one sentence is the same failure as pushing every message. The mention row
 * still lands in the bell; only the push is folded. For the agent that fold costs nothing: it has
 * no device, and what summons it is the same `mention.created` ephemeral, read by chat-agent.ts
 * (`ChatStore.isDirectGuest` is the store's side of "@nova in a DM between two people").
 *
 * The agent's own DM messages do not push. Its answer is a placeholder posted first and streamed
 * into afterwards (checkpointBody emits nothing), so the only frame this seam would ever see is
 * the placeholder - a nudge that reads "…" on a lock screen is worse than no nudge. The one
 * exception is deliberate: a mention the agent writes INTO a human DM it is a guest of (a
 * `chat-post` from another room's turn saying "@dan ...") does push as a mention, because
 * `directPeer` answers null for a sender who is not one of the pair - the guest has no peer, so
 * there is no DM nudge for the fold to defer to, and a person addressed by name is owed one.
 */
export function startNotificationDelivery(): void {
  if (listening) return
  listening = true
  onChatEvent((event: ChatBusEvent) => {
    if ('ephemeral' in event) {
      if (event.type !== 'mention.created') return
      // Per-user routing: the store emits one of these per mentioned user, so userId is the target.
      if (event.userId === null) return
      const message = event.payload ?? null
      if (message === null) return
      // The DM fold: the message.created path below already reached this person.
      if (chatStore().directPeer(event.roomId, message.senderId) !== null) return
      void deliver('mention', event.userId, event.roomId, message, event.at)
      return
    }
    if (event.type !== 'message.created') return
    const message = event.payload
    if (message.senderId === systemUserId()) return
    // One indexed read per committed message on the bus: null for every named room, which is the
    // common case and the whole cost of this feature to everything that is not a DM.
    const peer = chatStore().directPeer(event.roomId, message.senderId)
    if (peer === null) return
    void deliver('dm', peer, event.roomId, message, event.at)
  })
}

function deliver(
  kind: NotificationDelivery['kind'],
  userId: string,
  roomId: string,
  message: ChatMessage,
  at: number,
): Promise<void> {
  return deliverNotification({
    userId,
    kind,
    // The bus carries roomId, not the slug. Resolved here (one indexed point read per delivery)
    // rather than per-transport, because the slug is the shared deep-link contract - web push and
    // the native app both route on /chat/<slug>.
    roomSlug: chatStore().roomSlugById(roomId),
    actor: message.senderName,
    actorId: message.senderId,
    messageId: message.id,
    preview: message.body.length <= PREVIEW_CHARS ? message.body : `${message.body.slice(0, PREVIEW_CHARS).trimEnd()}…`,
    at,
  })
}
