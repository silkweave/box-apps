import * as React from 'react'
import { InlineEdit } from '@silkweave/box-ui'
import { saveCrmAccountLink, type CrmAccountUpsert } from '../lib/useCrmData.ts'

/** The three account fields that name a row in ANOTHER system. Only these are duplicate-guarded. */
export type CrmLinkField = 'stripe_customer_id' | 'supabase_space_id' | 'whatsapp_group_jid'

/**
 * One external link, editable in place - on the account page and, since it is the same field, in a
 * CRM list cell. Shared rather than duplicated because the interesting half is not the input, it is
 * what happens when the server REFUSES the value: `InlineEdit` is uncontrolled, so a rejected write
 * would leave the rejected text sitting in the box looking saved. The nonce in the key remounts the
 * field on refusal, which restores whatever the account actually holds.
 */
export function CrmLinkEdit({
  accountId,
  field,
  value,
  placeholder,
  ariaLabel,
  className,
  inputClassName,
}: {
  accountId: string
  field: CrmLinkField
  value: string | null
  placeholder?: string
  ariaLabel: string
  className?: string
  inputClassName?: string
}) {
  const [nonce, setNonce] = React.useState(0)
  const current = value ?? ''

  return (
    <InlineEdit
      key={`${current}:${nonce}`}
      defaultValue={current}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className={className}
      inputClassName={inputClassName}
      onCommit={(v) => {
        if (v === current) return
        void saveCrmAccountLink(accountId, { [field]: v } as Partial<CrmAccountUpsert>).then((ok) => {
          if (!ok) setNonce((n) => n + 1)
        })
      }}
    />
  )
}
