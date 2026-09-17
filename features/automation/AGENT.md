# Installing `automation`

The recipe. Read [`SPEC.md`](./SPEC.md) first for what the feature is; this is how it gets into a
Box, what to change afterwards, and how to arm it without setting a laptop firing production crons.

## 1. Install

**The scaffold is the working code**, not a copy of it (see `features/README.md`). `box adopt`
fetches it from the registry at its tag, byte-exact, and rewrites the registries and skill links:

```bash
box registry validate                  # confirm the index offers automation, and at which version
box adopt automation                   # fetches the four directories and anything it dependsOn
pnpm install && pnpm build             # adoption changes package.json; tests resolve via build/
pnpm verify                            # features:check, lint:deps, typegen, typecheck, lint, tests
pnpm schema:check                      # diagnostic, not part of verify: run it after a schema change
```

In this checkout `automation` is already installed; the above is what a fresh Box runs.

**Do not rename the directory.** The name is the migration ledger namespace and is the same string
in all three trees. `automation` has `migrations: []` today, but the rule has no exceptions - and
the id is also what `pnpm features` writes into the registries and what `dependsOn` would name.

Nothing else is edited. `automation` has no `dependsOn`, so `pnpm features --check` can never ask
you to install something first.

## 2. Customise for the team

1. **The schedules file** - `<BOX_DATA_DIR>/config/schedules.json`. A fresh Box has none; a missing
   file is an empty list, and the first upsert creates it. Shape:

   ```json
   {
     "schedules": [
       { "id": "daily-pulls", "action_id": "warehouse-backup", "cron": "0 7 * * *", "enabled": true, "description": "Nightly snapshot" }
     ]
   }
   ```

   `id` is a slug (`^[a-z0-9][a-z0-9-]*$`) and is stable - it is what a run row is attributed to.
   Write it by hand or through Settings → Schedules; both end in the same file.

2. **Cron expressions** - full 5-field, parsed by `cron-parser`, evaluated in the **server's local
   timezone**. There is no per-schedule timezone. The UI renders each one back in English via
   `cronstrue` ("At 07:00 AM"), which is the fastest way to catch a field-order mistake.

3. **Which actions to arm** - the catalog is every `ActionSpec` the installed features contribute,
   plus core's `warehouse-backup`. Two entries cannot be scheduled and will be refused at upsert
   time: an `action_id` that no present feature declares, and an action marked `parameterized`
   (it needs per-run params a cron cannot supply). The catalog itself is `opsActions`, tRPC-only -
   there is no MCP tool that lists actions, so read it from Automation → Actions in the UI.

4. **Labels and order** - `apps/web/src/features/automation/index.tsx`, band 800 for both the nav
   entry and the Settings section.

There is no vocabulary, no table and no migration, so there is nothing to seed.

## 3. Prove it

```bash
pnpm dev
```

Open `http://localhost:8190/automation`. You should see the Automation view with two sections:
**Schedule Runs** (every execution of every action - cron, dashboard, agent - newest first; empty on
a fresh Box) and **Actions** (the registry as a console). Click a run to get its stored log.

Then `http://localhost:8190/settings/schedules`: the schedule cards. On a dev checkout the header
reads "timers NOT armed - set AUTOMATION_ENABLED=1 in .env to run them", which is the correct state.
Create one with **New schedule**, and confirm `<BOX_DATA_DIR>/config/schedules.json` really changed -
the file and the view agreeing is the feature's whole contract.

Press **Run now** on a card. That does not touch the scheduler: it calls core's `opsRunNow`
subscription with the schedule's `action_id` (and `scheduleId` for attribution), streams the
progress inline, and lands a `trigger: 'manual'` row in the run history. If the run appears under
Schedule Runs, the funnel works even though nothing is armed.

Editing the config also flips the topbar: after any upsert or delete, **Restart required** appears,
because the running scheduler keeps its boot-time snapshot. That indicator is the proof that the
config and the armed timers are two different things.

Agent-side, the same operations are MCP tools:

```bash
pnpm cli schedules-list                 # what is configured, valid, next fire
pnpm cli schedule-upsert                # create/update one entry
pnpm cli schedule-delete                # remove one
pnpm cli run-now                        # core's, not this feature's - run any action immediately
pnpm cli run-get                        # core's - one run with its full log
pnpm cli service-restart                # apply a config change (refuses mid-turn without force)
```

**Arming it deliberately.** Set `AUTOMATION_ENABLED=1` (exactly `1`; `true` and `yes` do nothing)
in the environment and restart. The boot log then says `armed N/M schedule(s) from
config/schedules.json`, and every entry that is `enabled` and valid gets a timer.

