// The crm feature's tables. PERSONAL DATA lives here - the `crm_` prefix exists so "no crm_* table
// is ever publicly reachable" stays a greppable, scannable claim.

import type { ModelSpec } from '../../warehouse/model.js'
import {
  CRM_ACCOUNT_SOURCES, CRM_ACCOUNT_STATUSES, CRM_WAITING_ON, CRM_CONTACT_ROLES,
  CRM_MEETING_KINDS, CRM_MEETING_OUTCOMES, CRM_MEETING_SOURCES, CRM_MEETING_MATCHED_BY,
  CRM_REVENUE_PROVIDERS, CRM_REVENUE_KINDS, CRM_REVENUE_STATUSES, CRM_REVENUE_MATCHED_BY,
  CRM_RENEWAL_RISKS,
  CRM_ACTIVITY_CHANNELS, CRM_ACTIVITY_DIRECTIONS,
} from './types.js'

/**
 * An ACCOUNT - one company, and the unit the pipeline is worked in. There is deliberately no Deal
 * object (a four-person team does not need a multi-deal model), so the account IS the deal and
 * `status` carries the whole lifecycle: `stale → meeting_requested → meeting_booked → demo → proposal → confirmed → customer → onboarding`, with
 * `at_risk` / `churned` / `lost` / `archived` as the exits. Lead, Customer and Churned are therefore
 * three values of one column, never three tables.
 *
 * OWNERSHIP: every column here is Box-owned today (CRM_ACCOUNT_BOX_COLUMNS in crm/types.ts) - an
 * account is a human judgment about a company, and the import only ever CREATES one with a seeded
 * status or attaches a contact to an existing one; it never edits one. Structural columns are `id`,
 * `data_source_id`, `external_id`, `first_seen_at` and the audit stamps.
 *
 * `mrr_usd` IS NOT A FINANCE NUMBER. A billing provider (and the finance ledger) remain the source
 * of truth for money; this column is the operator's hand-maintained working estimate, and it exists
 * for exactly one reason: a pipeline you cannot sort or weigh by value is not a pipeline. It is
 * never summed into anything presented as revenue. When the `stripe` provider lands it - together
 * with `subscription_start_at` / `subscription_end_at` (CRM_ACCOUNT_FUTURE_PROVIDER_COLUMNS) -
 * becomes provider-owned on connected accounts, and the hand value survives only where no provider
 * claims the row: the same live-over-manual precedence `signal_points` already implements.
 *
 * It is stored AS TYPED. There is no product, plan, seat or price column beside it: the deal shape
 * is one team's commercial vocabulary, not the foundation's (a product decision, 2026-09-14), and a
 * team that wants MRR derived from its shape adds those columns with the recipe in
 * features/crm/AGENT.md - crm/types.ts says why a derived number beats a typed one.
 *
 * PERSONAL DATA lives in the crm_* tables - never publicly exposed (every crm route sits behind
 * `AuthGuard`, which is deny-by-default), no raw sync snapshot, and
 * message history lives in `crm_activities` (since 2026-09-13 - it used to be fetched on open and
 * stored nowhere). The `crm_` prefix exists so "no crm_* table is
 * ever publicly reachable" stays a greppable, scannable claim.
 */
