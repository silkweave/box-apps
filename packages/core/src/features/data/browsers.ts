// config/browsers.json - users.id → the chromatrix IDENTITY whose persistent, human-logged-in
// headed Chrome belongs to that person. Committed and non-secret (identities are names, not
// endpoints), read at call time like accounts.json, so edits apply without a restart.
// The engagement verify op uses this to answer "whose browser do I ask" for a card's user_id -
// see features/data/SPEC.md.
//
// This used to map to a fixed per-teammate CDP URL (one debugging port each). chromatrix replaced
// that: there are no stable ports any more, because a tab is leased per job and its CDP URL is
// minted per lease. See features/data/SPEC.md.

import { existsSync, readFileSync } from 'node:fs'
import { configPath } from '../../io.js'

/** users.id → chromatrix identity (the name that person's headed Chrome is registered under). */
export type BrowsersFile = Record<string, string>

export function browsersPath(): string {
  return configPath('browsers.json')
}

/** Parse config/browsers.json; `_`-prefixed keys are doc notes. A missing file means no browsers. */
export function readBrowsersFile(): BrowsersFile {
  const file = browsersPath()
  if (!existsSync(file)) return {}
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const out: BrowsersFile = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('_') && typeof value === 'string' && value) out[key] = value
  }
  return out
}

/** The chromatrix identity backing a user's own headed Chrome, or null when none is declared. */
export function browserIdentity(userId: string): string | null {
  return readBrowsersFile()[userId] ?? null
}
