// Maintenance / Exploration-Mode operations against the remote stealth browser (CDP) and the
// CDP-attached Reddit session. These were the standalone `scripts/` CLIs (cdp-check, reddit:probe,
// reddit:login, reddit:thread, reddit:explore); they now return structured results so the server can
// surface them as in-process @Mcp() actions (callable from the `cli` proxy, agents, and the
// dashboard). Read-only except redditLogin, which only navigates the browser (a human still types
// the credentials on the machine the browser runs on).

import { connectCDP, firstContext, detach, CHROMATRIX_URL, DEFAULT_IDENTITY } from '../cdp.js'
import { defaultAccount } from '../../../accounts.js'
import { withReddit, fetchOne, redditSelf, ORIGIN } from './reddit-client.js'

const clip = (s: unknown, n = 140): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const age = (utc?: number): string => {
  if (!utc) return '?'
  const days = Date.now() / 1000 / 86400 - utc / 86400
  return days >= 365 ? `${(days / 365).toFixed(1)}y` : days >= 1 ? `${Math.round(days)}d` : `${Math.round(days * 24)}h`
}

// ---------------- CDP connectivity ----------------
export interface CdpCheckResult {
  url: string
  contexts: number
  pages: { url: string; title: string }[]
  summary: string
}

/** Attach to the stealth browser, report the contexts/pages it can see, detach. Service-agnostic. */
export async function cdpCheck(): Promise<CdpCheckResult> {
  const browser = await connectCDP()
  try {
    const ctx = firstContext(browser)
    const pages = ctx.pages()
    const out: { url: string; title: string }[] = []
    for (const p of pages) {
      let title = ''
      try {
        title = await p.title()
      } catch {
        /* page may be mid-navigation */
      }
      out.push({ url: p.url(), title })
    }
    return {
      url: `${CHROMATRIX_URL} (identity ${DEFAULT_IDENTITY})`,
      contexts: browser.contexts().length,
      pages: out,
      summary: `leased a tab in chromatrix identity "${DEFAULT_IDENTITY}" - ${browser.contexts().length} context(s), ${pages.length} page(s) in scope`,
    }
  } finally {
    await detach(browser)
  }
}

// ---------------- Reddit probe ----------------
interface MeJson {
  data?: { name?: string; link_karma?: number; comment_karma?: number; total_karma?: number }
}

export interface RedditProbeResult {
  attached: boolean
  loggedIn: boolean
  user: string | null
  karma: { total: number | null; link: number | null; comment: number | null }
  expectedUser: string
  summary: string
}

