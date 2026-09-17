import { useState } from 'react'
import Editor from 'react-simple-code-editor'
import Prism from 'prismjs'
import 'prismjs/components/prism-json'
import { Check, ExternalLink, PencilLine } from 'lucide-react'
import { Button } from '@silkweave/box-ui'
import { upsertTask } from '../lib/usePlanningData.ts'

const pretty = (m: Record<string, unknown>) => JSON.stringify(m, null, 2)

/**
 * Task metadata is a free-form JSON bag. View mode renders it as a key/value list (with the `repo`
 * key linked); Edit mode swaps in a react-simple-code-editor JSON surface that validates on save and
 * writes back via task-upsert (which takes metadata as a JSON string).
 */
export function MetadataEditor({ taskId, metadata, url }: { taskId: string; metadata: Record<string, unknown>; url: string | null }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(() => pretty(metadata))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const startEdit = () => {
    setText(pretty(metadata))
    setError(null)
    setEditing(true)
  }

  const save = () => {
    let parsed: unknown
    try {
      parsed = text.trim() === '' ? {} : JSON.parse(text)
    } catch (e) {
      return setError(`Invalid JSON: ${(e as Error).message}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return setError('Metadata must be a JSON object.')
    }
    setSaving(true)
    void upsertTask({ id: taskId, metadata: JSON.stringify(parsed) })
      .then(() => {
        setSaving(false)
        setEditing(false)
      })
      .catch((err) => {
        setSaving(false)
        setError(String(err))
      })
  }

  return (
    <section className='mb-6 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <div className='mb-2 flex items-center justify-between gap-2'>
        <h2 className='text-body-sm font-medium text-text'>Metadata</h2>
        {editing ? (
          <div className='flex items-center gap-2'>
            <Button variant='ghost' size='xs' onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size='xs' onClick={save} disabled={saving}>
              <Check /> {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : (
          <Button variant='ghost' size='xs' onClick={startEdit}>
            <PencilLine /> Edit
          </Button>
        )}
      </div>

      {editing ? (
        <div className='flex flex-col gap-2'>
          <div className='cp-code-editor overflow-auto rounded-md border border-border bg-bg'>
            <Editor
              value={text}
              onValueChange={(v) => {
                setText(v)
                setError(null)
              }}
              highlight={(code) => Prism.highlight(code, Prism.languages.json, 'json')}
              padding={12}
              textareaClassName='focus:outline-none'
              className='min-h-[10rem] font-mono text-code'
            />
          </div>
          {error && <p className='text-label text-danger'>{error}</p>}
        </div>
      ) : Object.keys(metadata).length === 0 ? (
        <p className='text-label text-muted-foreground'>No metadata - add some with Edit.</p>
      ) : (
        <dl className='grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2'>
          {Object.entries(metadata).map(([k, v]) => (
            <div key={k} className='flex gap-2 text-label'>
              <dt className='shrink-0 text-muted-foreground'>{k}</dt>
              <dd className='min-w-0 break-words text-text'>
                {k === 'repo' && typeof v === 'string' ? (
                  <a
                    href={url ?? `https://github.com/${v}`}
                    target='_blank'
                    rel='noreferrer'
                    className='inline-flex items-center gap-1 hover:text-accent'>
                    {v}
                    <ExternalLink className='size-3' />
                  </a>
                ) : typeof v === 'object' ? (
                  <code>{JSON.stringify(v)}</code>
                ) : (
                  String(v)
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}
