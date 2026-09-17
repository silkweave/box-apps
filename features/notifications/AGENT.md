# Installing `notifications`

The recipe. Read [`SPEC.md`](./SPEC.md) first for what the feature is; this is how it gets into a
Box and what to change afterwards.

## 1. Install

**Install `chat` and `alerts` first.** `notifications` is glue (`docs/core/SEAM.md` § 4.2) and is
useless - in fact unbootable - without both: it imports `chatStore`, `onChatEvent` and
the identity from core and `listAlerts`, `registerAlertTransport` and `AlertRecord` from the
other. `pnpm features --check` refuses the registry and names the missing feature; do not try to
soften the imports, a feature never optionally imports another.

**The scaffold is the working code**, not a copy of it (see `features/README.md`). `box adopt`
fetches it from the registry at its tag, byte-exact, and rewrites the registries and skill links:

```bash
box registry validate                  # confirm the index offers notifications, and at which version
box adopt notifications                # fetches the four directories and anything it dependsOn
pnpm install && pnpm build             # adoption changes package.json; tests resolve via build/
pnpm verify                            # features:check, lint:deps, typecheck, lint, both test suites
```

In this checkout `notifications` is already installed; the above is what a fresh Box runs.

**Do not rename the directory.** The name is the migration ledger namespace and it is the same
string in all three trees. `notifications` has no migrations of its own today - its tables belong
to chat's chain - but the rule has no exceptions.

Nothing else is edited. The service worker uses core `BOX_BRAND.name` and `BOX_BRAND.icon192`
when a payload has no title or a sender has no avatar. Supply the core artwork as described in
[Branding a Box](../../docs/BRANDING.md).

## 2. Customise for the team

1. **Generate a VAPID pair** if this team wants browser push. Any web-push keygen does it
   (`npx web-push generate-vapid-keys`), then write three credentials into
   `<BOX_DATA_DIR>/config/credentials.json` under channel `push`, account `*`:
   `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:` or `https:` URL
   identifying you to the push services). All three, or the transport stays off. Secrets live in
   credentials, never `.env` - the two `PUSH_VAPID_*` entries in
   `apps/server/src/features/notifications/index.ts` are declared for the boot report and are read
   by nothing. **The pair is durable**: rotating it invalidates every stored subscription and every
   browser has to re-enable the toggle.
2. **Device push** is the same shape, one credential: `push.*.FCM_SERVICE_ACCOUNT`, the Firebase
   service-account document (Project settings -> Service accounts -> Generate new private key)
   pasted as a single JSON **string** with the `private_key` newlines escaped as `\n`. Skip it
   unless this team runs `apps/mobile`. APNs is configured in the Firebase console, not here.
3. **Decide which alerts route to which room.** Settings -> Rules, the `route` field on an alert
   rule. `chat:<slug>` is the vocabulary this feature adds - `chat:standup`, `chat:go-to-market`.
   The room must already exist (delivery throws otherwise, and the alert row records the error
   rather than disappearing), the slug must be a plain room - `chat:dm:...` is refused on purpose -
   and everything else (`owner`, `user:<id>`, `channel`) keeps going to alerts' Lark routing
   untouched. The rule dialog's placeholder does not mention `chat:` yet; it still works.
   Rule of thumb from the code's own comment: page a person for what needs answering now, route to
   a room what wants a durable line people read later.
4. **The copy and the badge**, if the team disagrees with them.
   `apps/server/src/features/notifications/notifications/notification-copy.ts` is two pure
   functions shared by both transports - change it there or phone and browser drift. The badge
   counts mentions + alerts and deliberately not unread messages; the bell's topbar `order` is
   `200` in `apps/web/src/features/notifications/index.tsx`.

There is no vocabulary, no table and no migration to seed.

## 3. Prove it

```bash
pnpm dev
```

Open `http://localhost:8190/` (Nest is the single origin; if another Box is already running, move
this one with `PORT` / `BOX_VITE_PORT` rather than sharing a default -
`apps/server/src/agent/loopback-guard.ts`). Signed in, the **bell** sits in the top bar. You
should see:

- a dropdown with "Nothing new." on a fresh Box, and a **Clear all** header once there are rows;
- three strata once there is traffic - `@` mention, message, alert - newest first, with unseen rows
  tinted, a per-row dismiss `X`, and a count pill (capped at `9+`) that clears the moment you open
  the dropdown;
- a **"Push mentions to this browser"** footer row *only* if VAPID is configured. No VAPID means
  `notificationsPushConfig` answers `enabled:false` and the footer does not render at all - that is
  correct, not a failure.

End to end, four checks that exercise the whole feature:

