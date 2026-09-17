import * as React from 'react'
import { subscribeChanges } from '../../../lib/changeFeed.ts'
import { trpc } from '../../../lib/trpc'
import type { InboxState, InboxStateEntry, ItemStatus } from '../inbox-types'

const EMPTY: InboxState = { version: 1, items: {} }

export interface UseInboxState {
  state: InboxState
  /** False when the backend is unreachable (writes won't persist; optimistic values are kept). */
  available: boolean
  loading: boolean
  /** Record an item as handled (status 'done'). Optimistic; reconciles with the server. */
  markDone: (id: string, note?: string) => void
  /** Un-handle an item - returns it to the open inbox. */
  reopen: (id: string) => void
}

interface StateEntryWire {
  id: string
  status: string
  done_at: string
  note?: string
}

/** Map the server's array-of-entries wire shape to the UI's keyed lookup. (tRPC reflects nested
 *  DTO arrays as `unknown[]`, so we cast - same pattern the signals view uses.) */
function toState(items: unknown[]): InboxState {
  const out: Record<string, InboxStateEntry> = {}
  for (const e of items as StateEntryWire[]) {
    out[e.id] = { status: e.status as ItemStatus, done_at: e.done_at, ...(e.note ? { note: e.note } : {}) }
  }
  return { version: 1, items: out }
}

/**
 * Reads/writes the committed done-state from the warehouse `inbox_state` table over tRPC
 * (`inboxState` query, `inboxSetDone` mutation). Optimistic on write; degrades to read-only
 * (in-memory) if the backend is unreachable.
 */
export function useInboxState(): UseInboxState {
  const [state, setState] = React.useState<InboxState>(EMPTY)
  const [available, setAvailable] = React.useState(true)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    let alive = true
    const fetch = (): void => {
      trpc.inboxState
        .query({})
        .then((s) => alive && setState(toState(s.items)))
        .catch(() => alive && setAvailable(false))
        .finally(() => alive && setLoading(false))
    }
    fetch()
    // Live-refresh: another session (or an agent over MCP) marking items done shows up here.
    const off = subscribeChanges(['table:inbox_state'], fetch)
    return () => {
      alive = false
      off()
    }
  }, [])

  const post = React.useCallback((id: string, status: ItemStatus | 'open', note?: string) => {
    // Optimistic local update.
    setState((prev) => {
      const items = { ...prev.items }
      if (status === 'open') delete items[id]
      else items[id] = { status, done_at: new Date().toISOString(), ...(note ? { note } : {}) }
      return { version: 1, items }
    })
    trpc.inboxSetDone
      .mutate({ id, status, note })
      .then((s) => setState(toState(s.items)))
      .catch(() => setAvailable(false)) // keep the optimistic value; just flag write-unavailable
  }, [])

  const markDone = React.useCallback((id: string, note?: string) => post(id, 'done', note), [post])
  const reopen = React.useCallback((id: string) => post(id, 'open'), [post])

  return { state, available, loading, markDone, reopen }
}
