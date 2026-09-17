// Mirror of the server's CRM domain (packages/core/src/features/crm/types.ts). The tRPC router reflects
// nested DTO arrays as `unknown[]`, so useCrmData casts the wire shape to these types - the same
// pattern planning-types / content-types use.
//
// Two nouns: an ACCOUNT is a company and carries the lifecycle (there is no Deal object, so the
// account IS the deal); a CONTACT is a human at exactly one account, with a role.

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

export const CRM_ACCOUNT_STATUS_LABEL: Record<CrmAccountStatus, string> = {
  stale: 'Stale',
  meeting_requested: 'Meeting requested',
  meeting_booked: 'Meeting booked',
  demo: 'Demo',
  proposal: 'Proposal',
  confirmed: 'Confirmed',
  customer: 'Customer',
  onboarding: 'Onboarding',
  at_risk: 'At risk',
  revisit: 'Revisit',
  churned: 'Churned',
  lost: 'Lost',
  archived: 'Archived',
}

/** They are paying us today. The one predicate anything money-shaped uses. */
export const CRM_PAYING_STATUSES: CrmAccountStatus[] = ['customer', 'onboarding', 'at_risk']
/** Still in play pre-sale - the working pipeline. */
export const CRM_PIPELINE_STATUSES: CrmAccountStatus[] = [
  'meeting_requested',
  'meeting_booked',
  'demo',
  'proposal',
  'confirmed',
]

// There is deliberately no product / plan / price vocabulary here: the deal shape is a per-team
// recipe (features/crm/AGENT.md, "Adding a deal shape"), not part of the foundation, and `mrr_usd`
// is stored as typed. A team that adds one mirrors its unions and labels in this file.

export type CrmWaitingOn = 'me' | 'them'
export const CRM_WAITING_ON: CrmWaitingOn[] = ['me', 'them']
export const CRM_WAITING_ON_LABEL: Record<CrmWaitingOn, string> = {
  me: 'On me',
  them: 'On them',
}

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

export const CRM_ACCOUNT_SOURCE_LABEL: Record<CrmAccountSource, string> = {
  direct: 'Direct',
  inbound: 'Inbound',
  outbound: 'Outbound',
  referral: 'Referral',
  partner: 'Partner',
  existing: 'Existing customer',
  unknown: 'Unknown',
}

export type CrmContactRole = 'decision_maker' | 'buyer' | 'user' | 'other'

export const CRM_CONTACT_ROLES: CrmContactRole[] = ['decision_maker', 'buyer', 'user', 'other']

export const CRM_CONTACT_ROLE_LABEL: Record<CrmContactRole, string> = {
  decision_maker: 'Decision maker',
  buyer: 'Buyer',
  user: 'User / SDR',
  other: 'Other',
}

export interface CrmContact {
  id: string
  account_id: string
  name: string
  headline: string
  email: string | null
  phone: string | null
  linkedin_url: string | null
  role: CrmContactRole
  /** 1 = the account's primary contact (at most one per account). */
  is_primary: number
  external_stage: string | null
  data_source_id: string | null
  external_id: string | null
  external: Record<string, unknown>
  tags: string[]
  notes: string
  first_seen_at: string
  last_activity_at: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
}

