// The CRM store - one shared fetch of accounts-with-contacts behind the standard createDataStore,
// reloaded live on either crm table (so an import run, an MCP write or another tab's edit lands in
// an open dashboard within moments).

import { registerStoreReloads } from '../../../lib/changeFeed.ts'
import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'
import type {
  CrmAccount,
  CrmWaitingOn,
  CrmAccountDeleteReport,
  CrmAccountSource,
  CrmAccountStatus,
  CrmContactDeleteReport,
  CrmContactRole,
  CrmRenewalRisk,
} from '../crm-types.ts'

/** The active user as the mutation's `actor` audit stamp (created_by/updated_by server-side). */
const actor = (): string | undefined => getActiveUserId() ?? undefined

const store = createDataStore<CrmAccount[]>(() =>
  trpc.crmAccounts.query({}).then((d) => ((d as { accounts?: unknown[] }).accounts ?? []) as CrmAccount[]),
)
registerStoreReloads(['table:crm_accounts', 'table:crm_contacts'], store)

export function useCrmData(): { data: CrmAccount[] | null; error: string | null } {
  return store.useData()
}

/** Force a refetch (after a mutation made elsewhere, e.g. a supervised import run). */
export const reloadCrm = (): Promise<CrmAccount[]> => store.reload()

/**
 * What the dashboard may write to an account. Every field is Box-owned; the structural columns
 * (`data_source_id`, `external_id`, `external`) are absent on purpose.
 */
export interface CrmAccountUpsert {
  id: string
  name?: string
  status?: CrmAccountStatus
  waiting_on?: CrmWaitingOn
  /** users.id; '' clears it. */
  owner?: string
  source?: CrmAccountSource
  /** '' clears it. */
  referral_partner?: string
  mrr_usd?: number
  close_probability?: number
  next_action?: string
  /** 'YYYY-MM-DD'; '' clears it. */
  next_action_at?: string
  last_contacted_at?: string
  subscription_start_at?: string
  subscription_end_at?: string
  /** A1 - 'YYYY-MM-DD'; '' clears. Suppresses the account from MRR and churn. */
  paused_since?: string
  paused_until?: string
  /** A2 - '' clears. */
  loss_reason?: string
  renewal_risk?: CrmRenewalRisk
  renewal_risk_note?: string
  renewal_risk_reviewed_at?: string
  website?: string
  tags?: string[]
  notes?: string
  /** R1/R2 - the external links; '' clears each. Refused when another account holds the same value. */
  stripe_customer_id?: string
  supabase_space_id?: string
  whatsapp_group_jid?: string
}

/** Create or update an account (partial), then reload. */
export async function upsertCrmAccount(input: CrmAccountUpsert): Promise<void> {
  await trpc.crmAccountUpsert.mutate({ ...input, actor: actor() })
  await store.reload()
}

/**
 * Write one of the three EXTERNAL LINKS (R1/R2), and hand back whether it stuck. The duplicate
 * guard (R3) is the only account write that can fail for a reason the user can act on - one Stripe
 * customer id was live on two accounts of the same customer - so the refusal is surfaced rather than
 * swallowed, and the caller restores the field it came from. Returns false when refused.
 */
export async function saveCrmAccountLink(id: string, patch: Partial<CrmAccountUpsert>): Promise<boolean> {
  try {
    await upsertCrmAccount({ id, ...patch })
    return true
  } catch (e: unknown) {
    window.alert(e instanceof Error ? e.message : String(e))
    return false
  }
}

/** Optimistically move an account's status (the one-click table action), then reconcile. */
export async function setCrmAccountStatus(id: string, status: CrmAccountStatus): Promise<void> {
  store.set((cur) => cur.map((a) => (a.id === id ? { ...a, status } : a)))
  try {
    await trpc.crmAccountUpsert.mutate({ id, status, actor: actor() })
  } finally {
    await store.reload()
  }
}

/** Delete an account and its contacts; returns the report for the caller to show. */
export async function deleteCrmAccount(id: string): Promise<CrmAccountDeleteReport> {
  const report = (await trpc.crmAccountDelete.mutate({ id, actor: actor() })) as unknown as CrmAccountDeleteReport
  await store.reload()
  return report
}

/** What the dashboard may write to a contact - Box columns plus the identity fields. */
export interface CrmContactUpsert {
  id: string
  account_id?: string
  name?: string
  headline?: string
  /** '' clears it. */
  email?: string
  phone?: string
  linkedin_url?: string
  role?: CrmContactRole
  is_primary?: boolean
  tags?: string[]
  notes?: string
}

/** Create or update a contact (partial), then reload. */
export async function upsertCrmContact(input: CrmContactUpsert): Promise<void> {
  await trpc.crmContactUpsert.mutate({ ...input, actor: actor() })
  await store.reload()
}

/** Delete a contact; returns the report (re-import warning, primary promotion, empty account). */
export async function deleteCrmContact(id: string): Promise<CrmContactDeleteReport> {
  const report = (await trpc.crmContactDelete.mutate({ id, actor: actor() })) as unknown as CrmContactDeleteReport
  await store.reload()
  return report
}
