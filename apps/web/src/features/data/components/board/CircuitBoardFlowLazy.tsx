import { lazy, Suspense } from 'react'
import type { CircuitBoardFlowProps } from './CircuitBoardFlow.tsx'

// Lazy boundary so React Flow (+ its CSS) ships in its own chunk, downloaded only by a browser
// that opens a board route - the same discipline as the TipTap editor. This is also half the
// answer to "does the library carry its weight": on every other route it costs nothing.
const Inner = lazy(() => import('./CircuitBoardFlow.tsx').then((m) => ({ default: m.CircuitBoardFlow })))

export function CircuitBoardFlow(props: CircuitBoardFlowProps) {
  return (
    <Suspense
      fallback={
        <div className='grid h-full place-items-center text-body-sm text-muted-foreground'>Loading board…</div>
      }>
      <Inner {...props} />
    </Suspense>
  )
}
