import { useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import { Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { confirm, Button, Badge, Dialog, DialogContent, DialogDescription, DialogTitle, PageContainer, PageHeader } from '@silkweave/box-ui'
import { RunLogPane, type RunStatus } from '@/lib/runLog.tsx'
import type { ProgressChunk } from '@/lib/useRuns.ts'
import { RestartServerButton } from '../components/RestartServerButton.tsx'
import {
  deleteSchedule,
  runNow,
  upsertSchedule,
  useAutomationActions,
  useAutomationSchedules,
  useAutomationStatus,
  type AutomationSchedule,
} from '../lib/useAutomationData.ts'
import { relativeTime } from '../../../lib/format.ts'

// =================================================================================================
// Schedules (Settings → Schedules) - the cron schedules in config/schedules.json (CRUD; changes
// need a server restart - surfaced by the TopBar button and the banner here). Moved out of the
// Automation view in the nav restructure: schedules are system configuration, run history stays
// under Automation. See features/automation/SPEC.md.
// =================================================================================================

const inputCls =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

export function SchedulesSection() {
  const { data, error } = useAutomationSchedules()
  const { data: status } = useAutomationStatus()
  const { data: actions } = useAutomationActions()
  const [editing, setEditing] = useState<AutomationSchedule | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  // Inline Run now stream (one at a time, like the Ops console).
  const [streamFor, setStreamFor] = useState<string | null>(null)
  const [lines, setLines] = useState<ProgressChunk[]>([])
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null)
  const subRef = useRef<{ unsubscribe: () => void } | null>(null)
  useEffect(() => () => subRef.current?.unsubscribe(), [])

  const runSchedule = (s: AutomationSchedule) => {
    subRef.current?.unsubscribe()
    setStreamFor(s.id)
    setLines([])
    setRunStatus('running')
    subRef.current = runNow(
      s.action_id,
      {
        onData: (p) => {
          setLines((prev) => [...prev, p])
          if (p.phase === 'done') setRunStatus('done')
        },
        onError: (e) => {
          setLines((prev) => [...prev, { channel: s.action_id, phase: 'done', message: `stream error: ${e.message}` }])
          setRunStatus('error')
        },
      },
      { scheduleId: s.id },
    )
  }

  let body: React.ReactNode
  if (error) body = <p className='text-body-sm text-danger'>{error}</p>
  else if (!data) body = <p className='text-body-sm text-muted-foreground'>Loading…</p>
  else
    body = (
      <>
        <PageHeader
          title='Schedules'
          description={
            <>
              Cron-scheduled ops from <code>config/schedules.json</code> - the scheduler loads it once at
              boot{data.disabled ? ' (timers NOT armed - set AUTOMATION_ENABLED=1 in .env to run them)' : ''}.
            </>
          }
          actions={
            <>
              <RestartServerButton />
              <Button size='sm' onClick={() => setCreateOpen(true)}>
                <Plus /> New schedule
              </Button>
            </>
          }
        />

        {(status?.restartRequired ?? data.restartRequired) && (
          <p className='mb-4 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-body-sm text-warning'>
            The config changed after the server started - schedule changes take effect after a restart.
          </p>
        )}

        {data.schedules.length === 0 ? (
          <p className='rounded-lg border border-border bg-surface p-6 text-center text-body-sm text-muted-foreground'>
            No schedules yet. Create one - e.g. a daily signals pull at 07:00 (<code>0 7 * * *</code>).
          </p>
        ) : (
          <div className='grid grid-cols-1 gap-3 lg:grid-cols-2'>
            {data.schedules.map((s) => (
              <div
                key={s.id}
                className={cn(
                  'flex flex-col gap-2 rounded-lg border bg-surface p-4 shadow-(--shadow-sm)',
                  s.valid ? 'border-border' : 'border-danger/40',
                )}>
                <div className='flex items-center gap-2'>
                  <span className='text-body font-medium text-text'>{s.id}</span>
                  <Badge variant={s.enabled ? 'success' : 'neutral'}>{s.enabled ? 'enabled' : 'disabled'}</Badge>
                  {!s.valid && <Badge variant='danger'>invalid</Badge>}
                  <span className='ml-auto flex items-center gap-0.5'>
                    <button
                      type='button'
                      title='Run now'
                      aria-label='Run now'
                      onClick={() => runSchedule(s)}
                      disabled={!s.valid}
                      className='rounded p-1 text-muted-foreground hover:bg-accent-tint hover:text-accent disabled:opacity-40'>
                      {streamFor === s.id && runStatus === 'running' ? (
                        <Loader2 className='size-3.5 animate-spin' />
                      ) : (
                        <Play className='size-3.5' />
                      )}
                    </button>
                    <button
                      type='button'
                      title='Edit'
                      aria-label='Edit schedule'
                      onClick={() => setEditing(s)}
                      className='rounded p-1 text-muted-foreground hover:bg-accent-tint hover:text-accent'>
                      <Pencil className='size-3.5' />
                    </button>
                    <button
                      type='button'
                      title='Delete'
                      aria-label='Delete schedule'
                      onClick={() =>
                        void confirm({ title: `Delete schedule "${s.id}"?`, confirmLabel: 'Delete', danger: true }).then(
                          (ok) => void (ok && deleteSchedule(s.id)),
                        )
                      }
                      className='rounded p-1 text-muted-foreground hover:bg-danger/10 hover:text-danger'>
                      <Trash2 className='size-3.5' />
                    </button>
                  </span>
                </div>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm'>
                  <code className='rounded bg-bg px-1.5 py-0.5 text-label text-text'>{s.cron}</code>
                  <span className='text-muted-foreground'>{s.human}</span>
                </div>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground'>
                  <span>
                    action <code>{s.action_id}</code>
                  </span>
                  {s.nextFire && <span title={s.nextFire}>next fire {relativeTime(s.nextFire)}</span>}
                  {s.problem && <span className='text-danger'>{s.problem}</span>}
                </div>
                {s.description && <p className='text-body-sm text-muted-foreground'>{s.description}</p>}
                <label className='mt-1 inline-flex w-fit cursor-pointer items-center gap-2 text-body-sm text-muted-foreground'>
                  <input
                    type='checkbox'
                    checked={s.enabled}
                    onChange={(e) => void upsertSchedule({ id: s.id, enabled: e.target.checked })}
                    className='accent-(--accent)'
                  />
                  Enabled
                </label>
              </div>
            ))}
          </div>
        )}

        {streamFor && (
          <RunLogPane
            title={`Run now - ${streamFor}`}
            status={runStatus}
            chunks={lines}
            emptyNote='Waiting for the first progress line…'
          />
        )}

        <ScheduleDialog
          open={createOpen || editing !== null}
          onOpenChange={(o) => {
            if (!o) {
              setCreateOpen(false)
              setEditing(null)
            }
          }}
          schedule={editing ?? undefined}
          actions={actions ?? []}
          existingIds={data.schedules.map((s) => s.id)}
        />
      </>
    )

  // Settings sections bring their own canvas container (the old one lived in the Automation view).
  return <PageContainer width='wide' className='flex h-full flex-col'>{body}</PageContainer>
}

// --- schedule create/edit dialog --------------------------------------------------------------------

function ScheduleDialog({
  open,
  onOpenChange,
  schedule,
  actions,
  existingIds,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  schedule?: AutomationSchedule
  actions: { id: string; label: string; group: string; parameterized?: boolean }[]
  existingIds: string[]
}) {
  const editing = !!schedule
  const [f, setF] = useState({ id: '', action_id: '', cron: '', description: '', enabled: true })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setF({
      id: schedule?.id ?? '',
      action_id: schedule?.action_id ?? '',
      cron: schedule?.cron ?? '',
      description: schedule?.description ?? '',
      enabled: schedule?.enabled ?? true,
    })
    setError(null)
    setSaving(false)
  }, [open, schedule])

  const id = editing ? schedule.id : slugify(f.id)
  const duplicate = !editing && !!id && existingIds.includes(id)

  // Parameterized actions (verify-engagement) take per-run args - a schedule can't carry them.
  const schedulable = actions.filter((a) => !a.parameterized)
  const groups = [...new Set(schedulable.map((a) => a.group))]

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return setError('An id is required (a-z, 0-9, -).')
    if (duplicate) return setError(`Schedule "${id}" already exists.`)
    if (!f.action_id) return setError('Pick an action.')
    if (!f.cron.trim()) return setError('A cron expression is required.')
    setSaving(true)
    // Cron + action validation is server-side (cron-parser); its rejection message surfaces here.
    void upsertSchedule({
      id,
      action_id: f.action_id,
      cron: f.cron.trim(),
      description: f.description.trim() || undefined,
      enabled: f.enabled,
    })
      .then(() => onOpenChange(false))
      .catch((err) => {
        setSaving(false)
        setError(String((err as Error)?.message ?? err))
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-lg'>
        <div className='flex flex-col gap-1'>
          <DialogTitle>{editing ? 'Edit schedule' : 'New schedule'}</DialogTitle>
          <DialogDescription>
            {editing ? (
              <code className='text-label'>{id}</code>
            ) : (
              'A cron-scheduled op, written to config/schedules.json. Takes effect after a server restart.'
            )}
          </DialogDescription>
        </div>

        <form onSubmit={submit} className='flex flex-col gap-3'>
          {!editing && (
            <Field label='Id'>
              <input
                value={f.id}
                onChange={(e) => {
                  setF((p) => ({ ...p, id: e.target.value }))
                  setError(null)
                }}
                placeholder='daily-github'
                className={inputCls}
              />
            </Field>
          )}
          <Field label='Action'>
            <select
              value={f.action_id}
              onChange={(e) => setF((p) => ({ ...p, action_id: e.target.value }))}
              className={inputCls}>
              <option value=''>Pick an action…</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {schedulable
                    .filter((a) => a.group === g)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label} ({a.id})
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label='Cron expression (server-local time)'>
            <input
              value={f.cron}
              onChange={(e) => setF((p) => ({ ...p, cron: e.target.value }))}
              placeholder='0 7 * * *'
              className={cn(inputCls, 'font-mono')}
            />
          </Field>
          <Field label='Description (optional)'>
            <input
              value={f.description}
              onChange={(e) => setF((p) => ({ ...p, description: e.target.value }))}
              className={inputCls}
            />
          </Field>
          <label className='inline-flex w-fit cursor-pointer items-center gap-2 text-body-sm text-text'>
            <input
              type='checkbox'
              checked={f.enabled}
              onChange={(e) => setF((p) => ({ ...p, enabled: e.target.checked }))}
              className='accent-(--accent)'
            />
            Enabled
          </label>

          {error && <p className='text-label text-danger'>{error}</p>}

          <div className='mt-1 flex items-center justify-end gap-2'>
            <Button type='button' variant='ghost' size='sm' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={saving || duplicate}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create schedule'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className='flex flex-col gap-1'>
      <span className='text-label text-muted-foreground'>{label}</span>
      {children}
    </label>
  )
}
