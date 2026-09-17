import { cn } from '@/lib/utils'
import {
  Archive,
  CircleCheck,
  Clock,
  FileText,
  PencilLine,
  Send,
  type LucideIcon,
} from 'lucide-react'
import { CHANNEL_ICON, type ChannelIconComponent } from '@/lib/channelIcons.tsx'
import { CONTENT_STATUS_META, type ContentChannel, type ContentStatus } from '../content-types.ts'

/** Per-status icon + the text color class for its semantic tone. Label comes from CONTENT_STATUS_META. */
export const CONTENT_STATUS_UI: Record<ContentStatus, { icon: LucideIcon; color: string }> = {
  draft: { icon: PencilLine, color: 'text-muted-foreground' },
  approved: { icon: CircleCheck, color: 'text-accent' },
  scheduled: { icon: Clock, color: 'text-info' },
  published: { icon: Send, color: 'text-success' },
  archived: { icon: Archive, color: 'text-muted-foreground' },
}

/** Lifecycle position per status - "lowest across a post's channel variants" drives the sidebar icon
 *  and the post-group header. `archived` is out of the lifecycle, so it ranks last. */
export const CONTENT_STATUS_RANK: Record<ContentStatus, number> = {
  draft: 1,
  approved: 4,
  scheduled: 5,
  published: 6,
  archived: 7,
}

/** The lowest lifecycle status across a set of pieces (archived excluded unless it's all there is). */
export function lowestStatus(statuses: ContentStatus[]): ContentStatus {
  const live = statuses.filter((s) => s !== 'archived')
  const considered = live.length > 0 ? live : statuses
  return considered.reduce((min, s) => (CONTENT_STATUS_RANK[s] < CONTENT_STATUS_RANK[min] ? s : min), considered[0])
}

/** Per-channel icon + label. Icons come from the shared channel-icon map (brand glyphs). */
export const CHANNEL_UI: Record<ContentChannel, { icon: ChannelIconComponent; label: string }> = {
  blog: { icon: CHANNEL_ICON.blog, label: 'Blog' },
  reddit: { icon: CHANNEL_ICON.reddit, label: 'Reddit' },
  x: { icon: CHANNEL_ICON.x, label: 'X' },
  linkedin: { icon: CHANNEL_ICON.linkedin, label: 'LinkedIn' },
  'linkedin-article': { icon: CHANNEL_ICON['linkedin-article'], label: 'LinkedIn Article' },
  hackernews: { icon: CHANNEL_ICON.hackernews, label: 'Hacker News' },
  substack: { icon: CHANNEL_ICON.substack, label: 'Substack' },
}

/**
 * A channel, as its brand glyph and its name.
 *
 * `iconOnly` drops the name and keeps it as the tooltip and the accessible name - for the list
 * grid's Channels cell, where the label is repeated on every row of a narrow column and the glyphs
 * are already the thing being scanned. Everywhere a channel is named ONCE (a piece's own header, a
 * nested row that IS that channel) keeps the words: an icon alone is a thing you learn, and a page
 * with room to say it should say it.
 */
export function ChannelLabel({
  channel,
  className,
  iconOnly,
}: {
  channel: ContentChannel
  className?: string
  iconOnly?: boolean
}) {
  const ui = CHANNEL_UI[channel] ?? { icon: FileText, label: channel }
  const Icon = ui.icon
  if (iconOnly)
    return (
      <span
        title={ui.label}
        aria-label={ui.label}
        className={cn('inline-flex items-center text-muted-foreground', className)}>
        <Icon className='size-3.5 shrink-0' />
      </span>
    )
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-muted-foreground', className)}>
      <Icon className='size-3.5 shrink-0' />
      <span className='truncate'>{ui.label}</span>
    </span>
  )
}

/** Icon + colored label for a status, used inside the trigger and each option. */
export function StatusLabel({ status }: { status: ContentStatus }) {
  const { icon: Icon, color } = CONTENT_STATUS_UI[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5', color)}>
      <Icon className='size-3.5 shrink-0' />
      <span className='truncate font-medium'>{CONTENT_STATUS_META[status].label}</span>
    </span>
  )
}

/**
 * Read-only status chip for lists (board rows, topic pages). Deliberately NOT a control: the
 * lifecycle moves through named transitions on the piece's own page (see TransitionActions), where
 * there's room to say what each one does. A dropdown in a list row can't say "this posts publicly in
 * five minutes", and one that doesn't say it will eventually be clicked by someone who didn't know.
 */
export function ContentStatusChip({ status, className }: { status: ContentStatus; className?: string }) {
  const { icon: Icon, color } = CONTENT_STATUS_UI[status]
  return (
    <span
      title={CONTENT_STATUS_META[status].label}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-label font-medium',
        color,
        className,
      )}>
      <Icon className='size-3.5 shrink-0' />
      <span className='truncate'>{CONTENT_STATUS_META[status].label}</span>
    </span>
  )
}
