import { lazy, Suspense } from 'react'
import type { ChannelProfile, ContentPiece } from '../content-types.ts'

// Lazy boundary so TipTap ships in its own chunk (shared with DocEditor's and SinkBodyEditor's),
// loaded only when a piece is open. Re-exported as `ContentBodyEditor` so call sites don't change.
//
// This one is load-bearing for the OTHER two. ContentDetailView is imported eagerly by the router,
// so a static import here pulled all of TipTap (~600 kB) into the main bundle and quietly made
// the DocEditor and SinkBodyEditorLazy no-ops: their chunks stayed tiny because the heavy dependency
// was already in the entry chunk. One eager import is enough to defeat every lazy boundary that
// shares a dependency.
const Inner = lazy(() => import('./ContentBodyEditor.tsx').then((m) => ({ default: m.ContentBodyEditor })))

export function ContentBodyEditor(props: { piece: ContentPiece; profile?: ChannelProfile }) {
  return (
    <Suspense
      fallback={
        <div className='grid h-full place-items-center bg-bg px-4 py-10 text-center text-body-sm text-muted-foreground'>
          Loading editor…
        </div>
      }>
      <Inner {...props} />
    </Suspense>
  )
}
