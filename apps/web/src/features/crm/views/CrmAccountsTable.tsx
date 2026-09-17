import * as React from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ExternalLink, Plus, Trash2, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge, Button, confirm, Dialog, DialogContent, DialogDescription, DialogTitle, GridFooter, GridHeader, PageContainer, TopBarActions, Money, Percent, formatCurrency, inlineSelectCls, UserPicker } from '@silkweave/box-ui'
import { ShowAllContext } from '@/lib/showAll.tsx'
import { CrmStatusSelect } from '../components/crmStatus.tsx'
import { ViewBar } from '../../data/components/board/ViewBar.tsx'
import { CrmKanban } from '../components/CrmKanban.tsx'
import { CrmLinkEdit } from '../components/CrmLinkEdit.tsx'
import { getActiveUserId, useActiveUser } from '../../../lib/useActiveUser.ts'
import { usePersistedState } from '../../../lib/usePersistedState.ts'
import { useColumnAggregates, useColumnWidths } from '../../../lib/gridColumns.ts'
import { rowCountLabel } from '../../../lib/rowCount.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { userName } from '../../../user-types.ts'
import {
  deleteCrmAccount,
  setCrmAccountStatus,
  upsertCrmAccount,
  upsertCrmContact,
  useCrmData,
} from '../lib/useCrmData.ts'
import { useCrmView } from '../lib/useCrmView.ts'
import {
  CRM_COLUMNS,
  allCrmTags,
  applyCrmView,
  crmAggregates,
  crmBarSpec,
  crmGrid,
  crmGroupLabel,
  isActionOverdue,
  kanbanColumns,
  type CrmColumnKey,
} from '../lib/crmView.ts'
import {
  CRM_ACCOUNT_SOURCE_LABEL,
  primaryContact,
  weightedMrr,
  type CrmAccount,
} from '../crm-types.ts'
import { appKey } from '@/lib/storage.ts'

/** name → slug id. Account ids are always slugs (only CONTACT ids can be a source's lead id). */
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

/**
 * The CRM working surface: one row per ACCOUNT (the company - and, since there is no Deal object,
 * the deal). Two layouts over one view model - a full-width data grid, and a pipeline board you drag
 * cards across. The layout is part of the preset, so "Pipeline" is a lens someone picks rather than a
 * mode with its own forgotten state.
 *
 * There is exactly ONE filter surface (the board bar). The status sidebar this view used to carry was
 * a second one, so it became plain navigation when the bar arrived.
 */
