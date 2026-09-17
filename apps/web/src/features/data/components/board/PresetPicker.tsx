// The preset control: pick one · see when you have changed it · save, save-as or throw the changes
// away · manage the whole list. Shared by the Content, Initiatives and CRM bars.
//
// THE SELECT KEEPS SHOWING THE PRESET YOU CAME FROM (2026-08-12). It used to fall back to "Custom
// view" the moment you touched a filter, which threw away the one fact you need to choose between
// "save this over Critical path" and "save it as something new" - and made the sidebar highlight
// vanish for no reason a person would recognise. Now the name stays, marked `· changed`, and the
// selection lives in the URL (`?preset=Critical%20path`), so a link carries the lens with it.
//
// EVERY ACTION LIVES INSIDE THE DROPDOWN, on its header row, to the left of the gear. They rode
// beside the trigger for about an hour and the problem was immediate: the control changed width the
// moment you touched a filter, so the whole bar reflowed under the cursor and the thing you were
// aiming at moved. A control that resizes when you use it is a control you stop trusting. The trigger
// is now a fixed width whatever the state - the changed dot has a reserved slot rather than an
// appearing one - and the actions are one click deeper, which is the right depth for three things you
// use a few times a day.
//
//   • nothing changed → the header carries only the gear.
//   • changed → **Reset** (throw the edits away, back to what the preset shows), **Save Existing**
//     (overwrite the selected preset in place, for everyone), **Save New** (opens the manager in
//     create mode), then the gear. Left to right they run cheapest-to-most-consequential, and the two
//     saves - the pair you actually have to choose between - sit next to each other.
//   • changed with nothing selected → no Save Existing: there is nothing to overwrite, and Reset
//     means the module default.
//
// All of them are `tabIndex={-1}` and siblings of the items, never children: base-ui hands the open
// popup's initial focus to its first TABBABLE child, which has to be the highlighted preset, and a
// button inside a `Select.Item` would select that preset on its way to being clicked.

