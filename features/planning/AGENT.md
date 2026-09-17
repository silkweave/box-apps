# Installing `planning`

The recipe. Read [`SPEC.md`](./SPEC.md) first for what the feature is; this is how it gets into a
Box and what to change afterwards.

## 1. Install

**The scaffold is the working code**, not a copy of it (see `features/README.md`). `box adopt`
fetches it from the registry at its tag, byte-exact, and rewrites the registries and skill links:

```bash
box registry validate                  # confirm the index offers planning, and at which version
box adopt planning                     # fetches the four directories and anything it dependsOn
pnpm install && pnpm build             # adoption changes package.json; tests resolve via build/
pnpm verify                            # features:check, lint:deps, typegen, typecheck, lint, tests
pnpm schema:check                      # diagnostic, not part of verify: run it after a schema change
```

In this checkout `planning` is already installed; the above is what a fresh Box runs.

**Do not rename the directory.** The name is the migration ledger namespace (`planning:<name>` in
`schema_migrations`) and the id of the signal-hooks registration - and it is the same string in all
three trees. `planning` ships with `migrations: []`, but the rule has no exceptions.

Nothing else is edited. The four tables are baselined with `CREATE TABLE IF NOT EXISTS` on the next
boot; there is nothing to seed by hand. The initiative kind list writes itself to
`<BOX_DATA_DIR>/config/initiative-kinds.json` on first use.

## 2. Customise for the team

Every vocabulary edit below is a plain source edit. **An enum edit needs no migration until a Box
has shipped with the old set** - once rows exist carrying the old value, add a migration that
rewrites those rows, or the enum check on the column will refuse them. `planning` has no
`migrations.ts` yet: create one exporting `MIGRATIONS` (append-only, starting at `001`) and point
the manifest's `migrations` at it.

1. **Statuses** - `packages/core/src/features/planning/types.ts`: `PLANNING_STATUSES` (one list for
   initiatives AND tasks) and `TERMINAL_PLANNING_STATUSES`. Mirror the change in
   `apps/web/src/features/planning/planning-types.ts` (`PLANNING_STATUSES`, `PLANNING_STATUS_META`
   labels and tones) and `apps/web/src/features/planning/components/status.tsx`
   (`PLANNING_STATUS_UI` icons and colors). If `content` is installed, it imports this list - the
   edit reaches content's pieces too.
2. **Sprint statuses** - `SPRINT_STATUSES` in the same `types.ts`, mirrored in
   `apps/web/src/features/planning/sprint-types.ts`. Changing the order changes which tab opens for
   a sprint (`SprintDetailView` picks from the status).
3. **Initiative kinds** - do NOT edit these in code. They are tenant config
   (`<BOX_DATA_DIR>/config/initiative-kinds.json`): open Settings -> **Initiative kinds** in the
   dashboard, or call `pnpm cli initiative-kind-save`. Edit
   `packages/core/src/features/planning/kinds.ts` only to change the SEED
   (`INITIATIVE_KIND_SEED`) before a Box's first write, or `DEFAULT_INITIATIVE_KIND`. An id is
   immutable once created; `oss-pr` is read by name by the derived signal in `state.ts`.
4. **Value levels and priority** - `VALUE_LEVELS` and `PRIORITIES` in `types.ts`. Three priority
   steps and four value buckets are deliberate; widening either is an enum edit, see the note above.
5. **Estimates** - `MIN_TASK_HOURS` / `MAX_TASK_HOURS` / `TASK_HOURS` in `types.ts` (a whole-hour
   scale, clamped not rejected) and the display buckets `EFFORT_HOURS` / `EFFORT_META` /
   `EFFORT_HINT` in `apps/web/src/features/planning/planning-types.ts`. An initiative has no size
   column - `apps/web/src/features/planning/lib/effort.ts` sums its tasks.
6. **Sprint capacity** - `DEFAULT_SPRINT_HOURS` in `types.ts` (5, not 8, and the reason is written
   there) and `UNDER_UTILISATION_RATIO` in `packages/core/src/features/planning/sprints.ts`.
   Weekend handling lives in `capacityOn` / `isWeekend` in the same file.
7. **Check-in buckets** - `CHECKIN_BUCKETS` is declared in TWO places,
   `packages/core/src/features/planning/state.ts` and
   `apps/web/src/features/planning/sprint-types.ts`. Change both or the server will refuse a bucket
   the Board renders.
8. **Nav and settings** - `apps/web/src/features/planning/index.tsx`: labels, icons and order
   (band 200-299). Retitle "Initiatives" to whatever this team calls a body of work.
