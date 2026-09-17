import type { Signal } from '../../../types.ts'

// A signal detail route is `/signals/<channel>/<slug>`. The slug is the signal id with its
// `<channel>.` prefix stripped and every non-alphanumeric run collapsed to a single dash:
//   github.stars.acme        -> stars-acme
//   npm.pkg.@acme/core       -> pkg-acme-core
//   reddit.total_karma       -> total-karma
// Slugs are unique within a channel for our signal set, so (channel, slug) round-trips to a signal.
export function signalSlug(signal: Pick<Signal, 'id' | 'channel'>): string {
  const tail = signal.id.startsWith(`${signal.channel}.`)
    ? signal.id.slice(signal.channel.length + 1)
    : signal.id
  return tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Resolve a (channel, slug) pair back to its signal, or undefined if no match. */
export function findSignal(signal: Signal[], channel: string, slug: string): Signal | undefined {
  return signal.find((s) => s.channel === channel && signalSlug(s) === slug)
}
