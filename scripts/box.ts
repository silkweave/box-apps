#!/usr/bin/env node
// `pnpm box <verb> ...` - the `box` command line, pointed at THIS pair's Box.
//
//   pnpm box auth reveal nova          re-print a token on box/data
//   pnpm box db backup                 back up box/data/data.db
//   pnpm box reminders-list            anything unrecognised is an MCP tool
//   pnpm box where                     which Box this acts on, and why
//
// WHY IT EXISTS, NOW THAT `box` ITSELF RESOLVES THIS PAIR CORRECTLY. The shim in `~/.local/bin/box`
// belongs to whichever checkout ran `pnpm box:install` - here, the maintainer's own Box. Standing
// in box-apps there is no Box above you (this root holds app SOURCE under `apps/server/`, not a
// server package), so `box` falls back to the checkout that registered it and says so. That is the
// right answer for a shim and the wrong Box for this repo, whose Box is the submodule. This script
// removes the ambiguity: it runs the SUBMODULE's CLI, with the submodule as cwd and as
// BOX_INVOKED_FROM, so the target is never in question.
//
// It is a pass-through, not a mirror: every verb, flag and MCP tool is box's own, and a verb added
// there works here the day the pin moves. Before 2026-09-18 this had to duplicate box's routing
// table, because `isBoxRoot` tested `pnpm-workspace.yaml` - which box-apps has and the submodule
// (sparse-checkout) does not - so no environment could point box's CLI at the right tree.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { box } from './compose.ts'

const die = (msg: string): never => {
  console.error(`[pnpm box] ${msg}`)
  process.exit(1)
}

const argv = process.argv.slice(2)

// Refused rather than passed through: `box adopt` writes an app's four directories into the Box it
// targets, which here is the submodule - the one tree app code must never land in. This repo
// PUBLISHES apps; adopting is what a consuming Box does with what it publishes. (CLAUDE.md.)
if (argv[0] === 'adopt') {
  die('`adopt` is not available here: box-apps publishes apps, it never adopts them. Run it in the adopting Box.')
}

const cli = join(box, 'packages/cli/src/index.ts')
if (!existsSync(cli)) die(`${cli} is missing - run \`git submodule update --init\` first`)

const res = spawnSync(process.execPath, [cli, ...argv], {
  cwd: box,
  // The CLI walks up from here for its target. Pointing it at the submodule is the whole job.
  env: { ...process.env, BOX_INVOKED_FROM: box },
  stdio: 'inherit',
})
process.exit(res.status ?? 1)
