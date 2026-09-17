// The CRM domain vocabulary.
//
// TWO nouns, since 2026-08-11 (this supersedes the PRD's original one-table `crm_people` call):
//
//   • an ACCOUNT is a company. It is the pipeline unit and it carries the lifecycle - because there
//     is deliberately no Deal object, the account IS the deal. "Lead / Customer / Churned" is an
//     account STATUS, so a prospect who buys is an edit, not a migration between types.
//   • a CONTACT is a human at an account. Every contact belongs to exactly one account; an account
//     has one or more of them, each with a ROLE (the real requirement: one account, five contacts,
//     one decision maker, one buyer, three SDRs who are the actual product users).
//
// A contact MAY additionally be a user of a connected data source - that link is `data_source_id` +
// `external_id` + `external` on the contact, which is also how the import (`import.ts`) attaches an
// imported person to an account.
//
// The word "lead" appears here only where it names the SOURCE side's own noun (their endpoints,
// their stage keys). It is not a type in this system - a lead is an account at an early status.

// --- account status --------------------------------------------------------------------------------

/**
 * The ONE account lifecycle vocabulary. It has to span both halves of the business, because there
 * is no Deal object to separate them: the pre-sale pipeline stages (what the Lark PipelineTracker
 * called Prospect / Call Booked / Demo Done / Proposal Sent / Follow-up Sent / Negotiation /
 * Trial - On Hold / Closed Won / Closed Lost) and the post-sale states (what the Lark Customers
 * sheet called Active / At Risk / Churned) are one column here.
 *
 * Collapsed hard on purpose - a stage nobody will ever filter on is a note, not an enum member.
 * The full source mapping lives in _docs/PRD/CRM.md § "The account status vocabulary"; the short
 * version is: Call Booked and Demo Done are both `engaged` (a live conversation), Proposal Sent /
 * Follow-up Sent / Negotiation are all `proposal` (a price is on the table), and the ceremony of
 * "Closed Won" is just `customer`.
 *
 * `at_risk` earns its place over a separate health column because it is the one post-sale state
 * that demands a different action today (chase the payment, chase the contact). The paying base is
 * therefore `status IN ('customer','at_risk')` - one documented predicate, and the two counts are
 * more informative side by side than a single blurred one.
 *
 * `archived` is the honest "remove": the row stays, imports keep refreshing provider-owned columns,
 * no events fire for it and the UI hides it by default - which is what makes "never re-import
 * someone a human archived" true by construction.
 *
 * Extending this list is a code edit, not a migration (enum validation is app-level, in the record
 * layer, driven by the `enum` on the CRM_ACCOUNTS ModelSpec).
 *
 * 2026-08-19 - the pre-sale half was RE-OPENED, on the sales side's read of how the cycle actually
 * runs. The v0.1 collapse above was correct about Lark's ceremony and wrong about one thing: it
 * left every live conversation in a single `engaged` bucket, which by August held a no-show, a
 * booked discovery call, a nurture-revisit and a demo being scheduled at the same time - four
 * different next actions under one word, so the board could not be read and nothing forecast.
 *
 * The ladder is now, in order:
 *
 *   stale -> meeting_requested -> meeting_booked -> demo -> proposal -> confirmed -> customer -> onboarding
 *
 * Top of funnel lives in the outreach tool that feeds the import, NOT here. A CRM account is created
 * the first time an upstream lead reaches EITHER "Meeting Requested" or "Meeting Booked" - a lead can
 * jump straight from Interested to a booked meeting without ever asking for one, so meeting_requested
 * is an entry point, not a prerequisite, and the account lands in whichever stage it actually reached.
 *
 * `demo` deliberately spans booked, held and evaluating-after. The commonest real stall is "the demo
 * happened and they are deciding internally", which has no price on the table yet; a stage that only
 * meant "booked" would either lie about those or push them into `proposal` and inflate the forecast.
 * Whether the demo is in the diary or already behind us is carried by `next_action` / `next_action_at`.
 *
 * `onboarding` sits AFTER `customer` because that is the order money arrives in: they pay, they are
 * a customer, then they get live. It is a paying status.
 *
 * `stale` (2026-08-31) sits BEFORE `meeting_requested` and is a PARKING BAY, not a rung. It holds a
 * deal that was real once and has had no contact for long enough that carrying it at its old stage
 * is a lie about the pipeline. It was introduced when 16 of 47 pipeline rows had not been contacted
 * since before 1 Aug 2026 - several since March - while still carrying stage, probability and MRR as
 * though they were live. The sales lead, 2026-08-31: "anything older than August needs to move to a
 * stale deal status for now. We'll revert this in the future."
 *
 * It is deliberately NOT in CRM_PIPELINE_STATUSES - forecasting revenue against a deal nobody is
 * working is exactly the lie it exists to remove - but it IS in PIPELINE_COLUMNS, as the first
 * column, because the whole point is that these stay visible rather than being quietly archived.
 * Same shape as `revisit`, different reason: `revisit` is a real deal with an external clock and a
 * date; `stale` is a deal with no clock at all until someone decides to restart it.
 *
 * It is NOT terminal. These are not lost - they are parked, and the exit is a human deciding to work
 * one again, at which point it goes back to whichever rung it actually reached.
 *
 * `confirmed` (2026-08-31) sits between `proposal` and `customer` and means WON BUT NOT PAID: terms
 * agreed, an invoice issued, cash not yet in. It exists because a deal spent three weeks looking
 * like an open proposal while everyone involved treated it as sold - seats agreed, an invoice out a
 * week later, a go-live date in the diary, and a `proposal` label that made the board lie in both
 * directions at once. Without it a won deal either understates as `proposal` or
 * overstates as `customer`, and `customer` is load-bearing: CRM_PAYING_STATUSES drives everything
 * money-shaped, so a row that has not paid must never enter it.
 *
 * It IS in CRM_PIPELINE_STATUSES - it is the most forecastable stage there is - and deliberately NOT
 * in CRM_PAYING_STATUSES. The exit is the payment landing, at which point it becomes `customer`; if
 * the deal dies here it goes to `lost` like any other pre-sale stage.
 *
 * `revisit` (2026-08-19) is a SIDING, not a rung. It holds a real opportunity whose clock is external
 * - they just signed with someone else, they are mid-contract, the budget resets next year - and the
 * only honest next step is to come back on a date. It is deliberately NOT in CRM_PIPELINE_STATUSES,
 * because forecasting revenue against a deal you have agreed not to work would be a lie; and it is
 * deliberately NOT terminal, because the whole point is that `next_action_at` fires and puts it back
 * in front of a human. The 3 / 6 / 9 / 12-month horizon is carried by that date, NOT by four separate
 * stages - the date field already exists and multiplying the vocabulary to store one would be worse.
 *
 * `prospect`, `engaged` and `trial` were the v0.1 values. They were RETIRED on 2026-08-19 once the
 * whole book had been re-staged onto the ladder above and no row referenced them. Two things had to
 * move with them, and both are easy to miss: `prospect` was the CRM_ACCOUNTS ModelSpec default AND
 * the fallback in crm/state.ts, so an account created without an explicit status would otherwise have
 * been written with a value no longer in this list - invalid on write, blank on the board. The default
 * is now `meeting_requested`, which is also the honest one: a CRM account exists because a human asked
 * for a meeting.
 */
