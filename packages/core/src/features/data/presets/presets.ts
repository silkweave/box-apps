// Presets - the named lenses on the boards that have one (Content, the CRM, Initiatives). "Pipeline",
// "Critical path", "Needs review", whatever the team invents. They live in config/presets.json,
// alongside signal-owners.json and for the same reasons: this is Box CONFIGURATION, it wants a
// diff and a git history rather than audit stamps in the warehouse, and it travels with the Box's
// config directory, which is version-controlled (data.db is not).
//
// ONE KIND OF PRESET (2026-08-12, a product decision). There used to be two: built-in "presets" that were
// code and unchangeable, and "saved views" that were config and editable - which meant the six lenses
// people actually used every day were the six nobody could fix. There is now a single list per
// module, team-owned end to end: any internal user may retitle, re-icon, reorder, re-aim or delete
// ANY of them. Nothing here is personal - a lens only you can open is a lens you end up describing
// over Lark.
//
// The built-ins survive as a SEED, not as a floor. `presetsSeed` writes a module's defaults in the
// first time anybody opens it and records the module in `seeded`; from that moment they are ordinary
// records with no special status. That flag is what makes "delete a preset" stick: an empty list is
// a decision, and without the flag every read would helpfully undo it. Getting one back is an
// explicit act - `mode: 'restore'`, behind "Restore default presets" in the manage dialog.
//
// What this layer deliberately does NOT know is what a preset SHOWS. `state` is opaque JSON, because
// the vocabulary of a CRM lens (statuses, MRR buckets) and a Content one (channels, verify verdicts)
// have nothing in common, and the client already owns the repair-not-reset read that upgrades a
// stored preset when a release moves a column. That is also why the DEFAULTS live in the SPA and
// arrive here through `presetsSeed`: teaching this file three board vocabularies would mean
// re-teaching it on every release.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { configPath } from '../../../io.js'

/** The modules that have a preset bar. A closed list, so a typo cannot create a phantom module whose
 *  presets are written to disk and never rendered by anything. */
export const PRESET_MODULES = ['content', 'crm', 'initiatives'] as const
export type PresetModule = (typeof PRESET_MODULES)[number]

/** The longest a preset name may be - a nav sub-item and a select trigger both have to hold it. */
export const PRESET_NAME_MAX = 60

/** The longest one-liner a preset may carry. It renders under the name in the picker, so it is a
 *  sentence, not a paragraph. */
export const PRESET_DESCRIPTION_MAX = 160

/** Longest icon key accepted. The vocabulary itself lives in the SPA (`components/board/presetIcons`),
 *  for the same reason `state` does: it is presentation, and a key this layer does not know renders
 *  as the default rather than erroring. */
export const PRESET_ICON_MAX = 40

export interface PresetRecord {
  name: string
  /** The one-liner under the name in the picker, or null. Was a code-only field on the old built-in
   *  presets; it is editable now, because a lens whose title stopped explaining it is exactly the
   *  thing the team needs to be able to fix. */
  description: string | null
  /** The module's own view state, opaque here (see the header). */
  state: Record<string, unknown>
  /** Icon key, or null for the client's default. Opaque here - see PRESET_ICON_MAX. */
  icon: string | null
  /**
   * Where this preset sits in its module's list, ascending. Explicit because the team's own ordering
   * ("Pipeline first, then the Friday lens") is information alphabetical order cannot carry, and a
   * preset bar is read top to bottom. Always contiguous 0..n-1 on the way in and out - `sortPresets`
   * re-indexes, so a file hand-edited to `[0, 0, 7]` heals on the next write instead of persisting a
   * tie whose winner depends on sort stability.
   */
  order: number
  updated_at: string
  /** users.id of whoever last wrote it, or null when the caller passed no actor. */
  updated_by: string | null
}

export interface PresetsFile {
  /** Modules whose defaults have been seeded. Presence here - NOT a non-empty list - is what stops
   *  the seed running again, so deleting every preset in a module stays deleted. */
  seeded: string[]
  /** module id → its presets, in their own order. */
  modules: Record<string, PresetRecord[]>
}

export function presetsPath(): string {
  return configPath('presets.json')
}

