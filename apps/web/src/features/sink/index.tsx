import { FolderInput } from 'lucide-react'
import { defineWebFeature } from '../../feature.ts'
import { sinkRoutes } from './routes.tsx'
import { trpc } from '../../lib/trpc.ts'

/** The sink of notes. Order band 700. */
export default defineWebFeature({
  id: 'sink',
  routes: sinkRoutes,
  nav: [
    {
      id: 'sink',
      label: 'Sink',
      icon: FolderInput,
      to: '/sink',
      description: 'The markdown inbox: drop a raw note here, then hand it to an agent to work up.',
      order: 700,
    },
  ],
  // A sink doc is addressed by FILENAME (`data/docs/sink/<name>.md`), not by a row id.
  docs: {
    sink: {
      read: (name) => trpc.sinkDoc.mutate({ name }),
      save: (name, content) => trpc.sinkDocSave.mutate({ name, content }),
    },
  },
})
