import { createRoute, Outlet } from '@tanstack/react-router'
import { rootRoute } from '../../router-root.tsx'
import { InitiativesLayout } from './views/InitiativesLayout.tsx'
import { SprintsLayout } from './views/SprintsLayout.tsx'
import { SprintsIndex } from './views/SprintsIndex.tsx'
import { SprintDetailView } from './views/SprintDetailView.tsx'
import { InitiativesGrid } from './views/InitiativesGrid.tsx'
import { InitiativeDetailView } from './views/InitiativeDetailView.tsx'
import { TaskDetailView } from './views/TaskDetailView.tsx'

// Initiatives mirrors Signals: a layout (shell + initiative sidebar) with an overview index and a
// per-initiative detail child route.
const initiativesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/initiatives',
  component: InitiativesLayout,
})
const initiativesIndexRoute = createRoute({
  getParentRoute: () => initiativesRoute,
  path: '/',
  component: InitiativesGrid,
})
// `$id` is an intermediate layout that forwards to its children (the initiative detail or a task).
const initiativeRoute = createRoute({
  getParentRoute: () => initiativesRoute,
  path: '$id',
  component: Outlet,
})
const initiativeIndexRoute = createRoute({
  getParentRoute: () => initiativeRoute,
  path: '/',
  component: InitiativeDetailView,
})
const taskDetailRoute = createRoute({
  getParentRoute: () => initiativeRoute,
  path: '$taskSlug',
  component: TaskDetailView,
})

// Sprints mirrors Initiatives: a layout (shell + a sidebar of every sprint) with an index and a
// per-sprint canvas. `$tab` is design|planning|board - one surface, three views, and the tab that
// OPENS is chosen from the sprint's status when the URL does not name one.
const sprintsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sprints',
  component: SprintsLayout,
})
const sprintsIndexRoute = createRoute({
  getParentRoute: () => sprintsRoute,
  path: '/',
  component: SprintsIndex,
})
const sprintRoute = createRoute({
  getParentRoute: () => sprintsRoute,
  path: '$id',
  component: Outlet,
})
const sprintIndexRoute = createRoute({
  getParentRoute: () => sprintRoute,
  path: '/',
  component: SprintDetailView,
})
const sprintTabRoute = createRoute({
  getParentRoute: () => sprintRoute,
  path: '$tab',
  component: SprintDetailView,
})


/** Initiatives and Sprints, direct children of rootRoute. */
export const planningRoutes = [
  initiativesRoute.addChildren([
    initiativesIndexRoute,
    initiativeRoute.addChildren([initiativeIndexRoute, taskDetailRoute]),
  ]),
  sprintsRoute.addChildren([sprintsIndexRoute, sprintRoute.addChildren([sprintIndexRoute, sprintTabRoute])]),
] as const
