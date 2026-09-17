// Read/write `crm_accounts` + `crm_contacts`. Row↔domain plumbing (column list, JSON/timestamp
// handling, partial upsert, audit stamps, enum validation) comes from the record layer
// (warehouse/model.ts) driven by the two ModelSpecs; this module keeps only the domain semantics:
// the account↔contact invariants, ownership validation, tag/date normalization, the cascade delete
// and the delete reports.
//
// The load-bearing rule is COLUMN OWNERSHIP. Every writer builds its update set from exactly one
// column class (crm/types.ts):
//
//   • `upsertCrmAccount` / `upsertCrmContact` - the HUMAN path (dashboard, MCP, REST). They cannot
//     express a provider-owned column at all, so a tool call can never fight a sync over one.
//   • a sync, through `import.ts` - the MACHINE path. Writes CRM_CONTACT_PROVIDER_COLUMNS only,
//     creates an account with a seeded status when it has to (CRM_ACCOUNT_STATUS_SEED), and never
//     touches an account column or a Box contact column afterwards. `crmContactExists()` and
//     `findAccountForImport()` below are the gates it should use.
//
// That split is why the first hand-set status survives every subsequent sync - the bug the whole
// module would lose trust over.

import type { DuckDBValue } from '@duckdb/node-api'
import { assertKnownUser } from '../../users/state.js'
import { ensureSchema, withRead, withWrite } from '../../warehouse/db.js'
import { deleteRecord, readRecord, readRecords, upsertRecord } from '../../warehouse/model.js'
import { CRM_ACCOUNTS, CRM_CONTACTS } from './models.js'
import { companyNameKey, emailDomain, linkedinKey, websiteDomain } from './identity.js'
import { applyCrmDocRegions, parseCrmDoc, readCrmDoc, syncCrmDocFields, writeCrmDoc, type CrmDoc, type CrmDocRegions } from './docs.js'
import {
  CRM_IMPORT_STAGES,
  type CrmAccount,
  type CrmAccountDeleteReport,
  type CrmAccountInput,
  type CrmAccountWithContacts,
  type CrmContact,
  type CrmContactDeleteReport,
  type CrmContactInput,
} from './types.js'

// --- normalization ---------------------------------------------------------------------------------

const list = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])
const bag = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const normAccount = <T extends CrmAccount>(a: T): T => ({ ...a, tags: list(a.tags), external: bag(a.external) })
const normContact = (c: CrmContact): CrmContact => ({
  ...c,
  tags: list(c.tags),
  external: bag(c.external),
  is_primary: Number(c.is_primary) === 1 ? 1 : 0,
})

/** Tags are a filter axis, so they get one canonical form: trimmed, lowercased, de-duplicated. */
const normalizeTags = (raw: string[] | null | undefined): string[] =>
  [...new Set(list(raw).map((t) => t.trim().toLowerCase()).filter(Boolean))].sort()

/** '' means "clear it" over the @Mcp scalar surface; undefined means "leave it alone". */
const clearable = (v: string | null | undefined): string | null | undefined =>
  v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim()

