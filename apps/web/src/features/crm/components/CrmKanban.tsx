// The pipeline: one column per account status, cards you drag between them. The structure (drag
// context, columns, the card frame and its grip) is `components/board/BoardKanban`; what lives here
// is the two things that are actually about accounts - what a card SHOWS and what a drop MEANS.
//
// Dragging writes `status` through the ordinary `crm-account-upsert` path - status is Box-owned, so
// moving a card IS a human edit and needs no new tool, no new permission and no new column.

import { CircleUser, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar, Money, formatCurrency } from '@silkweave/box-ui'
import { BoardKanban, type KanbanColumn } from '@silkweave/box-ui/board'
import { CRM_STATUS_UI } from './crmStatus.tsx'
import {
  CRM_ACCOUNT_STATUS_LABEL,
  primaryContact,
  weightedMrr,
  type CrmAccount,
  type CrmAccountStatus,
} from '../crm-types.ts'
import { CRM_TERMINAL_STATUSES, isActionOverdue } from '../lib/crmView.ts'
import { setCrmAccountStatus } from '../lib/useCrmData.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { userName, type User } from '../../../user-types.ts'

export function CrmKanban({
  accounts,
  columns,
  onOpen,
}: {
  /** Already filtered and sorted by the view - the board only buckets by status. */
  accounts: CrmAccount[]
  columns: CrmAccountStatus[]
  onOpen: (id: string) => void
}) {
  const { data: users } = useUsersData()
  const kanbanColumns: KanbanColumn[] = columns.map((status) => ({
    key: status,
    label: CRM_ACCOUNT_STATUS_LABEL[status],
    icon: CRM_STATUS_UI[status].icon,
    color: CRM_STATUS_UI[status].color,
    terminal: CRM_TERMINAL_STATUSES.includes(status),
  }))

  return (
    <BoardKanban
      items={accounts}
      columns={kanbanColumns}
      columnOf={(a) => a.status}
      idOf={(a) => a.id}
      cardLabel={(a) => a.name}
      onDrop={(a, status) => void setCrmAccountStatus(a.id, status as CrmAccountStatus)}
      // Column total, so the board answers "how much is sitting in Proposal" without a spreadsheet.
      renderColumnBadge={(_status, held) => {
        const total = held.reduce((sum, a) => sum + (a.mrr_usd ?? 0), 0)
        return total > 0 ? <Money value={total} /> : null
      }}
      renderCard={(a) => <CardBody account={a} users={users ?? []} onOpen={onOpen} />}
    />
  )
}

/**
 * One account, as a card. Shows what someone working the pipeline needs at a glance and nothing
 * else: company, who to call, the money, what happens next and when, and whose job it is. The next
 * action is clamped to two lines - the Lark data has some that run a paragraph - with the full text
 * on hover.
 */
function CardBody({ account: a, users, onOpen }: { account: CrmAccount; users: User[]; onOpen: (id: string) => void }) {
  const primary = primaryContact(a)
  const owner = a.owner ? users.find((u) => u.id === a.owner) : undefined
  const weighted = weightedMrr(a)
  const overdue = isActionOverdue(a)

  return (
    <>
      <div className='flex items-start gap-1'>
        <button type='button' onClick={() => onOpen(a.id)} className='min-w-0 flex-1 text-left outline-none'>
          <span className='line-clamp-1 font-medium text-text hover:text-accent'>{a.name}</span>
        </button>
        {owner ? (
          <span title={userName(owner)} className='shrink-0'>
            <Avatar user={owner} size='xs' />
          </span>
        ) : (
          <CircleUser className='size-4 shrink-0 text-fg-4' aria-label='Unowned' />
        )}
      </div>

      <p className='mt-0.5 line-clamp-1 text-label text-muted-foreground'>
        {primary ? (
          <span className='inline-flex items-center gap-1'>
            {primary.name}
            {a.contacts.length > 1 && (
              <span className='inline-flex items-center gap-0.5'>
                <Users className='size-3' />
                {a.contacts.length}
              </span>
            )}
          </span>
        ) : (
          <span className='text-warning'>no contacts yet</span>
        )}
      </p>

      <div className='mt-1.5 flex items-center gap-2 text-label tabular-nums'>
        <Money value={a.mrr_usd} className='font-medium text-text' />
        {a.close_probability != null && a.close_probability < 100 && (
          <span className='text-muted-foreground' title={weighted != null ? `weighted ${formatCurrency(weighted)}/mo` : undefined}>
            {a.close_probability}%
          </span>
        )}
      </div>

      {(a.next_action || a.next_action_at) && (
        <div className='mt-1.5 border-t border-border-light pt-1.5'>
          {a.next_action && (
            <p className='line-clamp-2 text-label leading-relaxed text-muted-foreground' title={a.next_action}>
              {a.next_action}
            </p>
          )}
          {a.next_action_at && (
            <p className={cn('mt-0.5 text-label tabular-nums', overdue ? 'text-danger' : 'text-fg-4')}>{a.next_action_at}</p>
          )}
        </div>
      )}
    </>
  )
}
