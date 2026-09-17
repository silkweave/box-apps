import { useState } from 'react'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, Button } from '@silkweave/box-ui'
import { RoomIconPicker } from './RoomIconPicker.tsx'
import { roomSlugFrom } from '../lib/chatRoomLabel.ts'
import type { RoomIconName } from '../lib/chatRoomIcons.ts'

/** Mirrors the server's `@Matches` on ChatRoomCreateInputDto - reject here so a typo is a hint under
 *  the field rather than a 400 after the round trip. Keep the two in step. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

interface NewRoomDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (input: {
    slug: string
    topic?: string
    icon?: RoomIconName
    name?: string
  }) => Promise<void>
}

export function NewRoomDialog({ open, onOpenChange, onCreate }: NewRoomDialogProps) {
  const [name, setName] = useState('')
  /**
   * The address, and whether the human has taken it over. Until they touch it, it FOLLOWS the name
   * (`roomSlugFrom`); the moment they edit it, it stops - a field that keeps overwriting what you
   * typed is the worse failure, and there is no way back from it inside one dialog.
   */
  const [slugTouched, setSlugTouched] = useState(false)
  const [slugEdit, setSlugEdit] = useState('')
  const [topic, setTopic] = useState('')
  // Null until picked, and the server's default is the same absence - so creating without touching
  // the grid stores no icon at all rather than the string 'hash'.
  const [icon, setIcon] = useState<RoomIconName | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const slug = slugTouched ? slugEdit : roomSlugFrom(name)
  const slugValid = SLUG_RE.test(slug)
  // Worth saying out loud, and only when it is actually true: the name will not be the address.
  const derived = !slugTouched && name.trim() !== '' && slug !== name.trim()

  async function create() {
    if (!slugValid || busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate({
        slug,
        // Only when it says something the slug does not. "deploys" typed into the name field with
        // the address following it is not a display name, it is the same word stored twice.
        ...(name.trim() !== '' && name.trim() !== slug ? { name: name.trim() } : {}),
        topic: topic.trim() || undefined,
        ...(icon === null ? {} : { icon }),
      })
      setName('')
      setSlugTouched(false)
      setSlugEdit('')
      setTopic('')
      setIcon(null)
      onOpenChange(false)
    } catch (cause) {
      // The store refuses a duplicate slug with a 409; surface it rather than leaving the dialog
      // looking like it did nothing.
      setError(cause instanceof Error ? cause.message : 'Failed to create the room')
    } finally {
      setBusy(false)
    }
  }

  const field = 'h-8 w-full rounded-md border border-border bg-bg px-2 text-body-sm text-text outline-none transition-colors placeholder:text-fg-4 hover:border-accent/40 focus:border-accent'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <div className='flex flex-col gap-1'>
          <DialogTitle>New room</DialogTitle>
          <DialogDescription>
            The name is what people see; the address is what links and tools use, and it follows the
            name until you edit it. Public rooms are open for anyone on the team to join; a private
            room is visible only to its members, admins included.
          </DialogDescription>
        </div>

        <label className='flex flex-col gap-1'>
          <span className='text-label text-muted-foreground'>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='Deploys'
            maxLength={64}
            className={field}
            autoFocus
          />
        </label>

        <label className='flex flex-col gap-1'>
          <span className='text-label text-muted-foreground'>Address</span>
          <input
            value={slug}
            onChange={(e) => {
              setSlugTouched(true)
              setSlugEdit(e.target.value.toLowerCase())
            }}
            placeholder='deploys'
            className={field}
          />
          {slug !== '' && !slugValid ? (
            <span className='text-label text-danger'>Lowercase letters, numbers and dashes; no leading or trailing dash.</span>
          ) : (
            <span className='text-label text-muted-foreground'>
              {derived ? 'Follows the name. ' : ''}How links and tools name this room: /chat/{slug || '…'}
            </span>
          )}
        </label>

        <label className='flex flex-col gap-1'>
          <span className='text-label text-muted-foreground'>Topic (optional)</span>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder='What this room is for'
            maxLength={200}
            className={field}
          />
        </label>

        <div className='flex flex-col gap-1'>
          <span className='text-label text-muted-foreground'>Icon (optional)</span>
          <RoomIconPicker value={icon} onChange={setIcon} disabled={busy} />
        </div>

        {error && <p className='text-label text-danger'>{error}</p>}

        <div className='flex justify-end gap-2'>
          <DialogClose render={<Button variant='ghost' size='sm'>Cancel</Button>} />
          <Button size='sm' disabled={!slugValid || busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create room'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
