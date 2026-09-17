import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../../router-root.tsx'
import { AlertsView } from './views/AlertsView.tsx'

// Alerts: the recorded alert history. Rules are configured under Settings → Rules.
const alertsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/alerts',
  component: AlertsView,
})

/** Alerts, a direct child of rootRoute. */
export const alertsRoutes = [alertsRoute] as const
