// The alert transport port. Delivery knows one sink natively (Lark, this engine's original pager); any other
// place an alert can be routed to - a chat room, later a webhook - is a transport a dependent
// feature registers from its server module. Alerts never imports the feature that provides it.

import type { AlertRecord } from './types.js'

export interface AlertTransport {
  /** Stable id; prefixes the recorded delivery target (`chat:<slug>`). */
  id: string
  /** The concrete target for a rule's `route`, or null when this transport does not handle it. */
  matchRoute: (route: string) => string | null
  /** Deliver one batch to one target. Throw to record every alert in the batch as an error. */
  deliver: (target: string, alerts: readonly AlertRecord[]) => Promise<void>
}

const transports: AlertTransport[] = []

export function registerAlertTransport(t: AlertTransport): () => void {
  if (transports.some((x) => x.id === t.id)) throw new Error(`alert transport "${t.id}" registered twice`)
  transports.push(t)
  return () => {
    const i = transports.indexOf(t)
    if (i >= 0) transports.splice(i, 1)
  }
}

/** The first registered transport that claims the route, with its target. */
export function matchAlertTransport(route: string): { transport: AlertTransport; target: string } | null {
  for (const transport of transports) {
    const target = transport.matchRoute(route)
    if (target) return { transport, target }
  }
  return null
}
