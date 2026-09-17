// The signal hooks port - how features that DEPEND on data take part in data's own operations
// without data importing them. Planning contributes task-ledger rows to the github channel and
// re-points its initiative bindings when a signal is renamed; alerts re-points its rules; content
// contributes its outcome derive. Each registers once from its server module's onModuleInit
// ("the dependent registers into the dependency"; docs/core/SEAM.md § 4.2). A CLI or test that never
// boots those modules simply sees data alone, which is the point.

import type { SignalRow } from './write.js'

export interface SignalHooks {
  /** The registering feature, for error messages. */
  id: string
  /** Extra live rows appended to a channel's derive - keyed by dashboard channel. Needed because
   *  a channel derive REPLACES the channel's live rows, so anything else that lives on that
   *  channel must ride along or be wiped. */
  channelRows?: Record<string, () => Promise<SignalRow[]>>
  /** A standalone derive step `warehouse-derive` runs after the in-process channels. Returns rows. */
  derive?: () => Promise<number>
  /** A signal id was renamed - re-point every reference you hold. Runs inside renameSignal. */
  onRename?: (oldId: string, newId: string, actor?: string) => Promise<void>
  /** Ids of your objects that still reference this signal (for the delete report). */
  references?: (signalId: string) => Promise<string[]>
}

const hooks: SignalHooks[] = []

/** Register once per feature. Returns the unregister. */
export function registerSignalHooks(h: SignalHooks): () => void {
  if (hooks.some((x) => x.id === h.id)) throw new Error(`signal hooks "${h.id}" registered twice`)
  hooks.push(h)
  return () => {
    const i = hooks.indexOf(h)
    if (i >= 0) hooks.splice(i, 1)
  }
}

export function signalHooks(): readonly SignalHooks[] {
  return hooks
}

/** Every contributed row for one channel, from every registered feature. */
export async function contributedChannelRows(channel: string): Promise<SignalRow[]> {
  const out: SignalRow[] = []
  for (const h of hooks) {
    const fn = h.channelRows?.[channel]
    if (fn) out.push(...(await fn()))
  }
  return out
}
