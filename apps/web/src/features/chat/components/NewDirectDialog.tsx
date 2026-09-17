import { useMemo, useState } from 'react'
import { Avatar, Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, Button } from '@silkweave/box-ui'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { useAuth } from '../../../lib/useAuth.tsx'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'
import { userName, type User } from '../../../user-types.ts'

interface NewDirectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Given a `users.id`, open (or reopen) the DM with that person. Idempotent server-side. */
  onOpen: (userId: string) => Promise<void>
}

/**
 * Start a direct message: a person picker over the SAME directory the @-autocomplete resolves.
 *
 * Internal users only, and that is not a policy decision made here - `useUsersData` filters
 * Revoked accounts are dropped:
 * a DM with somebody whose sessions are dead is a conversation with nobody.
 *
 * There is no "does a DM already exist" check in front of the pick, on purpose. The room's slug
 * derives from the sorted pair of user ids, so opening is idempotent by construction - the second
 * open finds the first room. A client-side existence check would be a second, weaker copy of a
 * rule the schema already enforces.
 */
export function NewDirectDialog({ open, onOpenChange, onOpen }: NewDirectDialogProps) {
  const { data: users } = useUsersData()
  const { principal } = useAuth()
  const selfId = principal?.id ?? getActiveUserId()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const candidates = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (users ?? [])
      .filter((u) => u.id !== selfId && u.status !== 'revoked')
      .filter((u) => needle === '' || u.id.toLowerCase().includes(needle) || userName(u).toLowerCase().includes(needle))
      .sort((a, b) => userName(a).localeCompare(userName(b)))
  }, [users, selfId, query])

  async function pick(user: User): Promise<void> {
    if (busy !== null) return
    setBusy(user.id)
    setError(null)
    try {
      await onOpen(user.id)
      setQuery('')
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open that conversation')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className='flex flex-col gap-1'>
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>
            A direct message is private to the two of you. It cannot be renamed, made public, or left.
          </DialogDescription>
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Search people'
          autoFocus
          className='h-8 w-full rounded-md border border-border bg-bg px-2 text-body-sm text-text outline-none transition-colors placeholder:text-fg-4 hover:border-accent/40 focus:border-accent'
        />

        <div className='flex max-h-64 flex-col overflow-y-auto'>
          {candidates.length === 0 && (
            <p className='px-1 py-2 text-body-sm text-muted-foreground'>
              {users === null ? 'Loading people…' : 'Nobody matches that.'}
            </p>
          )}
          {candidates.map((u) => (
            <button
              key={u.id}
              type='button'
              disabled={busy !== null}
              onClick={() => void pick(u)}
              className='flex items-center gap-2 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-surface disabled:opacity-60'
            >
              <Avatar user={u} size='sm' />
              <span className='truncate text-body-sm text-text'>{userName(u)}</span>
              <span className='truncate text-label text-muted-foreground'>{u.id}</span>
              {busy === u.id && <span className='ml-auto text-label text-muted-foreground'>Opening…</span>}
            </button>
          ))}
        </div>

        {error && <p className='text-label text-danger'>{error}</p>}

        <div className='flex justify-end'>
          <DialogClose render={<Button variant='ghost' size='sm'>Cancel</Button>} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
