// The PROVIDER write path for accounts, contacts and activities.
//
// Separate from `state.ts`'s human path for the same reason `upsertImportedMeeting` is separate
// from `upsertCrmMeeting`: the human surface deliberately CANNOT write the structural and
// provider-owned columns (`data_source_id`, `external_id`, `external`, `external_stage`,
// `last_activity_at`), which is the guarantee that a tool call can never fight a sync. A sync needs
// exactly those columns, so it gets its own door rather than a hole in that one.
//
// Everything here is keyed on an id the UPSTREAM guarantees, so re-running a sync is a no-op
// instead of a duplicate. That is the property the whole relay design leans on: delivery is
// at-least-once and a backfill re-reads the same thread every time.

import { ensureSchema } from '../../warehouse/db.js'
import { readRecord, upsertRecord } from '../../warehouse/model.js'
import { CRM_ACCOUNTS, CRM_CONTACTS } from './models.js'

import { upsertCrmAccount, upsertCrmContact } from './state.js'
import type {
  CrmAccount,
  CrmAccountInput,
  CrmAccountStatus,
  CrmContact,
} from './types.js'

const bag = (v: unknown): Record<string, unknown> =>
  typeof v === 'string' ? (JSON.parse(v || '{}') as Record<string, unknown>) : ((v ?? {}) as Record<string, unknown>)

/** What a provider knows about a company when it has to CREATE the account. */
export interface CrmImportedAccountInput {
  id: string
  name: string
  /** Only applied on INSERT unless `force_status` - see `upsertImportedAccount`. */
  status?: CrmAccountStatus
  /** Set the status even on an existing row. A sync whose upstream is the system of record for
   *  where a lead sits passes this - its stage map is then authoritative over a hand-set status. */
  force_status?: boolean
  source?: string
  website?: string | null
  data_source_id?: string | null
  external_id?: string | null
  /** Merged into the stored bag, never replacing it - another provider's keys must survive. */
  external?: Record<string, unknown>
  actor?: string
}

/**
 * Create an account, or update the narrow set of columns a provider owns.
 *
 * **It never overwrites a human's judgement columns.** `owner`, `mrr_usd`, `next_action`, `notes`
 * and the rest are Box-owned and are simply not expressible here. `status` is the one interesting
 * case: seeded on insert, and overwritten afterwards only when the caller passes `force_status`,
 * which exists for an upstream that genuinely is the system of record for outreach stage. The
 * caller decides whether the CURRENT status is one it is allowed to move.
 */
export async function upsertImportedAccount(
  input: CrmImportedAccountInput,
): Promise<{ account_id: string; created: boolean }> {
  await ensureSchema()
  const prev = await readRecord<CrmAccount>(CRM_ACCOUNTS, { id: input.id })
  const created = !prev

  // Create through the HUMAN path. `upsertRecord` writes every column explicitly (`prev ?? null`),
  // so a DDL default never applies on insert - a hand-rolled insert here would have to restate
  // every NOT NULL default in the model and would silently rot the day one changes. `upsertCrmAccount`
  // already owns that defaulting, plus the write-time validation and the docs mirror.
  if (created) {
    await upsertCrmAccount({
      id: input.id,
      name: input.name,
      status: input.status ?? 'meeting_requested',
      source: (input.source ?? 'unknown') as CrmAccountInput['source'],
      ...(input.website ? { website: input.website } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
    })
  } else if (input.force_status && input.status && input.status !== prev.status) {
    await upsertCrmAccount({
      id: input.id,
      status: input.status,
      ...(input.actor ? { actor: input.actor } : {}),
    })
  }

  // Then the structural columns, which the human path deliberately cannot express - that refusal is
  // what guarantees a tool call can never fight a sync.
  const row = await readRecord<CrmAccount>(CRM_ACCOUNTS, { id: input.id })
  await upsertRecord<CrmAccount>(
    CRM_ACCOUNTS,
    {
      ...row,
      id: input.id,
      data_source_id: row?.data_source_id ?? input.data_source_id ?? null,
      external_id: row?.external_id ?? input.external_id ?? null,
      // Merged, never replaced: another provider's keys live in the same bag.
      external: { ...bag(row?.external), ...input.external },
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev: row ?? undefined },
  )
  return { account_id: input.id, created }
}

/** The provider-owned half of a contact. Box-owned columns (role, is_primary, tags, notes, email,
 *  phone) are only ever SEEDED here, on insert. */
export interface CrmImportedContactInput {
  id: string
  account_id: string
  name: string
  headline?: string
  linkedin_url?: string | null
  /** Seeded on insert only - a human may correct them afterwards and must not be overwritten. */
  email?: string | null
  phone?: string | null
  /** The upstream's own stage string, verbatim ('RESPONDED'). Display + debugging, never matched. */
  external_stage?: string | null
  data_source_id: string
  external_id: string
  external?: Record<string, unknown>
  last_activity_at?: string | null
  actor?: string
}

export async function upsertImportedContact(
  input: CrmImportedContactInput,
): Promise<{ contact_id: string; created: boolean }> {
  await ensureSchema()
  const prev = await readRecord<CrmContact>(CRM_CONTACTS, { id: input.id })
  const created = !prev

  // Same reasoning as the account: the human path owns the defaults, the primary-contact rule and
  // the account-exists refusal. Provider-owned identity columns ARE expressible there, so they ride
  // along; only the structural ones need the second write below.
  await upsertCrmContact({
    id: input.id,
    account_id: input.account_id,
    name: input.name,
    headline: input.headline ?? prev?.headline ?? '',
    ...(input.linkedin_url !== undefined ? { linkedin_url: input.linkedin_url } : {}),
    // Box-owned: seeded on insert only. A human correction must survive the next sync.
    ...(created && input.email ? { email: input.email } : {}),
    ...(created && input.phone ? { phone: input.phone } : {}),
    ...(input.actor ? { actor: input.actor } : {}),
  })

  const row = await readRecord<CrmContact>(CRM_CONTACTS, { id: input.id })
  await upsertRecord<CrmContact>(
    CRM_CONTACTS,
    {
      ...row,
      id: input.id,
      external_stage: input.external_stage ?? row?.external_stage ?? null,
      data_source_id: input.data_source_id,
      external_id: input.external_id,
      external: { ...bag(row?.external), ...input.external },
      last_activity_at: input.last_activity_at ?? row?.last_activity_at ?? null,
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev: row ?? undefined },
  )

  // Same heal as the human re-parent path: the activity's account_id is denormalized.
  if (prev && prev.account_id !== input.account_id) {
    const { healActivitiesForContact } = await import('./activities.js')
    await healActivitiesForContact(input.id)
  }
  return { contact_id: input.id, created }
}
