# Installing `chat`

The recipe. Read [`SPEC.md`](./SPEC.md) first for what the feature is; this is how it gets into a Box
and what to change afterwards. Chat is the largest feature in the Box and the only one with its own
database engine, so read the Gotchas before you arm anything.

## 1. Install

**The scaffold is the working code**, not a copy of it (see `features/README.md`). `box adopt`
fetches it from the registry at its tag, byte-exact, and rewrites the registries and skill links:

```bash
box registry validate                  # confirm the index offers chat, and at which version
box adopt chat                         # fetches the four directories and anything it dependsOn
pnpm install && pnpm build             # adoption changes package.json; tests resolve via build/
pnpm verify                            # features:check, lint:deps, typegen, typecheck, lint, tests
pnpm schema:check                      # diagnostic, not part of verify: run it after a schema change
```

In this checkout `chat` is already installed; the above is what a fresh Box runs.

**Do not rename the directory.** For every feature the name is the migration ledger namespace and the
same string in all three trees. For chat it is that **and** the namespace of a second chain: the
migration names in `packages/core/src/features/chat/migrations.ts` are the primary keys of `chat.db`'s
own `schema_migrations`. A rename there re-runs `001` on a live database.

`chat` has no `dependsOn`, so `pnpm features --check` will never ask you to install something first.
It is the other direction that matters: if you also want the bell, web/FCM push, or alerts delivered
into rooms, install `notifications` after this - it declares `dependsOn: ['chat', 'alerts']`.

The server dependency chat brings with it is `better-sqlite3` (already in `@silkweave/box-core`'s
dependencies) and, for the agent seat only, `@workerdeck/client` + `@workerdeck/protocol` in
`apps/server`.

## 2. Customise for the team

1. **Create the first rooms.** Nothing seeds them - no migration, no boot path. After the first boot,
   make them in the UI or over MCP: `pnpm cli chat-room-create` with a slug, and optionally a `name`,
   `topic` and `icon` from the 69-name `CHAT_ROOM_ICONS` list.
