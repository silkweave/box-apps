# Installing `data`

The recipe. Read [`SPEC.md`](./SPEC.md) first for what the feature is; this is how it gets into a
Box and what to change afterwards.

## 1. Install

**The scaffold is the working code**, not a copy of it (see `features/README.md`). `box adopt`
fetches it from the registry at its tag, byte-exact, and rewrites the registries and skill links:

```bash
box registry validate                  # confirm the index offers data, and at which version
box adopt data                         # fetches the four directories and anything it dependsOn
pnpm install && pnpm build             # adoption changes package.json; tests resolve via build/
pnpm verify                            # features:check, lint:deps, typegen, typecheck, lint, tests
pnpm schema:check                      # diagnostic, not part of verify: run it after a schema change
```

In this checkout `data` is already installed; the above is what a fresh Box runs.

`data` has no `dependsOn`, so `pnpm features --check` will never send you elsewhere first. It is
the other way round: install `data` before `planning`, `content`, `engagement`, `crm` or `alerts`.

**Do not rename the directory.** The name is the migration ledger namespace (`data:<name>` in
`schema_migrations`) and it is the same string in all three trees. `data` has no migrations today,
which makes renaming look free; it is not, and the rule has no exceptions.

Two things ride along that are NOT inside the three directories:

- `packages/provider-kit` (`@silkweave/box-provider-kit`) - the Provider contract, a core
  dependency. Copy it. The `PROVIDERS` registry in `sources/registry.ts` is **empty on purpose**
  and every consumer handles zero, so a fresh Box needs no provider package at all; writing one is
  `SPEC.md` § "Adding a provider", and each is a `@silkweave/box-provider-<id>` workspace package
  depending only on the kit.
- `apps/web/src/types.ts` carries the `Channel` union, `CHANNEL_LABEL` and the `@`-account helpers
  the Signals sidebar reads. It is app-level, shared with other features, and is not copied by the
  three `cp -R` lines above.

Nothing else is edited.

## 2. Customise for the team

1. **Channels.** `packages/core/src/features/data/signals/derive.ts` - `DERIVED_CHANNELS` is
   `github, reddit, x, linkedin, npm, blog, hackernews, substack`, each with a deriver in
   `DERIVERS`. Delete the channels this team does not have: the deriver, its file under `pulls/`,
   its `ActionSpec`(s) in `actions.ts`, and its `IngestController` method in
   `apps/server/src/features/data/ingest/ingest.controller.ts` if it has one. Then mirror the list
   in `apps/web/src/types.ts` (`Channel` + `CHANNEL_LABEL`) - that file is app-level and hand-kept,
   and it additionally carries `content` and `business` (`MANUAL_SIGNAL_CHANNEL`). Nothing checks
   the two lists against each other: a channel missing from the union falls back to its raw id in
   the sidebar, so drift is silent.
2. **The manual channel.** `signals/types.ts` - `MANUAL_SIGNAL_CHANNEL` is `'business'`, the
   channel every source-less signal lands on. Rename it to whatever the team calls its hand-kept
   numbers, and add the matching `CHANNEL_LABEL` entry.
3. **Credentials, not env.** `config/credentials.json` (gitignored) under
   `<provider-or-channel> → <account> → KEY`. GitHub wants `GH_TOKEN` per account; LinkedIn wants
   `LINKEDIN_CLIENT_ID` / `_SECRET` / `_ACCESS_TOKEN` / `_PERSON_URN` / `_REFRESH_TOKEN`; the blog
   pull wants `GOOGLE_APPLICATION_CREDENTIALS` + `GA4_PROPERTY_ID`; Substack wants its session
   keys. A pull with no credential fails loud, on purpose.
4. **Accounts.** `config/accounts.json` drives the account-scoped `github@<id>` channels (one
   deriver, namespaced signal ids) and supplies the account binding that resolves signal ownership.
5. **npm packages.** `config/npm-packages.json` (`packages` = the line that sums into
   `npm.week`/`npm.month`; `tracked` = standalone packages that always get their own signal).
   Start from `docs/examples/npm-packages.json`. EMPTY BY DEFAULT and never seeded - the npm pull
   needs no credential, so a default list would import somebody else's downloads on day one. No
   packages configured means the pull logs that and does nothing.
