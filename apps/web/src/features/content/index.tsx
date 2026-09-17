import { Megaphone, MessagesSquare } from 'lucide-react'
import { defineWebFeature } from '../../feature.ts'
import { contentRoutes } from './routes.tsx'
import { trpc } from '../../lib/trpc.ts'
import { ChannelsView } from './views/ChannelsView.tsx'

/** Topics and pieces, channel profiles. Order band 300. */
export default defineWebFeature({
  id: 'content',
  routes: contentRoutes,
  nav: [
    {
      id: 'content',
      label: 'Content',
      icon: Megaphone,
      to: '/content',
      description: 'Topics, their per-channel pieces, and the gated path from draft to published.',
      order: 300,
    },
  ],
  // A topic's brief. The content controller addresses it as the piece id `<topic>/topic`
  // (-> `docs/content/<topic>/topic.md`): the doc surface is shared with planning, the
  // vocabularies are not, which is why a topic does not route through the planning controller.
  docs: {
    topic: {
      read: (id) => trpc.contentDoc.mutate({ id: `${id}/topic` }),
      save: (id, content) => trpc.contentDocSave.mutate({ id: `${id}/topic`, content }),
    },
  },
  settings: [{ id: 'channels', label: 'Channels', icon: MessagesSquare, order: 300, render: () => <ChannelsView /> }],
})
