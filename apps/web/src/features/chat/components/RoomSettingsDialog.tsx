import { useEffect, useState } from 'react'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, Button } from '@silkweave/box-ui'
import { RoomIconPicker } from './RoomIconPicker.tsx'
import type { RoomIconName } from '../lib/chatRoomIcons.ts'
import type { ChatRoom, ChatRoomDeleteResult } from '../lib/chatTypes.ts'
import type { ChatRoomUpdateInput } from '../lib/useChatData.ts'

/** Mirrors the server's `@Matches` on ChatRoomUpdateInputDto (the same pattern NewRoomDialog
 *  mirrors) - a typo is a hint under the field rather than a 400 after the round trip. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

interface RoomSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  room: ChatRoom
  /** Resolves to the new summary. Only CHANGED fields are sent, so an untouched dialog that is
   *  saved anyway is a no-op patch rather than a rewrite of every column. */
  onSave: (patch: ChatRoomUpdateInput) => Promise<ChatRoom>
  /** `confirm` is what the human typed, passed through - the server checks it repeats the slug. */
  onDelete: (confirm: string) => Promise<ChatRoomDeleteResult>
}

/**
 * Room settings: name, topic, icon, and the way to destroy the room.
 *
 * One dialog for all four because they are one mental act ("this channel is wrong"), and because
 * two of them carry consequences that are better read side by side than discovered one at a time:
 * a RENAME changes the room's address (every saved link stops resolving), and delete is the only
 * irreversible call in chat.
 *
 * Delete lives behind a second pane rather than a button in this footer. The pane makes you type
 * the slug - which the server demands anyway (`confirm`) - so the guard is the same one the API has
 * rather than a client-side ceremony, and the settings footer never puts "Save" next to a button
 * that purges the room.
 */
