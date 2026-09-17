import { Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { chatRoomSessionRule, chatStore, closeChatStore, registerAgentSessionRule } from '@silkweave/box-core'
import { startChatOpApprovals, stopChatOpApprovals } from './chat-op-approvals.js'
import { ChatController } from './chat.controller.js'
import { startChatAgent } from '../chat-agent.js'

@Module({
  controllers: [ChatController]
})
export class ChatModule implements OnModuleInit, OnModuleDestroy {
  private unregisterSessionRule: (() => void) | null = null

  onModuleInit(): void {
    // Chat's half of core's agent-session access rule: a room's readers may READ that room's @nova
    // turn. Core knows ownership and nothing else, so on a Box without this feature the widening
    // simply does not exist. The predicate is the chat store's own membership check - the one the
    // feed, `chatAgentStatus` and the approval cards are gated on - so "may read this room's agent
    // turn" can never drift from "may read this room". Sync on purpose: workerdeck's `canSee` is,
    // and `canReadRoom` is a prepared statement. If the store throws, core refuses.
    this.unregisterSessionRule = registerAgentSessionRule(
      'chat',
      chatRoomSessionRule((roomId, userId) => chatStore().canReadRoom(roomId, userId)),
    )
    // Arm the agent's seat in chat (nova answering in rooms). A no-op unless CHAT_AGENT_ENABLED is
    // exactly '1' AND a worker is configured, so this is safe to always call. The agent HOST it
    // talks to is core (agent/workerdeck.host.ts); the seat is this feature's.
    startChatAgent()
    // Settle every chat-op approval card the last process left pending - the held operation died
    // with it. Owned here rather than by AgentModule's `startChatAgent` because a chat-op card
    // needs no agent: it is raised by the chat controller and answered by the server itself.
    startChatOpApprovals()
  }

  onModuleDestroy(): void {
    this.unregisterSessionRule?.()
    this.unregisterSessionRule = null
    // Timers first: an expiry firing after the close below would be a write into a closed handle.
    stopChatOpApprovals()
    // The store is a process-wide long-lived SQLite handle (see chatStore() in @silkweave/box-core); close
    // it on shutdown so WAL checkpoints cleanly before the self-restart's exit(86).
    closeChatStore()
  }
}
