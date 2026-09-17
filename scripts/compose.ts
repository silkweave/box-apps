#!/usr/bin/env node
// COMPOSE: make the submodule working tree buildable.
//
// box-apps is the git truth for the ten apps; `box/` is the only tree that installs, builds and
// boots. The four app directory families are MIRRORED into the submodule by a one-way, idempotent
// copy that box's git never sees. Nothing ever writes core files back out of `box/`.
//
// WHY A COPY AND NOT SYMLINKS. The ten apps carry 471 relative imports that reach into core
// (`../../warehouse/db.js`, `../../../auth/auth.guard.js`, `../../feature.js`). Node, Vite, tsgo and
// vitest all realpath by default, so a symlinked app file resolves those against the box-apps root,
// where core does not exist. There is no bare-specifier route to `apps/server/src/feature.ts`, so
// this is unfixable rather than awkward. Symlinking would also defeat the three scanners in
// packages/cli, which filter directory entries with `d.isDirectory()` - false for a symlink.
//
// Mirror files are written 0444 so an absent-minded edit inside `box/` fails instead of being
// silently lost at the next compose. Edit the truth at the box-apps root.

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const box = join(root, 'box')

/** The four directory families, exactly the paths `box adopt` fetches and writes. */
export const FAMILIES = ['packages/core/src/features', 'apps/server/src/features', 'apps/web/src/features', 'features']

/** Entries of `features/` that belong to box-apps itself and are never mirrored. */
const NOT_AN_APP = new Set(['README.md'])

export const appIds = (): string[] =>
  existsSync(join(root, 'features'))
    ? readdirSync(join(root, 'features'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !NOT_AN_APP.has(d.name))
        .map((d) => d.name)
        .sort()
    : []

const git = (args: string[], cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const walk = (dir: string, base = dir): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    return e.isDirectory() ? walk(full, base) : [relative(base, full)]
  })

/** Copy one directory tree onto another, in place, and report what moved. */
const mirrorDir = (src: string, dest: string, stats: { copied: number; unchanged: number; deleted: number }) => {
  const want = new Set(existsSync(src) ? walk(src) : [])
  const have = new Set(existsSync(dest) ? walk(dest) : [])
  for (const rel of have) if (!want.has(rel)) { rmSync(join(dest, rel), { force: true }); stats.deleted++ }
  for (const rel of want) {
    const from = join(src, rel)
    const to = join(dest, rel)
    const a = statSync(from)
    const b = existsSync(to) ? statSync(to) : undefined
    if (b && b.size === a.size && readFileSync(from).equals(readFileSync(to))) { stats.unchanged++; continue }
    mkdirSync(dirname(to), { recursive: true })
    // Write in place (chmod +w, write, chmod -w) so a watcher sees `change`, not unlink+add.
    if (b) chmodSync(to, 0o644)
    cpSync(from, to, { force: true })
    chmodSync(to, 0o444)
    stats.copied++
  }
}

export const mirror = () => {
  const stats = { copied: 0, unchanged: 0, deleted: 0 }
  const ids = appIds()
  for (const family of FAMILIES) {
    for (const id of ids) {
      const src = join(root, family, id)
      if (!existsSync(src)) continue
      mirrorDir(src, join(box, family, id), stats)
    }
    // Remove a mirrored app the truth no longer has.
    const destFamily = join(box, family)
    if (!existsSync(destFamily)) continue
    for (const e of readdirSync(destFamily, { withFileTypes: true })) {
      if (!e.isDirectory() || NOT_AN_APP.has(e.name)) continue
      if (!ids.includes(e.name) || !existsSync(join(root, family, e.name))) {
        rmSync(join(destFamily, e.name), { recursive: true, force: true })
        stats.deleted++
      }
    }
  }
  return stats
}

/**
 * Per-clone submodule setup. None of this is a tracked file of `box`, so none of it can leak
 * upstream; it is re-applied on every compose because a fresh clone has none of it.
 */
export const prepareSubmodule = () => {
  // 1. The mirror must be invisible to box's git, or every `git -C box add -A` during core work
  //    would carry app code into the core-only repo and the CI dirty-guard would never pass.
  const gitDir = git(['rev-parse', '--absolute-git-dir'], box)
  const excludeFile = join(gitDir, 'info', 'exclude')
  const lines = FAMILIES.map((f) => (f === 'features' ? '/features/*/' : `/${f}/`))
  const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
  const missing = lines.filter((l) => !current.split('\n').includes(l))
  if (missing.length) {
    mkdirSync(dirname(excludeFile), { recursive: true })
    writeFileSync(excludeFile, `${current}${current.endsWith('\n') || !current ? '' : '\n'}# box-apps mirror - see scripts/compose.ts\n${missing.join('\n')}\n`)
  }

  // 2. pnpm 11 defaults verifyDepsBeforeRun to `install`: ANY pnpm script whose cwd is inside box/
  //    finds box/pnpm-workspace.yaml as the nearest workspace root and silently installs a SECOND
  //    store there against box's own lockfile, which then fails typecheck with cross-store type
  //    identity errors. Neither .npmrc nor npm_config_* overrides it. Hiding these two files from
  //    the worktree removes box/ as a workspace-root candidate entirely. `git ls-files` still lists
  //    them, so box's own docs-check is unaffected.
  git(['sparse-checkout', 'set', '--no-cone', '/*', '!/pnpm-workspace.yaml', '!/pnpm-lock.yaml'], box)

  // 3. Refuse to push a pointer at a commit the remote does not have.
  git(['config', 'push.recurseSubmodules', 'check'])
}

/** An install that ran from inside box/ poisons the tree; say so by name rather than failing later. */
export const refuseWrongRootInstall = () => {
  for (const marker of ['node_modules/.modules.yaml', 'node_modules/.pnpm']) {
    if (existsSync(join(box, marker))) {
      throw new Error(
        `box/${marker} exists, which means pnpm installed from inside the submodule.\n` +
          '  box-apps is the workspace root; box/ only ever receives member node_modules.\n' +
          '  Fix: rm -rf box/node_modules && pnpm install',
      )
    }
  }
}

/** The workspace settings that must agree, because only box/ has the packages they apply to. */
const SETTINGS = ['allowBuilds', 'minimumReleaseAgeExclude', 'linkWorkspacePackages']

const yamlBlock = (text: string, key: string) => {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`${key}:`))
  if (start === -1) return undefined
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break
    if (lines[i].trim().startsWith('#') || !lines[i].trim()) continue
    out.push(lines[i])
  }
  return out.join('\n')
}

export const checkSettingsDrift = () => {
  const theirs = git(['show', 'HEAD:pnpm-workspace.yaml'], box)
  const ours = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const drifted = SETTINGS.filter((k) => yamlBlock(theirs, k) !== yamlBlock(ours, k))
  if (drifted.length) {
    throw new Error(
      `pnpm-workspace.yaml has drifted from box's for: ${drifted.join(', ')}.\n` +
        "  These settings apply to packages that live in the submodule, so they must match box's copy.\n" +
        '  Copy the blocks across from `git -C box show HEAD:pnpm-workspace.yaml`.',
    )
  }
}

export const compose = () => {
  refuseWrongRootInstall()
  prepareSubmodule()
  checkSettingsDrift()
  return mirror()
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = compose()
  console.log(`compose: ${s.copied} copied, ${s.unchanged} unchanged, ${s.deleted} removed`)
}
