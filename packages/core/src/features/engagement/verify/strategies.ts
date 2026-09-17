// Deterministic per-(channel·action) engagement verify strategies. Always answers "did I engage"
// from the ENGAGER's side - a public JSON read for reddit (falling back to their own session when
// reddit IP-blocks the server's network), their own logged-in Chrome on the browser host
// (config/browsers.json) for x/linkedin - never by scraping a post's audience.
//
// Verdict rules (features/engagement/SPEC.md): ambiguity is `unknown`, NEVER `confirmed` - a false positive
// silently corrupts the ledger, a false negative just means clicking Verify again. Only a
// `confirmed` verdict should be recorded by the caller (pods/verify.ts), with evidence of how it
// was observed (+ a screenshot for the browser strategies).

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { browserIdentity } from '../../data/browsers.js'
import { connectCDP, detach, firstContext } from '../../data/cdp.js'
import { fetchJson } from '../../../http.js'
import { dataPath, instanceRelative } from '../../../io.js'
import type { EngagementAction, EngagementEvidence } from './types.js'

export type VerifyVerdict = 'confirmed' | 'not_found' | 'unknown'

export interface VerifyOutcome {
  verdict: VerifyVerdict
  /** Human-readable observation ("comment by u/x found", "alice's browser is unreachable: …"). */
  detail: string
  /** Present on `confirmed` - becomes the recorded engagement's evidence. */
  evidence?: EngagementEvidence
}

/** Dispatch to the (channel·action) strategy; unmapped combinations are `unknown`, never fatal.
 *  Consumed by the pods verify (pods/verify.ts) - the strategies are channel-generic. */
export async function runStrategy(
  channel: string,
  action: EngagementAction,
  url: string,
  userId: string,
  login: string,
  contentId: string,
): Promise<VerifyOutcome> {
  const shot = evidenceSlug(contentId, userId)
  switch (`${channel}:${action}`) {
    case 'reddit:comment':
      return verifyRedditComment(url, userId, login)
    case 'x:like':
      return verifyXToggle(url, userId, 'like', shot)
    case 'x:repost':
      return verifyXToggle(url, userId, 'repost', shot)
    case 'linkedin:react':
      return verifyLinkedinReact(url, userId, shot)
    case 'linkedin:comment':
      return verifyLinkedinComment(url, userId, login, shot)
    // linkedin-article is the same platform (login/handle/browser) as linkedin, and pulse article
    // pages render the classic post DOM (probed live 2026-07-22 in dan's session: the article's
    // own `react-button__trigger` is the FIRST on the page with aria-pressed reflecting your
    // reaction, and comments are `comments-comment-entity` blocks) - so the post strategies apply
    // unchanged. Give articles their own handlers here if the DOMs ever diverge.
    case 'linkedin-article:react':
      return verifyLinkedinReact(url, userId, shot)
    case 'linkedin-article:comment':
      return verifyLinkedinComment(url, userId, login, shot)
    default:
      return { verdict: 'unknown', detail: `no verify strategy for ${channel}·${action} yet - record manually` }
  }
}

// --- reddit · comment (public JSON, no browser) ---------------------------------------------------

interface RedditThing {
  kind?: string
  data?: {
    author?: string
    body?: string
    children?: RedditThing[]
    replies?: RedditThing | ''
  }
}

/** Collect every t1 comment (author + body) from the thread listing, depth-first. */
function collectComments(node: RedditThing | RedditThing[] | '' | undefined, out: { author: string; body: string }[]): void {
  if (!node) return
  if (Array.isArray(node)) {
    for (const child of node) collectComments(child, out)
    return
  }
  if (node.kind === 't1' && node.data?.author) {
    out.push({ author: node.data.author, body: node.data.body ?? '' })
  }
  collectComments(node.data?.children, out)
  collectComments(node.data?.replies, out)
}

/** Scan a fetched thread listing for a comment by `login` and turn it into a verdict. */
function scanRedditListings(listings: RedditThing[], login: string, method: 'http' | 'browser'): VerifyOutcome {
  const comments: { author: string; body: string }[] = []
  collectComments(listings, comments)
  const mine = comments.find((c) => c.author.toLowerCase() === login.toLowerCase())
  if (!mine) {
    return {
      verdict: 'not_found',
      detail: `no comment by u/${login} among the ${comments.length} loaded comments - comment first, then verify again`,
    }
  }
  return {
    verdict: 'confirmed',
    detail: `comment by u/${login} found in the thread`,
    evidence: {
      method,
      detail:
        method === 'http'
          ? `public thread JSON contains a comment authored by u/${login}`
          : `thread JSON fetched from ${login}'s own reddit session contains their comment`,
      comment_text: mine.body.slice(0, 500),
    },
  }
}

