// Derive the tidy long-format `signals` signal from the raw `snapshots` table - the warehouse-native
// successor to dashboard/scripts/build-data.ts (which read data/<channel>/<date>.json and emitted
// signals.json). Each ingest action calls deriveSignals(itsChannel) after upserting a snapshot, so
// the dashboard's `signalsData` query stays current with no separate build step.
//
// The dashboard "channel" of a signal can differ from the snapshot folder it came from (e.g.
// reddit-engagement snapshots feed reddit.* signal), so derivers are keyed by dashboard channel and
// read whatever snapshot channels they need.

import { withRead } from '../../../warehouse/db.js'
import { replaceChannelSignals, type SignalRow } from './write.js'
import { accountChannel, channelAccounts, splitChannel } from '../../../accounts.js'
import { dailyKindCounts } from '../../../events.js'
import { todayUtc } from '../../../ops/types.js'
import { autoRegisterDefinitions } from './definitions.js'
import { contributedChannelRows } from './hooks.js'

/**
 * Base dashboard channels we derive **in-process** (snapshot folders fan in per deriver).
 * github is account-scoped: each non-default account in config/accounts.json adds a dynamic
 * `github@<id>` channel (same deriver, namespaced signal ids). See docs/WAREHOUSE.md.
 */
export const DERIVED_CHANNELS = ['github', 'reddit', 'x', 'linkedin', 'npm', 'blog', 'hackernews', 'substack'] as const
export type DerivedChannel = (typeof DERIVED_CHANNELS)[number]

/** Is this channel derivable in-process? Accepts account-scoped variants ('github@bob'). */
export function isDerivedChannel(channel: string): boolean {
  return (DERIVED_CHANNELS as readonly string[]).includes(splitChannel(channel).base)
}

interface Snap {
  date: string
  data: any
}

/** Load a snapshot folder's rows from the warehouse, ascending by date, payload parsed. */
async function loadSnapshots(snapshotChannel: string): Promise<Snap[]> {
  const rows = await withRead<{ date: string; payload: unknown }>(
    `SELECT CAST(snapshot_date AS VARCHAR) AS date, payload FROM snapshots WHERE channel = ? ORDER BY snapshot_date`,
    [snapshotChannel],
  )
  return rows.map((r) => ({
    date: r.date,
    data: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
  }))
}

/** Accumulates (signal, date) points, dedup by date within a signal - mirrors build-data's add(). */
class Builder {
  private readonly map = new Map<string, SignalRow & { _dates: Set<string> }>()
  constructor(private readonly channel: string) {}

  add(id: string, label: string, group: string, date: string, value: number | undefined, unit?: string): void {
    if (value == null || Number.isNaN(value)) return
    let s = this.map.get(id)
    if (!s) {
      s = { channel: this.channel, signal_id: id, label, signal_group: group, unit: unit ?? null, date, value, _dates: new Set() }
      this.map.set(id, s)
    }
    if (s._dates.has(date)) return
    s._dates.add(date)
    this.rows.push({ channel: this.channel, signal_id: id, label, signal_group: group, unit: unit ?? null, date, value })
  }

  readonly rows: SignalRow[] = []
}

/** Account-scoped: `channel` is 'github' (default account, legacy ids) or 'github@<account>'. */
async function deriveGithub(channel: string): Promise<SignalRow[]> {
  const b = new Builder(channel)
  for (const { date, data } of await loadSnapshots(channel)) {
    b.add(`${channel}.followers`, 'Followers', 'Audience', date, data.user?.followers)
    b.add(`${channel}.public_repos`, 'Public repos', 'Audience', date, data.user?.public_repos)
    b.add(`${channel}.oss_prs`, 'External PRs authored', 'Open source', date, data.oss_prs_authored_external)
    b.add(`${channel}.org_followers`, 'Org followers', 'Audience', date, data.org?.followers)
    for (const r of data.repos ?? []) {
      const name = String(r.full_name).split('/')[1] ?? r.full_name
      b.add(`${channel}.stars.${name}`, `${name} ★`, 'Stars', date, r.stars)
      const tv = r.traffic_views
      if (tv && typeof tv === 'object' && typeof tv.count === 'number') {
        b.add(`${channel}.views.${name}`, `${name} views (14d)`, 'Traffic', date, tv.count)
        b.add(`${channel}.uniques.${name}`, `${name} unique views (14d)`, 'Traffic', date, tv.uniques)
      }
    }
  }
  // Other features may keep signals on this channel (planning's task-ledger signal rides on
  // github). They must ride along here: replaceChannelSignals wipes the channel's live rows.
  b.rows.push(...(await contributedChannelRows(channel)))
  return b.rows
}

