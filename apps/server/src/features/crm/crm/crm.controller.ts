import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString } from 'class-validator'
import { Mcp, Trpc } from '@silkweave/nestjs'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { type PrincipalRequest } from '../../../auth/auth.decorators.js'
import { CRM_ACTIVITY_CHANNELS, CRM_ACTIVITY_DIRECTIONS, deleteCrmActivity, logCrmActivity, readCrmActivities, type CrmActivity, type CrmActivityChannel, type CrmActivityDirection, CRM_ACCOUNT_SOURCES, CRM_MEETING_KINDS, CRM_MEETING_OUTCOMES, CRM_MEETING_SOURCES, CRM_MEETING_MATCHED_BY, CRM_RENEWAL_RISKS, CRM_REVENUE_KINDS, CRM_REVENUE_MATCHED_BY, CRM_REVENUE_PROVIDERS, CRM_REVENUE_STATUSES, deleteCrmMeeting, deleteCrmRevenueEvent, readCrmMeetings, readCrmMeetingQueue, readCrmRevenueEvents, readCrmRevenueQueue, upsertCrmMeeting, upsertCrmRevenueEvent, type CrmEventDeleteReport, type CrmMeeting, type CrmMeetingKind, type CrmMeetingOutcome, type CrmMeetingSource, type CrmRenewalRisk, type CrmRevenueEvent, type CrmRevenueKind, type CrmRevenueProvider, type CrmRevenueStatus, CRM_ACCOUNT_STATUSES, CRM_WAITING_ON, CRM_CONTACT_ROLES, deleteCrmAccount, deleteCrmContact, readCrmDocRegions, readCrmAccounts, readCrmDoc, saveCrmDoc, saveCrmDocRegions, upsertCrmAccount, upsertCrmContact, type CrmAccountDeleteReport, type CrmAccountSource, type CrmAccountStatus, type CrmWaitingOn, type CrmAccountWithContacts, type CrmContact, type CrmContactDeleteReport, type CrmContactRole, type CrmDoc } from '@silkweave/box-core'

// The @Mcp() adapter cannot express `| null`, so the clearable text fields take '' as "clear it"
// (the convention `target_signal_id` and `severity` already use). Omitting a field leaves the
// stored value alone.

class CrmContactDto {
  @ApiProperty() id!: string
  @ApiProperty() account_id!: string
  @ApiProperty() name!: string
  @ApiProperty() headline!: string
  @ApiProperty({ required: false, nullable: true }) email!: string | null
  @ApiProperty({ required: false, nullable: true }) phone!: string | null
  @ApiProperty({ required: false, nullable: true }) linkedin_url!: string | null
  @ApiProperty({ enum: CRM_CONTACT_ROLES }) role!: string
  @ApiProperty({ description: '1 = the account primary contact (at most one per account)' }) is_primary!: number
  @ApiProperty({ required: false, nullable: true }) external_stage!: string | null
  @ApiProperty({ required: false, nullable: true }) data_source_id!: string | null
  @ApiProperty({ required: false, nullable: true }) external_id!: string | null
  @ApiProperty({ type: Object }) external!: Record<string, unknown>
  @ApiProperty({ type: [String] }) tags!: string[]
  @ApiProperty() notes!: string
  @ApiProperty() first_seen_at!: string
  @ApiProperty({ required: false, nullable: true }) last_activity_at!: string | null
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}

class CrmAccountDto {
  @ApiProperty() id!: string
  @ApiProperty() name!: string
  @ApiProperty({ enum: CRM_ACCOUNT_STATUSES }) status!: string
  @ApiProperty({ required: false, nullable: true }) owner!: string | null
  @ApiProperty({ enum: CRM_ACCOUNT_SOURCES }) source!: string
  @ApiProperty({ required: false, nullable: true }) referral_partner!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'Operator working estimate - NOT a finance number' })
  mrr_usd!: number | null
  @ApiProperty({ required: false, nullable: true }) close_probability!: number | null
  @ApiProperty({ enum: CRM_WAITING_ON }) waiting_on!: string
  @ApiProperty() next_action!: string
  @ApiProperty({ required: false, nullable: true }) next_action_at!: string | null
  @ApiProperty({ required: false, nullable: true }) last_contacted_at!: string | null
  @ApiProperty({ required: false, nullable: true }) subscription_start_at!: string | null
  @ApiProperty({ required: false, nullable: true }) subscription_end_at!: string | null
  @ApiProperty({ required: false, nullable: true }) website!: string | null
  @ApiProperty({ type: [String] }) tags!: string[]
  @ApiProperty() notes!: string
  @ApiProperty({ required: false, nullable: true }) data_source_id!: string | null
  @ApiProperty({ required: false, nullable: true }) external_id!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'R1 - the Stripe customer (`cus_...`). At most one account per customer id' })
  stripe_customer_id!: string | null
  @ApiProperty({ required: false, nullable: true, description: "R1 - the platform space this account's usage lives in" })
  supabase_space_id!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'R2 - the WhatsApp group (`...@g.us`). Set by a human: group NAMES do not identify an account' })
  whatsapp_group_jid!: string | null
  @ApiProperty({ type: Object }) external!: Record<string, unknown>
  @ApiProperty({ required: false, nullable: true, description: 'A1 - paused since (YYYY-MM-DD). Suppresses the account from BOTH MRR and churn' })
  paused_since!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'A1 - EXPECTED restart date. Expected, not promised; the cash calendar reads it' })
  paused_until!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'A2 - why a real deal died' }) loss_reason!: string | null
  @ApiProperty({ enum: CRM_RENEWAL_RISKS, description: "A5 - `open` means nobody has looked, which is NOT `low`" })
  renewal_risk!: string
  @ApiProperty({ required: false, nullable: true }) renewal_risk_note!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'A5 - when the risk was last reviewed. A judgement with no review date is a guess' })
  renewal_risk_reviewed_at!: string | null
  @ApiProperty() first_seen_at!: string
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
  @ApiProperty({ type: [CrmContactDto] }) contacts!: CrmContactDto[]
}

