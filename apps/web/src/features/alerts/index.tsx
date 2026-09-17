import { Bell, ListChecks } from 'lucide-react'
import { defineWebFeature } from '../../feature.ts'
import { alertsRoutes } from './routes.tsx'
import { AlertRulesSection } from './views/AlertsSections.tsx'

/** The alert feed and its rules. Order band 810 (next to Automation). */
export default defineWebFeature({
  id: 'alerts',
  routes: alertsRoutes,
  nav: [
    {
      id: 'alerts',
      label: 'Alerts',
      icon: Bell,
      to: '/alerts',
      description: 'Rules over the event spine, and the ledger of everything that should page somebody.',
      order: 810,
    },
  ],
  settings: [{ id: 'rules', label: 'Rules', icon: ListChecks, order: 810, render: () => <AlertRulesSection /> }],
})
