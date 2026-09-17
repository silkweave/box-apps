#!/usr/bin/env node
// The submodule guard. Everything here fails the pair loudly rather than letting it drift.
//
// The classic submodule failure modes are a dirty working tree and a forgotten pointer bump, and
// both are silent: the pair builds locally off a commit nobody else can fetch. On top of those,
// this pair has one of its own - the root lockfile is SEEDED from box's, so a pointer bump that
// changes box's pins leaves the root resolving the old ones until someone re-seeds.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { box, root } from './compose.ts'

/**
 * box's default branch. It is `core-only` until Session 6 promotes that line onto `master`; this
 * constant and .gitmodules' `branch =` are the two places that have to move together.
 */
export const BOX_DEFAULT_BRANCH = 'core-only'

const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const tryGit = (args: string[], cwd: string) => { try { return git(args, cwd) } catch { return null } }

/** The importers box owns, paired with where they live under this root. */
const importerPairs = (theirLock: string): [string, string][] =>
  [...theirLock.matchAll(/^ {2}(\.|apps\/[^:\s]+|packages\/[^:\s]+):$/gm)]
    .map((m) => m[1])
    .map((key) => [key, key === '.' ? 'box' : `box/${key}`] as [string, string])

/** specifier -> resolved version, for one importer block of a lockfile. */
const importerResolutions = (text: string, key: string): Map<string, string> => {
  const out = new Map<string, string>()
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === `  ${key}:`)
  if (start === -1) return out
  let name: string | null = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^ {0,2}\S/.test(line)) break
    const dep = /^ {6}'?([^':\s]+)'?:$/.exec(line)
    if (dep) { name = dep[1]; continue }
    const version = /^ {8}version: (\S+)$/.exec(line)
    // Strip pnpm's peer-suffix: `3.27.1(react@19.2.7)` is the same release as `3.27.1`.
    if (version && name) { out.set(name, version[1].replace(/\(.*$/, '')); name = null }
  }
  return out
}

export const checks = (offline = false) => {
  const problems: string[] = []

  const dirty = git(['status', '--porcelain'], box)
  if (dirty) {
    problems.push(
      `the submodule has uncommitted changes:\n${dirty.split('\n').map((l) => `      ${l}`).join('\n')}\n` +
        '    Core edits belong in box: commit and push them there, then bump the pointer here.',
    )
  }

  const head = git(['rev-parse', 'HEAD'], box)
  if (!offline) {
    tryGit(['fetch', '--quiet', 'origin', BOX_DEFAULT_BRANCH], box)
    const ancestor = tryGit(['merge-base', '--is-ancestor', head, `origin/${BOX_DEFAULT_BRANCH}`], box)
    if (ancestor === null) {
      problems.push(
        `the pinned core commit ${head.slice(0, 7)} is not an ancestor of box's origin/${BOX_DEFAULT_BRANCH}.\n` +
          '    Push the core commit to box first; a pin nobody can fetch is a broken clone for everyone else.',
      )
    }
  }

  // The sharp question is not whether two copies of a transitive package exist - pnpm's tree has
  // duplicates by design, and box's own lockfile already carries two lucide-react - but whether a
  // package in the submodule RESOLVES DIFFERENTLY here than it does in box. Compare the importer
  // blocks: box's `apps/web` against this root's `box/apps/web`, and so on. A mismatch means the
  // seeded lockfile has drifted and box/apps/web is building against versions box never tested.
  const theirLock = git(['show', 'HEAD:pnpm-lock.yaml'], box)
  const ourLock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  for (const [theirKey, ourKey] of importerPairs(theirLock)) {
    const a = importerResolutions(theirLock, theirKey)
    const b = importerResolutions(ourLock, ourKey)
    for (const [name, version] of a) {
      const mine = b.get(name)
      if (mine === undefined) problems.push(`${ourKey} no longer resolves ${name}, which box pins at ${version}`)
      else if (mine !== version) {
        problems.push(
          `${ourKey} resolves ${name} to ${mine}, but box pins ${version}.\n` +
            '    The root lockfile is seeded from box\'s: run `pnpm lock:seed && pnpm install` and commit it.',
        )
      }
    }
  }

  return { head, problems }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { head, problems } = checks(process.argv.includes('--offline'))
  if (problems.length) { console.error(problems.map((p) => `  ${p}`).join('\n')); process.exit(1) }
  console.log(`guard: submodule clean at ${head.slice(0, 7)}, on origin/${BOX_DEFAULT_BRANCH}, lockfile in step with box`)
}
