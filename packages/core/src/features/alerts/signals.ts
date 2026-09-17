// Signal alert evaluator - the "free tier". After a run that may have written signals, compare each
// signal rule's signal against its two latest snapshots and fire when the condition holds. Unlike
// reddit.inbox (one event fanned to every rule of that kind), a signal rule is bound to its OWN
// `signal_id`, so candidates are built per-rule here rather than via candidatesForEvent. Deduped by
// (rule, signal:date), so re-running after any success is a no-op. See features/alerts/SPEC.md.

import { readSignalOwnersFile, resolveSignalOwner, type SignalOwnersFile } from '../data/signals/owners.js'
import { withRead } from '../../warehouse/db.js'
import { loadAlertRules } from './config.js'
import { recordEvent } from '../../events.js'
import { DEFAULT_DEBOUNCE_SEC, requestFlush } from './flush.js'
import { recordAlerts } from './store.js'
import { renderMessage, type AlertCandidate, type AlertRule } from './types.js'

interface SignalPoint {
  date: string
  value: number
  label: string
  unit: string | null
  channel: string
}

/** The two most recent snapshots of a signal (newest first) - the delta reference. */
async function latestTwo(signalId: string): Promise<SignalPoint[]> {
  return withRead<SignalPoint>(
    `SELECT date::VARCHAR AS date, value, label, unit, channel
       FROM legacy_signal_points WHERE signal_id = ? ORDER BY date DESC LIMIT 2`,
    [signalId],
  )
}

/**
 * Resolve a signal rule's `owner` route to the concrete person owning the signal, via the same
 * config/signal-owners.json resolution the dashboard uses (signal override → channel default →
 * account binding). An unowned signal keeps the literal `owner` route, which delivery then sends
 * down the routing file's `fallback` - so an ownerless alert still lands somewhere visible.
 */
function resolveOwnerRoute(route: string, owners: SignalOwnersFile, channel: string, signalId: string): string {
  if (route !== 'owner') return route
  const owner = resolveSignalOwner(owners, channel, signalId)
  return owner ? `user:${owner}` : route
}

/**
 * Evaluate every enabled `signal.*` rule against the current warehouse and record any that fire
 * (delivery rides the debounced flusher). Best-effort and isolated - never throws, so the run
 * funnel can await it on the success path without risk. `signal.increase` fires on any upward
 * move; `signal.threshold` fires once when the signal reaches/crosses the rule's threshold.
 */
export async function evaluateSignalRules(): Promise<{ recorded: number }> {
  try {
    const rules = loadAlertRules().filter((r) => r.enabled && r.event.startsWith('signal.') && r.signal_id)
    if (rules.length === 0) return { recorded: 0 }

    const owners = readSignalOwnersFile()
    const candidates: AlertCandidate[] = []
    const firedRules: AlertRule[] = []
    for (const rule of rules) {
      const points = await latestTwo(rule.signal_id as string)
      const latest = points[0]
      if (!latest) continue
      const prior = points[1]
      const delta = prior ? latest.value - prior.value : latest.value

      let fire = false
      if (rule.event === 'signal.increase') {
        fire = !!prior && latest.value > prior.value
      } else if (rule.event === 'signal.threshold') {
        const t = rule.threshold as number
        fire = latest.value >= t && (!prior || prior.value < t)
      }
      if (!fire) continue

      const fields: Record<string, string> = {
        signal_id: rule.signal_id as string,
        label: latest.label,
        unit: latest.unit ?? '',
        date: latest.date,
        value: String(latest.value),
        prev: prior ? String(prior.value) : '',
        delta: String(delta),
      }
      // The durable events row (the v2 data layer) - keyed per (kind, signal:date), so two rules
      // watching one signal share the event. Best-effort; the alerts-table dedup still latches.
      await recordEvent({
        kind: rule.event,
        dedup_key: `${rule.signal_id}:${latest.date}`,
        event_at: `${latest.date}T00:00:00.000Z`,
        source: 'funnel',
        subject: rule.signal_id as string,
        fields,
      })

      firedRules.push(rule)
      candidates.push({
        rule_id: rule.id,
        event_kind: rule.event,
        dedup_key: `${rule.signal_id}:${latest.date}`,
        route: resolveOwnerRoute(rule.route, owners, latest.channel, rule.signal_id as string),
        message: renderMessage(rule.message, fields),
        payload: { ...fields },
        event_at: `${latest.date}T00:00:00.000Z`,
      })
    }

    if (candidates.length === 0) return { recorded: 0 }
    const recorded = await recordAlerts(candidates)
    if (recorded.length > 0) {
      requestFlush(Math.min(...firedRules.map((r) => r.debounce_sec ?? DEFAULT_DEBOUNCE_SEC)))
    }
    return { recorded: recorded.length }
  } catch {
    return { recorded: 0 }
  }
}