9. **The derived signal** - `SILKWEAVE_PRS_SIGNAL_ID` and `computeSilkweavePrRows` in
   `packages/core/src/features/planning/state.ts` hard-code `github.silkweave_prs_merged` over the
   `oss-pr` kind. A team that does not do OSS PRs should either repoint this at their own
   kind + signal or delete the hook from `PLANNING_SIGNAL_HOOKS` (and with it the
   `deriveOssPrSignals()` calls in the task mutations).

There is no `env` to set.

## 3. Prove it

```bash
pnpm dev
```

Open `http://localhost:8190/initiatives`: the grid renders (empty is fine). Create an initiative,
give it a kind and at least one bound signal, add a task, drag it to reorder, and open the task at
`http://localhost:8190/initiatives/<initiative>/<task>`. Type into the doc editor - it autosaves,
and the one-line summary under the title on the board becomes the doc's first paragraph. Check
`<BOX_DATA_DIR>/docs/initiatives/<initiative>/<task>.md` on disk: the file is really there.

Then `http://localhost:8190/sprints`: create a sprint, set its dates and per-person availability
on the **design** tab, slot tasks onto days on **planning**, and try to move it to `planned` while a
day is over capacity - it must refuse with a message naming the worst day. On **board**, tick a
stand-up bucket and complete the day.

Open Settings -> **Initiative kinds**: add a lane, then try to delete one that has initiatives in
it - it must refuse.

Agent-side, the same operations are MCP tools:

```bash
pnpm cli initiatives-get
pnpm cli initiative-upsert
pnpm cli task-upsert
pnpm cli task-set-status
pnpm cli doc-read
pnpm cli doc-save
pnpm cli sprint-get
pnpm cli sprint-upsert
pnpm cli initiative-kinds
```

(19 tools in all - see SPEC.md for the full list.)

## 4. Remove

**There is no removal command.** This code is yours: delete the directories, then check that
nothing else in your Box still imports `planning` and prune the npm packages
`features/planning/deps.json` declares that no remaining feature needs.


```bash
rm -rf packages/core/src/features/planning apps/server/src/features/planning apps/web/src/features/planning
pnpm features && pnpm verify
```

**`content` must go too**, and with it `engagement` (depends on `content`), `alerts` (depends on
`planning` and `content` and `engagement`) and `notifications` (depends on `alerts`).
`pnpm features --check` names them. `data` stays, but loses
`github.silkweave_prs_merged`, the binding re-point on a signal rename and the reference guard that
stops one.

The four tables are left in the warehouse - removing a feature does not drop data - and
`<BOX_DATA_DIR>/docs/initiatives/` is untouched. Both are the team's; delete them by hand if that
is really what you want.

## Gotchas

- **`rekeyTask` hand-writes its column list** (`packages/core/src/features/planning/state.ts`). A
  column you add to the `TASKS` ModelSpec and forget there is silently nulled on every task MOVE and
  every RENAME. `models.ts` says so in capitals above `sprint_id` / `slot_date`; believe it.
- **`summary` is derived, not typed.** `savePlanningDoc` is its only writer. Do not add a summary
  input to `taskUpsert` / `initiativeUpsert` - the two-fields-for-one-prose problem is exactly what
  the derivation replaced on 2026-08-24.
- **Doc paths are built only from validated slugs**, then re-checked to stay inside
  `docs/initiatives/` (`docs.ts` `absPath`). If you add an operation on a doc, route it through that
  module rather than joining a path yourself - it is the feature's only filesystem security surface.
- **The MCP tool names `doc-read` and `doc-save` are generic.** They are planning's docs, not the
  Box's docs, and they share the flat MCP namespace with every other feature - `typegen` will fail
  loudly on a collision, but pick a scoped name if you add another doc tool.
- **A sprint delete releases tasks, it does not delete them.** Anything you add that removes a
  window over work must do the same.
- **`index.tsx` sits on the web feature-registry import cycle.** Never read a registry binding at
  module scope there, and load the app in a browser after touching it - `pnpm verify` has no runtime
  step (`CLAUDE.md`).
- **After a controller change, boot once (or `pnpm typegen`)** so `appRouter.d.ts` is rewritten, or
  the web typecheck is stale and the new procedure does not exist as far as the SPA is concerned.
- **Dev ports are Nest 8190 / Vite 5190.** A second Box gets its own `PORT` / `BOX_VITE_PORT` and
  never a neighbour of the first's: two Boxes a default apart either collide loudly or sit beside
  each other on different address families and get mistaken for one another
  (`apps/server/src/agent/loopback-guard.ts`).
