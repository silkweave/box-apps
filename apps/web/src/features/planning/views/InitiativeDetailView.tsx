import { useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, Plus, Settings2, Trash2 } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { deleteInitiative, renameInitiative, upsertInitiative, usePlanningData } from '../lib/usePlanningData.ts'
import { useSignalsData } from '../../data/lib/useSignalsData.ts'
import { confirm, PageContainer, TopBarActions, SplitPane, Button, Checkbox, InlineEdit, Popover, PopoverContent, PopoverTrigger, DateInput, UserPicker } from '@silkweave/box-ui'
import { SignalCard } from '../../data/components/SignalCard.tsx'
import { DocEditor } from '../../../components/DocEditor.tsx'
import { DoneGateDialog, unresolvedTasks } from '../components/DoneGateDialog.tsx'
import { SignalSelect, SignalPicker } from '../../data/components/SignalSelect.tsx'
import { StatusSelect } from '../components/status.tsx'
import { NewTaskDialog } from '../components/NewTaskDialog.tsx'
import { TaskColumnsButton, TaskDoneTasksButton, TaskList } from '../components/TaskList.tsx'
import {
  DependencyPicker,
  EffortMeter,
  KindSelect,
  PriorityStars,
  TagPicker,
  ValueSelect,
} from '../components/dimensions.tsx'
import { allTags } from '../lib/planningView.ts'
import { rollupEffort } from '../lib/effort.ts'
import { cn } from '@/lib/utils'
import { TERMINAL_PLANNING_STATUSES, type Initiative } from '../planning-types.ts'
import type { Signal } from '../../../types.ts'
import { formatNumber } from '../../../lib/format.ts'
import { appKey } from '@/lib/storage.ts'

/** title/slug → slug: lowercase, non-alphanumerics → '-', trimmed. Matches the server's slug rules. */
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

