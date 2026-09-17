import * as React from 'react'
import { ArrowLeft, Check, Copy, ExternalLink, PenLine, RotateCcw } from 'lucide-react'
import { Button, PageContainer } from '@silkweave/box-ui'
import { ChannelGlyph } from '@/lib/channelIcons.tsx'
import { GenerateButton } from '../../../../components/agent/GenerateCommand.tsx'
import { trpc } from '../../../../lib/trpc'
import { getActiveUserId } from '../../../../lib/useActiveUser.ts'
import { INBOX_CHANNEL_LABEL, KIND_LABEL, type InboxItem } from '../../inbox-types'

/** "2026-06-21T03:56:31Z" -> "Jun 21, 03:56"; '' -> ''. */
function whenLabel(iso: string): string {
  if (!iso) return ''
  const [date, time] = iso.split('T')
  const [, m, d] = (date ?? '').split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const hm = (time ?? '').slice(0, 5)
  return m && d ? `${months[Number(m) - 1]} ${Number(d)}${hm ? `, ${hm}` : ''}` : ''
}

interface InboxDraft {
  item_id: string
  channel: string
  body: string
  author: string | null
  updated_by: string | null
  updated_at: string
}

/**
 * Draft-reply panel (P3b) - a saved draft attached to the item (warehouse `inbox_drafts`), written
 * by the /draft-reply skill or edited here. Drafting hands off to the agent (sidebar, or copied
 * for a Claude Code session); nothing sends from the dashboard.
 */
function DraftPanel({ item }: { item: InboxItem }) {
  const [draft, setDraft] = React.useState<InboxDraft | null>(null)
  const [text, setText] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [copied, setCopied] = React.useState<'draft' | null>(null)
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    trpc.inboxDraftGet
      .mutate({ item_id: item.id })
      .then((r) => {
        if (!alive) return
        setDraft((r.draft as InboxDraft | null) ?? null)
        setText((r.draft as InboxDraft | null)?.body ?? '')
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
    return () => {
      alive = false
    }
  }, [item.id])

  const save = async () => {
    setBusy(true)
    try {
      const r = await trpc.inboxDraftSave.mutate({
        item_id: item.id,
        channel: item.channel,
        body: text,
        ...(getActiveUserId() ? { actor: getActiveUserId()! } : {}),
      })
      setDraft((r.draft as InboxDraft | null) ?? null)
      if (!r.draft) setText('')
    } finally {
      setBusy(false)
    }
  }

  const copy = (what: 'draft', value: string) => {
    void navigator.clipboard.writeText(value)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  const command = `/draft-reply ${item.id}`
  if (!loaded) return null

  return (
    <div className='mt-6 border-t border-border pt-4'>
      <div className='flex items-center gap-2 text-label uppercase tracking-[0.04em] text-muted-foreground'>
        <PenLine className='size-3.5' />
        Draft reply
        {draft?.updated_at && (
          <span className='ml-auto normal-case tracking-normal'>
            edited {whenLabel(draft.updated_at.replace(' ', 'T'))}
            {draft.updated_by ? ` by ${draft.updated_by}` : ''}
            {draft.author ? ` · voice: ${draft.author}` : ''}
          </span>
        )}
      </div>

      {draft || text ? (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={Math.min(10, Math.max(4, text.split('\n').length + 1))}
            className='mt-3 w-full resize-y rounded-md border border-border bg-background p-3 text-body-sm leading-relaxed text-text outline-none focus:border-accent'
          />
          <div className='mt-2 flex items-center gap-2'>
            <Button variant='secondary' size='sm' onClick={() => copy('draft', text)}>
              <Copy />
              {copied === 'draft' ? 'Copied' : 'Copy draft'}
            </Button>
            <span className='flex-1' />
            <Button variant='default' size='sm' disabled={busy || text === (draft?.body ?? '')} onClick={() => void save()}>
              {busy ? 'Saving…' : text.trim() ? 'Save draft' : 'Clear draft'}
            </Button>
          </div>
        </>
      ) : (
        <div className='mt-3 flex items-center gap-2'>
          <p className='text-body-sm text-muted-foreground'>
            No draft yet - write one here, or have Claude draft it in the owner's voice:
          </p>
          <GenerateButton
            label='Draft reply'
            command={command}
            title='Draft a reply to this item'
            description={
              <>
                Reads the thread behind this item and drafts a reply in the item owner's voice, saving
                it to this panel. It saves a <strong>draft</strong> only - it never posts or sends.
              </>
            }
          />
          <span className='flex-1' />
          <Button variant='secondary' size='sm' onClick={() => setText(' ')}>
            <PenLine />
            Write
          </Button>
        </div>
      )}
    </div>
  )
}

interface InboxItemDetailProps {
  item: InboxItem
  done: boolean
  onDone: (id: string) => void
  onReopen: (id: string) => void
  onBack: () => void
}

/**
 * One inbox item, full-page - the landing target of the Lark alert cards' "Open in dashboard"
 * button. Shows the FULL text (items derived from the events table carry it untruncated), the
 * external permalink to act on, and the completed lifecycle (Mark done / Undo). Replying itself
 * stays a human act on the platform - this page tracks the loop, it doesn't automate the response.
 */
export function InboxItemDetail({ item, done, onDone, onReopen, onBack }: InboxItemDetailProps) {
  const when = whenLabel(item.created_at)

  return (
    <PageContainer width='reading'>
      <button
        type='button'
        onClick={onBack}
        className='mb-5 inline-flex items-center gap-1.5 text-label font-medium text-muted-foreground transition-colors hover:text-text'>
        <ArrowLeft className='size-3.5' />
        Back to Replies
      </button>

      <div className='rounded-lg border border-border bg-surface p-6 shadow-(--shadow-sm)'>
        <div className='flex items-center gap-2 text-label uppercase tracking-[0.04em] text-muted-foreground'>
          <span className='inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 normal-case tracking-normal'>
            <ChannelGlyph channel={item.channel} className='size-3 shrink-0' />
            {INBOX_CHANNEL_LABEL[item.channel]} · {KIND_LABEL[item.kind]}
          </span>
          <span className='truncate'>{item.target}</span>
          {when && <span className='ml-auto shrink-0 tabular-nums'>{when}</span>}
          {done && <span className='shrink-0 rounded bg-muted px-1.5 py-0.5 normal-case tracking-normal'>done</span>}
        </div>

        <h1 className='mt-4 text-heading-2 font-semibold text-text'>
          <span className='text-accent'>@{item.author}</span>
          {item.title && item.title !== item.target ? <span className='text-muted-foreground'> · {item.title}</span> : null}
        </h1>

        {(item.body || item.snippet) && (
          <p className='mt-4 whitespace-pre-wrap text-body-sm leading-relaxed text-text'>{item.body || item.snippet}</p>
        )}

        <DraftPanel item={item} />

        <div className='mt-6 flex items-center gap-2 border-t border-border pt-4'>
          {item.url && (
            <Button variant='secondary' size='sm' render={<a href={item.url} target='_blank' rel='noreferrer' />}>
              <ExternalLink />
              Open thread
            </Button>
          )}
          <span className='flex-1' />
          {done ? (
            <Button variant='ghost' size='sm' onClick={() => onReopen(item.id)}>
              <RotateCcw />
              Undo
            </Button>
          ) : (
            <Button variant='default' size='sm' onClick={() => onDone(item.id)}>
              <Check />
              Mark completed
            </Button>
          )}
        </div>
      </div>
    </PageContainer>
  )
}
