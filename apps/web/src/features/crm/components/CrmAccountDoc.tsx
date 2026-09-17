import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Placeholder } from '@tiptap/extensions'
import { Markdown } from '@tiptap/markdown'
import { Check, ClipboardCopy, Clock, Code2, FileText, Loader2, Lock, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SplitPaneToggle } from '@silkweave/box-ui'
import { useCrmDoc, type CrmDocStatus } from '../lib/useCrmDoc.ts'

/**
 * An account's doc: the next move, then the notes, in `docs/crm/<id>.md`.
 *
 * THE LOCKED BLOCK. Both headings are static chrome rendered here, not content in either editor.
 * That is the whole mechanism, and it is the one ContentBodyEditor already relies on for content
 * frontmatter: structure the editor never contains is structure the user cannot delete, reorder or
 * mangle. There is no "locked node" extension, no decoration, and nothing to enforce on every
 * keystroke - the two editors simply own one prose region each and the file is recomposed around
 * them server-side.
 *
 * The next-move editor runs with headings and horizontal rules DISABLED. That is a data guard, not
 * a style choice: a `##` line inside the block would be written into the file as a real heading, and
 * the parser reads the first heading after the opener as the end of the block - so the user's own
 * text would silently move itself into notes. Removing the ability to make one removes the failure.
 */
