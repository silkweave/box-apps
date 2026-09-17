import { SmilePlus } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@silkweave/box-ui'
import { cn } from '../../../lib/utils.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { userName } from '../../../user-types.ts'
import type { ChatReactionGroup } from '../lib/chatTypes.ts'

/**
 * The reaction surface for one message (chat Track 10): the pills it already has, plus a way to
 * add one.
 *
 * The palette is duplicated here rather than imported from `@silkweave/box-core`, for the same reason the
 * mention ranking is - the web bundle does not depend on core. It is asserted against the server's
 * list by the server itself: an emoji this build offers and the server does not is refused with a
 * 400, so the two cannot drift silently into a picker full of dead buttons.
 *
 * ORDER IS THE SERVER'S order (`CHAT_REACTION_EMOJI`), and pills render in it rather than by count.
 * A row that re-sorts as counts change moves the target out from under a finger already on its way
 * down, and a mis-click here shows up in somebody else's channel.
 */
const PALETTE = ['👍', '🎉', '❤️', '😂', '👀', '✅', '🚀', '🔥', '🙏', '💯', '😮', '😢'] as const

interface ReactionsProps {
  reactions: ChatReactionGroup[] | undefined
  /** Who is looking - the pill is "mine" when this id is in its `users`. Null when nobody is
   *  signed in, in which case nothing is reactable. */
  currentUserId: string | null
  onReact: (emoji: string, on: boolean) => Promise<void>
  className?: string
}

/** Toggle one reaction, swallowing failures. A reaction is a gesture, not a submission: the
 *  server's state is unchanged on error, the next frame or history fetch re-renders the truth, and
 *  an error banner hanging under somebody else's message costs more than the failed ack did. */
function useToggle(currentUserId: string | null, onReact: (emoji: string, on: boolean) => Promise<void>) {
  // Tracked so a click cannot be double-fired while its round trip is open. Per-emoji rather than
  // one flag for the row: reacting 👍 must not freeze 🎉 next to it.
  const [pending, setPending] = useState<string | null>(null)
  const toggle = useCallback(
    async (emoji: string, on: boolean): Promise<void> => {
      if (currentUserId === null) return
      setPending(emoji)
      try {
        await onReact(emoji, on)
      } catch {
        // Deliberately silent - see above.
      } finally {
        setPending(null)
      }
    },
    [currentUserId, onReact],
  )
  return { pending, toggle }
}

/**
 * The pills a message already has. Nothing else - the ADD affordance moved into the row's hover
 * toolbar on 2026-09-04 (see `ReactionPicker` and MessageRow), so a message with no reactions
 * renders no row at all and costs no vertical space.
 */
export function Reactions({ reactions, currentUserId, onReact, className }: ReactionsProps) {
  const groups = reactions ?? []
  const { pending, toggle } = useToggle(currentUserId, onReact)
  const canReact = currentUserId !== null
  if (groups.length === 0) return null

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {groups.map((group) => (
        <ReactionPill
          key={group.emoji}
          group={group}
          mine={currentUserId !== null && group.users.includes(currentUserId)}
          disabled={!canReact || pending === group.emoji}
          onClick={() =>
            void toggle(group.emoji, !(currentUserId !== null && group.users.includes(currentUserId)))
          }
        />
      ))}
    </div>
  )
}

interface ReactionPickerProps {
  reactions: ChatReactionGroup[] | undefined
  currentUserId: string | null
  onReact: (emoji: string, on: boolean) => Promise<void>
  /** Classes for the trigger, so the caller (the hover toolbar) owns its own button shape. */
  className?: string
  /** Told when the popover opens or closes, so a toolbar that is only alive on hover can pin
   *  itself open while the palette is on screen. */
  onOpenChange?: (open: boolean) => void
}

/** The palette, as a popover trigger. Rendered inside the message row's hover toolbar. */
export function ReactionPicker({ reactions, currentUserId, onReact, className, onOpenChange }: ReactionPickerProps) {
  const groups = reactions ?? []
  const [open, setOpen] = useState(false)
  const { toggle } = useToggle(currentUserId, onReact)
  if (currentUserId === null) return null

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        onOpenChange?.(next)
      }}>
      <PopoverTrigger className={className} aria-label='Add a reaction' title='Add a reaction'>
        <SmilePlus className='size-3.5' aria-hidden />
      </PopoverTrigger>
      <PopoverContent align='start' side='top' className='w-auto max-w-[13rem] flex-row flex-wrap gap-1 p-1.5'>
        {PALETTE.map((emoji) => {
          const group = groups.find((g) => g.emoji === emoji)
          const mine = group !== undefined && group.users.includes(currentUserId)
          return (
            <button
              key={emoji}
              type='button'
              // The picker TOGGLES rather than only adds: picking the one you already used is
              // otherwise a click that does nothing, which reads as a broken button.
              onClick={() => {
                setOpen(false)
                onOpenChange?.(false)
                void toggle(emoji, !mine)
              }}
              className={cn(
                'flex size-7 items-center justify-center rounded text-base hover:bg-muted',
                mine && 'bg-accent/15 ring-1 ring-accent',
              )}
              aria-label={emoji}
              aria-pressed={mine}>
              {emoji}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

function ReactionPill({
  group,
  mine,
  disabled,
  onClick,
}: {
  group: ChatReactionGroup
  mine: boolean
  disabled: boolean
  onClick: () => void
}) {
  const { data: users } = useUsersData()
  // Names, not ids, and resolved at render time so a rename is reflected without touching the
  // stored rows - the same rule `senderName` deliberately does NOT follow (a message records the
  // name it was written under; a reaction is live state).
  const who = group.users
    .map((id) => users?.find((u) => u.id === id))
    .map((u, i) => (u ? userName(u) : group.users[i]))
    .join(', ')

  return (
    <button
      type='button'
      disabled={disabled}
      onClick={onClick}
      aria-pressed={mine}
      title={`${who} reacted with ${group.emoji}`}
      className={cn(
        'flex h-5 items-center gap-1 rounded-full border px-1.5 text-label tabular-nums transition-colors disabled:opacity-60',
        mine
          ? 'border-accent bg-accent/15 text-foreground'
          : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
      )}>
      <span className='text-[0.8rem] leading-none'>{group.emoji}</span>
      <span>{group.count}</span>
    </button>
  )
}
