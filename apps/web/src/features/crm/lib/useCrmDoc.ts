import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeChanges } from '../../../lib/changeFeed.ts'
import { trpc } from '../../../lib/trpc.ts'

export type CrmDocStatus = 'loading' | 'saved' | 'dirty' | 'saving' | 'error'

const AUTOSAVE_MS = 1000

/**
 * Load a CRM account's doc (`docs/crm/<id>.md`) as TWO REGIONS and debounced-autosave them back.
 *
 * Why regions rather than one markdown string, which is what every other doc hook here does: the
 * next move lives in a reserved block at the top of the file, and a block a user can delete is not
 * reserved. So the panel holds both headings as static chrome OUTSIDE its editors - the same move
 * ContentBodyEditor makes for frontmatter, which survives precisely because the editor never
 * contains it - and edits only the prose inside each region.
 *
 * The split is done SERVER-side (the controller calls core's parser). apps/web deliberately does
 * not depend on @silkweave/box-core, and hand-mirroring the parse rules into the browser would put the one
 * thing guarding people's notes in two places at once. The hook therefore never parses markdown; it
 * moves two opaque strings.
 *
 * Saving is a recompose over the file on disk, so anything the panel does not model (frontmatter, a
 * heading variant someone typed by hand) is preserved rather than flattened. `externalRev` bumps
 * when a refetch returns different regions than we are showing - an out-of-band write (the MCP
 * `crm-account-upsert` mirror-back, a local Claude session, VS Code), not our own autosave echo -
 * and the panel watches it to re-seed its editors.
 */
export function useCrmDoc(accountId: string): {
  nextAction: string | null
  notes: string | null
  /** The last doc the SERVER composed. Powers Copy without teaching the SPA the file format. */
  content: string
  status: CrmDocStatus
  path: string
  editorUri: string
  externalRev: number
  update: (regions: { nextAction: string; notes: string }) => void
} {
  const [nextAction, setNextAction] = useState<string | null>(null)
  const [notes, setNotes] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [status, setStatus] = useState<CrmDocStatus>('loading')
  const [path, setPath] = useState('')
  const [editorUri, setEditorUri] = useState('')
  const [externalRev, setExternalRev] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Latest regions/status in refs so the change-feed callback (bound once per account) can diff
  // against what we show without re-subscribing, and bail out while there are unsaved edits.
  const regionsRef = useRef<{ nextAction: string; notes: string } | null>(null)
  const statusRef = useRef<CrmDocStatus>('loading')
  useEffect(() => {
    regionsRef.current = nextAction == null || notes == null ? null : { nextAction, notes }
  }, [nextAction, notes])
  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    let alive = true
    setNextAction(null)
    setNotes(null)
    setStatus('loading')
    trpc.crmDoc
      .mutate({ id: accountId })
      .then((d) => {
        if (!alive) return
        setNextAction(d.nextAction)
        setNotes(d.notes)
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
  }, [accountId])

  // Live refresh. `docs:crm` needs no server change: the fs watcher derives the scope generically
  // from docs/<section>/… (changes.watcher.ts). We refetch on any crm-doc write regardless of which
  // file it named - an unrelated account's write returns identical regions and is a no-op, which is
  // more robust than path-matching a feed that only delivers the last event of a burst. Guarded
  // twice against unsaved edits: at fire time and again when the fetch resolves.
  useEffect(() => {
    let alive = true
    const off = subscribeChanges(['docs:crm'], () => {
      if (statusRef.current === 'dirty' || statusRef.current === 'saving') return
      trpc.crmDoc
        .mutate({ id: accountId })
        .then((d) => {
          if (!alive || statusRef.current === 'dirty' || statusRef.current === 'saving') return
          setPath(d.path)
          setEditorUri(d.editorUri)
          setContent(d.content)
          setStatus('saved')
          const cur = regionsRef.current
          if (cur && (cur.nextAction !== d.nextAction || cur.notes !== d.notes)) {
            setNextAction(d.nextAction)
            setNotes(d.notes)
            setExternalRev((r) => r + 1)
          }
        })
        .catch(() => undefined)
    })
    return () => {
      alive = false
      off()
    }
  }, [accountId])

  const update = useCallback(
    (regions: { nextAction: string; notes: string }) => {
      setNextAction(regions.nextAction)
      setNotes(regions.notes)
      setStatus('dirty')
      if (timer.current) clearTimeout(timer.current)
      const target = accountId
      timer.current = setTimeout(() => {
        setStatus('saving')
        trpc.crmDocRegionsSave
          .mutate({ id: target, nextAction: regions.nextAction, notes: regions.notes })
          .then((d) => {
            setPath(d.path)
            setEditorUri(d.editorUri)
            setContent(d.content)
            setStatus((s) => (s === 'saving' ? 'saved' : s)) // a newer edit may have re-dirtied
          })
          .catch(() => setStatus('error'))
      }, AUTOSAVE_MS)
    },
    [accountId],
  )

  return { nextAction, notes, content, status, path, editorUri, externalRev, update }
}
