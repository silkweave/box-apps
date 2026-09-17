// The Reddit topic radar's listening list - which subreddits this Box scans, and which words make a
// thread worth a reply. Configuration since 2026-09-14, not a TypeScript constant.
//
// It was two arrays at the top of pulls/reddit.ts: eight subreddits and nineteen keywords, both the
// AUTHOR's. Every Box that ran the radar scanned one company's target communities for that same
// company's product keywords, and stamped those subs into the snapshot it stored. Unlike npm this
// path is dormant for a field tester (the radar needs the stealth-browser gateway, which this repo
// does not ship), but shipped product should not name one team's competitors and keywords, and the
// day the gateway lands it would be the npm bug again.
//
// Shape follows npm-packages.json, which follows accounts.json: a plain declared list that is EMPTY
// by default, with no seed and no `seeded` flag. There is no subreddit every Box wants to watch and
// no keyword every Box wants to hear, an empty list is the correct state for a team that is not
// listening yet, and the only seed available would be somebody else's targets - which is the bug.
//
// Keys and list entries starting with `_` are notes, never subs or topics. Reddit forbids a
// subreddit name starting with `_`, so the namespace is free for the same reason npm's is, and it is
// what lets docs/examples/reddit-radar.json document itself in keys the parser skips.

import { existsSync, readFileSync } from 'node:fs'
import { configPath } from '../../io.js'

export interface RedditRadarFile {
  /** Subreddit names WITHOUT the `r/` prefix ('typescript', not '/r/typescript'). */
  subs: string[]
  /**
   * Words and phrases that make a thread on-topic. Matched whole-word, case-insensitively, against
   * a post's title + selftext; a post matching none of them is not a candidate.
   */
  topics: string[]
}

export function redditRadarPath(): string {
  return configPath('reddit-radar.json')
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Normalise one declared list. Anything unusable is DROPPED rather than throwing: a typo in one
 * entry must not take out the other seven, and the pull's log line reports what it ended up with.
 * Dropped: non-strings, blank strings, `_`-prefixed doc notes, and duplicates (first occurrence
 * wins, so the file's own order is preserved).
 */
function readList(raw: unknown, clean: (s: string) => string): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    if (entry.trim().startsWith('_')) continue
    const value = clean(entry)
    if (!value) continue
    if (!out.some((v) => v.toLowerCase() === value.toLowerCase())) out.push(value)
  }
  return out
}

/**
 * Tolerate the three ways a person writes a subreddit down - `typescript`, `r/typescript`,
 * `/r/typescript` - and keep the bare name, which is what the JSON endpoint paths are built from.
 */
const cleanSub = (s: string): string => s.trim().replace(/^\/?r\//i, '').replace(/\/+$/, '').trim()

/** Topics are matched as words, so collapse inner whitespace but otherwise keep them verbatim. */
const cleanTopic = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Parse the parsed-JSON body of config/reddit-radar.json. Pure, so it is the thing the tests drive.
 * Anything unrecognised - including every `_`-prefixed doc key - is ignored.
 */
export function parseRedditRadar(raw: unknown): RedditRadarFile {
  if (!isRecord(raw)) return { subs: [], topics: [] }
  return { subs: readList(raw.subs, cleanSub), topics: readList(raw.topics, cleanTopic) }
}

/** Read config/reddit-radar.json. A missing or unreadable file means "nothing configured". */
export function readRedditRadar(): RedditRadarFile {
  const file = redditRadarPath()
  if (!existsSync(file)) return { subs: [], topics: [] }
  try {
    return parseRedditRadar(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // Malformed JSON is the same outcome as no file: the pull declines and says where to look.
    return { subs: [], topics: [] }
  }
}

/**
 * A scan needs BOTH halves: subs with no topics matches nothing, topics with no subs has nowhere to
 * look. Either half empty means the radar has nothing to do.
 */
export function redditRadarConfigured(cfg: RedditRadarFile): boolean {
  return cfg.subs.length > 0 && cfg.topics.length > 0
}

/** The one line the radar prints when it has no listening list. */
export const REDDIT_RADAR_NOT_CONFIGURED =
  `no subreddits/topics configured - add them to config/reddit-radar.json ` +
  `(see docs/examples/reddit-radar.json)`
