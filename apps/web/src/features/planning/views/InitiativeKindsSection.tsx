import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { PageContainer, PageHeader, Button, confirm, Popover, PopoverContent, PopoverTrigger } from '@silkweave/box-ui'
import { DEFAULT_KIND_ICON, PresetIconPicker, presetIcon } from '../../data/components/board/presetIcons.tsx'
import { deleteInitiativeKind, saveInitiativeKind, useInitiativeKinds } from '../lib/initiativeKinds.ts'
import { DEFAULT_INITIATIVE_KIND } from '../planning-types.ts'

const inputCls =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'

/** The icon button + its picker popover, the same control (and the same closed lucide vocabulary) a
 *  preset uses - one set of icons for everything the team names on a board. */
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
          value={value ?? DEFAULT_KIND_ICON}
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
 * Settings → Initiative kinds: the board's lanes (`config/initiative-kinds.json`), which were ten
 * hardcoded strings until 2026-08-28.
 *
 * Two rules the UI has to make legible rather than hide:
 *   • The **id is immutable** - it is what every initiative row stores, and one signal derivation
 *     (`github.silkweave_prs_merged`, keyed on `oss-pr`) reads it. Only the label moves.
 *   • **Delete is refused while a lane holds work.** The count is shown next to the button so the
 *     refusal is predictable before it is attempted, and moving those initiatives stays a human
 *     decision made one Kind cell at a time, not a silent rewrite from here.
 */
export function InitiativeKindsSection() {
  const { data, error } = useInitiativeKinds()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  // Every mutation goes through here: one place to disable the controls, and one place where a
  // server refusal ("used by 4 initiatives") becomes something the operator can read.
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setFailure(null)
    try {
      await fn()
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className='px-8 py-8 text-body-sm text-danger'>{error}</p>
  if (!data) return <p className='px-8 py-8 text-body-sm text-muted-foreground'>Loading…</p>

  return (
    <PageContainer width='wide'>
      <PageHeader
        title='Initiative kinds'
        description={
          <>
            The lanes on the initiatives board (<code>config/initiative-kinds.json</code>). The label and
            icon are yours to change; the id is what every initiative stores, so it never changes. The
            list is alphabetical everywhere it appears. A kind can only be deleted once nothing is in it.
          </>
        }
        actions={
          <Button variant='outline' size='sm' disabled={busy} onClick={() => setAdding((v) => !v)}>
            <Plus /> New kind
          </Button>
        }
      />

      {failure && <p className='mb-3 text-body-sm text-danger'>{failure}</p>}

      <div className='overflow-hidden rounded-lg border border-border bg-surface shadow-(--shadow-sm)'>
        {data.map((k) => (
          <div key={k.id} className='flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0'>
            <IconButton
              value={k.icon}
              label={`Icon for ${k.label}`}
              onChange={(icon) => void run(() => saveInitiativeKind({ id: k.id, icon }))}
            />
            {/* Uncontrolled + commit on blur/Enter: a controlled input here would round-trip the
                whole list on every keystroke. `key` re-seeds it when the server's value changes. */}
            <input
              key={`${k.id}:${k.label}`}
              className={`${inputCls} max-w-56`}
              defaultValue={k.label}
              aria-label={`Label for ${k.id}`}
              disabled={busy}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              onBlur={(e) => {
                const label = e.currentTarget.value.trim()
                if (label && label !== k.label) void run(() => saveInitiativeKind({ id: k.id, label }))
              }}
            />
            <code className='w-44 shrink-0 truncate text-label text-muted-foreground' title={k.id}>
              {k.id}
            </code>
            <span className='flex-1 text-right text-label text-muted-foreground'>
              {k.count} initiative{k.count === 1 ? '' : 's'}
            </span>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label={`Delete ${k.label}`}
              disabled={busy || k.count > 0 || k.id === DEFAULT_INITIATIVE_KIND}
              title={
                k.id === DEFAULT_INITIATIVE_KIND
                  ? 'The fallback kind cannot be deleted'
                  : k.count > 0
                    ? 'Move its initiatives to another kind first'
                    : 'Delete this kind'
              }
              onClick={() =>
                void confirm({
                  title: `Delete the kind "${k.label}"?`,
                  message: 'Kinds are shared - this removes the lane for the whole team. Nothing is in it, so no initiative changes.',
                  confirmLabel: 'Delete kind',
                  danger: true,
                }).then((ok) => {
                  if (ok) void run(() => deleteInitiativeKind(k.id))
                })
              }>
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>

      {adding && <NewKindForm busy={busy} onCreate={(input) => run(() => saveInitiativeKind(input)).then(() => setAdding(false))} />}
    </PageContainer>
  )
}

/** The create row. The id is typed once, here, and never editable again - so it is offered as its
 *  own field rather than derived from the label, where a typo would be invisible until it was on
 *  rows. */
function NewKindForm({
  busy,
  onCreate,
}: {
  busy: boolean
  onCreate: (input: { id: string; label: string; icon: string }) => void
}) {
  const [id, setId] = useState('')
  const [label, setLabel] = useState('')
  const [icon, setIcon] = useState<string>(DEFAULT_KIND_ICON)
  const slug = id.trim().toLowerCase()
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(slug) && label.trim().length > 0

  return (
    <section className='mt-4 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <h2 className='mb-3 text-label uppercase tracking-[0.07em] text-muted-foreground'>New kind</h2>
      <div className='flex items-center gap-3'>
        <IconButton value={icon} onChange={setIcon} label='Icon for the new kind' />
        <input
          className={`${inputCls} max-w-56`}
          placeholder='Label, e.g. Partnerships'
          aria-label='Label'
          value={label}
          disabled={busy}
          onChange={(e) => {
            setLabel(e.target.value)
            // The slug follows the label until you touch it - typing it twice is the common case.
            if (!id || id === slugify(label)) setId(slugify(e.target.value))
          }}
        />
        <input
          className={`${inputCls} max-w-44`}
          placeholder='id, e.g. partnerships'
          aria-label='Id'
          value={id}
          disabled={busy}
          onChange={(e) => setId(e.target.value)}
        />
        <Button size='sm' disabled={busy || !valid} onClick={() => onCreate({ id: slug, label: label.trim(), icon })}>
          Create
        </Button>
      </div>
      <p className='mt-2 text-label text-muted-foreground'>
        The id is permanent - lowercase letters, digits and dashes. It is the value stored on every
        initiative in this lane.
      </p>
    </section>
  )
}

const slugify = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