export type CrmAccountStatus =
  | 'stale'
  | 'meeting_requested'
  | 'meeting_booked'
  | 'demo'
  | 'proposal'
  | 'confirmed'
  | 'customer'
  | 'onboarding'
  | 'at_risk'
  | 'revisit'
  | 'churned'
  | 'lost'
  | 'archived'

export const CRM_ACCOUNT_STATUSES: CrmAccountStatus[] = [
  'stale',
  'meeting_requested',
  'meeting_booked',
  'demo',
  'proposal',
  'confirmed',
  'customer',
  'onboarding',
  'at_risk',
  'revisit',
  'churned',
  'lost',
  'archived',
]

/** Statuses that mean "they are paying us today". The one predicate everything money-shaped uses. */
export const CRM_PAYING_STATUSES: CrmAccountStatus[] = ['customer', 'onboarding', 'at_risk']

/** Statuses still in play pre-sale - the working pipeline. */
export const CRM_PIPELINE_STATUSES: CrmAccountStatus[] = [
  'meeting_requested',
  'meeting_booked',
  'demo',
  'proposal',
  'confirmed',
]

/**
 * Where the account came from. Collapsed from the Lark sheets' two overlapping columns (Customers
 * `Channel`: Direct / FC Partner / Partner; PipelineTracker `Source`: Referral / LinkedIn Outbound /
 * Inbound / Existing Customer). "FC Partner" vs "Partner" is not a source difference - WHICH partner
 * is carried by `referral_partner`, so both collapse to `partner`.
 */
export type CrmAccountSource = 'direct' | 'inbound' | 'outbound' | 'referral' | 'partner' | 'existing' | 'unknown'

export const CRM_ACCOUNT_SOURCES: CrmAccountSource[] = [
  'direct',
  'inbound',
  'outbound',
  'referral',
  'partner',
  'existing',
  'unknown',
]

// --- the deal shape ---------------------------------------------------------------------------------
//
// Deliberately ABSENT from the foundation (a product decision, 2026-09-14). WHAT an account buys
// (product), HOW it is billed (plan, term), how many (seats, profiles, units) and at what price are
// one team's commercial vocabulary, and until that date the template shipped one company's - two
// product lines, eight plan names and a USD price list. The foundation keeps `mrr_usd` as a plainly
// stored number: what the account is worth per month is the one deal fact every pipeline needs,
// whatever is being sold.
//
// A deal shape that DERIVES `mrr_usd` (quantity x unit price / months in the term) is the upgrade,
// not the baseline, and it is worth making: the same price typed by hand three times landed as 332,
// 332.3 and 332.33, which no report can group on. The recipe - the two axes, the derivation, the
// rounding rule and every file a new enum column touches - is "Adding a deal shape" in
// features/crm/AGENT.md. The seam it plugs into is the resolve-before-write block in
// upsertCrmAccount (state.ts).

/**
 * Who the ball is with. The single most useful thing a pipeline board can tell you, and the one the
 * date alone cannot: "I owe them screenshots" and "I am waiting on their Friday slot" have the same
 * due date and are completely different jobs.
 */
export type CrmWaitingOn = 'me' | 'them'
export const CRM_WAITING_ON: CrmWaitingOn[] = ['me', 'them']

// --- contact role ----------------------------------------------------------------------------------

/**
 * What this human does in the deal. Straight from the requirement ("1 is decision maker, 1 is
 * buyer, 3 are SDRs / users") plus an `other` escape hatch, because a four-value enum that forces a
 * guess is worse than one that admits it does not know.
 *
 * `user` means a product user (the SDR seat), which is also the role an imported contact lands in
 * until a human says otherwise.
 */
export type CrmContactRole = 'decision_maker' | 'buyer' | 'user' | 'other'

export const CRM_CONTACT_ROLES: CrmContactRole[] = ['decision_maker', 'buyer', 'user', 'other']

/**
 * The CHANNEL an activity happened on. Named `channel` rather than `type` because this repo already
 * uses "channel" for exactly this axis, and `type` would sit beside `message_type` meaning
 * something else entirely.
 *
 * `linkedin` is the only one a SYNC writes today. The rest exist for the hand-logged path
 * (`logCrmActivity`), which is how a call, an untracked email or a letter gets into the history -
 * and the reason the list is not just "whatever the sync sends".
 *
 * `call` is here rather than in `crm_meetings` on purpose: a meeting is a future appointment with a
 * lifecycle, a logged call is a past fact with a body. `models.ts` settles that boundary.
 * `other` is the escape hatch, so a channel nobody anticipated never blocks recording what happened.
 */