export function CrmAccountDoc({ accountId }: { accountId: string }) {
  const { nextAction, notes, content, status, path, editorUri, externalRev, update } = useCrmDoc(accountId)
  const [copied, setCopied] = useState(false)

  // Both regions + the save closure in refs: each editor's onUpdate is bound once at creation, and
  // has to send BOTH regions (it only knows its own), always targeting the current account.
  const regions = useRef({ nextAction: '', notes: '' })
  const updateRef = useRef(update)
  updateRef.current = update
  const loaded = useRef(false)

  const commit = useCallback((patch: { nextAction?: string; notes?: string }) => {
    if (!loaded.current) return // skip the programmatic seed and the pre-load gap
    regions.current = { ...regions.current, ...patch }
    updateRef.current(regions.current)
  }, [])

  const nextEditor = useEditor({
    extensions: [
      // See the header: no headings, no rules - a heading here would re-partition the file. Block
      // nodes are off too, because the write path collapses this region to a single line: a list or
      // a second paragraph would come back as run-on prose. Inline marks survive and stay enabled.
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
      }),
      Markdown.configure({ markedOptions: { gfm: true } }),
      Placeholder.configure({ placeholder: 'The one thing to do for this account next' }),
    ],
    editorProps: { attributes: { class: 'markdown-body tiptap px-4 py-3 focus:outline-none' } },
    onUpdate: ({ editor }) => commit({ nextAction: editor.getMarkdown().trim() }),
  })

  const notesEditor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit,
      Markdown.configure({ markedOptions: { gfm: true } }),
      Placeholder.configure({ placeholder: 'What was said, what they want, what you learned.' }),
    ],
    editorProps: { attributes: { class: 'markdown-body tiptap min-h-[16rem] px-4 py-3 focus:outline-none' } },
    onUpdate: ({ editor }) => commit({ notes: editor.getMarkdown().trim() }),
  })

  // Seed both editors once the regions arrive. emitUpdate:false so seeding never triggers a save.
  // The parent remounts per account (key={account.id}), so the refs reset and one load is correct.
  useEffect(() => {
    // `isDestroyed`: the TipTap v3 mount race where the eagerly-created editor is torn down by its
    // 1ms scheduleDestroy before this effect runs (see SinkBodyEditor). Skipping lets TipTap
    // recreate a fresh instance and this effect re-seed it.
    if (!nextEditor || nextEditor.isDestroyed || !notesEditor || notesEditor.isDestroyed) return
    if (nextAction == null || notes == null || loaded.current) return
    seed(nextEditor, nextAction)
    seed(notesEditor, notes)
    regions.current = { nextAction, notes }
    loaded.current = true
  }, [nextEditor, notesEditor, nextAction, notes])

  // Re-seed on an out-of-band write (the crm-account-upsert mirror-back, a Claude session, VS Code).
  // Never while the user is focused in either editor - that would yank the caret mid-sentence - so we
  // defer to the next blur. useCrmDoc already withholds the refetch while edits are unsaved, so this
  // only ever replaces clean, already-saved regions.
  const seededRev = useRef(0)
  const reseed = useCallback(() => {
    if (!nextEditor || nextEditor.isDestroyed || !notesEditor || notesEditor.isDestroyed) return
    if (!loaded.current || nextAction == null || notes == null) return
    if (externalRev === seededRev.current || nextEditor.isFocused || notesEditor.isFocused) return
    seededRev.current = externalRev
    seed(nextEditor, nextAction)
    seed(notesEditor, notes)
    regions.current = { nextAction, notes }
  }, [nextEditor, notesEditor, nextAction, notes, externalRev])
  useEffect(() => reseed(), [reseed])
  // Bind blur once per editor (reseed changes every keystroke); the handler calls the latest via ref.
  const reseedRef = useRef(reseed)
  reseedRef.current = reseed
  useEffect(() => {
    if (!nextEditor || !notesEditor) return
    const onBlur = (): void => reseedRef.current()
    nextEditor.on('blur', onBlur)
    notesEditor.on('blur', onBlur)
    return () => {
      nextEditor.off('blur', onBlur)
      notesEditor.off('blur', onBlur)
    }
  }, [nextEditor, notesEditor])

  const copyMarkdown = (): void => {
    // The server's composition, not one assembled here - the SPA does not know the file format.
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const pending = nextAction == null || notes == null

  return (
    <div className='flex h-full min-h-0 flex-col bg-bg'>
      <header className='flex shrink-0 items-center gap-2 border-b border-border px-3 py-2'>
        <SplitPaneToggle className='-ml-1' />
        <FileText className='size-3.5 shrink-0 text-muted-foreground' />
        <code className='line-clamp-1 min-w-0 text-label text-muted-foreground'>{path || 'doc'}</code>
        <SaveBadge status={status} />
        <div className='ml-auto flex shrink-0 items-center gap-1'>
          <a
            href={editorUri || undefined}
            aria-disabled={!editorUri}
            title='Open in VS Code'
            className={cn(
              'inline-flex items-center gap-1 rounded-md bg-bg px-2 py-1 text-label transition-colors',
              'text-muted-foreground hover:text-text aria-disabled:pointer-events-none aria-disabled:opacity-50',
            )}>
            <Code2 className='size-3' />
            <span className='hidden sm:inline'>Open</span>
          </a>
          <button
            type='button'
            onClick={copyMarkdown}
            disabled={pending}
            title='Copy as markdown'
            className={cn(
              'inline-flex items-center gap-1 rounded-md bg-bg px-2 py-1 text-label transition-colors',
              'text-muted-foreground hover:text-text disabled:opacity-50',
            )}>
            {copied ? <Check className='size-3 text-accent' /> : <ClipboardCopy className='size-3' />}
            <span className='hidden sm:inline'>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </header>

      {pending ? (
        <div className='min-h-[24rem] px-4 py-10 text-center text-body-sm text-muted-foreground'>Loading…</div>
      ) : (
        <div className='min-h-0 flex-1 overflow-y-auto'>
          {/*
            The reserved block. The accent rule and the lock icon are the affordance that says "this
            heading is the app's, not yours" - the editor below it holds only the prose.
          */}
          <div className='border-l-2 border-l-accent'>
            <div className='flex items-center gap-1.5 px-4 pt-3'>
              <h2 className='font-serif text-display-sm leading-none text-text'>Next move</h2>
              <Lock className='size-3 text-muted-foreground' aria-label='This heading is fixed' />
            </div>
            <EditorContent editor={nextEditor} />
          </div>

          <div className='border-t border-border px-4 pt-3'>
            <h2 className='font-serif text-display-sm leading-none text-text'>Notes</h2>
          </div>
          <EditorContent editor={notesEditor} />
        </div>
      )}
    </div>
  )
}

/** Load a region's markdown into an editor without triggering a save. */
function seed(editor: Editor, markdown: string): void {
  editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false })
}

function SaveBadge({ status }: { status: CrmDocStatus }) {
  const map: Record<CrmDocStatus, { cls: string; icon: React.ReactNode }> = {
    loading: { cls: 'text-muted-foreground', icon: <Loader2 className='size-3 animate-spin' /> },
    saved: { cls: 'text-muted-foreground', icon: <Check className='size-3' /> },
    dirty: { cls: 'text-muted-foreground', icon: <Clock className='size-3' /> },
    saving: { cls: 'text-accent', icon: <Loader2 className='size-3 animate-spin' /> },
    error: { cls: 'text-danger', icon: <TriangleAlert className='size-3' /> },
  }
  const m = map[status]
  return <span className={cn('inline-flex items-center gap-1 text-label', m.cls)}>{m.icon}</span>
}
