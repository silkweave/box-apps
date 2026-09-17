import { BarChart3, Plug, Waypoints } from 'lucide-react'
import { defineWebFeature } from '../../feature.ts'
import { dataRoutes } from './routes.tsx'
import { DataSourcesSection } from './views/DataSourcesSection.tsx'
import { SignalOwnersView } from './views/SignalOwnersView.tsx'

/** Signals, circuit boards, data sources. Order band 100-199. */
export default defineWebFeature({
  id: 'data',
  routes: dataRoutes,
  nav: [
    {
      id: 'signals',
      label: 'Signals',
      icon: BarChart3,
      to: '/signals',
      description: 'Every number this team watches, with its history, its owner and its target.',
      order: 100,
    },
    // Circuit boards compose signals across channels, so they outgrew being a view inside
    // Signals - a board is a first-class object you create and name.
    {
      id: 'boards',
      label: 'Circuit Boards',
      icon: Waypoints,
      to: '/boards',
      description: 'Canvases that place signals side by side and draw what moves what.',
      order: 110,
    },
  ],
  settings: [
    { id: 'signal-owners', label: 'Signal owners', icon: BarChart3, order: 110, render: () => <SignalOwnersView /> },
    { id: 'data-sources', label: 'Data sources', icon: Plug, order: 120, render: () => <DataSourcesSection /> },
  ],
})
