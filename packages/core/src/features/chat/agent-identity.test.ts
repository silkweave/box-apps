import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { repoRoot } from '../../io.js'
import { AGENT_SESSION_APP } from '../../agent-session.js'
import { agentTriggerFor, parseAgentDirective, buildAgentPrime, resolveAgentTrigger } from './agent-trigger.js'
import { agentRoomOf } from './agent-session-access.js'
import { chatOpNeedsApproval } from './chat-op-approvals.js'
import { ChatStore } from './store.js'
import type { ChatMessage } from './types.js'
import { setInstanceDir, resetInstanceDir } from '../../testing.js'

test('a custom configured identity drives mentions, DM guests, prompts, sessions and approvals', () => {
  const parent = join(repoRoot(), 'node_modules', '.cache')
  mkdirSync(parent, { recursive: true })
  const dir = mkdtempSync(join(parent, 'chat-identity-'))
  setInstanceDir(dir)
  mkdirSync(join(dir, 'config'))
  writeFileSync(join(dir, 'config', 'box.json'), JSON.stringify({ agent: { id: 'orion', name: 'Orion Guide', role: 'member' } }))
  const store = new ChatStore(join(dir, 'chat.db'))
  try {
    const room = store.openDirect({ id: 'alice', display: 'Alice' }, 'orion')
    const message: ChatMessage = { id: 'm1', roomId: room.id, senderId: 'alice', senderName: 'Alice', body: '@orion hello', createdAt: 1, editedAt: null }
    const event = { ephemeral: true as const, type: 'mention.created' as const, roomId: room.id, userId: 'orion', payload: message, at: 1 }
    expect(agentTriggerFor(event)?.senderId).toBe('alice')
    expect(agentTriggerFor({ ...event, userId: 'nova' })).toBeNull()
    expect(agentTriggerFor({ ...event, payload: { ...message, senderId: 'orion' } })).toBeNull()
    const trigger = resolveAgentTrigger(event, store)!
    expect(trigger.via).toBe('dm')
    expect(parseAgentDirective('@orion stop')).toEqual({ kind: 'interrupt' })
    expect(buildAgentPrime({ roomSlug: room.slug, roomTopic: null })).toContain('You are Orion Guide')
    expect(agentRoomOf({ meta: { app: AGENT_SESSION_APP, user: 'orion', room: room.id } })).toBe(room.id)
    expect(agentRoomOf({ meta: { app: AGENT_SESSION_APP, user: 'nova', room: room.id } })).toBeNull()
    expect(chatOpNeedsApproval({ principalId: 'orion', credential: 'session' })).toBe(true)
    expect(chatOpNeedsApproval({ principalId: 'alice', credential: 'session' })).toBe(false)
    const privateRoom = store.openDirect({ id: 'alice', display: 'Alice' }, 'bob')
    store.post(privateRoom.slug, { id: 'alice', display: 'Alice' }, '@orion please help', ['orion'])
    expect(store.canReadRoom(privateRoom.id, 'orion')).toBe(true)
    expect(store.canReadRoom(privateRoom.id, 'nova')).toBe(false)
  } finally {
    store.close()
    resetInstanceDir()
    rmSync(dir, { recursive: true, force: true })
  }
})
