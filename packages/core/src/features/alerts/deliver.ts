// Delivery worker (alerts v2) - take every `pending` alert, resolve routes, honor rule cooldowns,
// group by target, and send ONE Lark card per person per pass (single card for one alert, a
// batched top-10 + "+ N more" card for several). Outcomes are recorded on every row (delivered /
// suppressed / error), with a shared batch_id across rows that went out as one message. Idempotent
// and retry-safe: a failed send stays `error` and is NOT retried automatically; only `pending`
// rows are picked up, so re-running never double-sends. Callers should go through flush.ts (the
// debounced single-flight wrapper) rather than calling this directly. Claude never sends on
// anyone's behalf outside this gated path. See features/alerts/SPEC.md.

import { randomUUID } from 'node:crypto'
import { batchAlertCard, singleAlertCard, titleFor } from './cards.js'
import { matchAlertTransport, type AlertTransport } from './transports.js'
import { loadAlertRules } from './config.js'
import { sendLarkCard } from './lark.js'
import { resolveRoute, type LarkTarget } from './routing.js'
import { lastDeliveredAt, listPendingAlerts, markAlert } from './store.js'
import type { AlertRecord } from './types.js'

export interface DeliveryResult {
  delivered: number
  suppressed: number
  failed: number
  /** How many Lark messages actually went out (≤ delivered - batching collapses them). */
  messages: number
}

export { titleFor }

/** Deliver all pending alerts. Never throws for a single bad alert - each outcome is recorded. */
export async function deliverPendingAlerts(): Promise<DeliveryResult> {
  const pending = await listPendingAlerts()
  const result: DeliveryResult = { delivered: 0, suppressed: 0, failed: 0, messages: 0 }
  if (pending.length === 0) return result

  const cooldownByRule = new Map(loadAlertRules().map((r) => [r.id, r.cooldown_min ?? 0]))

  // Cooldown-filter first, then group the survivors by concrete target. Two kinds of target:
  // a Lark target (a person), and whatever a registered transport claims (a chat room,
  // `chat:<slug>`, registered by the notifications feature), which never touches Lark.
  //
  // Cooldown is checked BEFORE the route resolves because it is a property of the RULE, not of
  // where the rule sends. A suppressed alert on an unmappable route now records `suppressed`
  // rather than `error` - the rule was in its quiet window either way.
  const groups = new Map<string, { target: LarkTarget; alerts: AlertRecord[] }>()
  const transportGroups = new Map<string, { transport: AlertTransport; target: string; alerts: AlertRecord[] }>()
  for (const alert of pending) {
    const cooldownMin = cooldownByRule.get(alert.rule_id) ?? 0
    if (cooldownMin > 0) {
      const last = await lastDeliveredAt(alert.rule_id)
      if (last && Date.now() - Date.parse(last) < cooldownMin * 60_000) {
        await markAlert(alert.id, { status: 'suppressed' })
        result.suppressed++
        continue
      }
    }

    const matched = matchAlertTransport(alert.route)
    if (matched) {
      const key = `${matched.transport.id}:${matched.target}`
      const group = transportGroups.get(key) ?? { ...matched, alerts: [] }
      group.alerts.push(alert)
      transportGroups.set(key, group)
      continue
    }

    const target = resolveRoute(alert.route)
    if (!target) {
      await markAlert(alert.id, { status: 'error', error: `no Lark route mapping for "${alert.route}"` })
      result.failed++
      continue
    }

    const key = `${target.type}:${target.receive_id}`
    const group = groups.get(key) ?? { target, alerts: [] }
    group.alerts.push(alert)
    groups.set(key, group)
  }

  for (const { transport, target, alerts } of transportGroups.values()) {
    const batchId = randomUUID()
    try {
      await transport.deliver(target, alerts)
      for (const alert of alerts) {
        await markAlert(alert.id, { status: 'delivered', target: `${transport.id}:${target}`, batch_id: batchId })
        result.delivered++
      }
      result.messages++
    } catch (err) {
      for (const alert of alerts) {
        await markAlert(alert.id, { status: 'error', error: (err as Error).message, batch_id: batchId })
        result.failed++
      }
    }
  }

  for (const { target, alerts } of groups.values()) {
    const batchId = randomUUID()
    const card = alerts.length === 1 ? singleAlertCard(alerts[0]) : batchAlertCard(alerts)
    try {
      sendLarkCard(target, card)
      for (const alert of alerts) {
        await markAlert(alert.id, {
          status: 'delivered',
          target: `${target.type}:${target.receive_id}`,
          batch_id: batchId,
        })
        result.delivered++
      }
      result.messages++
    } catch (err) {
      for (const alert of alerts) {
        await markAlert(alert.id, { status: 'error', error: (err as Error).message, batch_id: batchId })
        result.failed++
      }
    }
  }
  return result
}
