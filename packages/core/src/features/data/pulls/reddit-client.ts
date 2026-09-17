// Shared Reddit access for all Reddit ingest + Exploration-Mode scripts. Attaches to the stealth
// browser (see features/data/SPEC.md) and fetches JSON endpoints from the
// authenticated www.reddit.com origin - cookies + real UA sent natively, no API keys (the OAuth
// path is blocked).

import type { Page } from 'playwright-core'
import { defaultAccount } from '../../../accounts.js'
import { connectCDP, firstContext, detach } from '../cdp.js'

/**
 * WHOSE Reddit account these pulls are, from the default `reddit` account in config/accounts.json.
 *
 * A FUNCTION rather than a module constant, deliberately: it is read at call time, so editing
 * accounts.json takes effect on the next run with no restart, and importing this module on a Box
 * that has no reddit account configured does not throw at import (which would take out every
 * module that transitively imports it, including ones that never touch Reddit). `defaultAccount`
 * refuses with a pointed message at the point of USE instead.
 */
export const redditSelf = (): string => defaultAccount('reddit').login

export const ORIGIN = 'https://www.reddit.com'

export interface Fetched<T = any> {
  status?: number
  ok?: boolean
  json?: T | null
  snippet?: string
  error?: string
}

/**
 * Attach, ensure we're on the reddit.com origin (so same-origin fetch carries the session), run
 * `fn`, and always detach. The browser is never launched/killed - we only borrow the session.
 */
export async function withReddit<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await connectCDP()
  try {
    const ctx = firstContext(browser)
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    if (!page.url().includes('reddit.com')) {
      await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    }
    return await fn(page)
  } finally {
    await detach(browser)
  }
}

/** Batch GET several reddit JSON paths from inside the page (one round-trip). Keyed by path. */
export async function fetchAll(page: Page, paths: string[]): Promise<Record<string, Fetched>> {
  return page.evaluate(
    async ({ origin, paths }: { origin: string; paths: string[] }) => {
      const acc: Record<string, any> = {}
      for (const p of paths) {
        try {
          const r = await fetch(origin + p, { headers: { Accept: 'application/json' }, credentials: 'include' })
          const text = await r.text()
          let json: any = null
          try {
            json = JSON.parse(text)
          } catch {
            /* non-JSON: HTML interstitial / login wall */
          }
          acc[p] = { status: r.status, ok: r.ok, json, snippet: json ? undefined : text.slice(0, 200) }
        } catch (e) {
          acc[p] = { error: String(e) }
        }
      }
      return acc
    },
    { origin: ORIGIN, paths },
  )
}

/** Single-path convenience. */
export async function fetchOne(page: Page, path: string): Promise<Fetched> {
  return (await fetchAll(page, [path]))[path] ?? { error: 'no result' }
}

/**
 * Fail loud if the borrowed session isn't logged in as the configured account. Automated pulls must never write a
 * "zero activity" file just because the browser got logged out - that would corrupt history.
 */
export async function assertLoggedIn(page: Page): Promise<void> {
  const me = await fetchOne(page, '/api/me.json')
  const name = me.json?.data?.name
  if (!name) {
    throw new Error('Reddit session not logged in (api/me.json has no account). Run: pnpm cli reddit-login')
  }
  const self = redditSelf()
  if (name.toLowerCase() !== self.toLowerCase()) {
    throw new Error(`Reddit session is u/${name}, expected u/${self}.`)
  }
}
