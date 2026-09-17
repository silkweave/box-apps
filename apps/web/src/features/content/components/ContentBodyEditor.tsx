import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { Check, Code2, Loader2, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useContentDoc, type ContentDocStatus } from '../lib/useContentDoc.ts'
import { SplitPaneToggle } from '@silkweave/box-ui'
import { GenerateButton } from '../../../components/agent/GenerateCommand.tsx'
import { XThreadPosts, threadPostStats, type ThreadPostStat } from './xThreadPosts.ts'
import type { ChannelProfile, ContentPiece } from '../content-types.ts'

/**
 * Content body editor - the same TipTap WYSIWYG stack the planning DocEditor uses, so the editing
 * tech is standardized across the app (no separate textarea, no formatting toolbar). Two content-only
 * concerns it adds:
 *   • Frontmatter - content bodies start with a `--- … ---` block that the markdown editor would
 *     mangle (it parses `---` as a thematic break). We split it off on load, edit only the body in
 *     the editor, and re-attach the original frontmatter verbatim on every save.
 *   • Live constraints - the channel profile's length/format counter plus the global no-em-dash rule
 *     (voice/global.md) surfaced as you type, mirroring what /verify-content checks.
 */
export function ContentBodyEditor({ piece, profile }: { piece: ContentPiece; profile?: ChannelProfile }) {
  const { content, status, path, editorUri, externalRev, update } = useContentDoc(piece.id)

  // The frontmatter for the loaded piece + the live save closure, kept in refs so the editor's
  // onUpdate (bound once) always re-attaches the right frontmatter and targets the current doc.
  const fmRef = useRef('')
  const updateRef = useRef(update)
  updateRef.current = update
  const loaded = useRef(false)

  // Per-post stats for a thread body, kept in sync with the editor doc so the header summary matches
  // the inline post chips exactly (both come from threadPostStats on the same doc). Empty otherwise.
  const isThread = profile?.bodyKind === 'thread'
  const [threadStats, setThreadStats] = useState<ThreadPostStat[]>([])

  const editor = useEditor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit,
      Markdown.configure({ markedOptions: { gfm: true } }),
      // Thread bodies get view-only post dividers + count chips (markdown is untouched).
      ...(isThread ? [XThreadPosts.configure({ max: profile?.limits.perUnitChars ?? 280 })] : []),
    ],
    editorProps: {
      attributes: { class: 'markdown-body tiptap min-h-[24rem] px-4 py-3 focus:outline-none' },
    },
    onUpdate: ({ editor }) => {
      if (!loaded.current) return // skip the programmatic seed + the pre-load gap
      updateRef.current(fmRef.current + editor.getMarkdown())
      if (isThread) setThreadStats(threadPostStats(editor.state.doc))
    },
  })

  // Seed the editor once: split frontmatter off, load the body markdown (emitUpdate:false so the seed
  // never triggers a save). The parent remounts this component per piece (key={piece.id}), so the refs
  // reset and a single load is correct.
  useEffect(() => {
    // `editor.isDestroyed`: guards the TipTap v3 mount race where the eagerly-created editor is torn
    // down by its 1ms scheduleDestroy before this seed effect runs (see SinkBodyEditor for the full
    // note). Skipping lets TipTap recreate a fresh instance and this effect re-seeds it.
    if (!editor || editor.isDestroyed || content == null || loaded.current) return
    const m = /^---\n[\s\S]*?\n---\n?/.exec(content)
    fmRef.current = m ? m[0] : ''
    editor.commands.setContent(m ? content.slice(m[0].length) : content, {
      contentType: 'markdown',
      emitUpdate: false,
    })
    if (isThread) setThreadStats(threadPostStats(editor.state.doc))
    loaded.current = true
  }, [editor, content, isThread])

  // Re-seed on an external (on-disk) change: useContentDoc bumps externalRev when the body is rewritten
  // out from under us (an agent-sidebar refine, a local Claude session, another tab). Split the fresh
  // frontmatter off and reload the editor - but never while the user is focused in it (that would yank
  // their cursor mid-read); we defer to the next blur instead. useContentDoc already withholds the
  // refetch while there are unsaved local edits, so this only ever replaces a clean, already-saved body.
  const seededRev = useRef(0)
  const reseed = useCallback(() => {
    if (!editor || editor.isDestroyed || content == null || !loaded.current) return
    if (externalRev === seededRev.current || editor.isFocused) return
    seededRev.current = externalRev
    const m = /^---\n[\s\S]*?\n---\n?/.exec(content)
    fmRef.current = m ? m[0] : ''
    editor.commands.setContent(m ? content.slice(m[0].length) : content, {
      contentType: 'markdown',
      emitUpdate: false,
    })
    if (isThread) setThreadStats(threadPostStats(editor.state.doc))
  }, [editor, content, externalRev, isThread])
  useEffect(() => reseed(), [reseed])
  // Bind blur once per editor (reseed changes every keystroke); the handler calls the latest via a ref.
  const reseedRef = useRef(reseed)
  reseedRef.current = reseed
  useEffect(() => {
    if (!editor) return
    const onBlur = (): void => reseedRef.current()
    editor.on('blur', onBlur)
    return () => {
      editor.off('blur', onBlur)
    }
  }, [editor])

  const counter = useMemo(() => {
    if (content == null || !profile) return null
    return profile.bodyKind === 'thread'
      ? threadReport(threadStats, profile, content)
      : constraintReport(content, profile)
  }, [content, profile, threadStats])

  return (
    <div className='flex h-full min-h-0 flex-col bg-bg'>
      <header className='flex shrink-0 items-center gap-2 border-b border-border px-3 py-2'>
        <SplitPaneToggle className='-ml-1' />
        <code className='line-clamp-1 min-w-0 text-label text-muted-foreground'>{path || piece.body_path || piece.id}</code>
        <SaveBadge status={status} />
        {counter && (
          <span
            className={cn(
              'shrink-0 whitespace-nowrap text-label tabular-nums',
              counter.ok ? 'text-muted-foreground' : 'text-warning',
            )}>
            {counter.label}
          </span>
        )}
        <div className='ml-auto flex shrink-0 items-center gap-1'>
          {editorUri && (
            <a
              href={editorUri}
              title='Open in VS Code'
              className='inline-flex items-center gap-1 rounded-md bg-card px-2 py-1 text-label text-muted-foreground transition-colors hover:text-text'>
              <Code2 className='size-3' />
              <span className='hidden sm:inline'>VS Code</span>
            </a>
          )}
        </div>
      </header>

      {counter && counter.violations.length > 0 && (
        <ul className='shrink-0 border-b border-border bg-warning-bg/30 px-3 py-2 text-label text-warning'>
          {counter.violations.map((v, i) => (
            <li key={i}>⚠ {v}</li>
          ))}
        </ul>
      )}

      {content == null ? (
        <div className='grid flex-1 place-items-center text-body-sm text-muted-foreground'>Loading…</div>
      ) : (
        <EditorContent editor={editor} className='min-h-0 flex-1 overflow-y-auto bg-bg' />
      )}

      <footer className='flex shrink-0 items-center justify-end border-t border-border px-3 py-2'>
        <GenerateButton
          label='Refine Content'
          command={`/refine-content ${piece.id} `}
          withDirection
          title='Refine this draft'
          description={
            <>
              Revises the draft along a direction you append to the command: pivot the angle, dig
              deeper on a point, add a source, tighten it, or address the latest verify findings. It
              honors the topic&apos;s claims ledger and the voice style, edits this body, then
              re-runs the verify gate. It never publishes.
            </>
          }
        />
      </footer>
    </div>
  )
}

