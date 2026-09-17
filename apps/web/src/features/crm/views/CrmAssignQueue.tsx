import * as React from 'react'
import { Building2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge, Button, Popover, PopoverContent, PopoverTrigger, PageContainer } from '@silkweave/box-ui'
import { crmStatusUi } from '../components/crmStatus.tsx'
import { useCrmData } from '../lib/useCrmData.ts'
import { upsertCrmMeeting, upsertCrmRevenueEvent, useCrmAssignQueue } from '../lib/useCrmEvents.ts'
import {
  CRM_MEETING_KIND_LABEL,
  CRM_REVENUE_STATUS_LABEL,
  needsCoverage,
  needsOutcome,
  type CrmAccount,
  type CrmMeeting,
  type CrmRevenueEvent,
} from '../crm-types.ts'

/**
 * The assign queue: every row the syncs could not decide, from both event tables, on one page.
 *
 * It exists because an unmatched row is WRITTEN rather than dropped - a payment whose payer matches
 * no contact, a calendar event with an unknown external attendee - and a row written nowhere visible
 * is a row lost. Two more kinds of open question ride along, because they are the same human motion
 * (look at it, answer it, move on):
 *
 *   • a PAST meeting still at `scheduled`. No machine may assert `no_show`, so this one can only
 *     ever be closed here.
 *   • a PAID RECURRING row with no service window, which the MRR walk reads as a single month - a
 *     12x error on an annual prepay, and a silent one.
 *
 * Every control writes through the same human upsert path the account detail panels use, so
 * `matched_by` becomes `manual` and the next sync will not undo the answer.
 */
export function CrmAssignQueue() {
  const { data: queue, error } = useCrmAssignQueue()
  const { data: accounts } = useCrmData()

  const meetings = queue?.meetings ?? []
  const events = queue?.events ?? []
  const total = meetings.length + events.length

  if (error)
    return (
      <PageContainer width='wide'>
        <p className='text-body-sm text-danger'>{error}</p>
      </PageContainer>
    )

  return (
    <PageContainer width='wide'>
      <header className='mb-6'>
        <h1 className='text-heading-md'>
          Assign queue <span className='tabular-nums text-muted-foreground'>({total})</span>
        </h1>
        <p className='mt-1 text-body-sm text-muted-foreground'>
          What no sync could decide: rows with no account, past meetings nobody closed out, and paid
          recurring rows with no service window. Answering one here is final - the next sync leaves it alone.
        </p>
      </header>

      {queue === null ? (
        <p className='text-body-sm text-muted-foreground'>Loading…</p>
      ) : total === 0 ? (
        <p className='rounded-md border border-dashed border-border py-10 text-center text-body-sm text-muted-foreground'>
          Nothing waiting. Every meeting and every payment is attributed.
        </p>
      ) : (
        <div className='flex flex-col gap-6'>
          {meetings.length > 0 && (
            <Section title='Meetings' count={meetings.length}>
              {meetings.map((m) => (
                <MeetingQueueRow key={m.id} meeting={m} accounts={accounts ?? []} />
              ))}
            </Section>
          )}
          {events.length > 0 && (
            <Section title='Money' count={events.length}>
              {events.map((e) => (
                <RevenueQueueRow key={e.id} event={e} accounts={accounts ?? []} />
              ))}
            </Section>
          )}
        </div>
      )}
    </PageContainer>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className='rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <h2 className='mb-3 text-label font-medium text-muted-foreground'>
        {title} <span className='tabular-nums'>({count})</span>
      </h2>
      <ul className='flex flex-col gap-1'>{children}</ul>
    </section>
  )
}

const fmtDay = (d: string): string =>
  new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

const money = (n: number, ccy: string): string =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(n)

const rowCls = 'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md px-2 py-2 hover:bg-surface-2'

function MeetingQueueRow({ meeting: m, accounts }: { meeting: CrmMeeting; accounts: CrmAccount[] }) {
  return (
    <li className={rowCls}>
      <span className='w-24 shrink-0 tabular-nums text-body-sm text-muted-foreground'>{fmtDay(m.scheduled_at)}</span>
      <Badge variant='neutral'>{CRM_MEETING_KIND_LABEL[m.kind]}</Badge>
      <span className='min-w-32 flex-1 truncate text-body-sm' title={m.title}>
        {m.title || <span className='text-muted-foreground'>(untitled)</span>}
      </span>
      <span className='hidden max-w-56 truncate text-label text-muted-foreground xl:inline' title={m.attendee_email ?? ''}>
        {m.attendee_email ?? ''}
      </span>

      {m.account_id === null && (
        <AccountPicker
          accounts={accounts}
          onPick={(id) => void upsertCrmMeeting({ id: m.id, account_id: id })}
        />
      )}

      {/* Held-or-no-show is a human's call by design, so it is an action here rather than a flag. */}
      {needsOutcome(m) && (
        <span className='flex shrink-0 gap-1'>
          <Button size='sm' variant='outline' onClick={() => void upsertCrmMeeting({ id: m.id, outcome: 'held' })}>
            Held
          </Button>
          <Button size='sm' variant='outline' onClick={() => void upsertCrmMeeting({ id: m.id, outcome: 'no_show' })}>
            No-show
          </Button>
        </span>
      )}
    </li>
  )
}

