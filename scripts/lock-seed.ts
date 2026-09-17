#!/usr/bin/env node
// Seed this root's pnpm-lock.yaml from box's, so the pair installs box's EXACT pins.
//
// A fresh resolution here is not equivalent: it re-resolves peers and picked typescript@7 for
// @swc-node/register, which has no JS API. Seeding rewrites only the importer keys - `.`,
// `apps/*`, `packages/*` become `box`, `box/apps/*`, `box/packages/*` - and leaves every
// resolution untouched. The root importer's own 27 app packages are then resolved by pnpm against
// what is already pinned (preferred-versions reuse), so there is one react, one typescript.
//
// Run this ONLY when the submodule pointer moves, then `pnpm install`, then commit the lockfile.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { box, root } from './compose.ts'

export const seed = () => {
  const text = execFileSync('git', ['show', 'HEAD:pnpm-lock.yaml'], { cwd: box, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = text.replace(/^(  )(\.|apps\/[^:\s]+|packages\/[^:\s]+):$/gm, (_m, indent: string, key: string) =>
    `${indent}${key === '.' ? 'box' : `box/${key}`}:`,
  )
  writeFileSync(join(root, 'pnpm-lock.yaml'), out)
  return out.split('\n').length
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`lock:seed: wrote pnpm-lock.yaml from box HEAD (${seed()} lines). Run \`pnpm install\` next.`)
}