export function RoomSettingsDialog({ open, onOpenChange, room, onSave, onDelete }: RoomSettingsDialogProps) {
  const [name, setName] = useState(room.name ?? '')
  const [slug, setSlug] = useState(room.slug)
  const [topic, setTopic] = useState(room.topic ?? '')
  const [icon, setIcon] = useState<RoomIconName | null>(room.icon as RoomIconName | null)
  const [confirming, setConfirming] = useState(false)
  const [confirmSlug, setConfirmSlug] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Re-seed from the room whenever the dialog is opened, and whenever the room changes underneath
  // it (somebody else renamed it, or this tab switched rooms with the dialog mounted). Without
  // this, a second open shows the first open's abandoned edits as if they were the room's state.
  useEffect(() => {
    if (!open) return
    setName(room.name ?? '')
    setSlug(room.slug)
    setTopic(room.topic ?? '')
    setIcon(room.icon as RoomIconName | null)
    setConfirming(false)
    setConfirmSlug('')
    setError(null)
  }, [open, room.name, room.slug, room.topic, room.icon])

  const slugValid = SLUG_RE.test(slug)
  const renaming = slug !== room.slug
  const dirty =
    renaming ||
    name.trim() !== (room.name ?? '') ||
    topic !== (room.topic ?? '') ||
    icon !== room.icon

  async function save() {
    if (!slugValid || !dirty || busy) return
    setBusy(true)
    setError(null)
    try {
      // Only what changed. `name`, `topic` and `icon` send '' to CLEAR - the wire's way of saying
      // null, since an omitted field has to keep meaning "leave it alone". Clearing the name is
      // therefore a normal save, and drops the room back to being called by its address.
      await onSave({
        ...(renaming ? { slug } : {}),
        ...(name.trim() !== (room.name ?? '') ? { name: name.trim() } : {}),
        ...(topic !== (room.topic ?? '') ? { topic } : {}),
        ...(icon !== room.icon ? { icon: icon ?? '' } : {}),
      })
      onOpenChange(false)
    } catch (cause) {
      // A slug that collided is a 409 and a DM is a 400 - both belong under the fields rather
      // than in a toast that outlives the dialog.
      setError(cause instanceof Error ? cause.message : 'Failed to save the room')
    } finally {
      setBusy(false)
    }
  }

  async function destroy() {
    if (confirmSlug !== room.slug || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await onDelete(confirmSlug)
      // `pending` means nothing was deleted: an approval card went into the room instead. A browser
      // session never gets it, but reporting it as done would be a lie if that ever changed.
      if (result.status === 'pending') {
        setError(result.detail)
        return
      }
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to delete the room')
    } finally {
      setBusy(false)
    }
  }

  const field =
    'h-8 w-full rounded-md border border-border bg-bg px-2 text-body-sm text-text outline-none transition-colors placeholder:text-fg-4 hover:border-accent/40 focus:border-accent'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {confirming ? (
          <>
            <div className='flex flex-col gap-1'>
              <DialogTitle>Delete #{room.slug}?</DialogTitle>
              <DialogDescription>
                This destroys the room and everything in it - every message, thread, reaction and
                attachment - for everyone. It cannot be undone, and it is not the same as leaving:
                leaving keeps the history and only removes the audience.
              </DialogDescription>
            </div>

            <label className='flex flex-col gap-1'>
              <span className='text-label text-muted-foreground'>
                Type <span className='text-text'>{room.slug}</span> to confirm
              </span>
              <input
                value={confirmSlug}
                onChange={(e) => setConfirmSlug(e.target.value)}
                placeholder={room.slug}
                className={field}
                autoFocus
              />
            </label>

            {error && <p className='text-label text-danger'>{error}</p>}

            <div className='flex justify-end gap-2'>
              <Button variant='ghost' size='sm' disabled={busy} onClick={() => setConfirming(false)}>
                Back
              </Button>
              <Button
                variant='destructive'
                size='sm'
                disabled={confirmSlug !== room.slug || busy}
                onClick={() => void destroy()}>
                {busy ? 'Deleting…' : 'Delete room'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className='flex flex-col gap-1'>
              <DialogTitle>Room settings</DialogTitle>
              <DialogDescription>
                Anyone on the team can change these. The name is what people see; the address is
                what links and tools use, so changing it breaks every saved link.
              </DialogDescription>
            </div>

            <label className='flex flex-col gap-1'>
              <span className='text-label text-muted-foreground'>Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                // The placeholder IS the fallback: an empty name means the address is the name, so
                // showing the slug here is literally what the room will be called.
                placeholder={room.slug}
                maxLength={64}
                className={field}
                autoFocus
              />
            </label>

            <label className='flex flex-col gap-1'>
              <span className='text-label text-muted-foreground'>Address</span>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder='deploys'
                className={field}
              />
              {slug !== '' && !slugValid ? (
                <span className='text-label text-danger'>
                  Lowercase letters, numbers and dashes; no leading or trailing dash.
                </span>
              ) : renaming ? (
                <span className='text-label text-danger'>
                  Changing the address breaks every saved link and every tool call that named
                  #{room.slug}. Rename the display name instead if you only want it to read
                  differently.
                </span>
              ) : (
                <span className='text-label text-muted-foreground'>
                  How links and tools name this room: /chat/{slug || room.slug}
                </span>
              )}
            </label>

            <label className='flex flex-col gap-1'>
              <span className='text-label text-muted-foreground'>Topic</span>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder='What this room is for'
                maxLength={200}
                className={field}
              />
            </label>

            <div className='flex flex-col gap-1'>
              <span className='text-label text-muted-foreground'>Icon</span>
              <RoomIconPicker value={icon} onChange={setIcon} disabled={busy} />
            </div>

            {error && <p className='text-label text-danger'>{error}</p>}

            <div className='flex items-center justify-between gap-2'>
              <Button variant='ghost' size='sm' className='text-destructive' onClick={() => setConfirming(true)}>
                Delete room…
              </Button>
              <div className='flex gap-2'>
                <DialogClose render={<Button variant='ghost' size='sm'>Cancel</Button>} />
                <Button size='sm' disabled={!slugValid || !dirty || busy} onClick={() => void save()}>
                  {busy ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
