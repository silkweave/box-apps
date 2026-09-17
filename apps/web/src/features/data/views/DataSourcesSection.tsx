import { useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import { AlertTriangle, KeyRound, Loader2, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { confirm, Button, Badge, Dialog, DialogContent, DialogDescription, DialogTitle, PageContainer, PageHeader } from '@silkweave/box-ui'
import { RunLogPane, type RunStatus } from '@/lib/runLog.tsx'
import type { ProgressChunk } from '@/lib/useRuns.ts'
import { runNow } from '../../../lib/useRuns.ts'
import {
  deleteDataSource,
  reloadDataSources,
  upsertDataSource,
  useDataSources,
  useProviders,
} from '../lib/useSourcesData.ts'
import { relativeTime } from '../../../lib/format.ts'
import type { DataSource, Provider } from '../source-types.ts'

// =================================================================================================
// Data sources (Settings → Data sources) - the user-named instances of a registered provider that
// feed connected signals. Admin configuration, like Schedules: the server refuses a write from
// anyone else regardless of what this renders.
//
// The operating ritual this view is shaped around, because it is not guessable: create the source
// (it is born DISABLED) → hand-add its credential to config/credentials.json → Run now (the
// parameterized `source-sync`, which syncs disabled sources too) → read the log → flip Enabled so
// it rides the one `sources-sync` schedule. Secrets are never edited here; the card shows only
// whether each key resolves.
// =================================================================================================

const inputCls =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

/** Staleness is READ-SIDE only - no stored state, no alert rule. A source is stale when its last
 *  sync is older than ~2x the daily cadence every source runs on today; a never-synced source is
 *  not stale, it is simply new (and its card already says so). */
const STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000
const isStale = (s: DataSource): boolean =>
  s.status === 'enabled' && !!s.last_sync_at && Date.now() - new Date(s.last_sync_at).getTime() > STALE_AFTER_MS

export function DataSourcesSection() {
  const { data: sources, error } = useDataSources()
  const { data: providers } = useProviders()
  const [editing, setEditing] = useState<DataSource | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  // Inline Run now stream, one at a time - the Schedules/Ops console idiom.
  const [streamFor, setStreamFor] = useState<string | null>(null)
  const [lines, setLines] = useState<ProgressChunk[]>([])
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null)
  const subRef = useRef<{ unsubscribe: () => void } | null>(null)
  useEffect(() => () => subRef.current?.unsubscribe(), [])

  const sync = (s: DataSource) => {
    subRef.current?.unsubscribe()
    setStreamFor(s.id)
    setLines([])
    setRunStatus('running')
    subRef.current = runNow(
      'source-sync',
      {
        onData: (p) => {
          setLines((prev) => [...prev, p])
          if (p.phase === 'done') setRunStatus('done')
        },
        onError: (e) => {
          setLines((prev) => [...prev, { channel: s.id, phase: 'done', message: `stream error: ${e.message}` }])
          setRunStatus('error')
        },
        // The run stamps last_sync_* on the row; reload so the card's health line catches up.
        onComplete: () => void reloadDataSources().catch(() => undefined),
      },
      { params: { source_id: s.id } },
    )
  }

  const remove = async (s: DataSource) => {
    const ok = await confirm({
      title: `Delete data source "${s.label}"?`,
      message:
        (s.bound_signals.length > 0
          ? `${s.bound_signals.length} signal(s) are bound to it. They KEEP their points and stop refreshing, and their binding stays visible so you can re-point it.\n`
          : '') + 'Its credentials live in config/credentials.json and are not removed - clean them up by hand.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    const report = await deleteDataSource(s.id)
    if (report.warnings.length > 0) console.warn(`data-source-delete ${s.id}:`, report.warnings)
  }

  let body: React.ReactNode
  if (error) body = <p className='text-body-sm text-danger'>{error}</p>
  else if (!sources) body = <p className='text-body-sm text-muted-foreground'>Loading…</p>
  else
    body = (
      <>
        <PageHeader
          title='Data sources'
          description={
            <>
              Named instances of a provider - two platform spaces are two sources, each with its own
              key and its own sync health. A signal connects by binding one of a source&rsquo;s measures.
            </>
          }
          actions={
            <Button size='sm' disabled={!providers?.length} onClick={() => setCreateOpen(true)}>
              <Plus /> New source
            </Button>
          }
        />

        {sources.length === 0 ? (
          <p className='rounded-lg border border-border bg-surface p-6 text-center text-body-sm text-muted-foreground'>
            No data sources yet. Create one, add its credential to <code>config/credentials.json</code>, then
            Run now to check it before enabling.
          </p>
        ) : (
          <div className='grid grid-cols-1 gap-3 lg:grid-cols-2'>
            {sources.map((s) => (
              <SourceCard
                key={s.id}
                source={s}
                running={streamFor === s.id && runStatus === 'running'}
                onSync={() => sync(s)}
                onEdit={() => setEditing(s)}
                onDelete={() => void remove(s)}
              />
            ))}
          </div>
        )}

        {streamFor && (
          <RunLogPane
            title={`Sync - ${streamFor}`}
            status={runStatus}
            chunks={lines}
            emptyNote='Waiting for the first progress line…'
          />
        )}

        <SourceDialog
          open={createOpen || editing !== null}
          onOpenChange={(o) => {
            if (!o) {
              setCreateOpen(false)
              setEditing(null)
            }
          }}
          source={editing ?? undefined}
          providers={providers ?? []}
          existingIds={sources.map((x) => x.id)}
        />
      </>
    )

  return <PageContainer width='wide' className='flex h-full flex-col'>{body}</PageContainer>
}

function SourceCard({
  source: s,
  running,
  onSync,
  onEdit,
  onDelete,
}: {
  source: DataSource
  running: boolean
  onSync: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const missingKeys = Object.entries(s.credentials).filter(([, ok]) => !ok).map(([k]) => k)
  const failed = s.last_sync_status === 'error'
  const stale = isStale(s)

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border bg-surface p-4 shadow-(--shadow-sm)',
        failed || !s.provider_label ? 'border-danger/40' : 'border-border',
      )}>
      <div className='flex items-center gap-2'>
        <span className='text-body font-medium text-text'>{s.label}</span>
        <Badge variant={s.status === 'enabled' ? 'success' : 'neutral'}>{s.status}</Badge>
        {failed && <Badge variant='danger'>last sync failed</Badge>}
        {stale && !failed && <Badge variant='warning'>stale</Badge>}
        {!s.provider_label && <Badge variant='danger'>provider not registered</Badge>}
        <span className='ml-auto flex items-center gap-0.5'>
          <button
            type='button'
            title='Sync now (works on a disabled source - this is the supervised run)'
            aria-label='Sync now'
            onClick={onSync}
            disabled={!s.provider_label}
            className='rounded p-1 text-muted-foreground hover:bg-accent-tint hover:text-accent disabled:opacity-40'>
            {running ? <Loader2 className='size-3.5 animate-spin' /> : <Play className='size-3.5' />}
          </button>
          <button
            type='button'
            title='Edit'
            aria-label='Edit data source'
            onClick={onEdit}
            className='rounded p-1 text-muted-foreground hover:bg-accent-tint hover:text-accent'>
            <Pencil className='size-3.5' />
          </button>
          <button
            type='button'
            title='Delete'
            aria-label='Delete data source'
            onClick={onDelete}
            className='rounded p-1 text-muted-foreground hover:bg-danger/10 hover:text-danger'>
            <Trash2 className='size-3.5' />
          </button>
        </span>
      </div>

      <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground'>
        <code className='rounded bg-bg px-1.5 py-0.5 text-text'>{s.id}</code>
        <span>{s.provider_label ?? s.provider}</span>
        {Object.entries(s.config).map(([k, v]) => (
          <span key={k}>
            {k} <code className='text-text'>{v}</code>
          </span>
        ))}
      </div>

      {/* Health, the "Stripe connected to …, last measure received on …" line. Never-synced is a
          distinct state from failed - it is what a brand-new source looks like. */}
      <p className='text-body-sm text-muted-foreground'>
        {s.last_sync_at ? (
          <>
            <span className={failed ? 'text-danger' : stale ? 'text-warning' : 'text-success'}>●</span> Last synced{' '}
            <span title={s.last_sync_at}>{relativeTime(s.last_sync_at)}</span>
            {s.last_sync_points != null && ` · ${s.last_sync_points} points`}
          </>
        ) : (
          <>
            <span className='text-muted-foreground'>○</span> Never synced - Run now to check it before enabling.
          </>
        )}
      </p>
      {s.last_sync_error && (
        <p className='rounded-md border border-danger/30 bg-danger/5 px-2 py-1 font-mono text-label text-danger'>
          {s.last_sync_error}
        </p>
      )}

      {missingKeys.length > 0 && (
        <p className='flex items-start gap-1.5 text-label text-warning'>
          <KeyRound className='mt-px size-3.5 shrink-0' />
          <span>
            {missingKeys.join(', ')} not configured - add {missingKeys.length > 1 ? 'them' : 'it'} to{' '}
            <code>
              config/credentials.json → {s.provider} → {s.id}
            </code>
            .
          </span>
        </p>
      )}
      {s.dead_measures.length > 0 && (
        <p className='flex items-start gap-1.5 text-label text-warning'>
          <AlertTriangle className='mt-px size-3.5 shrink-0' />
          <span>
            {s.dead_measures.map((d) => `${d.signal_id} → ${d.measure_key}`).join(', ')} - the provider no longer
            offers that measure. The binding is left in place; re-point or clear it on the signal.
          </span>
        </p>
      )}

      <p className='text-label text-muted-foreground'>
        {s.bound_signals.length === 0
          ? 'No signals bound yet - a sync would have nothing to pull. Bind one from a signal’s edit dialog.'
          : `${s.bound_signals.length} signal${s.bound_signals.length === 1 ? '' : 's'} bound`}
      </p>
      {s.notes && <p className='text-body-sm text-muted-foreground'>{s.notes}</p>}

      <label className='mt-1 inline-flex w-fit cursor-pointer items-center gap-2 text-body-sm text-muted-foreground'>
        <input
          type='checkbox'
          checked={s.status === 'enabled'}
          onChange={(e) => void upsertDataSource({ id: s.id, status: e.target.checked ? 'enabled' : 'disabled' })}
          className='accent-(--accent)'
        />
        Enabled (rides the daily sources sync)
      </label>
    </div>
  )
}

// --- create/edit dialog ---------------------------------------------------------------------------

function SourceDialog({
  open,
  onOpenChange,
  source,
  providers,
  existingIds,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  source?: DataSource
  providers: Provider[]
  existingIds: string[]
}) {
  const editing = !!source
  const [f, setF] = useState({ id: '', provider: '', label: '', notes: '' })
  const [config, setConfig] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setF({
      id: source?.id ?? '',
      provider: source?.provider ?? providers[0]?.id ?? '',
      label: source?.label ?? '',
      notes: source?.notes ?? '',
    })
    setConfig(source?.config ?? {})
    setError(null)
    setSaving(false)
  }, [open, source, providers])

  // The id defaults to the slugified label (no enforced provider prefix - ids are global, and the
  // label is what a human already picked). Fixed once created: it keys the credentials entry and
  // the audit snapshots.
  const id = editing ? source.id : (slugify(f.id) || slugify(f.label))
  const duplicate = !editing && !!id && existingIds.includes(id)
  const provider = providers.find((p) => p.id === f.provider)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return setError('An id is required (a-z, 0-9, -).')
    if (duplicate) return setError(`Data source "${id}" already exists.`)
    if (!f.provider) return setError('Pick a provider.')
    setSaving(true)
    // Required/undeclared config fields are validated server-side; its message surfaces here.
    void upsertDataSource({
      id,
      ...(editing ? {} : { provider: f.provider }),
      label: f.label.trim() || id,
      config,
      notes: f.notes.trim(),
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
          <DialogTitle>{editing ? 'Edit data source' : 'New data source'}</DialogTitle>
          <DialogDescription>
            {editing ? (
              <code className='text-label'>{id}</code>
            ) : (
              'One instance of a provider. It is created disabled - add its credential, sync it once by hand, then enable it.'
            )}
          </DialogDescription>
        </div>

        <form onSubmit={submit} className='flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1'>
          <Field label='Provider'>
            <select
              value={f.provider}
              onChange={(e) => {
                setF((p) => ({ ...p, provider: e.target.value }))
                setConfig({})
              }}
              disabled={editing}
              title={editing ? 'Changing the provider would strand this source’s config and credentials' : undefined}
              className={inputCls}>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({p.measures.length} measures)
                </option>
              ))}
            </select>
          </Field>
          {provider && <p className='-mt-1 text-label text-muted-foreground'>{provider.description}</p>}

          <div className='grid grid-cols-2 gap-3'>
            <Field label='Name'>
              <input
                value={f.label}
                onChange={(e) => {
                  setF((p) => ({ ...p, label: e.target.value }))
                  setError(null)
                }}
                placeholder='Acme Team'
                className={inputCls}
              />
            </Field>
            <Field label={editing ? 'Id (fixed)' : 'Id (defaults to the name)'}>
              <input
                value={editing ? id : f.id}
                onChange={(e) => {
                  setF((p) => ({ ...p, id: e.target.value }))
                  setError(null)
                }}
                disabled={editing}
                placeholder={slugify(f.label) || 'acme-team'}
                className={inputCls}
              />
            </Field>
          </div>

          {provider && provider.config.length > 0 && (
            <fieldset className='rounded-md border border-border p-3'>
              <legend className='px-1 text-label text-muted-foreground'>Settings</legend>
              <div className='flex flex-col gap-3'>
                {provider.config.map((field) => (
                  <Field key={field.key} label={`${field.label}${field.required ? '' : ' (optional)'}`}>
                    <input
                      value={config[field.key] ?? ''}
                      onChange={(e) => setConfig((p) => ({ ...p, [field.key]: e.target.value }))}
                      className={inputCls}
                    />
                    {field.help && <span className='text-label text-muted-foreground'>{field.help}</span>}
                  </Field>
                ))}
              </div>
            </fieldset>
          )}

          {provider && provider.credentials.length > 0 && (
            <p className='rounded-md border border-border bg-bg px-3 py-2 text-label text-muted-foreground'>
              Needs <code className='text-text'>{provider.credentials.join(', ')}</code> in{' '}
              <code className='text-text'>
                config/credentials.json → {provider.id} → {id || '<id>'}
              </code>
              . Secrets are hand-edited on the server - there is no write path for them here.
            </p>
          )}

          <Field label='Notes (optional)'>
            <input value={f.notes} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} className={inputCls} />
          </Field>

          {error && <p className='text-label text-danger'>{error}</p>}

          <div className='mt-1 flex items-center justify-end gap-2'>
            <Button type='button' variant='ghost' size='sm' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={saving || duplicate}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Create source'}
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