export type CrmActivityChannel = 'linkedin' | 'email' | 'whatsapp' | 'call' | 'letter' | 'other'
export const CRM_ACTIVITY_CHANNELS: CrmActivityChannel[] = [
  'linkedin',
  'email',
  'whatsapp',
  'call',
  'letter',
  'other',
]

/** Labels for the channel picker + the stream. */
export const CRM_ACTIVITY_CHANNEL_LABEL: Record<CrmActivityChannel, string> = {
  linkedin: 'LinkedIn',
  email: 'Email',
  whatsapp: 'WhatsApp',
  call: 'Call',
  letter: 'Letter',
  other: 'Other',
}

/** Which way it went, from our side: `inbound` = the contact wrote it, called us, sent
 *  it. For a call that means who placed it. */
export type CrmActivityDirection = 'inbound' | 'outbound'
export const CRM_ACTIVITY_DIRECTIONS: CrmActivityDirection[] = ['inbound', 'outbound']

/** One message with a contact. Provider-owned in full; there is no human write path today. */
export interface CrmActivity {
  id: string
  account_id: string
  contact_id: string
  channel: CrmActivityChannel
  direction: CrmActivityDirection
  /** Naive-UTC, the warehouse convention. */
  occurred_at: string
  body: string
  subject: string | null
  thread_id: string | null
  /** The upstream's order within the thread. `occurred_at` alone is not a total order. */
  thread_index: number | null
  message_type: string | null
  interaction_type: string | null
  author_name: string
  campaign_id: string | null
  campaign_name: string
  data_source_id: string | null
  external_id: string | null
  external: Record<string, unknown>
  first_seen_at: string
  created_at: string
  updated_at: string
}

// --- the import's external vocabulary ---------------------------------------------------------------

/**
 * The UPSTREAM stage keys the import scans, verbatim - the `external_stage` values that mean "still
 * active at the source, will re-import". `crm-contact-delete` uses the same list to decide whether a
 * deleted contact will simply come back on the next scan. Kept HERE, in the domain, so the two sides
 * can never drift apart. The shipped keys are a placeholder vocabulary: a team wiring its own sync
 * replaces them with the stages its source actually reports.
 */
export const CRM_IMPORT_STAGES = ['INTERESTED', 'CONVERTED', 'CLOSED'] as const

/**
 * The one-time seed map: what ACCOUNT STATUS a brand-new account gets when the import has to create
 * one for an imported contact. It stays deliberately timid - an imported lead never arrives as
 * `customer`, because a source's "closed" is not known to mean "won" and inventing a customer is the
 * one mistake this table must never make. A human promotes.
 *
 * PROVISIONAL since 2026-08-19 - remapped off the retired `prospect` / `engaged` so the file compiles,
 * but the KEYS are the problem: the rule sales actually set is that an account is created the first
 * time an upstream lead reaches EITHER "Meeting Requested" or "Meeting Booked", landing in whichever
 * stage it reached, and INTERESTED / CONVERTED / CLOSED are not those stages. Nothing reads this map
 * today; a team wiring a sync redesigns it against the stage keys its source really reports.
 */
export const CRM_ACCOUNT_STATUS_SEED: Record<(typeof CRM_IMPORT_STAGES)[number], CrmAccountStatus> = {
  INTERESTED: 'meeting_requested',
  CONVERTED: 'meeting_booked',
  CLOSED: 'meeting_booked',
}

// --- column ownership -------------------------------------------------------------------------------

/**
 * Column ownership, as data - the `signal_points` live-vs-manual split applied at COLUMN grain,
 * now across two tables. Every writer builds its update set from exactly one class:
 *
 *   • PROVIDER-owned: a sync overwrites these freely on CONNECTED rows. Upstream is the source of
 *     truth for who a person IS, so a hand edit to a connected contact's identity will be reverted
 *     by the next sync - documented behavior; the escape hatches are `notes` and unconnected rows.
 *   • Box-owned: NEVER machine-written after the one seed on INSERT.
 *   • structural: ids, first_seen_at, the audit stamps.
 *
 * ACCOUNTS have no provider-owned columns today: an account is a human judgment about a company,
 * and the import only ever creates one (seeded status) or attaches to an existing one - it never
 * edits one. That changes when the `stripe` provider lands: `mrr_usd`,
 * `subscription_start_at` and `subscription_end_at` move to the provider class for connected
 * accounts, which is exactly why those three are listed apart below.
 */
export const CRM_ACCOUNT_BOX_COLUMNS = [
  'paused_since',
  'paused_until',
  'loss_reason',
  'renewal_risk',
  'renewal_risk_note',
  'renewal_risk_reviewed_at',
  'name',
  'status',
  'owner',
  'source',
  'referral_partner',
  'mrr_usd',
  'close_probability',
  'waiting_on',
  'next_action',
  'next_action_at',
  'last_contacted_at',
  'subscription_start_at',
  'subscription_end_at',
  'website',
  'tags',
  'notes',
] as const

/**
 * Box-owned today; these become provider-owned per account once a money provider connects it. A
 * team that adds a deal shape (features/crm/AGENT.md) lists its quantity, plan and price columns
 * here too: a billing provider knows all three, and declaring that up front is what stops a
 * hand-maintained shape being silently overwritten the day the provider lands.
 */
export const CRM_ACCOUNT_FUTURE_PROVIDER_COLUMNS = [
  'mrr_usd',
  'subscription_start_at',
  'subscription_end_at',
] as const

export const CRM_CONTACT_PROVIDER_COLUMNS = [
  'name',
  'headline',
  'linkedin_url',
  'external_stage',
  'external',
  'last_activity_at',
] as const

