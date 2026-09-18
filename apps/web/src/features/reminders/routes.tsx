import { createRoute } from '@tanstack/react-router'
import { rootRoute } from '../../router-root.tsx'
import { RemindersView } from './views/RemindersView.tsx'

// One route. A reminder has no detail worth a page of its own - everything it holds is on the row.
const remindersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/reminders',
  component: RemindersView,
})

/** Reminders, a direct child of rootRoute. */
export const remindersRoutes = [remindersRoute] as const
