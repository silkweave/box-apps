// Per-channel content profiles - the constraints the editor surfaces live and that agent-verify
// (/verify-content) checks a piece against. The single source of truth for "what does a good X /
// Reddit / blog piece look like". See features/content/SPEC.md.
//
// `voiceNotes` here is a one-line summary only. The canonical, iterable voice style lives in markdown
// under docs/identity/voice/ (global.md + <channel>.md); /verify-content and /draft-content read those
// directly. Keep these strings short - edit the md files to change house style.
//
// EDITABLE SINCE 2026-08-12. The defaults below are still code, but a tenant may overlay them from
// `config/channel-profiles.json` (Settings → Channels), read at query time like signal-owners.json
// and presets.json. Three calls worth keeping:
//
//   • The file holds OVERLAYS, not whole records - only the keys somebody changed. So a release that
//     adds a field or fixes a default still reaches every tenant, and the diff shows what the TEAM
//     decided rather than a frozen copy of what shipped six months ago.
//   • `channel` and the whole `publish` block are NOT overlayable. Everything else here DESCRIBES
//     the writing; `publish` describes what CODE exists, and no config can conjure a sender. The
//     hazard is specific: `auto` is what the transition set and every confirm dialog key off, so a
//     tenant flipping `auto: true` on a channel with no runner would make the UI promise a send the
//     system will never make - the exact failure `auto` was introduced to prevent.
//   • An unknown channel key in the file is IGNORED rather than becoming a phantom channel: the
//     channel list is a closed vocabulary (ContentChannel), and a typo must not create a profile
//     that nothing renders and no piece can ever use.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { configPath } from '../../io.js'
import type { ContentChannel } from './types.js'

export interface ChannelContentProfile {
  channel: ContentChannel
  /** Display label for the channel. */
  label: string
  /** Shape of the body, which drives the editor (longform/medium → WYSIWYG; thread/short → plain). */
  bodyKind: 'longform' | 'medium' | 'thread' | 'short'
  limits: {
    /** Max chars per unit (per X post, per Reddit/HN title…). */
    perUnitChars?: number
    /** Max title chars. */
    titleChars?: number
    /** [min, max] number of units (e.g. X thread length, blog word target). */
    units?: [number, number]
    /** What `units` counts - informs the editor's counter and verify. */
    unitKind?: 'words' | 'posts' | 'chars'
  }
  /** Channel-specific style beyond the global voice guide. */
  voiceNotes: string
  /** Required metadata/fields a piece must carry to be verifiable (e.g. reddit needs a subreddit). */
  requires: string[]
  /**
   * Recommended (not required) fields that lift reach/quality without gating publish - e.g. reddit
   * `flair` (a missing/wrong required flair gets a post auto-removed, so set it; but the value is
   * per-sub, so we recommend rather than hard-require). Missing → a verify `warn`, never a `fail`.
   */
  recommends?: string[]
  publish: {
    mode: 'workflow' | 'exploration' | 'manual'
    /** The tool/path used (informational; dispatch stays human-gated, record-only for now). */
    tool?: string
    costNote?: string
    gated: true
    /**
     * This channel has a REAL sender wired to the run funnel: arming a piece (scheduling it, or
     * "publish now") makes the machine post it for you. False = nothing is ever sent from here; you
     * post it yourself and record the URL. The transition set + every confirm dialog keys off this,
     * so the UI can never promise a send the system won't make (or hide one it will).
     */
    auto: boolean
  }
}

