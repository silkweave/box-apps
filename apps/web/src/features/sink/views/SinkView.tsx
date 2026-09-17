import * as React from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Check, ClipboardCopy, ExternalLink, FileText, Loader2, Plus, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { confirm, PageContainer, PageHeader, type NavItem, Dialog, DialogContent, DialogDescription, DialogTitle, Button, AppShell } from '@silkweave/box-ui'
import { SinkBodyEditor } from '../components/SinkBodyEditorLazy'
import { useGroupNav } from '../../../lib/nav.ts'
import { trpc } from '../../../lib/trpc'
import { useDoc, type DocStatus } from '../../../lib/useDoc'
import { formatDateTime } from '../../../lib/format.ts'

interface SinkDocMeta {
  name: string
  path: string
  bytes: number
  modified: string
  excerpt: string
}

interface DocMeta {
  status: DocStatus
  editorUri: string
}

/**
 * Sink view - the docs/sink/ processing inbox. The index (`/sink`) shows the queue as a card grid with
 * Refresh / New in the top bar. Opening a file (`/sink/$file`) edits it in the shared TipTap markdown
 * editor with a single top bar that carries every action (save state, Copy /ingest-sink, VS Code,
 * Delete). The list is read live from the backend; Refresh re-reads it after files change on disk.
 */
