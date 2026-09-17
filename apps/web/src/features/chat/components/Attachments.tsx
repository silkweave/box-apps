import { Dialog, DialogContent } from '@silkweave/box-ui'
import { Download, FileText } from 'lucide-react'
import { useState } from 'react'
import { attachmentUrl, formatBytes } from '../lib/chatUploads.ts'
import type { ChatAttachment } from '../lib/chatTypes.ts'

/**
 * Attachments under a message (chat Track 11).
 *
 * The split mirrors the server's: the four types it will serve INLINE (png/jpeg/gif/webp) render as
 * images, everything else as a download row. Note `image/heic` is an image the browser cannot
 * display - the server serves it as a download for exactly that reason - so `mime.startsWith` is
 * not the test; the inline set is.
 *
 * No token, no signed URL: `/api/chat/attachments/:id` is same-origin, so the session cookie rides
 * along on the <img> automatically, and the server re-authorizes every single request.
 */
const INLINE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export function Attachments({ attachments }: { attachments: ChatAttachment[] }) {
  const [zoomed, setZoomed] = useState<ChatAttachment | null>(null)
  if (attachments.length === 0) return null

  return (
    <>
      <div className='mt-1 flex flex-wrap gap-2'>
        {attachments.map((a) =>
          INLINE_MIME.has(a.mime) ? (
            <button
              key={a.id}
              type='button'
              onClick={() => setZoomed(a)}
              className='block overflow-hidden rounded-lg border border-border transition-colors hover:border-accent'
              aria-label={`View ${a.filename}`}>
              <img
                src={attachmentUrl(a.id)}
                alt={a.filename}
                // Bounded so one tall screenshot cannot push the rest of the room off screen;
                // `loading=lazy` keeps scrollback cheap when a channel is image-heavy.
                className='max-h-64 max-w-full object-contain'
                loading='lazy'
              />
            </button>
          ) : (
            <a
              key={a.id}
              href={attachmentUrl(a.id)}
              download={a.filename}
              className='flex items-center gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-label transition-colors hover:border-accent'>
              <FileText className='size-4 shrink-0 text-muted-foreground' />
              <span className='max-w-56 truncate'>{a.filename}</span>
              <span className='shrink-0 text-muted-foreground'>{formatBytes(a.bytes)}</span>
              <Download className='size-3.5 shrink-0 text-muted-foreground' />
            </a>
          ),
        )}
      </div>

      {/* Lightbox. Rendered from the same URL the thumbnail used, so it is already in cache. */}
      <Dialog open={zoomed !== null} onOpenChange={(open) => !open && setZoomed(null)}>
        {/* `w-auto` matters: DialogContent's base w-[calc(100%-2rem)] is not a max-width, so without
            it the popup is an invisible near-full-width surface and clicks beside the letterboxed
            image hit it instead of the backdrop, refusing to dismiss. */}
        <DialogContent
          className='w-auto max-w-[90vw] border-none bg-transparent p-0 shadow-none'
          aria-label={zoomed?.filename ?? 'Image'}>
          {zoomed && (
            <img
              src={attachmentUrl(zoomed.id)}
              alt={zoomed.filename}
              className='max-h-[85vh] w-auto rounded-lg object-contain'
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
