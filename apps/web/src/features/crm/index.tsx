import { Contact } from 'lucide-react'
import { defineWebFeature } from '../../feature.ts'
import { crmRoutes } from './routes.tsx'

/** Accounts, contacts, meetings, revenue. Personal data. Order band 600. */
export default defineWebFeature({
  id: 'crm',
  routes: crmRoutes,
  nav: [
    {
      id: 'crm',
      label: 'CRM',
      icon: Contact,
      to: '/crm',
      description: 'Accounts, contacts, meetings and revenue, worked one company at a time.',
      order: 600,
    },
  ],
})
