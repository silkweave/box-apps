#!/usr/bin/env node
// registry.json: the published index `box adopt` fetches.
//
//   pnpm registry           rewrite it from the truth at this root
//   pnpm registry --check   fail if it is stale, invalid, or promises a tag that does not exist
//
// The generator itself lives in box (packages/cli/src/registry.ts) and is imported, not copied:
// one implementation of the format, in the repo whose CLI has to read it. box's own
// `pnpm registry:check` cannot serve here, because it runs against box's tree, which has no apps.
//
// Three checks box's version cannot make, because only box-apps knows them:
//   - every app's core range must admit the PINNED core, or the pair proves nothing;
//   - every listed version must have its tag in this repo, or adopt fails at the clone for a user;
//   - the tag's own app.json must carry that version, which catches a moved or mistyped tag.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { box, root } from './compose.ts'
import { buildIndex, validateIndex } from '../box/packages/cli/src/registry.ts'
import { coreVerdict } from '../box/packages/cli/src/adopt.ts'

export const REPO = 'https://github.com/silkweave/box-apps.git'

const pinnedCore = (): string => JSON.parse(readFileSync(join(box, 'packages/core/package.json'), 'utf8')).version

const tagsPresent = (): Set<string> => {
  try {
    return new Set(execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean))
  } catch {
    return new Set()
  }
}

const versionAtTag = (tag: string, id: string): string | null => {
  try {
    return JSON.parse(execFileSync('git', ['show', `${tag}:features/${id}/app.json`], { cwd: root, encoding: 'utf8' })).version
  } catch {
    return null
  }
}

export const index = () => buildIndex(root, REPO)

export const problems = (requireTags: boolean) => {
  const idx = index()
  const { errors, warnings } = validateIndex(idx)
  const core = pinnedCore()
  for (const app of idx.apps) {
    const verdict = coreVerdict(core, app.core)
    if (!verdict.ok) errors.push(`${app.id}: the pinned core (${core}) does not satisfy "${app.core}" - ${verdict.reason}`)
  }
  if (requireTags) {
    const tags = tagsPresent()
    for (const app of idx.apps) {
      if (!tags.has(app.tag)) { warnings.push(`${app.id}: no tag ${app.tag} in this repo yet, so \`box adopt ${app.id}\` would fail at the clone`); continue }
      const at = versionAtTag(app.tag, app.id)
      if (at !== app.version) errors.push(`${app.id}: tag ${app.tag} carries version ${at ?? '(no app.json)'}, not ${app.version}`)
    }
  }
  return { idx, errors, warnings }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check')
  const target = join(root, 'registry.json')
  const { idx, errors, warnings } = problems(check)
  for (const w of warnings) console.warn(`  warning: ${w}`)
  if (errors.length) { console.error(errors.map((e) => `  ${e}`).join('\n')); process.exit(1) }
  const next = `${JSON.stringify(idx, null, 2)}\n`
  if (check) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : ''
    // generatedAt moves every day; compare everything else.
    const strip = (t: string) => t.replace(/"generatedAt": "[^"]*"/, '')
    if (strip(current) !== strip(next)) { console.error('  registry.json is stale: run `pnpm registry`'); process.exit(1) }
    console.log(`registry: ${idx.apps.length} apps, valid, core ${pinnedCore()} satisfies every range`)
  } else {
    writeFileSync(target, next)
    console.log(`registry: wrote ${idx.apps.length} apps`)
  }
}
