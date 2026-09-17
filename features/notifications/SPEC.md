# `notifications` - the bell, push, and alerts into chat

**A glue feature** (`docs/core/SEAM.md` § 4.2), and the one the pattern was invented for. `chat` is
useful alone: rooms, mentions, the agent's seat, its own sidebar unread badges. `alerts` is useful
alone: rules over the events spine, the alert ledger, the `/alerts` feed, Lark as its native sink.
The *together*-part is this third feature, and it is two things pointing in opposite directions -
a top-bar **bell** that merges chat mentions and messages with warehouse alerts into one list, and
a **chat transport registered into alerts** so a rule routed `chat:<slug>` lands as a post in a
room. Delete it and both halves keep working, minus exactly those two things: chat has no bell (the
chat sidebar still counts unread), and an alert routed `chat:standup` matches no transport and
falls back to alerts' own Lark routing - it stays in the feed and the ledger either way. Both true,
both fine. That is the whole argument for glue.

- **dependsOn**: `chat`, `alerts`. From **chat** it takes `chatStore()` (mentions, recent messages,
  the notification watermark and dismissal tables, push subscriptions, device tokens, room lookup,
  `directPeer`), `onChatEvent`/`ChatBusEvent`/`ChatMessage` (the delivery trigger), and on the web `subscribeChatFrames` from
  `features/chat/lib/useChatData.ts`. From **alerts** it takes `listAlerts` (the bell's second
  stratum), the `AlertTransport` / `AlertRecord` types and `registerAlertTransport`. From core:
  `resolvePrincipalById`, `readUsers`, `credential`, the `AuthGuard`.
- **Nothing depends on `notifications`.** It is a leaf; it is the longest chain in the Box
  (`notifications -> alerts -> data`).
- **Removal**: `rm -rf` the three directories. No feature names it, no table is its own to drop.

## Tables

None. `models: []`, `migrations: []` - the core manifest is four lines.

Its state lives in three places it does not own:

- **`chat.db`** (chat's feature-private SQLite store, chat's own migration chain, § 3.6):
  `notification_reads` (the per-user alert watermark, chat `002-mentions`),
  `notification_dismissals` (per-item tombstones, chat `003-notification-dismissals`),
  `push_subscriptions` (chat `004-push-subscriptions`) and `device_tokens` (chat
  `005-device-tokens`). Chat wrote those migrations with this feature in mind - `004`'s comment
  says outright that "a native app brings its own table and its own transport". Read state for an
  interactive bell is a small hot per-user write, which is the shape DuckDB's ephemeral
  single-writer design is wrong for; chat.db is the instance's store for exactly that, and is only
  called "chat" because chat got there first.
- **The DuckDB warehouse**, via alerts: the `alerts` table is read through `listAlerts` and never
  written here.
- **`<BOX_DATA_DIR>/config/credentials.json`** under the `push.*` channel: the VAPID pair and the
  FCM service account. Secrets go in credentials, never `.env` (see Env below).

There is **no join between the two engines**, on purpose. Both reads are capped at `FEED_LIMIT`
(30) and merged in memory on `at`; a DuckDB `ATTACH` of chat.db would put the interactive bell
behind the warehouse's single-writer lock, which is the coupling chat.db exists to avoid.

## What it registers where

Two ports, both filled from `NotificationsModule.onModuleInit`
(`apps/server/src/features/notifications/notifications/notifications.module.ts`), which owns no
providers at all - the chat SQLite handle belongs to `ChatModule`:

| Registration | Into | Effect |
|---|---|---|
| `startNotificationDelivery()` | its own chat-bus listener | translates `mention.created` and DM `message.created` into `NotificationDelivery` structs |
| `registerWebPushTransport()` | its own delivery seam (`delivery.ts`) | web push; returns `false` and does nothing when VAPID is unconfigured |
| `registerFcmTransport()` | the same seam | FCM/APNs device push; `false` when the service account is unconfigured |
| `registerAlertTransport(CHAT_ALERT_TRANSPORT)` | **alerts'** port (`features/alerts/transports.ts`) | routes `chat:<slug>` to a chat room post |

**The direction rule**: the dependent registers into the dependency, never the reverse. `alerts`
owns the `AlertTransport` port and has no idea chat exists; `notifications` - which depends on both
and may therefore import both - hands it an implementation at boot. The same shape is how `data`
takes signal hooks and how core takes `onEvent` listeners (§ 4.3). `registerAlertTransport` throws
on a duplicate `id`, so the registration is once-per-process, not idempotent; the delivery seam's
own `registerNotificationTransport` replaces by name instead, so a hot reload cannot double-send.