/** What shipped, before any tenant overlay - the fallback for every field nobody has changed. */
export const CHANNEL_PROFILE_DEFAULTS: Record<ContentChannel, ChannelContentProfile> = {
  blog: {
    channel: 'blog',
    label: 'Blog / article',
    bodyKind: 'longform',
    limits: { units: [800, 2000], unitKind: 'words' },
    voiceNotes: 'Long-form, expansive on the *why*; the canonical source every channel adapts from. See voice/blog.md.',
    requires: ['slug'],
    publish: { mode: 'manual', tool: 'git push to your blog', gated: true, auto: false },
  },
  linkedin: {
    channel: 'linkedin',
    label: 'LinkedIn',
    bodyKind: 'medium',
    limits: { perUnitChars: 3000, units: [1200, 2000], unitKind: 'chars' },
    voiceNotes: 'Company voice: a story with a lesson, shorter than the blog. See voice/linkedin.md.',
    requires: [],
    publish: { mode: 'workflow', tool: 'linkedin-publish (Posts API)', gated: true, auto: true },
  },
  'linkedin-article': {
    channel: 'linkedin-article',
    label: 'LinkedIn newsletter article',
    bodyKind: 'longform',
    limits: { titleChars: 100, units: [2000, 2500], unitKind: 'words' },
    voiceNotes:
      "Newsletter long-form (Dan's Atomic Insights): LinkedIn post energy inside a newsletter structure. See voice/linkedin-article.md.",
    requires: ['author'],
    recommends: ['announcement_text'],
    publish: {
      mode: 'workflow',
      tool: "linkedin-article-publish (full CDP publish in the author's browser: cover, body, announcement post; linkedin-article-draft for a draft-only run)",
      gated: true,
      auto: true,
    },
  },
  reddit: {
    channel: 'reddit',
    label: 'Reddit',
    bodyKind: 'medium',
    limits: { titleChars: 300, units: [200, 600], unitKind: 'words' },
    voiceNotes:
      'Community discussion. Idea-first, product-last; respect per-sub rules; never cross-post identical text. See voice/reddit.md.',
    requires: ['subreddit'],
    recommends: ['flair'],
    // No sender exists: there is no reddit MCP server in `.mcp.json` and `redditLogin` only ever
    // opens the page (ops.ts) - a human types the post themselves. `manual`, like hackernews.
    publish: { mode: 'manual', tool: 'manual (a human posts it; nothing here types)', gated: true, auto: false },
  },
  x: {
    channel: 'x',
    label: 'X',
    bodyKind: 'thread',
    limits: { perUnitChars: 280, units: [3, 9], unitKind: 'posts' },
    voiceNotes: 'Punchy, opinionated, in the moment. An ordered thread (1/ 2/ …). See voice/x.md.',
    requires: [],
    // No write path at all - `twitter-api-v2` was the intended tool and was never wired, so the
    // cost note described a call nothing makes. Manual until a runner exists.
    publish: { mode: 'manual', tool: 'manual (no sender wired; twitter-api-v2 would cost ~$0.015/post)', gated: true, auto: false },
  },
  hackernews: {
    channel: 'hackernews',
    label: 'Hacker News',
    bodyKind: 'short',
    limits: { titleChars: 80 },
    voiceNotes: 'Terse, plain, no marketing. Title + URL or text. See voice/hackernews.md.',
    requires: [],
    publish: { mode: 'manual', tool: 'manual (no write API)', gated: true, auto: false },
  },
  substack: {
    channel: 'substack',
    label: 'Substack newsletter',
    bodyKind: 'longform',
    limits: { titleChars: 120, units: [800, 2500], unitKind: 'words' },
    voiceNotes:
      'Newsletter long-form: the blog piece written for someone who subscribed, so it can assume ' +
      'interest and open on the idea rather than on setup. See voice/substack.md.',
    // `subtitle` is the deck under the title in the reader and the email preview line, and a post
    // without one looks unfinished in the inbox.
    requires: ['subtitle'],
    recommends: ['audience'],
    publish: {
      mode: 'workflow',
      tool: 'substack-publish (private JSON API, session cookie; substack-draft for a draft-only run)',
      costNote: 'emails the list only when metadata.send_email is true',
      gated: true,
      auto: true,
    },
  },
}

/** The channels that have a profile, in display order - the closed vocabulary an overlay is checked
 *  against. */
export const PROFILE_CHANNELS = Object.keys(CHANNEL_PROFILE_DEFAULTS) as ContentChannel[]

/** The fields a tenant may overlay: everything that describes the WRITING. See the header for why
 *  `channel` and `publish` are not here. `undefined` on a key means "keep the default". */
export interface ChannelProfileOverlay {
  label?: string
  bodyKind?: ChannelContentProfile['bodyKind']
  limits?: ChannelContentProfile['limits']
  voiceNotes?: string
  requires?: string[]
  recommends?: string[]
}