6. **Signal ownership.** `config/signal-owners.json`, editable from Settings → Signal owners.
   Channel defaults plus per-signal overrides; an explicit `null` marks a signal deliberately
   unowned. It applies at read time, so no re-derive and no restart.
7. **Providers and data sources.** A provider is code: a `@silkweave/box-provider-<id>` workspace
   package depending only on `@silkweave/box-provider-kit`, plus one line in
   `packages/core/src/features/data/sources/registry.ts`. Never let a provider import
   `@silkweave/box-core` - that is the cycle the packaging exists to prevent. A DATA SOURCE is a
   row the team creates in Settings → Data sources; it is born `disabled` on purpose.
7. **Presets.** `presets/presets.ts` - `PRESET_MODULES` is the closed list `content`, `crm`,
   `initiatives`, which names boards owned by `content`, `crm` and `planning`. Drop the entries for
   features this Box does not install. The default preset lists live in the SPA
   (`apps/web/src/features/*/...`, sent through `presetsSeed`) and the icon vocabulary is
   `apps/web/src/features/data/components/board/presetIcons.tsx`.
8. **Nav and settings order.** `apps/web/src/features/data/index.tsx` - band 100/110 for the two
   nav entries, 110/120 for the two settings sections. Band 100-199 is data's.
9. **The env declarations.** `apps/server/src/features/data/index.ts` declares `CDP_URL` and
   `GITHUB_TOKEN`. Neither name is read by the code any more (see Gotchas). Replace them with the
   names this Box actually uses before `pnpm typegen` prints them at someone.

Enum edits in `signals/types.ts` and `sources/types.ts` need no migration until a Box has shipped
with the old set; after that, a migration in `migrations.ts` rewrites the rows (`docs/core/SEAM.md`
§ 3). `SIGNAL_SOURCES` and `SIGNAL_POINT_SOURCES` are structural - leave them alone.

## 3. Prove it

```bash
pnpm dev
```

- `http://localhost:8190/signals` - the channel sidebar renders one entry per base channel with a
  signal count, and the grid shows cards. An empty Box shows an empty grid, which is fine: the
  registry is allowed to be empty and a definition may exist with no points at all.
- `http://localhost:8190/boards` - the boards index. Create one, open it, drag a signal onto the
  canvas; the position autosaves (~2s debounce) into `signal_boards.nodes`, so a reload puts it
  back where you left it. Positions are TEAM state, never localStorage.
- `http://localhost:8190/settings` → **Signal owners** and **Data sources**. Creating a source
  writes a `disabled` row; its credential presence booleans show whether
  `config/credentials.json` has the keys its provider declares.

Agent-side:

```bash
pnpm cli signals-list                  # the registry
pnpm cli signal-upsert                 # create a manual signal
pnpm cli signal-point-set              # hand-enter one point
pnpm cli signal-series                 # read that signal's numbers back
pnpm cli providers-list                # the provider catalogue
pnpm cli data-sources                  # the sources and their health
pnpm cli boards-list
pnpm cli presets
```

The round trip worth running once is `signal-upsert` → `signal-point-set` → `signal-series`: it
proves the registry, the point store, the bucket flooring and the merged read all agree. Use
`signal-series` and not `signal-points` for that - `signal-points` is the manual-point editor
backend and correctly returns `[]` for a purely-live signal.

A pull needs real credentials, so the honest smoke test for ingestion is `pnpm cli
warehouse-derive` (or the `github` pull, once `GH_TOKEN` is in `credentials.json`), then checking
that the run landed in the Automation run history. Tool names normalize: the CLI proxy accepts
`warehouse-derive` for the tool the MCP listing calls `WarehouseDerive`.

## 4. Remove

**There is no removal command.** This code is yours: delete the directories, then check that
nothing else in your Box still imports `data` and prune the npm packages
`features/data/deps.json` declares that no remaining feature needs.


```bash
rm -rf packages/core/src/features/data apps/server/src/features/data apps/web/src/features/data
pnpm features && pnpm verify
```

`features --check` will immediately name the dependents. **`planning`, `content`, `engagement`,
`crm` and `alerts` must go too**, and removing `alerts` drags `notifications` with it -
which is eight of eleven features. In practice `data` is not a feature you remove; it is the one
you start from. If you genuinely want a Box without signals, start from a Box that never had it.

