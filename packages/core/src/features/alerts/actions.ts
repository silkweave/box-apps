import type { ActionSpec } from '../../ops/types.js'
import { alertsDigestAction } from './digest.js'
import { alertsGithubAction } from './github.js'
import { alertsLinkedinAction } from './linkedin.js'
import { alertsRedditAction } from './reddit.js'
import { alertsTractionAction } from './traction.js'

export const ALERTS_ACTIONS: ActionSpec[] = [
  { id: 'alerts-reddit', label: 'Reddit inbox alerts', group: 'Alerts', description: 'Browser-free unread-feed poll → record new-reply alerts (deduped)', run: alertsRedditAction },
  { id: 'alerts-github', label: 'GitHub notification alerts', group: 'Alerts', description: 'Conditional-poll (free 304s) of the participating notifications inbox', run: alertsGithubAction },
  { id: 'alerts-linkedin', label: 'LinkedIn comment alerts', group: 'Alerts', description: 'Comments on published posts → events + Inbox (API for org posts, author-browser for member posts)', run: alertsLinkedinAction },
  { id: 'alerts-traction', label: 'Traction measures', group: 'Alerts', description: 'Trailing-hour engagement per post vs the tier ladder → "taking off" alerts', run: alertsTractionAction },
  { id: 'alerts-digest', label: 'Daily engagement digest', group: 'Alerts', description: '24h recap of digest-class events (likes, follows, stars) per person', run: alertsDigestAction },
]
