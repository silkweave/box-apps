// The provider registry - static, exactly like DERIVERS in signals/derive.ts. Each provider is a
// workspace package (`@silkweave/box-provider-<id>`) depending only on @silkweave/box-provider-kit, and core imports
// it here and keys it into PROVIDERS. Nothing is discovered at runtime and the boot path is
// unchanged: "installing" a provider is a commit in this repo.
//
// The dependency direction is the whole point of the packaging and must not be reversed: core →
// provider → kit. A provider that imported @silkweave/box-core would pull in the warehouse layer and create
// the cycle the split exists to prevent - which is also why the kit carries the signal vocabulary
// and the fetch helpers rather than re-exporting them from core.

import type { Provider, ProviderMeasure } from '@silkweave/box-provider-kit'

/**
 * Empty on purpose: a provider speaks to ONE company's SaaS account, so the template ships none and
 * every consumer below already handles zero (the catalogue renders empty, `requireProvider` refuses
 * with "(none)"). Adding one is a workspace package under `packages/provider-<id>` depending only on
 * `@silkweave/box-provider-kit`, plus its import and its entry here - see `features/data/SPEC.md`.
 */
export const PROVIDERS: Record<string, Provider> = {}

/** Every registered provider, id-sorted - the `providers-list` payload and the dialog's catalogue. */
export function listProviders(): Provider[] {
  return Object.values(PROVIDERS).sort((a, b) => a.id.localeCompare(b.id))
}

/** One provider, or null when the id names nothing registered (a row can outlive its provider). */
export function findProvider(id: string): Provider | null {
  return PROVIDERS[id] ?? null
}

/** One provider, or a refusal listing what IS registered. */
export function requireProvider(id: string): Provider {
  const p = PROVIDERS[id]
  if (!p) {
    throw new Error(`unknown provider "${id}" - registered providers: ${Object.keys(PROVIDERS).sort().join(', ') || '(none)'}`)
  }
  return p
}

/** One measure of a provider's catalogue, or null. Measure keys are the provider's native tokens. */
export function findMeasure(provider: Provider, key: string): ProviderMeasure | null {
  return provider.measures.find((s) => s.key === key) ?? null
}
