import { Check, ExternalLink, RotateCcw } from 'lucide-react'
import { ActionListRow, Button } from '@silkweave/box-ui'
import { channelIcon } from '@/lib/channelIcons.tsx'
import { KIND_LABEL, type InboxItem } from '../../inbox-types'

/** "2026-06-21T03:56:31Z" -> "Jun 21"; '' -> ''. */
function dayLabel(iso: string): string {
  if (!iso) return ''
  const [, m, d] = iso.slice(0, 10).split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return m && d ? `${months[Number(m) - 1]} ${Number(d)}` : ''
}

interface InboxItemRowProps {
  item: InboxItem
  /** When set, the item is already handled - show a muted row with an Undo affordance. */
  done?: boolean
  onDone?: (id: string) => void
  onReopen?: (id: string) => void
  /** Navigate to the item's detail page (title becomes clickable when provided). */
  onOpen?: (item: InboxItem) => void
}

// The frame is `ActionListRow`; what fills it is this feature's vocabulary - the channel glyph, the
// kind label, the author handle, "Open thread", and what done/undo mean here.
export function InboxItemRow({ item, done, onDone, onReopen, onOpen }: InboxItemRowProps) {
  const Icon = channelIcon(item.channel)
  const when = dayLabel(item.created_at)

  return (
    <ActionListRow
      muted={done}
      icon={<Icon className='size-4' />}
      meta={
        <>
          <span className='rounded bg-muted px-1.5 py-0.5 normal-case tracking-normal'>{KIND_LABEL[item.kind]}</span>
          <span className='truncate'>{item.target}</span>
        </>
      }
      aside={when || undefined}
      onTitleClick={onOpen ? () => onOpen(item) : undefined}
      title={
        <>
          <span className='text-accent'>@{item.author}</span>
          {item.title && item.title !== item.target ? (
            <span className='text-muted-foreground'> · {item.title}</span>
          ) : null}
        </>
      }
      body={item.snippet ? <p className='line-clamp-3'>{item.snippet}</p> : undefined}
      actions={
        <>
          <a
            href={item.url}
            target='_blank'
            rel='noreferrer'
            className='inline-flex items-center gap-1.5 text-label font-medium text-muted-foreground transition-colors hover:text-text'>
            <ExternalLink className='size-3.5' />
            Open thread
          </a>
          <span className='flex-1' />
          {done
            ? onReopen && (
                <Button variant='ghost' size='sm' onClick={() => onReopen(item.id)}>
                  <RotateCcw />
                  Undo
                </Button>
              )
            : onDone && (
                <Button variant='secondary' size='sm' onClick={() => onDone(item.id)}>
                  <Check />
                  Mark done
                </Button>
              )}
        </>
      }
    />
  )
}
