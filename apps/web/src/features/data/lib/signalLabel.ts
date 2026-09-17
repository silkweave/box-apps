// The one rule for signal identifiers in the UI: **ids are for machines and the API; the UI always
// resolves a friendly label, and an unresolvable binding renders its raw id rather than vanishing.**
// A binding you cannot see is a binding you cannot fix, so nothing here ever returns ''.
//
// This is the same contract `SignalSelect`'s `optionOf` implements for the pickers, lifted out
// so the read-only surfaces (board cells, target readouts, alert rules, owner overrides) share it.
// Keyed off a `Map<id, Signal>` because every caller either holds one already or builds it once per
// render - resolving against the raw payload per id would be a scan per cell.

import { channelLabel, type SignalsData, type Signal } from '../../../types.ts'

export type SignalMap = Map<string, Signal>

/** Build the lookup once from a signals payload (null-safe: an empty map resolves nothing). */
export const signalMap = (data: SignalsData | null): SignalMap =>
  new Map((data?.signals ?? []).map((s) => [s.id, s]))

/** True when the id resolves to a live signal - for callers that want to mark a dead binding. */
export const isKnownSignal = (byId: SignalMap, id: string): boolean => byId.has(id)

/**
 * The friendly name for one signal id: its label, or the raw id when nothing resolves.
 * `withChannel` appends the channel ("Followers · GitHub") for surfaces where the channel is not
 * already implied by context.
 */
export function signalLabel(byId: SignalMap, id: string, opts?: { withChannel?: boolean }): string {
  const s = byId.get(id)
  if (!s) return id
  return opts?.withChannel ? `${s.label} · ${channelLabel(s.channel)}` : s.label
}

/** The same for a list of bindings, joined the way the board cells render them. */
export function signalLabels(byId: SignalMap, ids: string[], opts?: { withChannel?: boolean }): string {
  return ids.map((id) => signalLabel(byId, id, opts)).join(' · ')
}
