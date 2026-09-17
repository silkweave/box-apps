// Resolve an alert rule's `route` string to a concrete Lark delivery target, from the checked-in
// config/lark-routing.json map (config-only, no schema change - the chosen v1 mapping). An unmapped
// route falls back to the configured `fallback` route. See features/alerts/SPEC.md.

import { existsSync, readFileSync } from 'node:fs'
import { configPath } from '../../io.js'

export type LarkReceiveType = 'open_id' | 'chat_id' | 'user_id' | 'union_id' | 'email'

export interface LarkTarget {
  receive_id: string
  type: LarkReceiveType
}

interface RoutingFile {
  routes?: Record<string, LarkTarget>
  fallback?: string
}

export function larkRoutingPath(): string {
  return configPath('lark-routing.json')
}

function loadRouting(): RoutingFile {
  const file = larkRoutingPath()
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, 'utf8')) as RoutingFile
}

/**
 * Resolve a route (`user:<id>` | `channel` | `owner` | …) to a Lark target, or null if neither the
 * route nor the fallback is mapped (the alert then records a delivery error rather than vanishing).
 */
export function resolveRoute(route: string): LarkTarget | null {
  const { routes = {}, fallback } = loadRouting()
  return routes[route] ?? (fallback ? routes[fallback] ?? null : null)
}
