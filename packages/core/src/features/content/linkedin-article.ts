// LinkedIn NEWSLETTER article automation - the `linkedin-article-draft` (DRAFT only) and
// `linkedin-article-publish` (full gated publish) ops. LinkedIn has NO official API for
// articles/newsletters (confirmed 2026-07-17: the read-only Articles API was sunset; the Posts API
// `content.article` is just a link share), so both are browser flows: attach over CDP to the
// AUTHOR'S own logged-in Chrome (config/browsers.json) and drive the article editor. The editor
// pre-binds the article to the author's newsletter signal. Flow + gotchas live-verified 2026-07-18
// (edition 1) and written up in the wiki: agent-browser/linkedin-article-editor.md. Ported from the
// legacy repo's scripts/article_draft.py (the verified DOM selectors and single-paste ProseMirror
// trick carry over).

import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserIdentity } from '../data/browsers.js'
import { connectCDP, detach, firstContext } from '../data/cdp.js'
import { todayUtc, type IngestProgress } from '../../ops/types.js'
import { contentAssetFile, readContentDoc } from './docs.js'
import { resolvePieceAuthor, stripFrontmatter } from './linkedin-publish.js'
import { readContentPiece, upsertContent } from './state.js'
import { isPublishDue, pieceAssets } from './types.js'

export interface LinkedinArticleDraftParams {
  content_id: string
  /** users.id whose browser to drive (defaults to the piece's metadata.author). */
  actor?: string
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ESC[c] ?? c)

/** Inline markdown → HTML (links, bold, italic, code) on an ALREADY-ESCAPED line. */
function inline(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
}

/**
 * Minimal markdown → HTML for the LinkedIn article editor (ProseMirror paste target). Covers what
 * newsletter bodies use - h2/h3 headings, paragraphs, blockquotes, ordered/unordered lists, links,
 * bold/italic/code. Anything fancier (tables, nested lists, images) is out of scope: images are
 * uploaded by hand in the editor, and the /verify-content gate keeps bodies within this shape.
 */
export function articleHtml(md: string): string {
  const out: string[] = []
  let list: 'ol' | 'ul' | null = null
  const closeList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (const block of md.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trimEnd())
    const first = lines[0] ?? ''
    if (/^###\s/.test(first)) {
      closeList()
      out.push(`<h3>${inline(escapeHtml(first.replace(/^###\s+/, '')))}</h3>`)
    } else if (/^##\s/.test(first)) {
      closeList()
      out.push(`<h2>${inline(escapeHtml(first.replace(/^##\s+/, '')))}</h2>`)
    } else if (lines.every((l) => l.startsWith('>'))) {
      closeList()
      const inner = lines.map((l) => inline(escapeHtml(l.replace(/^>\s?/, '')))).join('<br>')
      out.push(`<blockquote>${inner}</blockquote>`)
    } else if (lines.every((l) => /^(\d+[.)]|[-*])\s/.test(l))) {
      const kind: 'ol' | 'ul' = /^\d/.test(first) ? 'ol' : 'ul'
      if (list !== kind) {
        closeList()
        out.push(`<${kind}>`)
        list = kind
      }
      for (const l of lines) out.push(`<li>${inline(escapeHtml(l.replace(/^(\d+[.)]|[-*])\s+/, '')))}</li>`)
      continue // keep the list open across adjacent blocks
    } else {
      closeList()
      out.push(`<p>${lines.map((l) => inline(escapeHtml(l))).join('<br>')}</p>`)
    }
  }
  closeList()
  return out.join('\n')
}

const CH = 'linkedin-article-draft' // progress-stream channel label

/** Chunk size for staging the HTML into the page (long articles overflow a single evaluate arg). */
const CHUNK = 6000

/**
 * The `linkedin-article-draft` automation action. Requires an `approved` linkedin-article piece
 * (the body is final; images/signal are added by hand). Drives the author's own Chrome, creates
 * the article DRAFT, and stamps `metadata.article_draft_url`. Never publishes (rule #5).
 */
