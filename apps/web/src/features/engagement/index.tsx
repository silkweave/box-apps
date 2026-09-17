import { Boxes, HeartHandshake } from 'lucide-react'
import { defineWebFeature } from '../../feature.ts'
import { engagementRoutes } from './routes.tsx'
import { PodsAdminSection } from './views/PodsSections.tsx'
import { PodEngagementPanel } from './components/PodEngagementPanel.tsx'

/** Pods, the tactical inbox (replies), karma. Order band 400. */
export default defineWebFeature({
  id: 'engagement',
  routes: engagementRoutes,
  nav: [
    {
      id: 'engagement',
      label: 'Engagement',
      icon: HeartHandshake,
      to: '/engagement',
      description: 'Pods, the tactical inbox, and the replies somebody still owes a post.',
      order: 400,
    },
  ],
  settings: [{ id: 'pods', label: 'Pods', icon: Boxes, order: 400, render: () => <PodsAdminSection /> }],
  slots: { 'content.piece.panel': [PodEngagementPanel] },
})
