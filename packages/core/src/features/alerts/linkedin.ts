// LinkedIn comment alert evaluator (P3) - after we publish to LinkedIn, new comments on our
// posts land as `linkedin.comment` events (response-needed: Lark card + Inbox item). Targets are
// the published linkedin ContentPieces the P2 publisher stamped with `metadata.post_urn`.
//
// Fetch mechanism per post footing (features/alerts/SPEC.md):
//   • Org-page posts (author `company`): official API - socialActions/{urn}/comments
//     (r_organization_social_feed). Runs every poll; cheap.
//   • Member posts: NO API (r_member_social is closed) - the author's own logged-in Chrome on
//     the browser host (config/browsers.json) reads the post page's comment section, a TS port of the
//     marketing repo's `_parse_post_comments` (linkedin_mcp.py). Heavier, so it runs at most
//     once per BROWSER_MIN_INTERVAL_MIN (cursor in kv_state); comment URNs dedup replays.
//
// Runs as a normal funnel action (`alerts-linkedin`), schedulable like the other fast tiers.

import type { Page } from 'playwright-core'
import { readAccountsFile } from '../../accounts.js'
import { browserIdentity } from '../data/browsers.js'
import { connectCDP, detach, firstContext } from '../data/cdp.js'
import { readContentPieces } from '../content/state.js'
import { COMPANY_AUTHOR, type ContentPiece } from '../content/types.js'
import { linkedinGet } from '../data/pulls/linkedin-client.js'
import { todayUtc, type IngestProgress } from '../../ops/types.js'
import { getKvState, setKvState } from '../../warehouse/db.js'
import { ingestEvent } from './evaluate.js'
import { flushAlertsNow } from './flush.js'
import type { AlertEvent } from './types.js'

const EVENT_KIND = 'linkedin.comment'
const STATE_KEY = 'alerts-linkedin.browser'
/** Member-post browser passes are rate-limited to this interval; the API pass runs every poll. */
const BROWSER_MIN_INTERVAL_MIN = 60
/** Browser pass: only comments within this window are parsed (relative timestamps cap out). */
const WINDOW_DAYS = 7

interface BrowserState {
  last_scrape_at?: string
}

/** One normalized incoming comment, whichever path found it. */
export interface LinkedinComment {
  /** Comment URN - the stable dedup key (`urn:li:comment:(…)`). */
  urn: string
  author: string
  /** /in/<handle> vanity for member-path comments; '' when the API path only has an actor URN. */
  handle: string
  text: string
  /** ISO timestamp (exact from the API; approximated from relative time in the browser path). */
  event_at: string
}

function toAlertEvent(c: LinkedinComment, piece: ContentPiece): AlertEvent {
  const postUrl = piece.published_url ?? ''
  return {
    kind: EVENT_KIND,
    dedup_key: c.urn,
    event_at: c.event_at,
    source: 'poll:linkedin',
    actor: c.handle || c.author,
    subject: String(piece.metadata.post_urn ?? piece.id),
    url: postUrl,
    fields: {
      author: c.author,
      handle: c.handle,
      text: c.text,
      content_id: piece.id,
      post_title: piece.title,
      post_url: postUrl,
      url: postUrl,
    },
  }
}

/** Published linkedin pieces the publisher stamped - the posts we watch for comments. */
async function watchedPieces(): Promise<ContentPiece[]> {
  return (await readContentPieces()).filter(
    (p) => p.channel === 'linkedin' && p.status === 'published' && typeof p.metadata.post_urn === 'string',
  )
}

// --- org-page posts: official Comments API ---------------------------------------------------------

interface ApiComment {
  commentUrn?: string
  id?: string | number
  actor?: string
  created?: { time?: number }
  message?: { text?: string }
}

/** Comments on an org post via socialActions. Actor arrives as a bare URN (no name lookup at our
 *  tier) - the card shows the URN tail; the post link gives the human context. */
async function fetchOrgComments(postUrn: string): Promise<LinkedinComment[]> {
  const res = await linkedinGet<{ elements?: ApiComment[] }>(
    `/rest/socialActions/${encodeURIComponent(postUrn)}/comments?count=50`,
  )
  return (res.elements ?? []).map((e) => ({
    urn: e.commentUrn ?? `urn:li:comment:(${postUrn},${e.id ?? ''})`,
    author: String(e.actor ?? '').replace(/^urn:li:(person|organization):/, '') || 'someone',
    handle: '',
    text: e.message?.text ?? '',
    event_at: e.created?.time ? new Date(e.created.time).toISOString() : new Date().toISOString(),
  }))
}

// --- member posts: the author's own Chrome (port of linkedin_mcp.py `_parse_post_comments`) --------

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 }

