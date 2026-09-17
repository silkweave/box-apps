import { assetUrl, isVideoAsset, type ContentAsset } from '../content-types.ts'

/**
 * Feature-asset thumbnail for the content board. Images render as `<img>`; videos as a muted,
 * control-less `<video>` so the card stays one big click target (the detail view's AssetsPanel is
 * where a video gets real controls). The `#t=0.1` fragment makes Safari paint a first frame -
 * Chrome does it off `preload='metadata'` alone.
 */
export function AssetThumb({
  topicId,
  asset,
  className,
}: {
  topicId: string
  asset: ContentAsset
  className?: string
}) {
  const url = assetUrl(topicId, asset.path)
  if (isVideoAsset(asset.path)) {
    return (
      <video
        src={`${url}#t=0.1`}
        muted
        playsInline
        preload='metadata'
        aria-label={asset.alt ?? asset.path}
        className={className}
      />
    )
  }
  return <img src={url} alt={asset.alt ?? asset.path} loading='lazy' className={className} />
}