// --- phase 3: meetings + revenue events ---------------------------------------------------------

class CrmMeetingDto {
  @ApiProperty({ description: '`gcal:<event id>` | `meet:<code>:<yyyymmdd>` | a slug for manual rows' }) id!: string
  @ApiProperty({ required: false, nullable: true, description: 'null = the assign queue' }) account_id!: string | null
  @ApiProperty({ required: false, nullable: true }) contact_id!: string | null
  @ApiProperty({ enum: CRM_MEETING_KINDS }) kind!: string
  @ApiProperty() scheduled_at!: string
  @ApiProperty({ required: false, nullable: true }) duration_min!: number | null
  @ApiProperty({ enum: CRM_MEETING_OUTCOMES, description: 'no_show is never machine-asserted - only a human sets it' })
  outcome!: string
  @ApiProperty() rescheduled_count!: number
  @ApiProperty({ enum: CRM_MEETING_SOURCES }) source!: string
  @ApiProperty({ required: false, nullable: true }) external_id!: string | null
  @ApiProperty({ required: false, nullable: true }) meet_code!: string | null
  @ApiProperty({ required: false, nullable: true }) attendee_email!: string | null
  @ApiProperty() title!: string
  @ApiProperty({ required: false, nullable: true, enum: CRM_MEETING_MATCHED_BY, description: 'Confidence: contact_email HIGH, domain MEDIUM, title LOW, manual terminal' })
  matched_by!: string | null
  @ApiProperty() notes!: string
  @ApiProperty({ type: Object }) external!: Record<string, unknown>
  @ApiProperty() first_seen_at!: string
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}

class CrmMeetingsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [CrmMeetingDto] }) meetings!: CrmMeetingDto[]
}

class CrmActivityDto {
  @ApiProperty() id!: string
  @ApiProperty() account_id!: string
  @ApiProperty() contact_id!: string
  @ApiProperty({ enum: CRM_ACTIVITY_CHANNELS }) channel!: CrmActivityChannel
  @ApiProperty({ enum: CRM_ACTIVITY_DIRECTIONS, description: 'inbound = the contact wrote it' })
  direction!: CrmActivityDirection
  @ApiProperty() occurred_at!: string
  @ApiProperty() body!: string
  @ApiProperty({ required: false, nullable: true }) subject!: string | null
  @ApiProperty({ required: false, nullable: true }) thread_id!: string | null
  @ApiProperty({ required: false, nullable: true }) thread_index!: number | null
  @ApiProperty({ required: false, nullable: true }) message_type!: string | null
  @ApiProperty({ required: false, nullable: true }) interaction_type!: string | null
  @ApiProperty() author_name!: string
  @ApiProperty({ required: false, nullable: true }) campaign_id!: string | null
  @ApiProperty() campaign_name!: string
  @ApiProperty({ required: false, nullable: true }) data_source_id!: string | null
  @ApiProperty({ required: false, nullable: true }) external_id!: string | null
}

class CrmActivitiesDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [CrmActivityDto] }) activities!: CrmActivityDto[]
}

class LogCrmActivityDto {
  @ApiProperty({ required: false, description: "Omit to create. Pass an existing 'manual:…' id to edit; a synced row is refused." })
  @IsOptional() @IsString() id?: string
  @ApiProperty({ description: 'crm_contacts.id - the person this touch was with. The account is derived from it.' })
  @IsString() contact_id!: string
  @ApiProperty({ enum: CRM_ACTIVITY_CHANNELS, description: 'How it happened. `call`/`letter`/`other` are the hand-logged ones; a meeting with a lifecycle is crm-meeting-upsert, not this.' })
  @IsIn(CRM_ACTIVITY_CHANNELS) channel!: CrmActivityChannel
  @ApiProperty({ enum: CRM_ACTIVITY_DIRECTIONS, description: 'inbound = they contacted us (for a call, who placed it).' })
  @IsIn(CRM_ACTIVITY_DIRECTIONS) direction!: CrmActivityDirection
  @ApiProperty({ required: false, description: 'ISO timestamp, or YYYY-MM-DD for the whole day. Defaults to now.' })
  @IsOptional() @IsString() occurred_at?: string
  @ApiProperty({ description: 'What was said. Required - an empty touch records nothing.' })
  @IsString() body!: string
  @ApiProperty({ required: false, description: 'Subject line, for an email or a letter.' })
  @IsOptional() @IsString() subject?: string
  @ApiProperty({ required: false, description: "Who said it. Defaults to the contact inbound, the actor outbound." })
  @IsOptional() @IsString() author_name?: string
  @ApiProperty({ required: false, description: 'users.id to stamp. Defaults to the authenticated principal - pass the real human, not the service account.' })
  @IsOptional() @IsString() actor?: string
}

class DeleteCrmActivityDto {
  @ApiProperty({ description: "The activity id. Only a hand-logged 'manual:…' row can be deleted." })
  @IsString() id!: string
}

class CrmActivityDeleteReportDto {
  @ApiProperty() id!: string
  @ApiProperty() deleted!: boolean
}

class CrmActivitiesListDto {
  @ApiProperty({ description: 'The account whose whole conversation to return' }) @IsString() account_id!: string
  @ApiProperty({ required: false, description: 'Cap the rows returned (default 500, oldest first)' })
  @IsOptional() @IsInt() limit?: number
}

class CrmMeetingsListDto {
  @ApiProperty({ required: false, description: 'Only this account' }) @IsOptional() @IsString() account_id?: string
  @ApiProperty({ required: false, description: 'scheduled_at >= this (ISO date or timestamp)' }) @IsOptional() @IsString() since?: string
  @ApiProperty({ required: false, description: 'scheduled_at <= this' }) @IsOptional() @IsString() until?: string
  @ApiProperty({ required: false, description: 'Only rows with no account - the assign queue' })
  @IsOptional() @IsBoolean() unassigned?: boolean
}

