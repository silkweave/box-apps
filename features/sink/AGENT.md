# Installing `sink`

The recipe. Read [`SPEC.md`](./SPEC.md) first for what the feature is; this is how it gets into a
Box and what to change afterwards.

## 1. Install

**The scaffold is the working code**, not a copy of it (see `features/README.md`). `box adopt`
fetches it from the registry at its tag, byte-exact, and rewrites the registries and skill links:

```bash
box registry validate                  # confirm the index offers sink, and at which version
box adopt sink                         # fetches the four directories and anything it dependsOn
pnpm install && pnpm build             # adoption changes package.json; tests resolve via build/
pnpm verify                            # features:check, lint:deps, typegen, typecheck, lint, tests
pnpm schema:check                      # diagnostic, not part of verify: run it after a schema change
```

In this checkout `sink` is already installed; the above is what a fresh Box runs.

**Do not rename the directory.** The name is the migration ledger namespace, and it is the same
string in all three trees. `sink` has no migrations today, but the rule has no exceptions.

Nothing else is edited. If `pnpm features --check` complains about a `dependsOn`, install that
feature first - `sink` has none, so it never will.

## 2. Customise for the team

1. **Nav label and order** - `apps/web/src/features/sink/index.tsx`. Band 700 puts it near the
   bottom of the sidebar; move it if the sink is how this team actually works.
2. **The copy button's command** - `apps/web/src/features/sink/views/SinkView.tsx` offers
   `/ingest-sink <name>`. That skill lives with `content`
   (`features/content/skills/ingest-sink/`) and writes initiatives and pieces. Without `content`
   installed, point the button at whatever this team does with a note instead, or drop it.
3. **Where the notes live** - `<BOX_DATA_DIR>/docs/sink/`, from core's `docsDir()`. Create the
   folder or let the first save create it. `README.md` and any `_`-prefixed name are skipped, so
   `_done/` is the conventional archive.

There is no vocabulary, no env and no table, so there is nothing else to migrate or seed.

## 3. Prove it

```bash
pnpm dev
```

Open `http://localhost:8190/sink`: the queue renders (empty is fine), **New** creates a file,
typing autosaves, **Delete** removes it. Check `<BOX_DATA_DIR>/docs/sink/` afterwards - the file is
really there. The feature's whole contract is that the folder and the view agree.

Agent-side, the same operations are MCP tools: `pnpm cli sink-read`, `sink-save`, `sink-create`,
`sink-delete`.

## 4. Remove

**There is no removal command.** This code is yours: delete the directories, then check that
nothing else in your Box still imports `sink` and prune the npm packages
`features/sink/deps.json` declares that no remaining feature needs.


```bash
rm -rf packages/core/src/features/sink apps/server/src/features/sink apps/web/src/features/sink
pnpm features && pnpm verify
```

No feature depends on `sink`, there are no tables to purge, and `docs/sink/` is left alone - the
notes are the team's, not the feature's.

## Gotchas

- The editor chunk is lazy on purpose. Import `SinkBodyEditorLazy`, never `SinkBodyEditor`, or the
  queue view pulls TipTap in with it.
- Filenames are validated (`^[a-z0-9][a-z0-9._-]*\.md$`) and every path is re-checked to stay under
  `docs/sink/`. If you add an operation, route it through `state.ts`'s helpers rather than building
  a path yourself - that guard is the feature's only security surface.
- `index.tsx` sits on the web feature-registry import cycle. Never read a registry binding at module
  scope there, and load the app in a browser after touching it (`CLAUDE.md`).