async function verifyRedditComment(url: string, userId: string, login: string): Promise<VerifyOutcome> {
  const jsonUrl = `${url.replace(/\/+$/, '')}.json?limit=500&depth=10`
  // Fast path: reddit's public thread JSON, no browser. Reddit IP-blocks datacenter-ish networks
  // (403 regardless of UA) - then fall back to a same-origin fetch inside the ENGAGER's own
  // logged-in session, the proven reddit-client pattern (cookies + real UA sent natively).
  let directError: string
  try {
    const listings = await fetchJson<RedditThing[]>(jsonUrl, {}, 1)
    return scanRedditListings(listings, login, 'http')
  } catch (err) {
    directError = String((err as Error).message)
  }
  return withUserPage(userId, 'https://www.reddit.com/', async (page) => {
    const fetched = await page.evaluate(async (u: string) => {
      try {
        const r = await fetch(u, { headers: { Accept: 'application/json' }, credentials: 'include' })
        const text = await r.text()
        try {
          return { status: r.status, json: JSON.parse(text) as unknown }
        } catch {
          return { status: r.status, json: null }
        }
      } catch (e) {
        return { status: 0, json: null, error: String(e) }
      }
    }, jsonUrl)
    if (!fetched.json || !Array.isArray(fetched.json)) {
      return {
        verdict: 'unknown',
        detail: `thread JSON unreadable directly (${directError}) and via ${userId}'s session (status ${fetched.status}) - logged out?`,
      }
    }
    return scanRedditListings(fetched.json as RedditThing[], login, 'browser')
  })
}

// --- browser strategies (the engager's own Chrome over CDP) ---------------------------------------

/**
 * Run `fn` on a fresh page in the USER's own browser (config/browsers.json), always detaching and
 * closing only the page we opened. An unreachable/undeclared browser is an `unknown` verdict with
 * an actionable message - never an exception (the card's manual-record fallback stays available).
 */
async function withUserPage(userId: string, url: string, fn: (page: Page) => Promise<VerifyOutcome>): Promise<VerifyOutcome> {
  const identity = browserIdentity(userId)
  if (!identity) {
    return { verdict: 'unknown', detail: `${userId} has no browser in config/browsers.json - record manually` }
  }
  let browser
  try {
    browser = await connectCDP(identity)
  } catch {
    return {
      verdict: 'unknown',
      detail: `${userId}'s browser is unreachable (chromatrix identity "${identity}") - is the gateway up and the identity started? Record manually if needed`,
    }
  }
  try {
    const page = await firstContext(browser).newPage()
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      return await fn(page)
    } finally {
      await page.close().catch(() => undefined)
    }
  } catch (err) {
    return { verdict: 'unknown', detail: `page check failed: ${String((err as Error).message).slice(0, 200)}` }
  } finally {
    await detach(browser)
  }
}