class UpsertCrmMeetingDto {
  @ApiProperty({ description: 'Meeting id' }) @IsString() id!: string
  @ApiProperty({ required: false, description: "crm_accounts.id ('' returns the row to the assign queue). Setting it stamps matched_by=manual, which is terminal - the sync will not re-derive it." })
  @IsOptional() @IsString() account_id?: string
  @ApiProperty({ required: false, description: "crm_contacts.id ('' clears). Must belong to the same account." })
  @IsOptional() @IsString() contact_id?: string
  @ApiProperty({ required: false, enum: CRM_MEETING_KINDS, description: 'discovery | demo | other. Seeded from the calendar title; correct it here.' })
  @IsOptional() @IsIn(CRM_MEETING_KINDS) kind?: CrmMeetingKind
  @ApiProperty({ required: false, enum: CRM_MEETING_OUTCOMES, description: 'A human may set no_show; no machine may.' })
  @IsOptional() @IsIn(CRM_MEETING_OUTCOMES) outcome?: CrmMeetingOutcome
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string
  @ApiProperty({ required: false, enum: CRM_MEETING_SOURCES, description: 'manual for a hand-entered call. Provider rows refuse the columns below.' })
  @IsOptional() @IsIn(CRM_MEETING_SOURCES) source?: CrmMeetingSource
  @ApiProperty({ required: false, description: 'MANUAL rows only - ISO 8601 start' }) @IsOptional() @IsString() scheduled_at?: string
  @ApiProperty({ required: false, description: 'MANUAL rows only' }) @IsOptional() @IsInt() duration_min?: number
  @ApiProperty({ required: false, description: "MANUAL rows only ('' clears)" }) @IsOptional() @IsString() attendee_email?: string
  @ApiProperty({ required: false, description: 'MANUAL rows only' }) @IsOptional() @IsString() title?: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class CrmRevenueEventDto {
  @ApiProperty({ description: '`<provider>:inv:<id>` | `<provider>:pay:<id>` | a slug for manual rows' }) id!: string
  @ApiProperty({ required: false, nullable: true, description: 'null = the assign queue' }) account_id!: string | null
  @ApiProperty({ enum: CRM_REVENUE_PROVIDERS }) provider!: string
  @ApiProperty({ enum: CRM_REVENUE_KINDS, description: 'Defaults to recurring; one_off is a HUMAN decision, never inferred' }) kind!: string
  @ApiProperty({ enum: CRM_REVENUE_STATUSES }) status!: string
  @ApiProperty({ description: 'Original currency, always positive - a refund is a status, not a negative row' }) amount!: number
  @ApiProperty({ description: 'ISO 4217' }) currency!: string
  @ApiProperty({ description: "FROZEN at issued_at's rate. The receivable." }) amount_usd!: number
  @ApiProperty({ required: false, nullable: true, description: "Struck at paid_at's rate. The collection." }) collected_usd!: number | null
  @ApiProperty() fx_rate!: number
  @ApiProperty({ required: false, nullable: true, description: "'YYYY-MM' - which month's rate, so amount_usd reproduces" }) fx_rate_month!: string | null
  @ApiProperty() issued_at!: string
  @ApiProperty({ required: false, nullable: true }) due_at!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'The MRR walk buckets on this, never on issued_at' }) paid_at!: string | null
  @ApiProperty({ required: false, nullable: true }) refunded_at!: string | null
  @ApiProperty({ required: false, nullable: true }) period_months!: number | null
  @ApiProperty({ required: false, nullable: true, description: 'Service window start - stored, not derived' }) covers_from!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'Service window end. Also the next bill date (A3).' }) covers_to!: string | null
  @ApiProperty({ required: false, nullable: true }) payer_email!: string | null
  @ApiProperty({ required: false, nullable: true }) external_invoice_id!: string | null
  @ApiProperty({ required: false, nullable: true }) invoice_number!: string | null
  @ApiProperty({ required: false, nullable: true }) external_payment_id!: string | null
  @ApiProperty({ required: false, nullable: true }) external_subscription_id!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'Set at provider cutover; superseded rows are hidden unless include_superseded' })
  superseded_by!: string | null
  @ApiProperty() description!: string
  @ApiProperty({ required: false, nullable: true, enum: CRM_REVENUE_MATCHED_BY }) matched_by!: string | null
  @ApiProperty() notes!: string
  @ApiProperty({ type: Object }) external!: Record<string, unknown>
  @ApiProperty() first_seen_at!: string
  @ApiProperty() created_at!: string
  @ApiProperty() updated_at!: string
  @ApiProperty({ required: false, nullable: true }) created_by!: string | null
  @ApiProperty({ required: false, nullable: true }) updated_by!: string | null
}

class CrmRevenueEventsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [CrmRevenueEventDto] }) events!: CrmRevenueEventDto[]
}

class CrmRevenueEventsListDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() account_id?: string
  @ApiProperty({ required: false, description: 'issued_at >= this (YYYY-MM-DD)' }) @IsOptional() @IsString() since?: string
  @ApiProperty({ required: false, enum: CRM_REVENUE_STATUSES }) @IsOptional() @IsIn(CRM_REVENUE_STATUSES) status?: CrmRevenueStatus
  @ApiProperty({ required: false, enum: CRM_REVENUE_KINDS }) @IsOptional() @IsIn(CRM_REVENUE_KINDS) kind?: CrmRevenueKind
  @ApiProperty({ required: false, description: 'Only rows with no account - the assign queue' })
  @IsOptional() @IsBoolean() unassigned?: boolean
  @ApiProperty({ required: false, description: 'Include rows replaced by a later provider copy of the same invoice. Default false.' })
  @IsOptional() @IsBoolean() include_superseded?: boolean
}

class CrmAssignQueueDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [CrmMeetingDto], description: 'Meetings with no account, or past and still scheduled' })
  meetings!: CrmMeetingDto[]
  @ApiProperty({ type: [CrmRevenueEventDto], description: 'Revenue rows with no account, or paid recurring with no coverage window' })
  events!: CrmRevenueEventDto[]
}

