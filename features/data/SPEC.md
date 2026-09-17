# `data` - signals, their sources and pulls, circuit boards, presets

The foundation. A **signal** is a named number with a history: a registry row in `signals` that
carries its own identity, vocabulary, owner, target and causal edges, plus points in two stores
(`signal_points` at the signal's own grain, and the legacy `legacy_signal_points` rows a channel
deriver rebuilds from raw `snapshots`). Around that sit the three ways points arrive - in-process
**pulls** (GitHub, X, Reddit, LinkedIn, npm, blog RSS, Hacker News, Substack), **data sources**
(user-created instances of a code-shipped `Provider`, each syncing the measures its bound signals
subscribe to), and hand entry - plus **circuit boards** (user-named canvases that place signals and
render `depends_on` as edges) and **presets** (the team's named lenses on the boards other features
own). Almost everything a team looks at is downstream of this feature.

- **dependsOn**: nothing. `data` is the root of the dependency graph.
- **Depended on by**: `planning`, `content`, `engagement`, `crm` and `alerts` name it directly in
  their `dependsOn`; `notifications` inherits it via `alerts`.
  That is every feature in the Box except `chat`, `automation` and `sink`.
- **Removal**: removing `data` means removing eight of the eleven features. `pnpm features --check`
  names the direct dependents. What breaks if you force it: the signal pickers and charts every
  other view uses, the `latest_signals` view `alerts` reads its targets from, the hooks port
  `planning`/`content`/`alerts` register into at boot, the LinkedIn post source `content` feeds,
  the preset bars on the Content / CRM / Initiatives boards, and 19 of the run funnel's actions.

## Tables

Six models, all in `packages/core/src/features/data/models.ts`. No migrations (`migrations: []`) -
every table is at its baseline shape.

| table | pk | what it holds |
|---|---|---|
| `snapshots` | `channel`, `snapshot_date` | raw verbatim pulls, one row per (channel, date), `payload` kept as-is. Also the audit trail a data-source sync writes (`data_sources.id` doubles as a snapshot channel). |
| `legacy_signal_points` | `signal_id`, `date` | the tidy long-format daily rows a channel deriver writes. `source` is `live` (wholesale-replaced on every re-derive) or `backfill` (gap filler). Identity is denormalized onto every row, which is why the registry lives elsewhere. |
| `signals` | `id` | the signal REGISTRY - one row per first-class signal: `label`, `signal_group`, `unit`, `channel`, `source` (`derived`\|`manual`), `interval`, `accumulation`, `direction`, `owner`, `description`, `depends_on` (JSON), `target` (JSON), `sort`, and the provider binding `data_source_id` + `measure_key`. Timestamps + audit. |
| `signal_points` | `signal_id`, `bucket`, `source` | the point store at the signal's own grain. `bucket` is the naive-UTC interval start (`floorSignalBucket`, ISO weeks, Monday start). `source` (`manual`\|`live`) is part of the PK so a live write can never destroy a hand-entered point. Timestamps + audit. |
| `signal_boards` | `id` | a circuit board: slug, label, description, `nodes` JSON (`[{signal_id, x, y}]`) written whole on every autosave, `sort`. Edges are NOT here - they are `signals.depends_on`. Timestamps + audit. |
| `data_sources` | `id` | a user-created instance of a provider: `provider`, `label`, `config` JSON (non-secret settings only), `status` (`enabled`\|`disabled`, born disabled), `notes`, and the four denormalized `last_sync_*` health stamps. Timestamps + audit. **No secrets** - those stay in the gitignored `config/credentials.json`. |

`data_sources.id` is deliberately three keys at once: the row key, the credentials account key
(`credentials.json → <provider> → <source id> → KEY`), and the `snapshots.channel` of the audit
snapshot. Hence the strict slug charset `^[a-z0-9][a-z0-9-]*$` and the refusal of ids that would
collide with a derived channel (`sources/state.ts`).

**Baseline view** (`manifest.ts` `baseline`, one entry):

```sql
CREATE OR REPLACE VIEW latest_signals AS
SELECT channel, signal_id, label, signal_group, unit,
       last(value ORDER BY date) AS value, max(date) AS as_of
FROM legacy_signal_points GROUP BY 1, 2, 3, 4, 5
```

