# Installing `content`

The recipe. Read [`SPEC.md`](./SPEC.md) first for what the feature is; this is how it gets into a
Box and what to change afterwards.

## 1. Install

**The scaffold is the working code**, not a copy of it (see `features/README.md`). `box adopt`
fetches it from the registry at its tag, byte-exact, and rewrites the registries and skill links:

```bash
box registry validate                  # confirm the index offers content, and at which version
box adopt content                      # fetches the four directories and anything it dependsOn
pnpm install && pnpm build             # adoption changes package.json; tests resolve via build/
pnpm verify                            # features:check, lint:deps, typegen, typecheck, lint, tests
pnpm schema:check                      # diagnostic, not part of verify: run it after a schema change
```

In this checkout `content` is already installed; the above is what a fresh Box runs.

**Do not rename the directory.** `content` is the migration ledger namespace (`content:<name>` in
`schema_migrations`) and the same string in all three trees. The list is empty today; the rule has
no exceptions.

Nothing else is edited. The two tables are created from their `ModelSpec` on the next boot.

## 2. Customise for the team

1. **The voice files** - `<BOX_DATA_DIR>/docs/identity/voice-guide.md` and
   `docs/identity/voice/global.md`, then a `<channel>.md` per channel the team uses and
   `@<author>.md` per person. This is the single biggest edit: every skill checks drafts against
   these, and the ones that ship are EXAMPLES - a worked house style for the example authors
   (`alice`, `carol`, `bob`) plus the `company` company-page overlay. Editable in the app at
   Settings → Channels, or as files in the repo (they are markdown on disk on purpose - a style
   rule wants a diff and a git history).
2. **The channel vocabulary** - `CONTENT_CHANNELS` in
   `packages/core/src/features/content/types.ts`, and the matching entry in
   `CHANNEL_PROFILE_DEFAULTS` in `profiles.ts` (a channel without a profile is not renderable and
   the overlay file will ignore it). Mirror it in
   `apps/web/src/features/content/content-types.ts` and give it an icon/label in
   `apps/web/src/features/content/components/contentMeta.tsx`. An enum edit needs **no migration**
   until a Box has shipped with the old set; after that, a migration in `migrations.ts` rewrites the
   existing `content_pieces.channel` rows first.
3. **The channel profiles** - limits, `requires`, `recommends`, `voiceNotes`. Prefer the runtime
   overlay (Settings → Channels → `config/channel-profiles.json`) over editing `profiles.ts`: the
   file holds only the keys the team changed, so a later release that fixes a default still reaches
   them. `publish` is not overlayable - if a channel gains a real sender, that is code plus an
   `ActionSpec`, not config.
4. **The lifecycle copy** - `CONTENT_TRANSITIONS` labels and `intent` strings in `transitions.ts`
   are what the confirm dialogs say. `CONTENT_STATUSES` itself is four stages and an exit and was
   deliberately cut down from eight on 2026-08-13; read the header in `types.ts` before adding one
   back. A topic's statuses come from `planning` - change them there or not at all.
5. **Publishers and env** - decide per channel whether a real send is wanted. Leave
   `LINKEDIN_PUBLISH_LIVE` and `SUBSTACK_PUBLISH_LIVE` unset (or not `1`) and the scheduled
   publishers dry-run. Add them to `.env` only when the team has agreed to real sends, and keep
   `.env.example` in step (the `env` list in `apps/server/src/features/content/index.ts` is the
   machine-readable copy; `pnpm typegen` prints the unset ones).
6. **The skills** - the seven copied into `.claude/skills/` are procedures, so they are edited as
   prose. `ingest-sink`/`consult` reference `pnpm idea:apply` and `illustration` references
   `pnpm image`,
   neither of which is a script in this template's `package.json`. Rewrite them for the team's own
   host and tools. (`draft-reply` and `engage` moved to `features/engagement/skills/` on
   2026-09-13 - they drive that feature's tools, not this one's.)
7. **Labels and order** - the nav entry and the Channels settings section in
   `apps/web/src/features/content/index.tsx`, both band 300.

## 3. Prove it

```bash
pnpm dev
```

