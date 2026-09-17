// Daily digest (alerts v2) - the recap for everything that deliberately didn't page anyone. A
// scheduled action (`alerts-digest`, daily, morning) reads the last 24h of digest-class events
// (the kinds whose rules carry `notify: "digest"` - the rules file stays the single policy
// surface), groups them by kind + subject per route, and sends ONE card per person. Deduped per
// (route, date), so re-running the action is a no-op; an empty day sends nothing.
// See features/alerts/SPEC.md.

import { todayUtc, type IngestProgress } from '../../ops/types.js'
import { loadAlertRules } from './config.js'
import { listEvents, recordEvent } from '../../events.js'
import { flushAlertsNow, requestFlush } from './flush.js'
import { recordAlerts } from './store.js'
import { renderMessage, type AlertCandidate, type AlertRule } from './types.js'

const WINDOW_H = 24

const KIND_LINE: Record<string, { emoji: string; noun: [string, string]; grouped: string }> = {
  'x.like': { emoji: '❤️', noun: ['like', 'likes'], grouped: 'post' },
  'x.repost': { emoji: '🔁', noun: ['repost', 'reposts'], grouped: 'post' },
  'x.follow': { emoji: '➕', noun: ['new follower', 'new followers'], grouped: '' },
  'github.star': { emoji: '⭐', noun: ['new star', 'new stars'], grouped: 'repo' },
}

/** One summary line per kind: "❤️ 14 likes across 4 posts" / "➕ 2 new followers". */
function summarize(byKind: Map<string, { count: number; subjects: Set<string> }>): string {
  const lines: string[] = []
  for (const [kind, { count, subjects }] of [...byKind.entries()].sort(([, a], [, b]) => b.count - a.count)) {
    const spec = KIND_LINE[kind] ?? { emoji: '•', noun: [kind, kind] as [string, string], grouped: '' }
    let line = `${spec.emoji} ${count} ${spec.noun[count === 1 ? 0 : 1]}`
    if (spec.grouped && subjects.size > 0) {
      line += ` across ${subjects.size} ${spec.grouped}${subjects.size === 1 ? '' : 's'}`
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/**
 * Build + record the digest alerts for the trailing 24h. The digest-class rules define both WHAT
 * feeds the digest (their event kinds) and WHERE each kind's recap goes (their route); the
 * `digest.daily` rule provides the message template + enablement.
 */
export async function evaluateDigest(): Promise<{ events: number; digests: number }> {
  const rules = loadAlertRules()
  const digestRule = rules.find((r) => r.enabled && r.event === 'digest.daily')
  const feedRules = rules.filter((r): r is AlertRule => r.enabled && (r.notify ?? 'realtime') === 'digest')
  if (!digestRule || feedRules.length === 0) return { events: 0, digests: 0 }

  const routeByKind = new Map<string, string>()
  for (const r of feedRules) if (!routeByKind.has(r.event)) routeByKind.set(r.event, r.route)

  const since = new Date(Date.now() - WINDOW_H * 3_600_000).toISOString()
  const events = await listEvents([...routeByKind.keys()], since, 2000)
  if (events.length === 0) return { events: 0, digests: 0 }

  // route → kind → {count, distinct subjects}
  const byRoute = new Map<string, Map<string, { count: number; subjects: Set<string> }>>()
  for (const e of events) {
    const route = routeByKind.get(e.kind) ?? 'channel'
    const kinds = byRoute.get(route) ?? new Map()
    const entry = kinds.get(e.kind) ?? { count: 0, subjects: new Set<string>() }
    entry.count++
    if (e.subject) entry.subjects.add(e.subject)
    kinds.set(e.kind, entry)
    byRoute.set(route, kinds)
  }

  const date = todayUtc()
  const candidates: AlertCandidate[] = []
  for (const [route, byKind] of byRoute) {
    const fields = { date, summary: summarize(byKind), count: String([...byKind.values()].reduce((n, e) => n + e.count, 0)) }
    const dedupKey = `digest:${route}:${date}`
    await recordEvent({
      kind: 'digest.daily',
      dedup_key: dedupKey,
      event_at: new Date().toISOString(),
      source: 'funnel',
      fields,
    })
    candidates.push({
      rule_id: digestRule.id,
      event_kind: 'digest.daily',
      dedup_key: dedupKey,
      route,
      message: renderMessage(digestRule.message, fields),
      payload: { ...fields },
      event_at: new Date().toISOString(),
    })
  }

  const recorded = await recordAlerts(candidates)
  if (recorded.length > 0) requestFlush(digestRule.debounce_sec ?? 0)
  return { events: events.length, digests: recorded.length }
}

/** Funnel action wrapper - summarize → flush, streaming a one-line summary to automation_runs. */
export async function* alertsDigestAction(): AsyncGenerator<IngestProgress> {
  yield { channel: 'alerts-digest', phase: 'start', message: `summarizing last ${WINDOW_H}h of digest-class events…` }
  const { events, digests } = await evaluateDigest()
  yield { channel: 'alerts-digest', phase: 'persist', message: `${events} event(s) → ${digests} digest(s); delivering…` }
  const { delivered, suppressed, failed, messages } = await flushAlertsNow()
  const summary =
    `alerts-digest: ${events} event(s) → ${digests} digest(s); ` +
    `delivered ${delivered} in ${messages} message(s), suppressed ${suppressed}, failed ${failed}`
  yield {
    channel: 'alerts-digest',
    phase: 'done',
    message: summary,
    result: { channel: 'alerts-digest', date: todayUtc(), summary },
  }
}