/** channel → the keys that tenant changed. Absent channels (and absent keys) use the code default. */
export type ChannelProfilesFile = Partial<Record<ContentChannel, ChannelProfileOverlay>>

export function channelProfilesPath(): string {
  return configPath('channel-profiles.json')
}

const BODY_KINDS: ChannelContentProfile['bodyKind'][] = ['longform', 'medium', 'thread', 'short']
const UNIT_KINDS: NonNullable<ChannelContentProfile['limits']['unitKind']>[] = ['words', 'posts', 'chars']

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A non-empty trimmed string, or undefined - so `""` reads as "not set" rather than as a label. */
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** A positive finite integer, or undefined. A limit of 0 or -1 is not a stricter rule, it is a
 *  mistake that would fail every piece. */
const posInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined

const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? [...new Set(v.flatMap((x) => str(x) ?? []))] : undefined

/** Read one channel's overlay out of raw JSON, dropping anything that is not a field we accept.
 *  Coercion, never rejection: a file hand-edited to nonsense degrades to the shipped default for
 *  that key, which keeps the editor usable while the bad key is found. */
function readOverlay(raw: unknown): ChannelProfileOverlay {
  if (!isRecord(raw)) return {}
  const limitsRaw = isRecord(raw.limits) ? raw.limits : undefined
  const units = Array.isArray(limitsRaw?.units) ? limitsRaw.units : undefined
  const min = posInt(units?.[0])
  const max = posInt(units?.[1])
  const limits: ChannelContentProfile['limits'] | undefined = limitsRaw && {
    ...(posInt(limitsRaw.perUnitChars) !== undefined ? { perUnitChars: posInt(limitsRaw.perUnitChars)! } : {}),
    ...(posInt(limitsRaw.titleChars) !== undefined ? { titleChars: posInt(limitsRaw.titleChars)! } : {}),
    // A range needs BOTH ends and has to be the right way round - a [2000, 800] typo would make
    // every piece simultaneously too short and too long.
    ...(min !== undefined && max !== undefined ? { units: [Math.min(min, max), Math.max(min, max)] as [number, number] } : {}),
    ...(UNIT_KINDS.includes(limitsRaw.unitKind as never) ? { unitKind: limitsRaw.unitKind as 'words' } : {}),
  }
  return {
    ...(str(raw.label) !== undefined ? { label: str(raw.label)! } : {}),
    ...(BODY_KINDS.includes(raw.bodyKind as never) ? { bodyKind: raw.bodyKind as 'medium' } : {}),
    ...(limits ? { limits } : {}),
    ...(str(raw.voiceNotes) !== undefined ? { voiceNotes: str(raw.voiceNotes)! } : {}),
    ...(strList(raw.requires) ? { requires: strList(raw.requires)! } : {}),
    ...(strList(raw.recommends) ? { recommends: strList(raw.recommends)! } : {}),
  }
}

/** Parse the overlay file; a missing one means "nothing overlaid". Malformed JSON throws - a config
 *  file we cannot read is a deploy problem, and silently serving the defaults would hide it. */
export function readChannelProfilesFile(): ChannelProfilesFile {
  const path = channelProfilesPath()
  if (!existsSync(path)) return {}
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(raw)) return {}
  const out: ChannelProfilesFile = {}
  for (const channel of PROFILE_CHANNELS) {
    if (!(channel in raw)) continue
    const overlay = readOverlay(raw[channel])
    if (Object.keys(overlay).length > 0) out[channel] = overlay
  }
  return out
}

/** Pretty-print back to disk (2-space, channels in their display order, trailing newline). A channel
 *  whose overlay is empty is dropped rather than written as `{}` - "back to the default" should look
 *  like the default in the diff. */
export function writeChannelProfilesFile(file: ChannelProfilesFile): void {
  const path = channelProfilesPath()
  mkdirSync(dirname(path), { recursive: true })
  const out: ChannelProfilesFile = {}
  for (const channel of PROFILE_CHANNELS) {
    const overlay = file[channel]
    if (overlay && Object.keys(overlay).length > 0) out[channel] = overlay
  }
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
  cache = null
}

/** Recursively key-sorted, so two objects that differ only in key ORDER compare equal. The defaults
 *  below are hand-written in whatever order read best; a rebuilt overlay is not. */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon)
  if (isRecord(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
  return v
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b))