/** Where presets lived until 2026-08-12, under the old `{ boards: { … } }` shape. Read once, on the
 *  first load after the rename, and then written forward - see `readPresetsFile`. */
function legacyPath(): string {
  return configPath('saved-views.json')
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** One stored entry, or null if it is not a preset at all. Unknown extra keys are dropped.
 *  `order` comes back as null when the entry predates it - `sortPresets` is what turns that into a
 *  position, so this function stays a pure per-entry read. */
function readRecord(raw: unknown): (Omit<PresetRecord, 'order'> & { order: number | null }) | null {
  if (!isRecord(raw)) return null
  const { name, description, state, icon, order, updated_at, updated_by } = raw
  if (typeof name !== 'string' || !name.trim() || !isRecord(state)) return null
  return {
    name: name.trim(),
    description: typeof description === 'string' && description.trim() ? description.trim() : null,
    state,
    icon: typeof icon === 'string' && icon.trim() ? icon.trim() : null,
    order: typeof order === 'number' && Number.isFinite(order) ? order : null,
    updated_at: typeof updated_at === 'string' ? updated_at : new Date(0).toISOString(),
    updated_by: typeof updated_by === 'string' ? updated_by : null,
  }
}

/**
 * Put one module's presets in their display order and re-index them 0..n-1.
 *
 * Presets that carry an `order` lead, ascending; ones that do not follow, alphabetically. That second
 * clause is the upgrade path: an entry written before `order` existed has no position at all, so it
 * sorts the way it always did (by name) and only takes an explicit order once somebody reorders.
 * Ties fall back to the name so the result never depends on file order.
 */
function sortPresets(list: (Omit<PresetRecord, 'order'> & { order: number | null })[]): PresetRecord[] {
  return [...list]
    .sort((a, b) => {
      if (a.order === null && b.order === null) return a.name.localeCompare(b.name)
      if (a.order === null) return 1
      if (b.order === null) return -1
      return a.order - b.order || a.name.localeCompare(b.name)
    })
    .map((v, i) => ({ ...v, order: i }))
}

/**
 * Parse the config file; a missing one means "nothing seeded yet, no presets anywhere". Malformed
 * JSON throws - a config file we cannot read is a deploy problem, and silently serving an empty list
 * would look like the team's presets were deleted.
 *
 * Reads `saved-views.json` when `presets.json` is absent, so the rename costs nobody their lenses.
 * The old file had no `seeded` set and no built-ins in it (they were code), so everything it holds is
 * a team-made preset and every module still needs its defaults - which is exactly what carrying the
 * old contents forward with an EMPTY `seeded` produces. The old file is left on disk untouched; the
 * Box instance's git history is the undo.
 */
export function readPresetsFile(): PresetsFile {
  const file = presetsPath()
  const legacy = legacyPath()
  const path = existsSync(file) ? file : existsSync(legacy) ? legacy : null
  const raw: unknown = path ? JSON.parse(readFileSync(path, 'utf8')) : {}
  // `modules` is the current key; `boards` is what the pre-rename file called the same thing.
  const source = isRecord(raw) ? (isRecord(raw.modules) ? raw.modules : isRecord(raw.boards) ? raw.boards : {}) : {}
  const seeded =
    isRecord(raw) && Array.isArray(raw.seeded)
      ? raw.seeded.filter((m): m is string => typeof m === 'string' && (PRESET_MODULES as readonly string[]).includes(m))
      : []
  return {
    seeded: [...new Set(seeded)].sort(),
    modules: Object.fromEntries(
      PRESET_MODULES.map((module) => {
        const list = Array.isArray(source[module]) ? (source[module] as unknown[]) : []
        return [module, sortPresets(list.flatMap((entry) => readRecord(entry) ?? []))]
      }),
    ),
  }
}

/** Pretty-print back to disk (2-space, modules sorted, presets in their own order, trailing newline -
 *  diff-friendly). Ordering is by each record's `order`, NOT by array position, so a caller that
 *  means to move something has to renumber - `reorderPresets` is the one that does. */
export function writePresetsFile(file: PresetsFile): void {
  const path = presetsPath()
  mkdirSync(dirname(path), { recursive: true })
  const out: PresetsFile = {
    seeded: [...new Set(file.seeded)].sort(),
    modules: Object.fromEntries(
      [...PRESET_MODULES].sort().map((module) => [module, sortPresets(file.modules[module] ?? [])]),
    ),
  }
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, 'utf8')
}