export function CrmAccountsTable() {
  const navigate = useNavigate()
  const { data } = useCrmData()
  const { data: users } = useUsersData()
  const { userId: activeUserId, user: activeUser, filterMine } = useActiveUser()
  const showArchived = React.useContext(ShowAllContext)
  const v = useCrmView()
  // Widths, and what the footer totals, are per-browser user settings - deliberately outside the
  // preset, though the footer's choices are keyed BY the preset you are on (see `gridColumns.ts`).
  const { widths, setWidth } = useColumnWidths(appKey('crm'))
  const aggregates = useColumnAggregates(appKey('crm'), v.selected)
  const [collapsedGroups, setCollapsedGroups] = usePersistedState<string[]>(
    appKey('crm', 'collapsedGroups'),
    [],
    (val) => Array.isArray(val) && val.every((x) => typeof x === 'string'),
  )
  const [createOpen, setCreateOpen] = React.useState(false)

  const accounts = data ?? []
  const ownerName = (id: string) => {
    const u = users?.find((x) => x.id === id)
    return u ? userName(u) : id
  }
  const mineOnly = filterMine && !!activeUserId
  const groups = applyCrmView(accounts, v.view, { showArchived, mineOnly, activeUserId, ownerName })
  const visible = groups.flatMap((g) => g.items)
  // The view's own order, not the catalog's - which columns you took AND how you arranged them.
  const columns = v.view.columns.filter((k) => CRM_COLUMNS.some((c) => c.key === k))
  const grid = crmGrid(columns, widths)
  const openAccount = (id: string) => void navigate({ to: '/crm/$id', params: { id } })
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]))

  if (!data) return null

  if (accounts.length === 0)
    return (
      <div className='mx-auto max-w-3xl px-4 py-16 text-center text-body-sm text-muted-foreground'>
        No accounts yet. Create one here, or use the <code>CrmAccountUpsert</code> MCP tool
        (<code>pnpm cli CrmAccountUpsert</code>).
        <div className='mt-4'>
          <Button size='sm' onClick={() => setCreateOpen(true)}>
            <Plus /> New account
          </Button>
        </div>
        <NewAccountDialog open={createOpen} existingIds={[]} onClose={() => setCreateOpen(false)} />
      </div>
    )

  return (
    // Flush + headingless: see the note in `InitiativesGrid`. The breadcrumb says CRM.
    // A full-height column, because the GRID is what scrolls, not the page - that is what lets the
    // header stick to the top of the rows and the footer's totals stay on screen (see `GridFooter`).
    <PageContainer width='flush' className='flex h-full flex-col'>
      <TopBarActions>
        <Button size='sm' onClick={() => setCreateOpen(true)} className='shrink-0'>
          <Plus /> New account
        </Button>
      </TopBarActions>

      <ViewBar
        view={v}
        spec={{
          ...crmBarSpec(accounts, allCrmTags(accounts), ownerName, v.view.layout),
          notice: mineOnly && activeUser ? `Only ${activeUser.nickname || activeUser.id}'s` : undefined,
        }}
      />

      {v.view.layout === 'board' ? (
        <div className='min-h-0 flex-1 overflow-auto p-3'>
          <CrmKanban accounts={visible} columns={kanbanColumns(v.view)} onOpen={openAccount} />
        </div>
      ) : (
        <div className='min-h-0 flex-1 overflow-auto'>
          {/* At LEAST the height of the scrollport, and a column, so the footer's `mt-auto` can sit
              on the bottom edge when four rows survive a filter instead of floating under them. */}
          <div style={{ minWidth: grid.minWidth }} className='flex min-h-full flex-col'>
            <GridHeader columns={grid.columns} template={grid.template} onResize={setWidth} />

            {visible.length === 0 ? (
              <p className='px-3 py-12 text-center text-body-sm text-muted-foreground'>
                Nothing matches this view. Clear a filter, or widen the search.
              </p>
            ) : (
              groups.map((g) => {
                const collapsed = collapsedGroups.includes(g.key)
                return (
                  <div key={g.key}>
                    {g.label && (
                      <button
                        type='button'
                        onClick={() => toggleGroup(g.key)}
                        aria-expanded={!collapsed}
                        className='flex w-full items-center gap-2 border-b border-border bg-bg px-3 py-1.5 text-left text-label font-medium text-muted-foreground hover:text-text'>
                        {crmGroupLabel(v.view.groupBy, g.label)}
                        <span className='tabular-nums opacity-70'>{g.items.length}</span>
                      </button>
                    )}
                    {!collapsed &&
                      g.items.map((a) => (
                        <Row key={a.id} account={a} columns={columns} template={grid.template} onOpen={openAccount} />
                      ))}
                  </div>
                )
              })
            )}

            {visible.length > 0 && (
              <GridFooter
                columns={grid.columns}
                template={grid.template}
                label={rowCountLabel(visible.length, accounts.length, { one: 'account', many: 'accounts' })}
                sources={crmAggregates(visible, columns)}
                store={aggregates}
              />
            )}
          </div>
        </div>
      )}

      <NewAccountDialog open={createOpen} existingIds={accounts.map((a) => a.id)} onClose={() => setCreateOpen(false)} />
    </PageContainer>
  )
}

