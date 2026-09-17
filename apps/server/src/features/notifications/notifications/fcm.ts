// The FCM transport (mobile POC) - the second real transport behind the delivery seam, the one
// push.ts's comments promised. Everything FCM-specific lives HERE: the seam still hands over the
// same transport-agnostic NotificationDelivery, and the device_tokens table (chat migration 005)
// is this transport's own, exactly as 004's comment prescribed ("a native app brings its own
// table and its own transport").
//
// Protocol: FCM HTTP v1. Auth is a Google service account - a self-signed RS256 JWT exchanged at
// Google's token endpoint for a ~1h OAuth token, cached here for 50 minutes. No SDK: the flow is
// three well-documented requests and node:crypto signs RS256 natively, which keeps firebase-admin
// (and its dependency tree) out of the server.
//
// Config is channel-scoped in data/config/credentials.json like every other secret (never .env):
//   push.*.FCM_SERVICE_ACCOUNT = the service account JSON, as a string (from the Firebase console:
//     Project settings -> Service accounts -> Generate new private key).
// Unset simply means the transport is off - identical posture to VAPID in push.ts. APNs itself is
// Firebase's problem: upload the APNs auth key in the Firebase console and FCM fans out to iOS.
//
// The payload carries the same 120-char preview as web push (decision of 2026-08-30) and rides
// FCM's own transport encryption. Same capability rules: UNREGISTERED deletes the row
// immediately, last_seen_at is stamped on every successful send, stale rows are pruned at boot.

import { createSign } from 'node:crypto'
import { chatStore, credential } from '@silkweave/box-core'
import { registerNotificationTransport, type NotificationDelivery } from './delivery.js'
import { notificationTag, notificationTitle } from './notification-copy.js'

interface FcmServiceAccount {
  project_id: string
  client_email: string
  private_key: string
}

/**
 * The service account, or null when unconfigured (= the transport is off).
 *
 * ABSENT and MALFORMED are both null, because the caller's decision is the same
 * either way - but they are not the same mistake, so a value that is present and
 * unusable SAYS SO. Silence here is the expensive failure: the credential is a
 * JSON document pasted as a single JSON string, the private key is one long line
 * of escaped newlines, and getting that wrong looks exactly like never having
 * configured it. Never log `raw` - it is a private key.
 */
export function fcmServiceAccount(): FcmServiceAccount | null {
  const raw = credential('push', '*', 'FCM_SERVICE_ACCOUNT')
  if (!raw) return null
  let parsed: Partial<FcmServiceAccount>
  try {
    parsed = JSON.parse(raw) as Partial<FcmServiceAccount>
  } catch {
    console.warn(
      'push: credential push.*.FCM_SERVICE_ACCOUNT is not valid JSON - device push is OFF. It must be the service-account document as a JSON STRING (newlines in private_key escaped as \\n).'
    )
    return null
  }
  const missing = (['project_id', 'client_email', 'private_key'] as const).filter((k) => !parsed[k])
  if (missing.length > 0) {
    console.warn(`push: credential push.*.FCM_SERVICE_ACCOUNT is missing ${missing.join(', ')} - device push is OFF.`)
    return null
  }
  return parsed as FcmServiceAccount
}

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
/** Google mints ~1h tokens; refresh at 50min so a send never rides an expiring one. */
const TOKEN_REFRESH_MS = 50 * 60 * 1000
/** Tokens with no successful send for this long are dead installs; prune at boot (same window
 *  as web push subscriptions). */
const PRUNE_AFTER_MS = 60 * 24 * 60 * 60 * 1000

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url')

let cachedToken: { value: string; mintedAt: number } | null = null

/** A bearer for the FCM v1 API: self-signed JWT -> OAuth exchange, cached for 50 minutes. */
async function fcmAccessToken(sa: FcmServiceAccount): Promise<string> {
  if (cachedToken !== null && Date.now() - cachedToken.mintedAt < TOKEN_REFRESH_MS) return cachedToken.value
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(
    JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_ENDPOINT, iat: now, exp: now + 3600 }),
  )
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key)
  const assertion = `${header}.${claims}.${b64url(signature)}`
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!res.ok) throw new Error(`FCM token exchange failed: ${res.status} ${await res.text()}`)
  const json = (await res.json()) as { access_token: string }
  cachedToken = { value: json.access_token, mintedAt: Date.now() }
  return json.access_token
}

/**
 * Register the FCM transport on the delivery seam. Idempotent (the registry replaces by name).
 * Returns false when the service account is unconfigured - push to devices is simply off.
 */
export function registerFcmTransport(): boolean {
  const sa = fcmServiceAccount()
  if (sa === null) return false

  // Boot-time hygiene, mirroring web push: stale rows only matter while a process could send.
  chatStore().deviceTokenPruneUnseenSince(Date.now() - PRUNE_AFTER_MS)

  const endpoint = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`

  registerNotificationTransport({
    name: 'fcm',
    deliver: async (delivery: NotificationDelivery): Promise<void> => {
      const store = chatStore()
      const tokens = store.deviceTokensFor(delivery.userId)
      if (tokens.length === 0) return
      const bearer = await fcmAccessToken(sa)

      const slug = delivery.roomSlug
      // Per kind: a mention names the room, a DM names only the person (notification-copy.ts).
      const title = notificationTitle(delivery)
      // Collapsed by room and kind, like web push's tag: two nudges in one room replace.
      const tag = notificationTag(delivery)

      // One notification per device; failures are per-token so one dead install cannot mute the
      // user's other devices - the same posture as the web-push fan-out.
      await Promise.all(
        tokens.map(async (device) => {
          const message = {
            message: {
              token: device.token,
              notification: { title, body: delivery.preview },
              // The shared deep-link contract: the app routes on roomSlug (the same data web
              // push carries as /chat/<slug>).
              data: { kind: delivery.kind, roomSlug: slug ?? '', at: String(delivery.at) },
              android: {
                priority: 'HIGH' as const,
                collapse_key: tag,
                notification: { channel_id: 'box_chat' },
              },
              apns: {
                headers: { 'apns-priority': '10', 'apns-collapse-id': tag },
                payload: { aps: { sound: 'default', 'thread-id': tag } },
              },
            },
          }
          try {
            const res = await fetch(endpoint, {
              method: 'POST',
              headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
              body: JSON.stringify(message),
            })
            if (res.ok) {
              store.deviceTokenSeen(device.token, Date.now())
              return
            }
            // UNREGISTERED (or a plain 404) means the install is GONE: delete the row,
            // immediately, no retry. Anything else is transient and deliberately NOT retried
            // into a hot loop - the mention is still durably in the bell.
            const body = await res.text()
            if (res.status === 404 || body.includes('UNREGISTERED')) store.deviceTokenDelete(device.token)
          } catch {
            /* transient network failure - the mention is still in the bell */
          }
        }),
      )
    },
  })
  return true
}
