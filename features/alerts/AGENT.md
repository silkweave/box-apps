# Installing `alerts`

The recipe. Read [`SPEC.md`](./SPEC.md) first for what the feature is; this is how it gets into a
Box and what to change afterwards.

## 1. Install

`alerts` has **four** dependencies - the most in the Box. Install `data`, `planning`, `content` and
`engagement` first, in that order (`content` needs `data` + `planning`, `engagement` needs `data` +
`content`). `pnpm features --check` refuses the registry otherwise, and it names the missing one.

**The scaffold is the working code**, not a copy of it (see `features/README.md`). `box adopt`
fetches it from the registry at its tag, byte-exact, and rewrites the registries and skill links:

```bash
box registry validate                  # confirm the index offers alerts, and at which version
box adopt alerts                       # fetches the four directories and anything it dependsOn
pnpm install && pnpm build             # adoption changes package.json; tests resolve via build/
pnpm verify                            # features:check, lint:deps, typegen, typecheck, lint, tests
pnpm schema:check                      # diagnostic, not part of verify: run it after a schema change
```

In this checkout `alerts` is already installed; the above is what a fresh Box runs.

**Do not rename the directory.** `alerts` is the migration-ledger namespace (`<feature>:<name>` in
`schema_migrations`) and the same string in all three trees. The list is empty today, so a rename
looks harmless and stops being harmless the first time somebody appends `001`.

Nothing else is edited. `pnpm features` regenerates the registries; the first boot creates the
`alerts` table from `ALERTS_MODELS`.

## 2. Customise for the team

1. **The rules are the main thing.** Everything else is plumbing. Create
   `<BOX_DATA_DIR>/config/alerts.json`:

   ```json
   {
     "_readme": "route: owner | channel | user:<id> | chat:<room-slug>",
     "rules": [
       { "id": "reddit-replies", "event": "reddit.inbox", "route": "owner",
         "message": "u/{author} replied in r/{subreddit}: {summary}", "enabled": true },
       { "id": "run-failures", "event": "run.error", "route": "channel", "cooldown_min": 30,
         "message": "{action_id} failed: {error}", "enabled": true },
       { "id": "stars", "event": "github.star", "route": "channel", "notify": "digest",
         "message": "new star", "enabled": true },
       { "id": "daily-digest", "event": "digest.daily", "route": "channel",
         "message": "{summary}", "enabled": true }
     ]
   }
   ```

   `{token}`s are filled from the event's flat `fields`; unknown tokens are left intact, which is
   how you discover the real field names. `notify: "digest"` records the event and **no** alert row
   - the daily digest and traction detection read it from `events` instead. Rule ids are
   kebab-case; the route grammar is enforced. Editing through Settings -> Rules writes the same
   file, and the file is re-read per evaluation, so no restart either way.

2. **Routing.** `<BOX_DATA_DIR>/config/lark-routing.json`: `{ "routes": { "channel": {...},
   "user:alice": {...} }, "fallback": "channel" }`, each target a `{ receive_id, type }`. A route
   with no mapping and no transport records a delivery `error`. If the team lives in the Box's own
   chat instead of Lark, install `notifications` and route rules at `chat:<room-slug>` - that
   transport bypasses Lark entirely and needs no routing file.

3. **Which evaluators run.** Schedule the `alerts-*` actions through `automation` (fast tier for
   `alerts-reddit` / `alerts-github`, ~15 min for `alerts-traction`, daily for `alerts-digest`).
   `alerts-github` needs a `github` account with a `GH_TOKEN` credential; `alerts-linkedin` needs
   published LinkedIn pieces and, for member posts, the author's Chrome in `config/browsers.json`.
   An evaluator with no matching rule short-circuits, so an unused one costs nothing.

4. **The vocabularies.** `cards.ts` `titleFor()` and the header colours, `traction.ts`
   `ENGAGEMENT_KINDS` / `DEFAULT_TIERS` / the 60-minute window, `digest.ts` `KIND_LINE`,
   `flush.ts` `DEFAULT_DEBOUNCE_SEC`. These nouns are inherited from the predecessor; change them to the team's.

