import { useMemo, useState } from 'react'
import type * as React from 'react'
import { Pencil, Plus, Power, RefreshCw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { confirm, Button, Badge, Dialog, DialogContent, DialogDescription, DialogTitle, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, PageContainer, PageHeader } from '@silkweave/box-ui'
import { SignalPicker } from '../../data/components/SignalSelect.tsx'
import { relativeTime } from '../../../lib/format.ts'
import { signalLabel, signalMap } from '../../data/lib/signalLabel.ts'
import { useSignalsData } from '../../data/lib/useSignalsData.ts'
import {
  deleteAlertRule,
  reloadAlerts,
  saveAlertRule,
  useAlertRules,
  useAlerts,
  type Alert,
  type AlertRule,
  type AlertStatus,
} from '../lib/useAlertsData.ts'

// =================================================================================================
// The alerts sections, re-parented after the nav restructure (the standalone Alerts view is gone):
// the feed renders inside Automation → Alert Runs, the rule editor inside Settings → Rules. `Feed`
// is the recorded alert history - read-only, every candidate an evaluator matched, deduped, with
// its Lark delivery outcome. `Rules` surfaces AND edits the config/alerts.json rule set: the JSON
// file stays the single source of truth (the Schedules philosophy - no rules table); it's read
// fresh per evaluation, so edits apply on the next event without a restart. See features/alerts/SPEC.md.
// =================================================================================================

const STATUS_VARIANT: Record<AlertStatus, 'success' | 'info' | 'neutral' | 'danger'> = {
  delivered: 'success',
  pending: 'info',
  suppressed: 'neutral',
  error: 'danger',
}

// --- feed (Automation → Alert Runs) ----------------------------------------------------------------

const ALERT_ROW = 'grid grid-cols-[100px_minmax(240px,1fr)_130px_120px_110px] items-center gap-2 px-3'

export function AlertsFeedSection() {
  const { data: alerts, error } = useAlerts()
  const [refreshing, setRefreshing] = useState(false)

  const refresh = () => {
    setRefreshing(true)
    void reloadAlerts().finally(() => setRefreshing(false))
  }

  if (error) return <p className='text-body-sm text-danger'>{error}</p>
  if (!alerts) return <p className='text-body-sm text-muted-foreground'>Loading…</p>

  return (
    <>
      <PageHeader
        title='Alert runs'
        description='Every alert an evaluator matched - deduped, with its Lark delivery outcome - newest first.'
        actions={
          <Button variant='outline' size='sm' onClick={refresh} className='shrink-0'>
            <RefreshCw className={cn(refreshing && 'animate-spin')} /> Refresh
          </Button>
        }
      />

      {alerts.length === 0 ? (
        <p className='rounded-lg border border-border bg-surface p-6 text-center text-body-sm text-muted-foreground'>
          No alerts yet. When an evaluator (e.g. <code>alerts-reddit</code>) matches a rule, the fresh
          alerts land here.
        </p>
      ) : (
        <div className='overflow-x-auto rounded-lg border border-border bg-surface shadow-(--shadow-sm)'>
          <div className='min-w-[820px]'>
            <div className={cn(ALERT_ROW, 'border-b border-border py-2 text-label font-medium text-muted-foreground')}>
              <span>Status</span>
              <span>Message</span>
              <span>Rule</span>
              <span>Route</span>
              <span>When</span>
            </div>
            {alerts.map((a) => (
              <AlertRow key={a.id} alert={a} />
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function AlertRow({ alert: a }: { alert: Alert }) {
  const when = a.delivered_at ?? a.event_at ?? a.created_at
  return (
    <div className={cn(ALERT_ROW, 'border-b border-border py-2 text-body-sm last:border-0')}>
      <span>
        <Badge variant={STATUS_VARIANT[a.status]}>{a.status}</Badge>
      </span>
      <span className='min-w-0'>
        <span className='block truncate text-text' title={a.message}>
          {a.message}
        </span>
        {a.error && <span className='block truncate text-label text-danger' title={a.error}>{a.error}</span>}
      </span>
      <span className='min-w-0'>
        <code className='truncate text-label text-muted-foreground'>{a.rule_id}</code>
      </span>
      <span className='min-w-0'>
        <code className='truncate text-label text-muted-foreground' title={a.target ?? undefined}>
          {a.route}
        </code>
      </span>
      <span className='text-muted-foreground tabular-nums' title={when}>
        {relativeTime(when)}
      </span>
    </div>
  )
}

// --- rules (Settings → Rules) ----------------------------------------------------------------------

/** Event kinds the evaluators emit today (the dialog's suggestions - free text stays allowed). */
const EVENT_KINDS = [
  'reddit.inbox',
  'github.notification',
  'github.pr_merged',
  'github.star',
  'run.error',
  'signal.increase',
  'signal.threshold',
  'x.reply',
  'x.mention',
  'x.quote',
  'x.repost',
  'x.like',
  'x.follow',
  'traction.spike',
  'digest.daily',
]

export function AlertRulesSection() {
  const { data: rules, error } = useAlertRules()
  const [dialog, setDialog] = useState<{ mode: 'new' } | { mode: 'edit'; rule: AlertRule } | null>(null)
  const grouped = useMemo(() => {
    const m = new Map<string, typeof rules>()
    for (const r of rules ?? []) {
      const arr = m.get(r.event) ?? []
      arr.push(r)
      m.set(r.event, arr)
    }
    return [...m.entries()]
  }, [rules])

  let body: React.ReactNode
  if (error) body = <p className='text-body-sm text-danger'>{error}</p>
  else if (!rules) body = <p className='text-body-sm text-muted-foreground'>Loading…</p>
  else
    body = (
      <>
        <PageHeader
          title='Rules'
          description={
            <>
              The alert rules from <code>config/alerts.json</code> - grouped by the event kind they
              listen for. Edits write that file and apply on the next evaluation (no restart).
            </>
          }
          actions={
            <Button size='sm' onClick={() => setDialog({ mode: 'new' })} className='shrink-0'>
              <Plus /> New rule
            </Button>
          }
        />

        {rules.length === 0 ? (
          <p className='rounded-lg border border-border bg-surface p-6 text-center text-body-sm text-muted-foreground'>
            No rules configured yet - hit <span className='font-medium text-text'>New rule</span> to add
            the first one.
          </p>
        ) : (
          <div className='flex flex-col gap-6'>
            {grouped.map(([event, evtRules]) => (
              <section key={event}>
                <h2 className='mb-2 flex items-center gap-1.5 text-label font-medium uppercase tracking-[0.06em] text-muted-foreground'>
                  <code className='text-label text-muted-foreground'>{event}</code>
                </h2>
                <div className='grid grid-cols-1 gap-3 lg:grid-cols-2'>
                  {(evtRules ?? []).map((r) => (
                    <RuleCard key={r.id} rule={r} onEdit={() => setDialog({ mode: 'edit', rule: r })} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <RuleDialog
          key={dialog?.mode === 'edit' ? dialog.rule.id : 'new'}
          state={dialog}
          existingIds={rules.map((r) => r.id)}
          onClose={() => setDialog(null)}
        />
      </>
    )

  // Settings sections bring their own canvas container (the old one lived in the Alerts view).
  return <PageContainer width='wide' className='flex h-full flex-col'>{body}</PageContainer>
}

function RuleCard({ rule: r, onEdit }: { rule: AlertRule; onEdit: () => void }) {
  // Ids are for the config file; the card names the signal the way the rest of the app does.
  const byId = signalMap(useSignalsData().data)
  const [busy, setBusy] = useState(false)

  const toggle = () => {
    setBusy(true)
    void saveAlertRule({ ...r, enabled: !r.enabled }).finally(() => setBusy(false))
  }
  const onDelete = () => {
    void confirm({
      title: `Delete rule "${r.id}"?`,
      message: 'Recorded alerts stay in the feed; no new ones will fire.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => void (ok && deleteAlertRule(r.id)))
  }

  return (
    <div
      className={cn(
        'group flex flex-col gap-2 rounded-lg border bg-surface p-4 shadow-(--shadow-sm) transition-colors hover:border-accent/40',
        r.enabled ? 'border-border' : 'border-border opacity-60',
      )}>
      <div className='flex items-center gap-2'>
        <span className='text-body font-medium text-text'>{r.id}</span>
        <Badge variant={r.enabled ? 'success' : 'neutral'}>{r.enabled ? 'enabled' : 'disabled'}</Badge>
        {r.notify === 'digest' && <Badge variant='info'>digest</Badge>}
        {r.cooldown_min ? (
          <Badge variant='info' mono>{r.cooldown_min}m cooldown</Badge>
        ) : null}
        <div className='ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100'>
          <button
            type='button'
            onClick={toggle}
            disabled={busy}
            title={r.enabled ? 'Disable' : 'Enable'}
            aria-label={r.enabled ? 'Disable rule' : 'Enable rule'}
            className='rounded p-1 text-muted-foreground hover:bg-accent-tint hover:text-accent disabled:opacity-50'>
            <Power className='size-3.5' />
          </button>
          <button
            type='button'
            onClick={onEdit}
            title='Edit'
            aria-label='Edit rule'
            className='rounded p-1 text-muted-foreground hover:bg-accent-tint hover:text-accent'>
            <Pencil className='size-3.5' />
          </button>
          <button
            type='button'
            onClick={onDelete}
            title='Delete'
            aria-label='Delete rule'
            className='rounded p-1 text-muted-foreground hover:bg-danger/10 hover:text-danger'>
            <Trash2 className='size-3.5' />
          </button>
        </div>
      </div>
      <p className='text-body-sm text-text'>{r.message}</p>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground'>
        <span>
          route <code>{r.route}</code>
        </span>
        {r.signal_id && (
          <span title={r.signal_id}>
            signal <span className='text-text'>{signalLabel(byId, r.signal_id)}</span>
          </span>
        )}
        {r.threshold != null && (
          <span>
            threshold <code>{r.threshold}</code>
          </span>
        )}
        {r.debounce_sec != null && (
          <span>
            debounce <code>{r.debounce_sec}s</code>
          </span>
        )}
        {r.tiers && (
          <span>
            tiers <code>{r.tiers.join('/')}</code>
          </span>
        )}
      </div>
    </div>
  )
}

// --- rule dialog ------------------------------------------------------------------------------------

const inputCls =
  'w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none'

type RuleDialogState = { mode: 'new' } | { mode: 'edit'; rule: AlertRule } | null

/** Optional-number field state: keep the raw string, parse on submit ('' = unset). */
const parseNum = (s: string): number | undefined => (s.trim() === '' ? undefined : Number(s))

function RuleDialog({
  state,
  existingIds,
  onClose,
}: {
  state: RuleDialogState
  existingIds: string[]
  onClose: () => void
}) {
  const editing = state?.mode === 'edit' ? state.rule : null
  const [id, setId] = useState(editing?.id ?? '')
  const [event, setEvent] = useState(editing?.event ?? '')
  // `owner` is the right default for a NEW rule: it resolves at delivery to whoever owns the
  // thing the alert is about, so the rule is useful before anyone edits it and it names no person.
  const [route, setRoute] = useState(editing?.route ?? 'owner')
  const [message, setMessage] = useState(editing?.message ?? '')
  const [notify, setNotify] = useState<'realtime' | 'digest'>(editing?.notify ?? 'realtime')
  const [cooldown, setCooldown] = useState(editing?.cooldown_min != null ? String(editing.cooldown_min) : '')
  const [debounce, setDebounce] = useState(editing?.debounce_sec != null ? String(editing.debounce_sec) : '')
  const [signalId, setSignalId] = useState(editing?.signal_id ?? '')
  const [threshold, setThreshold] = useState(editing?.threshold != null ? String(editing.threshold) : '')
  const [tiers, setTiers] = useState(editing?.tiers?.join(', ') ?? '')
  const [enabled, setEnabled] = useState(editing?.enabled ?? true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const open = state !== null
  const isSignal = event.startsWith('signal.')
  const isTraction = event === 'traction.spike'
  const duplicate = !editing && !!id && existingIds.includes(id)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (duplicate) return setError(`A rule with id "${id}" already exists.`)
    const tierNums = tiers
      .split(/[,\s]+/)
      .filter(Boolean)
      .map(Number)
    if (tierNums.some(Number.isNaN)) return setError('Tiers must be numbers (comma-separated).')
    setSaving(true)
    void saveAlertRule({
      id: id.trim(),
      event: event.trim(),
      route: route.trim(),
      message,
      enabled,
      ...(notify === 'digest' ? { notify } : {}),
      ...(parseNum(cooldown) !== undefined ? { cooldown_min: parseNum(cooldown) } : {}),
      ...(parseNum(debounce) !== undefined ? { debounce_sec: parseNum(debounce) } : {}),
      ...(isSignal && signalId.trim() ? { signal_id: signalId.trim() } : {}),
      ...(isSignal && parseNum(threshold) !== undefined ? { threshold: parseNum(threshold) } : {}),
      ...(isTraction && tierNums.length > 0 ? { tiers: tierNums } : {}),
    })
      .then(onClose)
      .catch((err) => {
        setSaving(false)
        setError(String(err))
      })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='max-w-lg'>
        <div className='flex flex-col gap-1'>
          <DialogTitle>{editing ? 'Edit rule' : 'New rule'}</DialogTitle>
          <DialogDescription>
            {editing ? (
              <code className='text-label'>id: {editing.id}</code>
            ) : (
              'Listens for an event kind and renders the message from its fields.'
            )}
          </DialogDescription>
        </div>

        <form onSubmit={submit} className='mt-2 flex flex-col gap-3'>
          <div className='grid grid-cols-2 gap-2'>
            {!editing && (
              <label className='flex flex-col gap-1 text-label text-muted-foreground'>
                Rule id
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <input
                  autoFocus
                  value={id}
                  onChange={(e) => {
                    setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-'))
                    setError(null)
                  }}
                  placeholder='e.g. x-reply'
                  className={inputCls}
                  required
                />
              </label>
            )}
            <label className='flex flex-col gap-1 text-label text-muted-foreground'>
              Event kind
              <input
                value={event}
                onChange={(e) => setEvent(e.target.value)}
                placeholder='e.g. x.reply'
                list='alert-event-kinds'
                className={inputCls}
                required
              />
              <datalist id='alert-event-kinds'>
                {EVENT_KINDS.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
            </label>
            <label className='flex flex-col gap-1 text-label text-muted-foreground'>
              Route
              <input
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                placeholder='owner | user:<id> | channel'
                className={inputCls}
                required
              />
            </label>
            <label className='flex flex-col gap-1 text-label text-muted-foreground'>
              Notify class
              <Select
                value={notify}
                onValueChange={(v) => setNotify(v as 'realtime' | 'digest')}
                items={[
                  { value: 'realtime', label: 'realtime - batched DM card' },
                  { value: 'digest', label: 'digest - daily recap only' },
                ]}>
                <SelectTrigger aria-label='Notify class' className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='realtime'>realtime - batched DM card</SelectItem>
                  <SelectItem value='digest'>digest - daily recap only</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>

          <label className='flex flex-col gap-1 text-label text-muted-foreground'>
            Message template <span className='text-fg-4'>{'{field}'} tokens fill from the event</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder='💬 @{author} replied: "{text}" - {url}'
              rows={2}
              className={cn(inputCls, 'resize-y')}
              required
            />
          </label>

          <div className='grid grid-cols-2 gap-2'>
            <label className='flex flex-col gap-1 text-label text-muted-foreground'>
              Cooldown (min) <span className='text-fg-4'>suppression window; empty = none</span>
              <input value={cooldown} onChange={(e) => setCooldown(e.target.value)} inputMode='numeric' placeholder='0' className={inputCls} />
            </label>
            <label className='flex flex-col gap-1 text-label text-muted-foreground'>
              Debounce (sec) <span className='text-fg-4'>flush delay; empty = default 300</span>
              <input value={debounce} onChange={(e) => setDebounce(e.target.value)} inputMode='numeric' placeholder='300' className={inputCls} />
            </label>
          </div>

          {isSignal && (
            <div className='grid grid-cols-2 gap-2'>
              <label className='flex flex-col gap-1 text-label text-muted-foreground'>
                Signal <span className='text-fg-4'>required for signal.*</span>
                {/* The same picker the initiatives use: search by friendly name, store the id. */}
                <SignalPicker value={signalId} onChange={setSignalId} placeholder='pick a signal…' />
              </label>
              {event === 'signal.threshold' && (
                <label className='flex flex-col gap-1 text-label text-muted-foreground'>
                  Threshold <span className='text-fg-4'>value to reach/cross</span>
                  <input value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode='numeric' placeholder='50' className={inputCls} required />
                </label>
              )}
            </div>
          )}

          {isTraction && (
            <label className='flex flex-col gap-1 text-label text-muted-foreground'>
              Tiers <span className='text-fg-4'>engagement ladder, comma-separated</span>
              <input value={tiers} onChange={(e) => setTiers(e.target.value)} placeholder='10, 25, 50, 100, 250' className={inputCls} />
            </label>
          )}

          <label className='flex items-center gap-2 text-body-sm text-text'>
            <input type='checkbox' checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className='size-3.5 accent-(--color-accent)' />
            Enabled
          </label>

          {error && <p className='text-label text-danger'>{error}</p>}

          <div className='mt-1 flex items-center justify-end gap-2'>
            <Button type='button' variant='ghost' size='sm' onClick={onClose}>
              Cancel
            </Button>
            <Button type='submit' size='sm' disabled={saving || duplicate || !id.trim() || !event.trim() || !message.trim()}>
              {saving ? 'Saving…' : editing ? 'Save' : 'Create rule'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