2. **Read the agent's identity** from core's `config/box.json`, chosen before first boot. The
   default is Nova (`nova`), admin; ID changes after initialization are unsupported. Core seeds
   its directory row. Read [the role tradeoff](../../docs/AUTH.md#agent-identity-and-role) before
   arming chat. The seat also needs an entry in
   `<BOX_DATA_DIR>/config/agent-profiles.json` mapping it to a real workerdeck profile under the
   `codex` engine, and an access token for its MCP client (`pnpm auth:token`).
3. **Tune the turn** - `CHAT_AGENT_MODEL`, `CHAT_AGENT_REASONING_EFFORT`, `AGENT_TURN_BUDGET`,
   `SESSION_IDLE_TTL_MS`, `TURN_SILENCE_LIMIT_MS` in
   `apps/server/src/features/chat/chat-agent.ts`. The model and effort are probed against the
   profile's own catalogue and silently omitted if it does not declare them, so a wrong value degrades
   to the profile default rather than failing.
4. **Decide the agent's floor** - `CHAT_AGENT_DISALLOWED_TOOLS` is empty on purpose. Add names once
   you have watched real turns: a tool that gets approved reflexively, or one whose blast radius
   nobody reading a one-line card can judge.
5. **Nav label and order** - `apps/web/src/features/chat/index.tsx`. Band 500.
6. **Vocabulary** - `CHAT_ROOM_ICONS` and `CHAT_ROOM_NAME_MAX` in `types.ts`, `CHAT_REACTION_EMOJI`
   and `CHAT_REACTION_QUICK_COUNT` in `reactions.ts`. Both icon and emoji lists also exist in
   `apps/mobile`; change one and check the other.
7. **Attachments** - `ATTACHMENT_MAX_BYTES` (25 MB) and `ATTACHMENT_ALLOWED_MIME` in
   `chat.controller.ts`. Keep it an allowlist; `text/html` and `image/svg+xml` are excluded because
   both execute script when a browser renders them from this origin.

There is no warehouse table to migrate and no seed to load. `chat.db` creates itself on first open.

## 3. Prove it

```bash
pnpm dev
```

Open `http://localhost:8190/chat`. With no rooms yet you get the empty shell; **+** creates one and
the route forwards to it. Then, in one room: type a message (it appears without a refresh - that is
the `chatFeed` subscription, not a poll), hover it and react, reply to it to open a thread, drag an
image onto the composer, and open the same room in a second tab to watch the unread badge clear.
Check `<BOX_DATA_DIR>/` afterwards: `chat.db`, `chat.db-wal` and `chat-uploads/` are really there.

Agent-side, the same operations are MCP tools:

```bash
pnpm cli chat-rooms                 # discovery: what this principal can see
pnpm cli chat-post                  # room + body
pnpm cli chat-history               # room, before, limit, roots
pnpm cli chat-room-create           # slug, name, topic, icon
pnpm cli chat-direct-open           # user
pnpm cli chat-room-delete           # room + confirm (the slug, repeated)
```

`chat-room-delete` over MCP is the one to try deliberately: it should come back
`status: 'pending'` with a card posted into the room, because the caller is a bearer-token client.
Approve it in the browser and watch the card settle in place.

**Arming the agent, safely.** Leave `CHAT_AGENT_ENABLED` unset on any dev machine unless you are
deliberately testing against a worker you own. When you do arm it:

```bash
CHAT_AGENT_ENABLED=1 pnpm dev   # plus a config/workerdeck.json declaring the agent's profile
```

Both are required - the flag alone does nothing without `agentWorkerUrl()`. Then mention `@nova` in a
room. You should see a placeholder message appear under nova's avatar, an activity line describing what
it is doing, text streaming into the placeholder, and - the moment it wants to run a command or write
a file - an approval card with two buttons that anyone in the room can press. `@nova stop` cancels a
turn and does not count against the budget. If the turn instead posts "I am not running this turn",
the loopback guard refused it: something other than this process owns `127.0.0.1:8190`.

## 4. Remove

**There is no removal command.** This code is yours: delete the directories, then check that
nothing else in your Box still imports `chat` and prune the npm packages
`features/chat/deps.json` declares that no remaining feature needs.


```bash
rm -rf packages/core/src/features/chat apps/server/src/features/chat apps/web/src/features/chat
rm -rf packages/core/src/features/notifications apps/server/src/features/notifications apps/web/src/features/notifications
pnpm features && pnpm verify
```

`notifications` must go too - it declares `dependsOn: ['chat', 'alerts']` and its whole state lives in
chat's SQLite tables, so `pnpm features --check` names it if you forget. Nothing else depends on chat.

One thing outside any feature still references chat's code and `pnpm verify` will tell you about it:
`apps/server/src/agent/workerdeck.host.ts` imports `chatStore` for
`roomReadableBy(roomId, userId)`, the rule that lets a room's readers watch that room's agent session
through the `/agent` mount. Removing chat means that line has to go or be replaced.

**`chat.db` is not deleted, and should not be.** It, its `-wal`/`-shm` siblings, any
`chat.db.pre-*.bak` snapshots and the whole `chat-uploads/` tree are the team's messages and files.
They sit under `<BOX_DATA_DIR>/`, which the feature never owned - it opened it. Delete them yourself,
deliberately, if that is what you mean.

## Gotchas

- **`CHAT_AGENT_ENABLED` must be exactly `'1'`** (trimmed). `true`, `yes`, `on` all leave the seat
  off, silently and by design - same grammar as `AUTOMATION_ENABLED`. And the flag is only half of it:
  `agentWorkerUrl()` must also resolve, which means core's workerdeck host booted, which means
  `config/workerdeck.json` declares a profile for the agent's own account.
- **The agent host is core's, the seat is chat's.** `chat-agent.ts` talks to
  `apps/server/src/agent/workerdeck.host.ts`; it does not own a worker. The per-user agent SIDEBAR is a
  different thing entirely - browser-initiated, per-task, through the `/agent` proxy. The two share
  nothing but the worker process.
- **The loopback guard runs per turn, not once at boot.** Read the incident note at the top of
  `apps/server/src/agent/loopback-guard.ts` before touching `DEFAULT_PORT` (8190) or `PORT`. The
  failure it prevents is invisible: a VS Code Remote-SSH forward can own `127.0.0.1:<port>` while Node
  holds the IPv6 wildcard, and every MCP write from a "local" turn then lands on the other machine
  with nova's real credentials. A second Box must therefore never be one default away from the
  first: give it its own `PORT` and `BOX_VITE_PORT`.
- **Never `cp` chat.db.** Recent commits live in `chat.db-wal`; a copied file opens perfectly clean
  and has silently lost the last hour. Use `VACUUM INTO` - which is what `chatBackup`,
  `backupChat()` and the pre-migration snapshot all do.
- **Never edit, rename or reorder a shipped migration.** The name is the ledger key in a database
  that is already deployed. Append `016` instead.
- **Do not start an agent turn from inside a write.** `ChatStore.post` commits message + mentions +
  outbox in one transaction and publishes on the bus strictly after; that is why `chat-agent.ts` and
  `notifications/delivery.ts` are both bus subscribers. Holding a worker's REST latency inside a
  SQLite write transaction is the one thing a single-writer file database must never do.
- **`chatStore()` is a process-wide long-lived handle.** Close it on shutdown (`closeChatStore()` in
  `onModuleDestroy`, timers stopped first) or WAL never checkpoints cleanly. Tests construct
  `ChatStore` directly instead.
- **Import `ComposerLazy`, never `Composer`.** The composer pulls in the rich editor; the room list
  does not need it.
- **`index.tsx` sits on the web feature-registry import cycle.** Never read a registry binding at
  module scope there, and load the app in a browser after touching it (`CLAUDE.md`). Chat's
  `onSession` hook makes this sharper than most: it runs on every route for every session.
- **After a controller change, boot once** so typegen rewrites `appRouter.d.ts`, or the web typecheck
  is stale. A stale `packages/core/build/` will also fail the server tests with a confusing resolution
  error - `pnpm build` fixes it.
