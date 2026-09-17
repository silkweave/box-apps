# `chat` - team chat, and the agent's seat in it

Rooms, threads, mentions, reactions, attachments, read pointers and a live multiplexed feed - plus
`nova`, the service account that answers when you mention it in a channel. The biggest feature in the
Box (~58 files, ~20k lines) and the only one that runs its own database engine: **chat owns no
warehouse table**, it owns `chat.db`, a SQLite file with its own migration chain. Everything else it
touches - who the users are, who the agent's worker profile is - it reads from core.

- **dependsOn**: nothing. Chat is a root of the dependency graph; it imports core (`io.ts`,
  `auth/principal.ts`, `users/state.ts`, `ops/*`, `warehouse/backup.ts`) and no other feature.
- **Depended on by**: `notifications` (`dependsOn: ['chat', 'alerts']`) - the bell, web + FCM push,
  and alert delivery into chat rooms. It is glue, and it lives entirely on chat's store and chat's
  bus: `onChatEvent` for delivery, and five of chat's own SQLite tables (`mentions`,
  `notification_reads`, `notification_dismissals`, `push_subscriptions`, `device_tokens`) for its
  state. Remove `chat` and `notifications` must go with it; `pnpm features --check` says so.
- **Removal**: `rm -rf` the three directories **and** notifications' three. One thing outside a
  feature still names chat's code after that: core's agent host,
  `apps/server/src/agent/workerdeck.host.ts`, imports `chatStore` for `roomReadableBy` (the rule that
  lets a room's readers watch that room's agent session). A Box without chat needs that line
  addressed. `chat.db` and `chat-uploads/` under the instance dir are untouched - they are the
  team's messages, not the feature's.

## Tables

None in the warehouse. `models: []`, `migrations: []` in `manifest.ts`, by design.

## Its own store

`<BOX_DATA_DIR>/chat.db` - SQLite via `better-sqlite3`, opened lazily by `chatStore()` in
`packages/core/src/features/chat/store.ts` (one process-wide, long-lived connection; `closeChatStore()`
on shutdown). The path is the feature's own `chatPath()` (`packages/core/src/features/chat/paths.ts`) = `dataPath('chat.db')`.

Why not the warehouse: chat is many tiny writes at interactive latency plus point reads, which is
exactly what DuckDB's single-writer, ephemeral-connection design is wrong for. `docs/core/SEAM.md` § 3.6
makes chat the precedent - "a feature with its own engine follows the chat precedent: own file under
`instanceDir()`, own ledger, own chain, and its `manifest.models` lists only what it puts in the
warehouse (for chat: nothing)."

`openChatDatabase` pins the pragmas in one place: `journal_mode = WAL`, `synchronous = NORMAL`,
`busy_timeout = 5000`, and `foreign_keys` OFF across the migration then ON, with a
`foreign_key_check` that refuses to hand back a database with violations. Before an **existing**
database runs a pending migration it takes `chat.db.pre-<first-pending>.bak` with `VACUUM INTO`
(never `cp` - under WAL a copied file opens clean and has silently lost the log), keeping the two
newest.

### The chain (`migrations.ts`, 15 entries, append-only, keyed by name in `chat.db`'s own `schema_migrations`)

| # | name | what it does |
|---|---|---|
| 001 | `001-chat-schema` | `rooms`, `room_members`, `messages`, `events` (the outbox) |
| 002 | `002-mentions` | `mentions`, `notification_reads` |
| 003 | `003-notification-dismissals` | `notification_dismissals` |
| 004 | `004-push-subscriptions` | `push_subscriptions` |
| 005 | `005-device-tokens` | `device_tokens` |
| 006 | `006-attachments` | `attachments` (rows only - bytes live on disk) |
| 007 | `007-agent-sessions` | `agent_sessions` |
| 008 | `008-message-meta` | `messages.meta` - the approval card's structure |
| 009 | `009-threads` | `messages.parent_id` - a reply is a message |
| 010 | `010-time-order-key` | rebuilds `messages` and `events` onto a time order key |
| 011 | `011-reactions` | `message_reactions` |
| 012 | `012-direct-messages` | `rooms.kind` (`room` \| `dm`) |
| 013 | `013-room-icon` | `rooms.icon` |
| 014 | `014-room-name` | `rooms.name` (free-form display name; slug stays the address) |
| 015 | `015-open-channels` | rebuilds `rooms`; kind is the whole access rule |

Twelve tables plus the ledger. Two rules the file states and both lose data if broken: never edit,
rename or reorder a shipped migration (the name is the ledger key), and every rebuild asserts its
row count inside its own transaction. There is deliberately no baseline - `001` builds the whole
schema, so a fresh database runs the entire chain on every dev boot and every test.

