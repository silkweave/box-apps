// The board's kind list - server-backed since 2026-08-28, where it used to be three hardcoded
// structures in planning-types.ts (the union, KIND_AREA, KIND_LABEL). It lives in the Box
// instance's config/initiative-kinds.json; the ten this shipped with are its seed, not a floor.
//
// Two ways in, on purpose:
//   • `useInitiativeKinds()` - the hook. Subscribes, so a relabel repaints every board that is open.
//   • `kindLabel()` / `kindIcon()` / `kindIds()` - synchronous reads off the cache, for the pure
//     view functions (lib/planningView.ts) that map/group/filter rows and have no React in them.
//     They read `peek()`, so they answer sensibly before the first load: an unknown id renders as
//     itself rather than vanishing from the board.
//
// Freshness matches presets: config is not a warehouse table, so there is no change-feed topic. The
// store reloads after every local write; someone else's new lane lands on the next page load.

import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'
import type { InitiativeKind } from '../planning-types.ts'

/** One lane as it comes off the wire. `count` is how many initiatives are in it right now. */
export interface InitiativeKindRecord {
  id: InitiativeKind
  label: string
  /** Icon key from `components/board/presetIcons` (shared with presets), or null for the default. */
  icon: string | null
  count: number
  updated_at: string
  updated_by: string | null
}

const store = createDataStore<InitiativeKindRecord[]>(() =>
  trpc.planningKinds.query({}).then((d) => ((d as { kinds?: unknown }).kinds ?? []) as InitiativeKindRecord[]),
)

export const useInitiativeKinds = (): { data: InitiativeKindRecord[] | null; error: string | null } => store.useData()

/** The cached list without fetching - empty before the first load (see the header). */
export const peekInitiativeKinds = (): InitiativeKindRecord[] => store.peek() ?? []

/** Every configured kind id, by label. */
export const kindIds = (): InitiativeKind[] => peekInitiativeKinds().map((k) => k.id)

/** How a kind renders. An id the list does not know renders as itself - a lane deleted while rows
 *  still pointed at it must stay legible rather than turn into a blank cell. */
export const kindLabel = (id: InitiativeKind): string =>
  peekInitiativeKinds().find((k) => k.id === id)?.label ?? id

/** The stored icon key for a kind, or null - `presetIcon()` turns it into a component and falls back
 *  on its own, so an unknown key and no key at all render the same way. */
export const kindIcon = (id: InitiativeKind): string | null =>
  peekInitiativeKinds().find((k) => k.id === id)?.icon ?? null

/** Create a lane, or edit an existing one's label or icon. Admin-only server-side. */
export async function saveInitiativeKind(input: {
  id: string
  label?: string
  /** Omitted keeps the stored icon; `''` clears it back to the default. */
  icon?: string
}): Promise<void> {
  await trpc.planningKindSave.mutate({ ...input, actor: getActiveUserId() ?? undefined })
  await store.reload()
}

/** Remove a lane. The server refuses while any initiative is in it. */
export async function deleteInitiativeKind(id: string): Promise<void> {
  await trpc.planningKindDelete.mutate({ id })
  await store.reload()
}
