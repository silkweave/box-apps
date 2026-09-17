// P2 LinkedIn publisher - the gated `linkedin-publish` automation op (parameterized:
// content_id + confirm). Turns an **approved** linkedin ContentPiece into a real post via the
// Community Management Posts API (`POST /rest/posts`), then stamps the row published:
// `published_url` from the returned URN, `metadata.post_urn` (the join key the daily pull uses
// for per-post analytics), `published_at`/`published_by`, status → published. Human-gated
// (rule #5): a person triggers it with an explicit confirm param; anything not `approved`
// refuses. Spec: features/content/SPEC.md.

import { readFileSync } from 'node:fs'
import { readAccountsFile, defaultAccount } from '../../accounts.js'
import { linkedinAuthReady, linkedinPersonUrn, linkedinPost, linkedinUploadImage } from '../data/pulls/linkedin-client.js'
import { todayUtc, type IngestProgress } from '../../ops/types.js'
import { contentAssetFile, readContentDoc, readFrontmatterField } from './docs.js'
import { readContentPiece, readContentPieces, upsertContent } from './state.js'
import { COMPANY_AUTHOR, isPublishDue, pieceAssets } from './types.js'

export interface LinkedinPublishParams {
  content_id: string
  /** Hard gate - must be the string 'true' for the post to be sent. */
  confirm: string
  /** users.id triggering the publish (stamps published_by; defaults to the piece's author). */
  actor?: string
}

/**
 * LinkedIn "little text" - `commentary` treats these as formatting/mention syntax, so literal
 * occurrences must be backslash-escaped or parentheses/brackets silently vanish from the post.
 */