Attachment **bytes** are not in the database: `blobs.ts` content-addresses them under
`<instance>/chat-uploads/<sha[0:2]>/<sha>`, git-objects shaped, synchronous on purpose so a row
write and its blob write happen in one event-loop tick.

## Ports it owns, and what it registers into core

- **`onChatEvent` / `emitChatEvent`** (`bus.ts`) - the in-process chat bus. `ChatStore` publishes
  each COMMITTED outbox row (plus outbox-less per-user ephemerals) here, and only after the
  transaction commits. Deliberately **not** core's `changes.ts` bus, which is payload-free by design;
  chat frames carry message bodies, so safety comes from the server filtering each subscriber by room
  membership before yielding. Registered into by `notifications/delivery.ts` and by this feature's own
  `chat-agent.ts`.
- **`chatStore()`** - the store handle itself is the second port. `notifications` reads and writes its
  five tables through it; core's agent host uses `canReadRoom`.
- **Into core's run funnel**: one `ActionSpec` (below).
- **Not** registered: chat subscribes to no core `onEvent`, registers no `onRunOutcome`, and
  contributes no web `slots`.

## The agent seat

Core's `config/box.json` selects the identity before first boot; `systemUserId()` reads it lazily.
The default is Nova (`nova`), admin. Chat uses this same identity for mentions, DM guest access,
loop guards, prompts, approvals and worker-session ownership. The browser gets it from auth, so
its mention picker and system badge do not hardcode a name. Examples below use the default ID.
See [identity and role](../../docs/AUTH.md#agent-identity-and-role), including the admin tradeoff.

**What arms it.** `startChatAgent()` runs from `ChatModule.onModuleInit` unconditionally, and

```
armed = CHAT_AGENT_ENABLED?.trim() === '1'  AND  agentWorkerUrl() !== undefined
```

Both halves, or no turn ever runs. `CHAT_AGENT_ENABLED` must be **exactly `'1'`** (same grammar as
`AUTOMATION_ENABLED`, same reason). `agentWorkerUrl()` comes from core's workerdeck host
(`apps/server/src/agent/workerdeck.host.ts`), which boots only when `config/workerdeck.json` declares a
deployment. It is its own flag rather than riding `AUTOMATION_ENABLED` so that "test the chat agent on
dev" does not also arm every production schedule.

**What is armed regardless of the flag**, deliberately:

- `expireOrphanedCards()` at startup - a card the last process left `pending` is a promise this one
  cannot keep, and the flag having just been turned off is exactly when stale cards exist.
- `decideApproval` (behind the card buttons) - since chat-op approvals it answers cards no agent
  raised. It runs no turn, creates no session and does no MCP write.
- `startChatOpApprovals()` from the same `onModuleInit`, for the same reason.

**How nova answers.** Three doors, resolved in core by `resolveAgentTrigger` and deduped by
`AgentMessageClaims` (one message, one turn): an explicit `@nova` mention; a reply inside a thread the
agent already owns; any message in a DM with nova. In a named room the answer goes in a thread rooted
on the question (a long turn must not interleave through a room people are using); in a DM it goes at
top level. `parseAgentDirective` recognises exactly one non-turn directive - `stop` or `cancel`, with
an optional trailing `.`/`!` - and it never counts against the budget. Budget: `AGENT_TURN_BUDGET = 12`
turns per room per `AGENT_BUDGET_WINDOW_MS` (1h). A turn is seeded with `AGENT_SEED_HISTORY = 10`
recent messages plus whatever is new since the session last looked; `chat-history` over MCP is how it
reaches further back.

**The host.** `chat-agent.ts` creates a workerdeck `SessionHandle` per room against
`agentWorkerUrl()` with `hostAuth`, under the `codex` profile declared for `nova` in
`config/agent-profiles.json` (`agentProfileFor('nova', 'codex')`; no profile = the turn throws).
Model `gpt-5.6-luna`, reasoning effort `medium`, both probed against the profile's catalogue first
and **omitted if the profile does not declare them** rather than failing. Sessions close after
`SESSION_IDLE_TTL_MS` (1h idle); a turn that emits nothing for `TURN_SILENCE_LIMIT_MS` (10min) is
interrupted, with the watchdog standing down while the turn is legitimately blocked on an approval.
Text is assembled by `AgentTurnText` from `stream_delta`s and `assistant_message` blocks and
checkpointed into the room's placeholder message roughly twice a second.

**Before every turn**: `verifyLoopback()`. nova's tools dial the literal `127.0.0.1:<port>/mcp` out of
its own config, so a turn is only safe when that address is this process. If it is not, the turn is
refused loudly in the channel rather than degraded. Read the incident note at the top of
`apps/server/src/agent/loopback-guard.ts` - this guard exists because a VS Code port forward once made
a dev machine's agent write to production.

**Approvals** (two kinds, one card format, one decision endpoint):

- *Worker approvals* - `permissionMode: 'default'`, so reads are free and every Bash/Edit/Write raises
  a permission request. A request that settles inside `APPROVAL_HOLD_MS` (3s) never reaches the room;
  past that it becomes a real message anyone who can read the room may approve or deny, capped at
  `APPROVAL_CARDS_PER_TURN` (8) per turn, with the worker's own timeout at `APPROVAL_TIMEOUT_MS`
  (30min). `CHAT_AGENT_DISALLOWED_TOOLS` is the hard floor and is **empty on purpose** - the seam
  exists so adding a name later is one line. `AskUserQuestion` is still `deny`: a binary card cannot
  carry an answer form.
- *Chat-op approvals* (`chat-op-approvals.ts`, core rule + server registry) - a DESTRUCTIVE chat
  operation asked for by an API client. `chatOpNeedsApproval` keys on **how the principal
  authenticated**, not on transport: anything that is not demonstrably a `session` credential, plus
  the service account whatever it presented, is held. Today exactly one op kind: `room-delete`. The
  tool call returns `status: 'pending'` immediately, the card waits in memory (a restart expires it),
  and approving EXECUTES the delete with the approver as actor of record.

**Safety posture, as the code states it**: MCP authenticates as `nova`, an admin, and reach is full by
decision - anyone who can mention `@nova` effectively wields nova's whole MCP surface. What bounds it is
the permission mode, the in-channel approvals, `canReadRoom` on every read, and the disallowed-tools
floor. Chat bodies are untrusted input to an admin-credentialed loop: bounded, not solved.

## Procedures and tools

`ChatController` (`@Controller('chat')`, class-level `@UseGuards(AuthGuard)`). Every write is stamped
with the request principal - never a client-supplied id. Reads that take input are POST +
`@Trpc({ kind: 'mutation' })`, the house pattern; only the input-less query is a `@Get`.

**16 tRPC procedures, 12 MCP tools, 2 plain REST routes.**

| tRPC | MCP | what |
|---|---|---|
| `chatRooms` (query) | `chat-rooms` | the sidebar: the principal's rooms with unread counts plus joinable public rooms. Over MCP this is the discovery call |
| `chatHistory` (mutation) | `chat-history` | one room's messages, paging backwards by `createdAt`, returned oldest-first. The agent's memory |
| `chatThread` (mutation) | `chat-thread` | one thread expanded - the companion to `history({ roots: true })` |
| `chatPost` (mutation) | `chat-post` | send a message. Carries the double-post guard: nova may not `chat-post` into a room where its own turn is already streaming |
| `chatEdit` (mutation) | `chat-edit` | replace your own message's body; sender-only, issues no key and no outbox row |
| `chatReact` (mutation) | `chat-react` | toggle one of the twelve palette emoji (`CHAT_REACTION_EMOJI`) |
| `chatDelete` (mutation, `@Trpc({ name: 'Chat.delete' })`) | `chat-message-delete` | delete a message; `moderate: true` for any sender |
| `chatRoomCreate` (mutation) | `chat-room-create` | create a room - everyone can read and write it at once |
| `chatDirectOpen` (mutation) | `chat-direct-open` | open a DM with one person. Idempotent: the slug is `dm:<a>:<b>` from the sorted pair |
| `chatRoomUpdate` (mutation) | `chat-room-update` | rename / topic / icon. Empty string clears; a DM answers 400 |
| `chatRoomDelete` (mutation) | `chat-room-delete` | PURGE a room. Three guards: `confirm` must repeat the slug, an API client gets an approval card and `status: 'pending'`, and the store requires readability |
| `chatBackup` (mutation) | `ChatBackup` (bare `@Mcp()`, name derived) | `VACUUM INTO` chat.db to GCS through the recorded run funnel |
| `chatMarkRead` (mutation) | - | advance the member's read pointer (clamped, monotonic) and get the server's unread recount |
| `chatAgentStatus` (mutation) | - | what the turn in this room is doing right now; covers a late joiner and a reconnected feed, since `agent.activity` is ephemeral |
| `chatAgentDecision` (mutation) | - | approve or deny an approval card. **Any** user who can read the room may answer, worker cards and chat-op cards alike |
| `chatFeed` (subscription) | - | ONE multiplexed live stream per client over every room the principal belongs to. A `cursor` replays the outbox, then it goes live; every frame is membership-filtered server-side |

Plain REST, because multipart does not project onto tRPC or MCP:

| route | what |
|---|---|
| `POST /api/chat/attachments` | multipart upload, field `file`. 25 MB cap, mime allowlist (images, pdf, text, csv, markdown, json, archives; `text/html` and `image/svg+xml` deliberately excluded). The result is an ORPHAN until a `chatPost` claims it; orphans are swept after 24h |
| `GET /api/chat/attachments/:id` | stream the bytes. The URL is **not** a capability - every request re-runs `attachmentForRead`, which is uploader-only during the orphan window and exactly `canReadRoom` afterwards |

## Actions

One, in `actions.ts`:

| id | group | what |
|---|---|---|
| `chat-backup` | Warehouse | Snapshot `chat.db` (`VACUUM INTO`, through the live store) to the private GCS bucket as `chat/chat-<date>.sqlite` + `chat/chat-latest.sqlite` |

It is in core's action registry, so `automation` can schedule it and every invocation lands in
`automation_runs` - the `chatBackup` procedure calls `executeRecorded('chat-backup', …)` rather than
`backupChat()` directly.

## UI

- **Routes**: `/chat` (`ChatLayout` - the room list as sidebar, one room through the `Outlet`) with
  two children, the index and `$room`. `$room` is the room **slug**, not its id, because that is what
  every server procedure keys on and what people say out loud. Landing on `/chat` with no room
  forwards (`replace`) to the first channel, preferring a named room over a DM.
- **Nav**: one entry, `Chat`, icon `MessagesSquare`, order band **500**.
- **Settings / shell / slots**: none. The bell in the topbar is `notifications`, not chat.
- **`onSession`**: `startChatFeed()`. The feed arms on every route as soon as a session exists, not
  lazily with the first chat surface, because anything app-wide that counts on it (the bell) has to
  see it live from the start. `useChatData.ts` owns the single module-scope `chatFeed` subscription
  per tab, its cursor and its reconnect loop - chat does not ride the changes bus.
- The composer is behind a lazy chunk (`ComposerLazy.tsx`), like sink's editor.

## Env

From `apps/server/src/features/chat/index.ts`:

| name | doc |
|---|---|
| `CHAT_AGENT_ENABLED` | `1` arms the chat agent (nova answers in rooms); anything else leaves it off |

That is the feature's only declared env. The agent seat additionally depends on core's
`config/workerdeck.json` (which is what makes `agentWorkerUrl()` non-undefined) and on `PORT`, through the
loopback guard.

## Admin-only

Since 2026-09-13 the Box has two tiers (`docs/core/AUTH.md` § 3), and the rule every feature applies is
one sentence: **an operation is admin-only when its blast radius is another person's identity or
credential, the service itself, or configuration wired to credentials.**

This feature's admin set is the `moderate` flag on `chat-message-delete` (checked with `assertAdmin`, not a decorator - the
same route is every member's ordinary self-delete, and only the flag tells them apart).

Everything else in chat is a member's, rooms included: a room is a conversation, not configuration.

## What a team customises

1. **Room seeds** - there are none. No migration and no boot path creates a room; the first channel is
   created by a person (or by `chat-room-create`) after the Box boots. A team that wants `#general`
   day one creates it.
2. **The agent's identity** - select it in core's `config/box.json` before first boot.
   Core seeds the matching user; changing the ID later is unsupported. The agent also needs an entry in `config/agent-profiles.json` mapping it to a real workerdeck profile, and a
   token for its MCP client. `AGENT_ENGINE = 'codex'`, `CHAT_AGENT_MODEL` and
   `CHAT_AGENT_REASONING_EFFORT` in `apps/server/src/features/chat/chat-agent.ts` are the other three
   knobs, and the last two degrade rather than fail if the profile does not declare them.
3. **Labels and order** - the nav entry's `label` and `order` in
   `apps/web/src/features/chat/index.tsx`. Band 500 puts chat mid-sidebar.
4. **Vocabulary** - `CHAT_ROOM_ICONS` (69 curated lucide names) and `CHAT_REACTION_EMOJI` (12, in UI
   order, first six on the hover bar) in `types.ts` / `reactions.ts`. Both lists exist in the Flutter
   client too; add to one and check the other.
5. **The agent's bounds** - `CHAT_AGENT_DISALLOWED_TOOLS` (empty by design),
   `CHAT_AGENT_PERMISSION_MODE`, `AGENT_TURN_BUDGET`, `SESSION_IDLE_TTL_MS`,
   `TURN_SILENCE_LIMIT_MS`, `APPROVAL_*`. Shape these from watched usage, not from a guess.
6. **Attachment policy** - `ATTACHMENT_MAX_BYTES` and `ATTACHMENT_ALLOWED_MIME` in
   `chat.controller.ts`. Allowlist, never deny-list.