/** Screenshot the page as evidence; a capture failure never downgrades a confirmed verdict. */
async function captureEvidence(page: Page, slug: string): Promise<string | undefined> {
  try {
    const dir = dataPath('_evidence', 'engagement')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${slug}.png`)
    await page.screenshot({ path: file })
    return instanceRelative(file)
  } catch {
    return undefined
  }
}

const evidenceSlug = (contentId: string, userId: string): string =>
  `${contentId}__${userId}`.replace(/[^a-zA-Z0-9_-]+/g, '-')

/** x · like/repost - the toggle state of the focal tweet in the engager's own session. Reads the
 *  classic data-testid pair first, then falls back to aria-labels (X ships more than one shell -
 *  the 2026 logged-out shell has no testids at all, only `data-tweet-id` + aria-labels). */
async function verifyXToggle(url: string, userId: string, kind: 'like' | 'repost', shot: string): Promise<VerifyOutcome> {
  const activeSel = kind === 'like' ? '[data-testid="unlike"]' : '[data-testid="unretweet"]'
  const inactiveSel = kind === 'like' ? '[data-testid="like"]' : '[data-testid="retweet"]'
  // Aria fallback: "Unlike"/"Liked" (or "Undo repost"/"Reposted") only ever label a TOGGLED
  // control, so matching them can't false-confirm; the untoggled labels are exact-matched.
  const activeAria = kind === 'like' ? /^(unlike|liked)/i : /^(undo repost|unretweet|reposted)/i
  const inactiveAria = kind === 'like' ? /^like$/i : /^(repost|retweet)$/i
  const statusId = /\/status\/(\d+)/.exec(url)?.[1]
  return withUserPage(userId, url, async (page) => {
    // Scope to the focal tweet: by data-tweet-id (new shell), else the tabindex="-1" article
    // (classic status page), else the first article.
    const candidates = [
      ...(statusId ? [page.locator(`article[data-tweet-id="${statusId}"]`).first()] : []),
      page.locator('article[data-testid="tweet"][tabindex="-1"]').first(),
      page.locator('article').first(),
    ]
    try {
      await candidates[candidates.length - 1].waitFor({ state: 'visible', timeout: 15_000 })
    } catch {
      return { verdict: 'unknown', detail: 'the tweet did not render - deleted, rate-limited, or X DOM drift?' }
    }
    // A logged-out session can't show YOUR toggle state - fail actionably before reading buttons.
    // Covers the classic shell (/login, loginButton) and the 2026 shell (…onboarding/web?mode=login).
    if ((await page.locator('a[href*="/login"], a[href*="mode=login"], a[data-testid="loginButton"]').count()) > 0) {
      return {
        verdict: 'unknown',
        detail: `${userId}'s browser on the browser host is logged OUT of X - log in there once, then verify again`,
      }
    }
    let article = candidates[candidates.length - 1]
    for (const c of candidates) {
      if ((await c.count()) > 0) {
        article = c
        break
      }
    }
    const ariaButtons = await article.locator('button[aria-label]').evaluateAll((els) =>
      els.map((el) => el.getAttribute('aria-label') ?? ''),
    )
    const activeByAria = ariaButtons.some((l) => activeAria.test(l))
    if ((await article.locator(activeSel).count()) > 0 || activeByAria) {
      const screenshot_path = await captureEvidence(page, shot)
      return {
        verdict: 'confirmed',
        detail: `the ${kind} toggle is active in ${userId}'s session`,
        evidence: {
          method: 'browser',
          detail: `${kind} control in toggled state on the focal tweet in ${userId}'s own session`,
          ...(screenshot_path ? { screenshot_path } : {}),
        },
      }
    }
    if ((await article.locator(inactiveSel).count()) > 0 || ariaButtons.some((l) => inactiveAria.test(l))) {
      return { verdict: 'not_found', detail: `the ${kind} button is present but not toggled - ${kind} it first, then verify again` }
    }
    return { verdict: 'unknown', detail: `neither ${kind} toggle state rendered - X DOM drift? (selector repair: Exploration Mode)` }
  })
}

/** linkedin · react - the post's reaction-button state in the engager's own session. Gentle: one
 *  direct-URL visit, no crawling. DOM history: `aria-label="Reaction button state: <no reaction |
 *  Like | …>"` observed live 2026-07-09 but GONE by 2026-07-17 - since then the classic
 *  `react-button__trigger` aria-pressed branch is what actually decides (verified live: it
 *  correctly read an unpressed button). Both paths kept; the focal post's button is the first
 *  match (comment react buttons come later in DOM order). */
async function verifyLinkedinReact(url: string, userId: string, shot: string): Promise<VerifyOutcome> {
  return withUserPage(userId, url, async (page) => {
    const stateBtn = page.locator('button[aria-label^="Reaction button state:"]').first()
    const classicBtn = page.locator('button.react-button__trigger').first()
    try {
      await stateBtn.or(classicBtn).first().waitFor({ state: 'visible', timeout: 20_000 })
    } catch {
      const loggedOut =
        (await page.locator('form.join-form, .sign-in-form, a[data-tracking-control-name*="guest"]').count()) > 0
      return loggedOut
        ? { verdict: 'unknown', detail: `${userId}'s browser on the browser host is logged OUT of LinkedIn - log in there once, then verify again` }
        : { verdict: 'unknown', detail: 'the reaction button did not render - LinkedIn DOM drift? (selector repair: Exploration Mode)' }
    }
    if ((await stateBtn.count()) > 0) {
      const state = ((await stateBtn.getAttribute('aria-label')) ?? '').split(':')[1]?.trim() ?? ''
      if (/^no reaction$/i.test(state)) {
        return { verdict: 'not_found', detail: 'the reaction button says "no reaction" - react first, then verify again' }
      }
      if (state) {
        const screenshot_path = await captureEvidence(page, shot)
        return {
          verdict: 'confirmed',
          detail: `the post carries your "${state}" reaction`,
          evidence: {
            method: 'browser',
            detail: `reaction button state "${state}" in ${userId}'s own session`,
            ...(screenshot_path ? { screenshot_path } : {}),
          },
        }
      }
      return { verdict: 'unknown', detail: 'reaction button found but its state text is unreadable - LinkedIn DOM drift?' }
    }
    const pressed = await classicBtn.getAttribute('aria-pressed')
    const cls = (await classicBtn.getAttribute('class')) ?? ''
    if (pressed === 'true' || cls.includes('react-button__trigger--active')) {
      const screenshot_path = await captureEvidence(page, shot)
      return {
        verdict: 'confirmed',
        detail: `the reaction button is in pressed state in ${userId}'s session`,
        evidence: {
          method: 'browser',
          detail: `react button aria-pressed/active in ${userId}'s own session`,
          ...(screenshot_path ? { screenshot_path } : {}),
        },
      }
    }
    if (pressed === 'false') {
      return { verdict: 'not_found', detail: 'the reaction button is not pressed - react first, then verify again' }
    }
    return { verdict: 'unknown', detail: 'reaction button found but its pressed state is unreadable - LinkedIn DOM drift?' }
  })
}

