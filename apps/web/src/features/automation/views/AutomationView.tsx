import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import {
  ArrowLeft,
  Database,
  Download,
  History,
  Loader2,
  Play,
  RefreshCw,
  Terminal,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppShell, PageContainer, PageHeader, type NavItem, Button, Badge, UserChip } from '@silkweave/box-ui'
import { RunLogPane, RunStatusBadge, type RunStatus } from '@/lib/runLog.tsx'
import type { ProgressChunk } from '@/lib/useRuns.ts'
import { useGroupNav } from '../../../lib/nav.ts'
import {
  fetchRun,
  reloadRuns,
  runNow,
  useAutomationActions,
  useAutomationRuns,
  type AutomationAction,
  type AutomationRun,
  type AutomationRunWithLog,
} from '../lib/useAutomationData.ts'
import { formatDuration, relativeTime } from '../../../lib/format.ts'

const SECTIONS = ['runs', 'actions'] as const
type Section = (typeof SECTIONS)[number]

const SECTION_LABEL: Record<Section, string> = { runs: 'Schedule Runs', actions: 'Actions' }

/**
 * The Automation view - the operational surfaces: past runs of every action (scheduled or manual,
 * inspectable down to the stored log) and the manual live-run Actions console. The CONFIGURATION
 * lives under Settings → Schedules (old /automation/schedules links redirect there).
 */
export function AutomationView() {
  const groupNav = useGroupNav('automation')
  const params = useParams({ strict: false }) as { section?: string; runId?: string }
  const navigate = useNavigate()
  const section: Section = SECTIONS.includes(params.section as Section) ? (params.section as Section) : 'runs'
  const runId = params.section === 'runs' ? params.runId : undefined

  const { data: runs } = useAutomationRuns()
  const { data: actions } = useAutomationActions()

  const navItems: NavItem[] = [
    { id: 'runs', label: 'Schedule Runs', icon: History, count: runs?.length ?? 0 },
    { id: 'actions', label: 'Actions', icon: Terminal, count: actions?.length ?? 0 },
  ]
  const setSection = (s: string) =>
    void navigate(s === 'runs' ? { to: '/automation' } : { to: '/automation/$section', params: { section: s } })

  const crumbs = [{ label: 'Automation' }, { label: SECTION_LABEL[section] }]
  if (runId) crumbs.push({ label: runId })

  return (
    <AppShell
      items={navItems}
      activeId={section}
      onSelect={setSection}
      groupNav={groupNav}
      topbar={{ crumbs }}
>
      <PageContainer width='wide' className='flex h-full flex-col'>
        {section === 'actions' ? (
          <ActionsSection />
        ) : runId ? (
          <RunDetail runId={runId} onBack={() => setSection('runs')} />
        ) : (
          <RunsSection
            onOpen={(id) =>
              void navigate({ to: '/automation/$section/$runId', params: { section: 'runs', runId: id } })
            }
          />
        )}
      </PageContainer>
    </AppShell>
  )
}

// --- runs list ------------------------------------------------------------------------------------

const RUN_ROW = 'grid grid-cols-[110px_minmax(180px,1fr)_150px_110px_90px_minmax(220px,1.4fr)] items-center gap-2 px-3'

