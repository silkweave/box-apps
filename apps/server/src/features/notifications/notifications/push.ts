// The Web Push transport (chat Track 9) - the first real transport behind the delivery seam.
//
// Everything push-specific lives HERE, never in the seam: NotificationDelivery stays
// transport-agnostic so the planned native app registers its own transport (APNs/FCM, its own
// device_tokens table) alongside this one and receives the identical struct.
//
// The payload deliberately carries the full 120-char preview (decided 2026-08-30): it travels
// through the browser vendor's push service encrypted to the subscription's p256dh/auth keys, so
// the service cannot read it - but it renders on lock screens of any device holding the
// subscription. That is why a subscription is treated as a capability (prune hard, stamp
// last_seen_at) and why an attachment URL must never appear in a preview (Track 11).

import webpush from 'web-push'
import { chatStore, credential } from '@silkweave/box-core'
import { registerNotificationTransport, type NotificationDelivery } from './delivery.js'
import { notificationTag, notificationTitle } from './notification-copy.js'

export interface PushVapidConfig {
  publicKey: string
  privateKey: string
  subject: string
}

/**
 * The VAPID pair, channel-scoped in `data/config/credentials.json` under `push.*` like every
 * other secret here (never .env - that holds system-level vars only). DURABLE: rotating the pair
 * invalidates every subscription. Null when unconfigured, which simply means push is off.
 */
export function pushVapidConfig(): PushVapidConfig | null {
  const publicKey = credential('push', '*', 'VAPID_PUBLIC_KEY')
  const privateKey = credential('push', '*', 'VAPID_PRIVATE_KEY')
  const subject = credential('push', '*', 'VAPID_SUBJECT')
  if (!publicKey || !privateKey || !subject) return null
  return { publicKey, privateKey, subject }
}

/** A nudge older than this is stale - let the push service drop it rather than deliver history. */
const TTL_SECONDS = 3600

/** Subscriptions with no successful send for this long are dead browsers; prune at boot. */
const PRUNE_AFTER_MS = 60 * 24 * 60 * 60 * 1000 // 60 days

/**
 * Register the web-push transport on the delivery seam. Idempotent (the registry replaces by
 * name). Returns false when VAPID is unconfigured - push is simply off, nothing else changes.
 */
export function registerWebPushTransport(): boolean {
  const vapid = pushVapidConfig()
  if (!vapid) return false

  // Boot-time hygiene, not a scheduler: stale rows only matter when the process that would push
  // to them is alive.
  chatStore().pushPruneUnseenSince(Date.now() - PRUNE_AFTER_MS)

  registerNotificationTransport({
    name: 'web-push',
    deliver: async (delivery: NotificationDelivery): Promise<void> => {
      const store = chatStore()
      const subs = store.pushSubscriptionsFor(delivery.userId)
      if (subs.length === 0) return

      const slug = delivery.roomSlug
      const payload = JSON.stringify({
        // The SW fetches the avatar itself (credentialed, same-origin /api/push/avatar/<id>) and
        // rounds it on an OffscreenCanvas - so no image bytes ride the ~4KB push payload, and
        // data-URI avatars work exactly like CDN ones.
        actorId: delivery.actorId,
        messageId: delivery.messageId,
        kind: delivery.kind,
        // Per kind: a mention names the room, a DM names only the person (notification-copy.ts).
        title: notificationTitle(delivery),
        body: delivery.preview,
        // Collapsed by room and kind: two nudges in the same room replace, never stack.
        tag: notificationTag(delivery),
        // The shared deep-link contract - what a notification click opens, and what the future
        // native app will route on too: /chat/<slug>. A real path since 2026-09-14; the SPA still
        // accepts the old /#/chat/<slug> from notifications delivered before then (lib/push.ts).
        url: slug ? `/chat/${slug}` : '/chat',
        roomSlug: slug,
        at: delivery.at,
      })

      // Every subscription for the user - one notification per device. Failures are per-endpoint:
      // one dead subscription must not mute the user's other browsers.
      await Promise.all(
        subs.map(async (sub) => {
          try {
            await webpush.sendNotification(
              { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
              payload,
              { vapidDetails: vapid, TTL: TTL_SECONDS, urgency: 'high' },
            )
            store.pushSubscriptionSeen(sub.endpoint, Date.now())
          } catch (err) {
            // 404/410 from a push endpoint means the subscription is GONE: delete the row,
            // immediately, no retry. Anything else is transient and is deliberately NOT retried
            // into a hot loop - the mention is still durably in the bell.
            const status = (err as { statusCode?: number }).statusCode
            if (status === 404 || status === 410) store.pushSubscriptionDelete(sub.endpoint)
          }
        }),
      )
    },
  })
  return true
}
