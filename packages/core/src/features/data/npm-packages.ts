// The npm package list - which packages this Box counts downloads for. Configuration since
// 2026-09-14, not a TypeScript constant.
//
// It was fifteen `@silkweave/*` names plus `keybridge` hardcoded in pulls/npm.ts. npm's download
// endpoint needs no credential, so it is one of the very few pulls that works on a Box's first day -
// which meant the first thing a stranger's Box did was import the AUTHOR's download statistics and
// register them as that team's signals. The list is the team's, so it lives in the team's config
// directory.
//
// Shape follows config/accounts.json, NOT config/initiative-kinds.json: a plain declared list that
// is EMPTY by default, with no seed and no `seeded` flag. The kinds pattern earns its seed because
// a board with no lanes cannot be used at all, so shipping ten and letting you delete them is a
// kindness. A package list has no such floor - there is no package every Box wants, an empty list
// is the correct state for a team that publishes nothing, and the only seed available would be
// somebody else's packages, which is the bug being fixed. So: absent file, or empty list, means
// "this Box tracks no packages" and the pull says so and stops.
//
// Keys and list entries starting with `_` are notes, never packages. npm forbids a package name
// starting with `_`, so the namespace is free, and it is what lets docs/examples/npm-packages.json
// document itself in keys the parser skips.

import { existsSync, readFileSync } from 'node:fs'
import { configPath } from '../../io.js'

export interface NpmPackagesFile {
  /**
   * Packages that feed the all-package aggregate (`npm.week` / `npm.month`) and compete for the
   * top-N per-package signal. A product line: the sum over them means something.
   */
  packages: string[]
  /**
   * Packages tracked standalone: each ALWAYS gets its own `npm.pkg.<name>` signal, never gated on
   * the top-N cut, and they do NOT fold into the aggregate. For a package whose launch you want
   * measurable from day one even though it is not part of the line.
   */
  tracked: string[]
}

export function npmPackagesPath(): string {
  return configPath('npm-packages.json')
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Normalise one declared list. Anything that is not a usable package name is DROPPED rather than
 * throwing: a typo in one entry must not take out the other fourteen, and the pull's log line
 * reports the count it ended up with. Dropped: non-strings, blank strings, `_`-prefixed doc notes,
 * and duplicates (first occurrence wins, so the file's own order is preserved).
 */
function readList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const name = entry.trim()
    if (!name || name.startsWith('_')) continue
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/**
 * Parse the parsed-JSON body of config/npm-packages.json. Pure, so it is the thing the tests drive.
 * Anything unrecognised - including every `_`-prefixed doc key - is ignored.
 */
export function parseNpmPackages(raw: unknown): NpmPackagesFile {
  if (!isRecord(raw)) return { packages: [], tracked: [] }
  const tracked = readList(raw.tracked)
  // A name in both lists would be counted twice and register the same signal from two paths;
  // `tracked` wins, because its promise (always its own signal) is the stronger one.
  const packages = readList(raw.packages).filter((p) => !tracked.includes(p))
  return { packages, tracked }
}

/** Read config/npm-packages.json. A missing or unreadable file means "no packages configured". */
export function readNpmPackages(): NpmPackagesFile {
  const file = npmPackagesPath()
  if (!existsSync(file)) return { packages: [], tracked: [] }
  try {
    return parseNpmPackages(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // Malformed JSON is the same outcome as no file: the pull declines and says where to look.
    return { packages: [], tracked: [] }
  }
}

/** Every package this Box touches, aggregate list first. Empty means the npm pull has nothing to do. */
export function allNpmPackages(): string[] {
  const { packages, tracked } = readNpmPackages()
  return [...packages, ...tracked]
}

/** The one line every npm entry point prints when nothing is configured. */
export const NPM_NOT_CONFIGURED = `no npm packages configured - add them to config/npm-packages.json (see docs/examples/npm-packages.json)`