export const CRM_ACCOUNTS: ModelSpec = {
  table: 'crm_accounts',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },                                    // structural: a slug ('acme-uk')
    name: { kind: 'text' },                                  // Box-owned
    status: { kind: 'text', default: "'meeting_requested'", enum: CRM_ACCOUNT_STATUSES },  // Box-owned
    owner: { kind: 'text', nullable: true },                 // Box-owned; users.id, validated on write
    source: { kind: 'text', default: "'unknown'", enum: CRM_ACCOUNT_SOURCES },    // Box-owned
    referral_partner: { kind: 'text', nullable: true },      // Box-owned; "Jo at Acme"
    mrr_usd: { kind: 'float', nullable: true },              // Box-owned - NOT a finance number, see above
    close_probability: { kind: 'int', nullable: true },      // Box-owned; 0-100
    waiting_on: { kind: 'text', default: "'me'", enum: CRM_WAITING_ON },          // Box-owned
    next_action: { kind: 'text', default: "''" },            // Box-owned
    next_action_at: { kind: 'date', nullable: true },        // Box-owned
    last_contacted_at: { kind: 'date', nullable: true },     // Box-owned
    subscription_start_at: { kind: 'date', nullable: true }, // Box-owned -> provider-owned once a billing provider connects
    subscription_end_at: { kind: 'date', nullable: true },   // Box-owned -> provider-owned once a billing provider connects
    website: { kind: 'text', nullable: true },               // Box-owned
    tags: { kind: 'json', default: "'[]'" },                 // Box-owned
    notes: { kind: 'text', default: "''" },                  // Box-owned
    data_source_id: { kind: 'text', nullable: true },        // structural; reserved for the billing join
    external_id: { kind: 'text', nullable: true },           // structural
    paused_since: { kind: 'date', nullable: true },           // Box (A1) - suppresses from MRR and churn
    paused_until: { kind: 'date', nullable: true },           // Box (A1) - EXPECTED restart, not promised
    loss_reason: { kind: 'text', nullable: true },            // Box (A2) - without it win rate is unmeasurable
    renewal_risk: { kind: 'text', default: "'open'", enum: CRM_RENEWAL_RISKS },  // Box (A5); `open` = nobody looked
    renewal_risk_note: { kind: 'text', nullable: true },      // Box (A5)
    renewal_risk_reviewed_at: { kind: 'date', nullable: true },  // Box (A5) - the date is the point
    // The three EXTERNAL LINKS (R1/R2, 2026-09-03). They lived in `external` and were therefore
    // frozen at whatever the first import wrote: `@Mcp()` input fields are scalar-only, so a
    // `Record<string, unknown>` is not expressible and no API path could write them. Real columns
    // instead of a writable JSON bag - what matters is that there is exactly ONE place the link
    // lives, so there is no second copy to drift.
    // Uniqueness is a domain rule, not DDL (F4): one customer id on two accounts double-counts MRR
    // the moment the billing provider owns that number, so upsertCrmAccount refuses it (R3).
    stripe_customer_id: { kind: 'text', nullable: true },     // structural link - `cus_...`
    supabase_space_id: { kind: 'text', nullable: true },      // structural link - the platform space
    whatsapp_group_jid: { kind: 'text', nullable: true },     // structural link - `...@g.us`; name
                                                              // matching is unsafe (near-identical
                                                              // group names, a v.2 suffix)
    external: { kind: 'json', default: "'{}'" },             // per-system ids + health/scoring
                                                             // breakdowns that earn no column:
                                                             // company_urn (matching rung 3),
                                                             // currency, fx_rate, health_score,
                                                             // icp_fit, win/churn reasons, …
    name_key: { kind: 'text', default: "''" },              // derived: companyNameKey(name).
                                                             // A MATCHING index for the sync's
                                                             // ladder, never authoritative -
                                                             // `name` is what a human reads.
    first_seen_at: { kind: 'timestamp', default: 'now()' },  // structural
  },
  timestamps: true,
  audit: true,
}

/**
 * A CONTACT - one human at exactly one account. An account has one or more (a decision maker, a
 * buyer, the SDRs who actually use the product); `role` says which, `is_primary` marks the one to
 * talk to. A contact MAY also be a user of a connected data source - that is what `data_source_id` +
 * `external_id` + `external` express, and it is how the import attaches an imported person to an account.
 *
 * OWNERSHIP is the signal_points live-vs-manual split at column grain (crm/types.ts):
 * CRM_CONTACT_PROVIDER_COLUMNS (name, headline, linkedin_url, external_stage, external,
 * last_activity_at) are overwritten freely by the sync on connected rows; CRM_CONTACT_BOX_COLUMNS
 * (account_id, role, is_primary, email, phone, tags, notes) are NEVER machine-written after insert.
 * Nothing here carries a lifecycle - that moved to the account, which is the whole point of the
 * two-table split.
 *
 * `is_primary` is an INTEGER 0/1 (the record layer has no bool kind). It lives on the contact rather
 * than as a pointer on the account so it dies with the row it describes - an account-side pointer
 * would dangle on every contact delete and need a fixup nobody would remember to write. At most one
 * primary per account, enforced in the domain on write.
 */
