import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../../router-root.tsx'
import { ChatLayout } from './views/ChatLayout.tsx'
import { ChatRoomView } from './views/ChatRoomView.tsx'

// Chat mirrors CRM: a layout (shell + room sidebar) whose canvas is one room. `$room` is the room
// SLUG, not its id, because that is what the server's whole chat surface keys on (every procedure
// takes `room: string`) and what people say out loud.
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  component: ChatLayout,
})
const chatIndexRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: '/',
  component: ChatRoomView,
})
const chatRoomRoute = createRoute({
  getParentRoute: () => chatRoute,
  path: '$room',
  component: ChatRoomView,
})

/** Chat, a direct child of rootRoute. */
export const chatRoutes = [
  chatRoute.addChildren([chatIndexRoute, chatRoomRoute]),
] as const
