// Pull helpers. The action vocabulary (IngestProgress, PullResult, todayUtc, drain) is core's
// (ops/types.ts); this module keeps the one helper that knows about snapshots and derives.

import { upsertSnapshot } from '../signals/write.js'
import { deriveSignals, isDerivedChannel } from '../signals/derive.js'
export { todayUtc, drain, type IngestProgress, type PullResult } from '../../../ops/types.js'

/**
 * Persist a raw pull payload into the warehouse and re-derive the affected dashboard channel's
 * signals. `snapshotChannel` is the folder-equivalent key (e.g. 'reddit-engagement', or an
 * account-scoped 'github@bob'); `derive` is the dashboard channel to re-derive (e.g. 'reddit'),
 * defaulting to `snapshotChannel` when it is itself a derived channel. Pass `derive: null` for
 * snapshot-only channels (github-engagement, reddit-radar) that map to no live signal.
 */
export async function persist(
  snapshotChannel: string,
  date: string,
  payload: unknown,
  derive?: string | null,
): Promise<void> {
  await upsertSnapshot(snapshotChannel, date, payload)
  const target = derive === undefined ? (isDerivedChannel(snapshotChannel) ? snapshotChannel : null) : derive
  if (target) await deriveSignals(target)
}