export function escapeLittleText(s: string): string {
  return s.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`)
}

/** The markdown body minus its YAML frontmatter block, trimmed - what actually gets posted. */
export function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
}

/**
 * Resolve the post's author URN from the piece's `metadata.author` (a users.id, or `company`
 * for the company page). Member posts use THAT member's own token set (`linkedin@<account>` in
 * credentials.json); page posts use the default account's token + its `org` id (needs
 * w_organization_social - granted).
 *
 * GAP (2026-09-13): the template has no way to MINT a member token. The predecessor engine's
 * `pnpm linkedin:auth` was a one-shot script and those do not ship (an operation a feature wants from a terminal is an @Mcp
 * tool), but no replacement tool was written, so member posting cannot be set up from a fresh Box.
 * Tracked in _docs/NEXT-SESSION.md.
 */
function resolveAuthorUrn(author: string): { urn: string; kind: 'member' | 'org'; account: string } {
  const dflt = defaultAccount('linkedin')
  if (author === COMPANY_AUTHOR) {
    if (!dflt.org) throw new Error('accounts.json linkedin default has no `org` id - cannot page-post')
    return { urn: `urn:li:organization:${dflt.org}`, kind: 'org', account: dflt.id }
  }
  const acct = (readAccountsFile().linkedin ?? []).find((a) => a.user === author)
  if (!acct) {
    throw new Error(`unknown linkedin author "${author}" - use a users.id from config/accounts.json or "${COMPANY_AUTHOR}"`)
  }
  if (!linkedinAuthReady(acct.id)) {
    throw new Error(
      `linkedin@${acct.id} has no member token, and this Box has no tool to mint one yet ` +
        '(see the GAP note above) - add the token to config/credentials.json by hand for now.',
    )
  }
  return { urn: linkedinPersonUrn(acct.id), kind: 'member', account: acct.id }
}

/**
 * The piece's author for publishing purposes. Every drafting skill (draft-content etc.) writes
 * `author:` into the body's YAML frontmatter - that's the only place it's ever actually set - so
 * frontmatter is authoritative here. `metadata.author` (a separate DB field nothing populates in
 * the normal authoring flow) is a legacy/manual override, checked second. Falls back to the
 * default account only when neither is set. (Bug found 2026-07-17: this used to read
 * metadata.author ONLY, which is silently always empty in practice, so every piece posted as the
 * default account regardless of its frontmatter author - see docs/BACKLOG.md step 3c.)
 */
export function resolvePieceAuthor(docContent: string, metadata: Record<string, unknown>): string {
  return readFrontmatterField(docContent, 'author') || String(metadata.author ?? '') || defaultAccount('linkedin').user
}

const CH = 'linkedin-publish' // progress-stream channel label

/**
 * The `linkedin-publish` automation action. Validates the gate (approved piece + confirm),
 * posts the body as the resolved author, and flips the piece to published with the post URN
 * stamped. The URN also makes the piece visible to the daily pull's per-post analytics join.
 */
export async function* linkedinPublishAction(params: LinkedinPublishParams): AsyncGenerator<IngestProgress> {
  const { content_id } = params
  if (!content_id) throw new Error('linkedin-publish needs params { content_id, confirm: "true" }')
  if (params.confirm !== 'true') {
    throw new Error('linkedin-publish refused: this SENDS a real post - pass params confirm:"true" to proceed')
  }
  yield { channel: CH, phase: 'start', message: `publishing ${content_id}` }

  const piece = await readContentPiece(content_id)
  if (!piece) throw new Error(`no content piece "${content_id}"`)
  if (piece.channel !== 'linkedin') throw new Error(`piece "${content_id}" is ${piece.channel}, not linkedin`)
  if (!isPublishDue(piece)) {
    throw new Error(
      piece.status === 'scheduled'
        ? `linkedin-publish refused: piece "${content_id}" is scheduled for ${piece.scheduled_at} - wait for it, or re-run the "publish now" transition to send immediately`
        : `linkedin-publish refused: piece "${content_id}" is "${piece.status}" - a piece sends only once it is "scheduled" with its time passed (the "schedule" / "publish now" transitions arm it; "approved" alone never sends)`,
    )
  }
  const doc = readContentDoc(content_id)
  if (!doc.exists) throw new Error(`piece "${content_id}" has no body on disk (${doc.path})`)
  const text = stripFrontmatter(doc.content)
  if (!text) throw new Error(`piece "${content_id}" body is empty after stripping frontmatter`)

  const author = resolvePieceAuthor(doc.content, piece.metadata)
  const { urn: authorUrn, kind, account } = resolveAuthorUrn(author)

  // A `feature` (or, failing that, `social`) asset becomes the post's image - one upload
  // (initializeUpload + PUT bytes), then referenced by URN in the post's content.media.
  //
  // The order was the other way round until 2026-08-12, and it published the WRONG IMAGE on Dan's
  // "dad mode" post: a human attached the picture they wanted and marked it `feature`, a `social`
  // illustration from an earlier pass was still on the piece, and `social` silently won. Feature wins
  // now, because that is the only reading the rest of the system already agrees on - `AssetsPanel`
  // auto-marks the first image `feature`, gives features their own section and an accent badge, and
  // `linkedin-article` has always used `feature` exclusively. `social` stays as an explicit override
  // for the case it was meant for (a feed-cropped variant on a piece whose feature is a blog cover),
  // which is why it is a fallback rather than deleted. Safe to flip: no piece in the warehouse carries
  // both usages, so no existing piece changes image.
  const assets = pieceAssets(piece.metadata)
  const featureAsset = assets.find((a) => a.usage === 'feature') ?? assets.find((a) => a.usage === 'social')
  let media: { id: string; altText?: string } | undefined
  if (featureAsset) {
    yield { channel: CH, phase: 'fetch', message: `uploading image ${featureAsset.path}` }
    const { abs } = contentAssetFile(content_id.split('/')[0]!, featureAsset.path)
    const imageUrn = await linkedinUploadImage(readFileSync(abs), authorUrn, account)
    media = { id: imageUrn, ...(featureAsset.alt ? { altText: featureAsset.alt } : {}) }
  }

  yield {
    channel: CH,
    phase: 'fetch',
    message: `POST /rest/posts as ${author} (${kind}: ${authorUrn}) - ${text.length} chars${media ? ' + image' : ''}`,
  }
  const { id: postUrn } = await linkedinPost(
    '/rest/posts',
    {
      author: authorUrn,
      commentary: escapeLittleText(text),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(media ? { content: { media } } : {}),
    },
    account,
  )
  if (!postUrn) throw new Error('post created but LinkedIn returned no URN (x-restli-id header missing)')
  const publishedUrl = `https://www.linkedin.com/feed/update/${postUrn}/`

  yield { channel: CH, phase: 'persist', message: `posted ${postUrn} - stamping the piece published` }
  await upsertContent({
    id: content_id,
    status: 'published',
    published_url: publishedUrl,
    published_at: new Date().toISOString(),
    published_by: params.actor ?? (kind === 'member' ? author : defaultAccount('linkedin').user),
    metadata: { ...piece.metadata, post_urn: postUrn },
    ...(params.actor ? { actor: params.actor } : {}),
  })

  // First comment (legacy Zernio parity): metadata.first_comment posts as the author's own reply -
  // the usual home for links, which suppress reach in the post body. Comment failure never fails
  // the run: the post itself is live and recorded; the miss is surfaced in the run log/summary.
  const firstComment = String(piece.metadata.first_comment ?? '').trim()
  let commentNote = ''
  if (firstComment) {
    yield { channel: CH, phase: 'fetch', message: `posting first comment (${firstComment.length} chars)` }
    try {
      const { id: commentUrn } = await linkedinPost(
        `/rest/socialActions/${encodeURIComponent(postUrn)}/comments`,
        { actor: authorUrn, object: postUrn, message: { text: firstComment } },
        account,
      )
      if (commentUrn) await upsertContent({ id: content_id, metadata: { first_comment_urn: commentUrn } })
      commentNote = ' (+first comment)'
    } catch (err) {
      commentNote = ` (first comment FAILED: ${err instanceof Error ? err.message : String(err)})`
    }
  }

  const summary = `published ${content_id} as ${author} → ${publishedUrl}${commentNote}`
  yield { channel: CH, phase: 'done', message: summary, result: { channel: CH, date: todayUtc(), summary } }
}