async function deriveReddit(): Promise<SignalRow[]> {
  const b = new Builder('reddit')
  for (const { date, data } of await loadSnapshots('reddit')) {
    b.add('reddit.total_karma', 'Karma (total)', 'Profile', date, data.account?.total_karma)
    b.add('reddit.link_karma', 'Post karma', 'Profile', date, data.account?.link_karma)
    b.add('reddit.comment_karma', 'Comment karma', 'Profile', date, data.account?.comment_karma)
    b.add('reddit.posts', 'Posts', 'Activity', date, data.counts?.posts)
    b.add('reddit.comments', 'Comments', 'Activity', date, data.counts?.comments)
    const topPost = (data.top_posts ?? [])[0]
    if (topPost) b.add('reddit.top_post_score', 'Top post score', 'Reach', date, topPost.score)
  }
  for (const { date, data } of await loadSnapshots('reddit-engagement')) {
    const engagements = data.engagements ?? []
    const open = engagements.filter((e: any) => !e.answered).length
    b.add('reddit.engagement_open', 'Open replies (awaiting you)', 'Engagement', date, open)
  }
  return b.rows
}

/**
 * Incoming engagement kinds counted into `x.engagement` - mirrors the traction job's x kinds
 * (see alerts/traction.ts). Follows are audience (tracked by x.followers), not engagement.
 */
export const X_ENGAGEMENT_KINDS = ['x.reply', 'x.mention', 'x.quote', 'x.repost', 'x.like']

/**
 * Rows for the event-derived `x.engagement` signal (alerts v2): daily count of incoming engagement
 * events, straight off the `events` table - a query, not a new intake path. Zero-filled from the
 * first event through today so quiet days read as 0 instead of an interpolated gap. Rides along in
 * deriveX for the pull path; ingestEvent re-writes just the signal on each fresh x engagement
 * event (same pattern as the task-ledger signal, see warehouse/db.ts replaceSignalRows).
 */
export async function computeXEngagementRows(): Promise<SignalRow[]> {
  const counts = await dailyKindCounts(X_ENGAGEMENT_KINDS)
  if (counts.length === 0) return []
  const byDate = new Map(counts.map((c) => [c.date, c.value]))
  const rows: SignalRow[] = []
  for (let d = new Date(`${counts[0].date}T00:00:00Z`), end = todayUtc(); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10)
    rows.push({
      channel: 'x',
      signal_id: 'x.engagement',
      label: 'Engagement events (day)',
      signal_group: 'Engagement',
      unit: null,
      date,
      value: byDate.get(date) ?? 0,
    })
    if (date >= end) break
  }
  return rows
}

async function deriveX(): Promise<SignalRow[]> {
  const b = new Builder('x')
  for (const { date, data } of await loadSnapshots('x')) {
    b.add('x.followers', 'Followers', 'Audience', date, data.account?.followers)
    b.add('x.following', 'Following', 'Audience', date, data.account?.following)
    b.add('x.posts', 'Posts', 'Activity', date, data.account?.tweets)
    b.add('x.impressions', 'Impressions (recent posts)', 'Reach', date, data.counts?.impressions_total)
  }
  b.rows.push(...(await computeXEngagementRows()))
  return b.rows
}

async function deriveLinkedin(): Promise<SignalRow[]> {
  const b = new Builder('linkedin')
  for (const { date, data } of await loadSnapshots('linkedin')) {
    b.add('linkedin.followers', 'Followers', 'Audience', date, data.account?.followers)
    b.add('linkedin.connections', 'Connections', 'Audience', date, data.account?.connections)
    b.add('linkedin.impressions', 'Impressions (lifetime)', 'Reach', date, data.lifetime?.impressions)
    b.add('linkedin.members_reached', 'Members reached (lifetime)', 'Reach', date, data.lifetime?.members_reached)
    b.add('linkedin.reactions', 'Reactions (lifetime)', 'Engagement', date, data.lifetime?.reactions)
    b.add('linkedin.comments', 'Comments (lifetime)', 'Engagement', date, data.lifetime?.comments)
    b.add('linkedin.reshares', 'Reshares (lifetime)', 'Engagement', date, data.lifetime?.reshares)
    b.add('linkedin.org_followers', 'Company page followers', 'Audience', date, data.org?.followers)
    b.add('linkedin.org_impressions', 'Company page impressions (lifetime)', 'Reach', date, data.org?.shares?.impressionCount)
  }
  return b.rows
}

