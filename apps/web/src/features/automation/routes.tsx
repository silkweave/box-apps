import { createRoute, redirect } from '@tanstack/react-router'
import { rootRoute } from '../../router-root.tsx'
import { AutomationView } from './views/AutomationView.tsx'

// Automation is one stateful view; `$section` is runs|actions and `$runId` deep-links a
// run's detail (the parent renders everything; children only register the path segments). The old
// `schedules` section moved to Settings - its links redirect.
const automationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/automation',
  component: AutomationView,
})
const automationSectionRoute = createRoute({
  getParentRoute: () => automationRoute,
  path: '$section',
  beforeLoad: ({ params }) => {
    if ((params as { section: string }).section === 'schedules')
      throw redirect({ to: '/settings/$section', params: { section: 'schedules' } })
  },
  component: () => null,
})
const automationRunRoute = createRoute({
  getParentRoute: () => automationSectionRoute,
  path: '$runId',
  component: () => null,
})


/** Automation, a direct child of rootRoute. */
export const automationRoutes = [
  automationRoute.addChildren([automationSectionRoute.addChildren([automationRunRoute])]),
] as const
