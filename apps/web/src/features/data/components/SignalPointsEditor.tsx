import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, StickyNote, Trash2, X } from 'lucide-react'
import type { SignalPointRow, SignalPointsPayload, Signal } from '../../../types.ts'
import { fetchSignalPoints, removeSignalPoint, saveSignalPoint, saveSignalPoints } from '../lib/useSignalsData.ts'
import { formatBucket, formatNumber, relativeTime } from '../../../lib/format.ts'
import { UserChip, Button, DateInput, Popover, PopoverContent, PopoverTrigger } from '@silkweave/box-ui'
import { cn } from '@/lib/utils'

const inputCls =
  'rounded-md border border-border bg-bg px-2 py-1 text-body-sm text-text transition-colors hover:border-accent/40 focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60'

/**
 * The manual-points surface on a signal detail page (phase B2): a table of the signal's manual
 * points (bucket, value, note, who, when) with inline add/edit/delete, plus a bulk paste box -
 * one `date[, time], value[, note]` line per row, previewed before commit, committed via the bulk
 * tool so twelve monthly points are one paste and zero dialogs.
 *
 * A manual point a live value currently overrides renders as SHADOWED, not hidden - it resurfaces
 * if the live source retreats (the read-side merge, see docs/WAREHOUSE.md). Timestamps are UTC
 * throughout, matching the warehouse convention; buckets are floored server-side to the signal's
 * interval.
 */
export function SignalPointsEditor({ signal }: { signal: Signal }) {
  const [data, setData] = useState<SignalPointsPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    setData(null)
    fetchSignalPoints(signal.id)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
    return () => {
      cancelled = true
    }
  }, [signal.id])

  const run = useCallback((op: () => Promise<SignalPointsPayload>) => {
    setBusy(true)
    setError(null)
    return op()
      .then((d) => {
        setData(d)
        return true
      })
      .catch((e) => {
        setError(String(e))
        return false
      })
      .finally(() => setBusy(false))
  }, [])

  if (error && !data) return <p className='text-body-sm text-danger'>{error}</p>
  if (!data) return null

  return (
    <section className='mt-8'>
      <h2 className='mb-1 text-label uppercase tracking-[0.07em] text-muted-foreground'>Manual points</h2>
      <p className='mb-3 text-body-sm text-muted-foreground'>
        Hand-entered values at {data.interval} grain (UTC). A live value wins its bucket; the manual
        point stays underneath and resurfaces if the live source retreats.
        {signal.data_source_id &&
          ' This signal is connected, so its live buckets belong to its source’s sync - correcting one here shadows that value rather than replacing it.'}
      </p>
      <PointsTable signal={signal} data={data} busy={busy} run={run} />
      {error && <p className='mt-2 text-label text-danger'>{error}</p>}
      <BulkPasteBox signal={signal} busy={busy} run={run} />
    </section>
  )
}

// --- the table + inline add/edit ------------------------------------------------------------------

