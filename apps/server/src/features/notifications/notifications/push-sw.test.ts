import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@silkweave/box-core', () => ({
  BOX_BRAND: { name: 'North "Studio" \\ team', icon192: '/north/icon.png' },
}))
import { PUSH_SW_SOURCE } from './push-sw.js'

describe('push worker branding', () => {
  it('uses safely serialized custom fallbacks and preserves a supplied notification title', async () => {
    const listeners: Record<string, (event: unknown) => void> = {}
    const showNotification = vi.fn()
    runInNewContext(PUSH_SW_SOURCE, { URL, self: {
      addEventListener: (name: string, fn: (event: unknown) => void) => { listeners[name] = fn },
      registration: { showNotification }, location: { origin: 'https://box.example' },
    } })
    for (const data of [{}, { title: 'Alice mentioned you' }]) {
      let pending: Promise<void> | undefined
      listeners.push!({ data: { json: () => data }, waitUntil: (work: Promise<void>) => { pending = work } })
      await pending
    }
    expect(showNotification.mock.calls[0]?.[0]).toBe('North "Studio" \\ team')
    expect(showNotification.mock.calls[0]?.[1].icon).toBe('https://box.example/north/icon.png')
    expect(showNotification.mock.calls[1]?.[0]).toBe('Alice mentioned you')
  })
})
