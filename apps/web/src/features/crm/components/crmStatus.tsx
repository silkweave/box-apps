import { cn } from '@/lib/utils'
import {
  Archive,
  CalendarCheck,
  CalendarPlus,
  CalendarClock,
  CircleHelp,
  CircleSlash,
  CircleX,
  FileText,
  Handshake,
  MonitorPlay,
  Rocket,
  Snowflake,
  Star,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import {
  CRM_ACCOUNT_STATUSES,
  CRM_ACCOUNT_STATUS_LABEL,
  CRM_CONTACT_ROLES,
  CRM_CONTACT_ROLE_LABEL,
  type CrmAccountStatus,
  type CrmContactRole,
} from '../crm-types.ts'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@silkweave/box-ui'

// Self-contained on purpose: this mirrors the planning selects' icon+tone SHAPE without importing
// their vocabulary. An account status and a task status are different lifecycles that happen to
// render alike - coupling them would make every future pipeline stage a planning-status question.

/** Per-status icon + the text color class for its semantic tone. */
export const CRM_STATUS_UI: Record<CrmAccountStatus, { icon: LucideIcon; color: string }> = {
  stale: { icon: Snowflake, color: 'text-muted-foreground' },
  meeting_requested: { icon: CalendarPlus, color: 'text-muted-foreground' },
  meeting_booked: { icon: CalendarCheck, color: 'text-accent' },
  demo: { icon: MonitorPlay, color: 'text-accent' },
  proposal: { icon: FileText, color: 'text-info' },
  confirmed: { icon: Handshake, color: 'text-success' },
  customer: { icon: Star, color: 'text-success' },
  onboarding: { icon: Rocket, color: 'text-success' },
  at_risk: { icon: TriangleAlert, color: 'text-warning' },
  revisit: { icon: CalendarClock, color: 'text-info' },
  churned: { icon: CircleX, color: 'text-danger' },
  lost: { icon: CircleSlash, color: 'text-muted-foreground' },
  archived: { icon: Archive, color: 'text-muted-foreground' },
}

/**
 * The status vocabulary is Box-owned and it has been rewritten - `engaged` and `trial` were real
 * values once, and rows carrying them are still in the warehouse. `CRM_STATUS_UI[status]` on a
 * value the map has never heard of destructures `undefined` and takes the ENTIRE CRM view down
 * with it, which is how one legacy row in one account becomes a blank page (seen 2026-09-02 on
 * dev, where `engaged` x10 and `trial` x1 survive the reseed).
 *
 * So every lookup driven by DATA goes through here rather than indexing the record directly. The
 * unknown status renders in the muted tone with a question-mark icon and its raw value as the
 * label - visible, honest, and nothing to chase: a status nobody can name should LOOK like one,
 * not like an outage. Lookups driven by our own vocabulary (a kanban's column list) can still
 * index directly; those are exhaustive by construction and typechecked.
 */
export function crmStatusUi(status: string): { icon: LucideIcon; color: string; label: string } {
  const known = (CRM_STATUS_UI as Record<string, { icon: LucideIcon; color: string } | undefined>)[status]
  if (known === undefined) return { icon: CircleHelp, color: 'text-muted-foreground', label: status }
  return { ...known, label: CRM_ACCOUNT_STATUS_LABEL[status as CrmAccountStatus] }
}

/** Icon + colored label for a status, used inside the trigger and each option. */
export function StatusLabel({ status }: { status: CrmAccountStatus }) {
  // Typed as a known status, but the VALUE arrives from a warehouse row - see `crmStatusUi`.
  const { icon: Icon, color, label } = crmStatusUi(status)
  return (
    <span className={cn('inline-flex items-center gap-1.5', color)}>
      <Icon className='size-3.5 shrink-0' />
      <span className='truncate font-medium'>{label}</span>
    </span>
  )
}

/** Controlled account-status select (base-ui) - an icon + semantic color per status. */
export function CrmStatusSelect({
  value,
  onChange,
  className,
}: {
  value: CrmAccountStatus
  onChange: (status: CrmAccountStatus) => void
  className?: string
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as CrmAccountStatus)}
      items={CRM_ACCOUNT_STATUSES.map((s) => ({ value: s, label: CRM_ACCOUNT_STATUS_LABEL[s] }))}>
      <SelectTrigger aria-label='Status' className={className}>
        <SelectValue>{(v) => <StatusLabel status={v as CrmAccountStatus} />}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {CRM_ACCOUNT_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            <StatusLabel status={s} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Controlled contact-role select. Plain text - a role is not a lifecycle, so it gets no tone. */
export function CrmRoleSelect({
  value,
  onChange,
  className,
}: {
  value: CrmContactRole
  onChange: (role: CrmContactRole) => void
  className?: string
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onChange(next as CrmContactRole)}
      items={CRM_CONTACT_ROLES.map((r) => ({ value: r, label: CRM_CONTACT_ROLE_LABEL[r] }))}>
      <SelectTrigger aria-label='Role' className={className}>
        <SelectValue>{(v) => <span className='truncate'>{CRM_CONTACT_ROLE_LABEL[v as CrmContactRole]}</span>}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {CRM_CONTACT_ROLES.map((r) => (
          <SelectItem key={r} value={r}>
            {CRM_CONTACT_ROLE_LABEL[r]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// `Money`, `Percent` and `formatCurrency` used to live here. They are `components/ui/Figures.tsx` now
// (2026-08-12): the grid footer aggregates money on three boards, and nothing about drawing a
// quantity was ever CRM vocabulary.