// --- live constraint check (mirrors /verify-content's constraints + global voice rules) -----------

/** Strip a leading `--- … ---` frontmatter block before counting the prose. */
function stripFrontmatter(md: string): string {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(md)
  return m ? md.slice(m[0].length) : md
}

interface ConstraintReport {
  label: string
  ok: boolean
  violations: string[]
}

/** Emit the em-dash violation (voice/global.md hard rule) into an existing report, if any are present. */
function pushEmDash(body: string, violations: string[]): void {
  const emDash = (body.match(/\u2014/g) ?? []).length
  if (emDash) violations.push(`${emDash} em-dash found: forbidden by voice/global.md (rewrite or use plain punctuation)`)
}

/**
 * Thread summary: a tight one-line count ("5 posts · 2 over 280") plus the structural + voice checks.
 * Per-post lengths come from `stats` (computed from the editor doc), the same source the inline post
 * chips use, so the summary and the chips never disagree. The chips carry the which-post detail, so the
 * violation list stays tight (post-count target + em-dash only).
 */
function threadReport(stats: ThreadPostStat[], profile: ChannelProfile, raw: string): ConstraintReport {
  const { limits } = profile
  const max = limits.perUnitChars ?? 280
  const over = stats.filter((s) => s.chars > max).length
  const violations: string[] = []
  let label = `${stats.length} post${stats.length === 1 ? '' : 's'}`
  if (over) label += ` · ${over} over ${max}`
  if (limits.units) {
    const [lo, hi] = limits.units
    if (stats.length < lo || stats.length > hi) violations.push(`thread is ${stats.length} posts (target ${lo}–${hi})`)
  }
  pushEmDash(stripFrontmatter(raw), violations)
  return { label, ok: over === 0 && violations.length === 0, violations }
}

/** Live length/format + global-voice check for non-thread bodies - what /verify-content uses. */
function constraintReport(raw: string, profile: ChannelProfile): ConstraintReport {
  const body = stripFrontmatter(raw)
  const { limits } = profile
  const violations: string[] = []
  let label = ''

  if (limits.unitKind === 'chars') {
    const chars = body.trim().length
    label = `${chars.toLocaleString()} chars`
    if (limits.units) {
      const [lo, hi] = limits.units
      if (chars < lo || chars > hi) violations.push(`${chars.toLocaleString()} chars (target ${lo}–${hi})`)
    }
    if (limits.perUnitChars && chars > limits.perUnitChars)
      violations.push(`over the ${limits.perUnitChars.toLocaleString()}-char cap`)
  } else {
    const words = body.trim() ? body.trim().split(/\s+/).length : 0
    label = `${words.toLocaleString()} words`
    if (limits.units) {
      const [lo, hi] = limits.units
      if (words < lo || words > hi) violations.push(`${words.toLocaleString()} words (target ${lo}–${hi})`)
    }
  }

  // Global voice rule (voice/global.md): no em-dash, ever. A hard verify-fail, so flag it live.
  const before = violations.length
  pushEmDash(body, violations)
  if (violations.length > before) label += ` · ${violations.length - before} em-dash`

  return { label, ok: violations.length === 0, violations }
}

function SaveBadge({ status }: { status: ContentDocStatus }) {
  if (status === 'idle') return null
  const map: Record<ContentDocStatus, React.ReactNode> = {
    idle: null,
    loading: <Loader2 className='size-3 animate-spin' />,
    saving: <Loader2 className='size-3 animate-spin text-accent' />,
    saved: <Check className='size-3 text-success' />,
    dirty: <span className='size-1.5 rounded-full bg-muted-foreground' />,
    error: <TriangleAlert className='size-3 text-danger' />,
  }
  return <span className='inline-flex items-center gap-1 text-label text-muted-foreground'>{map[status]}</span>
}
