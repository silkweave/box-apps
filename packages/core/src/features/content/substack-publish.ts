// Substack publisher - `substack-draft` (safe: creates/updates a draft, never sends),
// `substack-publish` (the gated send), and `substack-publish-due` (the schedulable one).
//
// Substack is the third publish path in this repo and the first to reach a real write API on a
// platform that never offered one. LinkedIn posts go through an official API; LinkedIn newsletter
// articles are driven through the author's browser because no API exists. Substack sits between:
// the API is real and complete, but it is the dashboard's own private one, authenticated by a
// session cookie (see pulls/substack-session.ts). That makes it far better than DOM-driving an
// editor and still means it can change without notice, so every op fails loudly rather than
// half-posting.
//
// **The email is the irreversible half.** `POST /drafts/:id/publish` takes `send`, and a post goes
// live on the web either way - but an email to the list cannot be recalled. So `send` defaults to
// FALSE here even though the API's own default is true: a piece has to ask for the email with
// `metadata.send_email: true`. The intent is also written onto the draft (`should_send_email`)
// before publishing, because `should_send_email` is where the dashboard keeps the decision and it
// defaults to true on a real draft. If the publish endpoint turns out to read the draft rather than
// the request body, a call carrying only `send: false` would otherwise mail the entire list.

import { readFileSync } from 'node:fs'
import { defaultAccount, readAccountsFile, type ChannelAccount } from '../../accounts.js'
import {
  createDraft,
  getSelfProfile,
  publishDraft,
  updateDraft,
  uploadImage,
  type SubstackTarget,
} from '../data/pulls/substack-client.js'
import { todayUtc, type IngestProgress } from '../../ops/types.js'
import { contentAssetFile, readContentDoc, readFrontmatterField } from './docs.js'
import { readContentPiece, readContentPieces, upsertContent } from './state.js'
import { markdownToSubstackDoc, summarizeDoc, type SubstackDoc } from './substack-doc.js'
import { isPublishDue } from './types.js'
import { stripFrontmatter } from './linkedin-publish.js'

export interface SubstackDraftParams {
  content_id: string
  /** users.id triggering the run (stamps audit fields; defaults to the piece's author). */
  actor?: string
}

export interface SubstackPublishParams extends SubstackDraftParams {
  /** Hard gate - must be the string 'true' for the post to go live. */
  confirm: string
}

/** Opt-in env switch: the scheduled publisher SENDS only when this is exactly '1'. */
export const SUBSTACK_PUBLISH_LIVE = 'SUBSTACK_PUBLISH_LIVE'

/** Substack audiences, as the API names them. `everyone` is the default for a free newsletter. */
const AUDIENCES = ['everyone', 'only_paid', 'only_free', 'founding'] as const

/**
 * Resolve the account whose publication a piece goes to, from the piece's author. One account per
 * publication: unlike LinkedIn there is no company-page equivalent to disambiguate, so the author
 * simply picks which configured Substack account writes.
 */
function resolveTarget(author: string): { target: SubstackTarget; account: ChannelAccount } {
  const accounts = readAccountsFile().substack ?? []
  const account = accounts.find((a) => a.user === author) ?? defaultAccount('substack')
  if (!account.publication) {
    throw new Error(
      `substack account "${account.id}" has no \`publication\` in config/accounts.json - ` +
        'set it to the publication origin, e.g. "https://acme.substack.com"',
    )
  }
  return {
    account,
    target: { account: account.id, owner: account.user, publication: account.publication },
  }
}

/** The piece's author: body frontmatter first (the only place drafting skills ever set it), then
 *  the metadata override, then the default account's owner. Mirrors resolvePieceAuthor's ordering
 *  for linkedin, with substack's own default. */
function pieceAuthor(docContent: string, metadata: Record<string, unknown>): string {
  return (
    readFrontmatterField(docContent, 'author') ||
    String(metadata.author ?? '') ||
    defaultAccount('substack').user
  )
}

/**
 * Build the `draft_body` document, uploading any image the markdown references so its src is a
 * Substack-hosted URL. Images are uploaded ONCE per run and memoised by src: a body that shows the
 * same diagram twice should not cost two uploads or produce two copies in the media library.
 */
