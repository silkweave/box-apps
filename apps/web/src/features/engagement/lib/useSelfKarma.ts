import { registerStoreReloads } from '../../../lib/changeFeed.ts'
import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'

// One shared store (see dataStore.ts) for the topbar karma badge: the signed-in PRINCIPAL's global
// pod karma (given + received) via the role-shared `podsSelfKarma` query. Errors resolve to null
// quietly (no principal, an expired token, ...) - the badge simply
// hides. The karma sits inside a wrapper object so a legitimate "unavailable" (null) result still
// counts as loaded and is not refetched on every mount. NOTE: principal-scoped, unlike the
// engagement queue which follows the ACTIVE user (top-right menu) - the two can disagree when
// impersonating another user.

/** Both karma directions: given (engaging others) + received (their own content). */
export interface SelfKarma {
  given: number
  received: number
}

const store = createDataStore<{ karma: SelfKarma | null }>(() =>
  trpc.podsSelfKarma
    .query({})
    .then((d) => {
      const k = d as { given?: unknown; received?: unknown }
      return {
        karma:
          typeof k.given === 'number' && typeof k.received === 'number'
            ? { given: k.given, received: k.received }
            : null,
      }
    })
    .catch(() => ({ karma: null })),
)
registerStoreReloads(['table:pod_engagements', 'table:pod_content'], store)

/** Refresh after a karma-affecting mutation (pod engagement recorded). */
export const reloadSelfKarma = (): Promise<SelfKarma | null> => store.reload().then((s) => s.karma)

/** The signed-in principal's global pod karma, or null while loading / when unavailable. */
export function useSelfKarma(): SelfKarma | null {
  return store.useData().data?.karma ?? null
}