The alert-to-chat side lives in **core**, not the server
(`packages/core/src/features/notifications/alerts-chat.ts`): it is a store write, and core cannot
import the server. `chatRouteSlug` accepts `chat:<slug>` only, refusing `chat:dm:...` (`:` is the
DM namespace) and anything the chat controller would refuse; every non-`chat:` route falls through
to alerts' own routing untouched. One post per pass carries the whole batch, the sender is the
agent (core's `systemUserId()`, display resolved through the user directory so a rename in Settings
travels), and **no mentions are ever emitted** so an alert cannot trigger the chat agent's mention
loop. A missing room throws on purpose: the alert row records the error and stays visible in
history rather than vanishing into a room nobody created.

## Delivery: what pushes, and what does not

`delivery.ts` is the transport-agnostic seam. Two chat-bus events qualify, and only the two
addressed to a person:

- `mention.created` - somebody wrote your handle.
- `message.created` **in a direct message** - delivered to the peer, never the sender. A DM is
  addressed to its peer by construction, so the message *is* the mention. A plain message in a
  named room never pushes; the bell carries it and the chat sidebar counts it.

The two are deduplicated: a mention inside a DM is folded into the DM nudge that already went out.
The agent's own messages never push. A transport is handed `{ userId, kind, roomSlug, actor,
actorId, messageId, preview, at }` - `preview` is a 120-char excerpt of `message.body` and
**nothing else**; attachments have no field here by design, because a URL on a lock screen outlives
the notification. `deliverNotification` never throws: one failing transport must not break the
others or propagate into the chat bus. Copy is shared by both transports in
`notification-copy.ts` - a mention names the room, a DM names only the person - so phone and
browser cannot drift.

## Push

Both transports are off by default and their absence is silent and harmless.

**Web push (VAPID)**, `push.ts`. Reads `credential('push', '*', 'VAPID_PUBLIC_KEY' |
'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT')` from `<BOX_DATA_DIR>/config/credentials.json`; any one
missing means push is off and `notificationsPushConfig` answers `enabled:false`, at which point the
toggle in the bell simply does not render. The pair is **durable**: rotating it invalidates every
stored subscription. Sends carry the full 120-char preview (decided 2026-08-30), TTL 3600s,
urgency `high`. A 404/410 from an endpoint deletes the subscription row immediately; anything else
is not retried. Subscriptions unseen for 60 days are pruned at boot, and `last_seen_at` is stamped
on every success - a subscription is treated as a capability.

**FCM**, `fcm.ts`, for the Flutter app. Reads `credential('push', '*', 'FCM_SERVICE_ACCOUNT')` -
the Firebase service-account document pasted as a JSON **string**. Absent and malformed both mean
off, but malformed logs a warning, because a mis-escaped `private_key` otherwise looks exactly like
never having configured it. FCM HTTP v1, no SDK: a self-signed RS256 JWT from `node:crypto`
exchanged for an OAuth token cached 50 minutes. Same posture as web push - per-token fan-out,
`UNREGISTERED`/404 deletes the row, 60-day prune at boot. APNs is Firebase's problem.

The **service worker** is a string in `push-sw.ts` served by `PushWorkerController` at
`/api/push/sw.js`, unguarded (no secrets in it, and a registration fetch must never bounce off
auth) with `Service-Worker-Allowed: /` so the SPA can register it at scope `/`. It swallows a push
for a room a focused window is already looking at, fetches and rounds the sender's avatar through
the guarded `/api/push/avatar/:id` proxy (data-URI avatars cannot ride a ~4KB payload; a CORS-less
CDN image would taint the canvas), and offers two actions - "Open" (posts `push:navigate` to the
tab so TanStack Router routes with no reload) and "Mark read" (a credentialed POST to
`/api/notifications/seen`).

### Env

| Name | Declared in | Read by |
|---|---|---|
| `PUSH_VAPID_PUBLIC_KEY` | `ServerFeature.env` | nothing - see below |
| `PUSH_VAPID_PRIVATE_KEY` | `ServerFeature.env` | nothing - see below |

`pnpm verify` prints these when unset, but **no code reads them**. The values the code actually
reads are credentials (`push.*.VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`,
`FCM_SERVICE_ACCOUNT`), which is where secrets belong. Treat the two `env` entries as documentation
that has drifted from the code.

## Procedures and tools

`NotificationsController` (`@Controller('notifications')`, class-level `@UseGuards(AuthGuard)`) -
every procedure is principal-scoped; the client never supplies a user id. **No `@Mcp` decorator
anywhere in the feature**: the bell is a human surface, and an agent already sees chat and alerts
through their own tools.

| tRPC | MCP | what |
|---|---|---|
| `notificationsList` (query) | - | the whole bell in one round trip: merged items, `unseenMentions`, `unseenAlerts` |
| `notificationsMarkSeen` (mutation) | - | with `messageId`, dismiss that one mention; without, mark everything seen |
| `notificationsDismiss` (mutation) | - | throw one item out, keyed by its bell id (`mention:` / `message:` / `alert:<id>`) |
| `notificationsClear` (mutation) | - | empty the bell: one watermark write, so it also covers items past the feed limit |
| `notificationsPushConfig` (query) | - | `{ enabled, publicKey }`; the VAPID public key is public by construction |
| `notificationsPushSubscribe` (mutation) | - | store this browser's subscription, idempotent on the endpoint |
| `notificationsPushUnsubscribe` (mutation) | - | the app-side revoke, scoped to the caller's rows |
| `notificationsDeviceRegister` (mutation) | - | store the mobile app's FCM token, idempotent on the token |
| `notificationsDeviceUnregister` (mutation) | - | the app-side revoke on sign-out |

Nine procedures, zero MCP tools.

Plus `PushWorkerController` (`@Controller('push')`), two plain HTTP routes that are deliberately
not tRPC: `GET /api/push/sw.js` (`@Public`) and `GET /api/push/avatar/:id` (`@UseGuards(AuthGuard)`,
the SW's credentialed avatar proxy).

Three read models, three different answers to "have I seen it?", and that is not drift: a mention
is `mentions.seen_at` (per row, individually dismissable), a message is `room_members.last_read_at`
(the pointer the sidebar already owns - inventing a second one would let the two disagree), and an
alert is a per-user watermark in `notification_reads`. Marking the bell seen **never** writes
`room_members.last_read_at`: clearing the bell is not reading your rooms.

`alertSeenKey(eventAtMs, createdAt)` clamps an alert's seen-time to when the row was recorded. A
future-dated `event_at` from a skewed upstream clock would otherwise be permanently unseen against
a `Date.now()` watermark, and the bell's mark-on-open would fight the reload forever - which it
did, unattended, on 2026-09-10.

## Actions

None. `notifications` contributes nothing to core's run funnel: there is nothing to schedule.
Alert *evaluation* and *delivery* are alerts' own actions (`alerts-reddit`, `alerts-github`,
`alerts-linkedin`, `alerts-traction`, `alerts-digest`); this feature only supplies a transport they
route through.

## UI

- **Routes**: none. `routes: []` - the feature has no page of its own. The bell deep-links into
  chat's `/chat/$room`.
- **Nav**: none, so no order band.
- **Settings**: none. The one setting it has (push on/off for this browser) lives in the bell
  itself, because it is per-browser state and Settings is not.
- **Shell**: `shell.topbar`, one entry, `order: 200`, component `NotificationBell` - the bell is
  app-wide chrome deliberately, because chat's own badges only exist while you are looking at
  `/chat`, which is precisely when you do not need telling.
- **`onSession`**: arms `startNotifications()` (one module-scope subscription to the shared chat
  frame feed, so the badge is correct before the dropdown is ever opened) and returns the unlisten
  from `listenPushNavigate(...)`, which turns the SW's `push:navigate` message into a client-side
  `router.navigate`.
- **Slots**: none contributed, none consumed.
- The badge counts **mentions + alerts only**, never unread messages - the chat sidebar owns that
  number, and two badges over overlapping sets are how you get two numbers that are both right and
  disagree. Opening the dropdown *is* the acknowledgement; a guard (`stuck`) stops one ack per open
  from looping when the server hands the badge straight back.
- Live refresh comes from two signals: `registerStoreReloads(['table:alerts'])` on the changes bus
  for the warehouse half, and three chat frame types (`mention.created`, `message.created`,
  `message.deleted`) for the chat half, since chat.db writes emit nothing on the changes bus.

## What a team customises

Realistically, four things:

1. **Which alerts land in which room** - a rule's `route` field in Settings -> Rules. `chat:<slug>`
   is the whole vocabulary this feature adds; everything else stays alerts'.
2. **Whether push exists at all** - generate a VAPID pair and/or paste an FCM service account into
   `credentials.json`. Nothing else changes when you do not.
3. **The copy** - `notification-copy.ts` is two pure functions, and it is the only place the words
   live for both transports.
4. **What pushes** - `startNotificationDelivery`'s two qualifying events. Widening this to "every
   message in every subscribed room" is available and is how a team turns notifications off; the
   code argues against it at length before you get there.

Bell strata, the 30-item feed limit, the 120/180-char previews and the badge's definition are
tuned and documented in place; change them knowing why they are what they are.

Product fallback title and artwork come from core `BOX_BRAND`; see
[Branding a Box](../../docs/BRANDING.md). Sender-specific notification copy is unchanged.
