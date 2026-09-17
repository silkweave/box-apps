import { CalendarRange, Tags, Target } from 'lucide-react'
import { defineWebFeature } from '../../feature.ts'
import { planningRoutes } from './routes.tsx'
import { trpc } from '../../lib/trpc.ts'
import { InitiativeKindsSection } from './views/InitiativeKindsSection.tsx'

/** Initiatives, tasks, sprints. Order band 200-299. */
export default defineWebFeature({
  id: 'planning',
  routes: planningRoutes,
  nav: [
    {
      id: 'initiatives',
      label: 'Initiatives',
      icon: Target,
      to: '/initiatives',
      description: 'Bodies of work bound to the signals they are meant to move, each with its rationale.',
      order: 200,
    },
    // Sprints is its own group rather than a tab inside Initiatives: a sprint is a first-class
    // object with its own lifecycle, and the Active Sprint board is a daily-driver surface.
    {
      id: 'sprints',
      label: 'Sprints',
      icon: CalendarRange,
      to: '/sprints',
      description: 'Windows of days with real per-person capacity, and the tasks slotted into them.',
      order: 210,
    },
  ],
  // The two doc families the planning controller serves. Same procedure, `kind` selects the tree.
  docs: {
    initiative: {
      read: (id) => trpc.planningDoc.mutate({ kind: 'initiative', id }),
      save: (id, content) => trpc.planningDocSave.mutate({ kind: 'initiative', id, content }),
    },
    task: {
      read: (id) => trpc.planningDoc.mutate({ kind: 'task', id }),
      save: (id, content) => trpc.planningDocSave.mutate({ kind: 'task', id, content }),
    },
  },
  settings: [
    { id: 'initiative-kinds', label: 'Initiative kinds', icon: Tags, order: 200, render: () => <InitiativeKindsSection /> },
  ],
})