function Row({
  account: a,
  columns,
  template,
  onOpen,
}: {
  account: CrmAccount
  columns: CrmColumnKey[]
  template: string
  onOpen: (id: string) => void
}) {
  const primary = primaryContact(a)
  const overdue = isActionOverdue(a)
  const weighted = weightedMrr(a)

  const onDelete = (): void => {
    void confirm({
      title: `Delete ${a.name}?`,
      message:
        a.contacts.length > 0
          ? `This also deletes its ${a.contacts.length} contact(s), and the status, owner, MRR, next action and notes are gone for good. Set the status to "archived" instead to keep the record and park it.`
          : 'This removes the account for good. Set the status to "archived" instead to keep the record and park it.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      void deleteCrmAccount(a.id).then((report) => {
        if (report.warnings.length > 0) window.alert(report.warnings.join('\n\n'))
      })
    })
  }

  const cell = (key: CrmColumnKey) => {
    switch (key) {
      case 'contacts':
        return a.contacts.length === 0 ? (
          <span className='text-label text-warning'>no contacts yet</span>
        ) : (
          <span className='inline-flex min-w-0 items-center gap-1.5'>
            <span className='line-clamp-1'>{primary?.name}</span>
            {a.contacts.length > 1 && (
              <span className='inline-flex shrink-0 items-center gap-0.5 text-label text-muted-foreground'>
                <Users className='size-3' />
                {a.contacts.length}
              </span>
            )}
          </span>
        )
      // The money columns are right-aligned (the CELLS - the headers stay left, see CRM_COLUMNS),
      // with the `$` and the cents dimmed by `Money`, so a column of them reads as magnitudes.
      case 'value':
        // One cell for the whole money question: what this account is worth to the pipeline, and
        // underneath, the two numbers that produced it. Three separate columns could say the same
        // thing, but only if you turned all three on and remembered which was which.
        return (
          <span className='flex flex-col leading-tight'>
            <Money value={weighted} className='text-text' />
            <span className='text-label text-fg-4'>
              {a.close_probability != null ? `${a.close_probability}%` : '-'} {formatCurrency(a.mrr_usd)}
            </span>
          </span>
        )
      case 'mrr':
        return <Money value={a.mrr_usd} className='text-text' />
      case 'probability':
        return <Percent value={a.close_probability} />
      case 'weighted':
        return <Money value={weighted} />
      case 'next_action':
        return (
          <span className='line-clamp-2 leading-snug' title={a.next_action || undefined}>
            {a.next_action || '-'}
          </span>
        )
      case 'due':
        return (
          <span className={cn('tabular-nums', overdue ? 'text-danger' : undefined)}>{a.next_action_at ?? '-'}</span>
        )
      case 'source':
        return <Badge variant={a.source === 'unknown' ? 'neutral' : 'info'}>{CRM_ACCOUNT_SOURCE_LABEL[a.source]}</Badge>
      case 'referral':
        return <span className='line-clamp-1'>{a.referral_partner ?? '-'}</span>
      case 'last_contacted':
        return <span className='tabular-nums'>{a.last_contacted_at ?? '-'}</span>
      case 'subscription':
        // Two chunks that wrap as units. A plain string broke wherever the column edge fell, which
        // on a narrow Subscription column meant splitting a date down the middle ("2026-04-" / "22").
        // Flex-wrap keeps it on one line when there is room and breaks at the arrow when there is not.
        return (
          <span className='flex flex-wrap gap-x-1 tabular-nums'>
            <span className='whitespace-nowrap'>{a.subscription_start_at ?? '-'}</span>
            {a.subscription_end_at && (
              <span className='whitespace-nowrap text-danger'>→ {a.subscription_end_at}</span>
            )}
          </span>
        )
      // The external links edit IN the cell: deciding which Stripe customer or WhatsApp group IS
      // this account is a pass over the whole list, not a visit to thirty detail pages.
      // No placeholder here, unlike the account page. A column of `cus_…` down eighty unset rows
      // reads as DATA at a glance - which is the exact question this column exists to answer.
      case 'stripe':
        return (
          <CrmLinkEdit
            accountId={a.id}
            field='stripe_customer_id'
            value={a.stripe_customer_id}
            ariaLabel={`Stripe customer id for ${a.name}`}
            inputClassName='h-6 font-mono text-label'
          />
        )
      case 'whatsapp':
        return (
          <CrmLinkEdit
            accountId={a.id}
            field='whatsapp_group_jid'
            value={a.whatsapp_group_jid}
            ariaLabel={`WhatsApp group JID for ${a.name}`}
            inputClassName='h-6 font-mono text-label'
          />
        )
      case 'space':
        return (
          <CrmLinkEdit
            accountId={a.id}
            field='supabase_space_id'
            value={a.supabase_space_id}
            ariaLabel={`Platform space id for ${a.name}`}
            inputClassName='h-6 font-mono text-label'
          />
        )
      case 'tags':
        return (
          <span className='flex flex-wrap gap-1'>
            {a.tags.slice(0, 3).map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
            {a.tags.length > 3 && <span className='text-label text-muted-foreground'>+{a.tags.length - 3}</span>}
          </span>
        )
    }
  }

  return (
    <div
      className='grid items-center gap-2 border-b border-border-light px-2 py-1.5 text-body-sm transition-colors last:border-0 hover:bg-accent-tint'
      style={{ gridTemplateColumns: template }}>
      {/* `pl-2` matches the header's own inset - see CRM_GRID. */}
      <div className='flex min-w-0 items-center gap-1.5 pl-2'>
        <button type='button' onClick={() => onOpen(a.id)} className='min-w-0 text-left outline-none'>
          <span className='line-clamp-1 font-medium text-text hover:text-accent'>{a.name}</span>
        </button>
        {a.website && (
          <a
            href={a.website}
            target='_blank'
            rel='noreferrer noopener'
            onClick={(e) => e.stopPropagation()}
            title={a.website}
            aria-label={`Open ${a.name} website`}
            className='shrink-0 text-fg-4 hover:text-accent'>
            <ExternalLink className='size-3' />
          </a>
        )}
      </div>
      <CrmStatusSelect
        value={a.status}
        onChange={(s) => void setCrmAccountStatus(a.id, s)}
        className={cn(inlineSelectCls, 'w-full')}
      />
      <UserPicker value={a.owner} onChange={(id) => void upsertCrmAccount({ id: a.id, owner: id ?? '' })} />
      {columns.map((key) => (
        <div
          key={key}
          className={cn(
            'min-w-0 text-muted-foreground',
            CRM_COLUMNS.find((c) => c.key === key)?.numeric && 'text-right [&>span]:items-end',
          )}>
          {cell(key)}
        </div>
      ))}
      <button
        type='button'
        onClick={onDelete}
        title={`Delete ${a.name}`}
        aria-label={`Delete ${a.name}`}
        className='justify-self-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger'>
        <Trash2 className='size-3.5' />
      </button>
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'

/**
 * Create a company, and its first contact in the same breath. An account with nobody to call is not
 * refused by the server (the import and hand entry both need to create the company first), but this
 * is the affordance that stops it happening by accident.
 */
function NewAccountDialog({
  open,
  existingIds,
  onClose,
}: {
  open: boolean
  existingIds: string[]
  onClose: () => void
}) {
  const navigate = useNavigate()
  const [name, setName] = React.useState('')
  const [website, setWebsite] = React.useState('')
  const [contactName, setContactName] = React.useState('')
  const [contactEmail, setContactEmail] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  const id = slugify(name)
  const duplicate = !!id && existingIds.includes(id)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return setError('A company name is required (it seeds the id).')
    if (duplicate) return setError(`An account with id "${id}" already exists.`)
    setSaving(true)
    const write = async () => {
      await upsertCrmAccount({ id, name: name.trim(), website: website.trim(), owner: getActiveUserId() ?? undefined })
      if (contactName.trim()) {
        await upsertCrmContact({
          id: `${id}-${slugify(contactName)}`,
          account_id: id,
          name: contactName.trim(),
          email: contactEmail.trim(),
          is_primary: true,
        })
      }
    }
    void write()
      .then(() => {
        onClose()
        void navigate({ to: '/crm/$id', params: { id } })
      })
      .catch((err) => {
        setSaving(false)
        setError(String(err))
      })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-w-md'>
        <DialogTitle>New account</DialogTitle>
        <DialogDescription>
          A company, and the first person to talk to there. Both are yours - no import owns a
          hand-created row.
        </DialogDescription>
        <form onSubmit={submit} className='mt-3 flex flex-col gap-3'>
          <label className='flex flex-col gap-1 text-label text-muted-foreground'>
            Company name {id && <code className='text-fg-4'>id: {id}</code>}
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              placeholder='e.g. Acme Leeds'
              className={inputCls}
            />
          </label>
          <label className='flex flex-col gap-1 text-label text-muted-foreground'>
            Website
            <input
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder='https://…'
              className={inputCls}
            />
          </label>
          <div className='mt-1 border-t border-border pt-3'>
            <p className='mb-2 text-label text-muted-foreground'>First contact (optional, becomes the primary)</p>
            <div className='grid grid-cols-2 gap-2'>
              <input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                placeholder='Name'
                aria-label='Contact name'
                className={inputCls}
              />
              <input
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder='Email'
                aria-label='Contact email'
                className={inputCls}
              />
            </div>
          </div>
          {error && <p className='text-label text-danger'>{error}</p>}
          <div className='mt-1 flex items-center justify-end gap-2'>
            <Button type='button' variant='ghost' size='sm' onClick={onClose}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={saving || !id || duplicate}>
              {saving ? 'Saving…' : 'Create account'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