export interface CrmAccount {
  id: string
  name: string
  status: CrmAccountStatus
  owner: string | null
  source: CrmAccountSource
  referral_partner: string | null
  /** The operator's working estimate for weighing the pipeline. NOT a finance number. */
  mrr_usd: number | null
  close_probability: number | null
  waiting_on: CrmWaitingOn
  next_action: string
  next_action_at: string | null
  last_contacted_at: string | null
  subscription_start_at: string | null
  subscription_end_at: string | null
  /** A1 - paused: suppressed from BOTH MRR and churn while set. */
  paused_since: string | null
  /** A1 - EXPECTED restart. Expected, not promised. */
  paused_until: string | null
  /** A2 - why a real deal died. */
  loss_reason: string | null
  /** A5 - `open` means nobody has looked, which is NOT `low`. */
  renewal_risk: CrmRenewalRisk
  renewal_risk_note: string | null
  renewal_risk_reviewed_at: string | null
  website: string | null
  tags: string[]
  notes: string
  data_source_id: string | null
  external_id: string | null
  /** R1 - the Stripe customer (`cus_...`). At most one account per customer id. */
  stripe_customer_id: string | null
  /** R1 - the platform space this account's usage lives in. */
  supabase_space_id: string | null
  /** R2 - the WhatsApp group (`...@g.us`). Human-set: group names do not identify an account. */
  whatsapp_group_jid: string | null
  external: Record<string, unknown>
  first_seen_at: string
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
  contacts: CrmContact[]
}

export interface CrmAccountDeleteReport {
  id: string
  name: string
  deleted: boolean
  contacts_deleted: number
  activities_deleted: number
  reimporting_contacts: string[]
  will_reimport: boolean
  warnings: string[]
}

export interface CrmContactDeleteReport {
  id: string
  name: string
  account_id: string
  deleted: boolean
  connected: boolean
  data_source_id: string | null
  external_stage: string | null
  will_reimport: boolean
  activities_deleted: number
  promoted_primary: string | null
  account_left_empty: boolean
  warnings: string[]
}

/** The contact the sync owns the identity of - i.e. this person came from a data source. */
export const isConnected = (c: CrmContact): boolean => c.data_source_id !== null

/** The account's primary contact, or the first one, or null. */
export const primaryContact = (a: CrmAccount): CrmContact | null =>
  a.contacts.find((c) => c.is_primary === 1) ?? a.contacts[0] ?? null

/** Pipeline weighting: the operator estimate times their own read of the odds. Never a forecast. */
export const weightedMrr = (a: CrmAccount): number | null =>
  a.mrr_usd == null ? null : a.mrr_usd * ((a.close_probability ?? 100) / 100)

// --- phase 3: meetings + revenue events ---------------------------------------------------------
// Mirror of packages/core/src/features/crm/{types,meetings,revenue}.ts. Read the ModelSpec comments
// in packages/core/src/features/crm/models.ts before changing any of the semantics these labels describe.

export type CrmRenewalRisk = 'low' | 'open' | 'high'
export const CRM_RENEWAL_RISKS: CrmRenewalRisk[] = ['low', 'open', 'high']
export const CRM_RENEWAL_RISK_LABEL: Record<CrmRenewalRisk, string> = {
  low: 'Low',
  open: 'Not reviewed',
  high: 'High',
}

export type CrmMeetingKind = 'discovery' | 'demo' | 'other'
export const CRM_MEETING_KINDS: CrmMeetingKind[] = ['discovery', 'demo', 'other']
export const CRM_MEETING_KIND_LABEL: Record<CrmMeetingKind, string> = {
  discovery: 'Discovery',
  demo: 'Demo',
  other: 'Other',
}

export type CrmMeetingOutcome = 'scheduled' | 'held' | 'no_show' | 'cancelled'
export const CRM_MEETING_OUTCOMES: CrmMeetingOutcome[] = ['scheduled', 'held', 'no_show', 'cancelled']
export const CRM_MEETING_OUTCOME_LABEL: Record<CrmMeetingOutcome, string> = {
  scheduled: 'Scheduled',
  held: 'Held',
  no_show: 'No-show',
  cancelled: 'Cancelled',
}

export type CrmMeetingSource = 'calendar' | 'transcript' | 'manual'
export type CrmMeetingMatchedBy = 'contact_email' | 'domain' | 'title' | 'manual'

/** The confidence rubric, for the muted hint beside a matched row. */
export const CRM_MATCH_CONFIDENCE: Record<string, 'high' | 'medium' | 'low'> = {
  contact_email: 'high',
  payer_email: 'high',
  reseller_comment: 'high',
  manual: 'high',
  domain: 'medium',
  title: 'low',
}

