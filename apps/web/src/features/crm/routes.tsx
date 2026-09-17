import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../../router-root.tsx'
import { CrmLayout } from './views/CrmLayout.tsx'
import { CrmAccountsTable } from './views/CrmAccountsTable.tsx'
import { CrmAccountDetailView } from './views/CrmAccountDetailView.tsx'
import { CrmAssignQueue } from './views/CrmAssignQueue.tsx'

// CRM mirrors Initiatives: a layout (shell + status sidebar) with the ACCOUNTS table as its index
// and a per-account detail child route (contacts live on that page, they get no route of their own).
const crmRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/crm',
  component: CrmLayout,
})
const crmIndexRoute = createRoute({
  getParentRoute: () => crmRoute,
  path: '/',
  component: CrmAccountsTable,
})
// The queue is a static segment and must be registered BEFORE `$id` reads it as an account slug -
// TanStack ranks static over param, so both may coexist, but the order is the readable statement.
const crmQueueRoute = createRoute({
  getParentRoute: () => crmRoute,
  path: 'queue',
  component: CrmAssignQueue,
})
const crmAccountRoute = createRoute({
  getParentRoute: () => crmRoute,
  path: '$id',
  component: CrmAccountDetailView,
})


/** CRM, a direct child of rootRoute. */
export const crmRoutes = [
  crmRoute.addChildren([crmIndexRoute, crmQueueRoute, crmAccountRoute]),
] as const