async function buildDoc(
  target: SubstackTarget,
  topicId: string,
  markdown: string,
): Promise<{ doc: SubstackDoc; uploaded: number }> {
  // The converter is synchronous (it is a parser), so image uploads happen in a pre-pass: find
  // every standalone image, upload it, and hand the converter a finished lookup.
  const srcs = [...markdown.matchAll(/^!\[[^\]]*\]\(([^)\s]+)\)$/gm)].map((m) => m[1]!)
  const hosted = new Map<string, string>()
  for (const src of new Set(srcs)) {
    if (/^https?:\/\/[^/]*substackcdn\.com|^https?:\/\/[^/]*substack-post-media/.test(src)) {
      hosted.set(src, src) // already ours
      continue
    }
    const file = src.replace(/^\.\//, '')
    const { abs, mime } = contentAssetFile(topicId, file)
    const dataUri = `data:${mime};base64,${readFileSync(abs).toString('base64')}`
    const { url } = await uploadImage(target, dataUri)
    hosted.set(src, url)
  }
  return {
    doc: markdownToSubstackDoc(markdown, { resolveImage: (src) => hosted.get(src) }),
    uploaded: hosted.size,
  }
}

/**
 * The full draft record `POST /drafts` takes. Verified live 2026-08-16 by creating a draft from a
 * real 8.4k-char blog body and reading it back: title and subtitle land verbatim, and the body
 * round-trips BYTE-IDENTICAL, so nothing in the converter is being silently rewritten by Substack.
 *
 * Two shape traps:
 *   • `draft_body` is a JSON **string**, not a nested object.
 *   • The byline is written as `draft_bylines: [{id, is_guest}]` and read back under a different
 *     name and shape - `postBylines: [{user_id, is_guest, is_draft, user: {…}}]`. Confirmed to
 *     attach the right user, so an absent `draft_bylines` in a read is not evidence it was ignored.
 */
export function buildDraftPayload(opts: {
  doc: SubstackDoc
  title: string
  subtitle: string | null
  userId: number
  audience: string
}): Record<string, unknown> {
  return {
    draft_title: opts.title,
    draft_subtitle: opts.subtitle,
    draft_body: JSON.stringify(opts.doc),
    draft_bylines: [{ id: opts.userId, is_guest: false }],
    audience: opts.audience,
    write_comment_permissions: opts.audience,
    draft_section_id: null,
    section_chosen: true,
  }
}

/** Read the audience off the piece, refusing an unknown one rather than posting to the wrong list. */
function pieceAudience(metadata: Record<string, unknown>): string {
  const raw = String(metadata.audience ?? 'everyone')
  if (!(AUDIENCES as readonly string[]).includes(raw)) {
    throw new Error(`unknown substack audience "${raw}" - one of ${AUDIENCES.join(', ')}`)
  }
  return raw
}

/** Whether this piece wants the email blast. Absent means no: see the header. */
function wantsEmail(metadata: Record<string, unknown>): boolean {
  return metadata.send_email === true || metadata.send_email === 'true'
}

/**
 * Create the draft if the piece has none, otherwise update the one it already has. Returns the
 * draft id, which is stamped onto the piece so a re-run edits rather than duplicating - a second
 * `substack-draft` producing a second draft is the failure that makes a drafting loop unusable.
 */
async function syncDraft(
  target: SubstackTarget,
  piece: { title: string; metadata: Record<string, unknown> },
  markdown: string,
  topicId: string,
): Promise<{ draftId: number; nodes: Record<string, number>; uploaded: number; created: boolean }> {
  const { doc, uploaded } = await buildDoc(target, topicId, markdown)
  const self = await getSelfProfile(target)
  const payload = buildDraftPayload({
    doc,
    title: piece.title,
    subtitle: (String(piece.metadata.subtitle ?? '').trim() || null) as string | null,
    userId: self.id,
    audience: pieceAudience(piece.metadata),
  })

  const existing = Number(piece.metadata.draft_id ?? 0)
  const res = existing ? await updateDraft(target, existing, payload) : await createDraft(target, payload)
  const draftId = res.id ?? existing
  if (!draftId) throw new Error('substack accepted the draft but returned no id')
  return { draftId, nodes: summarizeDoc(doc), uploaded, created: !existing }
}