function RevenueQueueRow({ event: e, accounts }: { event: CrmRevenueEvent; accounts: CrmAccount[] }) {
  return (
    <li className={rowCls}>
      <span className='w-24 shrink-0 tabular-nums text-body-sm text-muted-foreground'>{fmtDay(e.issued_at)}</span>
      <span className='w-20 shrink-0 truncate text-body-sm'>{e.invoice_number ?? ''}</span>
      <Badge variant='neutral'>{CRM_REVENUE_STATUS_LABEL[e.status]}</Badge>
      <span className='min-w-32 flex-1 truncate text-body-sm text-muted-foreground' title={e.description}>
        {e.description || e.payer_email || ''}
      </span>
      <span className='shrink-0 tabular-nums text-body-sm'>{money(e.amount, e.currency)}</span>

      {e.account_id === null && (
        <AccountPicker
          accounts={accounts}
          onPick={(id) => void upsertCrmRevenueEvent({ id: e.id, account_id: id })}
        />
      )}

      {/* The window is stored, never derived: 1/3/12 months from paid_at is the seed, correctable
          on the account page afterwards. */}
      {needsCoverage(e) && (
        <span className='flex shrink-0 items-center gap-1' title='no service window - the walk reads this as one month'>
          {[1, 3, 12].map((n) => (
            <Button
              key={n}
              size='sm'
              variant='outline'
              onClick={() => void upsertCrmRevenueEvent({ id: e.id, period_months: n })}>
              {n}mo
            </Button>
          ))}
        </span>
      )}
    </li>
  )
}

/**
 * Pick the account a row belongs to. A filter box rather than a plain list because the book is ~100
 * accounts and growing; archived ones are still offered, since an old payment often belongs to one.
 */
function AccountPicker({ accounts, onPick }: { accounts: CrmAccount[]; onPick: (id: string) => void }) {
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState('')
  const needle = q.trim().toLowerCase()
  const shown = (needle ? accounts.filter((a) => a.name.toLowerCase().includes(needle)) : accounts).slice(0, 50)

  return (
    <Popover
      open={open}
      onOpenChange={(v: boolean) => {
        setOpen(v)
        if (!v) setQ('')
      }}>
      <PopoverTrigger
        className={cn(
          'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-warning/60 bg-warning-bg/40 px-2',
          'text-body-sm text-text transition-colors outline-none hover:bg-warning-bg/70 focus-visible:border-accent',
        )}>
        <Building2 className='size-3.5' />
        Assign account
      </PopoverTrigger>
      <PopoverContent align='end' className='w-64 gap-1 p-1.5'>
        <div className='flex items-center gap-1.5 border-b border-border px-2 pb-1.5'>
          <Search className='size-3.5 shrink-0 text-muted-foreground' />
          <input
            autoFocus
            value={q}
            onChange={(ev) => setQ(ev.target.value)}
            placeholder='Search accounts'
            className='h-6 w-full bg-transparent text-body-sm outline-none placeholder:text-muted-foreground'
          />
        </div>
        <div className='max-h-64 overflow-y-auto'>
          {shown.map((a) => (
            <button
              key={a.id}
              type='button'
              onClick={() => {
                setOpen(false)
                setQ('')
                onPick(a.id)
              }}
              className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body-sm text-text transition-colors hover:bg-accent-tint'>
              <StatusDot status={a.status} />
              <span className='line-clamp-1 flex-1'>{a.name}</span>
            </button>
          ))}
          {shown.length === 0 && <p className='px-2 py-1.5 text-label text-muted-foreground'>No account matches.</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The account's status as a colored glyph - enough to tell a live account from an archived one. */
function StatusDot({ status }: { status: string }) {
  const { icon: Icon, color, label } = crmStatusUi(status)
  return <Icon className={cn('size-3.5 shrink-0', color)} aria-label={label} />
}

/** The queue's size, for the sidebar badge. Null while it is still loading. */
export function useAssignQueueCount(): number | null {
  const { data } = useCrmAssignQueue()
  return data ? data.meetings.length + data.events.length : null
}