const NPM_TOP_PACKAGES = 6

/** npm live signal - all-package weekly/monthly totals + the top-N per-package + tracked packages. */
async function deriveNpm(): Promise<SignalRow[]> {
  const b = new Builder('npm')
  for (const { date, data } of await loadSnapshots('npm')) {
    b.add('npm.week', 'Downloads / week (all pkgs)', 'Downloads', date, data.totals?.last_week, 'dl')
    b.add('npm.month', 'Downloads / month (all pkgs)', 'Downloads', date, data.totals?.last_month, 'dl')
    const pkgs = data.packages ?? {}
    const top = Object.entries(pkgs)
      .map(([name, v]) => ({ name, week: (v as { last_week?: number }).last_week ?? 0 }))
      .sort((a, c) => c.week - a.week)
      .slice(0, NPM_TOP_PACKAGES)
    for (const p of top) b.add(`npm.pkg.${p.name}`, `${p.name} / wk`, 'Top packages', date, p.week, 'dl')
    // Standalone tracked packages always get a signal, regardless of the top-N cut.
    const tracked = data.tracked ?? {}
    for (const [name, v] of Object.entries(tracked)) {
      b.add(`npm.pkg.${name}`, `${name} / wk`, 'Top packages', date, (v as { last_week?: number }).last_week, 'dl')
    }
  }
  return b.rows
}

/** blog live signal - the configured feed's publishing cadence + GA4 daily traffic. */
async function deriveBlog(): Promise<SignalRow[]> {
  const b = new Builder('blog')
  const snaps = await loadSnapshots('blog')
  for (const { date, data } of snaps) {
    b.add('blog.posts', 'Posts published', 'Content', date, data.counts?.posts)
  }
  // GA4 rows are keyed by the snapshot's `ga4.daily` dates (a rolling 28-day window), so
  // consecutive snapshots overlap. The Builder keeps the first value it sees per date - iterate
  // newest snapshot first so the freshest GA4 numbers win (GA4 data settles for ~48h).
  for (const { data } of [...snaps].reverse()) {
    for (const d of data.ga4?.daily ?? []) {
      b.add('blog.sessions', 'Sessions (day)', 'Traffic', d.date, d.sessions)
      b.add('blog.users', 'Users (day)', 'Traffic', d.date, d.total_users)
      b.add('blog.pageviews', 'Pageviews (day)', 'Traffic', d.date, d.pageviews)
    }
  }
  return b.rows
}

/** hackernews live signal - karma, submissions, site-wide brand mentions. */
async function deriveHackernews(): Promise<SignalRow[]> {
  const b = new Builder('hackernews')
  for (const { date, data } of await loadSnapshots('hackernews')) {
    b.add('hn.karma', 'Karma', 'Profile', date, data.profile?.karma)
    b.add('hn.submissions', 'Submissions', 'Profile', date, data.profile?.submission_count)
    const mentions = data.mentions ?? {}
    const total = Object.values(mentions).reduce((n: number, arr: any) => n + (Array.isArray(arr) ? arr.length : 0), 0)
    b.add('hn.mentions', 'Brand mentions (site-wide)', 'Reach', date, total)
  }
  return b.rows
}

/**
 * The subscriber count, dug out of `/publish-dashboard/summary`.
 *
 * **Not reachable today.** Probed live 2026-08-16 against a real publication: every
 * subscriber-facing endpoint answers `403 Not authorized` on a session that is definitely signed in
 * (`/user/profile/self`, `/publication`, `/post_management/*` and `/publication/stats/email_stats`
 * all answer 200 on the same cookie). It is not a header or fingerprint problem - identical requests
 * with a full browser header set get the same 403 - so it reads as a per-publication gate on a
 * newsletter that has not launched or taken a payment yet, not as something a caller can fix.
 *
 * So this stays defensive rather than being deleted: the field name is unconfirmed, and if the gate
 * lifts as the publication matures the signal starts appearing with no code change. Finding nothing
 * yields NO ROW rather than a zero - a fabricated 0 subscribers would render as a real collapse,
 * while a gap reads as what it is. The raw payload is snapshotted either way, so the day the true
 * shape is known the whole history re-derives without a re-pull.
 */
