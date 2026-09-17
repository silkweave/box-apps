// Manage presets - the one surface where a preset is fully editable: create it, retitle it, rewrite
// its one-liner, change its icon, move it up or down, overwrite what it shows with the board in
// front of you, delete it. Shared by Content, the CRM and Initiatives.
//
// It exists because none of that used to be possible. There were two tiers - built-in "presets" that
// were code, and "saved views" that were config - and the six lenses people actually used every day
// were the six nobody could touch. There is one tier now (2026-08-12): every preset is a team-owned
// record, and the built-ins are a seed rather than a floor. `Restore default presets` is the way
// back from a delete, and it only ever ADDS names that are missing - it never reverts an edit.
//
// One dialog, two ways in, and it shows a different amount of itself depending on which (2026-08-12).
// The gear opens it to MANAGE - the list, nothing else. "Save New" opens it to CREATE, which adds the
// name-and-icon row on top; the list stays visible underneath because the thing you most need while
// naming a preset is the names that are taken. Having the create row up permanently made the dialog
// read as a save form you had to scroll past to reach what you came for.

import { useState } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button, confirm, Dialog, DialogContent, DialogDescription, DialogTitle, Popover, PopoverContent, PopoverTrigger } from '@silkweave/box-ui'
import { DEFAULT_PRESET_ICON, PresetIconPicker, presetIcon } from './presetIcons.tsx'
import type { BaseViewState, Preset, ViewStore } from '../../lib/boardView.ts'

/** The shared input styling of the text fields - one line so the create row and the list match. */
const FIELD =
  'h-8 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-body-sm text-text outline-none focus:border-accent'