Open `http://localhost:8190/content`: the board renders (empty is fine). Create a topic, set its
target channels, move it to `active`, then open `/content/<topic>` - the topic page shows the
brief, the doc editor and the pieces. Open a piece at `/content/<topic>/<channel>`: the transition
wizard offers exactly `Verify`, `Approve`, `Archive` on a draft, the body editor autosaves to
`docs/content/<topic>/<channel>.md` (check the file), and an auto channel shows **Publish now**
while a manual one shows **Record published** and demands the URL. Settings → Channels edits a
profile and writes `config/channel-profiles.json`.

Agent-side, the same surface is MCP:

```bash
pnpm cli topic-upsert --id my-topic --title "My topic" --target_channels blog,reddit
pnpm cli topic-pending-channels --id my-topic
pnpm cli content-upsert --id my-topic/reddit --title "…"
pnpm cli content-doc-save --id my-topic/reddit --content "…"
pnpm cli voice-read --channel reddit --author alice
pnpm cli content-verify --id my-topic/reddit --findings '[]'   # --no-passed for a failing verdict
pnpm cli content-list --topic_id my-topic
pnpm cli content-publish --id my-topic/reddit --published_url https://… --confirm
```

`content-publish` is record-only and refuses without `confirm`, and refuses `linkedin` outright.

## 4. Remove

**There is no removal command.** This code is yours: delete the directories, then check that
nothing else in your Box still imports `content` and prune the npm packages
`features/content/deps.json` declares that no remaining feature needs.


```bash
rm -rf packages/core/src/features/content apps/server/src/features/content apps/web/src/features/content
rm -rf features/content
pnpm features && pnpm verify
```

`engagement` depends on it, `alerts` depends on both, and `notifications` depends on `alerts` - all
three have to go too, or keep `content`. `pnpm features --check` names them. The `content_topics`
and `content_pieces` rows stay in the warehouse (nothing drops a table), and `docs/content/` and
`docs/identity/` are untouched - they are the team's files. Remove the nine skills from
`.claude/skills/` by hand; the registries do not know about them.

## Gotchas

- **`approved` arms nothing.** The only armed state is `scheduled`, which always carries an explicit
  `scheduled_at` (`isPublishDue`). This is a scar: a status dropdown once made picking "Approved"
  post publicly within five minutes. Do not add a publisher that fires on `approved`.
- **Move a piece with `content-transition`, not `content-set-status`.** `availableTransitions()` is
  the single source of truth and ships with each row, so the UI renders buttons instead of
  re-deriving the machine. `upsertContent` still enforces `allowedContentTransitions`; the `force`
  escape hatch exists in `ContentInput` and is deliberately not exposed over tRPC/MCP.
- **Verify findings are positional.** A re-verify replaces the array and every tick resets with it.
  That is intended - findings regenerated against an edited draft are new findings.
- **`@Mcp()` inputs must be scalars or arrays with a concrete JSON-schema type**, so lists travel
  comma-separated (`target_channels`, `signal_ids`, `tags`, `requires`) and `metadata` / `findings`
  travel as a JSON string. Both controllers carry a note where this bites.
- **`metadata` deep-merges** on `content-upsert`. Passing only `{"flair": "x"}` keeps `subreddit`
  and `assets`; a key whose value is `null` is deleted.
- **The publishers really send.** `linkedin-publish`, `linkedin-article-publish` and
  `substack-publish` demand `confirm:"true"`; the two scheduled ones dry-run unless their
  `*_PUBLISH_LIVE` env is `1`. The article path drives the author's own browser over CDP - it needs
  a real logged-in profile, not a headless one.
- **A topic auto-closes.** Publishing the last outstanding piece moves a `planned`/`active` topic to
  `done`; a `blocked` or `dropped` topic is a human decision and a publish does not overrule it.
- `index.tsx` sits on the web feature-registry import cycle. Never read a registry binding at module
  scope there, and load the app in a browser after touching it (`CLAUDE.md`) - `pnpm verify` has no
  runtime step.
- After changing either controller, boot once (or run `pnpm typegen`) so `appRouter.d.ts` is
  regenerated, or the web typecheck is stale.
- Dev is Nest **:8190** / Vite **:5190**. Never point a Box or a skill at a port a *different* Box
  may hold: two Boxes a default apart either collide loudly or sit beside each other on different
  address families and get mistaken for one another (`apps/server/src/agent/loopback-guard.ts`).
  A second Box gets its own `PORT` / `BOX_VITE_PORT`.
