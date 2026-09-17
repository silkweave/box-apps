// Generic event ingestion (alerts v2) - the single entry point every source funnels through
// (polls, the run funnel, traction/digest jobs): record the event durably FIRST, then -
// only when it's fresh - run alert policy on top. A new source is just "build an AlertEvent and
// call ingestEvent". Alert policy: match the enabled REALTIME rules for the kind, record deduped
// alert rows, and ask the flusher for a debounced batched delivery. `digest`-class rules record
// the event only - the daily digest and traction detection read it from the events table.
// See features/alerts/SPEC.md.

import { computeXEngagementRows, X_ENGAGEMENT_KINDS } from '../data/signals/derive.js'
import { autoRegisterDefinitions } from '../data/signals/definitions.js'
import { deriveSignalIncrements, SIGNAL_INCREMENT_KIND } from '../data/signals/points.js'
import { replaceSignalRows } from '../data/signals/write.js'
import { rulesForEvent } from './config.js'
import { recordEvent } from '../../events.js'
import { DEFAULT_DEBOUNCE_SEC, requestFlush } from './flush.js'
import { recordAlerts } from './store.js'
import { renderMessage, type AlertCandidate, type AlertEvent, type AlertRule } from './types.js'

/** Realtime-class rules listening for a kind (digest-class rules never make alert rows). */
function realtimeRulesForEvent(kind: string): AlertRule[] {
  return rulesForEvent(kind).filter((r) => (r.notify ?? 'realtime') === 'realtime')
}

/** Match an event against the enabled realtime rules for its kind → candidate rows. */
export function candidatesForEvent(event: AlertEvent): AlertCandidate[] {
  return realtimeRulesForEvent(event.kind).map((rule) => ({
    rule_id: rule.id,
    event_kind: event.kind,
    dedup_key: event.dedup_key,
    route: rule.route,
    message: renderMessage(rule.message, event.fields),
    payload: { ...event.fields },
    event_at: event.event_at,
  }))
}

export interface IngestResult {
  /** False when the event was already stored (a replay) or the write failed. */
  fresh: boolean
}

/**
 * Record one event on the core spine. Best-effort and isolated - it NEVER throws, so callers on a
 * hot path can await it without risking their own flow. The alert POLICY (rule matching, alert
 * rows, the debounced flush) is `applyAlertPolicy`, which AlertsModule subscribes to the spine
 * with `onEvent` - so a fresh event reaches it whether it was recorded here, by content, by the
 * relay or by the run funnel. Poll actions that want their batch out immediately call
 * flushAlertsNow() themselves.
 */
export async function ingestEvent(event: AlertEvent): Promise<IngestResult> {
  try {
    return { fresh: await recordEvent(event) }
  } catch {
    // Alerting must never break its own trigger. A record error is best-effort by design.
    return { fresh: false }
  }
}

/**
 * The alert policy for one FRESH event: keep event-derived signals current, match realtime rules,
 * record deduped alert rows, request a debounced flush. Returns the number of alert rows recorded.
 * Registered on the events spine by AlertsModule; never throws.
 */
export async function applyAlertPolicy(event: AlertEvent): Promise<number> {
  try {

    // Keep the event-derived `x.engagement` signal current between daily pulls. Self-guarded:
    // a signal write failure must not suppress the alert path below.
    if (X_ENGAGEMENT_KINDS.includes(event.kind)) {
      try {
        const rows = await computeXEngagementRows()
        await replaceSignalRows('x.engagement', rows)
        await autoRegisterDefinitions(rows)
      } catch {}
    }

    // Same promotion for increment signals: a fresh `signal.increment` event (from ANY intake -
    // the signal-event tool writes via recordEvent + its own derive, but a poll or another
    // funnel source lands here) re-materializes the signal's live buckets. Self-guarded likewise.
    if (event.kind === SIGNAL_INCREMENT_KIND && event.subject) {
      try {
        await deriveSignalIncrements(event.subject)
      } catch {}
    }

    const candidates = candidatesForEvent(event)
    if (candidates.length === 0) return 0
    const recorded = await recordAlerts(candidates)
    if (recorded.length > 0) {
      const debounce = Math.min(
        ...realtimeRulesForEvent(event.kind).map((r) => r.debounce_sec ?? DEFAULT_DEBOUNCE_SEC),
      )
      requestFlush(debounce)
    }
    return recorded.length
  } catch {
    // Policy must never break the event it reacts to; anything missed is visible in the history.
    return 0
  }
}
