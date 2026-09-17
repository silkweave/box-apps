import { defineServerFeature } from '../../feature.js'
import { ChatModule } from './chat/chat.module.js'

/** Team chat, and the agent's seat in it. */
export default defineServerFeature({
  id: 'chat',
  module: ChatModule,
  env: [{ name: 'CHAT_AGENT_ENABLED', doc: "1 arms the chat agent (the configured agent answers in rooms); anything else leaves it off" }],
})
