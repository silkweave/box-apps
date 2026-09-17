import { useEffect, useState } from 'react'
import { registerStoreReloads } from '../../../lib/changeFeed.ts'
import { createDataStore, type DataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'

// Alerts data layer - the recorded alert feed (read-only) and the configured rule set
// (config/alerts.json, editable: saveAlertRule/deleteAlertRule write the file through the server).
// Two shared stores (see dataStore.ts), mirroring useAutomationData. The feed store polls itself
// while anything is still `pending` (an evaluator recorded it but delivery hasn't settled), so the
// view stays live without per-component timers.

export type AlertStatus = 'pending' | 'delivered' | 'suppressed' | 'error'

export interface Alert {
  id: string
  rule_id: string
  event_kind: string
  dedup_key: string
  route: string
  target: string | null
  title: string | null
  message: string
  status: AlertStatus
  event_at: string | null
  created_at: string
  delivered_at: string | null
  error: string | null
}

export interface AlertRule {
  id: string
  event: string
  route: string
  message: string
  cooldown_min?: number
  enabled: boolean
  signal_id?: string
  threshold?: number
  notify?: 'realtime' | 'digest'
  debounce_sec?: number
  tiers?: number[]
}

/** Stale-while-revalidate on mount: render the cache immediately, but always refetch so a view
 *  never shows a delivery state that settled while it was unmounted. */
function useFresh<T>(store: DataStore<T>): { data: T | null; error: string | null } {
  const { data, error } = store.useData()
  const [reloadError, setReloadError] = useState<string | null>(null)
  useEffect(() => {
    store.reload().catch((e) => setReloadError(String(e)))
  }, [store])
  return { data, error: error ?? reloadError }
}

// While any alert is still `pending`, keep polling so a delivery outcome (delivered/suppressed/
// error) lands without a manual refresh.
const FEED_POLL_MS = 10_000
let feedPollTimer: ReturnType<typeof setTimeout> | undefined

function scheduleFeedPoll(alerts: Alert[]): void {
  clearTimeout(feedPollTimer)
  feedPollTimer = undefined
  if (!alerts.some((a) => a.status === 'pending')) return
  feedPollTimer = setTimeout(() => {
    feedPollTimer = undefined
    void feedStore.reload().catch(() => undefined)
  }, FEED_POLL_MS)
}

const feedStore = createDataStore<Alert[]>(() =>
  trpc.alertsList.query({}).then((d) => {
    const alerts = ((d as { alerts?: unknown[] }).alerts ?? []) as Alert[]
    scheduleFeedPoll(alerts) // re-arms on every (re)fetch, no matter who triggered it
    return alerts
  }),
)
const rulesStore = createDataStore<AlertRule[]>(() =>
  trpc.alertsRules.query({}).then((d) => ((d as { rules?: unknown[] }).rules ?? []) as AlertRule[]),
)
registerStoreReloads(['table:alerts', 'table:events'], feedStore)
registerStoreReloads(['config:alerts.json'], rulesStore)

export const useAlerts = (): { data: Alert[] | null; error: string | null } => useFresh(feedStore)
export const reloadAlerts = feedStore.reload
export const useAlertRules = (): { data: AlertRule[] | null; error: string | null } => useFresh(rulesStore)
export const reloadAlertRules = rulesStore.reload

/** Create or replace one rule in config/alerts.json (matched by id), then refresh the store. */
export async function saveAlertRule(rule: AlertRule): Promise<void> {
  await trpc.alertsRulesSave.mutate(rule)
  await rulesStore.reload()
}

/** Remove one rule from config/alerts.json, then refresh the store. */
export async function deleteAlertRule(id: string): Promise<void> {
  await trpc.alertsRulesDelete.mutate({ id })
  await rulesStore.reload()
}