function RunsSection({ onOpen }: { onOpen: (id: string) => void }) {
  const { data: runs, error } = useAutomationRuns()
  const { data: actions } = useAutomationActions()
  const [refreshing, setRefreshing] = useState(false)

  const labelOf = useMemo(() => {
    const m = new Map((actions ?? []).map((a) => [a.id, a.label]))
    return (id: string) => m.get(id) ?? id
  }, [actions])

  // No local poll: the runs store polls itself while anything is in flight (see useAutomationData),
  // so this list stays live no matter where the run was started or watched.
  const refresh = () => {
    setRefreshing(true)
    void reloadRuns().finally(() => setRefreshing(false))
  }

  if (error) return <p className='text-body-sm text-danger'>{error}</p>
  if (!runs) return <p className='text-body-sm text-muted-foreground'>Loading…</p>

  return (
    <>
      <PageHeader
        title='Schedule runs'
        description='Every op execution - cron fires, dashboard runs, agent calls - newest first. Click a row to inspect its log.'
        actions={
          <Button variant='outline' size='sm' onClick={refresh} className='shrink-0'>
            <RefreshCw className={cn(refreshing && 'animate-spin')} /> Refresh
          </Button>
        }
      />

      {runs.length === 0 ? (
        <p className='rounded-lg border border-border bg-surface p-6 text-center text-body-sm text-muted-foreground'>
          No runs yet. Trigger one from Actions, from a schedule's Run now, or wait for a cron fire.
        </p>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-border bg-surface shadow-(--shadow-sm)'>
          <div className='min-w-[980px]'>
            <div className={cn(RUN_ROW, 'border-b border-border py-2 text-label font-medium text-muted-foreground')}>
              <span>Status</span>
              <span>Action</span>
              <span>Trigger</span>
              <span>Started</span>
              <span>Duration</span>
              <span>Outcome</span>
            </div>
            {runs.map((r) => (
              <button
                type='button'
                key={r.id}
                onClick={() => onOpen(r.id)}
                className={cn(RUN_ROW, 'w-full border-b border-border py-2 text-left text-body-sm last:border-0 hover:bg-accent-tint')}>
                <span>
                  <RunStatusBadge status={r.status as RunStatus} />
                </span>
                <span className='truncate text-text'>{labelOf(r.action_id)}</span>
                <TriggerCell run={r} />
                <span className='text-muted-foreground tabular-nums' title={r.started_at}>
                  {relativeTime(r.started_at)}
                </span>
                <span className='text-muted-foreground tabular-nums'>
                  {r.duration_ms != null ? formatDuration(r.duration_ms) : '-'}
                </span>
                <span className={cn('truncate', r.error ? 'text-danger' : 'text-muted-foreground')}>
                  {r.error ?? r.summary ?? '-'}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function TriggerCell({ run }: { run: AutomationRun }) {
  if (run.trigger === 'schedule')
    return (
      <span className='min-w-0'>
        <Badge variant='info' mono className='max-w-full truncate'>
          {run.schedule_id ?? 'schedule'}
        </Badge>
      </span>
    )
  return (
    <span className='inline-flex min-w-0 items-center gap-1.5 text-muted-foreground'>
      {run.triggered_by ? <UserChip userId={run.triggered_by} showName /> : 'manual'}
    </span>
  )
}

// --- run detail -----------------------------------------------------------------------------------

function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const [run, setRun] = useState<AutomationRunWithLog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { data: actions } = useAutomationActions()

  const active = run?.status === 'queued' || run?.status === 'running'
  const sawActive = useRef(false)
  useEffect(() => {
    let alive = true
    const load = () =>
      fetchRun(runId)
        .then((r) => {
          if (!alive) return
          const stillActive = r.status === 'queued' || r.status === 'running'
          // Watched it settle → push that into the shared runs cache so the list (and any other
          // consumer) agrees immediately instead of waiting for the next store poll.
          if (sawActive.current && !stillActive) void reloadRuns().catch(() => undefined)
          sawActive.current = stillActive
          setRun(r)
        })
        .catch((e) => alive && setError(String(e)))
    load()
    // A still-running row keeps refreshing until it settles (its log is written at finalization).
    const t = active ? setInterval(load, 5_000) : undefined
    return () => {
      alive = false
      if (t) clearInterval(t)
    }
  }, [runId, active])

  if (error) return <p className='text-body-sm text-danger'>{error}</p>
  if (!run) return <p className='text-body-sm text-muted-foreground'>Loading…</p>

  const label = actions?.find((a) => a.id === run.action_id)?.label ?? run.action_id
  const lines: ProgressChunk[] = run.log.map((l) => ({
    channel: l.channel,
    phase: l.phase as ProgressChunk['phase'],
    message: `${l.ts.slice(11, 19)}  ${l.message}`,
  }))

  const meta: { label: string; node: React.ReactNode }[] = [
    { label: 'Status', node: <RunStatusBadge status={run.status as RunStatus} /> },
    {
      label: 'Trigger',
      node:
        run.trigger === 'schedule' ? (
          <Badge variant='info' mono>{run.schedule_id ?? 'schedule'}</Badge>
        ) : run.triggered_by ? (
          <UserChip userId={run.triggered_by} showName />
        ) : (
          <span className='text-muted-foreground'>manual (unattributed)</span>
        ),
    },
    { label: 'Started', node: <span title={run.started_at}>{relativeTime(run.started_at)}</span> },
    {
      label: 'Duration',
      node: <span>{run.duration_ms != null ? formatDuration(run.duration_ms) : '-'}</span>,
    },
  ]

  return (
    <>
      <button
        type='button'
        onClick={onBack}
        className='mb-4 inline-flex items-center gap-1.5 text-label text-muted-foreground transition-colors hover:text-text'>
        <ArrowLeft className='size-3.5' /> All runs
      </button>

      <PageHeader
        className='mb-4'
        title={label}
        description={
          <code className='text-label'>
            {run.action_id} · {run.id}
          </code>
        }
      />

      <section className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
        {meta.map((m) => (
          <div key={m.label} className='rounded-lg border border-border bg-surface p-3 shadow-(--shadow-sm)'>
            <div className='text-label uppercase tracking-[0.06em] text-muted-foreground'>{m.label}</div>
            <div className='mt-1.5 text-body-sm text-text'>{m.node}</div>
          </div>
        ))}
      </section>

      {run.summary && <p className='mt-4 text-body-sm text-text'>{run.summary}</p>}
      {run.error && (
        <p className='mt-4 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-label text-danger'>
          {run.error}
        </p>
      )}

      <RunLogPane
        title='Run log'
        status={run.status as RunStatus}
        chunks={lines}
        emptyNote={
          active ? 'The log is written when the run finishes - this page refreshes itself.' : 'No log lines were recorded.'
        }
      />
    </>
  )
}

// --- actions (the manual live-run console, formerly the Ops view) ---------------------------------

const GROUP_ICON: Record<string, LucideIcon> = {
  Pulls: Download,
  Backfills: History,
  Warehouse: Database,
}

function ActionsSection() {
  const { data: fullCatalog, error } = useAutomationActions()
  // Parameterized actions (verify-engagement) can't run bare - their own view triggers them.
  const catalog = useMemo(() => fullCatalog?.filter((a) => !a.parameterized) ?? null, [fullCatalog])

  // Active run state. Chunks accrue from the subscription; unsubscribe ref tears down the previous
  // stream when a new run starts (or the view unmounts).
  const [activeAction, setActiveAction] = useState<AutomationAction | null>(null)
  const [lines, setLines] = useState<ProgressChunk[]>([])
  const [status, setStatus] = useState<RunStatus | null>(null)
  const subRef = useRef<{ unsubscribe: () => void } | null>(null)
  const logEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => () => subRef.current?.unsubscribe(), [])

  // Keep the log pane pinned to the latest line.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' })
  }, [lines])

  const groups = useMemo(() => [...new Set((catalog ?? []).map((a) => a.group))], [catalog])

  function run(action: AutomationAction): void {
    subRef.current?.unsubscribe()
    subRef.current = null
    setActiveAction(action)
    setLines([])
    setStatus('running')

    subRef.current = runNow(action.id, {
      onData: (p) => {
        setLines((prev) => [...prev, p])
        if (p.phase === 'done') setStatus('done')
      },
      onError: (err) => {
        setLines((prev) => [...prev, { channel: action.id, phase: 'done', message: `stream error: ${err.message}` }])
        setStatus('error')
      },
    })
  }

  if (error) return <p className='text-body-sm text-danger'>{error}</p>
  if (!catalog) return <p className='text-body-sm text-muted-foreground'>Loading…</p>

  return (
    <>
      <PageHeader
        title='Actions'
        description='Run any op now - progress streams here and every run lands in the run history, attributed to the active user.'
      />

      {groups.map((group) => {
        const Icon = GROUP_ICON[group] ?? Terminal
        return (
          <section key={group} className='mb-6'>
            <h2 className='mb-2 flex items-center gap-1.5 text-label font-medium uppercase tracking-[0.06em] text-muted-foreground'>
              <Icon className='size-3.5' /> {group}
            </h2>
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              {catalog
                .filter((a) => a.group === group)
                .map((action) => {
                  const active = activeAction?.id === action.id
                  return (
                    <div
                      key={action.id}
                      className={cn(
                        'flex items-start gap-3 rounded-lg border bg-surface p-4 shadow-(--shadow-sm)',
                        active && status === 'running' ? 'border-accent' : 'border-border',
                      )}>
                      <div className='min-w-0 flex-1'>
                        <div className='flex items-center gap-2 text-body font-medium text-text'>
                          {action.label}
                          {active && <RunStatusBadge status={status} />}
                        </div>
                        <p className='mt-1 text-body-sm text-muted-foreground'>{action.description}</p>
                        <div className='mt-1.5 flex items-center gap-2'>
                          <code className='text-label text-muted-foreground'>{action.id}</code>
                        </div>
                      </div>
                      <Button
                        variant='outline'
                        size='sm'
                        disabled={active && status === 'running'}
                        onClick={() => run(action)}>
                        {active && status === 'running' ? <Loader2 className='animate-spin' /> : <Play />}
                        Run
                      </Button>
                    </div>
                  )
                })}
            </div>
          </section>
        )
      })}

      <RunLogPane
        title={activeAction?.label ?? null}
        status={status}
        chunks={lines}
        emptyNote='Run an action to stream its progress here.'
        endRef={logEndRef}
      />
    </>
  )
}
