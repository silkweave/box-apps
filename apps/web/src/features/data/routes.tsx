import { createRoute, Outlet, redirect } from '@tanstack/react-router'
import { rootRoute } from '../../router-root.tsx'
import { SignalsLayout } from './views/SignalsLayout.tsx'
import { SignalsGrid } from './views/SignalsGrid.tsx'
import { SignalDetailView } from './views/SignalDetailView.tsx'
import { BoardsLayout } from './views/BoardsLayout.tsx'
import { BoardsIndex } from './views/BoardsIndex.tsx'
import { BoardView } from './views/BoardView.tsx'

// Signals is a layout (shell + channel sidebar + breadcrumbs); the canvas renders through children.
const signalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signals',
  component: SignalsLayout,
})
const signalsIndexRoute = createRoute({
  getParentRoute: () => signalsRoute,
  path: '/',
  component: SignalsGrid,
})
// The single implicit board that used to live here became the top-level Circuit Boards surface -
// old links (and muscle memory) redirect, and must keep doing so forever.
const signalsBoardRoute = createRoute({
  getParentRoute: () => signalsRoute,
  path: 'board',
  beforeLoad: () => {
    throw redirect({ to: '/boards' })
  },
})
// Circuit Boards mirrors Signals: a layout (shell + one sidebar entry per board) with an index and
// a per-board canvas.
const boardsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/boards',
  component: BoardsLayout,
})
const boardsIndexRoute = createRoute({
  getParentRoute: () => boardsRoute,
  path: '/',
  component: BoardsIndex,
})
const boardDetailRoute = createRoute({
  getParentRoute: () => boardsRoute,
  path: '$id',
  component: BoardView,
})

// `$channel` is an intermediate layout that just forwards to its own children (grid or detail).
const signalsChannelRoute = createRoute({
  getParentRoute: () => signalsRoute,
  path: '$channel',
  component: Outlet,
})
const signalsChannelIndexRoute = createRoute({
  getParentRoute: () => signalsChannelRoute,
  path: '/',
  component: SignalsGrid,
})
const signalDetailRoute = createRoute({
  getParentRoute: () => signalsChannelRoute,
  path: '$signal',
  component: SignalDetailView,
})


/** Signals and Circuit Boards, direct children of rootRoute. */
export const dataRoutes = [
  signalsRoute.addChildren([
    signalsIndexRoute,
    signalsBoardRoute,
    signalsChannelRoute.addChildren([signalsChannelIndexRoute, signalDetailRoute]),
  ]),
  boardsRoute.addChildren([boardsIndexRoute, boardDetailRoute]),
] as const