5. **Labels and order.** Nav `Alerts` at band 810 and the settings section `Rules` at 810, both in
   `apps/web/src/features/alerts/index.tsx`.

## 3. Prove it

```bash
pnpm dev
```

Open `http://localhost:8190/alerts`: the feed renders (empty is fine) with a status badge per
row. Settings -> Rules lists the rules grouped by event kind; adding one there rewrites
`config/alerts.json` on disk - check the file, that is the whole contract.

Agent-side the same surface is MCP: `pnpm cli alerts-rules`, `pnpm cli alerts-list`,
`pnpm cli alert-rule-save`, `pnpm cli alert-rule-delete`.

To fire a test alert without waiting for anything real, use the cheapest source - a failed run.
With a rule on `run.error` enabled, run an action that will fail (an `alerts-github` with no
credential configured will do) from the Automation view or `pnpm cli run-now`. The funnel records
the failure, `onRunOutcome` ingests a `run.error` event, the policy records a `pending` row, and
the feed shows it within its 10s poll; it flips to `delivered`, `suppressed` or `error` when the
debounced flush (default 300s) lands. `error` with `no Lark route mapping for "..."` means the
whole path worked and only `lark-routing.json` is missing.

## 4. Remove

`notifications` imports `alerts` directly, so it goes too:

**There is no removal command.** This code is yours: delete the directories, then check that
nothing else in your Box still imports `alerts` and prune the npm packages
`features/alerts/deps.json` declares that no remaining feature needs.


```bash
rm -rf packages/core/src/features/alerts apps/server/src/features/alerts apps/web/src/features/alerts
rm -rf packages/core/src/features/notifications apps/server/src/features/notifications apps/web/src/features/notifications
pnpm features && pnpm verify
```

(`pnpm features --check` names it if you forget.) The `alerts` table stops being created on a
fresh Box; an existing warehouse keeps the rows until somebody drops it. `config/alerts.json` and
`config/lark-routing.json` are left alone - they are the team's files. Core's `events` table and
everything that writes to it are untouched: the spine is core, and losing alerts only means nothing
reacts to a fresh event.

## Gotchas

- **The rules file is not in the repo.** It lives under `<BOX_DATA_DIR>/config/`, so a fresh Box
  has no rules and the feature is silently dormant. That is correct behaviour, not a bug - but it
  is also the first thing to check when "alerts do nothing".
- **`ingestEvent` never throws, and neither does the policy.** Both swallow their errors by design
  so alerting cannot break its own trigger. A dropped alert leaves no exception anywhere: look at
  the `events` table and the feed's `error` column instead.
- **Delivery only picks up `pending`.** A row that failed stays `error` and is never retried
  automatically. Re-running an evaluator does not resend it either, because the
  `(rule_id, dedup_key)` insert is a no-op.
- **Debounce is also max-hold.** The first arrival fixes the flush time; later arrivals never
  extend it. Poll actions call `flushAlertsNow()` themselves, so their batch does not wait.
- **The flush timer is `unref`'d.** A script or test that records alerts and exits sends nothing
  unless it calls `flushAlertsNow()` before exiting.
- **A `chat:` route needs `notifications` installed and the room to exist.** The transport throws
  on an unknown slug, which records the alert as `error` on purpose rather than losing it.
- **Never import `notifications` from here.** The dependent registers into `registerAlertTransport`
  from its own `onModuleInit`; alerts must stay unaware of it (`pnpm lint:deps` enforces this).
- **After a controller change, boot once** so typegen rewrites `appRouter.d.ts`, or the web
  typecheck is stale (`CLAUDE.md`). `pnpm verify` runs `typegen` for you.
- **`index.tsx` sits on the web feature-registry import cycle.** Never read a registry binding at
  module scope there, and load the app in a browser after touching it.
- Ports are Nest **8190** / Vite **5190**. A second Box needs its own `PORT` / `BOX_VITE_PORT`, not
  a neighbour of those - see `apps/server/src/agent/loopback-guard.ts` for why a near-miss is worse
  than a collision.