1. **Bell, chat half** - from a second session (or `pnpm cli chat-post`), post `@you something`
   into a room you are in. The badge increments without a reload: the bell rides the shared chat
   frame feed.
2. **Bell, alerts half** - any alert row landing in the warehouse shows up as a `Siren` item; the
   `table:alerts` change invalidation refreshes the bell.
3. **The glue, the other direction** - create an alert rule routed `chat:<an existing room>`, let
   a matching alert fire and be delivered, and the rendered message appears in that room as a post
   from the agent (`nova`), with no mentions in it. A burst arrives as one post with a bulleted
   line per alert, not one post each.
4. **Push**, if configured - flip the footer toggle to **On** (the browser prompts; permission
   must come from that click), then trigger a mention from another session while this tab is
   *not* focused on that room. A desktop notification appears with the sender's rounded avatar;
   clicking it focuses the tab and routes to `/chat/<slug>` with no page reload; "Mark read"
   clears the bell row without opening anything. A push for the room you are already looking at is
   swallowed by design.

`GET http://localhost:8190/api/push/sw.js` should return the worker source unauthenticated - if it
bounces off auth, push can never register.

No MCP tools: the bell is a human surface, and an agent already reads chat and alerts through their
own tools.

## 4. Remove

**There is no removal command.** This code is yours: delete the directories, then check that
nothing else in your Box still imports `notifications` and prune the npm packages
`features/notifications/deps.json` declares that no remaining feature needs.


```bash
rm -rf packages/core/src/features/notifications apps/server/src/features/notifications \
       apps/web/src/features/notifications
pnpm features && pnpm verify
```

Nothing depends on `notifications`, so nothing else has to go - and **that is the point of glue**.
`chat` keeps its rooms, its mentions, its sidebar unread counts and its agent; `alerts` keeps its
rules, its ledger, its `/alerts` feed and its Lark delivery. What you lose is exactly two things:
the top-bar bell (and with it push, on every device), and `chat:<slug>` as an alert route - such a
rule now matches no transport and falls through to alerts' own routing.

No warehouse table is dropped because the feature owns none. The rows in `chat.db`
(`notification_reads`, `notification_dismissals`, `push_subscriptions`, `device_tokens`) survive
untouched - they are chat's tables, written by chat's migration chain, and reinstalling the feature
picks up where it left off. Old push subscriptions simply stop being sent to.

## Gotchas

- **Boot order is `onModuleInit`, and `registerAlertTransport` throws on a duplicate `id`.** It is
  not idempotent, unlike the delivery seam's `registerNotificationTransport`, which replaces by
  name. If you add a second registration path, you will find this the hard way.
- **The two `PUSH_VAPID_*` env entries are read by nothing.** Configure `push.*.VAPID_*` in
  `credentials.json`. `pnpm verify` listing them as unset is not why push is off.
- **All three VAPID credentials or none.** A pair without `VAPID_SUBJECT` reads as unconfigured and
  push is silently off.
- **A malformed `FCM_SERVICE_ACCOUNT` warns and turns device push off**, it does not throw. Read
  the server log; a mis-escaped `private_key` looks exactly like never having configured it.
- **Never add a field to `NotificationDelivery` that could carry a URL or a filename.** The preview
  is 120 chars of `message.body` and nothing else, on purpose: a pushed payload renders on lock
  screens far outside the tailnet and outlives the notification. Attachments have no field here.
- **Do not `ATTACH` chat.db from the warehouse** to "just join" the bell's two strata. Both reads
  are capped at 30 rows and merged in memory precisely so the interactive bell never sits behind
  DuckDB's single-writer lock.
- **Marking the bell seen must never write `room_members.last_read_at`.** Two pointers, two
  questions; wiring them together makes the sidebar badge lie.
- **Alert read-state uses `alertSeenKey`, not `event_at`.** A future-dated `event_at` against a
  `Date.now()` watermark is permanently unseen and permanently un-clearable, and the bell's
  mark-on-open then loops against the reload - it did, unattended, on 2026-09-10. The `stuck` guard
  in `NotificationBell` is the second half of that fix; do not remove either.
- **`index.tsx` sits on the web feature-registry import cycle.** Never read a registry binding at
  module scope there, and load the app in a browser after touching it - `pnpm verify` has no
  runtime step (`CLAUDE.md`).
- **The service worker is a string in `push-sw.ts`, not an asset.** The server build does not copy
  assets and in dev every non-reserved route is proxied to Vite, so a reserved `/api` route is the
  only path served identically in both topologies. The `Service-Worker-Allowed: /` header is what
  permits scope `/`; drop it and registration fails.
- **A stale `packages/core/build/`** fails the server tests with a confusing resolution error after
  any rename here. `pnpm build` fixes it (`CLAUDE.md`).