Do **not** do this on a dev checkout seeded from production. Such a checkout shares the tenant's
credentials and, often, its warehouse snapshot; armed timers mean a laptop firing the real pulls,
backups and publishes beside the production Box, writing real rows and posting real posts. The
off-by-default is the guard. If you must watch the scheduler itself arm, do it with a throwaway
instance dir and a schedule pointing at something harmless:

```bash
BOX_DATA_DIR=$(mktemp -d) AUTH_SESSION_SECRET=<16+ chars> AUTOMATION_ENABLED=1 CHAT_AGENT_ENABLED=0 \
PORT=8123 node --conditions=@silkweave/box-source --import @swc-node/register/esm-register apps/server/src/main.ts
```

(create `$BOX_DATA_DIR/config` first). Pick a `PORT` no other Box could be holding: a throwaway
that lands beside a real Box on another address family is mistaken for it rather than rejected
(`apps/server/src/agent/loopback-guard.ts`).

## 4. Remove

**There is no removal command.** This code is yours: delete the directories, then check that
nothing else in your Box still imports `automation` and prune the npm packages
`features/automation/deps.json` declares that no remaining feature needs.


```bash
rm -rf packages/core/src/features/automation apps/server/src/features/automation apps/web/src/features/automation
pnpm features && pnpm verify
```

No feature depends on `automation`. Nothing to purge: the run history lives in core's
`automation_runs` and stays, Run Now and the action registry stay (core's `OpsController`), and
`config/schedules.json` is left on disk, simply unread. What the Box loses is time: every schedule
stops and nothing fires on its own again. Every action remains runnable by hand from core's ops
surface and by agents over `run-now`.

## 5. Gotchas

- **Config edits never hot-reload.** `SchedulerService` reads `config/schedules.json` once in
  `onApplicationBootstrap` and keeps the snapshot. An edit only flips `restartRequired` (a canonical
  comparison that ignores key order and entry order, so a reformat is not a change). Restart to
  apply - and a restart on a dev checkout run under `pnpm dev` does not come back: the
  implementation is `process.exit(86)` and it expects a supervisor with
  `KeepAlive.SuccessfulExit=false` to respawn it.
- **`service-restart` restarts nothing by itself, and this template ships no supervisor.** The
  implementation is `process.exit(86)`; something outside the process has to respawn it (a launchd
  KeepAlive agent, a systemd `Restart=on-failure`, a container policy). The docstring named a
  launchd plist that does not exist here; corrected 2026-09-13. `RestartServerButton` still talks
  about `logs/server.log`, which is whatever the supervisor redirects to.
- **`restart` refuses while an agent session is mid-turn**, returning `ok:false` with the session
  ids. That refusal must be surfaced, not polled through - the UI would otherwise find the
  un-restarted server answering instantly and reload as if it had worked. `force: true` overrides
  it, and those turns are lost.
- **A busy action is skipped, not queued.** On fire, the scheduler checks `isActionBusy()` and, if
  the action is already queued or running, writes a `skipped` run row instead of stacking a second
  execution. Core's funnel is FIFO with concurrency 1 (the warehouse is single-writer).
- **Scheduled runs are attributed to the `nova` system principal** (`systemUserId()`), not to null -
  otherwise the "who ran this" column in the run list is blank.
- **Invalid entries are surfaced, not fatal.** At boot, `scheduleProblem()` checks each entry softly:
  a bad cron or an unknown action logs a warning and leaves that one unarmed. The upsert mutation is
  the loud half - it throws with the reason.
- **`AUTOMATION_ENABLED` must be exactly `1`.** `env()` trims, then compares `!== '1'`.
- **Schedule writes and `service-restart` are admin-only, and now really are** - `@Admin()`, read
  by `AuthGuard`, on 2026-09-13. Between 2026-09-10 and then the docstrings claimed it and nothing
  enforced it, so any signed-in principal could restart the service. The agent can reach these when
  its configured role is admin (the fresh-Box default). Choose member in host config to restore
  that boundary; see [the role contract](../../docs/AUTH.md#agent-identity-and-role).
- **`index.tsx` sits on the web feature-registry import cycle.** Never read a registry binding at
  module scope there, and load the app in a browser after touching it (`CLAUDE.md`) - `pnpm verify`
  has no runtime step.
- **Far-future fires.** `setTimeout` clamps at 2^31-1 ms, so `arm()` caps the delay and re-arms.
  A rare cron does not silently fire immediately.
- **`docs/AUTOMATION.md` is gone (2026-09-13).** It described `packages/core/src/automation/` and
  `apps/server/src/automation/`, paths the feature split replaced, and the durable half of it now
  lives in this feature's `SPEC.md`. The two comments in this feature that cited it point there.