Nothing purges the tables. `snapshots`, `legacy_signal_points`, `signals`, `signal_points`,
`signal_boards` and `data_sources` stay in the warehouse, as do `config/signal-owners.json`,
`config/presets.json` and `config/credentials.json`.

## Gotchas

- **The declared `env` does not match the code.** `apps/server/src/features/data/index.ts` declares
  `CDP_URL` and `GITHUB_TOKEN`. `cdp.ts` actually reads `CHROMATRIX_URL`, `CHROMATRIX_IDENTITY` and
  `CHROMATRIX_TOKEN` (and best-effort `loadEnvFile`s the repo `.env` at module scope), and the
  GitHub pull reads its token from `credentials.json`, per account, as `GH_TOKEN`. Setting
  `GITHUB_TOKEN` does nothing.
- **"Admin-only" is a comment, not a guard.** The doc comments on `signalsUpsert`, `signalsRename`,
  `signalsOwnersSave`, `sourcesUpsert` and `sourcesDelete` say admin-only, but the controllers
  carry only the class-level `AuthGuard` and there is no `@Roles` decorator anywhere in
  `apps/server/src`. Any authenticated principal can perform them today.
- **The `sources` controller's doc comments name the wrong procedures.** They say `providersList`,
  `dataSourcesList`, `dataSourcesUpsert`, `dataSourcesDelete`; the generated router (and the SPA)
  use `sourcesProviders`, `sourcesList`, `sourcesUpsert`, `sourcesDelete`.
- **A channel derive REPLACES that channel's live rows.** Anything another feature keeps on the
  same channel must arrive through `registerSignalHooks({ channelRows })` or it is wiped on the
  next `warehouse-derive`. This is why planning's PR rows ride the `github` channel through the
  port rather than writing the table directly.
- **Live-writer exclusivity.** A bound signal's `source='live'` rows belong to its data source's
  sync, exclusively. The increment machinery (`deriveSignalIncrements`) is also a live writer and
  deletes every live row before rebuilding from events, so `signals/points.ts` refuses it on bound
  signals and `sources/sync.ts` is the other half of that pact. Do not add a third live writer.
- **`source` is part of the `signal_points` PK** so a live write can never destroy a manual point.
  Reads deduplicate per bucket with live-over-manual precedence, which means a shadowed manual
  point resurfaces if the live source retreats. That is intended, not a bug.
- **A `derived` signal cannot be renamed.** `signal-rename` refuses it: the deriver generates the
  id, so the next pull would re-create the old one.
- **Deleting a data source does not unbind its signals.** They are reported, keep their points and
  stop refreshing. A visible dead binding beats a silently narrowed signal.
- **`data_sources.id` is three keys at once** - the row key, the credentials account key, and the
  audit `snapshots.channel`. Hence the strict slug charset and the refusal of ids that collide with
  a derived channel. Do not "just rename" a source id.
- **`boardsUpsert` deliberately does not accept `nodes`.** Use `boardsNodesSet` for membership and
  positions, so a label edit can never race the position autosave onto the same column.
- **Import `CircuitBoardFlowLazy`, never `CircuitBoardFlow`** - the React Flow chunk is lazy on
  purpose and the boards index does not need it.
- **`index.tsx` sits on the web feature-registry import cycle.** Never read a registry binding at
  module scope there, and load the app in a browser after touching it - `pnpm verify` has no
  runtime step (`CLAUDE.md`).
- **After a controller change, boot once (or `pnpm typegen`)** so `appRouter.d.ts` is rewritten, or
  the web typecheck is stale. `data` owns 43 procedures, so this bites here more than anywhere.
- **Ports are 8190 (Nest) / 5190 (Vite).** A second Box gets its own `PORT` / `BOX_VITE_PORT`,
  never a neighbour of these: two Boxes running the same code are indistinguishable from the
  outside, so a near-miss is mistaken for the real one instead of being rejected
  (`CLAUDE.md`, `apps/server/src/agent/loopback-guard.ts`).
- **`export LC_ALL=en_US.UTF-8` before any repo-wide grep.** Several files in this feature contain
  non-ASCII bytes (`★` in the GitHub deriver, `→` and `·` in comments and labels), and macOS grep
  skips such files silently.
