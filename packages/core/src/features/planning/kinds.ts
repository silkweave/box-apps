// The initiative KIND list - the board's primary grouping axis, and since 2026-08-28 tenant
// configuration rather than a TypeScript union.
//
// It was ten hardcoded strings in three places (the core union, the SPA's mirror, and KIND_AREA /
// KIND_LABEL which existed only in the SPA), so adding a lane to the board the company plans its
// work on meant a code change, a typecheck and a deploy. The list is vocabulary, and vocabulary is
// the team's - it now lives in config/initiative-kinds.json beside presets.json and
// signal-owners.json, for the same reasons: it wants a diff and a git history rather than audit rows
// in the warehouse, and it travels with the Box's config directory, which is version-controlled (data.db is not).
//
// The ten built-ins survive as a SEED, not as a floor - the same call presets made. `seeded` (not a
// non-empty list) is what stops the seed running again, so deleting a lane STAYS deleted instead of
// being helpfully undone by the next read. The first write is what seeds the file.
//
// There is no manual ordering and no coarser bucket above a kind: the list is a flat set sorted BY
// LABEL, everywhere it is rendered. (An `area` field - growth / product / company - existed for one
// day, 2026-08-28. It bought a single "Group: Area" option nobody's preset used, duplicated what the
// Product / Growth / Business presets already do with explicit kind sets, and charged every new lane
// a bucket assignment for the privilege.) A hand-kept
// order is a fourth thing to maintain for a list this short, and "find the lane called X" is the
// only question anybody actually asks of it - alphabetical answers that without anyone curating it.
//
// An id is IMMUTABLE once created. It is the string stored on every initiative row, and one
// derivation (`github.silkweave_prs_merged`, planning/state.ts) plus the board's built-in presets
// read specific ids - so a rename would be a silent data migration wearing a settings control.
// Label and icon are editable; deleting is guarded by "no initiative uses it"
// (planning/state.ts), which is also what keeps `oss-pr` safe while that signal has rows behind it.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { configPath } from '../../io.js'

/** Longest id accepted. Slug-shaped, because it is stored on every row and read in a URL filter. */
export const INITIATIVE_KIND_ID_MAX = 40
/** Longest label accepted - it renders in a table cell, a chip and a select trigger. */
export const INITIATIVE_KIND_LABEL_MAX = 40
/** Longest icon key accepted. The vocabulary itself lives in the SPA (`components/board/presetIcons`,
 *  shared with presets) for the same reason a preset's does: it is presentation, and a key this layer
 *  does not know renders as the default rather than erroring. */
export const INITIATIVE_KIND_ICON_MAX = 40

export interface InitiativeKindRecord {
  /** The stored value on `initiatives.kind`. Immutable once created (see the header). */
  id: string
  /** How it renders. Editable. */
  label: string
  /** Icon key, or null for the client's default. Opaque here - see INITIATIVE_KIND_ICON_MAX. */
  icon: string | null
  updated_at: string
  /** users.id of whoever last wrote it, or null when the caller passed no actor. */
  updated_by: string | null
}

export interface InitiativeKindsFile {
  /** True once the built-ins have been written to disk. Presence of the flag - NOT a non-empty
   *  list - is what stops the seed running again. */
  seeded: boolean
  kinds: InitiativeKindRecord[]
}

/**
 * The ten kinds this shipped with. A seed: once written they are
 * ordinary records with no special status, and nothing here treats them as undeletable.
 */
export const INITIATIVE_KIND_SEED: { id: string; label: string; icon: string }[] = [
  { id: 'bug', label: 'Bugs', icon: 'bug' },
  { id: 'business', label: 'Business', icon: 'briefcase' },
  { id: 'channel-growth', label: 'Channel growth', icon: 'trending-up' },
  { id: 'decision', label: 'Decision', icon: 'compass' },
  { id: 'general', label: 'General', icon: 'layout-grid' },
  { id: 'infra', label: 'Infra', icon: 'wrench' },
  { id: 'capability', label: 'New capability', icon: 'sparkles' },
  { id: 'oss-pr', label: 'OSS PR', icon: 'git-branch' },
  { id: 'product', label: 'Product', icon: 'package' },
  { id: 'strategy', label: 'Strategy', icon: 'target' },
]

