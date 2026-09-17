// LinkedIn ingest for the default `linkedin` account's member profile + its company page -
// official Community Management
// API (no browser). Member side: follower count, 1st-degree connections, lifetime post analytics
// (memberCreatorPostAnalytics). Org side (accounts.json `org`): follower count + lifetime share
// statistics. Per-post analytics ride along for every published piece the P2 publisher stamped
// with a post URN (metadata.post_urn); spec: features/data/SPEC.md.

import { defaultAccount } from '../../../accounts.js'
import { upsertBackfillSignals, type SignalRow } from '../signals/write.js'
import { autoRegisterDefinitions } from '../signals/definitions.js'
import { linkedinGet, linkedinPersonUrn } from './linkedin-client.js'
import { persist, todayUtc, type IngestProgress, type PullResult } from './types.js'

/** Lifetime member totals pulled per signal (202506 enum; more exist from 202604 on). */
const MEMBER_STATS = ['IMPRESSION', 'MEMBERS_REACHED', 'RESHARE', 'REACTION', 'COMMENT'] as const
type MemberStat = (typeof MEMBER_STATS)[number]

interface AnalyticsElement {
  count: number
  signalType: unknown
}

interface OrgShareStats {
  impressionCount?: number
  uniqueImpressionsCount?: number
  clickCount?: number
  likeCount?: number
  commentCount?: number
  shareCount?: number
  engagement?: number
}

async function memberTotal(signal: MemberStat): Promise<number | undefined> {
  const res = await linkedinGet<{ elements: AnalyticsElement[] }>(
    `/rest/memberCreatorPostAnalytics?q=me&queryType=${signal}&aggregation=TOTAL`,
  )
  return res.elements[0]?.count
}

async function postTotal(postUrn: string, signal: MemberStat): Promise<number | undefined> {
  // The entity finder takes a Restli 2.0 union, keyed by URN type: (share:urn:li:share:…) or
  // (ugc:urn:li:ugcPost:…). A bare URN is rejected with 400 "Parameter 'entity' is invalid"
  // (found live 2026-07-17 on the first stamped post).
  const key = postUrn.includes(':ugcPost:') ? 'ugc' : 'share'
  const res = await linkedinGet<{ elements: AnalyticsElement[] }>(
    `/rest/memberCreatorPostAnalytics?q=entity&entity=(${key}:${encodeURIComponent(postUrn)})` +
      `&queryType=${signal}&aggregation=TOTAL`,
  )
  return res.elements[0]?.count
}

/** A published member post another feature knows about (content's pieces). */
export interface LinkedinPostRef {
  id: string
  urn: string
  title: string
}

type LinkedinPostSource = () => Promise<LinkedinPostRef[]>
const postSources: LinkedinPostSource[] = []

/** Register the posts whose per-post analytics the LinkedIn pull should fetch. The pull itself
 *  knows nothing about content pieces; content registers this from its server module. */
export function registerLinkedinPostSource(source: LinkedinPostSource): () => void {
  postSources.push(source)
  return () => {
    const i = postSources.indexOf(source)
    if (i >= 0) postSources.splice(i, 1)
  }
}

interface PostSnapshot {
  content_id: string
  urn: string
  title: string
  impressions: number | null
  members_reached: number | null
  reactions: number | null
  comments: number | null
  reshares: number | null
}

/**
 * Per-post lifetime totals for every published linkedin or linkedin-article piece with a stamped
 * post URN (for articles the URN is the announcement feed share - the /pulse/ page itself has no
 * analytics entity). Member posts only - the entity finder reads the token holder's own creator
 * analytics; posts authored by the COMPANY PAGE are covered by the org share statistics and are
 * skipped here. Best-effort per post: one bad URN never fails the pull.
 */