/** LinkedIn relative comment timestamps (3m/2h/5d/1w…). Keep those within WINDOW_DAYS. */
function relInWindow(n: number, unit: string): boolean {
  if (unit === 'm' || unit === 'h') return true
  if (unit === 'd') return n <= WINDOW_DAYS
  if (unit === 'w') return n === 1 && WINDOW_DAYS >= 7
  return false
}

/**
 * Parse comment entities out of a feed-post page's HTML - same `comments-comment-*` components
 * and `data-id="urn:li:comment:(…)"` markers Mark's parser keys on. Own replies (the author's
 * /in/<login>) are skipped: we want comments RECEIVED.
 */
export function parsePostComments(html: string, ownLogin: string): LinkedinComment[] {
  const out: LinkedinComment[] = []
  const idxs: number[] = []
  const marker = /data-id="urn:li:comment:\(/g
  for (let m = marker.exec(html); m; m = marker.exec(html)) idxs.push(m.index)

  for (let i = 0; i < idxs.length; i++) {
    // Comment meta markup (avatar, name, headline, badges) can run ~4.5k chars before the body,
    // so the single/last-comment fallback window must be generous.
    const seg = html.slice(idxs[i], idxs[i + 1] ?? idxs[i] + 16_000)
    const urn = /data-id="(urn:li:comment:\([^"]+\))"/.exec(seg)?.[1]
    if (!urn) continue
    const handle = /\/in\/([A-Za-z0-9\-%]+)/.exec(seg)?.[1] ?? ''
    if (handle.toLowerCase() === ownLogin.toLowerCase()) continue

    const tm =
      /<time[^>]*>\s*(?:Edited\s*[•·]?\s*)?(\d+)\s*(m|h|d|w|mo|y)\b/.exec(seg) ??
      /comments-comment-meta__data[^>]*>\s*(?:Edited\s*[•·]?\s*)?(\d+)\s*(m|h|d|w|mo|y)\b/.exec(seg)
    if (!tm) continue
    const n = Number(tm[1])
    const unit = tm[2]
    if (!relInWindow(n, unit)) continue

    const nm =
      /comments-comment-meta__description-title[^>]*>([\s\S]*?)<\/(?:h3|span|div)>/.exec(seg) ??
      /aria-label="View:?\s*([^"•]+?)(?:’s|"|\s*•)/.exec(seg)
    let name = nm ? nm[1].replace(/<[^>]+>/g, '') : ''
    name = name.split(/[•·]/)[0].replace(/\s+/g, ' ').trim() || handle

    // Capture the whole body (text + @mention link text), stopping right before the social-action
    // bar so "Like/Reply" UI stays out of the capture.
    const txm =
      /comments-comment-item__main-content[^>]*>([\s\S]*?)<[^>]*class="[^"]*(?:comments-comment-social|comments-comment-item__actions|social-actions)/.exec(
        seg,
      ) ?? /comments-comment-item__main-content[\s\S]*?dir="ltr"[^>]*>([\s\S]*?)<\/span>/.exec(seg)
    const text = txm
      ? txm[1]
          .replace(/<!---->|<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 500)
      : ''

    out.push({
      urn,
      author: name,
      handle,
      text,
      event_at: new Date(Date.now() - n * (UNIT_MS[unit] ?? 0)).toISOString(),
    })
  }
  return out
}

/** Navigate the author's own Chrome to the post, expand comments, and parse those in-window. */
async function scrapeMemberComments(page: Page, url: string, ownLogin: string): Promise<LinkedinComment[]> {
  // domcontentloaded, not load - LinkedIn keeps connections open and 'load' can hang past any
  // sane timeout; the settle sleep below is what actually lets the comment components render.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(4_000)
  for (const sel of ['button.comments-comment-social-bar__comments-count', 'button[aria-label*="comment"]']) {
    try {
      await page.click(sel, { timeout: 2_000 })
      await page.waitForTimeout(2_000)
    } catch {
      // no comment-expander on the page - fine, whatever is rendered gets parsed
    }
  }
  const html = ((await page.evaluate('document.documentElement.innerHTML')) as string)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
  return parsePostComments(html, ownLogin)
}

// --- the evaluator ----------------------------------------------------------------------------------

export interface LinkedinEvalResult {
  posts_checked: number
  browser_posts: number
  /** 'ran' | 'cooldown' | 'skipped:<reason>' - what happened to the member-post browser pass. */
  browser_pass: string
  fetched: number
  recorded: number
}

/**
 * Ingest new comments across every watched post: API pass for org posts each poll, browser pass
 * for member posts at most every BROWSER_MIN_INTERVAL_MIN. Per-post failures degrade to progress
 * messages - one dead post or an unreachable browser never fails the whole poll.
 */