/** Dates are stored as DATE. Accept 'YYYY-MM-DD' (the repo convention) or a full ISO timestamp. */
function normalizeDate(v: string | null | undefined): string | null | undefined {
  const s = clearable(v)
  if (s === undefined || s === null) return s
  const day = s.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid date "${v}" - use YYYY-MM-DD`)
  return day
}

// --- reads ---------------------------------------------------------------------------------------

/**
 * Every account with its contacts nested. Ordered by the pipeline's own logic: the accounts with a
 * next action due soonest first (nulls last), then by name. Filtering is client-side at this size -
 * hundreds of rows, one payload, one live store.
 */
export async function readCrmAccounts(): Promise<CrmAccountWithContacts[]> {
  const accounts = await readRecords<CrmAccount>(CRM_ACCOUNTS, {
    orderBy: 'next_action_at NULLS LAST, lower(name)',
  })
  const contacts = await readRecords<CrmContact>(CRM_CONTACTS, {
    orderBy: 'is_primary DESC, lower(name)',
  })
  const byAccount = new Map<string, CrmContact[]>()
  for (const c of contacts) {
    const forAccount = byAccount.get(c.account_id) ?? []
    forAccount.push(normContact(c))
    byAccount.set(c.account_id, forAccount)
  }
  return accounts.map((a) => normAccount({ ...a, contacts: byAccount.get(a.id) ?? [] }))
}

/** One account with its contacts, or null. */
export async function readCrmAccount(id: string): Promise<CrmAccountWithContacts | null> {
  const account = await readRecord<CrmAccount>(CRM_ACCOUNTS, { id })
  if (!account) return null
  const contacts = await readRecords<CrmContact>(CRM_CONTACTS, {
    where: 'account_id = ?',
    params: [id],
    orderBy: 'is_primary DESC, lower(name)',
  })
  return normAccount({ ...account, contacts: contacts.map(normContact) })
}

/** One contact, or null. */
export async function readCrmContact(id: string): Promise<CrmContact | null> {
  const row = await readRecord<CrmContact>(CRM_CONTACTS, { id })
  return row ? normContact(row) : null
}

/**
 * Does this contact id already have a row? The seed gate for phase 2's sync: a contact's account and
 * its account's status may be written on INSERT and never again, so the sync asks this first.
 */
export async function crmContactExists(id: string): Promise<boolean> {
  return (await readRecord<CrmContact>(CRM_CONTACTS, { id })) !== null
}

/** Which rung of the ladder produced a match. Recorded on the contact, so a wrong merge is
 *  traceable rather than mysterious. */
export type CrmMatchRung = 'contact' | 'linkedin' | 'company_urn' | 'name' | 'domain'

/** What a provider knows about the person and their company when asking "whose account is this?" */
export interface CrmMatchInput {
  data_source_id: string
  external_id: string
  linkedin_url?: string | null
  /** The provider's stable id for the COMPANY (LinkedIn's `urn:li:fs_salesCompany:...`), which an
   *  import records on the account as `external.company_urn` - rung 3 reads that key back. */
  company_urn?: string | null
  company_name?: string | null
  website?: string | null
  email?: string | null
}

/**
 * Find the account an imported contact belongs to. Five rungs, first hit wins, strongest first:
 *
 *   1. `contact`     - a contact already carries this provider's external key. The steady state.
 *   2. `linkedin`    - a contact's canonical LinkedIn profile key matches.
 *   3. `company_urn` - an account carries the provider's stable company id.
 *   4. `name`        - normalised company names agree ("Northwind Pte Ltd." = "Northwind").
 *   5. `domain`      - the registrable domain of the website (or the work email) agrees.
 *
 * Rungs 1-3 are EXACT: they compare ids somebody else guarantees to be stable. Rungs 4 and 5 are
 * judgements, which is why the rung is returned rather than just the id - the caller records it,
 * and a merge nobody would have made by hand can be found later by querying for it.
 *
 * Returns null when nothing matches, and the caller creates an account. That is the SAFE outcome:
 * a duplicate account is visible and mergeable, a wrong merge silently blends two companies'
 * histories.
 */
export async function findAccountForImport(
  input: CrmMatchInput,
): Promise<{ account_id: string; how: CrmMatchRung } | null> {
  await ensureSchema()

  // 1. This provider has seen this person before.
  const byExternal = await withRead<{ account_id: string }>(
    `SELECT account_id FROM crm_contacts WHERE data_source_id = ? AND external_id = ? LIMIT 1`,
    [input.data_source_id, input.external_id],
  )
  if (byExternal[0]) return { account_id: byExternal[0].account_id, how: 'contact' }

  // 2. Somebody else recorded the same LinkedIn profile - possibly by hand, possibly from another
  //    provider. The key is canonical, so the two spellings do not have to agree.
  const liKey = linkedinKey(input.linkedin_url)
  if (liKey) {
    const byLinkedin = await withRead<{ account_id: string }>(
      `SELECT account_id FROM crm_contacts WHERE linkedin_key = ? LIMIT 1`,
      [liKey],
    )
    if (byLinkedin[0]) return { account_id: byLinkedin[0].account_id, how: 'linkedin' }
  }

  // 3. The company's own stable id, recorded in the account's `external` bag under one well-known
  //    key so every provider and the ladder agree on where it lives.
  const urn = (input.company_urn ?? '').trim()
  if (urn) {
    const byUrn = await withRead<{ id: string }>(
      `SELECT id FROM crm_accounts
        WHERE CAST(json_extract_string(external, '$.company_urn') AS VARCHAR) = ? LIMIT 1`,
      [urn],
    )
    if (byUrn[0]) return { account_id: byUrn[0].id, how: 'company_urn' }
  }

  // 4. The names agree once the legal form is stripped. `name_key` is recomputed on every write
  //    (upsertCrmAccount), so it can never lag behind `name`.
  const nameKey = companyNameKey(input.company_name)
  if (nameKey) {
    const byName = await withRead<{ id: string }>(
      `SELECT id FROM crm_accounts WHERE name_key = ? LIMIT 1`,
      [nameKey],
    )
    if (byName[0]) return { account_id: byName[0].id, how: 'name' }
  }

  // 5. The domains agree. Compared in TS rather than SQL because `crm_accounts.website` holds
  //    whatever a human typed (scheme, `www.`, a path) and normalising that in SQL would be a
  //    second implementation of `websiteDomain` waiting to drift from the first.
  const domain = websiteDomain(input.website) || emailDomain(input.email)
  if (domain) {
    const sites = await withRead<{ id: string; website: string | null }>(
      `SELECT id, website FROM crm_accounts WHERE website IS NOT NULL AND website <> ''`,
    )
    const hit = sites.find((row) => websiteDomain(row.website) === domain)
    if (hit) return { account_id: hit.id, how: 'domain' }
  }

  return null
}

// --- validation ------------------------------------------------------------------------------------

/** Ids are opaque: an imported contact id is the source's lead id verbatim, so no slug rule applies.
 *  What we do refuse is the shapes that break routing and the record layer. */
function assertValidId(kind: string, id: string): void {
  if (!id || id.trim() !== id) throw new Error(`crm ${kind}: id is required and cannot be padded with whitespace`)
  if (/\s/.test(id)) throw new Error(`crm ${kind}: id "${id}" cannot contain whitespace`)
  if (id.includes('/')) throw new Error(`crm ${kind}: id "${id}" cannot contain "/" (it is a route segment)`)
  if (id.length > 200) throw new Error(`crm ${kind}: id is too long (max 200 characters)`)
}

// --- account writes ----------------------------------------------------------------------------------

/**
 * Create or partially update an account. Provided fields overwrite; the rest keep their stored value
 * (or a default on first insert). `created_at` / `first_seen_at` are preserved.
 *
 * `status` is Box-owned and is never machine-written after the import's one seed - that is what stops
 * the first hand-set status from being silently reverted, and it is the reason the pipeline is
 * trustworthy at all.
 */
export async function upsertCrmAccount(input: CrmAccountInput): Promise<CrmAccountWithContacts> {
  assertValidId('account', input.id)
  const prev = await readRecord<CrmAccount>(CRM_ACCOUNTS, { id: input.id })

  // Ownership joins the same chain as signal/initiative owners - an unknown id is a typo, and a
  // silent typo means nobody actually owns the follow-up.
  const owner = clearable(input.owner)
  if (owner) await assertKnownUser(owner)

  if (input.close_probability != null && (input.close_probability < 0 || input.close_probability > 100)) {
    throw new Error(`crm account ${input.id}: close_probability must be between 0 and 100`)
  }
  if (input.mrr_usd != null && input.mrr_usd < 0) {
    throw new Error(`crm account ${input.id}: mrr_usd cannot be negative`)
  }

  // `mrr_usd` is stored AS TYPED - the foundation has no deal shape to derive it from (a product
  // decision, 2026-09-14; crm/types.ts says why the shape is a per-team recipe). THIS is the seam a
  // deal shape plugs into: resolve the shape's columns here, BEFORE the write, the same way the
  // links and the pause window are resolved below, and let a derived number win over a passed
  // `mrr_usd` when the shape can imply one - once a deal has a shape, the shape IS the number, and
  // computing it in one place is what stops three roundings of the same price landing in one
  // column. When the shape cannot imply a number (no plan, a custom price left blank), the typed
  // value must survive untouched, so rows predating the shape are never disturbed.
  const mrr = input.mrr_usd !== undefined ? input.mrr_usd : (prev?.mrr_usd ?? null)

  const referral = clearable(input.referral_partner)
  const website = clearable(input.website)
  const nextActionAt = normalizeDate(input.next_action_at)
  const lastContactedAt = normalizeDate(input.last_contacted_at)
  const subStart = normalizeDate(input.subscription_start_at)
  const subEnd = normalizeDate(input.subscription_end_at)
  const pausedSince = normalizeDate(input.paused_since)
  const pausedUntil = normalizeDate(input.paused_until)
  const lossReason = clearable(input.loss_reason)
  const riskNote = clearable(input.renewal_risk_note)

  // A5: the review DATE is the load-bearing half - a risk judgement with no review date is a guess
  // with a confident face on it. So changing the risk or its note stamps today automatically, and an
  // explicit date still wins (a human backdating "I reviewed this on Monday" must be able to).
  const riskChanged =
    (input.renewal_risk !== undefined && input.renewal_risk !== (prev?.renewal_risk ?? 'open')) ||
    (riskNote !== undefined && riskNote !== (prev?.renewal_risk_note ?? null))
  const explicitReviewed = normalizeDate(input.renewal_risk_reviewed_at)
  const reviewedAt =
    explicitReviewed !== undefined
      ? explicitReviewed
      : riskChanged
        ? new Date().toISOString().slice(0, 10)
        : (prev?.renewal_risk_reviewed_at ?? null)

  // A1: a pause window that ends before it starts is always a typo, and a silent one - it would
  // suppress the account from MRR forever while reading as though it restarts.
  const effSince = pausedSince !== undefined ? pausedSince : (prev?.paused_since ?? null)
  const effUntil = pausedUntil !== undefined ? pausedUntil : (prev?.paused_until ?? null)
  if (effSince && effUntil && effUntil < effSince) {
    throw new Error(`crm account ${input.id}: paused_until (${effUntil}) is before paused_since (${effSince})`)
  }
  if (!effSince && effUntil) {
    throw new Error(`crm account ${input.id}: paused_until needs a paused_since - an end with no start suppresses nothing`)
  }

  // R1/R2: the three external LINKS. They were `external` keys until 2026-09-03 and therefore
  // unwritable (the @Mcp surface is scalar-only), which froze them at whatever the first import
  // happened to write.
  //
  // R3 is the reason each one is checked before the write: in the live book one Stripe customer id
  // was claimed by two accounts of the same customer, and once Stripe owns `mrr_usd` one customer
  // id on two accounts writes one subscription's revenue twice. Refusing beats warning -
  // a warning goes to a log nobody reads, and the honest model for a genuinely shared customer is a
  // per-account subscription id, not a second row claiming the same customer. The check is on the
  // VALUE ARRIVING, so the pairs already in the book keep working until someone edits one.
  const links = {
    stripe_customer_id: clearable(input.stripe_customer_id),
    supabase_space_id: clearable(input.supabase_space_id),
    whatsapp_group_jid: clearable(input.whatsapp_group_jid),
  } as const
  for (const [column, value] of Object.entries(links)) {
    if (!value || value === (prev?.[column as keyof CrmAccount] ?? null)) continue
    const holder = await withRead<{ id: string }>(
      `SELECT id FROM crm_accounts WHERE ${column} = ? AND id <> ? LIMIT 1`,
      [value, input.id],
    )
    if (holder[0]) {
      throw new Error(
        `crm account ${input.id}: ${column} "${value}" is already held by account "${holder[0].id}" - one id on two accounts double-counts whatever it is the key to. Clear it there first, or use a per-account id.`,
      )
    }
  }

  await upsertRecord<CrmAccount>(
    CRM_ACCOUNTS,
    {
      id: input.id,
      name: input.name ?? prev?.name ?? input.id,
      status: input.status ?? prev?.status ?? 'meeting_requested',
      owner: owner !== undefined ? owner : (prev?.owner ?? null),
      source: input.source ?? prev?.source ?? 'unknown',
      referral_partner: referral !== undefined ? referral : (prev?.referral_partner ?? null),
      mrr_usd: mrr,
      close_probability:
        input.close_probability !== undefined ? input.close_probability : (prev?.close_probability ?? null),
      waiting_on: input.waiting_on ?? prev?.waiting_on ?? 'me',
      next_action: input.next_action ?? prev?.next_action ?? '',
      next_action_at: nextActionAt !== undefined ? nextActionAt : (prev?.next_action_at ?? null),
      last_contacted_at: lastContactedAt !== undefined ? lastContactedAt : (prev?.last_contacted_at ?? null),
      subscription_start_at: subStart !== undefined ? subStart : (prev?.subscription_start_at ?? null),
      subscription_end_at: subEnd !== undefined ? subEnd : (prev?.subscription_end_at ?? null),
      website: website !== undefined ? website : (prev?.website ?? null),
      // Derived matching index, recomputed on every write so it can never drift from `name`.
      name_key: companyNameKey(input.name ?? prev?.name ?? input.id),
      paused_since: effSince,
      paused_until: effUntil,
      loss_reason: lossReason !== undefined ? lossReason : (prev?.loss_reason ?? null),
      renewal_risk: input.renewal_risk ?? prev?.renewal_risk ?? 'open',
      renewal_risk_note: riskNote !== undefined ? riskNote : (prev?.renewal_risk_note ?? null),
      renewal_risk_reviewed_at: reviewedAt,
      tags: normalizeTags(input.tags ?? prev?.tags),
      notes: input.notes ?? prev?.notes ?? '',
      // Structural: kept as-is on update, null/empty on a hand-created insert.
      data_source_id: prev?.data_source_id ?? null,
      external_id: prev?.external_id ?? null,
      // Structural but human-writable: a link is a fact about which row in another system is this
      // account, and only a person can decide that (see the WhatsApp naming evidence in R2).
      stripe_customer_id:
        links.stripe_customer_id !== undefined ? links.stripe_customer_id : (prev?.stripe_customer_id ?? null),
      supabase_space_id:
        links.supabase_space_id !== undefined ? links.supabase_space_id : (prev?.supabase_space_id ?? null),
      whatsapp_group_jid:
        links.whatsapp_group_jid !== undefined ? links.whatsapp_group_jid : (prev?.whatsapp_group_jid ?? null),
      external: prev?.external ?? {},
      first_seen_at: prev?.first_seen_at ?? new Date().toISOString(),
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev },
  )

  // Doc mirror-back: `next_action` and `notes` live in docs/crm/<id>.md (the doc is the source of
  // truth, the columns its derived caches - see saveCrmDoc). This path can
  // still write both, so when it CHANGES either, the doc is brought along - otherwise the next
  // panel save would parse the stale doc and silently revert this write. Only provided-and-changed
  // fields sync: mirroring an unchanged value could stomp a doc someone hand-edited in VS Code
  // (its column cache is stale until the next saveCrmDoc, and the doc wins). Best-effort by
  // design: a doc that cannot be synced must never fail the warehouse write.
  const nextChanged = input.next_action !== undefined && input.next_action !== (prev?.next_action ?? '')
  const notesChanged = input.notes !== undefined && input.notes !== (prev?.notes ?? '')
  if (nextChanged || notesChanged) {
    try {
      syncCrmDocFields(input.id, {
        ...(nextChanged ? { next_action: input.next_action } : {}),
        ...(notesChanged ? { notes: input.notes } : {}),
      })
    } catch {
      /* unwritable doc tree: the columns hold the values; the doc catches up on its next write */
    }
  }
  return (await readCrmAccount(input.id))!
}

/**
 * Write an account's doc AND refresh the row's derived `next_action` + `notes` caches from it.
 *
 * The doc is the source of truth (the savePlanningDoc pattern, 2026-08-26): the dashboard used to
 * carry two prose columns beside no doc at all; now the panel edits one markdown
 * file and the columns are what the kanban card, the sortable next-action column and the free-text
 * search index read - refreshed here so they can never disagree with the doc for longer than one
 * save.
 *
 * Deliberately a NARROW upsertRecord, not upsertCrmAccount: (a) a prose save must not re-run owner
 * validation or the other write-time checks - a row whose stored values would fail today's
 * validation must still accept a notes edit; (b) upsertCrmAccount now mirrors
 * next_action/notes back INTO the doc, so routing through it would write the file twice per save;
 * (c) column ownership: this writer owns exactly the two derived caches and can touch nothing else.
 * Like savePlanningDoc, this never CREATES a row - a doc saved for an id with no account yet is
 * left on disk and the caches catch up on the row's first upsert.
 */
export async function saveCrmDoc(accountId: string, content: string, actor?: string): Promise<CrmDoc> {
  const doc = writeCrmDoc(accountId, content)
  const { nextAction, notes } = parseCrmDoc(content)
  const prev = await readRecord<CrmAccount>(CRM_ACCOUNTS, { id: accountId })
  if (prev && (prev.next_action !== nextAction || prev.notes !== notes)) {
    await upsertRecord<CrmAccount>(
      CRM_ACCOUNTS,
      { id: accountId, next_action: nextAction, notes, ...(actor ? { actor } : {}) },
      { prev },
    )
  }
  return doc
}

/**
 * The dashboard panel's save path: the two LOCKED-BLOCK editing regions applied onto the doc on
 * disk, then the caches re-derived exactly as saveCrmDoc does. The panel never holds the whole
 * document - the headings are app chrome (the ContentBodyEditor frontmatter-split precedent), so
 * the structure cannot be deleted or mangled from the editor at all; this function owns turning
 * the two region values back into one canonical file (see applyCrmDocRegions for the ordering and
 * the degraded-doc canonicalization). Unchanged regions never touch the file - not even to
 * canonicalize a hand-mangled doc, which only an actual edit may restructure - and a doc is never
 * created for two empty regions. Same narrow-upsert rules as saveCrmDoc: only the two derived
 * cache columns, only when changed, and never creating a row that does not exist.
 */
export async function saveCrmDocRegions(
  accountId: string,
  regions: CrmDocRegions,
  actor?: string,
): Promise<CrmDoc> {
  const current = readCrmDoc(accountId)
  const content = applyCrmDocRegions(current.content, regions)
  const doc = content === current.content ? current : writeCrmDoc(accountId, content)
  const { nextAction, notes } = parseCrmDoc(content)
  const prev = await readRecord<CrmAccount>(CRM_ACCOUNTS, { id: accountId })
  if (prev && (prev.next_action !== nextAction || prev.notes !== notes)) {
    await upsertRecord<CrmAccount>(
      CRM_ACCOUNTS,
      { id: accountId, next_action: nextAction, notes, ...(actor ? { actor } : {}) },
      { prev },
    )
  }
  return doc
}

/**
 * Merge one account's `external` bag (the per-system ids and scoring breakdowns that earn no
 * column). Shallow merge, keys with a null value removed - the deep-merge escape hatch content's
 * `metadata` already established. Used by imports and, later, by the billing join; the human tool
 * surface deliberately does not expose it.
 */
export async function mergeCrmAccountExternal(
  id: string,
  patch: Record<string, unknown>,
  actor?: string,
): Promise<void> {
  const prev = await readRecord<CrmAccount>(CRM_ACCOUNTS, { id })
  if (!prev) throw new Error(`crm account ${id} not found`)
  const merged: Record<string, unknown> = { ...bag(prev.external) }
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === '') delete merged[k]
    else merged[k] = v
  }
  await upsertRecord<CrmAccount>(CRM_ACCOUNTS, { id, external: merged, ...(actor ? { actor } : {}) }, { prev })
}

/**
 * How many activity rows hang off an account / a contact. Lives here rather than in activities.ts
 * because activities.ts imports THIS module (`readCrmContact`), and the delete cascade would
 * otherwise close the import cycle.
 */
async function countActivitiesForAccount(accountId: string): Promise<number> {
  const rows = await withRead<{ n: number }>(`SELECT count(*) AS n FROM crm_activities WHERE account_id = ?`, [accountId])
  return Number(rows[0]?.n ?? 0)
}

async function countActivitiesForContact(contactId: string): Promise<number> {
  const rows = await withRead<{ n: number }>(`SELECT count(*) AS n FROM crm_activities WHERE contact_id = ?`, [contactId])
  return Number(rows[0]?.n ?? 0)
}

/**
 * Delete an account and CASCADE to its contacts AND their activities - neither can exist without an
 * account, so leaving them behind would strand rows nothing can reach (an activity is only ever
 * reached by `account_id`, so an orphan is invisible AND permanent). The report says how many
 * people and how many messages went, and warns
 * loudly when any of them were connected: those come back on the next import attached to a freshly
 * created account, with the status re-seeded and every bit of the account's working state (owner,
 * MRR, next action, notes) gone for good. Archive is the honest "remove".
 */
export async function deleteCrmAccount(id: string): Promise<CrmAccountDeleteReport> {
  const account = await readCrmAccount(id)
  if (!account) {
    return {
      id,
      name: id,
      deleted: false,
      contacts_deleted: 0,
      activities_deleted: 0,
      reimporting_contacts: [],
      will_reimport: false,
      warnings: [`No account with id "${id}" - nothing was deleted.`],
    }
  }

  const reimporting = account.contacts
    .filter(
      (c) =>
        c.data_source_id !== null &&
        c.external_stage !== null &&
        (CRM_IMPORT_STAGES as readonly string[]).includes(c.external_stage),
    )
    .map((c) => c.name)

  const warnings: string[] = []
  if (account.contacts.length > 0) {
    warnings.push(`${account.contacts.length} contact(s) are deleted with it: ${account.contacts.map((c) => c.name).join(', ')}.`)
  }
  if (reimporting.length > 0) {
    warnings.push(
      `${reimporting.length} of them are still active upstream (${reimporting.join(', ')}) and WILL re-import on the next sync, into a brand-new account with a re-seeded status. Set the status to "archived" instead to keep this account and park it.`,
    )
  }
  warnings.push('The account status, owner, MRR, next action, tags and notes are lost and do not come back.')

  await ensureSchema()
  const activities = await countActivitiesForAccount(id)
  if (activities > 0) {
    warnings.push(`${activities} activity row(s) - the whole conversation stream - are deleted with it.`)
  }
  await withWrite(async (conn) => {
    await conn.run(`DELETE FROM crm_activities WHERE account_id = ?`, [id])
    await conn.run(`DELETE FROM crm_contacts WHERE account_id = ?`, [id])
    await conn.run(`DELETE FROM crm_accounts WHERE id = ?`, [id])
  })

  return {
    id,
    name: account.name,
    deleted: true,
    contacts_deleted: account.contacts.length,
    activities_deleted: activities,
    reimporting_contacts: reimporting,
    will_reimport: reimporting.length > 0,
    warnings,
  }
}

// --- contact writes ------------------------------------------------------------------------------------

/** At most one primary per account: promoting one demotes every sibling, in one statement. */
async function demoteSiblings(accountId: string, keepId: string): Promise<void> {
  await withWrite(async (conn) => {
    await conn.run(
      `UPDATE crm_contacts SET is_primary = 0, updated_at = now() WHERE account_id = ? AND id <> ? AND is_primary = 1`,
      [accountId, keepId] as DuckDBValue[],
    )
  })
}

/**
 * Create or partially update a contact. `account_id` is required on create and re-parents on update;
 * it is refused unless the account exists, because a contact hanging off a company that is not in
 * the pipeline is a row nobody will ever see again.
 *
 * The FIRST contact of an account becomes its primary automatically - an account with people but no
 * primary is a state nothing surfaces and everyone forgets to fix.
 */
export async function upsertCrmContact(input: CrmContactInput): Promise<CrmContact> {
  assertValidId('contact', input.id)
  const prev = await readCrmContact(input.id)
  const accountId = input.account_id ?? prev?.account_id
  if (!accountId) throw new Error(`crm contact ${input.id}: account_id is required on create`)

  const account = await readRecord<CrmAccount>(CRM_ACCOUNTS, { id: accountId })
  if (!account) {
    throw new Error(`crm contact ${input.id}: unknown account "${accountId}" - create the account first`)
  }

  const email = clearable(input.email)
  const phone = clearable(input.phone)
  const linkedin = clearable(input.linkedin_url)

  // Primary: an explicit flag wins; otherwise the first contact of an account is primary by default.
  const siblings = await withRead<{ n: number }>(
    `SELECT count(*) AS n FROM crm_contacts WHERE account_id = ? AND id <> ?`,
    [accountId, input.id],
  )
  const isFirst = Number(siblings[0]?.n ?? 0) === 0
  const isPrimary =
    input.is_primary !== undefined ? (input.is_primary ? 1 : 0) : (prev?.is_primary ?? (isFirst ? 1 : 0))

  await upsertRecord<CrmContact>(
    CRM_CONTACTS,
    {
      id: input.id,
      account_id: accountId,
      // Identity (provider-owned on connected rows, freely editable on hand-created ones).
      name: input.name ?? prev?.name ?? input.id,
      headline: input.headline ?? prev?.headline ?? '',
      linkedin_url: linkedin !== undefined ? linkedin : (prev?.linkedin_url ?? null),
      // Derived matching index, recomputed on every write so it can never drift from the raw URL.
      linkedin_key: linkedinKey(linkedin !== undefined ? linkedin : (prev?.linkedin_url ?? null)),
      // Box-owned.
      email: email !== undefined ? email : (prev?.email ?? null),
      phone: phone !== undefined ? phone : (prev?.phone ?? null),
      role: input.role ?? prev?.role ?? 'other',
      is_primary: isPrimary,
      tags: normalizeTags(input.tags ?? prev?.tags),
      notes: input.notes ?? prev?.notes ?? '',
      // Structural / provider-owned: kept as-is on update, empty on a hand-created insert.
      external_stage: prev?.external_stage ?? null,
      data_source_id: prev?.data_source_id ?? null,
      external_id: prev?.external_id ?? null,
      external: prev?.external ?? {},
      first_seen_at: prev?.first_seen_at ?? new Date().toISOString(),
      last_activity_at: prev?.last_activity_at ?? null,
      ...(input.actor ? { actor: input.actor } : {}),
    },
    { prev },
  )
  if (isPrimary === 1) await demoteSiblings(accountId, input.id)
  // A re-parent can strand the OLD account without a primary; heal it the same way a delete does.
  if (prev && prev.account_id !== accountId) {
    await ensurePrimary(prev.account_id)
    // Activities carry a denormalized account_id, so a re-parent would otherwise leave this
    // person's conversation history hanging off the account they just left. Dynamic import: the
    // provider write path imports this module, and a static edge back would be a cycle.
    const { healActivitiesForContact } = await import('./activities.js')
    await healActivitiesForContact(input.id)
  }
  return (await readCrmContact(input.id))!
}

/** If an account has contacts but none is primary, promote the oldest. Deterministic, and it keeps
 *  "an account with people has someone to call" true after every delete and re-parent. */
async function ensurePrimary(accountId: string): Promise<string | null> {
  const rows = await readRecords<CrmContact>(CRM_CONTACTS, {
    where: 'account_id = ?',
    params: [accountId],
    orderBy: 'is_primary DESC, created_at, id',
  })
  if (rows.length === 0 || Number(rows[0].is_primary) === 1) return null
  const promote = rows[0]
  await withWrite(async (conn) => {
    await conn.run(`UPDATE crm_contacts SET is_primary = 1, updated_at = now() WHERE id = ?`, [promote.id])
  })
  return promote.id
}

/**
 * Delete a contact and report what that means. Delete is for mistakes and for people gone from the
 * source: a connected contact still at a scanned stage upstream comes back on the next sync. If the
 * deleted contact was the account's primary, the oldest remaining contact is promoted (deterministic
 * and reported), because an account with people and no primary is a silent broken state.
 */
export async function deleteCrmContact(id: string): Promise<CrmContactDeleteReport> {
  const contact = await readCrmContact(id)
  if (!contact) {
    return {
      id,
      name: id,
      account_id: '',
      deleted: false,
      connected: false,
      data_source_id: null,
      external_stage: null,
      will_reimport: false,
      activities_deleted: 0,
      promoted_primary: null,
      account_left_empty: false,
      warnings: [`No contact with id "${id}" - nothing was deleted.`],
    }
  }

  const connected = contact.data_source_id !== null
  const external = contact.external_stage
  const willReimport =
    connected && external !== null && (CRM_IMPORT_STAGES as readonly string[]).includes(external)

  const activities = await countActivitiesForContact(id)
  await withWrite(async (conn) => {
    await conn.run(`DELETE FROM crm_activities WHERE contact_id = ?`, [id])
  })
  await deleteRecord(CRM_CONTACTS, { id })
  const promoted = await ensurePrimary(contact.account_id)
  const remaining = await readRecords<CrmContact>(CRM_CONTACTS, {
    where: 'account_id = ?',
    params: [contact.account_id],
  })

  const warnings: string[] = []
  if (willReimport) {
    warnings.push(
      `Still at ${external} upstream (${contact.data_source_id}) - they will re-import on the next sync and re-attach to this account. Archive the account instead if you want them out of the way.`,
    )
  } else if (connected) {
    warnings.push(
      `Connected to ${contact.data_source_id} but last reported as "${external ?? 'unknown'}", which the import does not scan - they should stay gone.`,
    )
  } else {
    warnings.push('Hand-created (no data source) - nothing will re-import them.')
  }
  if (activities > 0) {
    warnings.push(`${activities} activity row(s) - their side of the conversation stream - were deleted with them.`)
  }
  if (promoted) warnings.push(`They were the primary contact; "${promoted}" was promoted in their place.`)
  if (remaining.length === 0) {
    warnings.push('This account now has NO contacts. Add one, or archive the account.')
  }

  return {
    id,
    name: contact.name,
    account_id: contact.account_id,
    deleted: true,
    connected,
    data_source_id: contact.data_source_id,
    external_stage: external,
    will_reimport: willReimport,
    activities_deleted: activities,
    promoted_primary: promoted,
    account_left_empty: remaining.length === 0,
    warnings,
  }
}