async function* pullPostAnalytics(): AsyncGenerator<IngestProgress, PostSnapshot[]> {
  const pieces: LinkedinPostRef[] = []
  for (const source of postSources) pieces.push(...(await source()))
  const posts: PostSnapshot[] = []
  for (const piece of pieces) {
    const urn = piece.urn
    try {
      const totals: Partial<Record<MemberStat, number>> = {}
      for (const signal of MEMBER_STATS) totals[signal] = await postTotal(urn, signal)
      posts.push({
        content_id: piece.id,
        urn,
        title: piece.title,
        impressions: totals.IMPRESSION ?? null,
        members_reached: totals.MEMBERS_REACHED ?? null,
        reactions: totals.REACTION ?? null,
        comments: totals.COMMENT ?? null,
        reshares: totals.RESHARE ?? null,
      })
    } catch (err) {
      yield {
        channel: 'linkedin',
        phase: 'fetch',
        message: `post analytics skipped for ${piece.id}: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
      }
    }
  }
  return posts
}

/** Streaming ingest action - LinkedIn member + org signals via the Community Management API. */
export async function* ingestLinkedin(opts: { date?: string } = {}): AsyncGenerator<IngestProgress> {
  const date = opts.date ?? todayUtc()
  const account = defaultAccount('linkedin')

  yield { channel: 'linkedin', phase: 'start', message: 'Reading LinkedIn member profile…' }
  const me = await linkedinGet<{ id: string; localizedFirstName?: string; localizedLastName?: string }>('/v2/me')
  const personUrn = linkedinPersonUrn()

  const followers = (
    await linkedinGet<{ elements: Array<{ memberFollowersCount: number }> }>(
      '/rest/memberFollowersCount?q=me',
    )
  ).elements[0]?.memberFollowersCount

  const connections = (
    await linkedinGet<{ firstDegreeSize: number }>(
      `/v2/connections/${encodeURIComponent(personUrn)}`,
    )
  ).firstDegreeSize

  yield { channel: 'linkedin', phase: 'fetch', message: 'Fetching lifetime post analytics…' }
  const totals: Partial<Record<MemberStat, number>> = {}
  for (const signal of MEMBER_STATS) totals[signal] = await memberTotal(signal)

  yield { channel: 'linkedin', phase: 'fetch', message: 'Fetching per-post analytics…' }
  const posts = yield* pullPostAnalytics()

  // Org side is best-effort: a missing `org` in accounts.json or a scope/API hiccup should never
  // fail the member pull.
  let org: { urn: string; name: string | null; followers: number | null; shares: OrgShareStats } | null = null
  if (account.org) {
    yield { channel: 'linkedin', phase: 'fetch', message: 'Fetching company page statistics…' }
    const orgUrn = `urn:li:organization:${account.org}`
    try {
      const info = await linkedinGet<{ localizedName?: string }>(`/rest/organizations/${account.org}`)
      const size = await linkedinGet<{ firstDegreeSize: number }>(
        `/rest/networkSizes/${encodeURIComponent(orgUrn)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
      )
      const stats = await linkedinGet<{ elements: Array<{ totalShareStatistics?: OrgShareStats }> }>(
        `/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(orgUrn)}`,
      )
      org = {
        urn: orgUrn,
        name: info.localizedName ?? null,
        followers: size.firstDegreeSize ?? null,
        shares: stats.elements[0]?.totalShareStatistics ?? {},
      }
    } catch (err) {
      yield {
        channel: 'linkedin',
        phase: 'fetch',
        message: `org stats skipped: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
      }
    }
  }

  const snapshot = {
    channel: 'linkedin',
    date,
    fetched_at: new Date().toISOString(),
    account: {
      person_urn: personUrn,
      login: account.login,
      name: [me.localizedFirstName, me.localizedLastName].filter(Boolean).join(' '),
      followers: followers ?? null,
      connections: connections ?? null,
    },
    lifetime: {
      impressions: totals.IMPRESSION ?? null,
      members_reached: totals.MEMBERS_REACHED ?? null,
      reactions: totals.REACTION ?? null,
      comments: totals.COMMENT ?? null,
      reshares: totals.RESHARE ?? null,
    },
    posts,
    org,
  }

  yield { channel: 'linkedin', phase: 'persist', message: 'Writing snapshot + deriving signals…' }
  await persist('linkedin', date, snapshot)

  const result: PullResult = {
    channel: 'linkedin',
    date,
    summary:
      `linkedin ${date}: ${account.login} · ${(followers ?? 0).toLocaleString()} followers · ` +
      `${(totals.IMPRESSION ?? 0).toLocaleString()} lifetime impressions` +
      (org ? ` · ${org.name} ${org.followers ?? '?'} page followers` : ''),
  }
  yield { channel: 'linkedin', phase: 'done', message: result.summary, result }
}

// ----- backfill (cumulative history reconstructed from LinkedIn's daily analytics deltas) -----
//
// memberFollowersCount?q=dateRange and memberCreatorPostAnalytics aggregation=DAILY both return
// per-day DELTAS (gains), with real data starting ~2024-05 (earlier days come back as zeros = "no
// data", not "no change"). We anchor at today's live totals and walk backwards subtracting each
// day's delta, trimming the pre-history flatline before the first nonzero delta. MEMBERS_REACHED
// has no DAILY aggregation and connections have no history endpoint - neither is backfilled.

const BACKFILL_START = { year: 2023, month: 1, day: 1 }

interface DailyDelta {
  date: string
  delta: number
}

interface RestliDate {
  year: number
  month: number
  day: number
}

const isoFromParts = (p: RestliDate): string =>
  `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`

function restliDateRange(): string {
  const t = new Date(Date.now() + 86_400_000) // range end is exclusive → tomorrow covers today
  const s = BACKFILL_START
  return (
    `dateRange=(start:(year:${s.year},month:${s.month},day:${s.day}),` +
    `end:(year:${t.getUTCFullYear()},month:${t.getUTCMonth() + 1},day:${t.getUTCDate()}))`
  )
}

async function memberDailyDeltas(signal: MemberStat): Promise<DailyDelta[]> {
  const res = await linkedinGet<{ elements: Array<{ count?: number; dateRange?: { start?: RestliDate } }> }>(
    `/rest/memberCreatorPostAnalytics?q=me&queryType=${signal}&aggregation=DAILY&${restliDateRange()}`,
  )
  return res.elements
    .filter((e) => e.dateRange?.start)
    .map((e) => ({ date: isoFromParts(e.dateRange!.start!), delta: e.count ?? 0 }))
}

async function followerDailyDeltas(): Promise<DailyDelta[]> {
  const res = await linkedinGet<{
    elements: Array<{ memberFollowersCount?: number; dateRange?: { start?: RestliDate } }>
  }>(`/rest/memberFollowersCount?q=dateRange&${restliDateRange()}`)
  return res.elements
    .filter((e) => e.dateRange?.start)
    .map((e) => ({ date: isoFromParts(e.dateRange!.start!), delta: e.memberFollowersCount ?? 0 }))
}

/** Anchor at today's total, walk backwards subtracting deltas; drop the pre-history flatline. */
function reconstruct(anchor: number, deltas: DailyDelta[]): Array<{ date: string; value: number }> {
  const sorted = [...deltas].sort((a, b) => a.date.localeCompare(b.date))
  const first = sorted.findIndex((d) => d.delta > 0)
  if (first === -1) return []
  const kept = sorted.slice(first)
  const out = Array.from<{ date: string; value: number }>({ length: kept.length })
  let total = anchor
  for (let i = kept.length - 1; i >= 0; i--) {
    out[i] = { date: kept[i]!.date, value: total }
    total -= kept[i]!.delta
  }
  return out
}

/** Streaming backfill - reconstruct linkedin.* history (member since ~2024-05, org last 12mo). */
export async function* backfillLinkedin(): AsyncGenerator<IngestProgress> {
  yield { channel: 'linkedin', phase: 'start', message: 'Anchoring at current totals…' }
  const account = defaultAccount('linkedin')

  const followersNow =
    (
      await linkedinGet<{ elements: Array<{ memberFollowersCount: number }> }>(
        '/rest/memberFollowersCount?q=me',
      )
    ).elements[0]?.memberFollowersCount ?? 0

  const rows: SignalRow[] = []
  const add = (
    signal_id: string,
    label: string,
    signal_group: string,
    points: Array<{ date: string; value: number }>,
  ) =>
    rows.push(
      ...points.map((p) => ({
        channel: 'linkedin',
        signal_id,
        label,
        signal_group,
        unit: null,
        date: p.date,
        value: p.value,
        source: 'backfill' as const,
      })),
    )

  yield { channel: 'linkedin', phase: 'fetch', message: 'Fetching daily member history…' }
  add('linkedin.followers', 'Followers', 'Audience', reconstruct(followersNow, await followerDailyDeltas()))

  const specs: Array<[MemberStat, string, string, string]> = [
    ['IMPRESSION', 'linkedin.impressions', 'Impressions (lifetime)', 'Reach'],
    ['REACTION', 'linkedin.reactions', 'Reactions (lifetime)', 'Engagement'],
    ['COMMENT', 'linkedin.comments', 'Comments (lifetime)', 'Engagement'],
    ['RESHARE', 'linkedin.reshares', 'Reshares (lifetime)', 'Engagement'],
  ]
  for (const [signal, id, label, group] of specs) {
    const anchor = (await memberTotal(signal)) ?? 0
    add(id, label, group, reconstruct(anchor, await memberDailyDeltas(signal)))
  }

  if (account.org) {
    yield { channel: 'linkedin', phase: 'fetch', message: 'Fetching org follower history (12mo)…' }
    try {
      const orgUrn = `urn:li:organization:${account.org}`
      const now = Date.now()
      const orgNow = (
        await linkedinGet<{ firstDegreeSize: number }>(
          `/rest/networkSizes/${encodeURIComponent(orgUrn)}?edgeType=COMPANY_FOLLOWED_BY_MEMBER`,
        )
      ).firstDegreeSize
      const stats = await linkedinGet<{
        elements: Array<{
          timeRange?: { start: number }
          followerGains?: { organicFollowerGain?: number; paidFollowerGain?: number }
        }>
      }>(
        `/rest/organizationalEntityFollowerStatistics?q=organizationalEntity` +
          `&organizationalEntity=${encodeURIComponent(orgUrn)}` +
          `&timeIntervals=(timeRange:(start:${now - 365 * 86_400_000},end:${now}),timeGranularityType:DAY)`,
      )
      const deltas: DailyDelta[] = stats.elements
        .filter((e) => e.timeRange?.start)
        .map((e) => ({
          date: new Date(e.timeRange!.start).toISOString().slice(0, 10),
          delta: (e.followerGains?.organicFollowerGain ?? 0) + (e.followerGains?.paidFollowerGain ?? 0),
        }))
      add('linkedin.org_followers', 'Company page followers', 'Audience', reconstruct(orgNow, deltas))
    } catch (err) {
      yield {
        channel: 'linkedin',
        phase: 'fetch',
        message: `org backfill skipped: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
      }
    }
  }

  yield { channel: 'linkedin', phase: 'persist', message: `Writing ${rows.length} history points…` }
  await upsertBackfillSignals(rows)
  await autoRegisterDefinitions(rows)

  const bySignal = [...new Set(rows.map((r) => r.signal_id))]
  const earliest = rows.reduce((min, r) => (r.date < min ? r.date : min), todayUtc())
  const result: PullResult = {
    channel: 'linkedin',
    date: todayUtc(),
    summary: `backfill:linkedin: ${rows.length} points across ${bySignal.length} signal (back to ${earliest})`,
  }
  yield { channel: 'linkedin', phase: 'done', message: result.summary, result }
}
