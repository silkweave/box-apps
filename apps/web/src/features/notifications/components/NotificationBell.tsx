import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { AtSign, Bell, BellRing, MessageSquare, Siren, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@silkweave/box-ui'
import { useNotifications, type NotificationItem } from '../lib/useNotifications.ts'
import { usePush } from '../lib/push.ts'

/**
 * The top-bar notification bell.
 *
 * It is app-wide chrome deliberately: chat's own unread badges live in the chat sidebar and only
 * exist while you are looking at /chat, which is precisely when you do not need to be told. This
 * is the surface for everything that happened while you were somewhere else.
 *
 * Three strata in one list, newest first, distinguished by icon and by weight:
 *   @  a mention - someone addressed you. Marked out, and the only chat item that counts on the badge.
 *   ▣  a message in a room you are subscribed to - context, never a badge.
 *   ◆  a warehouse alert - the automation spine's own feed (github, reddit, x, run errors).
 *
 * The badge deliberately does NOT count unread messages: the chat sidebar already owns that number,
 * and two badges counting overlapping things is how you end up with two numbers that are both
 * right and disagree.
 */
export function NotificationBell() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const { data, badge, markAllSeen, dismiss, clearAll } = useNotifications(true)
  // Push is opt-in per browser, per user, revocable right here (Track 9). Mentions only - the
  // same rule as the badge. Hidden entirely when the browser can't or the server isn't configured.
  const push = usePush()

  // Opening the bell IS the acknowledgement. Marking on open rather than behind a "mark all read"
  // button is the honest behaviour - you have now seen them - and it is what stops the badge from
  // becoming background noise you learn to ignore.
  //
  // ONE ack per STUCK badge, though. `markAllSeen` clears optimistically and then reloads, so a
  // badge the server hands straight back drives this effect's own dependency n -> 0 -> n and
  // re-fires it forever: a mutate+refetch loop that flashes the badge and hammers the server,
  // unattended (2026-09-10, a future-dated alert `event_at` that no `Date.now()` watermark could
  // cover). The guard has to hang off the RECONCILED badge, not off the local one - the optimistic
  // zero is indistinguishable from a real one and re-arms anything keyed on the dependency.
  const acking = useRef(false)
  const stuck = useRef(false)
  useEffect(() => {
    if (!open) {
      // A fresh open always gets one more go: whatever was wrong may have been fixed since.
      stuck.current = false
      return
    }
    if (badge === 0 || acking.current || stuck.current) return
    acking.current = true
    void markAllSeen()
      .then((remaining) => {
        // The server kept the badge. Acking again would change nothing, so stop until reopen.
        if (remaining > 0) stuck.current = true
      })
      .catch(() => {
        stuck.current = true
      })
      .finally(() => {
        acking.current = false
      })
  }, [open, badge, markAllSeen])

  const items = data?.items ?? []

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={badge > 0 ? `Notifications (${badge} new)` : 'Notifications'}
        title={badge > 0 ? `${badge} new` : 'Notifications'}
        className={cn(
          'relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground',
          'transition-colors outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-accent/50',
        )}>
        <Bell className='size-4.5' strokeWidth={1.75} />
        {badge > 0 && (
          // A count, not a dot: "3 people need you" and "someone posted" are different urgencies,
          // and the dot the agent toggle uses cannot tell them apart. Caps at 9+ so the pill never
          // changes the button's width.
          <span className='absolute -top-0.5 -right-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] leading-4 font-semibold text-white tabular-nums'>
            {badge > 9 ? '9+' : badge}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent align='end' className='max-h-[min(30rem,70vh)] w-88 overflow-y-auto p-0'>
        <div className='sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-bg px-3 py-2'>
          <p className='flex-1 text-label text-muted-foreground'>Notifications</p>
          {items.length > 0 && (
            <button
              type='button'
              onClick={() => void clearAll().catch(() => undefined)}
              className='-my-0.5 rounded px-1.5 py-0.5 text-label text-muted-foreground transition-colors hover:bg-muted hover:text-text'>
              Clear all
            </button>
          )}
        </div>

        {items.length === 0 ? (
          <p className='px-3 py-8 text-center text-body-sm text-muted-foreground'>Nothing new.</p>
        ) : (
          <ul className='divide-y divide-border'>
            {items.map((item) => (
              <NotificationRow
                key={item.id}
                item={item}
                onOpen={() => {
                  setOpen(false)
                  if (item.roomSlug !== null) {
                    void navigate({ to: '/chat/$room', params: { room: item.roomSlug } })
                  }
                }}
                onDismiss={() => void dismiss(item.id).catch(() => undefined)}
              />
            ))}
          </ul>
        )}

        {push.state !== 'unsupported' && push.state !== 'unconfigured' && (
          <div className='sticky bottom-0 flex items-center gap-2 border-t border-border bg-bg px-3 py-2'>
            <BellRing
              className={cn('size-4 shrink-0', push.state === 'on' ? 'text-accent' : 'text-muted-foreground')}
              strokeWidth={1.75}
            />
            <span
              className='flex-1 truncate text-body-sm text-muted-foreground'
              title='Desktop notifications when someone mentions you. Per browser; mentions only.'>
              {push.state === 'denied' ? 'Push blocked in browser settings' : 'Push mentions to this browser'}
            </span>
            {push.state !== 'denied' && (
              <button
                type='button'
                disabled={push.state === 'busy'}
                onClick={() => (push.state === 'on' ? push.disable() : push.enable())}
                className={cn(
                  '-my-0.5 rounded px-1.5 py-0.5 text-label transition-colors',
                  push.state === 'on'
                    ? 'bg-accent-tint text-accent hover:bg-muted hover:text-muted-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-text',
                )}>
                {push.state === 'on' ? 'On' : push.state === 'busy' ? '…' : 'Off'}
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

const ICON = {
  mention: AtSign,
  message: MessageSquare,
  alert: Siren,
} as const

function NotificationRow({
  item,
  onOpen,
  onDismiss,
}: {
  item: NotificationItem
  onOpen: () => void
  onDismiss: () => void
}) {
  const Icon = ICON[item.kind]
  const mention = item.kind === 'mention'
  // An alert has no room to open; only chat items are navigable.
  const navigable = item.roomSlug !== null

  return (
    <li className={cn('group relative', item.unseen && 'bg-accent-tint/40')}>
      <button
        type='button'
        onClick={onOpen}
        disabled={!navigable}
        className={cn(
          'flex w-full items-start gap-2.5 py-2 pr-8 pl-3 text-left transition-colors',
          navigable ? 'hover:bg-muted/60' : 'cursor-default',
        )}>
        <Icon
          className={cn('mt-0.5 size-4 shrink-0', mention ? 'text-accent' : 'text-muted-foreground')}
          strokeWidth={1.75}
        />
        <span className='min-w-0 flex-1'>
          <span className='flex items-baseline gap-1.5'>
            <span className={cn('truncate text-body-sm', mention ? 'font-semibold text-text' : 'text-text')}>
              {item.actor ?? item.title}
            </span>
            {item.actor !== null && <span className='shrink-0 text-label text-muted-foreground'>{item.title}</span>}
            <span className='ml-auto shrink-0 text-label text-muted-foreground tabular-nums'>{ago(item.at)}</span>
          </span>
          <span className='mt-0.5 line-clamp-2 text-body-sm text-muted-foreground'>{item.body}</span>
        </span>
      </button>

      {/* Every stratum can be dismissed, not just mentions - "make this go away" is the same verb
          whichever engine the row came from, and a dropdown where only some rows can be cleared is
          one people stop trusting. Always visible below sm (no hover to reveal it there, and a
          hidden control simply does not exist on a phone); hover/focus-reveal above. */}
      <button
        type='button'
        aria-label='Dismiss'
        title='Dismiss'
        onClick={(e) => {
          e.stopPropagation()
          onDismiss()
        }}
        className={cn(
          'absolute top-1.5 right-1.5 rounded p-1 text-muted-foreground transition-opacity',
          'hover:bg-muted hover:text-text focus-visible:opacity-100',
          'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100',
        )}>
        <X className='size-3' />
      </button>
    </li>
  )
}

/** Compact relative time. The dropdown is scanned, not read - "3h" beats a timestamp here. */
function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  return `${Math.round(days / 7)}w`
}
