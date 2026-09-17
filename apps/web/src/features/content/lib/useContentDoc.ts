import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeChanges } from '../../../lib/changeFeed.ts'
import { trpc } from '../../../lib/trpc.ts'

export type ContentDocStatus = 'idle' | 'loading' | 'saved' | 'dirty' | 'saving' | 'error'

const AUTOSAVE_MS = 1000

/**
 * Load a content piece's markdown body (docs/content/<topic>/<channel>.md) over tRPC and
 * **debounced-autosave** edits back (~1s after the last keystroke). `content` is null while loading.
 * Content bodies carry frontmatter and X bodies are plain threads, so this drives a plain textarea
 * (not the TipTap WYSIWYG, which would mangle the frontmatter) - mirrors useDoc. The save closure
 * captures the id at edit time, so a pending write still targets the right piece if the route changes.
 *
 * **Live refresh:** the body also lives on disk, where a local Claude session or the agent sidebar can
 * rewrite it out from under an open editor. We subscribe to the `docs:content` change feed and refetch
 * the open piece when any content file changes - but never while there are unsaved local edits
 * (`dirty`/`saving`), so a live agent edit can't clobber what the user is typing. `externalRev` bumps
 * only when a refetch actually returns a *different* body than we're showing (an out-of-band edit, not
 * our own autosave echo or an unrelated piece's write); the editor watches it to re-seed itself.
 */
export function useContentDoc(id: string | null): {
  content: string | null
  status: ContentDocStatus
  path: string
  editorUri: string
  /** Increments on each external (on-disk) change to this piece's body; seeds a re-render for viewers. */
  externalRev: number
  update: (next: string) => void
} {
  const [content, setContent] = useState<string | null>(null)
  const [status, setStatus] = useState<ContentDocStatus>('idle')
  const [path, setPath] = useState('')
  const [editorUri, setEditorUri] = useState('')
  const [externalRev, setExternalRev] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Latest content/status mirrored into refs so the change-feed callback (bound once per id) can read
  // them without re-subscribing: it diffs the refetched body against what we show, and bails out when
  // there are unsaved local edits.
  const contentRef = useRef<string | null>(null)
  const statusRef = useRef<ContentDocStatus>('idle')
  useEffect(() => {
    contentRef.current = content
  }, [content])
  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    if (!id) {
      setContent(null)
      setStatus('idle')
      return
    }
    let alive = true
    setContent(null)
    setStatus('loading')
    trpc.contentDoc
      .mutate({ id })
      .then((d) => {
        if (!alive) return
        setContent(d.content)
        setPath(d.path)
        setEditorUri(d.editorUri)
        setStatus('saved')
      })
      .catch(() => alive && setStatus('error'))
    return () => {
      alive = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [id])

  // Live refresh: refetch on any content-file change (debounced by the feed). We refetch the open piece
  // regardless of which file the event named - an unrelated piece's write returns identical content and
  // is a no-op (no externalRev bump), which is simpler and more robust than path-matching a feed that
  // only delivers the last event of a burst. Guarded twice against unsaved edits: at fire time and again
  // when the fetch resolves (the user may have started typing in between).
  useEffect(() => {
    if (!id) return
    let alive = true
    const off = subscribeChanges(['docs:content'], () => {
      if (statusRef.current === 'dirty' || statusRef.current === 'saving') return
      trpc.contentDoc
        .mutate({ id })
        .then((d) => {
          if (!alive || statusRef.current === 'dirty' || statusRef.current === 'saving') return
          setPath(d.path)
          setEditorUri(d.editorUri)
          setStatus('saved')
          if (d.content !== contentRef.current) {
            setContent(d.content)
            setExternalRev((r) => r + 1)
          }
        })
        .catch(() => undefined)
    })
    return () => {
      alive = false
      off()
    }
  }, [id])

  const update = useCallback(
    (next: string) => {
      setContent(next)
      setStatus('dirty')
      if (timer.current) clearTimeout(timer.current)
      const target = id
      timer.current = setTimeout(() => {
        if (!target) return
        setStatus('saving')
        trpc.contentDocSave
          .mutate({ id: target, content: next })
          .then((d) => {
            setPath(d.path)
            setEditorUri(d.editorUri)
            setStatus((s) => (s === 'saving' ? 'saved' : s)) // a newer edit may have re-dirtied
          })
          .catch(() => setStatus('error'))
      }, AUTOSAVE_MS)
    },
    [id],
  )

  return { content, status, path, editorUri, externalRev, update }
}
