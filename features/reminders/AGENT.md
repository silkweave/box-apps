# Installing `reminders`

The recipe. Read [`SPEC.md`](./SPEC.md) first for what the app is; this is how it gets into a Box
and what to change afterwards.

## 1. Install

**The scaffold is the working code**, not a copy of it (see `features/README.md`). `box adopt`
fetches it from the registry at its tag, byte-exact, and rewrites the registries and skill links:

```bash
box registry validate                  # confirm the index offers reminders, and at which version
box adopt reminders                    # fetches the four directories; this app dependsOn nothing
pnpm install && pnpm build             # adoption can change package.json; tests resolve via build/
pnpm verify                            # features:check, lint:deps, typegen, typecheck, lint, tests
pnpm schema:check                      # diagnostic, not part of verify: run it after a schema change
```

`reminders` declares no npm dependencies, so `pnpm install` will usually be a no-op here. Run it
anyway - `box adopt` rewrites manifests, and a stale lockfile is not worth the thirty seconds saved.

**Do not rename the directory.** `reminders` is the migration ledger namespace, and it is the same
string in all three trees and in the table's owning manifest.

## 2. Customise for the team

The app is small on purpose; the interesting edits are all additions.

1. **Make it fire.** Out of the box a reminder is remembered, not delivered. The wiring is an
   `ActionSpec` in `packages/core/src/features/reminders/` that selects
   `due_at <= now() AND done_at IS NULL`, routes each row through `alerts`, and stamps `done_at` (or
   a new `fired_at`); `automation` then schedules it. It is not shipped because it would make a
   one-table app depend on three others.
2. **Recurrence** - a `repeat` column plus a re-arm inside `setReminderDone`. Add it as migration
   `001-repeat` in `manifest.ts`; do not edit the `ModelSpec` alone, or a Box that has already
   booted never gets the column.
3. **An owner** - an `assignee` column, a `UserPicker` in the row, a "mine" filter. `created_by` /
   `updated_by` are already there and answer a different question (who typed it, not whose it is).
4. **Nav label and order** - `apps/web/src/features/reminders/index.tsx`, band 750.
5. **The due field** - `views/RemindersView.tsx` splits it into core's `DateInput` and an `HH:MM`
   text input. If your Box gains a real date-time field in `@silkweave/box-ui`, replace both with it
   and delete `toIso`/`fromIso`.

## 3. Prove it

```bash
pnpm dev
```

Open `http://localhost:8190/reminders`: add one, and it appears with a relative due time; tick it,
and it moves down to **Done**; untick it, and it comes back; delete it, and it goes. An overdue open
reminder renders its time in the danger colour.

Then prove the other half of the seam - the same four operations are MCP tools:

```bash
pnpm cli reminder-upsert --title 'Renew the domain' --due-at 2026-10-01T09:00:00Z
pnpm cli reminders-list
pnpm cli reminder-done --id <id> --done        # --no-done reopens it
pnpm cli reminder-delete --id <id>
```

Two things about the proxy that are easy to get wrong: it **kebab-cases** every input field, so the
flag for `due_at` is `--due-at`; and a boolean is a PRESENCE flag, so it is `--done` / `--no-done`,
never `--done true`. Set `BOX_MCP_TOKEN` to the access token of the user you are acting as.

With the dashboard open while you run these, the list updates without a refresh: the web store is
registered on `table:reminders` and the record layer emits on every write. That round trip is the
whole point of the app - if it holds, the seam is wired correctly.

## 4. Remove

**There is no removal command.** This code is yours: delete the directories, then check that
nothing else in your Box imports `reminders`.

```bash
rm -rf packages/core/src/features/reminders apps/server/src/features/reminders apps/web/src/features/reminders
pnpm features && pnpm verify
```

No app in the registry depends on `reminders`, and it declares no npm packages to prune. The
`reminders` TABLE is left behind - core never drops a table it once created. Drop it by hand when
the rows are genuinely unwanted, after a `pnpm db:backup`.

## Gotchas

- **`state.ts` has no SQL, and should not gain any.** The record layer owns the naive-UTC ↔ ISO-Z
  convention, the audit stamp and the `table:reminders` change-feed emit. A hand-written `INSERT`
  here would silently drop all three, and the dashboard would stop updating itself.
- **`done_at` is the status.** Do not add a `status` enum beside it. Two columns for one fact
  disagree the first time one of them is set.
- **`due_at` is required on create and merged on update.** `upsertRecord` keeps the previous value
  for any column the input omits, so a partial update that forgets `due_at` is correct, not a bug.
- `index.tsx` sits on the web feature-registry import cycle. Never read a registry binding at module
  scope there, and load the app in a browser after touching it (`CLAUDE.md`).
