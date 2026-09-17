# AGENTS.md - Silkweave Box apps

`CLAUDE.md` is a symlink to this file. Keep one set of instructions; never replace it with a copy.

This repository holds the ten reference apps for [Silkweave Box](https://github.com/silkweave/box)
and publishes `registry.json`, the index `box adopt` reads. The foundation itself is not here: it is
pinned as the submodule `box/`.

Clone it with its submodule, always:

```bash
git clone --recurse-submodules https://github.com/silkweave/box-apps.git
cd box-apps && pnpm install && pnpm build && pnpm verify
```

## The shape, and the one thing to understand first

**This root is the git truth for the apps. `box/` is the only tree that builds.** The four app
directory families are MIRRORED into the submodule by `scripts/compose.ts`, a one-way idempotent
copy that box's git never sees (per-clone `.git/info/exclude`), with mirror files written `0444`.

```text
box-apps/
  box/                              submodule: silkweave/box, pinned. Builds, boots, holds node_modules.
    packages/core/src/features/<id> mirror, git-excluded, read-only
    apps/server/src/features/<id>   mirror
    apps/web/src/features/<id>      mirror
    features/<id>                   mirror
  packages/core/src/features/<id>   TRUTH. Edit here.
  apps/server/src/features/<id>     TRUTH
  apps/web/src/features/<id>        TRUTH
  features/<id>                     TRUTH: SPEC.md, AGENT.md, CHANGELOG.md, app.json, deps.json, skills/
  registry.json                     generated and tracked; the published index
  package.json                      generated: the apps' npm dependencies (see below)
  scripts/                          this repo's own tooling
```

**Edit the truth at this root, never the copy inside `box/`.** The copy is read-only and is
overwritten on the next compose. `rg` and agent search are kept off it by `.ignore`.

Symlinking instead of copying is not an option and was measured, not assumed: the apps carry 471
relative imports that reach into core (`../../warehouse/db.js`, `../../feature.js`). Node, Vite,
tsgo and vitest all realpath, so a symlinked app file resolves those against this root, where core
does not exist. Three scanners in `box/packages/cli` also filter with `d.isDirectory()`, which is
false for a symlink, so the apps would silently vanish rather than fail.

## The dev loop

Core is canonical in `box`. Sync is **one direction only**. Nothing here ever writes core files.

- **Change an app.** Edit at this root. `pnpm dev` composes, watches the four families and runs the
  server and web dev servers. `pnpm verify`. Commit at the root as normal.
- **Fix core while doing it.** `cd box && git switch <branch>` (a fresh clone is detached at the
  pin), edit, test from this root so all ten apps exercise the change, then commit and push it to
  `box`. Back at the root: `git add box && git commit`. `push.recurseSubmodules=check` is set by
  compose and refuses to push a pointer at a commit the remote does not have. If box's lockfile
  moved, `pnpm lock:seed && pnpm install` and commit the root lockfile.
- **Release an app.** `pnpm release <id> <version>` bumps `app.json`, requires a `## <version>`
  section in the app's `CHANGELOG.md`, regenerates `registry.json`, commits and writes the annotated
  tag `<id>-v<version>`. Then `git push origin master <id>-v<version>`.
  **Never move a published tag**; it is what users fetch. Cut the next version instead.

## Rules

- **Never edit anything inside `box/` except core itself, and never commit app code to `box`.**
- **Never write the submodule's `package.json` files.** The apps' npm dependencies are declared in
  `features/<id>/deps.json` and generated onto THIS root's manifest by `scripts/deps.ts`. They
  resolve from `box/...` up to this root. `box adopt` writes the same specs into an adopting Box's
  own manifests, which that Box owns: two projections of one declared source.
- **Do not add box's toolchain to this manifest.** A fresh resolution picked `typescript@7` for
  `@swc-node/register`, which has no JS API, and typegen, `schema:check` and five server tests died
  with `Cannot read properties of undefined (reading 'Js')`. Scripts prepend
  `box/node_modules/.bin` to `PATH` instead.
- **Never run `pnpm` with a cwd inside `box/`.** pnpm 11 defaults `verifyDepsBeforeRun` to
  `install`; it would find a second workspace root and build a second store. `compose` hides
  `box/pnpm-workspace.yaml` and `box/pnpm-lock.yaml` with sparse-checkout to make that impossible,
  and refuses to run if `box/node_modules/.pnpm` already exists. `node` is safe there.
- **Do not `pnpm box:install` from this checkout.** The `box` shim would resolve this root as the
  Box. Use the root's delegating scripts instead.
- An app's core range in `features/<id>/app.json` is a promise to users: tighten it to what the app
  actually supports, and remember core takes a MAJOR for a breaking change with no downstream fix.
- Never use em-dashes (U+2014). Use absolute dates such as `2026-09-17`.

## Checks

`pnpm install && pnpm build && pnpm verify`. The build is required before verify, exactly as in
box: tests resolve core and provider-kit through `build/`.

`pnpm verify` is box's chain with two steps replaced and four added. `registry:check` and
`deps:check` are replaced because box's versions run against box's own tree, which has no apps and
whose manifests must stay unwritten. Added: `compose`, `guard`, the pinned-core-satisfies-every-range
check, and rule 3' (an app importing a package it does not declare, which works here and breaks on a
Box that adopts only that app).

`pnpm guard` is the submodule guard and runs twice inside verify: submodule clean, pin an ancestor
of box's default branch, and every importer in the submodule resolving exactly what box's own
lockfile pins.

Turbo is deliberately unused here: its hashing is git-based and cannot see the mirrored files, so a
cache hit would be a false green.
