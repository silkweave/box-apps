import { createRoute, Outlet } from '@tanstack/react-router'
import { rootRoute } from '../../router-root.tsx'
import { ContentLayout } from './views/ContentLayout.tsx'
import { ContentBoard } from './views/ContentBoard.tsx'
import { ContentDetailView } from './views/ContentDetailView.tsx'
import { ContentTopicView } from './views/ContentTopicView.tsx'

// Content mirrors Initiatives in shape only: a layout (shell + topic sidebar) with a board index, a
// per-TOPIC page and a per-piece (`$topic/$channel`) detail child route. The topic is the top-level
// content object since 2026-08-12 - it is not an initiative and the planning routes know nothing
// about it.
const contentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/content',
  component: ContentLayout,
})
const contentIndexRoute = createRoute({
  getParentRoute: () => contentRoute,
  path: '/',
  component: ContentBoard,
})
// `$topic` is an intermediate layout that forwards to its children (the topic page or a piece).
const contentTopicRoute = createRoute({
  getParentRoute: () => contentRoute,
  path: '$topic',
  component: Outlet,
})
// The topic's own page: fields + briefing doc + its pieces. Not the board filtered to it, which is
// what this route rendered until 2026-08-12 and which answered "which channels exist" and stopped.
const contentTopicIndexRoute = createRoute({
  getParentRoute: () => contentTopicRoute,
  path: '/',
  component: ContentTopicView,
})
const contentDetailRoute = createRoute({
  getParentRoute: () => contentTopicRoute,
  path: '$channel',
  component: ContentDetailView,
})


/** Content, a direct child of rootRoute. */
export const contentRoutes = [
  contentRoute.addChildren([
    contentIndexRoute,
    contentTopicRoute.addChildren([contentTopicIndexRoute, contentDetailRoute]),
  ]),
] as const