/** Opt-in env switch: the scheduled publisher SENDS only when this is exactly '1'. */
export const LINKEDIN_PUBLISH_LIVE = 'LINKEDIN_PUBLISH_LIVE'

/**
 * The `linkedin-publish-approved` automation action - the SCHEDULABLE (non-parameterized) publisher.
 * (The id is historical: since 2026-07-30 `approved` arms nothing, and only `scheduled` pieces ship.
 * It stays as-is because `publish-linkedin` in config/schedules.json references it.)
 * Scans linkedin AND linkedin-article pieces that are DUE (`scheduled` with `scheduled_at` passed -
 * see isPublishDue), takes the most overdue (per-run publish cap: 1 - a misconfigured cron
 * can never mass-post), and delegates per channel: `linkedin` → linkedinPublishAction (Posts API),
 * `linkedin-article` → linkedinArticlePublishAction (the author's browser - articles have no API).
 * A `scheduled` piece whose time hasn't arrived is left alone and reported as waiting. Safety
 * rails: it runs in dry-run mode unless LINKEDIN_PUBLISH_LIVE=1 (dry-run still validates the body
 * + the author's token/browser so the run report shows exactly what a live run would do), and any
 * thrown error lands in the `run.error` event the op-run-error alert rule already delivers.
 */
export async function* linkedinPublishApprovedAction(): AsyncGenerator<IngestProgress> {
  const live = process.env[LINKEDIN_PUBLISH_LIVE] === '1'
  const CHA = 'linkedin-publish-approved'
  yield {
    channel: CHA,
    phase: 'start',
    message: live ? 'scanning due linkedin pieces (LIVE)' : `scanning due linkedin pieces (dry-run - set ${LINKEDIN_PUBLISH_LIVE}=1 to arm)`,
  }

  const now = new Date()
  // Armed pieces only: `scheduled` is the one state that means "send this", and it always carries a
  // time (2026-07-30 - `approved` used to arm the publisher too, so a sign-off posted publicly).
  const candidates = (await readContentPieces()).filter(
    (p) => (p.channel === 'linkedin' || p.channel === 'linkedin-article') && p.status === 'scheduled',
  )
  const waiting = candidates.filter((p) => !isPublishDue(p, now))
  // Longest-overdue first: every due piece has a chosen time, so the earliest one goes out next.
  const due = candidates
    .filter((p) => isPublishDue(p, now))
    .sort((a, b) => (a.scheduled_at ?? a.updated_at).localeCompare(b.scheduled_at ?? b.updated_at))
  const waitNote = waiting.length
    ? ` (${waiting.length} scheduled piece(s) not due yet, next: ${waiting.map((p) => p.scheduled_at).sort()[0]})`
    : ''
  if (due.length === 0) {
    const summary = `no due linkedin pieces - nothing to publish${waitNote}`
    yield { channel: CHA, phase: 'done', message: summary, result: { channel: CHA, date: todayUtc(), summary } }
    return
  }

  const next = due[0]!
  const queued = due.length - 1
  if (queued > 0 || waiting.length > 0) {
    yield { channel: CHA, phase: 'fetch', message: `cap 1/run: publishing most urgent of ${due.length} due, ${queued} stay queued${waitNote}` }
  }

  if (!live) {
    // Validate everything a live run would need, without sending.
    const blockers: string[] = []
    const doc = readContentDoc(next.id)
    if (!doc.exists || !stripFrontmatter(doc.content)) blockers.push(`no body on disk (${doc.path})`)
    const author = resolvePieceAuthor(doc.content, next.metadata)
    if (next.channel === 'linkedin-article') {
      const { browserIdentity } = await import('../data/browsers.js')
      if (!browserIdentity(author)) blockers.push(`no browser for "${author}" in config/browsers.json`)
      if (!next.title) blockers.push('no title')
    } else {
      try {
        resolveAuthorUrn(author)
      } catch (err) {
        blockers.push(err instanceof Error ? err.message : String(err))
      }
    }
    const summary = blockers.length
      ? `DRY-RUN: would publish "${next.id}" as ${author}, but it would FAIL: ${blockers.join('; ')}`
      : `DRY-RUN: would publish "${next.id}" as ${author}${queued ? ` (+${queued} queued)` : ''} - set ${LINKEDIN_PUBLISH_LIVE}=1 to arm`
    yield { channel: CHA, phase: 'done', message: summary, result: { channel: CHA, date: todayUtc(), summary } }
    return
  }

  if (next.channel === 'linkedin-article') {
    // Lazy import: linkedin-article.ts imports helpers from this module, so a static import here
    // would create a cycle.
    const { linkedinArticlePublishAction } = await import('./linkedin-article.js')
    yield* linkedinArticlePublishAction({ content_id: next.id, confirm: 'true' })
    return
  }
  yield* linkedinPublishAction({ content_id: next.id, confirm: 'true' })
}