/** linkedin · comment - a loaded comment authored by the engager's own profile (/in/<login>).
 *  Comments are LAZY: LinkedIn fires the comments XHR only when the comments block nears the
 *  viewport (observed live 2026-07-22 - a post with a fresh comment verified as "none" until
 *  scrolled). window.scrollTo is inert on these pages; the scroll container is <main>. DOM has
 *  two shapes: classic (comments-comment-entity/-item classes) and the flat hashed-class DOM
 *  first seen 2026-07-21, where the only stable per-comment anchor is the options button
 *  `aria-label="View more options for {Author}'s comment."`. */
async function verifyLinkedinComment(url: string, userId: string, login: string, shot: string): Promise<VerifyOutcome> {
  return withUserPage(userId, url, async (page) => {
    const comments = page.locator('article.comments-comment-entity, .comments-comment-item')
    const anchors = page.locator('button[aria-label^="View more options for"]')
    await page.waitForTimeout(3_000)
    for (let i = 0; i < 8; i++) {
      if ((await comments.count()) > 0 || (await anchors.count()) > 0) break
      await page.evaluate(() => {
        const g = globalThis as any
        g.document.querySelector('main')?.scrollBy(0, 800)
        g.scrollBy(0, 800)
      })
      await page.waitForTimeout(1_500)
    }
    if ((await comments.count()) === 0 && (await anchors.count()) === 0) {
      return {
        verdict: 'unknown',
        detail: 'no comments rendered even after scrolling to trigger the lazy comments load - none posted yet, logged out, or LinkedIn DOM drift?',
      }
    }
    const mine = comments.filter({ has: page.locator(`a[href*="/in/${login}"]`) })
    if ((await mine.count()) > 0) {
      const screenshot_path = await captureEvidence(page, shot)
      // Prefer the comment BODY node - the entity's full innerText wraps it in name/headline/
      // timestamp/action noise (observed live 2026-07-17). Fallback keeps the old behavior.
      const body = await mine
        .first()
        .locator('.comments-comment-item__main-content, .update-components-text')
        .first()
        .innerText()
        .catch(() => '')
      const comment_text = (body || (await mine.first().innerText().catch(() => '')))?.trim().slice(0, 500)
      return {
        verdict: 'confirmed',
        detail: `comment by /in/${login} found on the post`,
        evidence: {
          method: 'browser',
          detail: `comment authored by /in/${login} visible in ${userId}'s own session`,
          ...(screenshot_path ? { screenshot_path } : {}),
          ...(comment_text ? { comment_text } : {}),
        },
      }
    }
    // Flat hashed-class DOM (2026-07-21): the comment block is the outermost ancestor of an
    // options button that still contains only that one options button AND not the post's own
    // control menu - the second guard is what bounds the climb when the post has a single
    // comment (probed live 2026-07-22: without it the climb runs past the post to <html>).
    const flatText = await page.evaluate((profileLogin) => {
      const doc = (globalThis as any).document
      const optionsSel = 'button[aria-label^="View more options for"]'
      const postMenuSel = 'button[aria-label^="Open control menu for post"]'
      // LinkedIn renders the possessive with a curly apostrophe (U+2019): "…Strand’s comment."
      const buttons = Array.from(doc.querySelectorAll(optionsSel)).filter((b: any) =>
        /['’]s comment\.?$/i.test(b.getAttribute('aria-label') ?? ''),
      )
      for (const btn of buttons) {
        let block: any = btn
        while (
          block.parentElement &&
          block.parentElement.querySelectorAll(optionsSel).length === 1 &&
          !block.parentElement.querySelector(postMenuSel)
        ) {
          block = block.parentElement
        }
        if (block.querySelector(`a[href*="/in/${profileLogin}"]`)) {
          return String(block.innerText || '').trim().slice(0, 500)
        }
      }
      return null
    }, login)
    if (flatText !== null) {
      const screenshot_path = await captureEvidence(page, shot)
      return {
        verdict: 'confirmed',
        detail: `comment by /in/${login} found on the post (flat-DOM path)`,
        evidence: {
          method: 'browser',
          detail: `comment authored by /in/${login} visible in ${userId}'s own session`,
          ...(screenshot_path ? { screenshot_path } : {}),
          ...(flatText ? { comment_text: flatText } : {}),
        },
      }
    }
    return {
      verdict: 'not_found',
      detail: `no comment by /in/${login} among the loaded comments (deeper pages are not crawled) - comment first, then verify again`,
    }
  })
}
