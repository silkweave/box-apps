// The routing rule behind every device nudge: mentions push, plain messages do not, a DM message is
// the one exception (it IS addressed to a person), and a mention inside a DM folds into that
// exception so nobody gets two notifications for one sentence. Proven against a fake bus and a
// fake store - no SQLite, no transport - because what is under test is the decision, not the send.

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown) => void
const handlers: Handler[] = []
const store = {
  directPeer: vi.fn<(roomId: string, userId: string) => string | null>(),
  roomSlugById: vi.fn<(roomId: string) => string | null>(),
}

vi.mock('@silkweave/box-core', () => ({
  systemUserId: () => 'nova',
  chatStore: () => store,
  onChatEvent: (h: Handler) => {
    handlers.push(h)
    return () => {}
  },
  credential: () => undefined,
}))

const { deliverNotification, registerNotificationTransport, startNotificationDelivery } = await import('./delivery.js')
type Delivery = Parameters<typeof deliverNotification>[0]

const ROOM = 'room-general'
const DM = 'room-dm'
const message = (over: Partial<{ id: string; roomId: string; senderId: string; senderName: string; body: string }> = {}) => ({
  id: 'm1',
  roomId: ROOM,
  senderId: 'carol',
  senderName: 'Carol',
  body: 'hello',
  createdAt: 1000,
  editedAt: null,
  ...over,
})
const emit = (event: unknown): void => {
  for (const h of handlers) h(event)
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('notification delivery routing', () => {
  const delivered: Delivery[] = []

  beforeEach(() => {
    delivered.length = 0
    store.directPeer.mockReset().mockReturnValue(null)
    store.roomSlugById.mockReset().mockImplementation((id) => (id === DM ? 'dm:alice:carol' : 'general'))
    registerNotificationTransport({
      name: 'capture',
      deliver: async (d) => {
        delivered.push(d)
      },
    })
    startNotificationDelivery()
  })

  it('subscribes to the bus exactly once, however often it is started', () => {
    startNotificationDelivery()
    startNotificationDelivery()
    expect(handlers).toHaveLength(1)
  })

  it('a plain message in a named room does NOT push', async () => {
    emit({ id: 1, roomId: ROOM, type: 'message.created', payload: message(), at: 1000 })
    await flush()
    expect(delivered).toEqual([])
  })

  it('a mention pushes to the mentioned user, as kind mention, with the room slug', async () => {
    emit({
      ephemeral: true,
      type: 'mention.created',
      roomId: ROOM,
      userId: 'alice',
      payload: message({ body: '@alice look' }),
      at: 1000,
    })
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      kind: 'mention',
      userId: 'alice',
      roomSlug: 'general',
      actor: 'Carol',
      actorId: 'carol',
      messageId: 'm1',
      preview: '@alice look',
      at: 1000,
    })
  })

  it('a message in a DM pushes to the PEER, as kind dm, never to the sender', async () => {
    store.directPeer.mockImplementation((roomId, userId) => (roomId === DM && userId === 'carol' ? 'alice' : null))
    emit({ id: 2, roomId: DM, type: 'message.created', payload: message({ roomId: DM }), at: 2000 })
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ kind: 'dm', userId: 'alice', roomSlug: 'dm:alice:carol' })
    expect(store.directPeer).toHaveBeenCalledWith(DM, 'carol')
  })

  it('a mention INSIDE a DM by a member folds into the DM nudge (one notification, not two)', async () => {
    store.directPeer.mockImplementation((roomId, userId) => (roomId === DM && userId === 'carol' ? 'alice' : null))
    const payload = message({ roomId: DM, body: '@alice ping' })
    emit({ id: 3, roomId: DM, type: 'message.created', payload, at: 3000 })
    emit({ ephemeral: true, type: 'mention.created', roomId: DM, userId: 'alice', payload, at: 3000 })
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.kind).toBe('dm')
  })

  it("the agent's own DM messages do not push, but a mention it writes as a DM guest does", async () => {
    // nova is not one of the pair, so directPeer answers null for her - no DM nudge to fold into.
    store.directPeer.mockReturnValue(null)
    const payload = message({ roomId: DM, senderId: 'nova', senderName: 'nova', body: '@carol done' })
    emit({ id: 4, roomId: DM, type: 'message.created', payload, at: 4000 })
    await flush()
    expect(delivered).toEqual([])
    emit({ ephemeral: true, type: 'mention.created', roomId: DM, userId: 'carol', payload, at: 4000 })
    await flush()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({ kind: 'mention', userId: 'carol', actorId: 'nova' })
  })

  it('ignores every other ephemeral, and a mention with no target or no payload', async () => {
    emit({ ephemeral: true, type: 'member.read', roomId: ROOM, userId: 'alice', at: 1 })
    emit({ ephemeral: true, type: 'mention.created', roomId: ROOM, userId: null, payload: message(), at: 1 })
    emit({ ephemeral: true, type: 'mention.created', roomId: ROOM, userId: 'alice', payload: null, at: 1 })
    emit({ id: 5, roomId: ROOM, type: 'message.edited', payload: message(), at: 1 })
    await flush()
    expect(delivered).toEqual([])
  })

  it('truncates the preview at 120 chars with an ellipsis', async () => {
    const body = 'x'.repeat(130)
    emit({ ephemeral: true, type: 'mention.created', roomId: ROOM, userId: 'alice', payload: message({ body }), at: 1 })
    await flush()
    expect(delivered[0]?.preview).toBe(`${'x'.repeat(120)}…`)
  })

  it('a throwing transport neither rejects nor mutes the others', async () => {
    registerNotificationTransport({
      name: 'broken',
      deliver: async () => {
        throw new Error('boom')
      },
    })
    await expect(
      deliverNotification({
        userId: 'alice',
        kind: 'mention',
        roomSlug: 'general',
        actor: 'Carol',
        actorId: 'carol',
        messageId: 'm9',
        preview: 'p',
        at: 1,
      }),
    ).resolves.toBeUndefined()
    expect(delivered).toHaveLength(1)
    // Replace it by name so later tests are not poisoned.
    registerNotificationTransport({ name: 'broken', deliver: async () => {} })
  })
})
