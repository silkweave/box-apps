import { MessagesSquare } from 'lucide-react'
import { defineWebFeature } from '../../feature.ts'
import { chatRoutes } from './routes.tsx'
import { startChatFeed } from './lib/useChatData.ts'

/** Team chat. Order band 500. */
export default defineWebFeature({
  id: 'chat',
  routes: chatRoutes,
  nav: [
    {
      id: 'chat',
      label: 'Chat',
      icon: MessagesSquare,
      to: '/chat',
      description: 'Rooms, threads, mentions and reactions, plus the agent you can talk to in any of them.',
      order: 500,
    },
  ],
  // The chat feed arms on every route once a session exists, not lazily with the first chat
  // surface: anything app-wide that counts on it (a bell) has to see it live from the start.
  onSession: () => {
    startChatFeed()
  },
})
