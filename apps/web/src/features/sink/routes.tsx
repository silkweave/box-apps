import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../../router-root.tsx'
import { SinkView } from './views/SinkView.tsx'

// Sink mirrors Inbox: one stateful view that reads the active filename from the `$file` param; the
// child route only registers the path segment.
const sinkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sink',
  component: SinkView,
})
const sinkFileRoute = createRoute({
  getParentRoute: () => sinkRoute,
  path: '$file',
  component: () => null,
})


/** Sink, a direct child of rootRoute. */
export const sinkRoutes = [
  sinkRoute.addChildren([sinkFileRoute]),
] as const