export function assertKnownModule(module: string): asserts module is PresetModule {
  if (!(PRESET_MODULES as readonly string[]).includes(module)) {
    throw new Error(`unknown module "${module}" - one of ${PRESET_MODULES.join(', ')}`)
  }
}

/** Every preset of one module, in the team's order. */
export function readPresets(module: string): PresetRecord[] {
  assertKnownModule(module)
  return readPresetsFile().modules[module] ?? []
}

/** A name that may be written, or a throw naming what is wrong with the one supplied. */
function assertName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('a preset needs a name')
  if (trimmed.length > PRESET_NAME_MAX) {
    throw new Error(`preset name is too long (${trimmed.length} > ${PRESET_NAME_MAX} characters)`)
  }
  return trimmed
}

/** The icon key to store: `''`/null/undefined all mean "no icon of its own" (the client's default). */
function assertIcon(icon?: string | null): string | null {
  const trimmed = icon?.trim() ?? ''
  if (trimmed.length > PRESET_ICON_MAX) {
    throw new Error(`icon key is too long (${trimmed.length} > ${PRESET_ICON_MAX} characters)`)
  }
  return trimmed || null
}

/** Same contract as the icon: `''` and null both mean "no one-liner". */
function assertDescription(description?: string | null): string | null {
  const trimmed = description?.trim() ?? ''
  if (trimmed.length > PRESET_DESCRIPTION_MAX) {
    throw new Error(`description is too long (${trimmed.length} > ${PRESET_DESCRIPTION_MAX} characters)`)
  }
  return trimmed || null
}

/**
 * Create or overwrite one preset by name. Overwrite IS the point - "save changes to this preset" is
 * the affordance the team asked for - so this is an upsert.
 *
 * An overwrite keeps the preset where it sits: re-saving "Pipeline" after a filter change must not
 * shuffle it to the bottom of everyone's list. A new one lands at the end.
 */
export function savePreset(
  module: string,
  name: string,
  state: Record<string, unknown>,
  actor?: string | null,
  icon?: string | null,
  description?: string | null,
): PresetRecord[] {
  assertKnownModule(module)
  const trimmed = assertName(name)
  const file = readPresetsFile()
  const existing = (file.modules[module] ?? []).find((v) => v.name === trimmed)
  const record: PresetRecord = {
    name: trimmed,
    // Unlike the upsert's other fields this one is a KEEP on overwrite when omitted: the ✓ in the bar
    // sends state and icon and has no opinion about the one-liner, and clearing it there would make
    // "save my filter change" quietly delete the sentence explaining the lens.
    description: description === undefined ? (existing?.description ?? null) : assertDescription(description),
    state,
    icon: assertIcon(icon),
    order: existing?.order ?? (file.modules[module] ?? []).length,
    updated_at: new Date().toISOString(),
    updated_by: actor ?? null,
  }
  const rest = (file.modules[module] ?? []).filter((v) => v.name !== trimmed)
  file.modules[module] = [...rest, record]
  writePresetsFile(file)
  return readPresetsFile().modules[module] ?? []
}

/**
 * Edit an EXISTING preset in place - its title, one-liner, icon, or state - keeping its position.
 *
 * Rename needs its own path because `name` is the identity: routing a title change through
 * `savePreset` would create a second preset and leave the original behind. It is the only operation
 * here that can fail on a conflict, and it fails loudly (a silent merge would eat one of the two
 * presets' state).
 *
 * Every field is optional and `undefined` means "leave it alone", which is what lets the manage
 * dialog send exactly what the user touched. `icon: null` (or `''`) is the explicit "back to the
 * default" - distinct from omitting it - and the same goes for `description`.
 */
