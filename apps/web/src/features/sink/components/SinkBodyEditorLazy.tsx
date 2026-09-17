import { lazy, Suspense } from 'react'
import type { SinkBodyEditorProps } from './SinkBodyEditor.tsx'

// Lazy boundary so TipTap ships in its own chunk (shared with the planning DocEditor's chunk), loaded
// only when a sink file is open. Re-exported as `SinkBodyEditor` so call sites don't change.
const Inner = lazy(() => import('./SinkBodyEditor.tsx').then((m) => ({ default: m.SinkBodyEditor })))

export function SinkBodyEditor(props: SinkBodyEditorProps) {
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