/** The fallback kind - what an initiative gets when none is given, and the one id the delete guard
 *  refuses to remove so the board can never be left with no lane to create into. */
export const DEFAULT_INITIATIVE_KIND = 'general'

export function initiativeKindsPath(): string {
  return configPath('initiative-kinds.json')
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const seedRecords = (): InitiativeKindRecord[] =>
  sortKinds(INITIATIVE_KIND_SEED.map((k) => ({ ...k, updated_at: new Date(0).toISOString(), updated_by: null })))

/** One stored entry, or null if it is not a kind at all. Unknown extra keys are dropped, and an
 *  malformed field falls back rather than erasing the row. */
function readEntry(raw: unknown): InitiativeKindRecord | null {
  if (!isRecord(raw)) return null
  const { id, label, icon, updated_at, updated_by } = raw
  if (typeof id !== 'string' || !id.trim()) return null
  return {
    id: id.trim(),
    label: typeof label === 'string' && label.trim() ? label.trim() : id.trim(),
    icon: typeof icon === 'string' && icon.trim() ? icon.trim() : null,
    updated_at: typeof updated_at === 'string' ? updated_at : new Date(0).toISOString(),
    updated_by: typeof updated_by === 'string' ? updated_by : null,
  }
}

/** By label, ties by id - the one order this list has, on disk and on screen alike. */
function sortKinds(list: InitiativeKindRecord[]): InitiativeKindRecord[] {
  return [...list].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
}

// mtime cache. `initiativeKinds()` is called on EVERY initiative write (it is the enum gate) and on
// every board read, so re-parsing the file each time would be silly - but a hand-edit to the JSON
// still has to take effect without a restart, which is what the mtime check buys (same trade as
// content/profiles.ts).
let cache: { mtimeMs: number; file: InitiativeKindsFile } | null = null

/**
 * Parse the config file. A missing one means "nothing seeded yet" - the caller sees the built-ins
 * via `initiativeKinds()`. Malformed JSON throws: a config file we cannot read is a deploy problem,
 * and silently serving an empty list would look like the team's lanes had been deleted.
 */
export function readInitiativeKindsFile(): InitiativeKindsFile {
  const path = initiativeKindsPath()
  if (!existsSync(path)) {
    cache = null
    return { seeded: false, kinds: [] }
  }
  const mtimeMs = statSync(path).mtimeMs
  if (cache && cache.mtimeMs === mtimeMs) return cache.file
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const list = isRecord(raw) && Array.isArray(raw.kinds) ? raw.kinds : []
  const seen = new Set<string>()
  const file: InitiativeKindsFile = {
    seeded: isRecord(raw) ? raw.seeded !== false : false,
    kinds: sortKinds(
      list.flatMap((entry) => {
        const parsed = readEntry(entry)
        if (!parsed || seen.has(parsed.id)) return []
        seen.add(parsed.id)
        return [parsed]
      }),
    ),
  }
  cache = { mtimeMs, file }
  return file
}

/** Pretty-print back to disk (2-space, by label, trailing newline - diff-friendly). */
export function writeInitiativeKindsFile(file: InitiativeKindsFile): void {
  const path = initiativeKindsPath()
  mkdirSync(dirname(path), { recursive: true })
  const out: InitiativeKindsFile = { seeded: true, kinds: sortKinds(file.kinds) }
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
  cache = { mtimeMs: statSync(path).mtimeMs, file: out }
}

/** The tenant's kinds, by label - the built-ins until the first write, the file after it. */
export function initiativeKinds(): InitiativeKindRecord[] {
  const file = readInitiativeKindsFile()
  return file.seeded ? file.kinds : seedRecords()
}

/** Just the ids, by label. This is the runtime enum every write is validated against. */
export function initiativeKindIds(): string[] {
  return initiativeKinds().map((k) => k.id)
}

export function isInitiativeKind(id: string): boolean {
  return initiativeKindIds().includes(id)
}

/** The gate on `initiatives.kind`: a typo used to silently create a one-row group. */
export function assertInitiativeKind(id: string): void {
  if (!isInitiativeKind(id)) {
    throw new Error(`unknown initiative kind "${id}" - one of ${initiativeKindIds().join(', ')} (edit them in Settings)`)
  }
}

/** A slug that may be stored, or a throw naming what is wrong with the one supplied. */
export function assertKindId(id: string): string {
  const trimmed = id.trim().toLowerCase()
  if (!trimmed) throw new Error('a kind needs an id')
  if (trimmed.length > INITIATIVE_KIND_ID_MAX) {
    throw new Error(`kind id is too long (${trimmed.length} > ${INITIATIVE_KIND_ID_MAX} characters)`)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
    throw new Error(`kind id "${trimmed}" is not a slug - lowercase letters, digits and dashes`)
  }
  return trimmed
}

function assertKindLabel(label: string): string {
  const trimmed = label.trim()
  if (!trimmed) throw new Error('a kind needs a label')
  if (trimmed.length > INITIATIVE_KIND_LABEL_MAX) {
    throw new Error(`kind label is too long (${trimmed.length} > ${INITIATIVE_KIND_LABEL_MAX} characters)`)
  }
  return trimmed
}

/** The icon key to store: `''`/null/undefined all mean "no icon of its own" (the client's default). */
function assertIcon(icon?: string | null): string | null {
  const trimmed = icon?.trim() ?? ''
  if (!trimmed) return null
  if (trimmed.length > INITIATIVE_KIND_ICON_MAX) {
    throw new Error(`kind icon key is too long (${trimmed.length} > ${INITIATIVE_KIND_ICON_MAX} characters)`)
  }
  return trimmed
}

export interface InitiativeKindInput {
  id: string
  /** Required when creating; omitted on an edit means "keep". */
  label?: string
  /** Omitted means "keep"; `''`/null clears it back to the client's default. */
  icon?: string | null
  actor?: string | null
}

/**
 * Create a kind or edit an existing one in place. The id is the key and is never rewritten (see the
 * header) - passing an unknown one creates a lane at the end of the list, a known one edits it.
 */
export function saveInitiativeKind(input: InitiativeKindInput): InitiativeKindRecord {
  const id = assertKindId(input.id)
  const kinds = initiativeKinds()
  const prev = kinds.find((k) => k.id === id) ?? null
  if (!prev && input.label === undefined) throw new Error(`a new kind needs a label ("${id}")`)
  const record: InitiativeKindRecord = {
    id,
    label: input.label !== undefined ? assertKindLabel(input.label) : (prev?.label ?? id),
    icon: input.icon !== undefined ? assertIcon(input.icon) : (prev?.icon ?? null),
    updated_at: new Date().toISOString(),
    updated_by: input.actor?.trim() || null,
  }
  writeInitiativeKindsFile({
    seeded: true,
    kinds: prev ? kinds.map((k) => (k.id === id ? record : k)) : [...kinds, record],
  })
  return record
}

/**
 * Remove one kind from the list. Refuses the default lane; the "no initiative uses it" guard lives
 * in planning/state.ts, which is the layer that can see the warehouse.
 */
export function removeInitiativeKind(id: string): void {
  const kinds = initiativeKinds()
  if (!kinds.some((k) => k.id === id)) throw new Error(`unknown initiative kind "${id}"`)
  if (id === DEFAULT_INITIATIVE_KIND) {
    throw new Error(`"${DEFAULT_INITIATIVE_KIND}" is the fallback kind and cannot be deleted - relabel it instead`)
  }
  writeInitiativeKindsFile({ seeded: true, kinds: kinds.filter((k) => k.id !== id) })
}
