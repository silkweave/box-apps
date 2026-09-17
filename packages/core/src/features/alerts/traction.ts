// Traction-measure detection (alerts v2) - alert on the WAVE, not the drops. A scheduled action
// (`alerts-traction`, ~every 15 min) counts engagement events per subject (post/thread) over the
// trailing hour and fires ONE `traction.spike` alert per (subject, tier) crossed - so a post that
// keeps growing re-alerts once per tier and a plateaued post never repeats. This is where the
// digest-class kinds (likes, stars) earn near-realtime value: individually silent, but 80 in an
// hour is the actual measure. Pure query over the events table. See features/alerts/SPEC.md.

import { todayUtc, type IngestProgress } from '../../ops/types.js'
import { rulesForEvent } from './config.js'
import { subjectActivity } from '../../events.js'
import { ingestEvent } from './evaluate.js'
import { flushAlertsNow } from './flush.js'

/** Engagement kinds that count toward a subject's wave (unweighted to start - see the PRD). */
const ENGAGEMENT_KINDS = ['x.reply', 'x.mention', 'x.quote', 'x.repost', 'x.like', 'reddit.inbox', 'github.star', 'linkedin.comment']

/** Trailing window (minutes) + the default tier ladder (rule.tiers overrides). */
const WINDOW_MIN = 60
export const DEFAULT_TIERS = [10, 25, 50, 100, 250]

const KIND_NOUN: Record<string, [string, string]> = {
  'x.reply': ['reply', 'replies'],
  'x.mention': ['mention', 'mentions'],
  'x.quote': ['quote', 'quotes'],
  'x.repost': ['repost', 'reposts'],
  'x.like': ['like', 'likes'],
  'reddit.inbox': ['reddit reply', 'reddit replies'],
  'github.star': ['star', 'stars'],
  'linkedin.comment': ['linkedin comment', 'linkedin comments'],
}

function breakdown(byKind: Record<string, number>): string {
  return Object.entries(byKind)
    .sort(([, a], [, b]) => b - a)
    .map(([kind, n]) => `${n} ${KIND_NOUN[kind]?.[n === 1 ? 0 : 1] ?? kind}`)
    .join(', ')
}

/**
 * Detect subjects over a tier and ingest one `traction.spike` per (subject, highest tier crossed).
 * Dedup lives in the events insert (`traction:<subject>:<tier>`), so re-running is a no-op until
 * the NEXT tier is crossed.
 */
export async function evaluateTraction(): Promise<{ subjects: number; spikes: number }> {
  const rules = rulesForEvent('traction.spike')
  if (rules.length === 0) return { subjects: 0, spikes: 0 }
  const tiers = [...(rules[0].tiers ?? DEFAULT_TIERS)].sort((a, b) => a - b)

  const since = new Date(Date.now() - WINDOW_MIN * 60_000).toISOString()
  const activity = await subjectActivity(ENGAGEMENT_KINDS, since)

  let spikes = 0
  for (const a of activity) {
    const tier = [...tiers].reverse().find((t) => a.total >= t)
    if (tier === undefined) continue
    const { fresh } = await ingestEvent({
      kind: 'traction.spike',
      dedup_key: `traction:${a.subject}:${tier}`,
      event_at: new Date().toISOString(),
      source: 'funnel',
      subject: a.subject,
      fields: {
        count: String(a.total),
        tier: String(tier),
        window_min: String(WINDOW_MIN),
        breakdown: breakdown(a.byKind),
        url: a.latest.url,
        // A representative handle on the post: its text (from a like/reply payload) or title.
        title: String(a.latest.fields.text ?? a.latest.fields.title ?? a.subject),
      },
    })
    if (fresh) spikes++
  }
  return { subjects: activity.length, spikes }
}

/** Funnel action wrapper - detect → flush, streaming a one-line summary to automation_runs. */
export async function* alertsTractionAction(): AsyncGenerator<IngestProgress> {
  yield { channel: 'alerts-traction', phase: 'start', message: `scanning trailing ${WINDOW_MIN}min engagement…` }
  const { subjects, spikes } = await evaluateTraction()
  yield { channel: 'alerts-traction', phase: 'persist', message: `${subjects} active subject(s), ${spikes} spike(s); delivering…` }
  const { delivered, suppressed, failed, messages } = await flushAlertsNow()
  const summary =
    `alerts-traction: ${subjects} active subject(s), ${spikes} new spike(s); ` +
    `delivered ${delivered} in ${messages} message(s), suppressed ${suppressed}, failed ${failed}`
  yield {
    channel: 'alerts-traction',
    phase: 'done',
    message: summary,
    result: { channel: 'alerts-traction', date: todayUtc(), summary },
  }
}