class UpsertCrmRevenueEventDto {
  @ApiProperty({ description: 'Revenue event id' }) @IsString() id!: string
  @ApiProperty({ required: false, description: "crm_accounts.id ('' returns the row to the assign queue). Stamps matched_by=manual." })
  @IsOptional() @IsString() account_id?: string
  @ApiProperty({
    required: false,
    enum: CRM_REVENUE_KINDS,
    description:
      'recurring | one_off. Defaults to recurring and is ONLY ever moved to one_off by a human - inferring it from a missing subscription reported $9,030 against a true $450.',
  })
  @IsOptional() @IsIn(CRM_REVENUE_KINDS) kind?: CrmRevenueKind
  @ApiProperty({ required: false, description: 'Months of service this payment covers (1, 3, 12)' })
  @IsOptional() @IsInt() period_months?: number
  @ApiProperty({ required: false, description: "Service window start, YYYY-MM-DD ('' clears). Seeded from paid_at; correct it here when a prepay or a late renewal makes the seed wrong." })
  @IsOptional() @IsString() covers_from?: string
  @ApiProperty({ required: false, description: "Service window end, YYYY-MM-DD ('' clears). This is also the next bill date." })
  @IsOptional() @IsString() covers_to?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string
  @ApiProperty({ required: false, enum: CRM_REVENUE_PROVIDERS, description: 'manual for a bank transfer with no invoice anywhere. Provider rows refuse the columns below.' })
  @IsOptional() @IsIn(CRM_REVENUE_PROVIDERS) provider?: CrmRevenueProvider
  @ApiProperty({ required: false, enum: CRM_REVENUE_STATUSES, description: 'MANUAL rows only' })
  @IsOptional() @IsIn(CRM_REVENUE_STATUSES) status?: CrmRevenueStatus
  @ApiProperty({ required: false, description: 'MANUAL rows only - original currency, positive' }) @IsOptional() @IsNumber() amount?: number
  @ApiProperty({ required: false, description: 'MANUAL rows only - ISO 4217, never assumed' }) @IsOptional() @IsString() currency?: string
  @ApiProperty({ required: false, description: 'MANUAL rows only - USD per unit of currency. Required for a non-USD row; never defaults to 1.0.' })
  @IsOptional() @IsNumber() fx_rate?: number
  @ApiProperty({ required: false, description: 'MANUAL rows only - YYYY-MM-DD' }) @IsOptional() @IsString() issued_at?: string
  @ApiProperty({ required: false, description: "MANUAL rows only ('' clears)" }) @IsOptional() @IsString() due_at?: string
  @ApiProperty({ required: false, description: "MANUAL rows only ('' clears)" }) @IsOptional() @IsString() paid_at?: string
  @ApiProperty({ required: false, description: "MANUAL rows only ('' clears)" }) @IsOptional() @IsString() refunded_at?: string
  @ApiProperty({ required: false, description: "MANUAL rows only ('' clears)" }) @IsOptional() @IsString() payer_email?: string
  @ApiProperty({ required: false, description: 'MANUAL rows only, e.g. INV-1042' }) @IsOptional() @IsString() invoice_number?: string
  @ApiProperty({ required: false, description: 'MANUAL rows only' }) @IsOptional() @IsString() description?: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class CrmEventDeleteReportDto {
  @ApiProperty() id!: string
  @ApiProperty() deleted!: boolean
  @ApiProperty({ required: false, nullable: true }) account_id!: string | null
  @ApiProperty({ description: 'True when the source still holds it, so the next sync re-creates it' }) will_reimport!: boolean
  @ApiProperty({ type: [String] }) warnings!: string[]
}

class CrmAccountsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [CrmAccountDto] }) accounts!: CrmAccountDto[]
}

