import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { cn } from '@/lib/utils'

export interface SinkBodyEditorProps {
  /** Doc identity; when it changes the editor re-seeds from `content`. */
  docKey: string
  /** Loaded markdown body, or null while loading. */
  content: string | null
  /** Called with serialized markdown on edits (not on the programmatic load). */
  onChange: (md: string) => void
  className?: string
}

/**
 * Headless markdown WYSIWYG - the same TipTap stack as the planning DocEditor, but with no header. The
 * Sink detail page hosts every action (save state, VS Code, copy, delete) in the app's single top bar,
 * so the editor renders only its body. Load-once semantics: it seeds from `content` when `docKey` first
 * resolves and streams edits out via `onChange`; the parent remounts it per file (key=name).
 */
export function SinkBodyEditor({ docKey, content, onChange, className }: SinkBodyEditorProps) {
  const keyRef = useRef(docKey)
  keyRef.current = docKey
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const loadedKey = useRef<string | null>(null)

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit,
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    editorProps: {
      attributes: { class: 'markdown-body tiptap min-h-[24rem] px-4 py-3 focus:outline-none' },
    },
    onUpdate: ({ editor }) => {
      if (loadedKey.current !== keyRef.current) return // skip the programmatic seed + pre-load gap
      onChangeRef.current(editor.getMarkdown())
    },
  })

  useEffect(() => {
    // `editor.isDestroyed`: TipTap v3's useEditor eagerly creates the editor then arms a 1ms
    // scheduleDestroy; if passive effects flush late (busy initial load + this editor's lazy/Suspense
    // boundary) the timer wins, tearing the instance down (commandManager=null) before this seed runs -
    // reading `.commands` on it throws. Skipping lets TipTap recreate a fresh instance, which re-runs
    // this effect (the `editor` dep changed) and seeds cleanly.
    if (!editor || editor.isDestroyed || content == null || loadedKey.current === docKey) return
    editor.commands.setContent(content, { contentType: 'markdown', emitUpdate: false })
    loadedKey.current = docKey
  }, [editor, content, docKey])

  if (content == null)
    return (
      <div className={cn('grid place-items-center bg-bg text-body-sm text-muted-foreground', className)}>Loading…</div>
    )
  return <EditorContent editor={editor} className={cn('overflow-y-auto bg-bg', className)} />
}
