// The delivery flusher (alerts v2) - the ONLY path that actually sends pending alerts. Recording
// and delivering are decoupled: evaluators record `pending` rows and call requestFlush(delay); the
// flusher delivers everything pending in one pass, batched one-message-per-target, after the
// debounce window. Single-flight: at most one delivery pass runs at a time, and a request that
// arrives mid-pass queues exactly one follow-up pass - this also removes v1's latent race where two
// concurrent evaluators could both pick up (and double-send) the same pending row.
// See features/alerts/SPEC.md.

import { deliverPendingAlerts, type DeliveryResult } from './deliver.js'

/** Default debounce before a flush (a product decision, 2026-07-14): 5 minutes. Per-rule override. */
export const DEFAULT_DEBOUNCE_SEC = 300

let timer: NodeJS.Timeout | null = null
let scheduledAt = Infinity
let running: Promise<DeliveryResult> | null = null
let rerun = false

async function runFlush(): Promise<DeliveryResult> {
  // Single-flight with a queued re-run: a request landing mid-pass is honored by exactly one
  // follow-up pass (its rows weren't in the current pass's snapshot).
  if (running) {
    rerun = true
    return running
  }
  running = (async () => {
    let result = await deliverPendingAlerts()
    while (rerun) {
      rerun = false
      result = await deliverPendingAlerts()
    }
    return result
  })()
  try {
    return await running
  } finally {
    running = null
  }
}

/**
 * Ask for a delivery pass at most `delaySec` from now. Earlier wins: if a flush is already
 * scheduled sooner, this is a no-op; a later one is pulled forward. The window never extends on
 * new arrivals (first arrival fixes it), so a steady flood still flushes on rhythm - debounce and
 * max-hold are the same number by design.
 */
export function requestFlush(delaySec: number = DEFAULT_DEBOUNCE_SEC): void {
  const at = Date.now() + Math.max(0, delaySec) * 1000
  if (timer && scheduledAt <= at) return
  if (timer) clearTimeout(timer)
  scheduledAt = at
  timer = setTimeout(() => {
    timer = null
    scheduledAt = Infinity
    void runFlush().catch(() => {})
  }, at - Date.now())
  // Never keep a short-lived process (a script, a test) alive just for a pending flush - those
  // call flushAlertsNow() explicitly before exiting.
  timer.unref?.()
}

/** Deliver everything pending right now (poll actions call this - their batch is already whole). */
export async function flushAlertsNow(): Promise<DeliveryResult> {
  if (timer) {
    clearTimeout(timer)
    timer = null
    scheduledAt = Infinity
  }
  return runFlush()
}
