// Data sources + the provider catalogue. Two stores, because they have opposite lifetimes: the
// catalogue is static (providers ship as code, so it changes only on deploy) while sources are
// CRUD-ed and re-synced constantly, and the change feed reloads only the latter.

import type { DataSource, Provider } from '../source-types.ts'
import type { DataSourceStatus } from '../../../types.ts'
import { registerStoreReloads } from '../../../lib/changeFeed.ts'
import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'

const actor = (): string | undefined => getActiveUserId() ?? undefined

const providersStore = createDataStore<Provider[]>(() =>
  trpc.sourcesProviders.query({}).then((d) => (d as unknown as { providers: Provider[] }).providers),
)

const sourcesStore = createDataStore<DataSource[]>(() =>
  trpc.sourcesList.query({}).then((d) => (d as unknown as { sources: DataSource[] }).sources),
)
// A sync writes points and stamps the row, so both table events land - reload on either.
registerStoreReloads(['table:data_sources', 'table:signals'], sourcesStore)

export function useProviders(enabled = true): { data: Provider[] | null; error: string | null } {
  return providersStore.useData(enabled)
}

export function useDataSources(enabled = true): { data: DataSource[] | null; error: string | null } {
  return sourcesStore.useData(enabled)
}

/** Force a refetch - after a sync run finishes, so the health stamps land without a change event. */
export const reloadDataSources = (): Promise<DataSource[]> => sourcesStore.reload()

export interface DataSourceUpsert {
  id: string
  /** Required on create; refused on an existing row (it would strand config + credentials). */
  provider?: string
  label?: string
  /** The provider's declared fields. Undeclared keys are refused server-side. */
  config?: Record<string, string>
  status?: DataSourceStatus
  notes?: string
}

/** Create or update a data source (admin), then reload. */
export async function upsertDataSource(input: DataSourceUpsert): Promise<void> {
  const { config, ...rest } = input
  await trpc.sourcesUpsert.mutate({
    ...rest,
    // @Mcp inputs stay scalar server-side, so `config` travels as a JSON object string.
    ...(config !== undefined ? { config: JSON.stringify(config) } : {}),
    actor: actor(),
  })
  await sourcesStore.reload()
}

/** Delete a data source (admin). Bound signals are reported, never unbound - they keep their
 *  points and stop refreshing, which is exactly the row a human should re-point. */
export async function deleteDataSource(id: string): Promise<{ bound_signals: string[]; warnings: string[] }> {
  const report = (await trpc.sourcesDelete.mutate({ id, actor: actor() })) as unknown as {
    bound_signals: string[]
    warnings: string[]
  }
  await sourcesStore.reload()
  return report
}
