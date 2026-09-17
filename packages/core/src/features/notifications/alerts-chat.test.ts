import { describe, expect, it } from 'vitest'
import { chatRouteSlug } from './alerts-chat.js'

describe('chatRouteSlug', () => {
  it('accepts a chat route and returns the room slug', () => {
    expect(chatRouteSlug('chat:campaigns')).toBe('campaigns')
    expect(chatRouteSlug('chat:go-to-market')).toBe('go-to-market')
  })

  it('returns null for every non-chat route, so Lark keeps them', () => {
    expect(chatRouteSlug('owner')).toBeNull()
    expect(chatRouteSlug('channel')).toBeNull()
    expect(chatRouteSlug('user:alice')).toBeNull()
  })

  it('refuses a DM slug - `:` is reserved for the dm: namespace in the chat store', () => {
    expect(chatRouteSlug('chat:dm:alice:carol')).toBeNull()
  })

  it('refuses slugs the chat controller would refuse anyway', () => {
    expect(chatRouteSlug('chat:')).toBeNull()
    expect(chatRouteSlug('chat:-leading')).toBeNull()
    expect(chatRouteSlug('chat:trailing-')).toBeNull()
    expect(chatRouteSlug('chat:Upper')).toBeNull()
  })
})