import { useState } from 'react'
import { Circle, Plus, RotateCcw, Save, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@silkweave/box-ui'
import { PresetManagerDialog } from './PresetManagerDialog.tsx'
import { presetIcon } from './presetIcons.tsx'
import type { BaseViewState, ViewStore } from '../../lib/boardView.ts'

/** One action on the dropdown's header row. Icon-only with a `title`: the row is 240px wide and has
 *  to hold four of them plus the word "Presets". */
const HEADER_ACTION = 'shrink-0 rounded p-1 transition-colors hover:bg-accent-tint'

export function PresetPicker<S extends BaseViewState>({
  view: v,
  savesHint,
  noun,
}: {
  view: ViewStore<S>
  /** What "save" captures here, e.g. "the current layout, filters, grouping and columns". */
  savesHint: string
  /** What this module calls its rows ("accounts", "initiatives", "posts"). */
  noun: string
}) {
  const { presets, selected, dirty, select, save, reset, error } = v
  const [manage, setManage] = useState<'closed' | 'manage' | 'create'>('closed')
  // The select is controlled only so the gear can close it on its way to the dialog: a dropdown left
  // open behind a modal is a second focus trap fighting the first.
  const [selectOpen, setSelectOpen] = useState(false)

  const current = selected ? presets.find((s) => s.name === selected) : null
  const TriggerIcon = presetIcon(current?.icon ?? null)

  const openManager = (mode: 'manage' | 'create'): void => {
    setSelectOpen(false)
    setManage(mode)
  }

  return (
    <div className='inline-flex flex-col gap-1'>
      <div className='inline-flex items-center'>
        <Select
          open={selectOpen}
          onOpenChange={setSelectOpen}
          value={selected ?? ''}
          onValueChange={(next) => next && select(next as string)}
          items={[{ value: '', label: 'Custom view' }, ...presets.map((s) => ({ value: s.name, label: s.name }))]}>
          <SelectTrigger aria-label='Preset' className='h-7 min-w-40 focus-visible:z-10 data-popup-open:z-10'>
            <SelectValue>
              {(val) => (
                <span className='flex min-w-0 items-center gap-1.5'>
                  {/* No icon on "Custom view": there is no preset to wear one, and a default icon
                      there would read as a named lens you cannot find in the list. */}
                  {val && <TriggerIcon className='size-3.5 shrink-0 text-accent' />}
                  <span className={cn('truncate', val ? 'font-medium' : 'text-muted-foreground')}>
                    {(val as string) || 'Custom view'}
                  </span>
                  {/* The changed marker rides IN the trigger rather than beside it, so the name and
                      the fact that it no longer matches can never be read apart. A filled dot rather
                      than a word: it is the same "unsaved" idiom every editor uses, and a label here
                      competes with the preset's own name for the width that matters. Its slot is
                      RESERVED rather than conditional - the whole point of moving the actions into the
                      dropdown was that this control must not resize while you are using it. */}
                  <Circle
                    className={cn('size-2 shrink-0 fill-current text-warning', dirty && val ? '' : 'invisible')}
                    aria-label={dirty && val ? 'changed' : undefined}
                    aria-hidden={dirty && val ? undefined : true}
                    role='img'
                  />
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent className='min-w-64'>
            {/* The gear rides the header rather than each row: managing presets is one action on the
                LIST, and a per-row control would be the hover-hidden thing it replaces. It is a
                sibling of the items, never a child - a button inside a base-ui Select.Item would
                select that preset on its way to being clicked - and it is out of the tab order,
                because the popup hands initial focus to its first TABBABLE child and that must be
                the highlighted preset, not this. */}
            <div className='flex items-center justify-between gap-2 px-2 py-1'>
              <span
                className='text-label text-muted-foreground'
                title='Shared with the team - everyone sees this list, in this order'>
                Presets
              </span>
              <div className='-mr-1 flex shrink-0 items-center gap-0.5'>
                {dirty && (
                  <>
                    <button
                      type='button'
                      onClick={() => {
                        reset()
                        setSelectOpen(false)
                      }}
                      tabIndex={-1}
                      aria-label='Discard changes'
                      title={selected ? `Discard the changes and go back to "${selected}"` : 'Discard the changes'}
                      className={cn(HEADER_ACTION, 'text-muted-foreground hover:text-text')}>
                      <RotateCcw className='size-3.5' />
                    </button>
                    {selected && (
                      <button
                        type='button'
                        // The preset's icon rides along explicitly - `save` writes the whole record,
                        // so omitting it would quietly reset the icon every time someone saved a
                        // filter change. The one-liner is the opposite: omitted means keep, so a
                        // filter change never eats the sentence explaining the lens.
                        onClick={() => {
                          void save(selected, current?.icon ?? null)
                          setSelectOpen(false)
                        }}
                        tabIndex={-1}
                        aria-label={`Save changes to ${selected}`}
                        title={`Save changes to "${selected}" - replaces what it shows, for everyone`}
                        className={cn(HEADER_ACTION, 'text-accent')}>
                        <Save className='size-3.5' />
                      </button>
                    )}
                    <button
                      type='button'
                      onClick={() => openManager('create')}
                      tabIndex={-1}
                      aria-label='Save as a new preset'
                      title={`Save ${savesHint} as a NEW preset - for everyone`}
                      className={cn(HEADER_ACTION, 'text-muted-foreground hover:text-text')}>
                      <Plus className='size-3.5' />
                    </button>
                    {/* A hairline between "what to do with your changes" and "manage the list" - four
                        undifferentiated icons read as one toolbar of equals, and the gear is not. */}
                    <span className='mx-0.5 h-4 w-px bg-border' />
                  </>
                )}
                <button
                  type='button'
                  onClick={() => openManager('manage')}
                  tabIndex={-1}
                  aria-label='Manage presets'
                  title='Manage presets - rename, reorder, delete'
                  className={cn(HEADER_ACTION, 'text-muted-foreground hover:text-text')}>
                  <Settings2 className='size-3.5' />
                </button>
              </div>
            </div>
            {presets.map((s) => {
              const Icon = presetIcon(s.icon)
              return (
                <SelectItem key={s.name} value={s.name}>
                  <span className='flex min-w-0 items-center gap-2'>
                    <Icon className='size-4 shrink-0 text-muted-foreground' />
                    <span className='flex min-w-0 flex-col'>
                      <span>{s.name}</span>
                      {s.description && (
                        <span className='truncate text-label text-muted-foreground'>{s.description}</span>
                      )}
                    </span>
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </div>

      {/* A shared write can fail (the config file, a lost session). Saying so beats a click that
          looks like it worked until the next reload. */}
      {error && <span className='text-label text-danger'>{error}</span>}

      <PresetManagerDialog
        view={v}
        savesHint={savesHint}
        noun={noun}
        showCreate={manage === 'create'}
        open={manage !== 'closed'}
        onOpenChange={(open) => !open && setManage('closed')}
      />
    </div>
  )
}