/** Load a piece + its body, refusing anything that is not a substack piece with a body on disk. */
async function loadPiece(contentId: string) {
  if (!contentId) throw new Error('substack ops need params { content_id }')
  const piece = await readContentPiece(contentId)
  if (!piece) throw new Error(`no content piece "${contentId}"`)
  if (piece.channel !== 'substack') throw new Error(`piece "${contentId}" is ${piece.channel}, not substack`)
  const doc = readContentDoc(contentId)
  if (!doc.exists) throw new Error(`piece "${contentId}" has no body on disk (${doc.path})`)
  const markdown = stripFrontmatter(doc.content)
  if (!markdown) throw new Error(`piece "${contentId}" body is empty after stripping frontmatter`)
  if (!piece.title.trim()) throw new Error(`piece "${contentId}" has no title - a Substack post needs one`)
  const author = pieceAuthor(doc.content, piece.metadata)
  return { piece, markdown, author, ...resolveTarget(author) }
}

const CH = 'substack-draft'

/**
 * The `substack-draft` action - push the piece into a Substack DRAFT and stop there. Safe by
 * construction: it touches `/drafts` only, so the worst outcome is a draft nobody wanted, which is
 * one click to delete. This is the op to run while a piece is still being worked on, and the one
 * that proves the whole path (session, conversion, upload) before anything goes live.
 */
export async function* substackDraftAction(params: SubstackDraftParams): AsyncGenerator<IngestProgress> {
  const { content_id } = params
  yield { channel: CH, phase: 'start', message: `drafting ${content_id}` }

  const { piece, markdown, author, target } = await loadPiece(content_id)
  yield { channel: CH, phase: 'fetch', message: `converting ${markdown.length} chars as ${author} → ${target.publication}` }

  const { draftId, nodes, uploaded, created } = await syncDraft(target, piece, markdown, piece.topic_id)

  yield { channel: CH, phase: 'persist', message: `${created ? 'created' : 'updated'} draft ${draftId} - stamping the piece` }
  await upsertContent({
    id: content_id,
    metadata: { ...piece.metadata, draft_id: draftId },
    ...(params.actor ? { actor: params.actor } : {}),
  })

  const shape = Object.entries(nodes)
    .map(([type, n]) => `${n} ${type}`)
    .join(', ')
  const summary =
    `${created ? 'created' : 'updated'} substack draft ${draftId} for ${content_id} ` +
    `(${shape}${uploaded ? `; ${uploaded} image(s) uploaded` : ''}) → ${target.publication}/publish/post/${draftId}`
  yield { channel: CH, phase: 'done', message: summary, result: { channel: CH, date: todayUtc(), summary } }
}

const CHP = 'substack-publish'

/**
 * The `substack-publish` action - the gated send. Syncs the draft one last time (so what publishes
 * is what the piece says right now, not whatever a draft run left behind days ago), writes the
 * email intent, publishes, and stamps the piece published with its canonical URL and post id.
 */
export async function* substackPublishAction(params: SubstackPublishParams): AsyncGenerator<IngestProgress> {
  const { content_id } = params
  if (params.confirm !== 'true') {
    throw new Error('substack-publish refused: this PUBLISHES a real post - pass params confirm:"true" to proceed')
  }
  yield { channel: CHP, phase: 'start', message: `publishing ${content_id}` }

  const { piece, markdown, author, target } = await loadPiece(content_id)
  if (!isPublishDue(piece)) {
    throw new Error(
      piece.status === 'scheduled'
        ? `substack-publish refused: piece "${content_id}" is scheduled for ${piece.scheduled_at} - wait for it, or re-run the "publish now" transition to send immediately`
        : `substack-publish refused: piece "${content_id}" is "${piece.status}" - a piece sends only once it is "scheduled" with its time passed ("approved" alone never sends)`,
    )
  }

  const send = wantsEmail(piece.metadata)
  yield { channel: CHP, phase: 'fetch', message: `syncing draft as ${author}${send ? ' (WILL EMAIL the list)' : ' (web only, no email)'}` }
  const { draftId, uploaded } = await syncDraft(target, piece, markdown, piece.topic_id)

  // Belt and braces, and not for its own sake: see the header on `should_send_email`.
  await updateDraft(target, draftId, { should_send_email: send })

  yield { channel: CHP, phase: 'fetch', message: `POST /drafts/${draftId}/publish (send: ${send})` }
  const post = await publishDraft(target, draftId, { send })

  const publishedUrl =
    post.canonical_url ?? (post.slug ? `${target.publication}/p/${post.slug}` : `${target.publication}/publish/posts`)

  yield { channel: CHP, phase: 'persist', message: `published ${post.id ?? draftId} - stamping the piece` }
  await upsertContent({
    id: content_id,
    status: 'published',
    published_url: publishedUrl,
    published_at: new Date().toISOString(),
    published_by: params.actor ?? author,
    metadata: {
      ...piece.metadata,
      draft_id: draftId,
      post_id: post.id ?? draftId,
      // The server's own record of whether it mailed, which is the only trustworthy answer -
      // `send` above is only what was asked for.
      email_sent_at: post.email_sent_at ?? null,
    },
    ...(params.actor ? { actor: params.actor } : {}),
  })

  const summary =
    `published ${content_id} as ${author} → ${publishedUrl}` +
    `${post.email_sent_at ? ' (emailed the list)' : ' (web only)'}${uploaded ? ` · ${uploaded} image(s)` : ''}`
  yield { channel: CHP, phase: 'done', message: summary, result: { channel: CHP, date: todayUtc(), summary } }
}