/**
 * Drop every key that matches what the release ships. An overlay is a record of what the team
 * DECIDED, and a form that posts all six fields on every save would otherwise write the five nobody
 * touched - which would mark them "edited" in the UI, and, worse, freeze them: a later release that
 * improved a default would be silently overridden by a copy of the old one nobody chose.
 */
function pruneToDefaults(channel: ContentChannel, overlay: ChannelProfileOverlay): ChannelProfileOverlay {
  const base = CHANNEL_PROFILE_DEFAULTS[channel] as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  // A key the default does not carry at all (most channels have no `recommends`) compares against
  // `undefined` and is therefore kept - setting one IS the decision.
  for (const [key, value] of Object.entries(overlay)) {
    if (!sameValue(value, base[key])) out[key] = value
  }
  return out as ChannelProfileOverlay
}

export function assertProfileChannel(channel: string): asserts channel is ContentChannel {
  if (!(PROFILE_CHANNELS as string[]).includes(channel)) {
    throw new Error(`unknown channel "${channel}" - one of ${PROFILE_CHANNELS.join(', ')}`)
  }
}

/**
 * Overlay one channel, keeping the keys the caller did not mention. An explicitly `null` value means
 * "back to the shipped default for this key" - distinct from omitting it, which leaves the tenant's
 * current setting alone. Returns the merged profile so a caller never has to re-read to see what it
 * just did.
 */
export function setChannelProfile(
  channel: string,
  patch: Record<keyof ChannelProfileOverlay, unknown>,
): ChannelContentProfile {
  assertProfileChannel(channel)
  const file = readChannelProfilesFile()
  const current: ChannelProfileOverlay = { ...file[channel] }
  // Read the patch through the same coercion as the file, so the tool surface and a hand edit
  // cannot disagree about what a valid overlay is.
  const clean = readOverlay(patch)
  for (const key of ['label', 'bodyKind', 'limits', 'voiceNotes', 'requires', 'recommends'] as const) {
    if (patch[key] === undefined) continue
    if (patch[key] === null) delete current[key]
    else if (clean[key] !== undefined) (current as Record<string, unknown>)[key] = clean[key]
    else throw new Error(`invalid value for "${key}" on channel ${channel}`)
  }
  file[channel] = pruneToDefaults(channel, current)
  writeChannelProfilesFile(file)
  return channelProfile(channel)!
}

/** Drop every overlay for one channel - "reset this channel to what shipped". */
export function resetChannelProfile(channel: string): ChannelContentProfile {
  assertProfileChannel(channel)
  const file = readChannelProfilesFile()
  delete file[channel]
  writeChannelProfilesFile(file)
  return channelProfile(channel)!
}

/** Parsed overlays + the mtime they were read at. `channelProfile` is called per piece on a list of
 *  dozens, so the file is parsed once and re-parsed only when it changes on disk - an agent editing
 *  the JSON directly must still take effect on the next call, the way signal-owners.json does. */
let cache: { mtimeMs: number; file: ChannelProfilesFile } | null = null

function overlays(): ChannelProfilesFile {
  const path = channelProfilesPath()
  const mtimeMs = existsSync(path) ? statSync(path).mtimeMs : 0
  if (cache?.mtimeMs !== mtimeMs) cache = { mtimeMs, file: mtimeMs ? readChannelProfilesFile() : {} }
  return cache.file
}

/** Every profile, tenant overlay applied. */
export function channelProfiles(): Record<ContentChannel, ChannelContentProfile> {
  const file = overlays()
  return Object.fromEntries(
    PROFILE_CHANNELS.map((channel) => {
      const base = CHANNEL_PROFILE_DEFAULTS[channel]
      const o = file[channel]
      // `publish` and `channel` come from the base unconditionally - see the header.
      return [channel, o ? { ...base, ...o, channel, publish: base.publish } : base]
    }),
  ) as Record<ContentChannel, ChannelContentProfile>
}

/** Profile for a channel, tenant overlay applied, or undefined for an unknown one. */
export function channelProfile(channel: string): ChannelContentProfile | undefined {
  if (!(PROFILE_CHANNELS as string[]).includes(channel)) return undefined
  return channelProfiles()[channel as ContentChannel]
}
