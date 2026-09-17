import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../../router-root.tsx'
import { EngagementView } from './views/EngagementView.tsx'

// Engagement is one stateful view; `$section` is inbox|replies|karma (internal) or
// inbox|karma|share - an unknown section falls back to `inbox`, so old
// /engagement/<channel> links keep working. Under `replies`, `$channel` filters the list and
// `$channel/$itemId` shows one item's detail page - the landing target of the Lark alert cards'
// "Open in dashboard" button (see features/engagement/SPEC.md). The parent renders everything; children only
// register the path segments.
const engagementRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/engagement',
  component: EngagementView,
})
const engagementSectionRoute = createRoute({
  getParentRoute: () => engagementRoute,
  path: '$section',
  component: () => null,
})
const engagementChannelRoute = createRoute({
  getParentRoute: () => engagementSectionRoute,
  path: '$channel',
  component: () => null,
})
const engagementItemRoute = createRoute({
  getParentRoute: () => engagementChannelRoute,
  path: '$itemId',
  component: () => null,
})


/** Engagement, a direct child of rootRoute. */
export const engagementRoutes = [
  engagementRoute.addChildren([
    engagementSectionRoute.addChildren([engagementChannelRoute.addChildren([engagementItemRoute])]),
  ]),
] as const