export const CRM_CONTACT_BOX_COLUMNS = ['account_id', 'role', 'is_primary', 'email', 'phone', 'tags', 'notes'] as const

// --- rows -------------------------------------------------------------------------------------------

/** One company. Mirrors the CRM_ACCOUNTS ModelSpec (warehouse/models.ts) column for column. */
export interface CrmAccount {
  /** A slug (`acme-uk`). Accounts are hand-created or created by the import; either way a slug. */
  id: string
  name: string
  /** The lifecycle. Box-owned, always - no machine ever writes this after the one seed on insert. */
  status: CrmAccountStatus
  /** users.id - who works this account (validated on write). */
  owner: string | null
  source: CrmAccountSource
  /** Free text: "Jo at Acme", "a partner's name (their firm)". Queried ("what came from Jo"). */
  referral_partner: string | null
  /**
   * The operator's working monthly number, in USD. NOT A FINANCE NUMBER - see the ModelSpec comment.
   * It exists so the pipeline can be sorted and weighed; Stripe remains the source of truth for money.
   */
  mrr_usd: number | null
  /** 0-100. The operator's read. Pipeline weighting = mrr * this. */
  close_probability: number | null
  /** Who the next action is waiting on. */
  waiting_on: CrmWaitingOn
  next_action: string
  next_action_at: string | null
  last_contacted_at: string | null
  subscription_start_at: string | null
  /** Churn date / subscription end. Set means the money stopped (or is scheduled to). */
  subscription_end_at: string | null
  /** A1 - set while a paying account is paused. Suppresses it from BOTH MRR and churn. */
  paused_since: string | null
  /** A1 - when they are EXPECTED back. Expected, not promised; the cash calendar reads it. */
  paused_until: string | null
  /** A2 - why a real deal died. Set `status: lost` (not `archived`) or win rate stays unmeasurable. */
  loss_reason: string | null
  /** A5 - `open` means nobody has looked, which is deliberately not `low`. */
  renewal_risk: CrmRenewalRisk
  renewal_risk_note: string | null
  renewal_risk_reviewed_at: string | null
  website: string | null
  /** Derived: `companyNameKey(name)`. A matching index, never authoritative - see crm/identity.ts. */
  name_key: string
  tags: string[]
  notes: string
  /** null = hand-created / migrated. Reserved for the stripe join (phase 4). */
  data_source_id: string | null
  external_id: string | null
  /** R1 - the Stripe customer (`cus_...`). At most one account per customer id (see R3: a shared
   *  one double-counts MRR the moment Stripe owns that number). */
  stripe_customer_id: string | null
  /** R1 - the platform space this account's usage lives in. */
  supabase_space_id: string | null
  /** R2 - the WhatsApp group (`...@g.us`). Set by a human: matching on group NAME is unsafe
   *  (near-identical names across several accounts, a `v.2` suffix, a double space in two). */
  whatsapp_group_jid: string | null
  /** Per-system ids and the health/scoring breakdowns that do not earn columns: `company_urn`
   *  (the matching ladder's rung 3), currency, mrr_local, fx_rate, health_score, icp_fit,
   *  win_reason, churn_reason, … The three LINKS moved out of here into columns on 2026-09-03. */
  external: Record<string, unknown>
  first_seen_at: string
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

/** One human at one account. Mirrors the CRM_CONTACTS ModelSpec column for column. */
export interface CrmContact {
  /** Imported: the source's lead id VERBATIM (so re-import is an upsert by primary key and the
   *  dedup key is structural). Hand-created: an ordinary slug. */
  id: string
  /** Required. Every contact belongs to exactly one account; re-parenting is a human act. */
  account_id: string
  name: string
  /** Job title / one-liner. Provider-owned on connected rows. */
  headline: string
  email: string | null
  phone: string | null
  linkedin_url: string | null
  /** Derived: `linkedinKey(linkedin_url)`. Two spellings of one profile share it. */
  linkedin_key: string
  role: CrmContactRole
  /** 0 or 1 - the record layer has no bool kind. At most one primary per account, enforced on write. */
  is_primary: number
  /** Provider-owned: what the source last reported about this person, verbatim ('INTERESTED'). */
  external_stage: string | null
  /** null = hand-created. Non-null = this contact IS a user of that data source and the sync owns
   *  the identity columns on this row. */
  data_source_id: string | null
  external_id: string | null
  external: Record<string, unknown>
  tags: string[]
  notes: string
  first_seen_at: string
  /** max(lastSentAt, lastRespondedAt) upstream. Provider-owned. */
  last_activity_at: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

/** The read shape the dashboard works with: an account with its people attached. */
export interface CrmAccountWithContacts extends CrmAccount {
  contacts: CrmContact[]
}

// --- write inputs ------------------------------------------------------------------------------------

/** What a human (dashboard, MCP agent, REST) may write to an account. Every column here is
 *  Box-owned; `data_source_id` / `external_id` / `external` are structural and are not writable. */
export interface CrmAccountInput {
  id: string
  name?: string
  status?: CrmAccountStatus
  /** users.id; '' clears it. Refused unless the user exists. */
  owner?: string | null
  source?: CrmAccountSource
  /** '' clears it. */
  referral_partner?: string | null
  /** null / a negative number clears it. */
  mrr_usd?: number | null
  /** 0-100; refused outside that range. */
  close_probability?: number | null
  waiting_on?: CrmWaitingOn
  next_action?: string
  /** 'YYYY-MM-DD'; '' clears it. */
  next_action_at?: string | null
  last_contacted_at?: string | null
  subscription_start_at?: string | null
  subscription_end_at?: string | null
  /** 'YYYY-MM-DD'; '' clears it. Setting it suppresses the account from MRR and churn (A1). */
  paused_since?: string | null
  paused_until?: string | null
  /** '' clears it. */
  loss_reason?: string | null
  renewal_risk?: CrmRenewalRisk
  renewal_risk_note?: string | null
  /** Stamped automatically when `renewal_risk` or its note changes, unless passed explicitly. */
  renewal_risk_reviewed_at?: string | null
  /** '' clears it. */
  website?: string | null
  tags?: string[]
  notes?: string
  /** R1/R2 - the external links. '' clears each. Refused when another account already holds the
   *  same value (R3), because one id on two rows double-counts whatever it is the key to. */
  stripe_customer_id?: string | null
  supabase_space_id?: string | null
  whatsapp_group_jid?: string | null
  /** users.id performing this write (audit stamp). */
  actor?: string
}

/**
 * What a human may write to a contact. Box columns plus the identity fields; the provider-owned
 * `external_stage` / `external` / `last_activity_at` are deliberately absent.
 *
 * Identity edits ARE allowed on connected rows in v1 (the next sync reverts them) rather than
 * refused: a hard refusal would also block fixing a truncated name on a source that will never
 * re-send it. Revisit on the first surprise.
 */
export interface CrmContactInput {
  id: string
  /** Required on create; on update it re-parents the contact to another account. */
  account_id?: string
  name?: string
  headline?: string
  /** '' clears it. */
  email?: string | null
  phone?: string | null
  linkedin_url?: string | null
  role?: CrmContactRole
  /** true promotes this contact to primary and demotes the account's previous primary. */
  is_primary?: boolean
  tags?: string[]
  notes?: string
  actor?: string
}

// --- delete reports ------------------------------------------------------------------------------------

/**
 * What `crm-account-delete` hands back. Deleting an account CASCADES to its contacts (they cannot
 * exist without one), so the report says how many people went with it - and warns when any of them
 * were connected, because those come back on the next import as contacts of a freshly created
 * account, with the status re-seeded and the account's whole working state gone.
 */
export interface CrmAccountDeleteReport {
  id: string
  name: string
  deleted: boolean
  /** How many contacts were cascade-deleted with the account. */
  contacts_deleted: number
  /** How many activity rows (the conversation stream) went with it. */
  activities_deleted: number
  /** Contacts that were connected to a data source and will therefore re-import. */
  reimporting_contacts: string[]
  will_reimport: boolean
  warnings: string[]
}

/**
 * What `crm-contact-delete` hands back. Delete is for MISTAKES and for people gone from the source -
 * it is not an opt-out: a connected contact still at an imported stage upstream comes back on the
 * next scan. Saying so at the moment of deletion is the whole point of this report.
 */
export interface CrmContactDeleteReport {
  id: string
  name: string
  account_id: string
  deleted: boolean
  connected: boolean
  data_source_id: string | null
  external_stage: string | null
  will_reimport: boolean
  /** How many of their activity rows (messages, calls, letters) went with them. */
  activities_deleted: number
  /** Set when this contact was the account's primary and another contact was promoted in its place. */
  promoted_primary: string | null
  /** True when the account is now left with no contacts at all. */
  account_left_empty: boolean
  warnings: string[]
}

// --- meetings (phase 3) -------------------------------------------------------------------------

/**
 * What KIND of sales conversation this was. The sales side's vocabulary, and the reason it is only three
 * values: discovery and demo are the two rungs the funnel is measured on, and a demo is a SECOND
 * meeting on the same account rather than a rename of the first. Everything else is `other`.
 *
 * Seeded from the `Discovery - ` / `Demo - ` calendar title prefix on insert; a human may correct
 * it, and after that the sync never touches it (Box-owned).
 *
 * `onboarding` and `support` are deliberately ABSENT even though the matcher will see those calls
 * and file them as `other`. They are customer-side, and adding them now would quietly reopen the
 * customer-success scope SCOPE.md fences off. Add them the day something actually reports on them.
 */
export type CrmMeetingKind = 'discovery' | 'demo' | 'other'
export const CRM_MEETING_KINDS: CrmMeetingKind[] = ['discovery', 'demo', 'other']

/**
 * What became of the meeting. This is the column that makes `crm_meetings` a different NOUN from
 * any future touch/activity log: a meeting is a future appointment with a lifecycle, not a past
 * fact. A row exists up to 60 days before the meeting happens (which is what makes
 * `meeting_booked` derivable at all), and then moves.
 *
 * `held` is machine-assertable: a conference record or an archive transcript exists for the event.
 * `cancelled` is machine-assertable: the calendar says so.
 *
 * `no_show` is NEVER machine-asserted, and that asymmetry is the whole point. A past event with no
 * transcript is either a no-show or a call held somewhere that does not record (Zoom, Teams, a
 * phone call, the prospect's own meeting room). Guessing turns "we have no evidence" into "they
 * stood us up", which is a lie about a customer. Such a row stays `scheduled` and surfaces in the
 * assign queue for a human to close out.
 */
export type CrmMeetingOutcome = 'scheduled' | 'held' | 'no_show' | 'cancelled'
export const CRM_MEETING_OUTCOMES: CrmMeetingOutcome[] = ['scheduled', 'held', 'no_show', 'cancelled']

/** Where the row came from. `transcript` is backfill-only: the archive had it, the calendar did not. */
export type CrmMeetingSource = 'calendar' | 'transcript' | 'manual'
export const CRM_MEETING_SOURCES: CrmMeetingSource[] = ['calendar', 'transcript', 'manual']

/**
 * How `account_id` was resolved - AUTHORITY.md's confidence rubric made queryable, so a report can
 * say "49 of 55 matched, 38 of them at HIGH confidence" instead of "49 of 55 matched".
 *
 *   • `contact_email` - an external attendee's email equals a crm_contacts.email. HIGH.
 *   • `domain`        - the attendee's domain resolves to exactly one account. MEDIUM, and measured
 *                       to be genuinely risky: a single domain can be shared by unrelated people who
 *                       are each their own account - independent consultants under one franchise
 *                       domain is the case that bit - so a domain match there merges two accounts.
 *                       Contact email is always tried first.
 *   • `title`         - the `<Company>` segment of the calendar title equals an account name
 *                       exactly (case-insensitive, trimmed - the findAccountForImport rule, never
 *                       fuzzy). LOW.
 *   • `manual`        - a human assigned it. Terminal: the sync never re-derives it.
 */
export type CrmMeetingMatchedBy = 'contact_email' | 'domain' | 'title' | 'manual'
export const CRM_MEETING_MATCHED_BY: CrmMeetingMatchedBy[] = ['contact_email', 'domain', 'title', 'manual']

// --- revenue events (phase 3) -------------------------------------------------------------------

/** Which system the external ids on the row belong to. The Stripe migration changes this value,
 *  not the schema - see the `id` column comment on CRM_REVENUE_EVENTS. */
export type CrmRevenueProvider = 'hubspot' | 'stripe' | 'manual'
export const CRM_REVENUE_PROVIDERS: CrmRevenueProvider[] = ['hubspot', 'stripe', 'manual']

/**
 * Recurring or one-off. **Defaults to `recurring`, and `one_off` is set by a HUMAN, never inferred.**
 *
 * The obvious rule - "no subscription association means one-off" - was tested against live data on
 * 2026-09-02 and came out wrong by a factor of TWENTY, overstating non-recurring revenue twentyfold.
 * It flagged ordinary monthly invoices, a first managed-service month and a seat expansion, because
 * those predate the billing provider's subscription objects or were raised by hand. Absence of a
 * subscription association is evidence about the BILLING SYSTEM's history, not about the deal.
 *
 * Genuinely non-recurring payments are rare - a one-off data enrichment, a block of extended support.
 * A default that is right ~99.5% of the time and wrong only where a human is already looking is the
 * correct default.
 *
 * The sync must NEVER write this column on an existing row.
 */
export type CrmRevenueKind = 'recurring' | 'one_off'
export const CRM_REVENUE_KINDS: CrmRevenueKind[] = ['recurring', 'one_off']

/**
 * The four states the reports need, and each earns its place against a live incident:
 *
 *   • `open`     - receivables. On the day this was measured four invoices were outstanding and NOT
 *                  ONE of them was mentioned on its account row. Receivables are invisible unless
 *                  the schema has somewhere to put them.
 *   • `paid`     - revenue.
 *   • `voided`   - noise. An invoice raised and then withdrawn is not revenue and is not a
 *                  receivable, and without a state of its own it is counted as one or the other.
 *   • `refunded` - the case that forces the state: an invoice can read `paid` in the billing system
 *                  against a charge the payment provider refunded IN FULL. Without this state,
 *                  collected revenue overstates and no report can see why.
 *
 * A refund is a STATUS CHANGE plus `refunded_at`, never a negative row. Negative rows make every
 * naive SUM a trap, and someone always writes the naive SUM.
 */
export type CrmRevenueStatus = 'open' | 'paid' | 'voided' | 'refunded'
export const CRM_REVENUE_STATUSES: CrmRevenueStatus[] = ['open', 'paid', 'voided', 'refunded']

/**
 * How `account_id` was resolved. Same rubric as meetings, two extra source-specific rungs:
 *
 *   • `payer_email`      - a contact carries that exact email. HIGH. Kept raw because one person
 *                          routinely talks from one address and pays from another, and it is common
 *                          enough that dropping the raw payer address loses real matches.
 *   • `reseller_comment` - the associated subscription's invoice-comment field names the sub-client.
 *                          HIGH, and it is what makes the RESELLER case automatic rather than a
 *                          permanent assign-queue resident: a reseller holds every seat under one
 *                          billing email with a generic product name, so the only thing that says
 *                          which end client a seat is for is free text on the invoice. Matching on
 *                          it is unglamorous and it is the difference between a queue that drains
 *                          and one that grows.
 */
export type CrmRevenueMatchedBy = 'payer_email' | 'reseller_comment' | 'contact_email' | 'domain' | 'manual'
export const CRM_REVENUE_MATCHED_BY: CrmRevenueMatchedBy[] = [
  'payer_email',
  'reseller_comment',
  'contact_email',
  'domain',
  'manual',
]

/**
 * A human's judgement on whether a renewal will happen, with a date attached (A5).
 *
 * This exists because the judgement is already being made and, before this column, lived in a build
 * script with no author and no date: marking one account `high` was the only reason its large
 * January invoice was excluded from the cash calendar bars, and including it would have created a
 * spike that dominates the year and probably will not happen. A number that load-bearing needs a
 * name and a date on it.
 *
 * `open` is the honest default and is NOT the same as `low` - it means nobody has looked. The
 * distinction matters in the months where several first-ever renewals land together: the fattest
 * month of the year can be fat mostly because of renewal DECISIONS rather than certainties, and a
 * forecast that cannot tell those apart is read as if it could.
 *
 * `renewal_risk_reviewed_at` is load-bearing, not decoration. A risk judgement with no review date
 * is a guess with a confident face on it, and it is exactly what rots first.
 */
export type CrmRenewalRisk = 'low' | 'open' | 'high'
export const CRM_RENEWAL_RISKS: CrmRenewalRisk[] = ['low', 'open', 'high']

// --- phase 3 column ownership ---------------------------------------------------------------------

/**
 * Provider-owned on a meeting: the calendar is the truth for WHEN and WHETHER, and re-asserts it on
 * every run. Note `outcome` is split by value, not by class - the sync may write `held` and
 * `cancelled`, never `no_show` (see CrmMeetingOutcome), which is enforced in upsertImportedMeeting
 * rather than expressible here.
 */
export const CRM_MEETING_PROVIDER_COLUMNS = [
  'scheduled_at',
  'duration_min',
  'outcome',
  'rescheduled_count',
  'meet_code',
  'attendee_email',
  'title',
  'external',
] as const

/** Box-owned on a meeting: written by the sync on INSERT only (when it can resolve them), never again. */
export const CRM_MEETING_BOX_COLUMNS = ['account_id', 'contact_id', 'kind', 'notes'] as const

/**
 * Provider-owned on a revenue event. `amount_usd` is in this list but is FROZEN after first write -
 * see the column comment. `covers_from` / `covers_to` are NOT here: they are seeded by the provider
 * on insert and are a human's to correct thereafter, which is the whole point of them.
 */
export const CRM_REVENUE_PROVIDER_COLUMNS = [
  'status',
  'amount',
  'currency',
  'fx_rate',
  'fx_rate_month',
  'issued_at',
  'due_at',
  'paid_at',
  'refunded_at',
  'payer_email',
  'invoice_number',
  'description',
  'external',
] as const

/**
 * Box-owned on a revenue event. `kind` is here and it is the important one: the sync must never
 * write it on an existing row (see CrmRevenueKind for the 20x error that rule prevents).
 */
export const CRM_REVENUE_BOX_COLUMNS = ['account_id', 'kind', 'period_months', 'covers_from', 'covers_to', 'notes'] as const

// --- phase 3 rows -------------------------------------------------------------------------------

/** One meeting instance. Mirrors the CRM_MEETINGS ModelSpec column for column. */
export interface CrmMeeting {
  /** `gcal:<calendar_event_id>` | `meet:<meet_code>:<yyyymmdd>` | a slug for manual rows. */
  id: string
  /** null = the assign queue. Refused unless the account exists when non-null. */
  account_id: string | null
  contact_id: string | null
  kind: CrmMeetingKind
  /** Naive-UTC. The x-axis of every meetings metric. */
  scheduled_at: string
  duration_min: number | null
  outcome: CrmMeetingOutcome
  rescheduled_count: number
  source: CrmMeetingSource
  external_id: string | null
  meet_code: string | null
  attendee_email: string | null
  title: string
  matched_by: CrmMeetingMatchedBy | null
  notes: string
  external: Record<string, unknown>
  first_seen_at: string
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

/** One money event. Mirrors the CRM_REVENUE_EVENTS ModelSpec column for column. */
export interface CrmRevenueEvent {
  /** `<provider>:inv:<id>` | `<provider>:pay:<id>` | a slug for manual rows. */
  id: string
  account_id: string | null
  provider: CrmRevenueProvider
  kind: CrmRevenueKind
  status: CrmRevenueStatus
  amount: number
  currency: string
  /** Frozen at `issued_at`'s rate on first write - see the ModelSpec column comment. */
  amount_usd: number
  /** Set when the money lands, at `paid_at`'s rate. Null while open. */
  collected_usd: number | null
  fx_rate: number
  /** 'YYYY-MM' - which month's rate `fx_rate` is, so amount_usd is reproducible. */
  fx_rate_month: string | null
  issued_at: string
  due_at: string | null
  paid_at: string | null
  refunded_at: string | null
  period_months: number | null
  /** The service window this payment buys. Seeded, then a human's to correct. */
  covers_from: string | null
  covers_to: string | null
  payer_email: string | null
  external_invoice_id: string | null
  invoice_number: string | null
  external_payment_id: string | null
  external_subscription_id: string | null
  /** Set on the OLD row when the same invoice is re-created under a new provider at cutover. */
  superseded_by: string | null
  description: string
  matched_by: CrmRevenueMatchedBy | null
  notes: string
  external: Record<string, unknown>
  first_seen_at: string
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

// --- phase 3 write inputs -----------------------------------------------------------------------

/**
 * What a human may write to a meeting. On a `manual` row every column is writable; on a calendar
 * row the DTO simply cannot express a provider-owned column, the same way UpsertCrmContactDto
 * cannot - so a tool call can never fight the calendar over when a meeting is.
 */
export interface CrmMeetingInput {
  id: string
  /** '' clears it (returns the row to the assign queue). Refused unless the account exists. */
  account_id?: string | null
  contact_id?: string | null
  kind?: CrmMeetingKind
  notes?: string
  /** Manual rows only - refused on a calendar/transcript row. */
  scheduled_at?: string
  duration_min?: number | null
  /** A human may set any outcome, including `no_show` (which no machine may set). */
  outcome?: CrmMeetingOutcome
  attendee_email?: string | null
  title?: string
  source?: CrmMeetingSource
  actor?: string
}

/** What a human may write to a revenue event. Same split: manual rows are fully writable, provider
 *  rows expose only the Box columns plus the coverage window. */
export interface CrmRevenueEventInput {
  id: string
  account_id?: string | null
  kind?: CrmRevenueKind
  period_months?: number | null
  /** 'YYYY-MM-DD'; the service window this payment buys. */
  covers_from?: string | null
  covers_to?: string | null
  notes?: string
  /** Manual rows only. */
  provider?: CrmRevenueProvider
  status?: CrmRevenueStatus
  amount?: number
  currency?: string
  fx_rate?: number
  issued_at?: string
  due_at?: string | null
  paid_at?: string | null
  refunded_at?: string | null
  payer_email?: string | null
  invoice_number?: string | null
  description?: string
  actor?: string
}

// --- phase 3 machine write inputs (F6) ------------------------------------------------------------
//
// The MACHINE path - `upsertImportedMeeting` / `upsertImportedRevenueEvent` - is a separate writer
// with its own DTO rather than a flag on the human one, for the same reason the human DTO cannot
// express a provider column: the type IS the ownership rule. Each input below is three groups:
//
//   • provider-owned columns, RE-ASSERTED on every run (`undefined` = the provider did not say,
//     keep the stored value; `null` = the provider says it is empty);
//   • the Box seeds, written only while the row has NEVER carried a value and then never again -
//     which is what makes a human's assignment, kind, notes or coverage window survive every
//     nightly run;
//   • the resolved attribution (`account_id` + `matched_by`), which is a seed with a rubric.
//
// What is deliberately INEXPRESSIBLE: `no_show` on a meeting, `kind` on a revenue event, and
// `matched_by: 'manual'` on either. Those are human words, and a DTO that cannot spell them is a
// stronger guarantee than a runtime check (which exists too, for callers that cast).

/** The outcomes a machine may assert. `no_show` is absent on purpose - see CrmMeetingOutcome. */
export type CrmMeetingMachineOutcome = Exclude<CrmMeetingOutcome, 'no_show'>

export interface CrmImportedMeetingInput {
  /** `gcal:<calendar_event_id>` or `meet:<meet_code>:<yyyymmdd>` - the prefix is enforced so a
   *  machine row can never collide with a human's manual slug. */
  id: string
  /** `calendar` or `transcript`; `manual` is the human path's word and is refused. */
  source: Exclude<CrmMeetingSource, 'manual'>
  /** The calendar event id (or meet code) as a queryable column. */
  external_id?: string | null
  // --- provider-owned, re-asserted every run ---
  /** ISO 8601. Moving it on an existing row bumps `rescheduled_count` and appends the prior time
   *  to `external.rescheduled_from[]` - same row, never a second one. */
  scheduled_at: string
  duration_min?: number | null
  /** `held` needs evidence (a conference record or transcript), `cancelled` needs the calendar to
   *  say so. Left undefined the stored outcome stands. */
  outcome?: CrmMeetingMachineOutcome
  meet_code?: string | null
  attendee_email?: string | null
  title?: string
  /** The provider's bag, replaced whole each run. `rescheduled_from[]` inside it is the writer's,
   *  carried across runs and never the caller's to set. */
  external?: Record<string, unknown>
  // --- Box seeds: written while the row has never carried a value, then never again ---
  /** Requires `matched_by`. Refused unless the account exists. */
  account_id?: string | null
  /** Must belong to `account_id`. */
  contact_id?: string | null
  /** How `account_id` was resolved; required whenever `account_id` is offered. Never `manual`. */
  matched_by?: Exclude<CrmMeetingMatchedBy, 'manual'> | null
  /** Parsed from the title prefix by the caller. Insert only. */
  kind?: CrmMeetingKind
  /** Insert only. */
  notes?: string
  /** users.id the run stamps into created_by/updated_by (validated). */
  actor?: string
}

export interface CrmImportedRevenueEventInput {
  /** `<provider>:inv:<id>` / `<provider>:pay:<id>` / `<provider>:ch:<id>` - the `<provider>:`
   *  prefix is enforced. */
  id: string
  /** `hubspot` or `stripe`; `manual` is the human path's word and is refused. */
  provider: Exclude<CrmRevenueProvider, 'manual'>
  // --- structural ids: asserted when given, kept when not (an open invoice gains its payment id
  //     on the run that sees it paid) ---
  external_invoice_id?: string | null
  external_payment_id?: string | null
  external_subscription_id?: string | null
  /** The newer provider's row for the same invoice, set on the OLDER row at cutover. Kept unless
   *  given, so the retired fetcher's history runs never clear it. */
  superseded_by?: string | null
  // --- provider-owned, re-asserted every run ---
  status: CrmRevenueStatus
  /** Original currency, non-negative. A refund is a status, never a negative amount. */
  amount: number
  /** ISO 4217. Never assumed, and never allowed to change on an existing row. */
  currency: string
  /** 'YYYY-MM-DD'. */
  issued_at: string
  due_at?: string | null
  paid_at?: string | null
  refunded_at?: string | null
  payer_email?: string | null
  invoice_number?: string | null
  description?: string
  external?: Record<string, unknown>
  // --- FX, explicit. Both are USD per unit of `currency`. ---
  /** The rate for `issued_at`'s month. Required on INSERT of a non-USD row; frozen thereafter
   *  (a later run cannot move `amount_usd` by passing a different one). */
  fx_rate?: number | null
  /** The rate for `paid_at`'s month, which strikes `collected_usd` once when the money lands.
   *  Required on a non-USD row the first time it is seen paid/refunded in a month other than
   *  the frozen `fx_rate_month`; in the same month `fx_rate` is by definition that rate. */
  fx_rate_paid?: number | null
  // --- Box seeds: written while the row has never carried a value, then never again ---
  /** Requires `matched_by`. Refused unless the account exists. */
  account_id?: string | null
  matched_by?: Exclude<CrmRevenueMatchedBy, 'manual'> | null
  /** Months of service the payment covers. The caller resolves it (line item, then plan); the
   *  writer never infers it - null on a paid recurring row is the A4 queue case, by design. */
  period_months?: number | null
  /** An explicit window when the provider knows it (Stripe's line period). Both or neither.
   *  Absent, the window is seeded from `paid_at + period_months` when the row is paid. */
  covers_from?: string | null
  covers_to?: string | null
  /** Insert only. */
  notes?: string
  actor?: string
}

/** What a machine write did. `unchanged` means NO write happened - the row already said all of
 *  this, so `updated_at` / `updated_by` still name the last real change (a human's, usually). */
export type CrmImportOp = 'inserted' | 'updated' | 'unchanged'

export interface CrmImportedMeetingResult {
  op: CrmImportOp
  meeting: CrmMeeting
  /** True when this run moved `scheduled_at` on an existing row. */
  rescheduled: boolean
}

export interface CrmImportedRevenueEventResult {
  op: CrmImportOp
  event: CrmRevenueEvent
}

/** What `crm-meeting-delete` / `crm-revenue-event-delete` hand back. Machines mark `cancelled` /
 *  `voided` and never delete, so a delete here is always a human undoing a mistake - and a calendar
 *  row still on the calendar comes straight back on the next run, which is what `will_reimport` says. */
export interface CrmEventDeleteReport {
  id: string
  deleted: boolean
  account_id: string | null
  /** True for a provider row whose source still holds it. */
  will_reimport: boolean
  warnings: string[]
}