function subscriberCount(summary: any): number | undefined {
  const candidates = [
    summary?.total_subscribers,
    summary?.subscriber_count,
    summary?.subscribers,
    summary?.free_subscribers,
    summary?.emailSubscribers,
    summary?.stats?.total_subscribers,
    summary?.subscriberCounts?.total,
  ]
  return candidates.find((v) => typeof v === 'number')
}

/** Paid subscribers, same caveat and same policy as the free count above. */
function paidCount(summary: any): number | undefined {
  const candidates = [summary?.paid_subscribers, summary?.paidSubscribers, summary?.stats?.paid_subscribers]
  return candidates.find((v) => typeof v === 'number')
}

/** substack live signal - publishing cadence plus whatever the dashboard stats endpoints yield. */
async function deriveSubstack(): Promise<SignalRow[]> {
  const b = new Builder('substack')
  for (const { date, data } of await loadSnapshots('substack')) {
    b.add('substack.posts', 'Posts published', 'Content', date, data.counts?.published)
    b.add('substack.drafts', 'Drafts open', 'Content', date, data.counts?.drafts)
    b.add('substack.subscribers', 'Subscribers', 'Audience', date, subscriberCount(data.stats?.summary))
    b.add('substack.paid_subscribers', 'Paid subscribers', 'Audience', date, paidCount(data.stats?.summary))
    // `/publication/stats/email_stats/30d_open_rate` answers `{openRate, openRateDiff}` (confirmed
    // live). No unit is declared: with no email ever sent from this publication the only value seen
    // is 0, which cannot distinguish a fraction from a percentage, and stamping '%' on a 0.42 would
    // render a 42% open rate as 0.42%. Set the unit once a real send proves the scale.
    b.add('substack.open_rate', 'Open rate (30d)', 'Engagement', date, numberOf(data.stats?.open_rate))
    b.add('substack.views', 'Views (30d)', 'Reach', date, numberOf(data.stats?.views_30d))
    // The per-post stats table doubles as an honest count of posts that have email stats at all.
    b.add('substack.posts_with_stats', 'Posts with email stats', 'Content', date, data.post_stats?.total)
  }
  return b.rows
}

/** A number, whether it arrived bare or wrapped in a one-key envelope. `openRate` is not a guess:
 *  it is the key `/publication/stats/email_stats/30d_open_rate` actually answers with. */
function numberOf(v: any): number | undefined {
  if (typeof v === 'number') return v
  for (const key of ['value', 'count', 'total', 'rate', 'views', 'openRate']) {
    if (typeof v?.[key] === 'number') return v[key]
  }
  return undefined
}

const DERIVERS: Record<DerivedChannel, (channel: string) => Promise<SignalRow[]>> = {
  github: deriveGithub,
  reddit: () => deriveReddit(),
  x: () => deriveX(),
  linkedin: () => deriveLinkedin(),
  npm: () => deriveNpm(),
  blog: () => deriveBlog(),
  hackernews: () => deriveHackernews(),
  substack: () => deriveSubstack(),
}

/** Re-derive one dashboard channel's live signal rows from its snapshots and persist them. */
export async function deriveSignals(channel: string): Promise<number> {
  const { base } = splitChannel(channel)
  const deriver = DERIVERS[base as DerivedChannel]
  if (!deriver) throw new Error(`no in-process deriver for channel "${channel}"`)
  const rows = await deriver(channel)
  await replaceChannelSignals(channel, rows)
  // Any signal this derive introduced gets a registry definition (existing ones are untouched).
  await autoRegisterDefinitions(rows)
  return rows.length
}

/** Every in-process channel incl. dynamic account-scoped ones ('github@bob') from accounts.json. */
export function derivedChannelIds(): string[] {
  const githubAccounts = channelAccounts('github').map((a) => accountChannel('github', a))
  return [...new Set(['github', ...githubAccounts, 'reddit', 'x', 'linkedin', 'npm', 'blog', 'hackernews', 'substack'])]
}

/** Re-derive every channel - used by the one-time bootstrap and as a manual full refresh. */
export async function deriveAllSignals(): Promise<number> {
  let n = 0
  for (const c of derivedChannelIds()) n += await deriveSignals(c)
  return n
}
