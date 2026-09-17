import { describe, expect, it, vi } from 'vitest'
import { agentRoomOf, chatRoomSessionRule } from './agent-session-access.js'
import { AGENT_SESSION_APP } from '../../agent-session.js'

/** What `ensureSession` in chat-agent.ts stamps on a room's session. */
const roomSession = (room = 'room-1') => ({ meta: { app: AGENT_SESSION_APP, user: 'nova', room, roomSlug: 'general' } })

/** A sidebar session as `gateCreate` stamps it: scoped and meta'd to the signed-in person. */
const sidebarSession = (user: string) => ({
  scope: { user },
  meta: { app: AGENT_SESSION_APP, user, display: user },
})

describe('agentRoomOf', () => {
  it('reads the room off a chat-agent session', () => {
    expect(agentRoomOf(roomSession('r9'))).toBe('r9')
  })

  it('is null for a session with no meta at all (a job stub, a foreign create)', () => {
    expect(agentRoomOf({})).toBeNull()
    expect(agentRoomOf({ scope: { user: 'alice' } })).toBeNull()
  })

  it('needs all three stamps: app, the agent as user, and a non-empty room', () => {
    expect(agentRoomOf({ meta: { user: 'nova', room: 'r1' } })).toBeNull()
    expect(agentRoomOf({ meta: { app: AGENT_SESSION_APP, room: 'r1' } })).toBeNull()
    expect(agentRoomOf({ meta: { app: AGENT_SESSION_APP, user: 'nova' } })).toBeNull()
    expect(agentRoomOf({ meta: { app: AGENT_SESSION_APP, user: 'nova', room: '' } })).toBeNull()
    expect(agentRoomOf({ meta: { app: AGENT_SESSION_APP, user: 'nova', room: 42 } })).toBeNull()
  })

  it("does not let a person's own create pass as a room session by naming a room", () => {
    // gateCreate overwrites meta.user with the principal, so this is what such a create looks like.
    expect(agentRoomOf({ scope: { user: 'alice' }, meta: { app: AGENT_SESSION_APP, user: 'alice', room: 'r1' } })).toBeNull()
  })

  it('honors a different agent id when asked', () => {
    expect(agentRoomOf({ meta: { app: AGENT_SESSION_APP, user: 'bot', room: 'r1' } }, 'bot')).toBe('r1')
    expect(agentRoomOf(roomSession(), 'bot')).toBeNull()
  })
})

describe('chatRoomSessionRule', () => {
  const allRooms = () => true
  const noRooms = () => false

  it('reader: a room session, for someone the chat store admits to that room', () => {
    const canRead = vi.fn((room: string, user: string) => room === 'r1' && user === 'alice')
    expect(chatRoomSessionRule(canRead)('alice', roomSession('r1'))).toEqual({ kind: 'reader', room: 'r1' })
    expect(canRead).toHaveBeenCalledWith('r1', 'alice')
  })

  it('abstains on a room the caller cannot read (a private room stays private)', () => {
    expect(chatRoomSessionRule(noRooms)('carol', roomSession('private'))).toBeNull()
  })

  it('abstains on a room session whose room the store no longer knows', () => {
    // canReadRoom answers false for an unknown room id; a deleted room's turns become unreadable
    // rather than public.
    expect(chatRoomSessionRule((room: string) => room !== 'deleted')('alice', roomSession('deleted'))).toBeNull()
  })

  it("abstains on another person's sidebar session, even for a caller who reads every room", () => {
    // The phase-2 bound: alice must never see bob's session. No room is stamped, so readability
    // has nothing to attach to.
    expect(chatRoomSessionRule(allRooms)('alice', sidebarSession('bob'))).toBeNull()
  })

  it('abstains when there is nothing to go on (no scope, no meta), whoever asks', () => {
    expect(chatRoomSessionRule(allRooms)('alice', {})).toBeNull()
  })
})
