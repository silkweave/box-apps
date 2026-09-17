import { CalendarClock } from 'lucide-react'
import { defineWebFeature } from '../../feature.ts'
import { automationRoutes } from './routes.tsx'
import { RestartRequiredButton } from './components/RestartRequiredButton.tsx'
import { SchedulesSection } from './views/SchedulesSection.tsx'

/** Schedules, run history, the actions console, the restart prompt. Order band 800. */
export default defineWebFeature({
  id: 'automation',
  routes: automationRoutes,
  nav: [
    {
      id: 'automation',
      label: 'Automation',
      icon: CalendarClock,
      to: '/automation',
      description: 'Cron schedules over every action this Box can run, with the history of each run.',
      order: 800,
    },
  ],
  settings: [{ id: 'schedules', label: 'Schedules', icon: CalendarClock, order: 800, render: () => <SchedulesSection /> }],
  shell: { topbar: [{ order: 100, component: RestartRequiredButton }] },
})