`alerts/targets.ts` reads it; it is the only cross-feature consumer in the tree.

## Ports this feature owns

Two runtime registries, both filled by dependents from their server module's `onModuleInit` - the
"a dependent registers into the dependency" shape of `docs/core/SEAM.md` § 4.2.

**`registerSignalHooks(hooks)`** - `packages/core/src/features/data/signals/hooks.ts`. One
registration per feature id (registering twice throws). Four optional members:

| member | contract |
|---|---|
| `channelRows?: Record<channel, () => Promise<SignalRow[]>>` | extra live rows appended to that channel's derive. Required because a channel derive REPLACES the channel's live rows, so anything else living there must ride along or be wiped. |
| `derive?: () => Promise<number>` | a standalone derive step the `warehouse-derive` action runs after the in-process channels; returns the row count. |
| `onRename?: (oldId, newId, actor?) => Promise<void>` | a signal id was re-keyed; re-point every reference you hold. Runs inside `renameSignal`. |
| `references?: (signalId) => Promise<string[]>` | ids of your objects still referencing the signal, for the delete report. |

Registered today by `planning` (`PLANNING_SIGNAL_HOOKS` - all four members: PR rows on the github
channel, an OSS-PR derive step, initiative re-pointing and initiative references), `content` (`derive: deriveContentSignals`) and `alerts`
(`onRename: repointAlertRuleSignals`, `references: alertRulesReferencingSignal`).

**`registerLinkedinPostSource(source)`** - `packages/core/src/features/data/pulls/linkedin.ts`.
A `() => Promise<LinkedinPostRef[]>` that tells the LinkedIn pull which published posts to fetch
per-post analytics for. Registered by `content` (`publishedLinkedinPosts`). With nothing
registered, the LinkedIn pull simply has no posts to enumerate.

A third registry, `PROVIDERS` in `sources/registry.ts`, is **static, not a port**: each provider is
a workspace package (`@silkweave/box-provider-<id>`) depending only on
`@silkweave/box-provider-kit`, imported and keyed in by hand. Installing a provider is a commit, not
a runtime registration, and the direction core → provider → kit must never be reversed - a provider
that imported `@silkweave/box-core` would pull in the warehouse layer and make the cycle the split
exists to prevent.

**`PROVIDERS` ships EMPTY, on purpose.** A provider speaks to one company's SaaS account, so the
template carries none and every consumer already handles zero: the catalogue dialog renders empty
and `requireProvider` refuses with `registered providers: (none)`. Adding your own is § "Adding a
provider" below.

## Procedures and tools

Six controllers, all `@UseGuards(AuthGuard)` at class level. Where `@Mcp()` carries no `name` the
tool name is derived from `<Controller><method>`; the MCP listing renders a declared kebab name
PascalCased (`signal-upsert` appears as `SignalUpsert`), while `pnpm cli` takes the kebab form.

`SignalsController` (`@Controller('signals')`) - 13 procedures, 12 tools:

| tRPC | MCP | what |
|---|---|---|
| `signalsData` (query) | - | the full cross-channel payload in one round-trip: every definition, both point stores merged per bucket (live over manual), period aggregates, health, and the data sources for resolving `data_source_id`. Sub-daily buckets are windowed to `SUBDAILY_WINDOW_DAYS`. |
| `signalsList` (query) | `signals-list` | the registry rows alone, no points |
| `signalsUpsert` (mutation) | `signal-upsert` | create or partially update a definition; the domain refuses unknown `depends_on` ids, cycles, half a provider binding and out-of-enum values |
| `signalsRename` (mutation) | `signal-rename` | re-key an id, cascading to initiatives, alert rules, `depends_on`, the owners file and the rows. Refused for `source: 'derived'` - the deriver would re-create the old id. |
| `signalsDelete` (mutation) | `signal-delete` | remove a definition; prunes `depends_on` edges and board placements, reports bound initiatives, never deletes points |
| `signalsOwners` (query) | `signal-owners` | the `config/signal-owners.json` map (channel defaults + per-signal overrides) |
| `signalsOwnersSave` (mutation) | `signal-owner-set` | set/unset one mapping; applies at the next read, no restart |
| `signalsSeries` (mutation) | `signal-series` | ONE signal's full merged history, windowable. The read path for agents. |
| `signalsPoints` (mutation) | `signal-points` | the manual-point EDITOR backend: manual points with their shadow state. Returns `[]` for a purely-live signal, by design. |
| `signalsPointSet` (mutation) | `signal-point-set` | upsert one manual point at `floor(at, interval)` |
| `signalsPointDelete` (mutation) | `signal-point-delete` | remove one manual point |
| `signalsPointsSet` (mutation) | `signal-points-set` | bulk manual entry; `points` travels as a JSON array string, all-or-nothing |
| `signalsEvent` (mutation) | `signal-event` | record one occurrence of an increment signal, idempotent via `dedup_key`; the signal's live buckets re-derive from its events |

