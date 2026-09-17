import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle, Button, DateInput } from '@silkweave/box-ui'
import { SignalSelect, SignalPicker } from '../../data/components/SignalSelect.tsx'
import { KindSelect, TagPicker, ValueSelect } from './dimensions.tsx'
import { upsertInitiative, usePlanningData, type InitiativeUpsert } from '../lib/usePlanningData.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'
import {
  PLANNING_STATUSES,
  PLANNING_STATUS_META,
  type Initiative,
  type InitiativeKind,
  type PlanningStatus,
  type ValueLevel,
} from '../planning-types.ts'

/** title → slug: lowercase, non-alphanumerics → '-', trimmed. Matches the server's slug rules. */
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

const inputCls =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'

/**
 * Create/edit an initiative. With `initiative` it edits in place (id fixed); without, it creates a
 * new one with the id derived from the title slug. Signal ids are comma/space separated; the
 * target group is optional (set-only - clearing a target is done via the MCP tool).
 */
export function InitiativeDialog({
  open,
  onOpenChange,
  initiative,
  existingIds,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initiative?: Initiative
  existingIds: string[]
  onSaved: (id: string) => void
}) {
  const editing = !!initiative
  const { data: allInitiatives } = usePlanningData()
  const tagSuggestions = [...new Set((allInitiatives ?? []).flatMap((i) => i.tags))].sort()
  const [f, setF] = useState(() => seed(initiative))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setF(seed(initiative))
    setError(null)
    setSaving(false)
  }, [open, initiative])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }))

  const id = editing ? initiative!.id : slugify(f.title)
  const duplicate = !editing && !!id && existingIds.includes(id)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!f.title.trim()) return setError('Title is required.')
    if (!id) return setError('Could not derive a slug from that title.')
    if (duplicate) return setError(`Initiative "${id}" already exists.`)

    const input: InitiativeUpsert = {
      id,
      title: f.title.trim(),
      status: f.status,
      kind: f.kind,
      owner: f.owner.trim(),
      signal_ids: f.signalIds,
      // '' is the server's "clear it" for the flattened enums - which is also the right thing to
      // send when the user explicitly un-set one while editing.
      value_customer: f.valueCustomer ?? '',
      value_company: f.valueCompany ?? '',
      tags: f.tags,
      // '' is the server's "clear it" here too - an explicitly emptied date field must clear.
      due_date: f.dueDate,
      sort: f.sort === '' ? undefined : Number(f.sort),
    }
    if (f.targetSignal.trim()) {
      input.target_signal_id = f.targetSignal.trim()
      if (f.targetValue !== '') input.target_value = Number(f.targetValue)
      if (f.targetByDate.trim()) input.target_by_date = f.targetByDate.trim()
      if (f.targetBaseline !== '') input.target_baseline = Number(f.targetBaseline)
    }

    setSaving(true)
    void upsertInitiative(input)
      .then(() => {
        onOpenChange(false)
        onSaved(id)
      })
      .catch((err) => {
        setSaving(false)
        setError(String(err))
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-xl'>
        <div className='flex flex-col gap-1'>
          <DialogTitle>{editing ? 'Edit initiative' : 'New initiative'}</DialogTitle>
          <DialogDescription>
            {editing ? <code className='text-label'>{id}</code> : 'A signals-bound body of work. The id is derived from the title.'}
          </DialogDescription>
        </div>

        <form onSubmit={submit} className='flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1'>
          <Field label='Title'>
            {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
            <input autoFocus value={f.title} onChange={(e) => { set('title', e.target.value); setError(null) }} className={inputCls} />
          </Field>

          <div className='grid grid-cols-2 gap-3'>
            <Field label='Status'>
              <select value={f.status} onChange={(e) => set('status', e.target.value as PlanningStatus)} className={inputCls}>
                {PLANNING_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {PLANNING_STATUS_META[s].label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label='Kind'>
              <KindSelect value={f.kind} onChange={(k) => set('kind', k)} className='w-full' />
            </Field>
            <Field label='Owner'>
              <input value={f.owner} onChange={(e) => set('owner', e.target.value)} placeholder='optional' className={inputCls} />
            </Field>
            <Field label='Due date'>
              <DateInput value={f.dueDate} onChange={(v) => set('dueDate', v)} ariaLabel='Due date' />
            </Field>
            <Field label='Sort'>
              <input type='number' value={f.sort} onChange={(e) => set('sort', e.target.value)} placeholder='0' className={inputCls} />
            </Field>
            <Field label='Customer value'>
              <ValueSelect value={f.valueCustomer} ariaLabel='Customer value' onChange={(v) => set('valueCustomer', v || null)} className='w-full' />
            </Field>
            <Field label='Company value'>
              <ValueSelect value={f.valueCompany} ariaLabel='Company value' onChange={(v) => set('valueCompany', v || null)} className='w-full' />
            </Field>
            {/* No Size field: an initiative's size is the sum of its tasks' estimates and nothing
                else, so at creation time - before it has any tasks - there is nothing to ask. */}
          </div>

          <Field label='Tags'>
            <TagPicker value={f.tags} suggestions={tagSuggestions} onChange={(tags) => set('tags', tags)} />
          </Field>

          <Field label='Signals (drives)'>
            <SignalSelect value={f.signalIds} onChange={(ids) => set('signalIds', ids)} />
          </Field>

          <fieldset className='rounded-md border border-border p-3'>
            <legend className='px-1 text-label text-muted-foreground'>Target (optional)</legend>
            <div className='grid grid-cols-2 gap-3'>
              <Field label='Signal id'>
                <SignalPicker value={f.targetSignal} onChange={(id) => set('targetSignal', id)} />
              </Field>
              <Field label='Value'>
                <input type='number' value={f.targetValue} onChange={(e) => set('targetValue', e.target.value)} className={inputCls} />
              </Field>
              <Field label='By date'>
                <DateInput value={f.targetByDate} onChange={(v) => set('targetByDate', v)} ariaLabel='Target by date' />
              </Field>
              <Field label='Baseline'>
                <input type='number' value={f.targetBaseline} onChange={(e) => set('targetBaseline', e.target.value)} className={inputCls} />
              </Field>
            </div>
          </fieldset>

          {error && <p className='text-label text-danger'>{error}</p>}

          <div className='mt-1 flex items-center justify-end gap-2'>
            <Button type='button' variant='ghost' size='sm' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={saving || !f.title.trim() || duplicate}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create initiative'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface Form {
  title: string
  status: PlanningStatus
  kind: InitiativeKind
  owner: string
  signalIds: string[]
  valueCustomer: ValueLevel | null
  valueCompany: ValueLevel | null
  tags: string[]
  dueDate: string
  sort: string
  targetSignal: string
  targetValue: string
  targetByDate: string
  targetBaseline: string
}

function seed(i?: Initiative): Form {
  return {
    title: i?.title ?? '',
    status: i?.status ?? 'planned',
    kind: i?.kind ?? 'general',
    // New initiatives default to the active user (still editable - "Carol creating for Alice").
    owner: i ? (i.owner ?? '') : (getActiveUserId() ?? ''),
    signalIds: i?.signal_ids ?? [],
    valueCustomer: i?.value_customer ?? null,
    valueCompany: i?.value_company ?? null,
    tags: i?.tags ?? [],
    dueDate: i?.due_date ?? '',
    sort: i?.sort != null ? String(i.sort) : '',
    targetSignal: i?.target?.signal_id ?? '',
    targetValue: i?.target?.value != null ? String(i.target.value) : '',
    targetByDate: i?.target?.by_date ?? '',
    targetBaseline: i?.target?.baseline != null ? String(i.target.baseline) : '',
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className='flex flex-col gap-1'>
      <span className='text-label text-muted-foreground'>{label}</span>
      {children}
    </label>
  )
}