const CHD = 'substack-publish-due'

/**
 * The SCHEDULABLE publisher: take the most overdue DUE substack piece and publish it. Same rails as
 * the LinkedIn one, for the same reasons - cap 1 per run so a misconfigured cron can never mass-post,
 * and dry-run unless SUBSTACK_PUBLISH_LIVE=1 in the server env. The dry run still resolves the
 * session, the author and the body, so its report says exactly what a live run would do.
 */
export async function* substackPublishDueAction(): AsyncGenerator<IngestProgress> {
  const live = process.env[SUBSTACK_PUBLISH_LIVE] === '1'
  yield {
    channel: CHD,
    phase: 'start',
    message: live ? 'scanning due substack pieces (LIVE)' : `scanning due substack pieces (dry-run - set ${SUBSTACK_PUBLISH_LIVE}=1 to arm)`,
  }

  const now = new Date()
  const candidates = (await readContentPieces()).filter((p) => p.channel === 'substack' && p.status === 'scheduled')
  const waiting = candidates.filter((p) => !isPublishDue(p, now))
  const due = candidates
    .filter((p) => isPublishDue(p, now))
    .sort((a, b) => (a.scheduled_at ?? a.updated_at).localeCompare(b.scheduled_at ?? b.updated_at))
  const waitNote = waiting.length
    ? ` (${waiting.length} scheduled piece(s) not due yet, next: ${waiting.map((p) => p.scheduled_at).sort()[0]})`
    : ''

  if (due.length === 0) {
    const summary = `no due substack pieces - nothing to publish${waitNote}`
    yield { channel: CHD, phase: 'done', message: summary, result: { channel: CHD, date: todayUtc(), summary } }
    return
  }

  const next = due[0]!
  const queued = due.length - 1
  if (queued > 0 || waiting.length > 0) {
    yield { channel: CHD, phase: 'fetch', message: `cap 1/run: publishing most urgent of ${due.length} due, ${queued} stay queued${waitNote}` }
  }

  if (!live) {
    const blockers: string[] = []
    let author = '?'
    let emails = false
    try {
      const loaded = await loadPiece(next.id)
      author = loaded.author
      emails = wantsEmail(loaded.piece.metadata)
      pieceAudience(loaded.piece.metadata)
    } catch (err) {
      blockers.push(err instanceof Error ? err.message : String(err))
    }
    const summary = blockers.length
      ? `DRY-RUN: would publish "${next.id}", but it would FAIL: ${blockers.join('; ')}`
      : `DRY-RUN: would publish "${next.id}" as ${author}${emails ? ' AND EMAIL the list' : ' (web only)'}` +
        `${queued ? ` (+${queued} queued)` : ''} - set ${SUBSTACK_PUBLISH_LIVE}=1 to arm`
    yield { channel: CHD, phase: 'done', message: summary, result: { channel: CHD, date: todayUtc(), summary } }
    return
  }

  yield* substackPublishAction({ content_id: next.id, confirm: 'true' })
}