export const CRM_CONTACTS: ModelSpec = {
  table: 'crm_contacts',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },                        // imported: the source's lead id verbatim; manual: a slug
    account_id: { kind: 'text' },                // Box-owned; required, refused unless the account exists
    name: { kind: 'text' },                      // provider-owned on connected rows
    headline: { kind: 'text', default: "''" },   // provider-owned on connected rows
    email: { kind: 'text', nullable: true },     // Box-owned; the lead list surface carries none
    phone: { kind: 'text', nullable: true },     // Box-owned
    linkedin_url: { kind: 'text', nullable: true },  // provider-owned on connected rows
    role: { kind: 'text', default: "'other'", enum: CRM_CONTACT_ROLES },  // Box-owned
    is_primary: { kind: 'int', default: '0' },   // Box-owned; 0/1, at most one per account
    external_stage: { kind: 'text', nullable: true },  // provider-owned, verbatim ('INTERESTED')
    data_source_id: { kind: 'text', nullable: true },  // structural; null = hand-created
    external_id: { kind: 'text', nullable: true },     // structural
    external: { kind: 'json', default: "'{}'" }, // provider-owned: campaignId, listTitle, degree,
                                                 // counts - the fetch-on-open keys + fields not yet
                                                 // worth columns
    tags: { kind: 'json', default: "'[]'" },     // Box-owned
    notes: { kind: 'text', default: "''" },      // Box-owned
    linkedin_key: { kind: 'text', default: "''" },   // derived: linkedinKey(linkedin_url). Two
                                                     // spellings of one profile share this; the
                                                     // raw column keeps whatever was typed.
    first_seen_at: { kind: 'timestamp', default: 'now()' },    // structural
    last_activity_at: { kind: 'timestamp', nullable: true },   // provider-owned: max(lastSentAt, lastRespondedAt)
  },
  timestamps: true,
  audit: true,
}

/**
 * A MEETING - one sales conversation, keyed to an account. Deliberately its own noun rather than a
 * row in a general `crm_events` table, and the column that settles it is `outcome`: a meeting is a
 * FUTURE APPOINTMENT WITH A LIFECYCLE, not a past fact. The row exists up to 60 days before the
 * meeting happens (which is what makes `meeting_booked` derivable at all), then moves
 * `scheduled -> held / no_show / cancelled`, and `rescheduled_count` bumps along the way. An email,
 * a WhatsApp message or a logged call has none of that - no future tense, no no-show, no reschedule,
 * no duration, no meet code - so those belong in a future append-only touch table, not here. Fold
 * them together and two thirds of these columns are NULL on two thirds of the rows.
 *
 * A rescheduled meeting is the SAME row with a new time, never a second row; prior times land in
 * `external.rescheduled_from[]`. A meeting moved twice and then held is `held` with count 2.
 *
 * OWNERSHIP: CRM_MEETING_PROVIDER_COLUMNS are re-asserted by the calendar sync every run;
 * CRM_MEETING_BOX_COLUMNS are written on INSERT only and never again, which is what makes a human's
 * assignment survive. `outcome` is split by VALUE rather than by class - the sync may write `held`
 * and `cancelled`, never `no_show` (crm/types.ts says why).
 *
 * No DDL foreign key on `account_id` (the warehouse has none anywhere); integrity is domain-level in
 * upsertCrmMeeting, the same way upsertCrmContact refuses an unknown account.
 *
 * PERSONAL DATA: `attendee_email` is a real person's address, kept raw because it is the matcher's
 * input and an unmatched row must be re-matchable when a contact later gains an email. The `crm_`
 * prefix keeps "no crm_* table is ever publicly reachable" greppable.
 */
export const CRM_MEETINGS: ModelSpec = {
  table: 'crm_meetings',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },                                       // structural; idempotency IS the PK
    account_id: { kind: 'text', nullable: true },               // Box; null = assign queue
    contact_id: { kind: 'text', nullable: true },               // Box
    kind: { kind: 'text', default: "'other'", enum: CRM_MEETING_KINDS },        // Box (title-seeded)
    scheduled_at: { kind: 'timestamp' },                        // provider; naive UTC
    duration_min: { kind: 'int', nullable: true },              // provider; "held for 4 min" is a no-show in disguise
    outcome: { kind: 'text', default: "'scheduled'", enum: CRM_MEETING_OUTCOMES },
    rescheduled_count: { kind: 'int', default: '0' },           // provider
    source: { kind: 'text', enum: CRM_MEETING_SOURCES },        // structural
    external_id: { kind: 'text', nullable: true },              // structural; the calendar event id
    meet_code: { kind: 'text', nullable: true },                // provider; how `held` is proven
    attendee_email: { kind: 'text', nullable: true },           // provider; the matcher's input, raw
    title: { kind: 'text', default: "''" },                     // provider; evidence when `kind` parsed wrong
    matched_by: { kind: 'text', nullable: true, enum: CRM_MEETING_MATCHED_BY },  // structural
    notes: { kind: 'text', default: "''" },                     // Box; the sync never touches it
    external: { kind: 'json', default: "'{}'" },                // provider; organizer, attendees[],
                                                                // conference record, transcript path,
                                                                // rescheduled_from[]
    first_seen_at: { kind: 'timestamp', default: 'now()' },     // structural
  },
  timestamps: true,
  audit: true,
}