export async function* evaluateLinkedinComments(): AsyncGenerator<IngestProgress, LinkedinEvalResult> {
  const pieces = await watchedPieces()
  const org = pieces.filter((p) => p.metadata.author === COMPANY_AUTHOR)
  const member = pieces.filter((p) => p.metadata.author !== COMPANY_AUTHOR)
  let fetched = 0
  let recorded = 0

  for (const piece of org) {
    try {
      const comments = await fetchOrgComments(String(piece.metadata.post_urn))
      fetched += comments.length
      for (const c of comments) if ((await ingestEvent(toAlertEvent(c, piece))).fresh) recorded++
    } catch (err) {
      yield {
        channel: 'alerts-linkedin',
        phase: 'fetch',
        message: `org comments skipped for ${piece.id}: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
      }
    }
  }

  let browserPass = 'skipped:no member posts'
  if (member.length > 0) {
    const state = (await getKvState<BrowserState>(STATE_KEY)) ?? {}
    const due =
      !state.last_scrape_at ||
      Date.now() - Date.parse(state.last_scrape_at) >= BROWSER_MIN_INTERVAL_MIN * 60_000
    if (!due) {
      browserPass = 'cooldown'
    } else {
      // Group by author so one CDP attach serves all their posts, read from THEIR own session.
      const byAuthor = new Map<string, ContentPiece[]>()
      for (const p of member) {
        const author = String(p.metadata.author ?? '')
        byAuthor.set(author, [...(byAuthor.get(author) ?? []), p])
      }
      let reached = 0
      for (const [author, posts] of byAuthor) {
        const identity = browserIdentity(author)
        const login = (readAccountsFile().linkedin ?? []).find((a) => a.user === author)?.login ?? ''
        if (!identity) {
          const who = author || '(piece has no metadata.author)'
          yield { channel: 'alerts-linkedin', phase: 'fetch', message: `${who} has no browser in config/browsers.json - ${posts.length} post(s) unchecked` }
          continue
        }
        let browser
        try {
          browser = await connectCDP(identity)
        } catch {
          yield { channel: 'alerts-linkedin', phase: 'fetch', message: `${author}'s browser unreachable (chromatrix "${identity}") - ${posts.length} post(s) unchecked` }
          continue
        }
        try {
          const page = await firstContext(browser).newPage()
          reached += 1
          try {
            for (const piece of posts) {
              if (!piece.published_url) continue
              try {
                const comments = await scrapeMemberComments(page, piece.published_url, login)
                fetched += comments.length
                for (const c of comments) if ((await ingestEvent(toAlertEvent(c, piece))).fresh) recorded++
              } catch (err) {
                yield {
                  channel: 'alerts-linkedin',
                  phase: 'fetch',
                  message: `scrape failed for ${piece.id}: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
                }
              }
            }
          } finally {
            await page.close().catch(() => undefined)
          }
        } catch (err) {
          // A leased tab that yields no usable page is this author's problem, not the poll's -
          // the contract above promises one bad browser never fails the whole run.
          yield {
            channel: 'alerts-linkedin',
            phase: 'fetch',
            message: `${author}'s browser gave no usable page - ${posts.length} post(s) unchecked: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
          }
        } finally {
          await detach(browser)
        }
      }
      // Only advance the cursor when a browser was actually reached. Advancing after a total
      // failure buys another BROWSER_MIN_INTERVAL_MIN of silence with zero posts checked, and
      // nothing surfaces it - the 2026-07-22 stale-build run degraded exactly that way.
      if (reached === 0) {
        browserPass = 'failed:no browser reachable'
      } else {
        browserPass = reached === byAuthor.size ? 'ran' : `ran:partial(${reached}/${byAuthor.size})`
        await setKvState(STATE_KEY, { last_scrape_at: new Date().toISOString() } satisfies BrowserState)
      }
    }
  }

  return { posts_checked: pieces.length, browser_posts: member.length, browser_pass: browserPass, fetched, recorded }
}

/** Funnel action wrapper - ingest → flush (one batched message), mirroring alertsRedditAction. */
export async function* alertsLinkedinAction(): AsyncGenerator<IngestProgress> {
  yield { channel: 'alerts-linkedin', phase: 'start', message: 'checking published LinkedIn posts for comments…' }
  const r = yield* evaluateLinkedinComments()
  yield {
    channel: 'alerts-linkedin',
    phase: 'persist',
    message: `${r.recorded} new comment(s) from ${r.posts_checked} post(s) (browser pass: ${r.browser_pass}); delivering…`,
  }
  const { delivered, suppressed, failed, messages } = await flushAlertsNow()
  const summary =
    `alerts-linkedin: ${r.posts_checked} post(s) checked (browser: ${r.browser_pass}), ` +
    `${r.fetched} comment(s) seen, ${r.recorded} new; ` +
    `delivered ${delivered} in ${messages} message(s), suppressed ${suppressed}, failed ${failed}`
  yield {
    channel: 'alerts-linkedin',
    phase: 'done',
    message: summary,
    result: { channel: 'alerts-linkedin', date: todayUtc(), summary },
  }
}
