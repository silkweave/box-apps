import { useEffect, useState } from 'react'
import { ExternalLink, FileImage, Images, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trpc } from '../../../lib/trpc.ts'
import { upsertContent } from '../lib/useContentData.ts'
import {
  ASSET_USAGES,
  assetUrl,
  isImageAsset,
  isVideoAsset,
  pieceAssets,
  type AssetUsage,
  type ContentAsset,
  type ContentPiece,
} from '../content-types.ts'
import { Badge, InlineEdit, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@silkweave/box-ui'
import { GenerateButton } from '../../../components/agent/GenerateCommand.tsx'

/** Usage-mark badge tones: the feature (hero) image stands out; the rest stay neutral. */
const USAGE_TONE: Record<AssetUsage, 'accent' | 'neutral' | 'info'> = {
  feature: 'accent',
  inline: 'neutral',
  social: 'info',
  attachment: 'neutral',
}

/**
 * Assets attached to a piece via `metadata.assets` - one physical file in the topic's
 * docs/content/<topic>/ folder, referenced (with a usage mark) by any of its channel pieces.
 * Feature assets render as a hero image; the rest as thumbnails. Unattached files found in the
 * folder appear as one-click "attach" chips.
 */
export function AssetsPanel({ piece }: { piece: ContentPiece }) {
  const assets = pieceAssets(piece.metadata)
  const [folderFiles, setFolderFiles] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    void trpc.contentAssets
      .mutate({ topic_id: piece.topic_id })
      .then((r) => alive && setFolderFiles(((r as { files?: unknown }).files ?? []) as string[]))
      .catch(() => alive && setFolderFiles([]))
    return () => {
      alive = false
    }
  }, [piece.topic_id])

  const save = (next: ContentAsset[]): void => {
    const metadata: Record<string, unknown> = { ...piece.metadata, assets: next }
    if (next.length === 0) delete metadata.assets
    void upsertContent({ id: piece.id, metadata: JSON.stringify(metadata) })
  }

  const attach = (file: string): void =>
    // First image attached becomes the feature (hero); later ones default to inline.
    save([...assets, { path: file, usage: assets.some((a) => a.usage === 'feature') ? 'inline' : 'feature' }])
  const patch = (i: number, p: Partial<ContentAsset>): void =>
    save(assets.map((a, j) => (j === i ? { ...a, ...p } : a)))
  const detach = (i: number): void => save(assets.filter((_, j) => j !== i))

  const attached = new Set(assets.map((a) => a.path))
  const attachable = folderFiles.filter((f) => !attached.has(f))

  const features = assets.filter((a) => a.usage === 'feature')
  const rest = assets.filter((a) => a.usage !== 'feature')

  return (
    <section className='mb-6'>
      <div className='mb-2 flex items-center gap-1.5'>
        <h2 className='flex items-center gap-1.5 text-body-sm font-medium text-text'>
          <Images className='size-4 text-muted-foreground' /> Assets
        </h2>
        <GenerateButton
          className='ml-auto'
          label='Generate Image'
          command={`/illustration ${piece.topic_id}`}
          title='Generate an illustration'
          description={
            <>
              Composes a house-style illustration prompt from this piece (the dark, oil-painted
              protocol-diagram look every Silkweave image shares), shows it for approval, then renders
              it via the Gemini image API into this topic&apos;s folder and attaches it here as an
              asset. The prompt is saved beside the image for re-renders and tweaks.
            </>
          }
        />
      </div>

      {features.map((a) => (
        <AssetCard key={a.path} asset={a} piece={piece} hero
          onPatch={(p) => patch(assets.indexOf(a), p)} onDetach={() => detach(assets.indexOf(a))} />
      ))}
      {rest.length > 0 && (
        <div className='grid grid-cols-2 gap-3 sm:grid-cols-3'>
          {rest.map((a) => (
            <AssetCard key={a.path} asset={a} piece={piece}
              onPatch={(p) => patch(assets.indexOf(a), p)} onDetach={() => detach(assets.indexOf(a))} />
          ))}
        </div>
      )}

      {attachable.length > 0 && (
        <div className='mt-2 flex flex-wrap items-center gap-1.5'>
          <span className='text-label text-muted-foreground'>In folder:</span>
          {attachable.map((f) => (
            <button
              key={f}
              type='button'
              onClick={() => attach(f)}
              title={`Attach ${f} to this piece`}
              className='inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-label text-muted-foreground transition-colors hover:border-accent/40 hover:text-text'>
              <Plus className='size-3' /> {f}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

function AssetCard({
  asset,
  piece,
  hero = false,
  onPatch,
  onDetach,
}: {
  asset: ContentAsset
  piece: ContentPiece
  hero?: boolean
  onPatch: (p: Partial<ContentAsset>) => void
  onDetach: () => void
}) {
  const url = assetUrl(piece.topic_id, asset.path)
  const isImage = isImageAsset(asset.path)
  const isVideo = isVideoAsset(asset.path)
  return (
    <figure
      className={cn(
        'group/asset relative mb-3 overflow-hidden rounded-lg border border-border bg-surface shadow-(--shadow-sm)',
        hero ? 'w-full' : '',
      )}>
      {/* Video sits outside the open-in-tab anchor so its native controls stay clickable. */}
      {isVideo ? (
        <video
          src={url}
          controls
          preload='metadata'
          className={cn('w-full bg-bg object-contain', hero ? 'max-h-80' : 'aspect-video')}
        />
      ) : (
        <a href={url} target='_blank' rel='noreferrer' title={`Open ${asset.path}`} className='block bg-bg'>
          {isImage ? (
            <img
              src={url}
              alt={asset.alt ?? asset.path}
              className={cn('w-full object-contain', hero ? 'max-h-80' : 'aspect-video object-cover')}
            />
          ) : (
            <span className='flex aspect-video items-center justify-center text-muted-foreground'>
              <FileImage className='size-8' />
            </span>
          )}
        </a>
      )}
      <button
        type='button'
        onClick={onDetach}
        aria-label={`Detach ${asset.path}`}
        title='Detach from this piece (file stays on disk)'
        className='absolute right-1.5 top-1.5 hidden size-6 items-center justify-center rounded-md bg-bg/80 text-muted-foreground backdrop-blur transition-colors hover:text-danger group-hover/asset:flex'>
        <X className='size-3.5' />
      </button>

      <figcaption className={cn('flex items-center gap-2 border-t border-border px-2.5 py-1.5', !hero && 'flex-wrap')}>
        <Badge variant={USAGE_TONE[asset.usage] ?? 'neutral'} className='shrink-0 py-0'>
          <Select
            value={asset.usage}
            onValueChange={(u) => onPatch({ usage: u as AssetUsage })}
            items={ASSET_USAGES.map((u) => ({ value: u, label: u }))}>
            <SelectTrigger
              aria-label='Usage'
              className='h-auto gap-1 border-none bg-transparent p-0 text-inherit shadow-none'>
              <SelectValue>{(v) => <span>{String(v)}</span>}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ASSET_USAGES.map((u) => (
                <SelectItem key={u} value={u}>
                  {u}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Badge>
        <span className='min-w-0 flex-1 truncate font-mono text-label text-muted-foreground' title={asset.path}>
          {asset.path}
        </span>
        <a href={url} target='_blank' rel='noreferrer' className='shrink-0 text-muted-foreground hover:text-accent'>
          <ExternalLink className='size-3' />
        </a>
      </figcaption>
      <div className='border-t border-border px-2.5 py-1'>
        <InlineEdit
          defaultValue={asset.alt ?? ''}
          aria-label='Alt text'
          placeholder='alt text / caption…'
          inputClassName='h-6 text-label'
          onCommit={(v) => v.trim() !== (asset.alt ?? '') && onPatch({ alt: v.trim() || undefined })}
        />
      </div>
    </figure>
  )
}