/**
 * A REVENUE EVENT - one money event, at the grain of the invoice where one exists, else the payment.
 * An open invoice is a row at `open` with no payment id; when it is paid the SAME row moves to `paid`
 * and gains `external_payment_id`, `paid_at` and `collected_usd`.
 *
 * Separate from `crm_meetings` because money mutates on a different axis and carries amounts,
 * currency and a provider that owns it. Separate from the alerting `events` table (above) because
 * that is a dedup-keyed notification spine, not a ledger - the name collision is unfortunate and the
 * `crm_` prefix is what disambiguates.
 *
 * NOT a finance ledger. Sleek owns the books; this is the sales-side view of money, and
 * `crm_accounts.mrr_usd` remains the operator's hand-maintained pipeline-weighting estimate rather
 * than being replaced by it.
 *
 * THREE DESIGN CALLS THAT DEVIATE FROM THE PRD, each because the PRD's version corrupts a number the
 * board report already shows:
 *
 * 1. `covers_from` / `covers_to` are STORED, not derived from `paid_at + period_months`. The PRD's
 *    MRR walk computes coverage arithmetically, which manufactures BOTH fake churn and - worse -
 *    fake NEW BUSINESS: a quarterly customer who renews 40 days late leaves an uncovered month, so
 *    the walk reports churn, then reports them as new next month. Annual prepays hit this once a
 *    year, every year, and "new MRR" is the number a board leans on hardest. Storing the window
 *    makes the walk a plain overlap query, makes a late renewal correctable by backdating coverage
 *    instead of by a magic grace constant, and makes the A4 case (a 12-month prepay that arrived
 *    with no subscription object behind it, a 12x error if it defaults to one month) VISIBLE rather
 *    than silent. It also answers
 *    A3 for free: next bill date is `covers_to` on the account's last paid recurring row.
 *
 * 2. `amount_usd` is FROZEN at `issued_at`'s rate and `collected_usd` is a separate column at
 *    `paid_at`'s rate. The PRD rewrites `amount_usd` when an invoice is paid, which means a
 *    receivables report re-run three months later silently reports different history - and it
 *    contradicts the PRD's own reason for storing `amount_usd` at all ("so the report and the row can
 *    never disagree"). Under FRS 21 a receivable and a collection are genuinely two flows in two
 *    months at two rates; two columns say that, one column hides it.
 *
 * 3. `superseded_by` is a real column, filtered by readCrmRevenueEvents by default, rather than a key
 *    in `external` with every consumer deduplicating on (account_id, invoice_number, paid_at). The
 *    HubSpot->Stripe migration makes one invoice two rows; pushing that onto readers is the
 *    derive-on-read pattern point 2 above rejects.
 *
 * PROVIDER MIGRATION is a value change, not a schema change: `id` is namespaced
 * (`hubspot:inv:...` / `stripe:inv:...`) so both eras coexist, the three external ids exist in both
 * systems, and `upsertImportedRevenueEvent` is the single writer both fetchers map onto.
 *
 * A REFUND is a status change plus `refunded_at`, never a negative row - negative rows make every
 * naive SUM a trap, and someone always writes the naive SUM.
 */
export const CRM_REVENUE_EVENTS: ModelSpec = {
  table: 'crm_revenue_events',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },                                       // structural; idempotency IS the PK
    account_id: { kind: 'text', nullable: true },               // Box; null = assign queue
    provider: { kind: 'text', enum: CRM_REVENUE_PROVIDERS },    // structural
    kind: { kind: 'text', default: "'recurring'", enum: CRM_REVENUE_KINDS },   // Box (human) - never inferred
    status: { kind: 'text', enum: CRM_REVENUE_STATUSES },       // provider
    amount: { kind: 'float' },                                  // provider; original currency, positive
    currency: { kind: 'text' },                                 // provider; ISO 4217, never assumed
    amount_usd: { kind: 'float' },                              // provider; FROZEN at issued_at's rate
    collected_usd: { kind: 'float', nullable: true },           // provider; set at paid_at's rate
    fx_rate: { kind: 'float', default: '1.0' },                 // provider; USD per unit of `currency`
    fx_rate_month: { kind: 'text', nullable: true },            // provider; 'YYYY-MM', so amount_usd reproduces
    issued_at: { kind: 'date' },                                // provider; the receivables clock
    due_at: { kind: 'date', nullable: true },                   // provider
    paid_at: { kind: 'date', nullable: true },                  // provider; the walk buckets on THIS
    refunded_at: { kind: 'date', nullable: true },              // provider
    period_months: { kind: 'int', nullable: true },             // Box; 1, 3, 12 - the coverage seed
    covers_from: { kind: 'date', nullable: true },              // Box; stored, see design call 1
    covers_to: { kind: 'date', nullable: true },                // Box; also answers A3 (next bill)
    payer_email: { kind: 'text', nullable: true },              // provider; raw - the attribution key
    external_invoice_id: { kind: 'text', nullable: true },      // structural
    invoice_number: { kind: 'text', nullable: true },           // provider; 'INV-1042', what humans quote
    external_payment_id: { kind: 'text', nullable: true },      // structural
    external_subscription_id: { kind: 'text', nullable: true }, // structural; does NOT seed `kind`
    superseded_by: { kind: 'text', nullable: true },            // structural; cutover, see design call 3
    description: { kind: 'text', default: "''" },               // provider; the only trace of seats/plan
    matched_by: { kind: 'text', nullable: true, enum: CRM_REVENUE_MATCHED_BY },  // structural
    notes: { kind: 'text', default: "''" },                     // Box
    external: { kind: 'json', default: "'{}'" },                // provider; portal_id, method, stripe ids
    first_seen_at: { kind: 'timestamp', default: 'now()' },     // structural
  },
  timestamps: true,
  audit: true,
}

