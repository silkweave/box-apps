// The data feature's runnable actions: every in-process pull and backfill, the data-source sync,
// and the full re-derive. Contributed to core's registry through the manifest.

import { todayUtc, type ActionSpec, type IngestProgress } from '../../ops/types.js'
import {
  backfillLinkedin,
  backfillNpm,
  backfillPrs,
  backfillStars,
  backfillX,
  ingestBlog,
  ingestGithub,
  ingestGithubEngagement,
  ingestHackerNews,
  ingestLinkedin,
  ingestNpm,
  ingestReddit,
  ingestRedditEngagement,
  ingestSubstack,
  ingestX,
  redditRadar,
} from './pulls/index.js'
import { deriveAllSignals } from './signals/derive.js'
import { signalHooks } from './signals/hooks.js'
import { sourceSyncAction, sourcesSyncAction } from './sources/actions.js'

const pull = (
  info: Omit<ActionSpec, 'run' | 'group'>,
  run: () => AsyncGenerator<IngestProgress>,
  group = 'Pulls',
): ActionSpec => ({ ...info, group, run })

async function* deriveAction(): AsyncGenerator<IngestProgress> {
  yield { channel: 'warehouse', phase: 'start', message: 're-deriving all signals' }
  const rows = await deriveAllSignals() // every in-process channel
  yield { channel: 'warehouse', phase: 'persist', message: `re-derived ${rows} in-process rows` }
  // Features that keep outcome signals in the warehouse (planning's task ledger, content's
  // published count) contribute a derive step through the hooks port.
  const extra: string[] = []
  for (const h of signalHooks()) {
    if (!h.derive) continue
    const n = await h.derive()
    extra.push(`+${n} ${h.id}`)
  }
  if (extra.length) yield { channel: 'warehouse', phase: 'persist', message: `re-derived outcome signals (${extra.join(', ')})` }
  const summary = `re-derived ${rows} in-process rows${extra.length ? ` (${extra.join(', ')})` : ''}`
  yield { channel: 'warehouse', phase: 'done', message: summary, result: { channel: 'warehouse', date: todayUtc(), summary } }
}

export const DATA_ACTIONS: ActionSpec[] = [
  pull({ id: 'github', label: 'GitHub signals', description: 'Followers, repo stars/forks, OSS PRs' }, ingestGithub),
  pull({ id: 'github-engagement', label: 'GitHub engagement', description: 'Issue/PR engagement awaiting a reply' }, ingestGithubEngagement),
  pull({ id: 'x', label: 'X / Twitter', description: 'Profile + per-post organic signals' }, ingestX),
  pull({ id: 'linkedin', label: 'LinkedIn signals', description: 'Member + page analytics via the Community Management API' }, ingestLinkedin),
  pull({ id: 'reddit', label: 'Reddit signals', description: 'Account/karma via the stealth browser' }, ingestReddit),
  pull({ id: 'reddit-engagement', label: 'Reddit engagement', description: 'Inbox replies awaiting you' }, ingestRedditEngagement),
  pull({ id: 'reddit-radar', label: 'Reddit topic radar', description: 'Scan target subs for openings' }, redditRadar),
  pull({ id: 'npm-pull', label: 'npm downloads', description: 'Weekly download counts across the configured packages' }, ingestNpm),
  pull({ id: 'blog-pull', label: 'Blog RSS', description: 'Publishing cadence from the blog feed' }, ingestBlog),
  pull({ id: 'hackernews-pull', label: 'Hacker News', description: 'Profile, submissions, brand mentions' }, ingestHackerNews),
  pull({ id: 'substack-pull', label: 'Substack signals', description: 'Publication archive + subscribers/open rate via the private API (needs a session cookie)' }, ingestSubstack),
  pull({ id: 'sources-sync', label: 'Data sources sync', description: 'Pull every ENABLED data source (Settings → Data sources) into the signals bound to it; one bad source does not stop the others' }, sourcesSyncAction),
  pull({ id: 'backfill-prs', label: 'Backfill OSS PRs', description: 'External PRs authored (enumerated)' }, backfillPrs, 'Backfills'),
  pull({ id: 'backfill-stars', label: 'Backfill stars', description: 'Repo star history' }, backfillStars, 'Backfills'),
  pull({ id: 'backfill-x', label: 'Backfill X posts', description: 'Posting cadence from tweet timestamps' }, backfillX, 'Backfills'),
  pull({ id: 'backfill-linkedin', label: 'Backfill LinkedIn', description: 'Follower + engagement history reconstructed from daily analytics deltas' }, backfillLinkedin, 'Backfills'),
  pull({ id: 'npm-backfill', label: 'Backfill npm', description: 'Weekly download history (~17 months)' }, backfillNpm, 'Backfills'),
  pull({ id: 'warehouse-derive', label: 'Re-derive signals', description: "Re-derive every channel's signals from raw snapshots" }, deriveAction, 'Warehouse'),
  {
    id: 'source-sync',
    label: 'Sync one data source',
    group: 'Pulls',
    description: 'Pull ONE data source, disabled ones included - the supervised first run before a source is armed (params: source_id)',
    parameterized: true,
    run: (opts) => sourceSyncAction({ source_id: opts.params?.source_id ?? '' }),
  },
]
