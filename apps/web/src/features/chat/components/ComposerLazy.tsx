import { lazy, Suspense } from 'react'

// Lazy boundary so TipTap (~600 kB) stays out of the main bundle, mirroring the library's DocEditor. The
// fallback is a static replica of the real composer's frame rather than a spinner: this sits at the
// bottom of every room, so anything a different height would shove the message list on arrival.
const ComposerInner = lazy(() => import('./Composer.tsx').then((m) => ({ default: m.Composer })))

interface ComposerProps {
  placeholder: string
  disabled: boolean
  onSend: (body: string, attachmentIds: string[]) => Promise<void>
  /** Edit mode - see Composer. Passing onCancel is what turns it on. */
  initialBody?: string
  onCancel?: () => void
  /** The thread this composer is aimed at, or null for the room - see Composer. */
  replyingTo?: { rootId: string; senderName: string } | null
  onCancelReply?: () => void
}

export function Composer(props: ComposerProps) {
  // Editing renders inline inside a message row, so the room-sized fallback frame below would
  // shove the list about. By the time anyone can click Edit the chunk is already loaded (the room's
  // own composer pulled it), so the fallback here is only ever a formality.
  if (props.onCancel !== undefined) {
    return (
      <Suspense fallback={<div className='py-1 text-body text-muted-foreground'>Loading editor…</div>}>
        <ComposerInner {...props} />
      </Suspense>
    )
  }
  return (
    <Suspense
      fallback={
        <div className='shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4 sm:pb-4'>
          <div className='flex items-end gap-1 rounded-lg border border-border bg-bg p-1'>
            <p className='min-w-0 flex-1 px-2 py-1.5 text-body text-fg-4'>{props.placeholder}</p>
            <div className='size-8 shrink-0' />
          </div>
        </div>
      }>
      <ComposerInner {...props} />
    </Suspense>
  )
}