/**
 * An ACTIVITY - one message exchanged with a contact. This is the append-only touch table
 * `crm_meetings` deliberately refused to become (see its own comment): a meeting is a future
 * appointment with a lifecycle - outcome, no-show, reschedule, duration - and a message is a past
 * fact with a body. Two thirds of either table's columns would be NULL on the other's rows.
 *
 * WHY NOT A ROW IN `events`: that table is the ALERTING spine, keyed `(kind, dedup_key)`, with no
 * account or contact to join on. This is CRM personal data, and it lives behind the `crm_` prefix
 * so "no crm_* table is ever publicly reachable" stays one greppable, scannable claim.
 *
 * `id` IS the idempotency, the same convention as `gcal:<event>` and `stripe:inv:<id>`:
 * `<provider>:msg:<upstream message id>`. A webhook retry, a backfill re-run and a live push of the
 * same message all resolve to one row, which is what makes the sync safe to run repeatedly.
 *
 * `account_id` is DENORMALIZED from the contact. The account page's query - the entire reason this
 * table exists - is "every message with this company, across all of its people", and that should
 * not be a join through a table whose rows can be re-parented. The cost is a heal when a contact
 * moves account.
 *
 * `direction` is derived UPSTREAM (`authorId === leadId`) and stored here, so the stream never has
 * to know which party was the lead.
 *
 * PROVIDER-OWNED IN FULL. No human write path today, and no `notes` column: a note about a message
 * is a note on the contact.
 */
export const CRM_ACTIVITIES: ModelSpec = {
  table: 'crm_activities',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },                            // '<provider>:msg:<message id>'
    account_id: { kind: 'text' },                    // denormalized from the contact
    contact_id: { kind: 'text' },
    channel: { kind: 'text', default: "'linkedin'", enum: CRM_ACTIVITY_CHANNELS },
    direction: { kind: 'text', enum: CRM_ACTIVITY_DIRECTIONS },
    occurred_at: { kind: 'timestamp' },              // from deliveredAt (epoch MILLIseconds upstream)
    body: { kind: 'text', default: "''" },
    subject: { kind: 'text', nullable: true },       // InMail only
    thread_id: { kind: 'text', nullable: true },
    thread_index: { kind: 'int', nullable: true },   // upstream order WITHIN the thread; occurred_at
                                                     // alone is not a total order (ties exist)
    message_type: { kind: 'text', nullable: true },  // INMAIL | MESSAGE | INVITATION | ...
    interaction_type: { kind: 'text', nullable: true },  // FIRST_MESSAGE | FOLLOWUP | RESPONSE | ...
    author_name: { kind: 'text', default: "''" },    // who the stream shows as the sender
    campaign_id: { kind: 'text', nullable: true },
    campaign_name: { kind: 'text', default: "''" },
    data_source_id: { kind: 'text', nullable: true },
    external_id: { kind: 'text', nullable: true },   // the upstream message id, bare
    external: { kind: 'json', default: "'{}'" },
    first_seen_at: { kind: 'timestamp', default: 'now()' },
  },
  timestamps: true,
  audit: true,
}

export const CRM_MODELS: readonly ModelSpec[] = [CRM_ACCOUNTS, CRM_CONTACTS, CRM_MEETINGS, CRM_REVENUE_EVENTS, CRM_ACTIVITIES]
