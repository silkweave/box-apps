import * as React from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { ExternalLink, Plus, Star, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge, Button, CollapsibleSection, confirm, DateInput, InlineEdit, PageContainer, SplitPane, formatCurrency, inlineSelectCls, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, UserChip, UserPicker } from '@silkweave/box-ui'
import { TagPicker } from '@/lib/tags.tsx'
import { CrmLinkEdit } from '../components/CrmLinkEdit.tsx'
import { CrmAccountDoc } from '../components/CrmAccountDocLazy.tsx'
import { CrmRoleSelect, CrmStatusSelect, StatusLabel } from '../components/crmStatus.tsx'
import { relativeTime } from '../../../lib/format.ts'
import { usePersistedState } from '../../../lib/usePersistedState.ts'
import {
  deleteCrmAccount,
  deleteCrmContact,
  upsertCrmAccount,
  upsertCrmContact,
  useCrmData,
} from '../lib/useCrmData.ts'
import {
  deleteCrmMeeting,
  deleteCrmRevenueEvent,
  upsertCrmMeeting,
  upsertCrmRevenueEvent,
  deleteCrmActivity,
  logCrmActivity,
  useCrmActivities,
  useCrmMeetings,
  useCrmRevenueEvents,
} from '../lib/useCrmEvents.ts'
import { useDataSources } from '../../data/lib/useSourcesData.ts'
import {
  CRM_ACTIVITY_CHANNELS,
  CRM_ACTIVITY_CHANNEL_LABEL,
  CRM_ACCOUNT_SOURCES,
  CRM_ACCOUNT_SOURCE_LABEL,
  CRM_WAITING_ON,
  CRM_WAITING_ON_LABEL,
  isConnected,
  weightedMrr,
  type CrmAccountSource,
  type CrmActivity,
  type CrmActivityChannel,
  type CrmActivityDirection,
  type CrmContact,
  type CrmWaitingOn,
  CRM_MEETING_KINDS,
  CRM_MEETING_KIND_LABEL,
  CRM_MEETING_OUTCOME_LABEL,
  CRM_MATCH_CONFIDENCE,
  CRM_RENEWAL_RISKS,
  CRM_RENEWAL_RISK_LABEL,
  CRM_REVENUE_KIND_LABEL,
  CRM_REVENUE_STATUS_LABEL,
  needsCoverage,
  type CrmMeeting,
  type CrmMeetingKind,
  type CrmMeetingOutcome,
  type CrmRenewalRisk,
  type CrmRevenueEvent,
} from '../crm-types.ts'
import { appKey } from '@/lib/storage.ts'

/**
 * How the due date reads at a glance. A MISSING date is deliberately a warning rather than a blank:
 * an undated row never appears in an overdue report, so it hides better than a late one does.
 */
function dueBadge(due: string | null): { text: string; variant: 'danger' | 'warning' | 'neutral' } {
  if (!due) return { text: 'No due date', variant: 'warning' }
  const today = new Date().toISOString().slice(0, 10)
  if (due < today) return { text: `Overdue - ${due}`, variant: 'danger' }
  if (due === today) return { text: 'Due today', variant: 'warning' }
  return { text: `Due ${due}`, variant: 'neutral' }
}

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

/**
 * One account: the company, where it sits in the pipeline, and the people at it.
 *
 * The account carries the whole lifecycle (there is no Deal object), so this page is the working
 * surface for a deal: status, owner, the value estimate, the next action and its date. Contacts sit
 * below in their own panel - an account with none is a visible, nagging state rather than a silent
 * one, because the server deliberately does not refuse it (the import has to create the company
 * before it can create anyone at it).
 */
