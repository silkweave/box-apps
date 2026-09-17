// The team's presets, server-backed. One store for every module, because the server answers with one
// file (config/presets.json) and splitting it per module would buy nothing but three caches to keep
// in step.
//
// There is ONE kind of preset (2026-08-12). Before this, each board had six built-in lenses that were
// code and unchangeable plus a separate list of "saved views" that were config and editable - so the
// six people used daily were the six nobody could fix. Everything here is now a team-owned record:
// global, editable by any internal user, with no personal tier at all. What stays per-browser is the
// LIVE view (which lens you happen to be looking through right now), because that is a cursor, not a
// shared artifact.
//
// Freshness: the file is not a warehouse table, so there is no change-feed topic to subscribe to.
// The store reloads after every local write; another person's new preset lands on the next page load.
// That is the right trade for something edited a few times a month.

import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'

/** The modules that have a preset bar. Mirrors `PRESET_MODULES` in @silkweave/box-core - the server refuses
 *  anything else, and the generated tRPC input narrows to exactly these three. */
export type PresetModule = 'content' | 'crm' | 'initiatives'

/** One preset as it comes off the wire - `state` is the module's own shape, repaired on read. */
export interface PresetRecord {
  name: string
  /** The one-liner under the name in the picker, or null. */
  description: string | null
  state: unknown
  /** Icon key from `components/board/presetIcons`, or null for the default. */
  icon: string | null
  updated_at: string
  updated_by: string | null
}

/** What a module declares as its built-ins, sent once to seed the team's list. */
export interface PresetSeed {
  name: string
  description?: string
  icon?: string
  state: unknown
}

interface PresetsPayload {
  seeded: string[]
  modules: Record<string, PresetRecord[]>
}

const store = createDataStore<PresetsPayload>(() =>
  trpc.presetsList.query({}).then((d) => {
    const payload = d as { seeded?: unknown; modules?: Record<string, PresetRecord[]> }
    return {
      seeded: Array.isArray(payload.seeded) ? (payload.seeded as string[]) : [],
      modules: payload.modules ?? {},
    }
  }),
)

export const usePresets = (): { data: PresetsPayload | null; error: string | null } => store.useData()

/** Create or overwrite one preset. The server upserts by name - overwrite IS the feature. */
export async function savePreset(
  module: PresetModule,
  name: string,
  state: unknown,
  icon?: string | null,
  description?: string | null,
): Promise<void> {
  await trpc.presetsSave.mutate({
    module,
    name,
    state: JSON.stringify(state),
    // '' is the server's "clear it": an omitted icon on an overwrite would otherwise read as "keep",
    // and the caller here always knows what it wants the icon to be. The one-liner is the opposite -
    // omitted means keep, because the ✓ in the bar has no opinion about it.
    icon: icon ?? '',
    description: description === undefined ? undefined : (description ?? ''),
    actor: getActiveUserId() ?? undefined,
  })
  await store.reload()
}

/**
 * Edit one existing preset in place - title, one-liner, icon, or the state it shows - keeping its
 * position. Every field is optional; omitting one leaves it alone. Renaming onto a taken name throws.
 */
export async function updatePreset(
  module: PresetModule,
  name: string,
  patch: { name?: string; description?: string | null; icon?: string | null; state?: unknown },
): Promise<void> {
  await trpc.presetsUpdate.mutate({
    module,
    name,
    new_name: patch.name,
    // Unlike `savePreset` (which always writes a whole record), `undefined` here means "keep" and ''
    // means "clear" - so a rename must not accidentally reset the icon or the one-liner.
    icon: patch.icon === undefined ? undefined : (patch.icon ?? ''),
    description: patch.description === undefined ? undefined : (patch.description ?? ''),
    state: patch.state === undefined ? undefined : JSON.stringify(patch.state),
    actor: getActiveUserId() ?? undefined,
  })
  await store.reload()
}

/** Set the team's order for one module. Names not mentioned keep their relative order after. */
export async function reorderPresets(module: PresetModule, names: string[]): Promise<void> {
  await trpc.presetsReorder.mutate({ module, names })
  await store.reload()
}

/** Remove one preset - it goes for the whole team. */
export async function deletePreset(module: PresetModule, name: string): Promise<void> {
  await trpc.presetsDelete.mutate({ module, name, actor: getActiveUserId() ?? undefined })
  await store.reload()
}

/**
 * Install a module's built-ins. `initial` is a no-op once the module has been seeded (the server
 * checks, so two tabs racing cannot double-seed); `restore` adds back only the names currently
 * missing and never touches an existing preset.
 */
export async function seedPresets(
  module: PresetModule,
  presets: PresetSeed[],
  mode: 'initial' | 'restore' = 'initial',
): Promise<void> {
  await trpc.presetsSeed.mutate({
    module,
    presets: JSON.stringify(presets),
    mode,
    actor: getActiveUserId() ?? undefined,
  })
  await store.reload()
}

/** Current cached list for one module without fetching (null before the first load). */
export const peekPresets = (module: string): PresetRecord[] | null => store.peek()?.modules[module] ?? null