export function SinkView() {
  const [docs, setDocs] = React.useState<SinkDocMeta[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [newOpen, setNewOpen] = React.useState(false)
  const [meta, setMeta] = React.useState<DocMeta | null>(null)
  const groupNav = useGroupNav('sink')
  const { file } = useParams({ strict: false }) as { file?: string }
  const navigate = useNavigate()

  const loadDocs = React.useCallback(() => {
    setRefreshing(true)
    return trpc.sinkDocs
      .query({})
      .then((d) => {
        setDocs(d.docs as SinkDocMeta[])
        setError(null)
      })
      .catch((e) => setError(String(e)))
      .finally(() => setRefreshing(false))
  }, [])

  React.useEffect(() => {
    void loadDocs()
  }, [loadDocs])

  const active = file ?? null
  // Clear the lifted editor meta whenever the active file changes; the detail pane re-reports it.
  React.useEffect(() => setMeta(null), [active])
  const onMeta = React.useCallback((m: DocMeta) => setMeta(m), [])

  const select = (name: string | null) =>
    void navigate(name ? { to: '/sink/$file', params: { file: name } } : { to: '/sink' })

  const remove = (name: string) => {
    void confirm({
      title: `Delete docs/sink/${name}?`,
      message: 'This removes the file from disk.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return
      void trpc.sinkDocDelete.mutate({ name }).then((d) => {
        setDocs(d.docs as SinkDocMeta[])
        select(null)
      })
    })
  }

  const navItems: NavItem[] = (docs ?? []).map((d) => ({ id: d.name, label: d.name, icon: FileText }))

  const actions = active ? (
    <DetailActions name={active} meta={meta} onDelete={() => remove(active)} />
  ) : (
    <IndexActions refreshing={refreshing} onRefresh={() => void loadDocs()} onNew={() => setNewOpen(true)} />
  )

  const shell = (children: React.ReactNode) => (
    <>
      <AppShell
        items={navItems}
        activeId={active ?? ''}
        onSelect={(id) => select(id)}
        groupNav={groupNav}
        topbar={{
          crumbs: active ? [{ label: 'Sink', onClick: () => select(null) }, { label: active }] : [{ label: 'Sink' }],
          actions,
        }}
>
        {children}
      </AppShell>
      <NewSinkDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        existing={(docs ?? []).map((d) => d.name)}
        onCreated={(name) => {
          setNewOpen(false)
          void loadDocs()
          select(name)
        }}
      />
    </>
  )

  if (error)
    return shell(
      <CenteredNote>
        Failed to load the sink: {error}
        <br />
        Is the backend running?
      </CenteredNote>,
    )
  if (!docs) return shell(<CenteredNote>Loading…</CenteredNote>)
  if (active) return shell(<SinkDetailPane key={active} name={active} onMeta={onMeta} />)
  return shell(<SinkCards docs={docs} onOpen={(name) => select(name)} onNew={() => setNewOpen(true)} />)
}

// --- index: card grid ----------------------------------------------------------------------------

function SinkCards({ docs, onOpen, onNew }: { docs: SinkDocMeta[]; onOpen: (name: string) => void; onNew: () => void }) {
  return (
    <PageContainer width='wide'>
      <PageHeader
        title='Sink'
        description={
          <>
            {docs.length === 0
              ? 'The processing inbox is empty.'
              : `${docs.length} doc${docs.length === 1 ? '' : 's'} awaiting processing.`}{' '}
            Open one to edit it, then copy <code>/ingest-sink &lt;file&gt;</code> to work it up.
          </>
        }
      />

      {docs.length === 0 ? (
        <div className='grid place-items-center rounded-lg border border-dashed border-border py-16 text-center text-body-sm text-muted-foreground'>
          <p>
            Hit <button type='button' onClick={onNew} className='font-medium text-accent hover:underline'>New</button> or
            drop a markdown file into <code>docs/sink/</code>.
          </p>
        </div>
      ) : (
        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'>
          {docs.map((d) => (
            <SinkCard key={d.name} doc={d} onOpen={() => onOpen(d.name)} />
          ))}
        </div>
      )}
    </PageContainer>
  )
}

function SinkCard({ doc, onOpen }: { doc: SinkDocMeta; onOpen: () => void }) {
  return (
    <div
      role='button'
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      className='group flex h-full cursor-pointer flex-col gap-2 rounded-lg border border-border bg-surface p-3 shadow-(--shadow-sm) transition-colors hover:border-accent/40'>
      <div className='flex items-center gap-2'>
        <FileText className='size-4 shrink-0 text-accent' />
        <span className='line-clamp-1 flex-1 break-all font-mono text-body-sm font-medium text-text'>{doc.name}</span>
      </div>
      <p className='line-clamp-3 min-h-[3.5em] text-label leading-relaxed text-muted-foreground'>
        {doc.excerpt || <span className='italic'>empty</span>}
      </p>
      <div className='mt-auto flex items-center gap-x-3 text-label text-muted-foreground'>
        <span>{fmtBytes(doc.bytes)}</span>
        <span className='ml-auto'>{fmtDate(doc.modified)}</span>
      </div>
    </div>
  )
}

// --- detail: editor body + lifted meta ------------------------------------------------------------

function SinkDetailPane({ name, onMeta }: { name: string; onMeta: (m: DocMeta) => void }) {
  const { content, status, editorUri, update } = useDoc('sink', name)
  React.useEffect(() => onMeta({ status, editorUri }), [status, editorUri, onMeta])
  return <SinkBodyEditor docKey={name} content={content} onChange={update} className='h-full min-h-0' />
}

// --- top-bar actions -----------------------------------------------------------------------------

function IndexActions({
  refreshing,
  onRefresh,
  onNew,
}: {
  refreshing: boolean
  onRefresh: () => void
  onNew: () => void
}) {
  return (
    <>
      <button
        type='button'
        onClick={onRefresh}
        disabled={refreshing}
        title='Refresh the file list'
        className='inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-label font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-text disabled:opacity-50'>
        <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} /> Refresh
      </button>
      <button
        type='button'
        onClick={onNew}
        title='New sink file'
        className='inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-label font-medium text-text transition-colors hover:bg-muted'>
        <Plus className='size-3.5' /> New
      </button>
    </>
  )
}