export function updatePreset(
  module: string,
  name: string,
  patch: { name?: string; description?: string | null; icon?: string | null; state?: Record<string, unknown> },
  actor?: string | null,
): PresetRecord[] {
  assertKnownModule(module)
  const file = readPresetsFile()
  const list = file.modules[module] ?? []
  const current = list.find((v) => v.name === name.trim())
  if (!current) throw new Error(`no preset named "${name.trim()}" in ${module}`)
  const nextName = patch.name === undefined ? current.name : assertName(patch.name)
  if (nextName !== current.name && list.some((v) => v.name === nextName)) {
    throw new Error(`a preset named "${nextName}" already exists - pick another name`)
  }
  const record: PresetRecord = {
    ...current,
    name: nextName,
    description: patch.description === undefined ? current.description : assertDescription(patch.description),
    icon: patch.icon === undefined ? current.icon : assertIcon(patch.icon),
    state: patch.state ?? current.state,
    updated_at: new Date().toISOString(),
    updated_by: actor ?? null,
  }
  file.modules[module] = list.map((v) => (v.name === current.name ? record : v))
  writePresetsFile(file)
  return readPresetsFile().modules[module] ?? []
}

/**
 * Put one module's presets in the given order. Names the module does not have are ignored and presets
 * the caller did not mention keep their relative order at the end - so a reorder computed against a
 * slightly stale list moves what it meant to move instead of dropping whatever it had not seen.
 *
 * Deliberately does NOT stamp `updated_at`/`updated_by`: where a preset sits in the list is a
 * property of the LIST, and re-attributing every one of them to whoever last dragged one would make
 * "last saved by" lie about who last changed what the preset shows.
 */
export function reorderPresets(module: string, names: string[]): PresetRecord[] {
  assertKnownModule(module)
  const file = readPresetsFile()
  const list = file.modules[module] ?? []
  const wanted = names.map((n) => n.trim()).filter((n, i, all) => all.indexOf(n) === i)
  const ordered = wanted.flatMap((n) => list.find((v) => v.name === n) ?? [])
  file.modules[module] = [...ordered, ...list.filter((v) => !ordered.includes(v))].map((v, i) => ({ ...v, order: i }))
  writePresetsFile(file)
  return readPresetsFile().modules[module] ?? []
}

/** Remove one preset by name. Deleting one that is not there is a no-op, not an error - two people
 *  clicking the same trash icon should not produce a red toast for the slower one. */
export function deletePreset(module: string, name: string): PresetRecord[] {
  assertKnownModule(module)
  const trimmed = name.trim()
  const file = readPresetsFile()
  file.modules[module] = (file.modules[module] ?? []).filter((v) => v.name !== trimmed)
  writePresetsFile(file)
  return readPresetsFile().modules[module] ?? []
}

/** One default as the SPA declares it - the seed's payload, before it becomes an ordinary record. */
export interface PresetSeed {
  name: string
  description?: string | null
  icon?: string | null
  state: Record<string, unknown>
}

/**
 * Install a module's built-in presets. Idempotent by design, and the mode says which kind:
 *
 * - **`initial`** (what every board load sends) does nothing at all once the module is in `seeded`.
 *   That flag, not the list being non-empty, is the guard - so a team that deletes every preset in a
 *   module keeps it deleted, and two browsers opening the board at once cannot double-seed.
 * - **`restore`** ("Restore default presets") adds back only the names that are currently missing and
 *   leaves every existing preset exactly as it is, including ones that were renamed or re-aimed. A
 *   restore is for getting a deleted lens back, never for reverting somebody's edits.
 *
 * Returns the module's list either way, so the caller never has to guess whether anything happened.
 */
export function seedPresets(
  module: string,
  presets: PresetSeed[],
  mode: 'initial' | 'restore' = 'initial',
  actor?: string | null,
): PresetRecord[] {
  assertKnownModule(module)
  const file = readPresetsFile()
  if (mode === 'initial' && file.seeded.includes(module)) return file.modules[module] ?? []
  const list = file.modules[module] ?? []
  const have = new Set(list.map((v) => v.name))
  const now = new Date().toISOString()
  const added = presets
    .filter((p) => p.name.trim() && !have.has(p.name.trim()))
    .map((p, i) => ({
      name: assertName(p.name),
      description: assertDescription(p.description),
      state: p.state,
      icon: assertIcon(p.icon),
      order: list.length + i,
      updated_at: now,
      updated_by: actor ?? null,
    }))
  file.modules[module] = [...list, ...added]
  file.seeded = [...file.seeded, module]
  writePresetsFile(file)
  return readPresetsFile().modules[module] ?? []
}