class UpsertCrmAccountDto {
  @ApiProperty({ description: 'Account slug (stable id), e.g. acme-leeds' }) @IsString() id!: string
  @ApiProperty({ required: false, description: 'Company name' }) @IsOptional() @IsString() name?: string
  @ApiProperty({
    required: false,
    enum: CRM_ACCOUNT_STATUSES,
    description:
      'The lifecycle: stale → meeting_requested → meeting_booked → demo → proposal → confirmed → customer → onboarding, with at_risk / churned / lost / archived as exits, and revisit as a dated siding for real deals whose clock is external. `confirmed` means won but NOT paid - terms agreed and invoice issued, cash not yet in; it is pipeline, never a paying status. `stale` is a parking bay before the ladder starts: a real deal gone cold, kept visible on the board but excluded from the forecast. prospect / engaged / trial are legacy v0.1 values, retiring. Box-owned, never machine-written.',
  })
  @IsOptional() @IsIn(CRM_ACCOUNT_STATUSES) status?: CrmAccountStatus
  @ApiProperty({ required: false, description: "users.id working this account ('' clears; unknown ids are refused)" })
  @IsOptional() @IsString() owner?: string
  @ApiProperty({ required: false, enum: CRM_ACCOUNT_SOURCES, description: 'How the account arrived' })
  @IsOptional() @IsIn(CRM_ACCOUNT_SOURCES) source?: CrmAccountSource
  @ApiProperty({ required: false, description: "Who referred them, e.g. 'Sam at Acme' ('' clears)" })
  @IsOptional() @IsString() referral_partner?: string
  @ApiProperty({
    required: false,
    description: 'Monthly value in USD - the OPERATOR ESTIMATE used to weigh the pipeline, NOT a finance number (Stripe owns money)',
  })
  @IsOptional() @IsNumber() mrr_usd?: number
  @ApiProperty({ required: false, description: 'Close probability 0-100' }) @IsOptional() @IsInt() close_probability?: number
  @ApiProperty({ required: false, enum: CRM_WAITING_ON, description: 'Who the next action waits on: me | them' })
  @IsOptional() @IsIn(CRM_WAITING_ON) waiting_on?: CrmWaitingOn
  @ApiProperty({ required: false, description: 'The next thing to do for this account' })
  @IsOptional() @IsString() next_action?: string
  @ApiProperty({ required: false, description: "When the next action is due, YYYY-MM-DD ('' clears)" })
  @IsOptional() @IsString() next_action_at?: string
  @ApiProperty({ required: false, description: "Last contact, YYYY-MM-DD ('' clears)" })
  @IsOptional() @IsString() last_contacted_at?: string
  @ApiProperty({ required: false, description: "Subscription start, YYYY-MM-DD ('' clears)" })
  @IsOptional() @IsString() subscription_start_at?: string
  @ApiProperty({ required: false, description: "Subscription end / churn date, YYYY-MM-DD ('' clears)" })
  @IsOptional() @IsString() subscription_end_at?: string
  @ApiProperty({ required: false, description: "Company website ('' clears)" }) @IsOptional() @IsString() website?: string
  @ApiProperty({
    required: false,
    description:
      "R1 - the Stripe customer id, `cus_...` ('' clears). Refused when another account already holds it: once Stripe owns mrr_usd, one customer id on two rows writes one subscription's revenue twice.",
  })
  @IsOptional() @IsString() stripe_customer_id?: string
  @ApiProperty({ required: false, description: "R1 - the platform space id ('' clears). Same one-account rule." })
  @IsOptional() @IsString() supabase_space_id?: string
  @ApiProperty({
    required: false,
    description:
      "R2 - the WhatsApp group JID, e.g. `120363000000000001@g.us` ('' clears). Set it by hand: one team's group list held six near-identical names across three accounts of one customer, so matching on name is not safe.",
  })
  @IsOptional() @IsString() whatsapp_group_jid?: string
  @ApiProperty({
    required: false,
    description:
      "A1 - paused since, YYYY-MM-DD ('' clears). A paused account is suppressed from BOTH MRR and churn, which is the point: counting a pause as churn overstates churn and understates retention, counting it as live overstates MRR.",
  })
  @IsOptional() @IsString() paused_since?: string
  @ApiProperty({ required: false, description: "A1 - when they are EXPECTED back, YYYY-MM-DD ('' clears). Needs a paused_since." })
  @IsOptional() @IsString() paused_until?: string
  @ApiProperty({
    required: false,
    description:
      "A2 - why a real deal died ('' clears). Set `status: lost` rather than `archived` when one does, or win rate stays unmeasurable.",
  })
  @IsOptional() @IsString() loss_reason?: string
  @ApiProperty({
    required: false,
    enum: CRM_RENEWAL_RISKS,
    description:
      'A5 - will this renew? `open` means nobody has looked and is deliberately NOT `low`. Changing this (or its note) stamps renewal_risk_reviewed_at with today unless you pass one.',
  })
  @IsOptional() @IsIn(CRM_RENEWAL_RISKS) renewal_risk?: CrmRenewalRisk
  @ApiProperty({ required: false, description: "A5 - why ('' clears). 'Mid-contract, budget resets in Jan' is the canonical shape." })
  @IsOptional() @IsString() renewal_risk_note?: string
  @ApiProperty({ required: false, description: "A5 - when the risk was reviewed, YYYY-MM-DD ('' clears). Defaults to today when the risk changes." })
  @IsOptional() @IsString() renewal_risk_reviewed_at?: string
  @ApiProperty({ required: false, type: [String], description: 'Free-form labels (lowercased + de-duplicated)' })
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[]
  @ApiProperty({ required: false }) @IsOptional() @IsString() notes?: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class UpsertCrmContactDto {
  @ApiProperty({ description: 'Contact id - an imported lead id verbatim, or a slug for a hand-created person' })
  @IsString() id!: string
  @ApiProperty({ required: false, description: 'crm_accounts.id this person belongs to (required on create; changing it re-parents them)' })
  @IsOptional() @IsString() account_id?: string
  @ApiProperty({ required: false }) @IsOptional() @IsString() name?: string
  @ApiProperty({ required: false, description: 'Job title / one-liner' }) @IsOptional() @IsString() headline?: string
  @ApiProperty({ required: false, description: "Email ('' clears)" }) @IsOptional() @IsString() email?: string
  @ApiProperty({ required: false, description: "Phone ('' clears)" }) @IsOptional() @IsString() phone?: string
  @ApiProperty({ required: false, description: "LinkedIn profile URL ('' clears)" })
  @IsOptional() @IsString() linkedin_url?: string
  @ApiProperty({
    required: false,
    enum: CRM_CONTACT_ROLES,
    description: 'What they do in the deal: decision_maker, buyer, user (an SDR / product user), other',
  })
  @IsOptional() @IsIn(CRM_CONTACT_ROLES) role?: CrmContactRole
  @ApiProperty({ required: false, description: 'Make this the account primary contact (demotes the previous one)' })
  @IsOptional() @IsBoolean() is_primary?: boolean
  @ApiProperty({ required: false, type: [String], description: 'Free-form labels (lowercased + de-duplicated)' })
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[]
  @ApiProperty({ required: false, description: 'Free-text notes - the escape hatch the sync never touches' })
  @IsOptional() @IsString() notes?: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class IdDto {
  @ApiProperty() @IsString() id!: string
  @ApiProperty({ required: false, description: 'users.id performing this mutation (audit stamp; defaults to the authenticated principal)' })
  @IsOptional() @IsString() actor?: string
}

class CrmAccountDeleteReportDto {
  @ApiProperty() id!: string
  @ApiProperty() name!: string
  @ApiProperty() deleted!: boolean
  @ApiProperty({ description: 'Contacts cascade-deleted with the account' }) contacts_deleted!: number
  @ApiProperty({ description: 'Activity rows (the conversation stream) cascade-deleted with it' })
  activities_deleted!: number
  @ApiProperty({ type: [String] }) reimporting_contacts!: string[]
  @ApiProperty() will_reimport!: boolean
  @ApiProperty({ type: [String] }) warnings!: string[]
}

class CrmContactDeleteReportDto {
  @ApiProperty() id!: string
  @ApiProperty() name!: string
  @ApiProperty() account_id!: string
  @ApiProperty() deleted!: boolean
  @ApiProperty() connected!: boolean
  @ApiProperty({ required: false, nullable: true }) data_source_id!: string | null
  @ApiProperty({ required: false, nullable: true }) external_stage!: string | null
  @ApiProperty({ description: 'True when the source still reports a scanned stage - they WILL come back' })
  will_reimport!: boolean
  @ApiProperty({ description: 'Activity rows deleted with this contact' }) activities_deleted!: number
  @ApiProperty({ required: false, nullable: true }) promoted_primary!: string | null
  @ApiProperty() account_left_empty!: boolean
  @ApiProperty({ type: [String] }) warnings!: string[]
}

class CrmDocDto {
  @ApiProperty() path!: string
  @ApiProperty() content!: string
  @ApiProperty() exists!: boolean
  @ApiProperty({ description: 'vscode://file/<abs> deep link' }) editorUri!: string
  @ApiProperty({ description: "The reserved block's prose, split out of the doc by core's parser" })
  nextAction!: string
  @ApiProperty({ description: 'Everything below the Notes heading' }) notes!: string
}

/**
 * The dashboard's save shape. The panel holds the two headings as static chrome OUTSIDE its editors
 * (the frontmatter trick ContentBodyEditor already uses), so it has no document to send - only the
 * two regions it owns. Core recomposes them over whatever is on disk, preserving everything else.
 */
class CrmDocRegionsDto {
  @ApiProperty({ description: 'Account slug, e.g. acme-leeds' }) @IsString() id!: string
  @ApiProperty({ description: 'The next-move block prose (markdown, may be empty)' })
  @IsString() nextAction!: string
  @ApiProperty({ description: 'The notes body (markdown, may be empty)' }) @IsString() notes!: string
  @ApiProperty({ required: false, description: 'users.id making the edit (defaults to the principal)' })
  @IsOptional() @IsString() actor?: string
}
class CrmDocRefDto {
  @ApiProperty({ description: 'Account slug, e.g. acme-leeds' }) @IsString() id!: string
}
class CrmDocSaveDto {
  @ApiProperty({ description: 'Account slug, e.g. acme-leeds' }) @IsString() id!: string
  @ApiProperty({
    description:
      'Full markdown body. The reserved block above the `<!-- next action above / notes below -->` sentinel is the next move; everything below it is notes. Both are re-derived into the row on write.',
  })
  @IsString() content!: string
  @ApiProperty({ required: false, description: 'users.id making the edit (defaults to the principal)' })
  @IsOptional() @IsString() actor?: string
}

/**
 * CRM surface - accounts (companies, the pipeline unit) and their contacts (the humans at them).
 * There is no Deal object: the account IS the deal and `status` carries the lifecycle, so
 * Lead / Customer / Churned are three values of one column.
 *
 * SECURITY: this is the most sensitive data a Box holds. The class-level `@UseGuards(AuthGuard)`
 * is deny-by-default and holds on REST, tRPC and MCP alike, so nothing here is publicly reachable;
 * the writes that reshape the pipeline carry `@Admin()` on top of it. Agents reading `crm-accounts`
 * get real names - they must never land in a public-facing draft (the content pipeline's
 * no-external-names rule is the guard).
 *
 * Column ownership is enforced one layer down, in @silkweave/box-core's crm/state.ts: these input DTOs simply
 * cannot express a provider-owned column, so no tool call can fight a sync over one.
 */
@Controller('crm')
@UseGuards(AuthGuard)
export class CrmController {
  /**
   * tRPC query `crmAccounts` / MCP `crm-accounts` - every account with its contacts nested. No
   * filtering server-side: the set is hundreds of rows, and one payload behind one live store beats
   * a query language nobody asked for.
   */
  @Get()
  @ApiOkResponse({ type: CrmAccountsDto })
  @Trpc()
  @Mcp({ name: 'crm-accounts' })
  async accounts(): Promise<CrmAccountsDto> {
    const accounts = (await readCrmAccounts()) as CrmAccountWithContacts[] as CrmAccountDto[]
    return { generatedAt: new Date().toISOString(), accounts }
  }

  /**
   * tRPC mutation `crmAccountUpsert` / MCP `crm-account-upsert` - create or partially update a
   * company. Every column here is Box-owned; `mrr_usd` is the operator's working estimate for
   * weighing the pipeline and is explicitly not a finance number.
   */
  @Post('account')
  @ApiOkResponse({ type: CrmAccountDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-account-upsert' })
  async accountUpsert(@Body() body: UpsertCrmAccountDto, @Req() req: PrincipalRequest): Promise<CrmAccountDto> {
    body.actor ??= req.principal?.id
    try {
      return (await upsertCrmAccount(body)) as CrmAccountWithContacts as CrmAccountDto
    } catch (e) {
      // The domain refuses unknown owners, out-of-enum statuses, bad dates and out-of-range
      // probabilities with a message that says which - a 500 would strip exactly the part the
      // caller needs to act on.
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `crmAccountDelete` / MCP `crm-account-delete` - remove a company AND cascade to
   * its contacts, then REPORT what that means (how many people went, and which of them will simply
   * re-import into a brand-new account on the next sync). Archive is the honest "remove".
   */
  @Post('account/delete')
  @ApiOkResponse({ type: CrmAccountDeleteReportDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-account-delete' })
  async accountDelete(@Body() body: IdDto): Promise<CrmAccountDeleteReportDto> {
    try {
      return (await deleteCrmAccount(body.id)) as CrmAccountDeleteReport as CrmAccountDeleteReportDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `crmContactUpsert` / MCP `crm-contact-upsert` - create or partially update a
   * person at an account. `account_id` is required on create and re-parents on update; the first
   * contact of an account becomes its primary automatically.
   */
  @Post('contact')
  @ApiOkResponse({ type: CrmContactDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-contact-upsert' })
  async contactUpsert(@Body() body: UpsertCrmContactDto, @Req() req: PrincipalRequest): Promise<CrmContactDto> {
    body.actor ??= req.principal?.id
    try {
      return (await upsertCrmContact(body)) as CrmContact as CrmContactDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `crmContactDelete` / MCP `crm-contact-delete` - remove a person and report what
   * that means: whether the source will simply send them back, who was promoted to primary in their
   * place, and whether the account is now left with nobody to call.
   */
  @Post('contact/delete')
  @ApiOkResponse({ type: CrmContactDeleteReportDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-contact-delete' })
  async contactDelete(@Body() body: IdDto): Promise<CrmContactDeleteReportDto> {
    try {
      return (await deleteCrmContact(body.id)) as CrmContactDeleteReport as CrmContactDeleteReportDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `crmActivities` / MCP `crm-activities` - every message with an account, across
   * ALL of its contacts, oldest first. The account detail page's conversation stream.
   *
   * Per-account and NOT nested into `crm-accounts` for the same reason meetings are not: that
   * payload is already ~294KB, and a conversation is unbounded where an account's field set is not.
   * A mutation-shaped read because it carries a body (the crm-doc-read precedent).
   */
  @Post('activities/list')
  @ApiOkResponse({ type: CrmActivitiesDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-activities' })
  async activities(@Body() body: CrmActivitiesListDto): Promise<CrmActivitiesDto> {
    const activities = await readCrmActivities(body.account_id, body.limit ?? 500)
    return {
      generatedAt: new Date().toISOString(),
      activities: activities as CrmActivity[] as CrmActivityDto[],
    }
  }

  /**
   * tRPC mutation `crmActivityLog` / MCP `crm-activity-log` - the HUMAN write path.
   *
   * A call someone had, an email that never touched a tracked inbox, a letter. Keyed `manual:<uuid>` in
   * its own id namespace, so it can never collide with a synced row and a sync can never overwrite
   * it. Editing a SYNCED row is refused rather than silently accepted: the next sync would undo it.
   */
  @Post('activity')
  @ApiOkResponse({ type: CrmActivityDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-activity-log' })
  async activityLog(@Body() body: LogCrmActivityDto, @Req() req: PrincipalRequest): Promise<CrmActivityDto> {
    try {
      const row = await logCrmActivity({ ...body, actor: body.actor ?? req.principal?.id })
      return row as CrmActivity as CrmActivityDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `crmActivityDelete` / MCP `crm-activity-delete` - hand-logged rows only.
   *
   * A synced message would be re-created by the next backfill, so "deleting" one is not a delete -
   * it is a row that reappears and a person who concludes the CRM is broken.
   */
  @Post('activity/delete')
  @ApiOkResponse({ type: CrmActivityDeleteReportDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-activity-delete' })
  async activityDelete(@Body() body: DeleteCrmActivityDto): Promise<CrmActivityDeleteReportDto> {
    try {
      return await deleteCrmActivity(body.id)
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  // --- phase 3: meetings ------------------------------------------------------------------------

  /**
   * tRPC mutation `crmMeetings` / MCP `crm-meetings` - a filtered list of meetings, newest first.
   *
   * Deliberately NOT nested into `crm-accounts`: that payload is already ~294KB and every consumer
   * that does not need meetings would pay for them. Filtering is SQL, not client-side, for the same
   * reason. A mutation-shaped read (the crm-doc-read precedent) because it carries a body.
   */
  @Post('meetings/list')
  @ApiOkResponse({ type: CrmMeetingsDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-meetings' })
  async meetings(@Body() body: CrmMeetingsListDto): Promise<CrmMeetingsDto> {
    const meetings = await readCrmMeetings({
      ...(body.account_id ? { account_id: body.account_id } : {}),
      ...(body.since ? { since: body.since } : {}),
      ...(body.until ? { until: body.until } : {}),
      ...(body.unassigned ? { unassigned: true } : {}),
    })
    return { generatedAt: new Date().toISOString(), meetings: meetings as CrmMeeting[] as CrmMeetingDto[] }
  }

  /**
   * tRPC mutation `crmMeetingUpsert` / MCP `crm-meeting-upsert` - the HUMAN write path.
   *
   * On a calendar/transcript row this cannot express a provider-owned column at all, so a tool call
   * can never fight the sync over when a meeting is; on a `manual` row everything is writable, which
   * is how a phone call that never had a calendar entry gets recorded.
   */
  @Post('meeting')
  @ApiOkResponse({ type: CrmMeetingDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-meeting-upsert' })
  async meetingUpsert(@Body() body: UpsertCrmMeetingDto, @Req() req: PrincipalRequest): Promise<CrmMeetingDto> {
    try {
      const row = await upsertCrmMeeting({ ...body, actor: body.actor ?? req.principal?.id })
      return row as CrmMeeting as CrmMeetingDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /** tRPC mutation `crmMeetingDelete` / MCP `crm-meeting-delete`. Machines mark `cancelled`, never delete. */
  @Post('meeting/delete')
  @ApiOkResponse({ type: CrmEventDeleteReportDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-meeting-delete' })
  async meetingDelete(@Body() body: IdDto): Promise<CrmEventDeleteReportDto> {
    try {
      return (await deleteCrmMeeting(body.id)) as CrmEventDeleteReport as CrmEventDeleteReportDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  // --- phase 3: revenue events ------------------------------------------------------------------

  /**
   * tRPC mutation `crmRevenueEvents` / MCP `crm-revenue-events` - a filtered list of money events.
   *
   * Superseded rows (the same invoice re-created under a new provider at cutover) are hidden here,
   * ONCE, rather than deduplicated by every consumer - that is what stops two reports disagreeing.
   */
  @Post('revenue-events/list')
  @ApiOkResponse({ type: CrmRevenueEventsDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-revenue-events' })
  async revenueEvents(@Body() body: CrmRevenueEventsListDto): Promise<CrmRevenueEventsDto> {
    const events = await readCrmRevenueEvents({
      ...(body.account_id ? { account_id: body.account_id } : {}),
      ...(body.since ? { since: body.since } : {}),
      ...(body.status ? { status: body.status } : {}),
      ...(body.kind ? { kind: body.kind } : {}),
      ...(body.unassigned ? { unassigned: true } : {}),
      ...(body.include_superseded ? { include_superseded: true } : {}),
    })
    return { generatedAt: new Date().toISOString(), events: events as CrmRevenueEvent[] as CrmRevenueEventDto[] }
  }

  /**
   * tRPC mutation `crmRevenueEventUpsert` / MCP `crm-revenue-event-upsert` - the HUMAN write path.
   *
   * Two fields here are the whole reason the tool exists: `kind` (one_off is never inferred) and the
   * coverage window (`covers_from`/`covers_to`), which is how a 12-month prepay with no subscription
   * object stops reading as a one-month payment.
   */
  @Post('revenue-event')
  @ApiOkResponse({ type: CrmRevenueEventDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-revenue-event-upsert' })
  async revenueEventUpsert(
    @Body() body: UpsertCrmRevenueEventDto,
    @Req() req: PrincipalRequest,
  ): Promise<CrmRevenueEventDto> {
    try {
      const row = await upsertCrmRevenueEvent({ ...body, actor: body.actor ?? req.principal?.id })
      return row as CrmRevenueEvent as CrmRevenueEventDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `crmAssignQueue` / MCP `crm-assign-queue` - everything a sync could not decide.
   *
   * Both tables in ONE call, because it is one human sitting down to clear one list; two round trips
   * would only invite a surface that shows half of it. Nothing here is an error: an unmatched row is
   * WRITTEN rather than dropped precisely so it can be answered, and a past meeting stays
   * `scheduled` because no machine may assert `no_show`.
   */
  @Post('queue')
  @ApiOkResponse({ type: CrmAssignQueueDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-assign-queue' })
  async assignQueue(): Promise<CrmAssignQueueDto> {
    const [meetings, events] = await Promise.all([readCrmMeetingQueue(), readCrmRevenueQueue()])
    return {
      generatedAt: new Date().toISOString(),
      meetings: meetings as CrmMeeting[] as CrmMeetingDto[],
      events: events as CrmRevenueEvent[] as CrmRevenueEventDto[],
    }
  }

  /** tRPC mutation `crmRevenueEventDelete` / MCP `crm-revenue-event-delete`. Machines mark `voided`. */
  @Post('revenue-event/delete')
  @ApiOkResponse({ type: CrmEventDeleteReportDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-revenue-event-delete' })
  async revenueEventDelete(@Body() body: IdDto): Promise<CrmEventDeleteReportDto> {
    try {
      return (await deleteCrmRevenueEvent(body.id)) as CrmEventDeleteReport as CrmEventDeleteReportDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `crmDoc` / MCP `crm-doc-read` - read an account's markdown doc from disk (empty
   * if none yet). A mutation for the same reason the planning one is: the queries here are
   * input-less, and an input-carrying read is fine as an RPC call.
   */
  @Post('account/doc/read')
  @ApiOkResponse({ type: CrmDocDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-doc-read' })
  async doc(@Body() body: CrmDocRefDto): Promise<CrmDocDto> {
    try {
      const doc = readCrmDoc(body.id) as CrmDoc
      // Split here rather than in the browser: apps/web deliberately does not depend on @silkweave/box-core,
      // and hand-mirroring the parse rules into the SPA is exactly the drift this design avoids.
      // RAW regions, not parseCrmDoc's flattened cache value - these seed live editors, and the
      // flattened form would strip a block's inline markdown the moment the user next typed.
      return { ...doc, ...readCrmDocRegions(doc.content) } as CrmDocDto
    } catch (e) {
      // A non-slug id is a caller error, not a 500 - crmDocPath refuses it by design.
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `crmDocSave` / MCP `crm-doc-save` - write an account doc to disk (autosave
   * target).
   *
   * It also refreshes the row's `next_action` and `notes`, which are derived caches of this doc
   * rather than fields of their own - the same move migration 013 made for planning `summary`.
   * They survive as columns because they are queryable: the kanban card renders the next action
   * and reddens it when overdue, the table sorts on it, and notes are in the search corpus. That
   * is why the write goes through core rather than straight to the filesystem.
   */
  @Post('account/doc')
  @ApiOkResponse({ type: CrmDocDto })
  @Trpc({ kind: 'mutation' })
  @Mcp({ name: 'crm-doc-save' })
  async docSave(@Body() body: CrmDocSaveDto, @Req() req: PrincipalRequest): Promise<CrmDocDto> {
    try {
      return (await saveCrmDoc(body.id, body.content, body.actor ?? req.principal?.id)) as CrmDoc as CrmDocDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * tRPC mutation `crmDocRegionsSave` - the DASHBOARD's autosave target, and deliberately NOT an MCP
   * tool. The panel renders the two headings as static chrome outside its editors so they cannot be
   * deleted, which means it owns two regions rather than a document; core recomposes them over the
   * file on disk. An agent, by contrast, wants the whole markdown, and keeps `crm-doc-save`.
   */
  @Post('account/doc/regions')
  @ApiOkResponse({ type: CrmDocDto })
  @Trpc({ kind: 'mutation' })
  async docRegionsSave(@Body() body: CrmDocRegionsDto, @Req() req: PrincipalRequest): Promise<CrmDocDto> {
    try {
      const doc = (await saveCrmDocRegions(
        body.id,
        { nextAction: body.nextAction, notes: body.notes },
        body.actor ?? req.principal?.id,
      )) as CrmDoc
      return { ...doc, ...readCrmDocRegions(doc.content) } as CrmDocDto
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : String(e))
    }
  }
}
