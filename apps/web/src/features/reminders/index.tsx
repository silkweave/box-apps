import { AlarmClock } from 'lucide-react'
import { defineWebFeature } from '../../feature.ts'
import { remindersRoutes } from './routes.tsx'

/** Reminders. Order band 750, between the sink and the operational features. */
export default defineWebFeature({
  id: 'reminders',
  routes: remindersRoutes,
  nav: [
    {
      id: 'reminders',
      label: 'Reminders',
      icon: AlarmClock,
      to: '/reminders',
      description: 'The things this team has to be told about at a particular moment, and nothing else.',
      order: 750,
    },
  ],
})