/** Confirm we can attach to the stealth browser and that it's logged in as the expected account. */
export async function redditProbe(): Promise<RedditProbeResult> {
  const self = redditSelf()
  const browser = await connectCDP()
  try {
    const ctx = firstContext(browser)
    const page = await ctx.newPage()
    try {
      // api/me.json reflects the session cookies of the real profile; {} when logged out.
      await page.goto(`${ORIGIN}/api/me.json`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      const text = await page.innerText('body')
      let me: MeJson = {}
      try {
        me = JSON.parse(text) as MeJson
      } catch {
        /* not JSON - likely an interstitial/login wall; treated as logged-out */
      }
      const d = me.data
      if (d?.name) {
        const mismatch = d.name.toLowerCase() !== self.toLowerCase()
        return {
          attached: true,
          loggedIn: true,
          user: d.name,
          karma: { total: d.total_karma ?? null, link: d.link_karma ?? null, comment: d.comment_karma ?? null },
          expectedUser: self,
          summary:
            `logged in as u/${d.name} - karma ${d.total_karma ?? '?'} (link ${d.link_karma ?? '?'} / comment ${d.comment_karma ?? '?'})` +
            (mismatch ? ` ⚠ expected u/${self}` : ''),
        }
      }
      return {
        attached: true,
        loggedIn: false,
        user: null,
        karma: { total: null, link: null, comment: null },
        expectedUser: self,
        summary: `attached, but no logged-in Reddit session. Log in as u/${self} in the stealth browser, then re-run.`,
      }
    } finally {
      await page.close()
    }
  } finally {
    await detach(browser)
  }
}

// ---------------- Reddit login (navigate only) ----------------
export interface RedditLoginResult {
  url: string
  summary: string
}

const LOGIN_URL = `${ORIGIN}/login/`

/** Navigate a leased tab to Reddit's login page and leave it open for a human to log in as
 *  the configured account. Human-in-the-loop: this only opens the page; it never types. */
export async function redditLogin(): Promise<RedditLoginResult> {
  const self = redditSelf()
  const browser = await connectCDP()
  try {
    const ctx = firstContext(browser)
    // The leased tab starts blank - drive that one rather than opening (and leasing) a second.
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.bringToFront()
    return {
      url: LOGIN_URL,
      summary:
        `opened ${LOGIN_URL} in chromatrix identity "${DEFAULT_IDENTITY}" - take the tab over at ` +
        `the chromatrix gateway, log in as u/${self}, close the tab there, then run reddit-probe`,
    }
  } finally {
    // keepTab: releasing would CLOSE the page we just opened for the human. The lease ends when
    // they close the tab from the dashboard.
    await detach(browser, { keepTab: true })
  }
}

// ---------------- Reddit thread (drafting context) ----------------
export interface RedditThreadResult {
  post: any
  comments: any
  outline: string[]
  summary: string
}

function walkThread(node: any, depth: number, lines: string[]): void {
  for (const c of node?.data?.children ?? []) {
    if (c.kind !== 't1') continue
    const d = c.data ?? {}
    lines.push(`${'  '.repeat(depth)}└ u/${d.author} (+${d.score}): ${clip(d.body, 500)}`)
    if (d.replies) walkThread(d.replies, depth + 1, lines)
  }
}

/** Fetch a full thread (post + comment tree) for drafting context. `path` is `/r/<sub>/comments/<id>`. */
export async function redditThread(path: string): Promise<RedditThreadResult> {
  const arg = path.trim()
  if (!arg.startsWith('/r/')) throw new Error('expected a path like /r/<sub>/comments/<id>')
  const jsonPath = `${arg.replace(/\/$/, '')}.json?raw_json=1&limit=500&sort=old`

  const { post, listing } = await withReddit(async (page) => {
    const f = await fetchOne(page, jsonPath)
    if (!f.ok) throw new Error(`HTTP ${f.status} for ${jsonPath}`)
    const [postListing, comments] = f.json as any[]
    return { post: postListing?.data?.children?.[0]?.data, listing: comments }
  })

  const outline: string[] = []
  walkThread(listing, 0, outline)
  return {
    post,
    comments: listing,
    outline,
    summary: `r/${post?.subreddit} - "${post?.title}" (u/${post?.author}, +${post?.score}, ${post?.num_comments}c, ${outline.length} comment line(s))`,
  }
}

// ---------------- Reddit exploration (read-only discovery) ----------------
// A FUNCTION, not a module constant: the account-scoped paths are only knowable once
// config/accounts.json has been read, and reading it at module scope would throw on import for a
// Box with no reddit account - in a module that every data pull transitively imports.
const exploreEndpoints = (self: string, mentionTerms: string[]): { name: string; path: string }[] => [
  { name: 'me', path: '/api/me.json' },
  { name: 'about', path: `/user/${self}/about.json` },
  { name: 'overview', path: `/user/${self}/overview.json?limit=50&sort=new&raw_json=1` },
  { name: 'submitted', path: `/user/${self}/submitted.json?limit=25&sort=top&raw_json=1` },
  { name: 'comments', path: `/user/${self}/comments.json?limit=25&sort=top&raw_json=1` },
  { name: 'unread', path: '/message/unread.json?limit=25&raw_json=1' },
  { name: 'inbox', path: '/message/inbox.json?limit=25&raw_json=1' },
  { name: 'mentions', path: '/message/mentions.json?limit=25&raw_json=1' },
  { name: 'subscriptions', path: '/subreddits/mine/subscriber.json?limit=100&raw_json=1' },
  // One site-wide search per term the account says means us. Configured rather than hardcoded:
  // this used to be a single literal brand term, which is the tenant fact this file carried.
  ...mentionTerms.map((term) => ({
    name: `search:${term}`,
    path: `/search.json?q=${encodeURIComponent(term)}&limit=25&sort=new&raw_json=1`,
  })),
]

interface Fetched {
  status?: number
  ok?: boolean
  json?: any
  snippet?: string
  error?: string
}

/** Summarize a Listing's children (t1 comment / t3 post / t4 message) as short lines. */
function digestListing(json: any, max = 8): { count: number; lines: string[] } {
  const kids: any[] = json?.data?.children ?? []
  const lines = kids.slice(0, max).map((c) => {
    const d = c.data ?? {}
    if (c.kind === 't3') return `  • [post +${d.score}, ${d.num_comments}c] r/${d.subreddit} - "${clip(d.title, 80)}" (${age(d.created_utc)})`
    if (c.kind === 't1') return `  • [cmt +${d.score}] r/${d.subreddit} on "${clip(d.link_title, 60)}" - "${clip(d.body, 80)}" (${age(d.created_utc)})`
    if (c.kind === 't4') return `  • [msg${d.new ? ' NEW' : ''}] from u/${d.author} - "${clip(d.subject, 40)}": "${clip(d.body, 80)}" (${age(d.created_utc)})`
    return `  • [${c.kind}] ${clip(JSON.stringify(d), 80)}`
  })
  return { count: kids.length, lines }
}

function summarizeExplore(name: string, f: Fetched): string[] {
  if (f.error) return [`✗ ${name}: ERROR ${f.error}`]
  if (!f.ok) return [`✗ ${name}: HTTP ${f.status}${f.snippet ? ` - ${clip(f.snippet, 80)}` : ''}`]
  const j = f.json
  if (name === 'me') {
    const d = j?.data ?? j ?? {} // /api/me.json wraps the account under .data
    return [`✓ me: u/${d.name} · karma ${d.total_karma ?? '?'} (link ${d.link_karma} / comment ${d.comment_karma}) · has_mail=${d.has_mail} · inbox_count=${d.inbox_count}`]
  }
  if (name === 'about') {
    const d = j?.data ?? {}
    return [`✓ about: age ${age(d.created_utc)} · total_karma ${d.total_karma} · verified=${d.verified} · suspended=${d.is_suspended}`]
  }
  if (name === 'subscriptions') {
    const subs = (j?.data?.children ?? []).map((c: any) => `r/${c.data?.display_name}`)
    return [`✓ subscriptions: ${subs.length} - ${subs.slice(0, 20).join(', ')}${subs.length > 20 ? ' …' : ''}`]
  }
  const { count, lines } = digestListing(j)
  return [`✓ ${name}: ${count} item(s)`, ...lines]
}

export interface RedditExploreResult {
  self: string
  fetchedAt: string
  results: Record<string, Fetched>
  summary: string[]
}

/** Exploration-Mode discovery: in-page fetch a battery of Reddit JSON endpoints from the
 *  authenticated origin and return both the raw results and a human-readable digest. */
export async function redditExplore(): Promise<RedditExploreResult> {
  const { login: self, mentionTerms = [] } = defaultAccount('reddit')
  const endpoints = exploreEndpoints(self, mentionTerms)
  const browser = await connectCDP()
  try {
    const ctx = firstContext(browser)
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    if (!page.url().includes('reddit.com')) {
      await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    }
    const results: Record<string, Fetched> = await page.evaluate(
      async ({ origin, eps }: { origin: string; eps: { name: string; path: string }[] }) => {
        const acc: Record<string, any> = {}
        for (const ep of eps) {
          try {
            const r = await fetch(origin + ep.path, { headers: { Accept: 'application/json' }, credentials: 'include' })
            const text = await r.text()
            let json: any = null
            try {
              json = JSON.parse(text)
            } catch {
              /* non-JSON (HTML interstitial / login wall) */
            }
            acc[ep.name] = { status: r.status, ok: r.ok, json, snippet: json ? undefined : text.slice(0, 200) }
          } catch (e) {
            acc[ep.name] = { error: String(e) }
          }
        }
        return acc
      },
      { origin: ORIGIN, eps: endpoints },
    )

    const summary: string[] = []
    for (const ep of endpoints) {
      for (const line of summarizeExplore(ep.name, results[ep.name] ?? { error: 'no result' })) summary.push(line)
    }
    return { self, fetchedAt: new Date().toISOString(), results, summary }
  } finally {
    await detach(browser)
  }
}