export function CrmAccountDetailView() {
  const { id } = useParams({ strict: false }) as { id?: string }
  const navigate = useNavigate()
  const { data } = useCrmData()
  const { data: sources } = useDataSources()
  const [addingContact, setAddingContact] = React.useState(false)
  // Global, per-browser: which cards this operator keeps folded shut. See `CardCollapse`.
  const [collapsedCards, setCollapsedCards] = usePersistedState<string[]>(
    appKey('crm', 'collapsedCards'),
    [],
    (val) => Array.isArray(val) && val.every((x) => typeof x === 'string'),
  )
  const collapse = React.useMemo(
    () => ({
      isCollapsed: (cardId: string) => collapsedCards.includes(cardId),
      toggle: (cardId: string) =>
        setCollapsedCards((prev) => (prev.includes(cardId) ? prev.filter((x) => x !== cardId) : [...prev, cardId])),
    }),
    [collapsedCards, setCollapsedCards],
  )

  if (!data || !id) return null
  const account = data.find((a) => a.id === id)
  if (!account)
    return (
      <div className='mx-auto max-w-3xl px-4 py-16 text-center text-body-sm text-muted-foreground'>
        Account not found.
      </div>
    )

  const tagSuggestions = [...new Set(data.flatMap((a) => a.tags))].sort()
  const weighted = weightedMrr(account)
  const due = dueBadge(account.next_action_at)
  const migratedFrom = typeof account.external.migrated_from === 'string' ? account.external.migrated_from : null
  // Provenance has three cases, not two: hand-created, migrated from Lark, and SYNCED by a provider.
  // Calling a synced account "hand-created" sends whoever reads the footer looking for a person.
  const syncedFrom = account.data_source_id ?? null

  const onDelete = (): void => {
    void confirm({
      title: `Delete ${account.name}?`,
      message:
        account.contacts.length > 0
          ? `This also deletes its ${account.contacts.length} contact(s), and the status, owner, MRR, next action and notes are gone for good. Any contact still active at its source will re-import into a brand-new account. Set the status to "archived" instead to keep the record and park it.`
          : 'This removes the account for good. Set the status to "archived" instead to keep the record and park it.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      void deleteCrmAccount(account.id).then((report) => {
        if (report.warnings.length > 0) window.alert(report.warnings.join('\n\n'))
        void navigate({ to: '/crm' })
      })
    })
  }

  const left = (
    <PageContainer width='reading' key={account.id}>
      <header className='mb-4'>
        <div className='flex flex-wrap items-center gap-2'>
          <Badge variant={account.source === 'unknown' ? 'neutral' : 'info'}>
            {CRM_ACCOUNT_SOURCE_LABEL[account.source]}
          </Badge>
          {account.referral_partner && <Badge variant='accent'>via {account.referral_partner}</Badge>}
          <code className='text-label text-muted-foreground'>{account.id}</code>
        </div>
        <div className='mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1'>
          <h1 className='font-serif text-display-md leading-tight text-text'>{account.name}</h1>
          <span className='text-body-sm'>
            <StatusLabel status={account.status} />
          </span>
        </div>
        {account.website && (
          <a
            href={account.website}
            target='_blank'
            rel='noreferrer noopener'
            className='mt-1 inline-flex items-center gap-1.5 text-body-sm text-accent hover:underline'>
            <ExternalLink className='size-3.5' /> {account.website.replace(/^https?:\/\//, '')}
          </a>
        )}
      </header>

      {/* At a glance. Answers "what is it worth, is it late, whose move is it" without reading a form. */}
      <section className='mb-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface px-4 py-3 shadow-(--shadow-sm) sm:grid-cols-5'>
        <div className='flex min-w-0 flex-col gap-1'>
          <span className='text-label text-muted-foreground'>MRR</span>
          <span className='font-serif text-display-sm leading-none tabular-nums text-text'>
            {formatCurrency(account.mrr_usd)}
          </span>
        </div>
        <Stat label='Probability'>
          {account.close_probability != null ? (
            <span className='tabular-nums'>
              {account.close_probability}%
              {weighted != null && account.close_probability < 100 && (
                <span className='text-muted-foreground'> · {formatCurrency(weighted)} wtd</span>
              )}
            </span>
          ) : (
            <span className='text-muted-foreground'>not set</span>
          )}
        </Stat>
        <Stat label='Whose move'>
          <Badge variant={account.waiting_on === 'me' ? 'accent' : 'neutral'}>
            {CRM_WAITING_ON_LABEL[account.waiting_on]}
          </Badge>
        </Stat>
        <Stat label='Next action'>
          <Badge variant={due.variant}>{due.text}</Badge>
        </Stat>
        <Stat label='Last contacted'>
          {account.last_contacted_at ? (
            relativeTime(account.last_contacted_at)
          ) : (
            <span className='text-warning'>never recorded</span>
          )}
        </Stat>
      </section>

      {/*
        THE WORK, minus the prose. The next move itself is the locked block at the top of the doc in
        the right-hand pane, so what stays here is only what the doc does NOT hold: the dates and
        whose turn it is. Mirroring the prose back into this panel was a duplicate of something
        already on screen, one pane away.
      */}
      <Panel id='next-move' title='The next move' className='border-l-2 border-l-accent'>
        <Field label='Due' className='sm:col-span-2'>
          <DateInput
            value={account.next_action_at ?? ''}
            onChange={(v) => void upsertCrmAccount({ id: account.id, next_action_at: v })}
            ariaLabel='Next action due date'
          />
        </Field>
        <Field label='Waiting on' className='sm:col-span-2'>
          <Select
            value={account.waiting_on}
            onValueChange={(next) => void upsertCrmAccount({ id: account.id, waiting_on: next as CrmWaitingOn })}
            items={CRM_WAITING_ON.map((w) => ({ value: w, label: CRM_WAITING_ON_LABEL[w] }))}>
            <SelectTrigger aria-label='Waiting on' className={inlineSelectCls}>
              <SelectValue>{(v) => <span>{CRM_WAITING_ON_LABEL[v as CrmWaitingOn]}</span>}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CRM_WAITING_ON.map((w) => (
                <SelectItem key={w} value={w}>
                  {CRM_WAITING_ON_LABEL[w]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label='Last contacted' className='sm:col-span-2'>
          <DateInput
            value={account.last_contacted_at ?? ''}
            onChange={(v) => void upsertCrmAccount({ id: account.id, last_contacted_at: v })}
            ariaLabel='Last contacted'
          />
        </Field>
        <Field label='Owner' className='sm:col-span-2'>
          <UserPicker value={account.owner} onChange={(o) => void upsertCrmAccount({ id: account.id, owner: o ?? '' })} />
        </Field>
      </Panel>

      {/*
        THE DEAL: where it sits and what it is worth. MRR is typed by hand here - a deal SHAPE
        (product, plan, quantity, price) that derives it is a per-team recipe, not the foundation
        (features/crm/AGENT.md, "Adding a deal shape"). When a team adds one, MRR becomes read-only
        exactly when something derives it: an editable box would accept a value the server discards.
      */}
      <Panel id='deal' title='Deal'>
        <Field label='Status' className='sm:col-span-2'>
          <CrmStatusSelect
            value={account.status}
            onChange={(status) => void upsertCrmAccount({ id: account.id, status })}
            className={inlineSelectCls}
          />
        </Field>
        <Field label='Close probability (%)' className='sm:col-span-2'>
          <InlineEdit
            type='number'
            min={0}
            max={100}
            defaultValue={account.close_probability ?? ''}
            aria-label='Close probability'
            placeholder='0-100'
            onCommit={(v) =>
              Number(v || 0) !== (account.close_probability ?? 0) &&
              void upsertCrmAccount({ id: account.id, close_probability: Number(v || 0) })
            }
          />
        </Field>
        <Field label='Subscription start' className='sm:col-span-2'>
          <DateInput
            value={account.subscription_start_at ?? ''}
            onChange={(v) => void upsertCrmAccount({ id: account.id, subscription_start_at: v })}
            ariaLabel='Subscription start'
          />
        </Field>
        <Field label='Subscription end / churn' className='sm:col-span-2'>
          <DateInput
            value={account.subscription_end_at ?? ''}
            onChange={(v) => void upsertCrmAccount({ id: account.id, subscription_end_at: v })}
            ariaLabel='Subscription end or churn date'
          />
        </Field>
        <Field label='MRR (USD)' className='sm:col-span-2'>
          <InlineEdit
            type='number'
            min={0}
            defaultValue={account.mrr_usd ?? ''}
            aria-label='MRR in USD'
            placeholder='0'
            onCommit={(v) =>
              Number(v || 0) !== (account.mrr_usd ?? 0) &&
              void upsertCrmAccount({ id: account.id, mrr_usd: Number(v || 0) })
            }
          />
        </Field>
        <p className='text-label leading-relaxed text-muted-foreground sm:col-span-4'>
          MRR is the operator&apos;s working estimate for weighing the pipeline, <strong>not a finance number</strong> -
          Stripe owns money.
        </p>
      </Panel>

      {/* THE RECORD: set once, rarely touched. Last because it competes with the work if it is first. */}
      {/*
        A1 + A2 + A5. Each of these is a judgement a human is already making that lived in a build
        script with no author and no date: `paused` is the only thing separating a suppressed seat
        from real churn, `loss_reason` is why win rate is currently unmeasurable, and the renewal
        risk on one account is the only reason an $11,480 invoice is excluded from the cash calendar.
      */}
      <Panel id='retention' title='Retention'>
        <Field label='Renewal risk' className='sm:col-span-2'>
          <Select
            value={account.renewal_risk}
            onValueChange={(next) => void upsertCrmAccount({ id: account.id, renewal_risk: next as CrmRenewalRisk })}
            items={CRM_RENEWAL_RISKS.map((r) => ({ value: r, label: CRM_RENEWAL_RISK_LABEL[r] }))}>
            <SelectTrigger aria-label='Renewal risk' className={inlineSelectCls}>
              <SelectValue>{(v) => <span>{CRM_RENEWAL_RISK_LABEL[v as CrmRenewalRisk]}</span>}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CRM_RENEWAL_RISKS.map((r) => (
                <SelectItem key={r} value={r}>
                  {CRM_RENEWAL_RISK_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label='Why' className='sm:col-span-2'>
          <InlineEdit
            defaultValue={account.renewal_risk_note ?? ''}
            aria-label='Renewal risk note'
            placeholder='e.g. mid-contract, budget resets in Jan'
            onCommit={(v) =>
              v !== (account.renewal_risk_note ?? '') && void upsertCrmAccount({ id: account.id, renewal_risk_note: v })
            }
          />
        </Field>
        <Field label='Paused since' className='sm:col-span-2'>
          <DateInput
            value={account.paused_since ?? ''}
            ariaLabel='Paused since'
            onChange={(v) => void upsertCrmAccount({ id: account.id, paused_since: v })}
          />
        </Field>
        <Field label='Expected back' className='sm:col-span-2'>
          <DateInput
            value={account.paused_until ?? ''}
            ariaLabel='Expected back'
            disabled={!account.paused_since}
            onChange={(v) => void upsertCrmAccount({ id: account.id, paused_until: v })}
          />
        </Field>
        <Field label='Loss reason' className='sm:col-span-4'>
          <InlineEdit
            defaultValue={account.loss_reason ?? ''}
            aria-label='Loss reason'
            placeholder='Why the deal died - set status to "lost", not "archived"'
            onCommit={(v) =>
              v !== (account.loss_reason ?? '') && void upsertCrmAccount({ id: account.id, loss_reason: v })
            }
          />
        </Field>
        <p className='text-label leading-relaxed text-muted-foreground sm:col-span-4'>
          {account.paused_since ? (
            <>
              <strong>Paused</strong> since {fmtDay(account.paused_since)}
              {account.paused_until ? `, expected back ${fmtDay(account.paused_until)}` : ' with no expected return date'}
              . While paused this account is suppressed from BOTH MRR and churn.{' '}
            </>
          ) : null}
          {account.renewal_risk_reviewed_at ? (
            <>Risk last reviewed {fmtDay(account.renewal_risk_reviewed_at)}. </>
          ) : (
            <>Nobody has reviewed this renewal yet - &ldquo;Not reviewed&rdquo; is not the same as low risk. </>
          )}
        </p>
      </Panel>

      <Panel id='record' title='Record'>
        <Field label='Company name' className='sm:col-span-2'>
          <InlineEdit
            defaultValue={account.name}
            aria-label='Company name'
            onCommit={(v) => v !== account.name && void upsertCrmAccount({ id: account.id, name: v })}
          />
        </Field>
        <Field label='Website' className='sm:col-span-2'>
          <InlineEdit
            defaultValue={account.website ?? ''}
            aria-label='Website'
            placeholder='https://…'
            onCommit={(v) => v !== (account.website ?? '') && void upsertCrmAccount({ id: account.id, website: v })}
          />
        </Field>
        <Field label='Source' className='sm:col-span-2'>
          <Select
            value={account.source}
            onValueChange={(next) => void upsertCrmAccount({ id: account.id, source: next as CrmAccountSource })}
            items={CRM_ACCOUNT_SOURCES.map((src) => ({ value: src, label: CRM_ACCOUNT_SOURCE_LABEL[src] }))}>
            <SelectTrigger aria-label='Source' className={inlineSelectCls}>
              <SelectValue>{(v) => <span>{CRM_ACCOUNT_SOURCE_LABEL[v as CrmAccountSource]}</span>}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CRM_ACCOUNT_SOURCES.map((src) => (
                <SelectItem key={src} value={src}>
                  {CRM_ACCOUNT_SOURCE_LABEL[src]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label='Referral partner' className='sm:col-span-2'>
          <InlineEdit
            defaultValue={account.referral_partner ?? ''}
            aria-label='Referral partner'
            placeholder='e.g. Sam at Acme'
            onCommit={(v) =>
              v !== (account.referral_partner ?? '') && void upsertCrmAccount({ id: account.id, referral_partner: v })
            }
          />
        </Field>
        {/*
          The three EXTERNAL LINKS (R1/R2). They lived in the `external` JSON bag until 2026-09-03,
          which meant no API path could write them and they sat frozen at whatever the June Lark
          migration imported. Editable here because only a person can decide which row in another
          system IS this account - the WhatsApp group list alone held six near-identical names
          across three accounts of one customer, so no matcher should ever guess it.
          A value already held by another account is REFUSED by the server (one id on two rows
          double-counts), and that refusal has to be visible or the box just appears to revert.
        */}
        <Field label='Stripe customer' className='sm:col-span-2'>
          <CrmLinkEdit
            accountId={account.id}
            field='stripe_customer_id'
            value={account.stripe_customer_id}
            ariaLabel='Stripe customer id'
            placeholder='cus_…'
          />
        </Field>
        <Field label='Platform space' className='sm:col-span-2'>
          <CrmLinkEdit
            accountId={account.id}
            field='supabase_space_id'
            value={account.supabase_space_id}
            ariaLabel='Platform space id'
          />
        </Field>
        <Field label='WhatsApp group' className='sm:col-span-4'>
          <CrmLinkEdit
            accountId={account.id}
            field='whatsapp_group_jid'
            value={account.whatsapp_group_jid}
            ariaLabel='WhatsApp group JID'
            placeholder='120363…@g.us'
          />
        </Field>
        <Field label='Tags' className='sm:col-span-4'>
          <TagPicker
            value={account.tags}
            suggestions={tagSuggestions}
            onChange={(tags) =>
              tags.join(',') !== account.tags.join(',') && void upsertCrmAccount({ id: account.id, tags })
            }
          />
        </Field>
      </Panel>

      {/* Contacts - the people at this company. An account with none is flagged, not refused. */}
      <Card
        id='contacts'
        title='Contacts'
        count={account.contacts.length}
        actions={
          <Button size='sm' variant='outline' onClick={() => setAddingContact(true)}>
            <Plus /> Add contact
          </Button>
        }>
        {account.contacts.length === 0 ? (
          <div className='grid place-items-center rounded-md border border-dashed border-warning/50 bg-warning-bg/40 py-8 text-center text-body-sm text-muted-foreground'>
            <p>
              No contacts yet.
              <br />
              An account needs at least one person to talk to.
            </p>
          </div>
        ) : (
          <ul className='flex flex-col gap-2'>
            {account.contacts.map((c) => (
              <ContactRow key={c.id} contact={c} sourceLabel={sourceLabelOf(c, sources)} />
            ))}
          </ul>
        )}
        {addingContact && (
          <AddContactRow
            accountId={account.id}
            existingIds={account.contacts.map((c) => c.id)}
            makePrimary={account.contacts.length === 0}
            onDone={() => setAddingContact(false)}
          />
        )}
      </Card>

      <ConversationPanel accountId={account.id} contacts={account.contacts} />
      <MeetingsPanel accountId={account.id} contacts={account.contacts} />
      <MoneyPanel accountId={account.id} />

      {/* Provenance, and the destructive action - deliberately last, not in the header's prime slot. */}
      <div className='flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3'>
        <p className='text-label leading-relaxed text-muted-foreground'>
          {migratedFrom
            ? `Migrated from Lark (${migratedFrom})`
            : syncedFrom
              ? `Synced from ${syncedFrom}`
              : 'Hand-created'}
          {account.created_by && (
            <>
              {syncedFrom ? ' · stamped ' : ' by '}
              <span className='inline-flex translate-y-0.5 items-center'>
                <UserChip userId={account.created_by} showName />
              </span>
            </>
          )}
          {' · first seen '}
          {account.first_seen_at.slice(0, 10)}
          {' · updated '}
          {relativeTime(account.updated_at)}
        </p>
        <Button
          variant='ghost'
          size='sm'
          onClick={onDelete}
          className='shrink-0 text-muted-foreground hover:text-danger'>
          <Trash2 /> Delete account
        </Button>
      </div>

      {/*
        The conversation lives in <ConversationPanel/> above, per ACCOUNT rather than per contact -
        the sales side wants the conversation with a company, not with a row in a table.

        This slot used to say the warehouse holds "the index, never the correspondence" and that
        message bodies are fetched on open and stored NOWHERE. That was reversed deliberately on
        2026-09-13: the CRM only starts at "Meeting requested",
        months after the conversation that earned the meeting, so fetch-on-open would show a thread
        starting mid-sentence. The bodies are stored in `crm_activities`, behind the same `crm_`
        prefix and the same anonymous-401 guarantee as every other personal-data table here.
      */}
    </PageContainer>
  )

  return (
    <CardCollapse.Provider value={collapse}>
      <SplitPane
        storageKey={appKey('split', 'crm')}
        collapseLabel='notes'
        left={left}
        right={<CrmAccountDoc key={account.id} accountId={account.id} />}
      />
    </CardCollapse.Provider>
  )
}

/** The data source a connected contact belongs to, by label. Hand-created contacts have none. */
function sourceLabelOf(c: CrmContact, sources: { id: string; label: string }[] | null): string | null {
  if (!c.data_source_id) return null
  return sources?.find((s) => s.id === c.data_source_id)?.label ?? c.data_source_id
}

/** One person at the account: identity, role, primary flag, and the edit/delete affordances. */
function ContactRow({ contact, sourceLabel }: { contact: CrmContact; sourceLabel: string | null }) {
  const connected = isConnected(contact)
  const [open, setOpen] = React.useState(false)

  const onDelete = (): void => {
    void confirm({
      title: `Remove ${contact.name}?`,
      message: connected
        ? 'They came from a data source, so if it still reports them at a scanned stage they come back on the next sync. Their role, tags and notes here are lost.'
        : 'Hand-created, so nothing will re-import them. This removes the contact for good.',
      confirmLabel: 'Remove',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      void deleteCrmContact(contact.id).then((report) => {
        if (report.warnings.length > 0) window.alert(report.warnings.join('\n\n'))
      })
    })
  }

  return (
    <li className='rounded-md border border-border-light bg-bg p-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <button
          type='button'
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className='min-w-0 flex-1 text-left outline-none'>
          <span className='flex items-center gap-1.5'>
            {contact.is_primary === 1 && <Star className='size-3.5 shrink-0 text-warning' aria-label='Primary contact' />}
            <span className='line-clamp-1 font-medium text-text hover:text-accent'>{contact.name}</span>
          </span>
          <span className='line-clamp-1 text-label text-muted-foreground'>
            {[contact.headline, contact.email].filter(Boolean).join(' · ') || 'No title or email yet'}
          </span>
        </button>
        <div className='w-40 shrink-0'>
          <CrmRoleSelect
            value={contact.role}
            onChange={(role) => void upsertCrmContact({ id: contact.id, role })}
            className={cn(inlineSelectCls, 'w-full')}
          />
        </div>
        {connected && <Badge variant='info'>{sourceLabel}</Badge>}
        <button
          type='button'
          onClick={onDelete}
          title={`Remove ${contact.name}`}
          className='rounded-md p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger'>
          <Trash2 className='size-3.5' />
        </button>
      </div>

      {open && (
        <div className='mt-3 grid grid-cols-1 gap-x-4 gap-y-3 border-t border-border-light pt-3 sm:grid-cols-2'>
          <Field label='Name'>
            <InlineEdit
              defaultValue={contact.name}
              aria-label='Contact name'
              onCommit={(v) => v !== contact.name && void upsertCrmContact({ id: contact.id, name: v })}
            />
          </Field>
          <Field label='Title'>
            <InlineEdit
              defaultValue={contact.headline}
              aria-label='Contact title'
              placeholder='Job title / one-liner'
              onCommit={(v) => v !== contact.headline && void upsertCrmContact({ id: contact.id, headline: v })}
            />
          </Field>
          <Field label='Email'>
            <InlineEdit
              defaultValue={contact.email ?? ''}
              aria-label='Contact email'
              placeholder='name@example.com'
              onCommit={(v) => v !== (contact.email ?? '') && void upsertCrmContact({ id: contact.id, email: v })}
            />
          </Field>
          <Field label='Phone'>
            <InlineEdit
              defaultValue={contact.phone ?? ''}
              aria-label='Contact phone'
              onCommit={(v) => v !== (contact.phone ?? '') && void upsertCrmContact({ id: contact.id, phone: v })}
            />
          </Field>
          <Field label='LinkedIn' className='sm:col-span-2'>
            <InlineEdit
              defaultValue={contact.linkedin_url ?? ''}
              aria-label='Contact LinkedIn URL'
              placeholder='https://www.linkedin.com/in/…'
              onCommit={(v) =>
                v !== (contact.linkedin_url ?? '') && void upsertCrmContact({ id: contact.id, linkedin_url: v })
              }
            />
          </Field>
          <Field label='Notes' className='sm:col-span-2'>
            <InlineEdit
              multiline
              rows={3}
              defaultValue={contact.notes}
              aria-label='Contact notes'
              placeholder='Yours - no import touches this.'
              onCommit={(v) => v !== contact.notes && void upsertCrmContact({ id: contact.id, notes: v })}
            />
          </Field>
          <div className='flex items-center gap-3 sm:col-span-2'>
            {contact.is_primary !== 1 && (
              <Button size='sm' variant='outline' onClick={() => void upsertCrmContact({ id: contact.id, is_primary: true })}>
                <Star /> Make primary
              </Button>
            )}
            {connected && (
              <p className='text-label text-muted-foreground'>
                This person came from a data source, so {sourceLabel} owns their name, title and LinkedIn URL - an edit
                here holds until the next import. Email, phone, role and notes are yours.
                {contact.external_stage && (
                  <>
                    {' '}
                    Last reported as <span className='font-mono text-text'>{contact.external_stage}</span>.
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

const inputCls =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'

/** Inline "add a person" row. Contact ids are namespaced under the account so two accounts can both
 *  have a "john" without colliding. */
function AddContactRow({
  accountId,
  existingIds,
  makePrimary,
  onDone,
}: {
  accountId: string
  existingIds: string[]
  makePrimary: boolean
  onDone: () => void
}) {
  const [name, setName] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)

  const id = name.trim() ? `${accountId}-${slugify(name)}` : ''

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return setError('A name is required.')
    if (existingIds.includes(id)) return setError('That person is already on this account.')
    void upsertCrmContact({ id, account_id: accountId, name: name.trim(), email: email.trim(), is_primary: makePrimary })
      .then(onDone)
      .catch((err) => setError(String(err)))
  }

  return (
    <form onSubmit={submit} className='mt-2 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-border p-3'>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <input
        autoFocus
        value={name}
        onChange={(e) => {
          setName(e.target.value)
          setError(null)
        }}
        placeholder='Name'
        aria-label='New contact name'
        className={cn(inputCls, 'w-48')}
      />
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder='Email (optional)'
        aria-label='New contact email'
        className={cn(inputCls, 'w-56')}
      />
      <Button type='submit' size='sm' disabled={!id}>
        Add
      </Button>
      <Button type='button' size='sm' variant='ghost' onClick={onDone}>
        Cancel
      </Button>
      {error && <p className='w-full text-label text-danger'>{error}</p>}
    </form>
  )
}

/**
 * Which cards on this page are folded shut, and how to fold one. A CONTEXT rather than a hook each
 * card calls for itself: seven cards each holding the whole array and writing all of it back is a
 * write path with seven authors, whatever the hook underneath does about sharing. One owner (the
 * view), one writer, many readers.
 *
 * The preference is GLOBAL, not per account: it says "I do not care about Money right now", which is
 * a statement about the operator's job this week, not about one company. Per-account memory would
 * also mean the same card is open here and shut there for no reason the person can see.
 */
const CardCollapse = React.createContext<{ isCollapsed: (id: string) => boolean; toggle: (id: string) => void }>({
  isCollapsed: () => false,
  toggle: () => {},
})

/**
 * A titled card that folds shut. The whole heading is the hit target (a caret alone is a 14px
 * target), and the header's right-hand slot - an Add button, an outstanding total - goes away while
 * the card is shut: an action that operates on rows you cannot see is a trap.
 */
function Card({
  id,
  title,
  count,
  actions,
  children,
  className,
}: {
  id: string
  title: string
  count?: number
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  const { isCollapsed, toggle } = React.useContext(CardCollapse)
  const collapsed = isCollapsed(id)
  return (
    <CollapsibleSection
      className={cn('mb-4 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)', className)}
      headerClassName={cn(!collapsed && 'mb-3')}
      triggerClassName='-ml-1 gap-1 rounded px-1 py-0.5 text-label font-medium text-muted-foreground hover:text-text'
      open={!collapsed}
      onOpenChange={() => toggle(id)}
      heading={2}
      title={
        <>
          {title}
          {count != null && <span className='tabular-nums'> ({count})</span>}
        </>
      }
      // Shut, the header's right-hand slot goes away: an action that operates on rows you cannot see
      // is a trap. `CollapsibleSection` renders whatever it is given in both states, so this is the
      // card's judgement to make, not the library's.
      aside={collapsed ? null : actions}>
      {children}
    </CollapsibleSection>
  )
}

/** A card holding a 4-column field grid. The page is a stack of these, not one long form. */
function Panel({
  id,
  title,
  children,
  className,
}: {
  id: string
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card id={id} title={title} className={className}>
      <div className='grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-4'>{children}</div>
    </Card>
  )
}

/** A read-only figure in the summary strip. Same label treatment as Field, without the input. */
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex min-w-0 flex-col gap-1'>
      <span className='text-label text-muted-foreground'>{label}</span>
      <span className='truncate text-body-sm text-text'>{children}</span>
    </div>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className='text-label text-muted-foreground'>{label}</span>
      {children}
    </label>
  )
}

// --- the conversation stream --------------------------------------------------------------------

const fmtTime = (d: string): string =>
  new Date(d).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * A hand-logged touch with only a DATE has no time, and the warehouse stores it at midnight UTC.
 * Rendering that as "12:00 AM" invents precision nobody entered, so a midnight-UTC row shows no
 * time at all. A synced message always carries a real delivery time, so this never hides one.
 */
const hasKnownTime = (iso: string): boolean => !/T00:00:00/.test(iso) && !/ 00:00:00/.test(iso)

/** Day boundaries read as "Today"/"Yesterday" near the present and as a date further back - the
 *  same treatment the chat message list uses, because this IS a message list. */
function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return fmtDay(iso)
}

/** A hand-logged row lives in its own id namespace, which is also what the server checks before
 *  allowing an edit or a delete. Keep the two in step. */
const isManual = (a: CrmActivity): boolean => a.id.startsWith('manual:')

/**
 * Log a touch that no integration will ever deliver - a call, an untracked email, a letter.
 *
 * Contact-first, because the contact is what the row anchors to: the account is derived from it
 * server-side, so a touch can never be attached to an account its contact does not belong to.
 */
function LogTouchForm({ contacts, onDone }: { contacts: CrmContact[]; onDone: () => void }) {
  const primary = contacts.find((c) => c.is_primary === 1) ?? contacts[0]
  const [contactId, setContactId] = React.useState(primary?.id ?? '')
  const [channel, setChannel] = React.useState<CrmActivityChannel>('call')
  const [direction, setDirection] = React.useState<CrmActivityDirection>('outbound')
  const [occurredAt, setOccurredAt] = React.useState(new Date().toISOString().slice(0, 10))
  const [subject, setSubject] = React.useState('')
  const [body, setBody] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const save = async (): Promise<void> => {
    if (!body.trim() || !contactId) return
    setBusy(true)
    setError(null)
    try {
      // Picking TODAY means "just now", so send the actual time. An earlier date carries no time -
      // the server stores it at midnight UTC and the stream then shows a date with no clock.
      const today = new Date().toISOString().slice(0, 10)
      const when = occurredAt === today ? new Date().toISOString() : occurredAt || undefined
      await logCrmActivity({
        contact_id: contactId,
        channel,
        direction,
        occurred_at: when,
        body: body.trim(),
        ...(subject.trim() ? { subject: subject.trim() } : {}),
      })
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='mb-3 flex flex-col gap-3 rounded-md border border-border bg-surface-2 p-3'>
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-4'>
        <Field label='With'>
          <select className={inlineSelectCls} value={contactId} onChange={(e) => setContactId(e.target.value)}>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label='Channel'>
          <select
            className={inlineSelectCls}
            value={channel}
            onChange={(e) => setChannel(e.target.value as CrmActivityChannel)}>
            {CRM_ACTIVITY_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {CRM_ACTIVITY_CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label='Direction'>
          <select
            className={inlineSelectCls}
            value={direction}
            onChange={(e) => setDirection(e.target.value as CrmActivityDirection)}>
            <option value='outbound'>We reached out</option>
            <option value='inbound'>They reached out</option>
          </select>
        </Field>
        <Field label='When'>
          <DateInput value={occurredAt} onChange={setOccurredAt} ariaLabel='When it happened' />
        </Field>
      </div>
      <Field label='Subject (optional)'>
        <input
          className='w-full rounded-md border border-border bg-surface px-2 py-1 text-body-sm'
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder='For an email or a letter'
        />
      </Field>
      <Field label='What was said'>
        <textarea
          className='min-h-24 w-full rounded-md border border-border bg-surface px-2 py-1 text-body-sm'
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder='Walked through pricing. Wants a proposal by Friday.'
        />
      </Field>
      {error && <p className='text-body-sm text-danger'>{error}</p>}
      <div className='flex items-center gap-2'>
        <Button size='sm' onClick={() => void save()} disabled={busy || !body.trim() || !contactId}>
          {busy ? 'Saving…' : 'Log it'}
        </Button>
        <Button variant='ghost' size='sm' onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * Every message with this account, across all of its contacts, oldest first.
 *
 * READ-ONLY, and deliberately so: the Box mirrors LinkedIn conversations, it does not send them. There
 * is no composer here and there should not be one until somebody has actually used the read path.
 *
 * Rendered per ACCOUNT rather than per contact: the question this answers is "what is our history
 * with this company", which no single contact's thread can answer once a second person joins the
 * conversation.
 */
function ConversationPanel({ accountId, contacts }: { accountId: string; contacts: CrmContact[] }) {
  const { data, error } = useCrmActivities(accountId)
  const [logging, setLogging] = React.useState(false)
  const rows = data ?? []

  const removeTouch = async (a: CrmActivity): Promise<void> => {
    const preview = a.body.length > 120 ? `${a.body.slice(0, 120)}…` : a.body
    if (!(await confirm({ title: 'Delete this entry?', message: preview, confirmLabel: 'Delete', danger: true }))) return
    await deleteCrmActivity(a.id)
  }

  return (
    <Card
      id='conversation'
      title='Conversation'
      count={data ? rows.length : undefined}
      actions={
        contacts.length > 0 && (
          <Button variant='ghost' size='sm' onClick={() => setLogging((v) => !v)}>
            <Plus /> Log a touch
          </Button>
        )
      }>
      {logging && (
        <LogTouchForm contacts={contacts} onDone={() => setLogging(false)} />
      )}
      {error && <p className='text-body-sm text-danger'>{error}</p>}
      {!error && !data && <p className='text-body-sm text-muted-foreground'>Loading…</p>}
      {!error && data && rows.length === 0 && !logging && (
        <div className='rounded-md border border-dashed border-border px-3 py-4 text-body-sm text-muted-foreground'>
          No conversation recorded yet. Messages sync in from connected channels; anything else - a
          call, an email, a letter - you can log by hand.
        </div>
      )}
      {rows.length > 0 && (
        <ol className='flex flex-col gap-3'>
          {rows.map((a, i) => {
            const prev = i > 0 ? rows[i - 1] : null
            const newDay = !prev || dayLabel(prev.occurred_at) !== dayLabel(a.occurred_at)
            const inbound = a.direction === 'inbound'
            return (
              <li key={a.id} className='flex flex-col gap-3'>
                {newDay && (
                  <div className='flex items-center gap-3' aria-hidden>
                    <span className='h-px flex-1 bg-border' />
                    <span className='text-label text-muted-foreground'>{dayLabel(a.occurred_at)}</span>
                    <span className='h-px flex-1 bg-border' />
                  </div>
                )}
                <div className={cn('flex flex-col gap-1', !inbound && 'items-end')}>
                  <div className='group flex items-center gap-2 text-label text-muted-foreground'>
                    <span className='font-medium text-text'>{a.author_name || (inbound ? 'Them' : 'Us')}</span>
                    {hasKnownTime(a.occurred_at) && <span>{fmtTime(a.occurred_at)}</span>}
                    {/* The channel only earns a badge when it is NOT the LinkedIn default - a
                        stream that says "LinkedIn" on every row says nothing. */}
                    {a.channel !== 'linkedin' && (
                      <Badge variant='neutral'>{CRM_ACTIVITY_CHANNEL_LABEL[a.channel] ?? a.channel}</Badge>
                    )}
                    {a.interaction_type && <Badge variant='neutral'>{a.interaction_type.toLowerCase().replaceAll('_', ' ')}</Badge>}
                    {/* Only a hand-logged row is deletable: a synced message comes back on the next
                        backfill, so the server refuses it and the button would be a lie. */}
                    {isManual(a) && (
                      <button
                        type='button'
                        aria-label='Delete this entry'
                        onClick={() => void removeTouch(a)}
                        className='opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger'>
                        <Trash2 className='size-3.5' />
                      </button>
                    )}
                  </div>
                  <div
                    className={cn(
                      'max-w-[85%] rounded-lg border px-3 py-2 text-body-sm whitespace-pre-wrap',
                      inbound
                        ? 'border-border bg-surface-2 text-text'
                        : 'border-transparent bg-accent/10 text-text',
                    )}>
                    {a.subject && <p className='mb-1 font-medium'>{a.subject}</p>}
                    {a.body || <span className='text-muted-foreground'>(no text)</span>}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </Card>
  )
}

// --- phase 3: meetings + money ------------------------------------------------------------------

const fmtDay = (d: string): string =>
  new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

const OUTCOME_VARIANT: Record<CrmMeetingOutcome, 'success' | 'warning' | 'danger' | 'neutral'> = {
  held: 'success',
  scheduled: 'neutral',
  no_show: 'danger',
  cancelled: 'neutral',
}

/** The confidence rubric as a muted hint - "matched on domain" is a materially weaker claim than
 *  "matched on contact email", and a human clearing the queue needs to see which they are trusting. */
function MatchHint({ matchedBy }: { matchedBy: string | null }) {
  if (!matchedBy) return null
  const conf = CRM_MATCH_CONFIDENCE[matchedBy] ?? 'low'
  return (
    <span
      className={cn(
        'text-label',
        conf === 'high' ? 'text-muted-foreground' : conf === 'medium' ? 'text-warning' : 'text-danger',
      )}
      title={`account matched on ${matchedBy.replace(/_/g, ' ')} (${conf} confidence)`}>
      {matchedBy.replace(/_/g, ' ')}
    </span>
  )
}

/**
 * Meetings, newest first. The one action that matters is closing out a PAST meeting still sitting at
 * `scheduled`: no machine may ever assert `no_show` (a past event with no transcript is either a
 * no-show or a call held somewhere that does not record), so that row waits here for a human.
 */
function MeetingsPanel({ accountId, contacts }: { accountId: string; contacts: CrmContact[] }) {
  const { data: meetings, error } = useCrmMeetings(accountId)
  const [adding, setAdding] = React.useState(false)

  const rows = meetings ?? []
  const now = Date.now()
  const needsClosing = rows.filter((m) => m.outcome === 'scheduled' && new Date(m.scheduled_at).getTime() < now)

  return (
    <Card
      id='meetings'
      title='Meetings'
      count={rows.length}
      actions={
        <Button size='sm' variant='outline' onClick={() => setAdding(true)}>
          <Plus /> Add meeting
        </Button>
      }>
      {error && <p className='mb-2 text-body-sm text-danger'>{error}</p>}

      {needsClosing.length > 0 && (
        <p className='mb-3 rounded-md border border-warning/50 bg-warning-bg/40 px-3 py-2 text-body-sm text-muted-foreground'>
          {needsClosing.length === 1 ? 'One meeting is' : `${needsClosing.length} meetings are`} past and still marked
          scheduled. Nothing can decide held-or-no-show but you.
        </p>
      )}

      {meetings === null ? (
        <p className='text-body-sm text-muted-foreground'>Loading…</p>
      ) : rows.length === 0 ? (
        <p className='rounded-md border border-dashed border-border py-6 text-center text-body-sm text-muted-foreground'>
          No meetings recorded.
        </p>
      ) : (
        <ul className='flex flex-col gap-1'>
          {rows.map((m) => (
            <MeetingRow key={m.id} meeting={m} contacts={contacts} />
          ))}
        </ul>
      )}

      {adding && <AddMeetingRow accountId={accountId} onDone={() => setAdding(false)} />}
    </Card>
  )
}

function MeetingRow({ meeting: m, contacts }: { meeting: CrmMeeting; contacts: CrmContact[] }) {
  const past = new Date(m.scheduled_at).getTime() < Date.now()
  const contact = contacts.find((c) => c.id === m.contact_id)

  const onDelete = (): void => {
    void confirm({
      title: 'Delete this meeting?',
      message:
        m.source === 'calendar'
          ? 'This row came from the calendar and will be re-created on the next sync. Mark it cancelled instead if you want it gone for good.'
          : 'This removes the meeting record for good.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      void deleteCrmMeeting(m.id).then((r) => {
        if (r.warnings.length > 0) window.alert(r.warnings.join('\n\n'))
      })
    })
  }

  return (
    <li className='group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 hover:bg-surface-2'>
      <span className='w-24 shrink-0 tabular-nums text-body-sm text-muted-foreground'>{fmtDay(m.scheduled_at)}</span>
      {/* The kind Select IS the display - a separate badge beside it would double the width, and an
          `opacity-0` select still occupies its box, which is what crushed the title to "De…". */}
      <Select
        value={m.kind}
        onValueChange={(next) => void upsertCrmMeeting({ id: m.id, kind: next as CrmMeetingKind })}
        items={CRM_MEETING_KINDS.map((k) => ({ value: k, label: CRM_MEETING_KIND_LABEL[k] }))}>
        <SelectTrigger aria-label='Meeting kind' className={cn(inlineSelectCls, 'w-26 shrink-0')}>
          <SelectValue>{(v) => <span>{CRM_MEETING_KIND_LABEL[v as CrmMeetingKind]}</span>}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {CRM_MEETING_KINDS.map((k) => (
            <SelectItem key={k} value={k}>
              {CRM_MEETING_KIND_LABEL[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Badge variant={OUTCOME_VARIANT[m.outcome]}>{CRM_MEETING_OUTCOME_LABEL[m.outcome]}</Badge>
      {m.rescheduled_count > 0 && (
        <span className='text-label text-muted-foreground' title='times this meeting moved'>
          moved {m.rescheduled_count}x
        </span>
      )}
      <span className='min-w-32 flex-1 truncate text-body-sm' title={m.title}>
        {m.title || <span className='text-muted-foreground'>(untitled)</span>}
      </span>
      {m.duration_min != null && (
        <span className='tabular-nums text-label text-muted-foreground'>{m.duration_min}m</span>
      )}
      <span className='hidden max-w-40 truncate text-label text-muted-foreground xl:inline'>
        {contact?.name ?? m.attendee_email ?? ''}
      </span>
      <MatchHint matchedBy={m.matched_by} />

      {/* Closing out a past `scheduled` row is the whole point of this panel. */}
      {past && m.outcome === 'scheduled' && (
        <span className='flex gap-1'>
          <Button size='sm' variant='outline' onClick={() => void upsertCrmMeeting({ id: m.id, outcome: 'held' })}>
            Held
          </Button>
          <Button size='sm' variant='outline' onClick={() => void upsertCrmMeeting({ id: m.id, outcome: 'no_show' })}>
            No-show
          </Button>
        </span>
      )}

      <Button
        size='sm'
        variant='ghost'
        aria-label='Delete meeting'
        className='opacity-0 group-hover:opacity-100'
        onClick={onDelete}>
        <Trash2 />
      </Button>
    </li>
  )
}

function AddMeetingRow({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const [title, setTitle] = React.useState('')
  const [at, setAt] = React.useState(new Date().toISOString().slice(0, 10))
  const [kind, setKind] = React.useState<CrmMeetingKind>('discovery')
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    // A manual row is how a phone call that never had a calendar entry gets recorded at all. The id
    // is slugged from the date + title so a double submit is an upsert, not a duplicate.
    const id = `manual:${accountId}:${at}-${slugify(title || kind)}`.slice(0, 200)
    void upsertCrmMeeting({
      id,
      account_id: accountId,
      source: 'manual',
      scheduled_at: `${at}T12:00:00Z`,
      title,
      kind,
      outcome: new Date(at).getTime() < Date.now() ? 'held' : 'scheduled',
    }).then(
      () => onDone(),
      (e2: unknown) => {
        setErr(e2 instanceof Error ? e2.message : String(e2))
        setBusy(false)
      },
    )
  }

  return (
    <form onSubmit={submit} className='mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3'>
      <DateInput value={at} onChange={setAt} ariaLabel='Meeting date' />
      <Select
        value={kind}
        onValueChange={(v) => setKind(v as CrmMeetingKind)}
        items={CRM_MEETING_KINDS.map((k) => ({ value: k, label: CRM_MEETING_KIND_LABEL[k] }))}>
        <SelectTrigger aria-label='Kind' className={cn(inlineSelectCls, 'w-32')}>
          <SelectValue>{(v) => <span>{CRM_MEETING_KIND_LABEL[v as CrmMeetingKind]}</span>}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {CRM_MEETING_KINDS.map((k) => (
            <SelectItem key={k} value={k}>
              {CRM_MEETING_KIND_LABEL[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <input
        className='min-w-48 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-body-sm'
        placeholder='What was it? e.g. Discovery call with Mark'
        aria-label='Meeting title'
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Button size='sm' type='submit' disabled={busy}>
        Add
      </Button>
      <Button size='sm' type='button' variant='ghost' onClick={onDone}>
        Cancel
      </Button>
      {err && <p className='w-full text-body-sm text-danger'>{err}</p>}
    </form>
  )
}

const REVENUE_VARIANT: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  paid: 'success',
  open: 'warning',
  voided: 'neutral',
  refunded: 'danger',
}

const money = (n: number, ccy: string): string =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(n)

/**
 * Money, newest first. Two things here are not decoration:
 *
 * 1. The COVERAGE GAP warning. A paid recurring row with no service window reads as a one-month
 *    payment, which is a 12x error on both the MRR walk and the cash forecast, and it is silent -
 *    one such annual was dropped from a shipped report before a human caught it by eye.
 * 2. The open total, by currency. Receivables were invisible until a human went looking: on the day
 *    this was measured, not one of the four open invoices was mentioned on its account row.
 */
function MoneyPanel({ accountId }: { accountId: string }) {
  const { data: events, error } = useCrmRevenueEvents(accountId)
  const rows = events ?? []

  const openByCcy = new Map<string, number>()
  for (const e of rows.filter((r) => r.status === 'open')) {
    openByCcy.set(e.currency, (openByCcy.get(e.currency) ?? 0) + e.amount)
  }
  const gaps = rows.filter(needsCoverage)

  return (
    <Card
      id='money'
      title='Money'
      count={rows.length}
      actions={
        openByCcy.size > 0 ? (
          <span className='text-body-sm text-warning'>
            {[...openByCcy].map(([ccy, amt]) => money(amt, ccy)).join(' + ')} outstanding
          </span>
        ) : undefined
      }>
      {error && <p className='mb-2 text-body-sm text-danger'>{error}</p>}

      {gaps.length > 0 && (
        <p className='mb-3 rounded-md border border-danger/50 bg-danger-bg/40 px-3 py-2 text-body-sm text-muted-foreground'>
          {gaps.length === 1 ? 'One paid row has' : `${gaps.length} paid rows have`} no service window, so the MRR walk
          and the cash forecast will read {gaps.length === 1 ? 'it' : 'them'} as a single month. Set the period below.
        </p>
      )}

      {events === null ? (
        <p className='text-body-sm text-muted-foreground'>Loading…</p>
      ) : rows.length === 0 ? (
        <p className='rounded-md border border-dashed border-border py-6 text-center text-body-sm text-muted-foreground'>
          No invoices or payments recorded.
        </p>
      ) : (
        <ul className='flex flex-col gap-1'>
          {rows.map((e) => (
            <RevenueRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function RevenueRow({ event: e }: { event: CrmRevenueEvent }) {
  const gap = needsCoverage(e)

  const onDelete = (): void => {
    void confirm({
      title: `Delete ${e.invoice_number ?? 'this row'}?`,
      message:
        e.provider === 'manual'
          ? 'This removes the record for good.'
          : `This row came from ${e.provider} and will be re-created on the next sync. Mark it voided instead if you want it gone for good.`,
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      void deleteCrmRevenueEvent(e.id).then((r) => {
        if (r.warnings.length > 0) window.alert(r.warnings.join('\n\n'))
      })
    })
  }

  return (
    <li
      className={cn(
        'group flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 hover:bg-surface-2',
        gap && 'border border-danger/40 bg-danger-bg/20',
      )}>
      <span className='w-24 shrink-0 tabular-nums text-body-sm text-muted-foreground'>{fmtDay(e.issued_at)}</span>
      <span className='w-20 shrink-0 truncate text-body-sm'>{e.invoice_number ?? ''}</span>
      <Badge variant={REVENUE_VARIANT[e.status] ?? 'neutral'}>{CRM_REVENUE_STATUS_LABEL[e.status]}</Badge>
      {e.kind === 'one_off' && <Badge variant='neutral'>{CRM_REVENUE_KIND_LABEL.one_off}</Badge>}
      <span className='min-w-32 flex-1 truncate text-body-sm text-muted-foreground' title={e.description}>
        {e.description}
      </span>

      <span className='shrink-0 tabular-nums text-body-sm'>
        {money(e.amount, e.currency)}
        {e.currency !== 'USD' && (
          <span className='ml-1 text-label text-muted-foreground' title={`fx ${e.fx_rate} (${e.fx_rate_month ?? '?'})`}>
            ≈ {money(e.amount_usd, 'USD')}
          </span>
        )}
      </span>

      {/* The service window - stored, not derived, so a prepay or a late renewal is correctable
          here rather than silently wrong in the walk. */}
      {gap ? (
        <span className='flex shrink-0 items-center gap-1'>
          {[1, 3, 12].map((n) => (
            <Button
              key={n}
              size='sm'
              variant='outline'
              title={`covers ${n} month${n > 1 ? 's' : ''} from ${e.paid_at ?? e.issued_at}`}
              onClick={() => void upsertCrmRevenueEvent({ id: e.id, period_months: n })}>
              {n}mo
            </Button>
          ))}
        </span>
      ) : (
        e.covers_to && (
          <span className='shrink-0 tabular-nums text-label text-muted-foreground' title='service window ends / next bill'>
            → {fmtDay(e.covers_to)}
          </span>
        )
      )}

      <MatchHint matchedBy={e.matched_by} />
      <Button
        size='sm'
        variant='ghost'
        aria-label='Delete revenue event'
        className='opacity-0 group-hover:opacity-100'
        onClick={onDelete}>
        <Trash2 />
      </Button>
    </li>
  )
}