export async function* linkedinArticleDraftAction(params: LinkedinArticleDraftParams): AsyncGenerator<IngestProgress> {
  const { content_id } = params
  if (!content_id) throw new Error('linkedin-article-draft needs params { content_id }')
  yield { channel: CH, phase: 'start', message: `drafting ${content_id} in the LinkedIn article editor` }

  const piece = await readContentPiece(content_id)
  if (!piece) throw new Error(`no content piece "${content_id}"`)
  if (piece.channel !== 'linkedin-article') {
    throw new Error(`piece "${content_id}" is ${piece.channel}, not linkedin-article`)
  }
  if (piece.status !== 'approved' && piece.status !== 'scheduled') {
    throw new Error(
      `linkedin-article-draft refused: piece "${content_id}" is "${piece.status}", must be "approved" or "scheduled"`,
    )
  }
  const doc = readContentDoc(content_id)
  if (!doc.exists) throw new Error(`piece "${content_id}" has no body on disk (${doc.path})`)
  const md = stripFrontmatter(doc.content)
  if (!md) throw new Error(`piece "${content_id}" body is empty after stripping frontmatter`)
  if (!piece.title) throw new Error(`piece "${content_id}" has no title - the article editor requires one`)

  const author = params.actor ?? resolvePieceAuthor(doc.content, piece.metadata)
  const identity = browserIdentity(author)
  if (!identity) {
    throw new Error(`no browser for "${author}" in config/browsers.json - the draft is created in THEIR logged-in Chrome`)
  }
  const html = articleHtml(md)

  yield { channel: CH, phase: 'fetch', message: `leasing a tab in ${author}'s browser (chromatrix "${identity}")` }
  const browser = await connectCDP(identity)
  try {
    const page = await firstContext(browser).newPage()
    try {
      await page.goto('https://www.linkedin.com/article/new/', { waitUntil: 'domcontentloaded' })
      // A login wall / security checkpoint means the session needs a human - fail loud, never solve.
      if (/checkpoint|login|authwall/.test(page.url())) {
        throw new Error(`LinkedIn wants a human (${page.url()}) - open ${author}'s browser and clear it, then re-run`)
      }
      const titleBox = page.locator('textarea[placeholder="Title"]')
      await titleBox.waitFor({ state: 'visible', timeout: 20_000 })
      await titleBox.fill(piece.title)

      // Stage the HTML into the page in chunks, then ONE synthetic paste onto the ProseMirror
      // editor (multiple pastes merge paragraphs - legacy-verified). text/plain rides along as a
      // fallback so a plain-text handler still gets the content.
      // String-form evaluate throughout: @silkweave/box-core compiles without the DOM lib (matching
      // alerts/linkedin.ts); JSON.stringify makes each chunk a safe JS literal.
      yield { channel: CH, phase: 'fetch', message: `pasting body (${html.length} chars of HTML)` }
      await page.evaluate('window.__articleHTML = ""')
      for (let i = 0; i < html.length; i += CHUNK) {
        await page.evaluate(`window.__articleHTML += ${JSON.stringify(html.slice(i, i + CHUNK))}`)
      }
      await page.evaluate(`(() => {
        const editor = document.querySelector('.ProseMirror[contenteditable="true"]')
        if (!editor) throw new Error('article editor (.ProseMirror) not found on the page')
        const dt = new DataTransfer()
        dt.setData('text/html', window.__articleHTML)
        dt.setData('text/plain', window.__articleHTML.replace(/<[^>]+>/g, ''))
        editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      })()`)

      // LinkedIn auto-saves; the URL flipping /article/new/ → /article/edit/<id>/ IS the draft.
      await page.waitForURL(/\/article\/edit\//, { timeout: 30_000 })
      const draftUrl = page.url()

      yield { channel: CH, phase: 'persist', message: `draft saved - stamping metadata.article_draft_url` }
      await upsertContent({ id: content_id, metadata: { article_draft_url: draftUrl } })

      const summary =
        `article draft for ${content_id} created in ${author}'s browser → ${draftUrl} ` +
        `(add images + the newsletter signal, publish by hand, then record it with content-publish)`
      yield { channel: CH, phase: 'done', message: summary, result: { channel: CH, date: todayUtc(), summary } }
    } finally {
      await page.close().catch(() => {})
    }
  } finally {
    await detach(browser)
  }
}

// --- full gated publish ---------------------------------------------------------------------------

export interface LinkedinArticlePublishParams {
  content_id: string
  /** Hard gate - must be the string 'true' for the article to be published. */
  confirm: string
  /** users.id triggering the publish (stamps published_by; defaults to the piece's author). */
  actor?: string
}

const CHP = 'linkedin-article-publish' // progress-stream channel label

/**
 * The `linkedin-article-publish` automation action - the browser-driven FULL publish for
 * newsletter articles (no API exists, so the browser IS the transport). Requires a DUE piece
 * (`approved`, or `scheduled` with `scheduled_at` passed) plus confirm:"true". Drives the author's
 * own Chrome end to end: cover image (`metadata.assets` feature entry, uploaded via filechooser
 * interception - the editor has no persistent file input) with its `alt` as the credit/caption,
 * title, body as one synthetic ProseMirror paste, then the publish dialog: the announcement feed
 * post (`metadata.announcement_text`, typed as REAL keystrokes - the dialog's Quill composer
 * silently ignores synthetic paste) and the Publish click. Captures the live article URL and flips
 * the piece to published. The announcement post doubles as the channel's same-day companion post.
 */
export async function* linkedinArticlePublishAction(
  params: LinkedinArticlePublishParams,
): AsyncGenerator<IngestProgress> {
  const { content_id } = params
  if (!content_id) throw new Error('linkedin-article-publish needs params { content_id, confirm: "true" }')
  if (params.confirm !== 'true') {
    throw new Error('linkedin-article-publish refused: this PUBLISHES a real newsletter edition - pass params confirm:"true" to proceed')
  }
  yield { channel: CHP, phase: 'start', message: `publishing ${content_id} via the article editor` }

  const piece = await readContentPiece(content_id)
  if (!piece) throw new Error(`no content piece "${content_id}"`)
  if (piece.channel !== 'linkedin-article') {
    throw new Error(`piece "${content_id}" is ${piece.channel}, not linkedin-article`)
  }
  if (!isPublishDue(piece)) {
    throw new Error(
      piece.status === 'scheduled'
        ? `linkedin-article-publish refused: piece "${content_id}" is scheduled for ${piece.scheduled_at} - wait for it, or re-run the "publish now" transition to publish immediately`
        : `linkedin-article-publish refused: piece "${content_id}" is "${piece.status}" - a piece publishes only once it is "scheduled" with its time passed (the "schedule" / "publish now" transitions arm it; "approved" alone never publishes)`,
    )
  }
  const doc = readContentDoc(content_id)
  if (!doc.exists) throw new Error(`piece "${content_id}" has no body on disk (${doc.path})`)
  const md = stripFrontmatter(doc.content)
  if (!md) throw new Error(`piece "${content_id}" body is empty after stripping frontmatter`)
  if (!piece.title) throw new Error(`piece "${content_id}" has no title - the article editor requires one`)

  const author = resolvePieceAuthor(doc.content, piece.metadata)
  const identity = browserIdentity(author)
  if (!identity) {
    throw new Error(`no browser for "${author}" in config/browsers.json - the article publishes from THEIR logged-in Chrome`)
  }
  const featureAsset = pieceAssets(piece.metadata).find((a) => a.usage === 'feature')
  const announcement = String(piece.metadata.announcement_text ?? '').trim()
  const html = articleHtml(md)

  yield { channel: CHP, phase: 'fetch', message: `leasing a tab in ${author}'s browser (chromatrix "${identity}")` }
  const browser = await connectCDP(identity)
  try {
    const page = await firstContext(browser).newPage()
    try {
      // LinkedIn keeps connections open, so the `load` event can hang forever - use DCL (wiki:
      // agent-browser/linkedin-page-load-event-hangs).
      await page.goto('https://www.linkedin.com/article/new/', { waitUntil: 'domcontentloaded' })
      if (/checkpoint|login|authwall/.test(page.url())) {
        throw new Error(`LinkedIn wants a human (${page.url()}) - open ${author}'s browser and clear it, then re-run`)
      }
      const titleBox = page.locator('textarea[placeholder="Title"]')
      await titleBox.waitFor({ state: 'visible', timeout: 20_000 })

      // The caption textarea only exists while a cover is applied - it doubles as the "is the
      // cover still there?" probe after LinkedIn's editor remounts.
      const caption = page.locator('textarea[placeholder*="credit and caption" i]')

      /** Chooser-intercepted cover upload + modal confirm (the editor has no persistent file
       *  input; the modal's Next is an ARIA button, NOT a <button> tag - match by role, scoped to
       *  LinkedIn's stable #artdeco-modal-outlet portal - and the modal must be GONE before the
       *  editor is touched again). */
      const uploadCover = async (abs: string): Promise<void> => {
        const chooser = page.waitForEvent('filechooser', { timeout: 15_000 })
        await page.getByRole('button', { name: 'Upload from computer' }).click()
        await (await chooser).setFiles(abs)
        const coverHeading = page.getByRole('heading', { name: /add cover image/i })
        await coverHeading.waitFor({ state: 'visible', timeout: 15_000 })
        await page.locator('#artdeco-modal-outlet').getByRole('button', { name: 'Next' }).click()
        await coverHeading.waitFor({ state: 'hidden', timeout: 15_000 })
      }

      /** Plain text length currently inside the article editor - the ground truth for "did the
       *  paste stick?". String-form evaluate: no DOM lib in core. */
      const editorTextLength = async (): Promise<number> =>
        Number(await page.evaluate(`(document.querySelector('.ProseMirror')?.innerText ?? '').trim().length`))

      /** Stage the HTML in chunks, dispatch ONE synthetic paste, and report the resulting editor
       *  text length after a settle (multiple paste EVENTS merge paragraphs, so re-pastes only
       *  happen when the previous one left the editor empty). */
      const pasteBody = async (): Promise<number> => {
        await page.evaluate('window.__articleHTML = ""')
        for (let i = 0; i < html.length; i += CHUNK) {
          await page.evaluate(`window.__articleHTML += ${JSON.stringify(html.slice(i, i + CHUNK))}`)
        }
        await page.evaluate(`(() => {
          const editor = document.querySelector('.ProseMirror[contenteditable="true"]')
          if (!editor) throw new Error('article editor (.ProseMirror) not found on the page')
          const dt = new DataTransfer()
          dt.setData('text/html', window.__articleHTML)
          dt.setData('text/plain', window.__articleHTML.replace(/<[^>]+>/g, ''))
          editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        })()`)
        await page.waitForTimeout(1_500)
        return editorTextLength()
      }
      // A dropped paste reads ~0; the real body is far longer. Threshold, not equality: LinkedIn
      // normalizes whitespace so the editor text never exactly matches the source.
      const MIN_BODY_CHARS = 500

      // Cover image first: uploading it alone already flips /article/new/ → /article/edit/<id>/
      // (the auto-saved draft). The editor creates its file input on click, so intercept the
      // filechooser instead of looking for an input node.
      if (featureAsset) {
        yield { channel: CHP, phase: 'fetch', message: `uploading cover ${featureAsset.path}` }
        const { abs } = contentAssetFile(content_id.split('/')[0]!, featureAsset.path)
        readFileSync(abs) // fail loud here (clear message) rather than inside the chooser
        await uploadCover(abs)
        // Uploading the cover creates the draft: the URL flips /article/new/ → /article/edit/<id>/
        // and the editor REMOUNTS onto the persisted server draft. Content set client-side before
        // that remount lands can be silently WIPED (third live run: caption briefly visible, then
        // final state had no cover and no body - "Body text is required" toast). So: wait out the
        // flip + remount BEFORE touching title/body, then verify the cover actually survived.
        await page.waitForURL(/\/article\/edit\//, { timeout: 30_000 })
        await page.waitForTimeout(3_000)
        if ((await caption.count()) === 0) {
          yield { channel: CHP, phase: 'fetch', message: 'cover lost in the editor remount - re-uploading' }
          await uploadCover(abs)
          await page.waitForTimeout(2_000)
        }
        if (featureAsset.alt && (await caption.count())) await caption.fill(featureAsset.alt)
      }

      await titleBox.fill(piece.title)

      // Body: stage the HTML in chunks, then ONE synthetic paste onto the ProseMirror editor
      // (multiple pastes merge paragraphs; the ARTICLE editor accepts synthetic paste - the
      // publish dialog's Quill does not, see below). String-form evaluate: no DOM lib in core.
      // VERIFIED, not fire-and-forget: LinkedIn can drop a paste that races its draft
      // save/remount, so check the editor actually holds the text and re-paste until it does.
      yield { channel: CHP, phase: 'fetch', message: `pasting body (${html.length} chars of HTML)` }
      let bodyLen = 0
      for (let attempt = 1; attempt <= 3 && bodyLen < MIN_BODY_CHARS; attempt++) {
        if (attempt > 1) yield { channel: CHP, phase: 'fetch', message: `body not in the editor (${bodyLen} chars) - re-pasting (attempt ${attempt}/3)` }
        bodyLen = await pasteBody()
      }
      if (bodyLen < MIN_BODY_CHARS) throw new Error(`body paste did not stick after 3 attempts (${bodyLen} chars in the editor)`)

      await page.waitForURL(/\/article\/edit\//, { timeout: 30_000 })
      const draftUrl = page.url()
      // Let the draft save + any editor remount settle, then make sure the body SURVIVED it
      // (and the cover, when there is one) before opening the publish dialog.
      await page.waitForTimeout(3_000)
      bodyLen = await editorTextLength()
      if (bodyLen < MIN_BODY_CHARS) {
        yield { channel: CHP, phase: 'fetch', message: `editor remount wiped the body (${bodyLen} chars) - re-pasting` }
        bodyLen = await pasteBody()
        if (bodyLen < MIN_BODY_CHARS) throw new Error(`body wiped by the editor remount and re-paste did not stick (${bodyLen} chars)`)
      }
      yield { channel: CHP, phase: 'fetch', message: `draft auto-saved (${draftUrl}), body verified (${bodyLen} chars) - opening the publish dialog` }

      // Publish dialog: the top-bar Next opens the announcement-post composer bound to the
      // newsletter. Click-with-retry: LinkedIn occasionally swallows the click - but if it shows
      // a validation TOAST instead ("Body text is required…"), fail fast with its text rather
      // than blind-clicking a button that can never succeed.
      const composer = page.locator('.ql-editor[contenteditable="true"]')
      let dialogOpen = false
      for (let attempt = 1; attempt <= 3 && !dialogOpen; attempt++) {
        if (attempt > 1) yield { channel: CHP, phase: 'fetch', message: `publish dialog not open - re-clicking Next (attempt ${attempt}/3)` }
        // The top-bar publish/Next control - class-targeted (button.article-editor-nav__publish,
        // confirmed in the run-2 error log) so a modal's Next can never be picked up here.
        await page.locator('button.article-editor-nav__publish').click()
        dialogOpen = await composer
          .waitFor({ state: 'visible', timeout: 10_000 })
          .then(() => true)
          .catch(() => false)
        if (!dialogOpen) {
          const toast = String(
            await page.evaluate(`(document.querySelector('.artdeco-toast-item')?.innerText ?? '').replace(/\\s+/g, ' ').trim()`),
          )
          if (toast) throw new Error(`LinkedIn refused the publish dialog: "${toast}"`)
        }
      }
      if (!dialogOpen) throw new Error('publish dialog never opened after 3 Next clicks')
      if (announcement) {
        // REAL keystrokes: the Quill composer silently ignores synthetic ClipboardEvent paste
        // (verified 2026-07-18). keyboard.type presses Enter for \n, which is exactly the literal
        // paragraph break LinkedIn wants.
        yield { channel: CHP, phase: 'fetch', message: `typing announcement (${announcement.length} chars)` }
        await composer.click()
        await page.keyboard.type(announcement.replace(/\n{2,}/g, '\n\n'))
      }

      yield { channel: CHP, phase: 'fetch', message: 'clicking Publish' }
      await page.getByRole('button', { name: 'Publish', exact: true }).click()

      // Resolve the live URL: publishing navigates to the published article (a /pulse/ URL).
      // Fall back to any /pulse/ anchor if LinkedIn shows a confirmation instead of navigating.
      let publishedUrl = ''
      try {
        await page.waitForURL(/\/pulse\//, { timeout: 30_000 })
        publishedUrl = page.url()
      } catch {
        publishedUrl = String(
          await page.evaluate(`(() => {
            const a = [...document.querySelectorAll('a[href*="/pulse/"]')][0]
            return a ? a.href : ''
          })()`),
        )
      }
      if (!publishedUrl) {
        throw new Error(
          `Publish was clicked but the live URL could not be captured - CHECK LINKEDIN BY HAND: ` +
            `the edition may be live. If so, record it with content-publish; the piece was NOT flipped.`,
        )
      }

      yield { channel: CHP, phase: 'persist', message: `live at ${publishedUrl} - stamping the piece published` }
      await upsertContent({
        id: content_id,
        status: 'published',
        published_url: publishedUrl,
        published_at: new Date().toISOString(),
        published_by: params.actor ?? author,
        metadata: { article_draft_url: null, article_edit_url: draftUrl },
        ...(params.actor ? { actor: params.actor } : {}),
      })

      const summary =
        `published ${content_id} as ${author} → ${publishedUrl}` +
        `${announcement ? ' (+announcement post)' : ' (no announcement text set)'}`
      yield { channel: CHP, phase: 'done', message: summary, result: { channel: CHP, date: todayUtc(), summary } }
    } catch (err) {
      // Freeze the page for diagnosis - browser flows fail in ways an error message can't convey.
      const shot = join(tmpdir(), `linkedin-article-publish-${Date.now()}.png`)
      await page.screenshot({ path: shot }).catch(() => {})
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(
        `${msg} [debug screenshot: ${shot}] - a stray auto-saved draft may remain in ${author}'s ` +
          `LinkedIn drafts (linkedin.com/article/manage/, delete by hand)`,
      )
    } finally {
      await page.close().catch(() => {})
    }
  } finally {
    await detach(browser)
  }
}