`SourcesController` (`@Controller('sources')`) - 4 procedures, 4 tools:

| tRPC | MCP | what |
|---|---|---|
| `sourcesProviders` (query) | `providers-list` | every registered provider with its config fields, credential key NAMES and measure catalogue |
| `sourcesList` (query) | `data-sources` | every source with health stamps, credential PRESENCE booleans (never values), bound signals and dead measures |
| `sourcesUpsert` (mutation) | `data-source-upsert` | create or partially update a source; `config` travels as a JSON object string |
| `sourcesDelete` (mutation) | `data-source-delete` | remove a source. Bound signals are REPORTED, never unbound - they keep their points and stop refreshing. |

`BoardsController` (`@Controller('boards')`) - 4 procedures, 4 tools:

| tRPC | MCP | what |
|---|---|---|
| `boardsList` (query) | `boards-list` | every board with its full node list (boards are few and small - there is no per-board read) |
| `boardsUpsert` (mutation) | `board-upsert` | a board's METADATA only; it deliberately does not accept `nodes`, so a label edit cannot race the position autosave |
| `boardsDelete` (mutation) | `board-delete` | remove a board; nothing cascades, no soft delete |
| `boardsNodesSet` (mutation) | `board-nodes-set` | replace the whole membership + position list (the SPA's ~2s debounced autosave); refuses bad shapes, non-finite coordinates, unknown or duplicated signal ids |

`PresetsController` (`@Controller('presets')`) - 6 procedures, 6 tools:

| tRPC | MCP | what |
|---|---|---|
| `presetsList` (query) | `presets` | every module's presets plus which modules have been seeded, in one payload |
| `presetsSave` (mutation) | `preset-save` | create or overwrite one named preset (`state` is a JSON object string) |
| `presetsUpdate` (mutation) | `preset-update` | edit an existing preset in place, keeping its position; rename onto a taken name is refused |
| `presetsReorder` (mutation) | `preset-reorder` | the team's own order for one module |
| `presetsDelete` (mutation) | `preset-delete` | remove one; deleting a name that is not there succeeds silently |
| `presetsSeed` (mutation) | `preset-seed` | install a module's built-in defaults (the defaults live in the SPA). `mode: 'initial'` is a no-op once the module is in `seeded`, which is what makes "delete a preset" stick. |

`IngestController` (`@Controller('ingest')`) - 14 procedures, 13 tools. `ingestCatalog` (query,
no tool) lists core's action registry filtered to the `Pulls` and `Backfills` groups; the other
thirteen are tRPC **subscriptions** with `@Mcp()` (streamed progress), each a one-line
`startDetachedRun('<action-id>', { trigger: 'manual' }).tail()`:

| tRPC | MCP | action |
|---|---|---|
| `ingestGithub` | `IngestGithub` | `github` |
| `ingestGithubEngagement` | `IngestGithubEngagement` | `github-engagement` |
| `ingestX` | `IngestX` | `x` |
| `ingestReddit` | `IngestReddit` | `reddit` |
| `ingestRedditEngagement` | `IngestRedditEngagement` | `reddit-engagement` |
| `ingestRedditRadar` | `IngestRedditRadar` | `reddit-radar` |
| `ingestNpmPull` | `IngestNpmPull` | `npm-pull` |
| `ingestBlogPull` | `IngestBlogPull` | `blog-pull` |
| `ingestHackernewsPull` | `IngestHackernewsPull` | `hackernews-pull` |
| `ingestBackfillPrs` | `IngestBackfillPrs` | `backfill-prs` |
| `ingestBackfillStars` | `IngestBackfillStars` | `backfill-stars` |
| `ingestBackfillX` | `IngestBackfillX` | `backfill-x` |
| `ingestNpmBackfill` | `IngestNpmBackfill` | `npm-backfill` |

The `linkedin`, `substack-pull`, `backfill-linkedin` and `sources-sync` actions have **no** method
here; they are reachable through core's run funnel (`opsRunNow` / the Automation view) only.

`WarehouseController` (`@Controller('warehouse')`) - 1 procedure, 1 tool:

| tRPC | MCP | what |
|---|---|---|
| `warehouseDerive` (mutation) | `WarehouseDerive` | run data's `warehouse-derive` action |

`warehouseBackup` used to be here too. It moved to core on 2026-09-17 (`apps/server/src/ops/warehouse.controller.ts`),
because a Box with no features installed still has a warehouse to protect.

**42 procedures, 40 MCP tools** in total.

## Actions

19 `ActionSpec`s in `packages/core/src/features/data/actions.ts`, contributed to core's run funnel
through the manifest (so all of them are schedulable by `automation` and visible in run history).

Group **Pulls** (13): `github` (followers, repo stars/forks, OSS PRs), `github-engagement`
(issue/PR engagement awaiting a reply), `x` (profile + per-post organic), `linkedin` (member +
page analytics via the Community Management API), `reddit` (account/karma via the stealth
browser), `reddit-engagement` (inbox replies), `reddit-radar` (scan target subs for openings),
`npm-pull` (weekly downloads), `blog-pull` (publishing cadence from the configured RSS feed),
`hackernews-pull` (profile, submissions, brand mentions), `substack-pull` (archive + subscribers /
open rate via the private API, needs a session cookie), `sources-sync` (pull every ENABLED data
source; one bad source does not stop the others), plus the parameterized `source-sync` (pull ONE
source, disabled ones included - the supervised first run; `params: source_id`). That is 13 ids in
the group, one of them parameterized.

Group **Backfills** (5): `backfill-prs`, `backfill-stars`, `backfill-x`, `backfill-linkedin`
(follower + engagement history reconstructed from daily analytics deltas), `npm-backfill`
(~17 months of weekly downloads).

Group **Warehouse** (1): `warehouse-derive` - re-derive every in-process channel from raw
snapshots, then run every registered hook's `derive()` step and report the extra rows per feature.
(`warehouse-backup` belongs to core, `packages/core/src/ops/core-actions.ts`, not to this feature.)

## The browser lease, and the stance behind it

**Prefer an official API, always.** Browser automation is the last resort for a surface with no
usable API (LinkedIn newsletter articles) or a blocked one (Reddit's OAuth path); it carries real
ToS and account-ban risk, and it is never used against a surface the Box holds scopes for. Reads
are low-risk and run unattended; writes are high-risk and stay human-gated. Once a browser flow is
understood it is frozen into a deterministic ingest action - which is where every `pulls/` file is.

`cdp.ts` does not launch a browser: it **leases a tab** in a long-running, human-logged-in Chrome
that a gateway (chromatrix) owns, one per identity. The reasons are all things a launched browser
lacks - the session is already there, so no credential handling and no login flow to automate; the
fingerprint is a genuine daily-use one rather than a vanilla headless profile; one browser per
person serves many services; a human can watch or take the tab over live. Four rules follow, each
of which has already cost something:

- **Every connect must be paired with `detach()`**, which closes the Playwright connection AND
  releases the lease. An unreleased lease leaks a tab and a window forever, so `withBrowser()`
  exists to stop consumers having to remember.
- **`compat: true` is mandatory** and the connector sets it - it asks the gateway for the
  unmitigated protocol. Without it `Runtime.enable` is suppressed, `goto` resolves, and then
  `title()` / `textContent()` hang forever on a main-world context that never arrives.
- **Attach to `firstContext(browser)`, never `browser.newContext()`** - a fresh context is
  unauthenticated with a clean fingerprint, which defeats the entire point.
- **Never launch or kill the browser** and never `close()` the shared context: the process belongs
  to a person. A logged-out identity is signed in BY HAND through the gateway's takeover.

Three per-channel facts that are load-bearing rather than incidental:

- The GitHub pulls require a per-account token and **never** fall back to the ambient `gh` CLI
  login, so a run cannot silently ride whoever happens to be logged in under a supervisor. Repo
  traffic additionally needs push access, and GitHub retains only **14 days** of it - a missed
  stretch is lost history, not a gap a backfill can close.
- `LINKEDIN_VERSION` pins a `Linkedin-Version` header that LinkedIn sunsets **monthly** - bump it
  deliberately. The client refreshes an access token proactively near expiry and once reactively on
  a `401`, which is what lets the daily pull run unattended.
- Substack has no OAuth and its login endpoint is captcha-gated unconditionally, and a
  `substack.sid` cookie is **not** proof of a session - Substack sets it on anonymous visitors too.
  Every candidate is probed against `/user/profile/self` before it is accepted; the first version
  trusted the cookie and turned a recoverable state into a hard 401.

## UI

`apps/web/src/features/data/index.tsx` fills three of the web contract's slots and none of the
others.

- **Routes** (`routes.tsx`, both direct children of `rootRoute`):
  - `/signals` - `SignalsLayout` (shell, one sidebar entry per BASE channel with a signal count,
    breadcrumbs) with `/` → `SignalsGrid`, `$channel/` → `SignalsGrid`, `$channel/$signal` →
    `SignalDetailView`. Account-scoped channels (`github@dan`) fold into their base entry.
  - `/signals/board` - a permanent `redirect({ to: '/boards' })`; the single implicit board became
    the top-level surface and old links must keep working.
  - `/boards` - `BoardsLayout` with `/` → `BoardsIndex` and `$id` → `BoardView`.
- **Nav**: two entries, order band 100-199. `Signals` (icon `BarChart3`, `/signals`, order **100**)
  and `Circuit Boards` (icon `Waypoints`, `/boards`, order **110**).
- **Settings**: two sections. `Signal owners` (icon `BarChart3`, order **110**, `SignalOwnersView`)
  and `Data sources` (icon `Plug`, order **120**, `DataSourcesSection`).
- **Shell / slots / onSession**: none.
- **Stores** (`lib/`): `useSignalsData` reloads on
  `table:signals`, `table:signal_points`, `table:snapshots`, `docs:signals` and
  `config:signal-owners.json`; `useSourcesData` on `table:data_sources` + `table:signals`;
  `useBoardsData` on `table:signal_boards` only (deliberately separate from the heavy signals
  payload). `lib/presets.ts` has no change-feed topic - presets are a config file, so the store
  reloads after a local write and picks up someone else's on the next page load.
- The React Flow canvas is lazy (`components/board/CircuitBoardFlowLazy.tsx`).

## Env

Declared in `apps/server/src/features/data/index.ts`:

| name | doc |
|---|---|
| `CDP_URL` | Chrome DevTools endpoint of the stealth browser the Reddit pulls drive |
| `GITHUB_TOKEN` | GitHub API token for the github pulls |

Both declarations are stale against the code as it stands (see the Gotchas in
[`AGENT.md`](./AGENT.md)): `cdp.ts` reads `CHROMATRIX_URL`, `CHROMATRIX_IDENTITY` and
`CHROMATRIX_TOKEN`, and the GitHub pull takes its token per account from
`config/credentials.json` (`github → <account> → GH_TOKEN`), never from `GITHUB_TOKEN`.

Everything else the pulls and syncs need is a **credential**, not an env var:
`credential(<provider-or-channel>, <account>, KEY)` over the gitignored
`config/credentials.json` - `GH_TOKEN`, `LINKEDIN_CLIENT_ID` / `_SECRET` / `_ACCESS_TOKEN` /
`_PERSON_URN` / `_REFRESH_TOKEN`, the Substack email/password/session keys, GA4's
`GOOGLE_APPLICATION_CREDENTIALS` + `GA4_PROPERTY_ID`, and whatever key names each provider
declares.

## Admin-only

Since 2026-09-13 the Box has two tiers (`docs/core/AUTH.md` § 3), and the rule every feature applies is
one sentence: **an operation is admin-only when its blast radius is another person's identity or
credential, the service itself, or configuration wired to credentials.**

This feature's admin set is `signal-upsert`, `signal-rename`, `signal-delete`, `signal-owner-set`, `data-source-upsert`,
`data-source-delete`.

Signal DEFINITIONS are configuration and a data source is configuration wired to credentials.
Everything else here is a member's, manual point entry included - it is operational data entry, and
admin-gating the primary interaction makes the tool unusable.

## What a team customises

The vocabularies are small and deliberate; almost everything a team changes is a label, an id or a
config file.

- **Signal vocabulary** (`packages/core/src/features/data/signals/types.ts`): `SIGNAL_SOURCES`
  (`derived` \| `manual`) and `SIGNAL_POINT_SOURCES` (`manual` \| `live`) are structural - do not
  edit them. `SIGNAL_INTERVALS`, `SIGNAL_ACCUMULATIONS` and `SIGNAL_DIRECTIONS` are re-exported
  from `@silkweave/box-provider-kit`, because a provider's measure catalogue declares defaults in
  them; changing those is a kit change, not a feature change.
- **`MANUAL_SIGNAL_CHANNEL`** (same file, today `'business'`) - the channel source-less signals
  land on. Rename it to whatever the team calls its hand-kept numbers.
- **Channels.** `DERIVED_CHANNELS` in `signals/derive.ts` is `github, reddit, x, linkedin, npm,
  blog, hackernews, substack` - each is a deriver function in `DERIVERS`, so removing one means
  removing its pull, its deriver and its action. On the web, `apps/web/src/types.ts` (app-level,
  not inside the feature) carries the `Channel` union and `CHANNEL_LABEL`, and it must be kept in
  step by hand: it additionally carries `content` (content's own derive) and `business`
  (`MANUAL_SIGNAL_CHANNEL`). A channel missing from that union falls back to its raw id in the
  sidebar rather than failing - which is why the two lists drift silently.
- **Signal ownership** - `config/signal-owners.json`, editable from Settings → Signal owners.
  Resolution order: the definition's `owner`, then the per-signal override, then the channel
  default, then the channel's account binding (`config/accounts.json`), then unowned.
- **Accounts** - `config/accounts.json` drives the account-scoped `github@<id>` channels and their
  per-account credentials, and carries the per-channel facts a handle does not imply: `feed` (the
  blog RSS URL), `publication` (the Substack origin), `repos` / `ossPrQuery` (GitHub),
  `mentionTerms` (who is talking about us). Example: `docs/examples/accounts.json`.
- **Blog feed** - `feed` on a `blog` account in `config/accounts.json` (`blog-feed.ts`) says which
  RSS feed the blog pull fetches. No default, and the blog channel was already account-shaped here,
  so it did not earn a config file of its own. A Box with no `feed` gets one log line and no pull
  (2026-09-14 - it was hardcoded to the author's own feed before that, with no override path).
- **Reddit radar** - `config/reddit-radar.json` (`reddit-radar.ts`) says which subreddits the topic
  radar scans and which keywords make a thread on-topic. Both lists must be non-empty for a scan;
  either empty means one log line and no pull. Every stored scan stamps the `subs` and `topics` that
  produced it, so `candidates[].matched` is never reinterpreted against a list edited since
  (2026-09-14 - they were two constants naming one company's target communities before that).
- **npm packages** - `config/npm-packages.json` (`npm-packages.ts`) says which packages this Box
  counts downloads for: `packages` sum into `npm.week`/`npm.month` and compete for the top-six
  per-package signal, `tracked` always get their own and never fold into the aggregate. Shaped like
  `accounts.json` rather than `initiative-kinds.json`: a declared list, empty by default, no seed.
  A seed here could only be somebody else's packages, and npm needs no credential, so a Box with no
  file just gets one log line and no pull (2026-09-14 - it was hardcoded before that).
- **Data sources vs providers.** A team creates `data_sources` rows from the UI; that needs no
  code. Adding a new PROVIDER is a code change - see § "Adding a provider". The template ships
  none, so the catalogue is empty until a team writes one.
- **Presets** - `PRESET_MODULES` in `presets/presets.ts` is a closed list: `content`, `crm`,
  `initiatives`. Those name the boards of `content`, `crm` and `planning`, so a Box without one of
  those features has a module nobody seeds. The default preset lists live in the SPA and arrive
  through `presetsSeed`; the icon vocabulary is `components/board/presetIcons.tsx`.
- **Nav and settings order** - `apps/web/src/features/data/index.tsx`. Band 100-199 puts Signals at
  the top of the sidebar.
- **Pulls.** Every pull in `pulls/` is a channel this team may not have. Deleting one means
  deleting its file, its `DERIVERS` entry, its `ActionSpec`(s) in `actions.ts` and its
  `IngestController` method if it has one.

## Adding a provider

`PROVIDERS` is empty in the template, so this is the one piece of `data` every team that syncs a
SaaS account writes for itself. The running example below is a hypothetical `mailer` - a mailing
platform with per-region workspaces.

1. **Create the package.** `packages/provider-mailer`, name `@silkweave/box-provider-mailer`, with
   exactly one dependency: `@silkweave/box-provider-kit`. Nothing else, ever. A provider that
   reaches for `@silkweave/box-core` gets the warehouse layer and the dependency cycle the split
   exists to prevent, which is also why the kit - not core - carries the signal vocabulary and the
   fetch helpers.
2. **Implement `Provider`** (`packages/provider-kit/src/provider.ts`), five declarations and one
   function:
   - `id` - stable, and doubles as the `credentials.json` channel key and the default signal
     channel (`mailer`).
   - `config` - the non-secret settings ONE instance needs, as `ProviderConfigField`s
     (`{key: 'workspace', label: 'Workspace', required: true}`). These are what the user fills in
     the new-data-source dialog and what lands in `data_sources.config`.
   - `credentials` - key NAMES only, never values (`['MAILER_API_KEY']`). The engine resolves them
     out of the gitignored `config/credentials.json` and hands the pull the resolved strings.
   - `measures` - the catalogue: one `ProviderMeasure` per data point you offer, keyed by the
     remote's NATIVE token (`'DELIVERED'`, uppercase and all), each carrying the defaults a new
     signal bound to it starts from (unit, interval, accumulation, direction, group).
   - `pull(ctx)` - a **pure fetcher**. Return `{points, raw, window}`; never write anything. Only
     `ctx.measures` is fetched (the subscribed subset), `ctx.progress` emits run-log lines, and a
     credential that ROTATES on use is handed back through `ctx.saveCredentials` the instant it
     rotates - before anything that can fail. Every warehouse write, the audit snapshot and the
     progress stream stay in core's sync engine, which is what keeps a provider at roughly a
     hundred lines.
3. **Register it.** Add the workspace dependency to `packages/core/package.json`, then the import
   and one key in `PROVIDERS` (`sources/registry.ts`). Installing a provider is a commit, not a
   runtime registration - nothing is discovered at boot.
4. **Create data sources from the UI.** A provider is code; a **data source** is a row. Two
   regions are two rows of the same provider - "Mailer EU" with `{workspace: 'acme-eu'}` and
   "Mailer US" with `{workspace: 'acme-us'}`, each with its own credentials under
   `credentials.json → mailer → <source id> → MAILER_API_KEY`. Rows are born `disabled`.
5. **Bind signals.** A measure exists whether or not anyone subscribes; a signal becomes connected
   by carrying both halves of the binding (`data_source_id` + `measure_key`) - `signalsUpsert`
   refuses half of one.

`pnpm verify` covers the wiring: an unregistered id fails loud at `requireProvider` with the list
of what IS registered, and a data-source row can outlive its provider (`findProvider` returns
null) rather than breaking the page.
