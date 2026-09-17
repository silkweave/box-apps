// The phase-3 CRM event stores - meetings and revenue events, fetched PER ACCOUNT.
//
// Deliberately not folded into useCrmData's one-shot accounts payload: that is already ~294KB and
// every consumer that does not need events would pay for them. The account detail view is the only
// surface that wants these, and it wants one account's worth.

import * as React from 'react'
import { subscribeChanges } from '../../../lib/changeFeed.ts'
import { trpc } from '../../../lib/trpc.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'
import type {
  CrmActivity,
  CrmActivityChannel,
  CrmActivityDirection,
  CrmEventDeleteReport,
  CrmMeeting,
  CrmMeetingKind,
  CrmMeetingOutcome,
  CrmRevenueEvent,
  CrmRevenueKind,
} from '../crm-types.ts'

const actor = (): string | undefined => getActiveUserId() ?? undefined

/**
 * A tiny per-key fetch hook rather than a createDataStore: these are keyed by account id, so a
 * single module-level store would thrash between accounts as you navigate. `reloadKey` is bumped by
 * the change feed and by every local mutation, which is what makes another tab's edit land here.
 */
let reloadKey = 0
const listeners = new Set<() => void>()
const bump = (): void => {
  reloadKey += 1
  for (const l of listeners) l()
}
subscribeChanges(['table:crm_meetings', 'table:crm_revenue_events', 'table:crm_activities'], bump)

function useAccountScoped<T>(accountId: string | null, fetch: (id: string) => Promise<T[]>): {
  data: T[] | null
  error: string | null
} {
  const [, force] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    listeners.add(force)
    return () => void listeners.delete(force)
  }, [])
  const [state, setState] = React.useState<{ data: T[] | null; error: string | null }>({ data: null, error: null })
  React.useEffect(() => {
    if (!accountId) return setState({ data: [], error: null })
    let live = true
    fetch(accountId).then(
      (rows) => live && setState({ data: rows, error: null }),
      (e: unknown) => live && setState({ data: null, error: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
    }
  }, [accountId, reloadKey])
  return state
}

export function useCrmMeetings(accountId: string | null) {
  return useAccountScoped<CrmMeeting>(accountId, (id) =>
    trpc.crmMeetings
      .mutate({ account_id: id })
      .then((d) => ((d as { meetings?: unknown[] }).meetings ?? []) as CrmMeeting[]),
  )
}

export function useCrmRevenueEvents(accountId: string | null) {
  return useAccountScoped<CrmRevenueEvent>(accountId, (id) =>
    trpc.crmRevenueEvents
      .mutate({ account_id: id })
      .then((d) => ((d as { events?: unknown[] }).events ?? []) as CrmRevenueEvent[]),
  )
}

/**
 * Every message with this account, across ALL of its contacts, oldest first - the conversation
 * stream. Read-only: the Box does not send LinkedIn messages, it mirrors them.
 */
export function useCrmActivities(accountId: string | null) {
  return useAccountScoped<CrmActivity>(accountId, (id) =>
    trpc.crmActivities
      .mutate({ account_id: id })
      .then((d) => ((d as { activities?: unknown[] }).activities ?? []) as CrmActivity[]),
  )
}

export async function logCrmActivity(input: {
  id?: string
  contact_id: string
  channel: CrmActivityChannel
  direction: CrmActivityDirection
  occurred_at?: string
  body: string
  subject?: string
}): Promise<void> {
  await trpc.crmActivityLog.mutate({ ...input, actor: actor() })
  bump()
}

export async function deleteCrmActivity(id: string): Promise<void> {
  await trpc.crmActivityDelete.mutate({ id })
  bump()
}

/**
 * The assign queue: everything the syncs could not decide, both tables, in one call. NOT
 * account-scoped, so it does not go through useAccountScoped - but it listens to the same
 * `reloadKey`, which is what makes a row vanish from the queue the moment you answer it.
 */
export function useCrmAssignQueue(): {
  data: { meetings: CrmMeeting[]; events: CrmRevenueEvent[] } | null
  error: string | null
} {
  const [, force] = React.useReducer((n: number) => n + 1, 0)
  React.useEffect(() => {
    listeners.add(force)
    return () => void listeners.delete(force)
  }, [])
  const [state, setState] = React.useState<{
    data: { meetings: CrmMeeting[]; events: CrmRevenueEvent[] } | null
    error: string | null
  }>({ data: null, error: null })
  React.useEffect(() => {
    let live = true
    trpc.crmAssignQueue.mutate({}).then(
      (d) => {
        if (!live) return
        const payload = d as { meetings?: unknown[]; events?: unknown[] }
        setState({
          data: {
            meetings: (payload.meetings ?? []) as CrmMeeting[],
            events: (payload.events ?? []) as CrmRevenueEvent[],
          },
          error: null,
        })
      },
      (e: unknown) => live && setState({ data: null, error: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
    }
  }, [reloadKey])
  return state
}

export interface CrmMeetingUpsert {
  id: string
  account_id?: string
  contact_id?: string
  kind?: CrmMeetingKind
  outcome?: CrmMeetingOutcome
  notes?: string
  source?: 'calendar' | 'transcript' | 'manual'
  scheduled_at?: string
  duration_min?: number
  attendee_email?: string
  title?: string
}

export async function upsertCrmMeeting(input: CrmMeetingUpsert): Promise<void> {
  await trpc.crmMeetingUpsert.mutate({ ...input, actor: actor() })
  bump()
}

export async function deleteCrmMeeting(id: string): Promise<CrmEventDeleteReport> {
  const report = (await trpc.crmMeetingDelete.mutate({ id, actor: actor() })) as unknown as CrmEventDeleteReport
  bump()
  return report
}

export interface CrmRevenueEventUpsert {
  id: string
  account_id?: string
  kind?: CrmRevenueKind
  period_months?: number
  covers_from?: string
  covers_to?: string
  notes?: string
  provider?: 'manual'
  status?: 'open' | 'paid' | 'voided' | 'refunded'
  amount?: number
  currency?: string
  fx_rate?: number
  issued_at?: string
  due_at?: string
  paid_at?: string
  payer_email?: string
  invoice_number?: string
  description?: string
}

export async function upsertCrmRevenueEvent(input: CrmRevenueEventUpsert): Promise<void> {
  await trpc.crmRevenueEventUpsert.mutate({ ...input, actor: actor() })
  bump()
}

export async function deleteCrmRevenueEvent(id: string): Promise<CrmEventDeleteReport> {
  const report = (await trpc.crmRevenueEventDelete.mutate({ id, actor: actor() })) as unknown as CrmEventDeleteReport
  bump()
  return report
}
