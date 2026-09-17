import { ROOM_ICON_NAMES, roomIcon, type RoomIconName } from '../lib/chatRoomIcons.ts'
import { cn } from '@/lib/utils'

interface RoomIconPickerProps {
  /** The stored name, or null for "not picked" - which selects the default (`hash`) so the grid
   *  always shows exactly one selection and "back to default" is a pick like any other. */
  value: string | null
  onChange: (icon: RoomIconName) => void
  disabled?: boolean
}

/**
 * The room icon grid: every name the server accepts, one tap each.
 *
 * A flat scrollable grid rather than a searchable combobox, because the list is curated and short
 * enough to scan (69 names) - a search field over sixty-nine items is a field nobody types in. The
 * height is capped so the dialog never grows past the viewport on the small end; the grid scrolls
 * inside it.
 */
export function RoomIconPicker({ value, onChange, disabled = false }: RoomIconPickerProps) {
  const selected = value ?? 'hash'
  return (
    <div
      role='radiogroup'
      aria-label='Room icon'
      className='grid max-h-40 grid-cols-10 gap-1 overflow-y-auto rounded-md border border-border bg-bg p-1.5'>
      {ROOM_ICON_NAMES.map((name) => {
        const Icon = roomIcon(name)
        const on = name === selected
        return (
          <button
            key={name}
            type='button'
            role='radio'
            aria-checked={on}
            aria-label={name}
            title={name}
            disabled={disabled}
            onClick={() => onChange(name)}
            className={cn(
              'flex size-7 items-center justify-center rounded-md border transition-colors disabled:opacity-50',
              on
                ? 'border-accent bg-accent/15 text-accent'
                : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground',
            )}>
            <Icon className='size-4' />
          </button>
        )
      })}
    </div>
  )
}