function DetailActions({ name, meta, onDelete }: { name: string; meta: DocMeta | null; onDelete: () => void }) {
  const [copied, setCopied] = React.useState(false)
  const copyCommand = () =>
    void navigator.clipboard.writeText(`/ingest-sink ${name}`).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })

  return (
    <>
      <SaveBadge status={meta?.status} />
      <button
        type='button'
        onClick={copyCommand}
        title='Copy the command to process this file in a Claude Code session'
        className='inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-label font-medium text-text transition-colors hover:bg-muted'>
        {copied ? <Check className='size-3.5 text-success' /> : <ClipboardCopy className='size-3.5' />}
        {copied ? 'Copied' : `Copy /ingest-sink ${name}`}
      </button>
      {meta?.editorUri && (
        <a
          href={meta.editorUri}
          title='Open in VS Code'
          className='inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-label font-medium text-muted-foreground transition-colors hover:text-text'>
          <ExternalLink className='size-3.5' /> VS Code
        </a>
      )}
      <button
        type='button'
        onClick={onDelete}
        title='Delete this file from the queue'
        className='inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-label font-medium text-danger transition-colors hover:bg-danger/10'>
        <Trash2 className='size-3.5' /> Delete
      </button>
    </>
  )
}

function SaveBadge({ status }: { status?: DocStatus }) {
  if (!status) return null
  const map: Record<DocStatus, { label: string; icon: React.ReactNode }> = {
    loading: { label: 'Loading…', icon: <Loader2 className='size-3 animate-spin' /> },
    saving: { label: 'Saving…', icon: <Loader2 className='size-3 animate-spin text-accent' /> },
    saved: { label: 'Saved', icon: <Check className='size-3 text-success' /> },
    dirty: { label: 'Unsaved…', icon: <span className='size-1.5 rounded-full bg-muted-foreground' /> },
    error: { label: 'Save failed', icon: <TriangleAlert className='size-3 text-danger' /> },
  }
  const m = map[status]
  return <span className='mr-1 inline-flex items-center gap-1 text-label text-muted-foreground'>{m.icon}{m.label}</span>
}

// --- new-file dialog -----------------------------------------------------------------------------

/** name → sink filename: lowercase, non-`[a-z0-9._-]` → '-', trimmed, ending in `.md`. */
const toFilename = (raw: string): string => {
  const stem = raw
    .trim()
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return stem ? `${stem}.md` : ''
}

function NewSinkDialog({
  open,
  onOpenChange,
  existing,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existing: string[]
  onCreated: (name: string) => void
}) {
  const [raw, setRaw] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setRaw('')
    setError(null)
    setSaving(false)
  }, [open])

  const name = toFilename(raw)
  const duplicate = !!name && existing.includes(name)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name) return setError('Enter a name (letters, digits, . _ -).')
    if (duplicate) return setError(`"${name}" already exists.`)
    setSaving(true)
    void trpc.sinkDocCreate
      .mutate({ name })
      .then(() => onCreated(name))
      .catch((err) => {
        setSaving(false)
        setError(String(err))
      })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-md'>
        <div className='flex flex-col gap-1'>
          <DialogTitle>New sink file</DialogTitle>
          <DialogDescription>
            {name ? <code className='text-label'>docs/sink/{name}</code> : 'A raw markdown doc to queue for processing.'}
          </DialogDescription>
        </div>

        <form onSubmit={submit} className='mt-2 flex flex-col gap-3'>
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input
            autoFocus
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value)
              setError(null)
            }}
            placeholder='Name, e.g. claude-max-plan-idea'
            className='w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'
          />

          {error && <p className='text-label text-danger'>{error}</p>}

          <div className='mt-1 flex items-center justify-end gap-2'>
            <Button type='button' variant='ghost' size='sm' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={saving || !name || duplicate}>
              {saving ? 'Creating…' : 'Create file'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// --- helpers -------------------------------------------------------------------------------------

const fmtBytes = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

const fmtDate = (iso: string): string => formatDateTime(iso)

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className='grid min-h-[60vh] place-items-center px-6 text-center text-body-sm leading-loose text-muted-foreground'>
      <p>{children}</p>
    </div>
  )
}
