#!/usr/bin/env node
// `pnpm verify` for the PAIR. box proves core-only; this proves core plus the ten apps.
//
// It is box's chain with one step replaced and five added, and it deliberately does not shell out
// to box's own `pnpm verify`: two of box's steps cannot pass here by design.
//   - box no longer has a `registry:check` at all: a Box reads an index and never publishes one,
//     so generating and checking it is this repo's job (scripts/registry.ts, using box's buildIndex).
//   - `deps:check` rule 1 wants each app's specs in box/<tree>/package.json, where box-apps must
//     never write them; it reports 52 failures. scripts/deps.ts checks the same property against
//     the place the specs actually live, and adds the rule box cannot see (rule 3').
//
// Turbo is not used. Its hashing is git-based and cannot see the mirrored app files inside the
// submodule, so a cache hit would be a false green.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { box, compose, root } from './compose.ts'

/**
 * box's verify chain as of the pinned commit. If box gains a step, this string stops matching and
 * box-apps fails until someone mirrors the new step into the list below. A silent divergence here
 * is how the second gate quietly stops proving anything.
 */
const BOX_VERIFY =
  'pnpm features && pnpm skills && pnpm docs:check && pnpm test:cli && pnpm lint:deps && pnpm deps:check && pnpm typegen && pnpm typecheck && pnpm lint && pnpm -F @silkweave/box-core test && pnpm -F @silkweave/box-server test'

const bin = join(box, 'node_modules', '.bin')
const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }

const run = (label: string, command: string, extraEnv: Record<string, string> = {}) => {
  process.stdout.write(`\n\x1b[1m-> ${label}\x1b[0m\n`)
  execFileSync('sh', ['-c', command], { cwd: root, env: { ...env, ...extraEnv }, stdio: 'inherit' })
}

const checkChainDrift = () => {
  const theirs = JSON.parse(execFileSync('git', ['show', 'HEAD:package.json'], { cwd: box, encoding: 'utf8' })).scripts.verify
  if (theirs !== BOX_VERIFY) {
    throw new Error(
      "box's own verify chain has changed since this pair was written:\n" +
        `  box:  ${theirs}\n  here: ${BOX_VERIFY}\n` +
        '  Mirror the new step into scripts/verify.ts and update BOX_VERIFY.',
    )
  }
}

/**
 * Tests resolve core and provider-kit through `build/`, exactly as they do in box: the packages'
 * exports map the `@silkweave/box-source` condition to src and everything else to build. Without a
 * build, fourteen core test FILES fail to import with "Failed to resolve entry for package
 * @silkweave/box-provider-kit" while the 552 tests that did load still pass, which reads like a
 * resolution bug rather than a missing step.
 */
const requireBuilds = () => {
  const missing = ['packages/provider-kit', 'packages/core'].filter((p) => !existsSync(join(box, p, 'build')))
  if (missing.length) throw new Error(`${missing.join(' and ')} ${missing.length === 1 ? 'has' : 'have'} no build/. Run \`pnpm build\` first.`)
}

const scratch = mkdtempSync(join(tmpdir(), 'box-apps-schema-'))
try {
  const s = compose()
  console.log(`compose: ${s.copied} copied, ${s.unchanged} unchanged, ${s.deleted} removed`)
  checkChainDrift()
  requireBuilds()
  run('guard', 'node scripts/guard.ts')
  run('features + skills', 'node box/packages/cli/src/features.ts && node box/packages/cli/src/skills.ts')
  run('registry', 'node scripts/registry.ts --check')
  run('deps', 'node scripts/deps.ts --check')
  run('docs-check', 'node box/packages/cli/src/docs-check.ts')
  // From inside box/: several of these resolve fixtures relative to cwd and expect a Box root.
  // `node` has no workspace-root opinion, so cwd inside the submodule is safe here; `pnpm` is not.
  run('cli tests', 'cd box && node --test packages/cli/src/tests/*.test.ts')
  run('lint-deps', 'node box/packages/cli/src/lint-deps.ts')
  run('typegen', 'pnpm -F silkweave-box run typegen')
  run('typecheck', "pnpm -r --filter '@silkweave/box-*' run typecheck")
  // Lint the TRUTH at this root, and only it. Adding `box` as an argument lints every app file a
  // second time at its mirror path, and --ignore-pattern does not fix it: with `box` in the
  // argument list oxlint stopped linting the root trees altogether. Core's own source is linted by
  // box's verify in box's repo, on the very commit this pair pins, so there is nothing to re-prove.
  run('lint', 'oxlint -c box/oxlint.json packages apps')
  run('core tests', 'pnpm -F @silkweave/box-core run test')
  run('server tests', 'pnpm -F @silkweave/box-server run test')
  run('schema:check', 'pnpm -F silkweave-box run schema:check', { BOX_DATA_DIR: scratch, AUTOMATION_ENABLED: 'false', CHAT_AGENT_ENABLED: 'false' })
  run('guard (again)', 'node scripts/guard.ts')
  console.log('\n\x1b[32mverify: the pair is green\x1b[0m')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
