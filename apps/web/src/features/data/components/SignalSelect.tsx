import { useMemo } from 'react'
import { Combobox } from '@base-ui/react/combobox'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSignalsData } from '../lib/useSignalsData.ts'
import { channelLabel, type Signal } from '../../../types.ts'

// Pickers for signal-signal bindings: a friendly-name autocomplete over the live signal list. The
// stored value is always the raw `signal_id`; options carry `{ value: id, label }` so base-ui shows the
// friendly label while we persist ids. Unknown ids (not in the live list) still render (id as label) so
// a binding is never silently dropped.

interface Option {
  value: string // signal_id
  label: string // friendly name
  channel: string
}

const friendly = (s: Signal): string => `${s.label} · ${channelLabel(s.channel)}`

function useSignalOptions() {
  const { data } = useSignalsData()
  return useMemo(() => {
    const signal = data?.signals ?? []
    const options: Option[] = signal
      .map((s) => ({ value: s.id, label: friendly(s), channel: s.channel }))
      .sort((a, b) => a.channel.localeCompare(b.channel) || a.label.localeCompare(b.label))
    const byId = new Map(options.map((o) => [o.value, o]))
    const optionOf = (id: string): Option => byId.get(id) ?? { value: id, label: id, channel: '' }
    return { options, optionOf }
  }, [data])
}

const eq = (a: Option, b: Option) => a.value === b.value

// Shared classes (mirror ui/Select.tsx tokens).
const groupCls =
  'flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 text-body-sm transition-colors hover:border-accent/40 focus-within:border-accent/60'
const inputCls =
  'h-6 min-w-20 flex-1 border-0 bg-transparent p-0 text-body-sm text-text outline-none placeholder:text-fg-4'
const popupCls =
  'max-h-[min(24rem,var(--available-height))] w-[var(--anchor-width)] origin-(--transform-origin) overflow-y-auto rounded-md bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0'
const itemCls =
  'grid cursor-pointer grid-cols-[1rem_1fr] items-center gap-2 rounded-sm px-2 py-1.5 text-body-sm text-text outline-none select-none data-highlighted:bg-accent-tint data-highlighted:text-text'

function OptionRow({ option }: { option: Option }) {
  return (
    <>
      <Combobox.ItemIndicator className='col-start-1 text-accent'>
        <Check className='size-3.5' />
      </Combobox.ItemIndicator>
      <span className='col-start-2 flex min-w-0 flex-col'>
        <span className='truncate'>{option.label}</span>
        <span className='truncate text-label text-muted-foreground'>{option.value}</span>
      </span>
    </>
  )
}

function OptionList() {
  return (
    <Combobox.Portal>
      <Combobox.Positioner className='isolate z-60 outline-none' sideOffset={6}>
        <Combobox.Popup className={popupCls}>
          <Combobox.Empty className='px-2 py-2 text-body-sm text-muted-foreground'>No matching signal.</Combobox.Empty>
          <Combobox.List>
            {(option: Option) => (
              <Combobox.Item key={option.value} value={option} className={itemCls}>
                <OptionRow option={option} />
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Popup>
      </Combobox.Positioner>
    </Combobox.Portal>
  )
}

/** Multi-select chip + autocomplete picker. value/onChange are arrays of raw signal_ids. */
export function SignalSelect({
  value,
  onChange,
  placeholder = 'add a signal…',
}: {
  value: string[]
  onChange: (ids: string[]) => void
  placeholder?: string
}) {
  const { options, optionOf } = useSignalOptions()
  const { contains } = Combobox.useFilter()
  const selected = value.map(optionOf)

  return (
    <Combobox.Root
      items={options}
      multiple
      value={selected}
      onValueChange={(opts: Option[]) => onChange(opts.map((o) => o.value))}
      isItemEqualToValue={eq}
      filter={(item: Option, query) => contains(item.label, query) || contains(item.value, query)}>
      <Combobox.Chips className={groupCls}>
        <Combobox.Value>
          {(vals: Option[]) => (
            <>
              {vals.map((opt) => (
                <Combobox.Chip
                  key={opt.value}
                  aria-label={opt.label}
                  className='group flex items-center gap-1 rounded bg-accent-tint py-0.5 pr-1 pl-1.5 text-label text-accent'>
                  {opt.label}
                  <Combobox.ChipRemove
                    aria-label={`Remove ${opt.label}`}
                    className='flex size-4 items-center justify-center rounded text-accent/70 hover:bg-accent/20 hover:text-accent'>
                    <X className='size-3' />
                  </Combobox.ChipRemove>
                </Combobox.Chip>
              ))}
              <Combobox.Input placeholder={vals.length ? '' : placeholder} className={inputCls} />
            </>
          )}
        </Combobox.Value>
      </Combobox.Chips>
      <OptionList />
    </Combobox.Root>
  )
}

/** Single-select autocomplete picker for the target signal. value is a raw signal_id (or empty). */
export function SignalPicker({
  value,
  onChange,
  placeholder = 'pick a signal…',
}: {
  value: string
  onChange: (id: string) => void
  placeholder?: string
}) {
  const { options, optionOf } = useSignalOptions()
  const { contains } = Combobox.useFilter()
  const selected = value ? optionOf(value) : null

  return (
    <Combobox.Root
      items={options}
      value={selected}
      onValueChange={(opt: Option | null) => onChange(opt?.value ?? '')}
      isItemEqualToValue={eq}
      filter={(item: Option, query) => contains(item.label, query) || contains(item.value, query)}>
      <Combobox.InputGroup className={cn(groupCls, 'flex-nowrap')}>
        <Combobox.Input placeholder={placeholder} className={inputCls} />
        {value && (
          <Combobox.Clear
            aria-label='Clear'
            className='flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-text'>
            <X className='size-3.5' />
          </Combobox.Clear>
        )}
        <Combobox.Trigger
          aria-label='Open'
          className='flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-text'>
          <ChevronsUpDown className='size-3.5' />
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <OptionList />
    </Combobox.Root>
  )
}
