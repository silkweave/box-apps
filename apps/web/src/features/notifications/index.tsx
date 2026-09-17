import { defineWebFeature } from '../../feature.ts'
import { router } from '../../router.tsx'
import { NotificationBell } from './components/NotificationBell.tsx'
import { startNotifications } from './lib/useNotifications.ts'
import { listenPushNavigate } from './lib/push.ts'

/** The bell (chat mentions + alerts) and push-click navigation. Glue over chat and alerts. */
export default defineWebFeature({
  id: 'notifications',
  routes: [],
  shell: { topbar: [{ order: 200, component: NotificationBell }] },
  onSession: () => {
    // The bell is app-wide chrome, so it arms on every route once a session exists.
    startNotifications()
    // A push-notification click focuses this tab and posts push:navigate; route client-side so
    // the SPA does not reload. Returns the unlisten, which the session hook wires as teardown.
    return listenPushNavigate((to) => void router.navigate({ to }))
  },
})