/** The icon button + its picker popover. Used by the create row and by every preset in the list. */
function IconButton({ value, onChange, label }: { value: string | null; onChange: (key: string) => void; label: string }) {
  const [open, setOpen] = useState(false)
  const Icon = presetIcon(value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className='inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-bg text-accent transition-colors hover:border-accent/40'>
        <Icon className='size-4' />
      </PopoverTrigger>
      <PopoverContent align='start' side='bottom' className='w-auto'>
        <PresetIconPicker
          value={value ?? DEFAULT_PRESET_ICON}
          onChange={(key) => {
            onChange(key)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * A text field that stays LOCAL until Enter or blur. Both editable strings on a row need it for the
 * same reason: a write per keystroke publishes half-typed titles to the whole team, and Escape has
 * to abandon rather than commit on its way past (it is also the key that closes the dialog).
 */
function CommitField({
  value,
  onCommit,
  label,
  placeholder,
  className,
}: {
  value: string
  onCommit: (next: string) => void
  label: string
  placeholder?: string
  className?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft?.trim()
        setDraft(null)
        if (next !== undefined && next !== value) onCommit(next)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          e.stopPropagation()
          setDraft(null)
        }
      }}
      placeholder={placeholder}
      aria-label={label}
      className={cn(FIELD, className)}
    />
  )
}

export function PresetManagerDialog<S extends BaseViewState>({
  view: v,
  savesHint,
  noun,
  showCreate,
  open,
  onOpenChange,
}: {
  view: ViewStore<S>
  /** What "save" captures here, e.g. "the current layout, filters, grouping and columns". */
  savesHint: string
  /** What this module calls its rows, for the empty state ("accounts", "pieces"). */
  noun: string
  /** Opened by "Save New" rather than the gear: show the name-and-icon row, and title it as a save. */
  showCreate: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { presets, save, update, reorder, remove, restoreDefaults, missingDefaults, error } = v
  const [create, setCreate] = useState<{ name: string; icon: string }>({ name: '', icon: DEFAULT_PRESET_ICON })
  // A small distance threshold keeps a click on the row's own controls from being read as a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  const createName = create.name.trim()
  const createOverwrites = presets.some((s) => s.name === createName)

  const doCreate = (): void => {
    if (!createName) return
    void save(createName, create.icon)
    setCreate({ name: '', icon: DEFAULT_PRESET_ICON })
    // Saving IS the errand you came on; staying open would leave you looking at a form you just
    // emptied. The list underneath has the new preset in it either way.
    onOpenChange(false)
  }

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return
    const names = presets.map((s) => s.name)
    const from = names.indexOf(String(active.id))
    const to = names.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    void reorder(arrayMove(names, from, to))
  }

  const doDelete = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: `Delete the preset "${name}"?`,
      message: 'Presets are shared - this removes it for everyone on the team. A built-in one can be brought back with "Restore default presets".',
      confirmLabel: 'Delete preset',
      danger: true,
    })
    if (ok) await remove(name)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-2xl'>
        <div className='flex flex-col gap-1'>
          <DialogTitle>{showCreate ? 'Save this view as a preset' : 'Manage presets'}</DialogTitle>
          <DialogDescription>
            Presets are shared - the whole team sees this list, in this order, and anyone can edit any
            of them. There are no private presets.
          </DialogDescription>
        </div>

        {/* Only on the "Save New" path. The list below stays visible while you type, because the one
            thing you need while naming a preset is the names that are already taken. */}
        {showCreate && (
          <div className='flex flex-col gap-1.5 rounded-md border border-border bg-bg/50 p-3'>
            <span className='text-label text-muted-foreground'>Save {savesHint} as a new preset</span>
            <div className='flex items-center gap-2'>
              <IconButton
                value={create.icon}
                onChange={(icon) => setCreate({ ...create, icon })}
                label='Icon for the new preset'
              />
              <input
                value={create.name}
                onChange={(e) => setCreate({ ...create, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && doCreate()}
                placeholder='Preset name'
                aria-label='New preset name'
                autoFocus
                className={FIELD}
              />
              <Button size='sm' onClick={doCreate} disabled={!createName}>
                {createOverwrites ? 'Update' : 'Save'}
              </Button>
            </div>
            {createOverwrites && (
              <span className='text-label text-warning'>That name exists - saving replaces it for everyone.</span>
            )}
          </div>
        )}

        {/* The list is the one part that grows without bound - six seeded presets already fill a
            laptop viewport, so it scrolls inside the dialog and the create row above it and the
            restore link below it both stay reachable. */}
        {presets.length === 0 ? (
          <span className='text-body-sm text-muted-foreground'>
            No presets yet. Set the {noun} up the way you want them, then use Save New in the bar.
          </span>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={presets.map((s) => s.name)} strategy={verticalListSortingStrategy}>
              <ul className='flex max-h-[46vh] flex-col divide-y divide-border overflow-y-auto rounded-md border border-border'>
                {presets.map((s) => (
                  <PresetRow
                    key={s.name}
                    preset={s}
                    onIcon={(icon) => void update(s.name, { icon })}
                    onTitle={(next) => next && void update(s.name, { name: next })}
                    onDescription={(next) => void update(s.name, { description: next })}
                    onDelete={() => void doDelete(s.name)}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}

        {/* Only offered when it would do something. A permanently-present "restore" reads as "undo
            everyone's edits", which is the one thing it will never do. */}
        {missingDefaults > 0 && (
          <button
            type='button'
            onClick={() => void restoreDefaults()}
            className='inline-flex items-center gap-1.5 self-start text-label text-muted-foreground transition-colors hover:text-text'>
            <RotateCcw className='size-3.5' />
            Restore default presets ({missingDefaults} missing) - adds them back, changes nothing else
          </button>
        )}

        {/* A shared write can fail (the config file, a lost session, a name someone else just took).
            Saying so beats a click that looks like it worked until the next reload. */}
        {error && <span className='text-label text-danger'>{error}</span>}
      </DialogContent>
    </Dialog>
  )
}

/**
 * One preset in the list: drag handle, icon, title, delete, and its one-liner underneath.
 *
 * What is NOT here is as deliberate as what is. There is no "replace what this shows" button - that
 * is **Save Existing** in the bar, where you can see what you would be saving; offering it from a
 * dialog meant aiming it at a preset you were not looking through, which is why it needed a confirm
 * step nothing else here has. And there is no "last saved by" line: it answered a question nobody
 * was asking and cost every row a third line.
 */
function PresetRow<S>({
  preset,
  onIcon,
  onTitle,
  onDescription,
  onDelete,
}: {
  preset: Preset<S>
  onIcon: (icon: string) => void
  onTitle: (next: string) => void
  onDescription: (next: string) => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: preset.name,
  })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('flex flex-col gap-1.5 bg-bg p-2', isDragging && 'z-10 opacity-80 shadow-md')}>
      <div className='flex items-center gap-2'>
        {/* The grip is the drag handle, so the fields beside it stay clickable and their text stays
            selectable - the same split the board cards make. */}
        <button
          type='button'
          ref={setActivatorNodeRef}
          {...listeners}
          {...attributes}
          aria-label={`Reorder ${preset.name}`}
          title='Drag to reorder - the whole team sees this order'
          className='-ml-1 shrink-0 cursor-grab touch-none rounded p-0.5 text-fg-4 transition-colors hover:text-text'>
          <GripVertical className='size-4' />
        </button>
        <IconButton value={preset.icon} onChange={onIcon} label={`Icon for ${preset.name}`} />
        <CommitField value={preset.name} onCommit={onTitle} label={`Title of ${preset.name}`} />
        <button
          type='button'
          onClick={onDelete}
          aria-label={`Delete preset ${preset.name}`}
          title={`Delete preset ${preset.name}`}
          className='inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger'>
          <Trash2 className='size-3.5' />
        </button>
      </div>
      <CommitField
        value={preset.description ?? ''}
        onCommit={onDescription}
        label={`Description of ${preset.name}`}
        placeholder='What this preset is for (optional)'
        className='ml-14 h-7 text-label'
      />
    </li>
  )
}