export function InitiativeDetailView() {
  const { id } = useParams({ strict: false }) as { id?: string }
  const { data } = usePlanningData()
  const signals = useSignalsData()
  const navigate = useNavigate()
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [doneGateOpen, setDoneGateOpen] = useState(false)
  if (!data) return null
  
  const initiative = data.find((i) => i.id === id)
  if (!initiative)
    return <div className='mx-auto max-w-3xl px-4 py-16 text-center text-body-sm text-muted-foreground'>Initiative not found.</div>

  // A task id is the slug path `<initiative>/<task>`, and the detail route rebuilds it from its two
  // params - so a row whose id does NOT carry its initiative's prefix has no address under this
  // route. The old code sliced blindly at `initiative.id.length + 1`, which on such a row yields an
  // empty slug and a navigation that does nothing at all: the row simply refused to open, with no
  // error anywhere. Prefer being loud over being silent - core now refuses to CREATE an id like
  // that (upsertTask), so this branch is a diagnostic for rows that predate the guard.
  const openTask = (taskId: string): void => {
    const prefix = `${initiative.id}/`
    if (!taskId.startsWith(prefix)) {
      console.error(`task "${taskId}" is not keyed under initiative "${initiative.id}" - cannot open it`)
      void confirm({
        title: 'This task has a malformed id',
        message: `Its id is "${taskId}", but a task must be keyed "${initiative.id}/<slug>" to have a page. Re-key it (task-move onto this initiative) and it will open.`,
        confirmLabel: 'OK',
      })
      return
    }
    void navigate({ to: '/initiatives/$id/$taskSlug', params: { id: initiative.id, taskSlug: taskId.slice(prefix.length) } })
  }

  const onDelete = (): void => {
    void confirm({
      title: `Delete initiative "${initiative.title}"?`,
      message: `Its ${initiative.tasks.length} task(s) go with it. Docs on disk stay.`,
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => void (ok && deleteInitiative(initiative.id).then(() => navigate({ to: '/initiatives' }))))
  }

  const signalById = new Map<string, Signal>((signals.data?.signals ?? []).map((s) => [s.id, s]))
  const boundSignal = initiative.signal_ids.map((sid) => signalById.get(sid)).filter((s): s is Signal => !!s)

  const openTasks = initiative.tasks.filter((t) => !TERMINAL_PLANNING_STATUSES.includes(t.status)).length

  const commit = (patch: Partial<Parameters<typeof upsertInitiative>[0]>) =>
    void upsertInitiative({ ...patch, id: initiative.id })

  // Renaming the slug re-keys the initiative + all its tasks and moves their docs (server-side); confirm
  // first, then route to the new id.
  const renameSlug = (raw: string): void => {
    const next = slugify(raw)
    if (!next || next === initiative.id) return
    if (data.some((i) => i.id === next)) return void window.alert(`An initiative "${next}" already exists.`)
    const n = initiative.tasks.length
    void confirm({
      title: `Rename slug to "${next}"?`,
      message: `This re-keys the initiative${n ? ` + its ${n} task(s)` : ''} and moves their docs on disk.`,
      confirmLabel: 'Rename',
    }).then(
      (ok) =>
        void (ok && renameInitiative(initiative.id, next).then(() => navigate({ to: '/initiatives/$id', params: { id: next } }))),
    )
  }

  const left = (
    // Full width, not `reading`: the tasks table is the bulk of this page and a 3xl cap left its
    // columns fighting for room while the frame had it to spare. Padding stays - the rest is a
    // document of cards, not a bare grid.
    <PageContainer width='full' key={initiative.id}>
      {/* Header - every field edits inline (commit on blur). The title lives in the breadcrumb and
          status/delete in the top bar (see the `TopBarActions` below), so no page heading row. */}
      <header className='mb-6'>
        {/* No summary line at all: it is the first paragraph of the doc in the right-hand pane
            (see `docSummary`), so printing it here would be showing the same sentence twice. */}

        {/* One line: Kind and Owner take a quarter each, Slug the rest. Sort is drag-only on the
            board - it has no field here. */}
        <section className='grid grid-cols-1 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm) sm:grid-cols-4'>
          <Field label='Kind'>
            <KindSelect
              value={initiative.kind || 'general'}
              onChange={(k) => k !== initiative.kind && commit({ kind: k })}
              className='w-full'
            />
          </Field>
          <Field label='Owner'>
            <UserPicker value={initiative.owner} onChange={(id) => commit({ owner: id ?? '' })} />
          </Field>
          <Field label='Slug'>
            <InlineEdit
              key={initiative.id}
              defaultValue={initiative.id}
              aria-label='Slug'
              onCommit={renameSlug}
            />
          </Field>
          <Field label='Due date'>
            {/* A picker commits on selection - no half-typed state to defer, so no InlineEdit wrapper. */}
            <DateInput
              value={initiative.due_date ?? ''}
              ariaLabel='Due date'
              onChange={(v) => v !== (initiative.due_date ?? '') && commit({ due_date: v })}
            />
          </Field>

          {/* The three judgement dimensions. Two value axes rather than one priority number: a thing
              can be worth a lot to a customer and little to us, and collapsing that loses the
              argument you actually need to have. */}
          <Field label='Customer value'>
            <ValueSelect
              value={initiative.value_customer}
              ariaLabel='Customer value'
              onChange={(v) => v !== (initiative.value_customer ?? '') && commit({ value_customer: v })}
            />
          </Field>
          <Field label='Company value'>
            <ValueSelect
              value={initiative.value_company}
              ariaLabel='Company value'
              onChange={(v) => v !== (initiative.value_company ?? '') && commit({ value_company: v })}
            />
          </Field>
          {/* Read-only, and the only read-only field in this grid: an initiative's size IS the sum
              of its tasks' estimates, so the way to change it is to estimate a task. */}
          <Field label='Size'>
            <SizeRollup initiative={initiative} />
          </Field>
          <Field label='Priority'>
            <PriorityStars
              value={initiative.priority}
              onChange={(p) => commit({ priority: p ?? 0 })}
              className='h-8'
            />
          </Field>

          <Field label='Tags' className='sm:col-span-2'>
            <TagPicker
              value={initiative.tags}
              suggestions={allTags(data)}
              onChange={(tags) => tags.join(',') !== initiative.tags.join(',') && commit({ tags })}
            />
          </Field>
          <Field label='Depends on' className='sm:col-span-2'>
            <DependencyPicker
              value={initiative.blocked_by}
              initiatives={data}
              selfId={initiative.id}
              onChange={(ids) => {
                if (ids.join(',') === initiative.blocked_by.join(',')) return
                // The server refuses cycles and unknown ids; surface its reason rather than
                // silently leaving the picker showing an edit that never landed. `.message` only -
                // the transport's class name in front of it is noise to whoever is reading.
                void upsertInitiative({ id: initiative.id, blocked_by: ids }).catch((err: unknown) =>
                  window.alert(err instanceof Error ? err.message : String(err)),
                )
              }}
            />
          </Field>
        </section>

        <DependencySummary initiative={initiative} all={data} />
      </header>

      {/* Tasks - one flat list, every field editable in place (see `TaskList`). */}
      <section className='mb-8'>
        <div className='mb-3 flex items-center justify-between gap-2'>
          <h2 className='text-body-sm font-medium text-text'>
            Tasks{' '}
            <span className='text-label font-normal text-muted-foreground tabular-nums'>
              {openTasks} open · {initiative.tasks.length} total
            </span>
          </h2>
          <div className='flex items-center gap-2'>
            <TaskDoneTasksButton tasks={initiative.tasks} />
            <TaskColumnsButton />
            <Button variant='outline' size='sm' onClick={() => setNewTaskOpen(true)}>
              <Plus /> New task
            </Button>
          </div>
        </div>

        <TaskList initiative={initiative} tagSuggestions={allTags(data)} onOpenTask={openTask} />
      </section>


      {/* Bound signals - which signal this initiative drives lives behind the gear popover */}
      <section className='mb-8'>
        <div className='mb-3 flex items-center justify-between gap-2'>
          <h2 className='text-body-sm font-medium text-text'>Signals this drives</h2>
          <Popover>
            <PopoverTrigger
              aria-label='Configure the signals this initiative drives'
              title='Configure signals'
              className='flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent-tint hover:text-text'>
              <Settings2 className='size-3.5' />
            </PopoverTrigger>
            <PopoverContent align='end' side='bottom' className='w-96'>
              <span className='text-label text-muted-foreground'>Signals (drives)</span>
              <SignalSelect
                value={initiative.signal_ids}
                onChange={(ids) => {
                  if (ids.join(',') !== initiative.signal_ids.join(',')) commit({ signal_ids: ids })
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
        {boundSignal.length > 0 ? (
          <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
            {boundSignal.map((s) => (
              <SignalCard key={s.id} signal={s} />
            ))}
          </div>
        ) : (
          <p className='rounded-lg border border-dashed border-border px-4 py-6 text-center text-body-sm text-muted-foreground'>
            No signals bound yet - use the gear to pick what this initiative drives.
          </p>
        )}
      </section>

      {/* Target - enable/collapse card; the progress bar shows whenever a target is saved */}
      <TargetSection
        initiative={initiative}
        commit={commit}
        signal={initiative.target ? signalById.get(initiative.target.signal_id) : undefined}
      />
    </PageContainer>
  )

  return (
    <>
      {/* Status + delete belong to the record, so they ride in the top bar beside the breadcrumb
          that names it, immediately before the bell. */}
      <TopBarActions>
        <StatusSelect
          value={initiative.status}
          className='w-36'
          onChange={(s) => {
            // `done` is gated: refuse while tasks are still open and explain why in a dialog.
            if (s === 'done' && unresolvedTasks(initiative).length > 0) return setDoneGateOpen(true)
            commit({ status: s })
          }}
        />
        {/* Icon-only up here - the bar is tight, and a red trash with a tooltip reads as destructive
            without the word. The confirm is still what actually guards it. */}
        <Button
          variant='outline'
          size='icon-sm'
          onClick={onDelete}
          className='text-danger'
          title='Delete initiative'
          aria-label='Delete initiative'>
          <Trash2 />
        </Button>
      </TopBarActions>
      <SplitPane
        storageKey={appKey('split', 'initiative')}
        collapseLabel='rationale'
        left={left}
        right={<DocEditor key={initiative.id} kind='initiative' id={initiative.id} variant='panel' />}
      />
      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        initiativeId={initiative.id}
        defaultStatus='planned'
        existingTaskIds={initiative.tasks.map((t) => t.id)}
        onCreated={openTask}
      />
      <DoneGateDialog initiative={initiative} open={doneGateOpen} onOpenChange={setDoneGateOpen} />
    </>
  )
}

/**
 * The optional target, as its own collapsible card. The header's "Enable" checkbox IS the
 * lifecycle: checking it reveals the form (nothing persists until a signal is picked),
 * unchecking a saved target clears it server-side (`target_signal_id: ''`) after a confirm.
 * The chevron collapses the form only - the progress bar stays visible whenever a target is
 * saved, so a collapsed card still reads as a status widget.
 */
function TargetSection({
  initiative,
  commit,
  signal,
}: {
  initiative: Initiative
  commit: (patch: Partial<Parameters<typeof upsertInitiative>[0]>) => void
  signal?: Signal
}) {
  const hasTarget = !!initiative.target
  // Enabled-but-empty draft state (checkbox on, no signal picked yet, nothing saved).
  const [draft, setDraft] = useState(false)
  const [open, setOpen] = useState(true)
  const enabled = hasTarget || draft

  const toggleEnable = (): void => {
    if (!enabled) {
      setDraft(true)
      setOpen(true)
      return
    }
    if (!hasTarget) return setDraft(false)
    void confirm({
      title: 'Disable the target?',
      message: 'This clears the saved signal, value, by-date and baseline (the target alerts stop firing).',
      confirmLabel: 'Disable',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      commit({ target_signal_id: '' })
      setDraft(false)
    })
  }

  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className='mb-8 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <div className='flex items-center justify-between gap-2'>
        <button
          type='button'
          onClick={() => setOpen((o) => !o)}
          disabled={!enabled}
          aria-expanded={enabled && open}
          className={cn(
            'flex items-center gap-1 text-body-sm font-medium text-text',
            enabled && 'transition-colors hover:text-accent',
          )}>
          <Chevron className={cn('size-3.5 text-muted-foreground', !enabled && 'opacity-40')} />
          Target
        </button>
        <label className='flex cursor-pointer items-center gap-1.5 text-label text-muted-foreground'>
          Enable
          <Checkbox checked={enabled} onChange={toggleEnable} aria-label='Enable target' />
        </label>
      </div>
      {enabled && open && (
        <div className='mt-3 grid grid-cols-2 gap-x-4 gap-y-2'>
          <Field label='Signal id'>
            <SignalPicker
              value={initiative.target?.signal_id ?? ''}
              onChange={(id) => id !== (initiative.target?.signal_id ?? '') && commit({ target_signal_id: id })}
            />
          </Field>
          <Field label='Value'>
            <InlineEdit
              type='number'
              defaultValue={initiative.target?.value ?? ''}
              aria-label='Target value'
              onCommit={(v) => {
                const n = v === '' ? undefined : Number(v)
                if (n !== (initiative.target?.value ?? undefined)) commit({ target_value: n })
              }}
            />
          </Field>
          <Field label='By date'>
            {/* A picker commits on selection - there is no half-typed state to defer, which is why
                this one field does not use the InlineEdit commit-on-blur idiom around it. */}
            <DateInput
              value={initiative.target?.by_date ?? ''}
              ariaLabel='Target by date'
              onChange={(v) => v !== (initiative.target?.by_date ?? '') && commit({ target_by_date: v })}
            />
          </Field>
          <Field label='Baseline'>
            <InlineEdit
              type='number'
              defaultValue={initiative.target?.baseline ?? ''}
              aria-label='Target baseline'
              onCommit={(v) => {
                const n = v === '' ? undefined : Number(v)
                if (n !== (initiative.target?.baseline ?? undefined)) commit({ target_baseline: n })
              }}
            />
          </Field>
        </div>
      )}
      {initiative.target && <TargetProgress target={initiative.target} signal={signal} />}
    </section>
  )
}

/** The saved target's progress readout (signal, current/goal, bar) - the card's always-on part. */
function TargetProgress({ target, signal }: { target: NonNullable<Initiative['target']>; signal?: Signal }) {
  const current = signal ? (signal.points[signal.points.length - 1]?.value ?? 0) : (target.baseline ?? 0)
  const baseline = target.baseline ?? 0
  const span = target.value - baseline
  const pct = span <= 0 ? 0 : Math.max(0, Math.min(1, (current - baseline) / span))
  return (
    <div className='mt-3'>
      <div className='flex items-baseline justify-between gap-2'>
        {/* Friendly label; the raw id survives as the tooltip, and as the text itself when the
            binding no longer resolves to a live signal (never silently blank). */}
        <span className='text-label text-muted-foreground' title={target.signal_id}>
          {signal?.label ?? target.signal_id}
        </span>
        <span className='text-label text-muted-foreground tabular-nums'>
          {formatNumber(current)} / {formatNumber(target.value)}
          {target.by_date ? ` by ${target.by_date}` : ''}
        </span>
      </div>
      <div className='mt-2 h-2 w-full overflow-hidden rounded-full bg-accent-tint'>
        <div className='h-full rounded-full bg-accent transition-[width]' style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
      <div className='mt-1 text-label text-muted-foreground'>
        baseline {formatNumber(baseline)} · {Math.round(pct * 100)}% to goal
      </div>
    </div>
  )
}

/**
 * Both directions of the dependency graph, spelled out. `blocked_by` alone is half the picture -
 * what makes something a foundation is the list of things waiting on it, which the row itself does
 * not store. Renders nothing when the initiative is free-standing.
 */
function DependencySummary({ initiative, all }: { initiative: Initiative; all: Initiative[] }) {
  const dependents = all.filter((i) => i.blocked_by.includes(initiative.id))
  const blockers = initiative.blocked_by
    .map((id) => all.find((i) => i.id === id))
    .filter((i): i is Initiative => !!i)
  if (dependents.length === 0 && blockers.length === 0) return null

  const Row = ({ label, items }: { label: string; items: Initiative[] }) =>
    items.length === 0 ? null : (
      <div className='flex flex-wrap items-baseline gap-x-2 gap-y-1'>
        <span className='text-label text-muted-foreground'>{label}</span>
        {items.map((i) => (
          <Link
            key={i.id}
            to='/initiatives/$id'
            params={{ id: i.id }}
            className='text-body-sm text-accent underline-offset-2 hover:underline'>
            {i.title}
          </Link>
        ))}
      </div>
    )

  return (
    <section className='mt-3 flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-4 py-3 shadow-(--shadow-sm)'>
      <Row label={`Foundation for ${dependents.length}:`} items={dependents} />
      <Row label='Waits on:' items={blockers} />
    </section>
  )
}

/**
 * An initiative's size: the meter the board shows, plus the line that says how complete the sum
 * behind it is. The caveat is not decoration - a total taken over a list where half the tasks are
 * unestimated is a FLOOR, and a reader who cannot see that will plan against it as if it were not.
 */
function SizeRollup({ initiative }: { initiative: Initiative }) {
  const r = rollupEffort(initiative)
  return (
    <span className='flex flex-col gap-1'>
      <span className='flex h-8 items-center'>
        <EffortMeter rollup={r} />
      </span>
      <span className='text-label text-muted-foreground'>
        {r.counted === 0
          ? 'No tasks yet - add one and estimate it.'
          : r.hours === null
            ? `None of its ${r.counted} tasks carry an estimate.`
            : r.unsized > 0
              ? `Summed over ${r.counted - r.unsized} of ${r.counted} tasks - ${r.unsized} carry no estimate, so this is a floor.`
              : `Summed over all ${r.counted} tasks.`}
      </span>
    </span>
  )
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className='text-label text-muted-foreground'>{label}</span>
      {children}
    </label>
  )
}
