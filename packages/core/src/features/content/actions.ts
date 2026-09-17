// The content feature's runnable actions: the gated publishers. A person triggers each parameterized
// one (never schedulable) and, because these SEND for real, they also demand confirm:"true". The two
// "due" publishers are schedulable and dry-run unless their *_PUBLISH_LIVE env is 1.

import type { ActionSpec } from '../../ops/types.js'
import { linkedinArticleDraftAction, linkedinArticlePublishAction } from './linkedin-article.js'
import { linkedinPublishAction, linkedinPublishApprovedAction } from './linkedin-publish.js'
import { substackDraftAction, substackPublishAction, substackPublishDueAction } from './substack-publish.js'

const withActor = (params: Record<string, string> | undefined): { actor?: string } =>
  params?.actor ? { actor: params.actor } : {}

export const CONTENT_ACTIONS: ActionSpec[] = [
  {
    id: 'linkedin-publish',
    label: 'LinkedIn publish',
    group: 'Content',
    description: 'POST an approved linkedin piece via the Posts API (params: content_id, confirm:"true")',
    parameterized: true,
    run: ({ params }) => linkedinPublishAction({ content_id: params?.content_id ?? '', confirm: params?.confirm ?? '', ...withActor(params) }),
  },
  // The SCHEDULABLE publisher: most urgent DUE linkedin/linkedin-article piece (approved, or
  // scheduled with scheduled_at passed), cap 1/run, dry-run unless LINKEDIN_PUBLISH_LIVE=1.
  {
    id: 'linkedin-publish-approved',
    label: 'LinkedIn publish due',
    group: 'Content',
    description: "Publish the most urgent DUE linkedin piece - posts via the API, articles via the author's browser (cap 1/run; dry-run unless LINKEDIN_PUBLISH_LIVE=1)",
    run: () => linkedinPublishApprovedAction(),
  },
  // Newsletter articles have NO official API - both article ops drive the author's own browser
  // (CDP). The draft op never publishes; the publish op is the full gated send.
  {
    id: 'linkedin-article-draft',
    label: 'LinkedIn article draft',
    group: 'Content',
    description: "Create a newsletter-article DRAFT in the author's browser from an approved linkedin-article piece (params: content_id)",
    parameterized: true,
    run: ({ params }) => linkedinArticleDraftAction({ content_id: params?.content_id ?? '', ...withActor(params) }),
  },
  {
    id: 'linkedin-article-publish',
    label: 'LinkedIn article publish',
    group: 'Content',
    description: "Publish a DUE linkedin-article piece end-to-end in the author's browser: cover + caption, title, body, announcement post, Publish (params: content_id, confirm:\"true\")",
    parameterized: true,
    run: ({ params }) => linkedinArticlePublishAction({ content_id: params?.content_id ?? '', confirm: params?.confirm ?? '', ...withActor(params) }),
  },
  // Substack reaches a real write API (the dashboard's own private one), so there is no browser in
  // the publish path - only in minting the session cookie. The draft op is safe at any point in
  // authoring; only `substack-publish` makes anything public, and only `metadata.send_email` mails.
  {
    id: 'substack-draft',
    label: 'Substack draft',
    group: 'Content',
    description: 'Push a substack piece into a Substack DRAFT (creates it, or updates the one the piece already has). Never publishes (params: content_id)',
    parameterized: true,
    run: ({ params }) => substackDraftAction({ content_id: params?.content_id ?? '', ...withActor(params) }),
  },
  {
    id: 'substack-publish',
    label: 'Substack publish',
    group: 'Content',
    description: 'Publish a DUE substack piece via the private API; emails the list only if metadata.send_email is true (params: content_id, confirm:"true")',
    parameterized: true,
    run: ({ params }) => substackPublishAction({ content_id: params?.content_id ?? '', confirm: params?.confirm ?? '', ...withActor(params) }),
  },
  {
    id: 'substack-publish-due',
    label: 'Substack publish due',
    group: 'Content',
    description: 'Publish the most urgent DUE substack piece (cap 1/run; dry-run unless SUBSTACK_PUBLISH_LIVE=1)',
    run: () => substackPublishDueAction(),
  },
]