function PointsTable({
  signal,
  data,
  busy,
  run,
}: {
  signal: Signal
  data: SignalPointsPayload
  busy: boolean
  run: (op: () => Promise<SignalPointsPayload>) => Promise<boolean>
}) {
  const hourly = data.interval === 'hour'
  const [editing, setEditing] = useState<string | null>(null) // bucket being edited
  const [value, setValue] = useState('')
  const [note, setNote] = useState('')

  // The inline add row.
  const [addDate, setAddDate] = useState('')
  const [addTime, setAddTime] = useState('')
  const [addValue, setAddValue] = useState('')
  const [addNote, setAddNote] = useState('')

  const rows = useMemo(() => [...data.points].sort((a, b) => b.bucket.localeCompare(a.bucket)), [data.points])

  const startEdit = (p: SignalPointRow) => {
    setEditing(p.bucket)
    setValue(String(p.value))
    setNote(p.note ?? '')
  }
  const saveEdit = (p: SignalPointRow) => {
    const v = Number(value)
    if (value.trim() === '' || Number.isNaN(v)) return
    void run(() => saveSignalPoint(signal.id, p.bucket, v, note)).then((ok) => {
      if (ok) setEditing(null)
    })
  }
  const add = () => {
    const v = Number(addValue)
    if (!addDate || addValue.trim() === '' || Number.isNaN(v)) return
    const at = hourly && addTime ? `${addDate}T${addTime}:00Z` : addDate
    void run(() => saveSignalPoint(signal.id, at, v, addNote || undefined)).then((ok) => {
      if (ok) {
        setAddDate('')
        setAddTime('')
        setAddValue('')
        setAddNote('')
      }
    })
  }

  return (
    // overflow-x-auto, not overflow-hidden: rows are single-line now (see NoteCell), so a narrow
    // viewport or a shadowed row that runs long must SCROLL rather than be silently clipped -
    // clipping loses the Updated column entirely with no way to reach it.
    <div className='overflow-x-auto rounded-lg border border-border'>
      <table className='w-full min-w-[36rem] text-body-sm'>
        <thead>
          <tr className='border-b border-border bg-surface text-left text-label uppercase tracking-[0.06em] text-muted-foreground'>
            <th className='px-3 py-2 font-medium'>Bucket</th>
            <th className='px-3 py-2 text-right font-medium'>Value</th>
            <th className='w-10 px-2 py-2 text-center font-medium'>Note</th>
            <th className='px-3 py-2 font-medium'>By</th>
            <th className='px-3 py-2 font-medium'>Updated</th>
            <th className='px-3 py-2' />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr className='border-b border-border bg-bg/40'>
              <td colSpan={6} className='px-3 py-3 text-muted-foreground'>
                No manual points yet - add one below, or paste a batch.
              </td>
            </tr>
          )}
          {rows.map((p) => {
            const shadowed = p.shadowed_by != null
            const isEditing = editing === p.bucket
            return (
              <tr key={p.bucket} className={cn('border-b border-border bg-bg/40', shadowed && 'opacity-70')}>
                {/* Day-grain and coarser buckets drop the "00:00" - it is always midnight, and the
                    six characters it costs are what pushed this row past the table's width. */}
                <td className='px-3 py-1.5 whitespace-nowrap tabular-nums text-muted-foreground'>
                  {hourly ? formatBucket(p.bucket) : p.bucket.slice(0, 10)}
                </td>
                <td className='px-3 py-1.5 text-right whitespace-nowrap tabular-nums text-text'>
                  {isEditing ? (
                    <input
                      type='number'
                      step='any'
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      className={cn(inputCls, 'w-28 text-right')}
                    />
                  ) : (
                    <>
                      {formatNumber(p.value)}
                      {shadowed && (
                        // Just "shadowed" - the live value moved into the tooltip. Spelled out it
                        // was the longest thing in any row and the one that pushed the table wide.
                        <span
                          className='ml-2 inline-flex items-center rounded border border-border bg-surface px-1.5 py-0.5 text-label text-muted-foreground'
                          title={`A live value of ${formatNumber(p.shadowed_by!)} currently wins this bucket; this manual point resurfaces if the live source retreats.`}>
                          shadowed
                        </span>
                      )}
                    </>
                  )}
                </td>
                {isEditing ? (
                  // Editing borrows the By + Updated columns for the note field: neither is editable,
                  // and it keeps the row one line high instead of growing a second.
                  <td className='px-3 py-1.5' colSpan={3}>
                    <input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder='note (optional)'
                      className={cn(inputCls, 'w-full')}
                      aria-label='Point note'
                    />
                  </td>
                ) : (
                  <>
                    <td className='px-2 py-1.5 text-center'>
                      <NoteCell note={p.note} />
                    </td>
                    <td className='px-3 py-1.5 whitespace-nowrap'>
                      <UserChip userId={p.updated_by ?? p.created_by} showName />
                    </td>
                    <td
                      className='px-3 py-1.5 whitespace-nowrap tabular-nums text-muted-foreground'
                      title={`${formatBucket(p.updated_at.slice(0, 16))} UTC`}>
                      {relativeTime(p.updated_at)}
                    </td>
                  </>
                )}
                <td className='px-3 py-1.5 text-right whitespace-nowrap'>
                  {isEditing ? (
                    <>
                      <Button size='xs' disabled={busy} onClick={() => saveEdit(p)}>
                        Save
                      </Button>
                      <Button size='icon-xs' variant='ghost' disabled={busy} onClick={() => setEditing(null)} title='Cancel'>
                        <X />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size='icon-xs' variant='ghost' disabled={busy} onClick={() => startEdit(p)} title='Edit point'>
                        <Pencil />
                      </Button>
                      <Button
                        size='icon-xs'
                        variant='ghost'
                        disabled={busy}
                        onClick={() => void run(() => removeSignalPoint(signal.id, p.bucket))}
                        title='Delete point'>
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            )
          })}
          {/* The inline add row. */}
          <tr className='bg-surface/60'>
            <td className='px-3 py-2 whitespace-nowrap'>
              <DateInput
                value={addDate}
                onChange={setAddDate}
                ariaLabel='Point date (UTC)'
                utc
              />
              {hourly && (
                <input
                  type='time'
                  value={addTime}
                  onChange={(e) => setAddTime(e.target.value)}
                  className={cn(inputCls, 'ml-1.5 w-24')}
                  aria-label='Point time (UTC)'
                />
              )}
            </td>
            <td className='px-3 py-2 text-right'>
              <input
                type='number'
                step='any'
                placeholder='value'
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                className={cn(inputCls, 'w-28 text-right')}
                aria-label='Point value'
              />
            </td>
            <td className='px-3 py-2' colSpan={3}>
              <input
                placeholder='note (optional)'
                value={addNote}
                onChange={(e) => setAddNote(e.target.value)}
                className={cn(inputCls, 'w-full')}
                aria-label='Point note'
              />
            </td>
            <td className='px-3 py-2 text-right'>
              <Button size='xs' variant='outline' disabled={busy || !addDate || addValue.trim() === ''} onClick={add}>
                <Plus /> Add
              </Button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

/**
 * A point's note as an icon that reveals the text on hover (or click/focus, which is what keeps it
 * reachable by keyboard and on touch). The note used to render inline, and a sentence like
 * a long import note ("imported from the vendor CLI daily snapshot") wrapped the row onto three lines - fifty of
 * those is an unreadable table. Nothing is truncated: the full note is in the popover.
 */
function NoteCell({ note }: { note: string | null }) {
  if (!note) return <span className='text-muted-foreground/50'>-</span>
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={120}
        aria-label='Show note'
        title={note}
        className='inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent-tint hover:text-text focus-visible:text-text'>
        <StickyNote className='size-3.5' />
      </PopoverTrigger>
      <PopoverContent side='top' className='w-64 gap-0 p-3 text-body-sm leading-relaxed'>
        {note}
      </PopoverContent>
    </Popover>
  )
}

// --- bulk paste -----------------------------------------------------------------------------------

interface ParsedLine {
  line: number
  raw: string
  at?: string
  value?: number
  note?: string
  error?: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?$/

/** Parse one pasted line: `date[, time], value[, note]` (comma- or tab-separated). */
function parseLine(raw: string, line: number): ParsedLine | null {
  const text = raw.trim()
  if (!text) return null
  const parts = text.split(/[,\t]/).map((s) => s.trim())
  if (parts.length < 2) return { line, raw, error: 'expected: date[, time], value[, note]' }
  const [date, ...rest] = parts
  if (!DATE_RE.test(date)) return { line, raw, error: `"${date}" is not a YYYY-MM-DD date` }
  let time: string | null = null
  if (TIME_RE.test(rest[0] ?? '')) {
    const [h, m, s] = rest.shift()!.split(':')
    time = `${h.padStart(2, '0')}:${m}:${s ?? '00'}`
  }
  if (rest.length === 0) return { line, raw, error: 'missing value' }
  const value = Number(rest.shift())
  if (Number.isNaN(value)) return { line, raw, error: 'value is not a number' }
  const note = rest.join(', ').trim()
  return {
    line,
    raw,
    at: time ? `${date}T${time}Z` : date,
    value,
    ...(note ? { note } : {}),
  }
}

function BulkPasteBox({
  signal,
  busy,
  run,
}: {
  signal: Signal
  busy: boolean
  run: (op: () => Promise<SignalPointsPayload>) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const parsed = useMemo(
    () => text.split('\n').map((raw, i) => parseLine(raw, i + 1)).filter((p): p is ParsedLine => p !== null),
    [text],
  )
  const bad = parsed.filter((p) => p.error)
  const good = parsed.filter((p) => !p.error)

  const commit = () => {
    void run(() =>
      saveSignalPoints(
        signal.id,
        good.map((p) => ({ at: p.at!, value: p.value!, ...(p.note ? { note: p.note } : {}) })),
      ),
    ).then((ok) => {
      if (ok) setText('')
    })
  }

  return (
    <div className='mt-4 rounded-lg border border-border bg-surface/50 p-3'>
      <div className='mb-1.5 text-label uppercase tracking-[0.06em] text-muted-foreground'>Bulk paste</div>
      <p className='mb-2 text-body-sm text-muted-foreground'>
        One <code>date[, time], value[, note]</code> line per row (UTC), e.g.{' '}
        <code>2025-09-01, 118000</code>. Buckets are floored to the signal&apos;s {signal.interval} grain
        on commit.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder={'2025-09-01, 118000\n2025-10-01, 121500, after the annual invoice'}
        className={cn(inputCls, 'w-full resize-y font-mono')}
      />
      {parsed.length > 0 && (
        <div className='mt-2 overflow-hidden rounded-md border border-border'>
          <table className='w-full text-body-sm'>
            <thead>
              <tr className='border-b border-border bg-surface text-left text-label uppercase tracking-[0.06em] text-muted-foreground'>
                <th className='px-3 py-1.5 font-medium'>Line</th>
                <th className='px-3 py-1.5 font-medium'>At (UTC)</th>
                <th className='px-3 py-1.5 text-right font-medium'>Value</th>
                <th className='px-3 py-1.5 font-medium'>Note</th>
              </tr>
            </thead>
            <tbody>
              {parsed.map((p) => (
                <tr key={p.line} className='border-b border-border bg-bg/40 last:border-0'>
                  <td className='px-3 py-1 tabular-nums text-muted-foreground'>{p.line}</td>
                  {p.error ? (
                    <td colSpan={3} className='px-3 py-1 text-danger'>
                      {p.error} - <code className='text-label'>{p.raw}</code>
                    </td>
                  ) : (
                    <>
                      <td className='px-3 py-1 tabular-nums text-text'>{formatBucket(p.at!)}</td>
                      <td className='px-3 py-1 text-right tabular-nums text-text'>{formatNumber(p.value!)}</td>
                      <td className='px-3 py-1 text-muted-foreground'>{p.note ?? ''}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className='mt-2 flex items-center justify-between gap-2'>
        <span className='text-label text-muted-foreground'>
          {parsed.length === 0
            ? ''
            : bad.length > 0
              ? `${bad.length} line(s) need fixing before commit`
              : `${good.length} point(s) ready`}
        </span>
        <Button size='sm' disabled={busy || good.length === 0 || bad.length > 0} onClick={commit}>
          Commit {good.length > 0 ? `${good.length} point(s)` : ''}
        </Button>
      </div>
    </div>
  )
}