export interface CrmMeeting {
  id: string
  account_id: string | null
  contact_id: string | null
  kind: CrmMeetingKind
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

export type CrmRevenueProvider = 'hubspot' | 'stripe' | 'manual'
export type CrmRevenueKind = 'recurring' | 'one_off'
export const CRM_REVENUE_KINDS: CrmRevenueKind[] = ['recurring', 'one_off']
export const CRM_REVENUE_KIND_LABEL: Record<CrmRevenueKind, string> = {
  recurring: 'Recurring',
  one_off: 'One-off',
}

export type CrmRevenueStatus = 'open' | 'paid' | 'voided' | 'refunded'
export const CRM_REVENUE_STATUSES: CrmRevenueStatus[] = ['open', 'paid', 'voided', 'refunded']
export const CRM_REVENUE_STATUS_LABEL: Record<CrmRevenueStatus, string> = {
  open: 'Open',
  paid: 'Paid',
  voided: 'Voided',
  refunded: 'Refunded',
}

export type CrmRevenueMatchedBy = 'payer_email' | 'reseller_comment' | 'contact_email' | 'domain' | 'manual'

export interface CrmRevenueEvent {
  id: string
  account_id: string | null
  provider: CrmRevenueProvider
  kind: CrmRevenueKind
  status: CrmRevenueStatus
  amount: number
  currency: string
  /** Frozen at issued_at's rate - the receivable. */
  amount_usd: number
  /** Struck at paid_at's rate - the collection. */
  collected_usd: number | null
  fx_rate: number
  fx_rate_month: string | null
  issued_at: string
  due_at: string | null
  paid_at: string | null
  refunded_at: string | null
  period_months: number | null
  covers_from: string | null
  covers_to: string | null
  payer_email: string | null
  external_invoice_id: string | null
  invoice_number: string | null
  external_payment_id: string | null
  external_subscription_id: string | null
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

export interface CrmEventDeleteReport {
  id: string
  deleted: boolean
  account_id: string | null
  will_reimport: boolean
  warnings: string[]
}

/**
 * A paid recurring row with no coverage window cannot be walked, forecast or billed from, and the
 * failure is silent and twelve-fold. Mirrors needsCoverage() in core - keep the two in step.
 */
export const needsCoverage = (e: CrmRevenueEvent): boolean =>
  e.status === 'paid' && e.kind === 'recurring' && (!e.covers_from || !e.covers_to)

/**
 * A past meeting nobody has closed out. Mirrors needsOutcome() in core - keep the two in step.
 * `scheduled` on a past row is an open question, not a state: no machine may assert `no_show`.
 */
export const needsOutcome = (m: CrmMeeting, now: number = Date.now()): boolean =>
  m.outcome === 'scheduled' && new Date(m.scheduled_at).getTime() < now

/**
 * One message with a contact - the account conversation stream.
 *
 * Hand-mirrored from `packages/core/src/features/crm/types.ts`, like every other type in this file: apps/web
 * deliberately does not depend on @silkweave/box-core. Adding a channel is therefore a two-file edit.
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
export const CRM_ACTIVITY_CHANNEL_LABEL: Record<CrmActivityChannel, string> = {
  linkedin: 'LinkedIn',
  email: 'Email',
  whatsapp: 'WhatsApp',
  call: 'Call',
  letter: 'Letter',
  other: 'Other',
}
export type CrmActivityDirection = 'inbound' | 'outbound'

export interface CrmActivity {
  id: string
  account_id: string
  contact_id: string
  channel: CrmActivityChannel
  /** `inbound` = the contact wrote it. */
  direction: CrmActivityDirection
  occurred_at: string
  body: string
  subject: string | null
  thread_id: string | null
  thread_index: number | null
  message_type: string | null
  interaction_type: string | null
  author_name: string
  campaign_id: string | null
  campaign_name: string
  data_source_id: string | null
  external_id: string | null
}
