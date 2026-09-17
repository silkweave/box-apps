// Which blog feed this Box pulls. Configuration since 2026-09-14, not a TypeScript constant.
//
// It was `const DEFAULT_FEED = 'https://www.silkweave.dev/rss.xml'` in pulls/blog.ts, and
// `ingestBlog` called `fetchFeed()` with no argument, so there was no override path at all. RSS
// needs no credential, so the blog pull is one of the few that works on a Box's first day - which
// meant the first thing a stranger's Box did was ingest the AUTHOR's posts and derive its
// `blog.*` publishing-cadence signals from them.
//
// It lives on the blog ACCOUNT in config/accounts.json, NOT in a config file of its own. A feed URL
// is a per-channel account fact of exactly the kind that file already holds: `publication` is the
// same thing for Substack (an origin that is not derivable from the login, so it is declared), the
// blog channel is already account-shaped here (pulls/blog.ts resolves its GA4 credential through
// `channelAccounts('blog')`), and a whole fifth config file holding one URL would be a worse tax on
// a field tester than the bug it fixes.
//
// Empty by default, no seed: absent accounts.json, absent `blog` channel, or a blog account with no
// `feed` all mean the same thing - this Box has no blog to pull - and the pull says so and stops.

import { channelAccounts } from '../../accounts.js'

/**
 * The feed URL to pull, or null when none is configured. `channelAccounts` sorts the default
 * account first, so the default account's feed wins; a non-default account with a feed is used when
 * the default has none, which is what makes "one member's blog, pulled by the team's Box" work
 * without inventing a second config shape.
 *
 * Anything that is not an absolute http(s) URL is DROPPED rather than thrown on, matching the npm
 * package list: a typo in one account's `feed` must not take the pull down, it must read as
 * "not configured" and print the line that says where to look.
 */
export function blogFeed(): string | null {
  let accounts: { feed?: string }[]
  try {
    accounts = channelAccounts('blog')
  } catch {
    // Unreadable or malformed accounts.json is the same outcome as no file: the pull declines and
    // says where to look. `readAccountsFile` parses raw and throws; the blog pull must not.
    return null
  }
  for (const account of accounts) {
    const feed = typeof account?.feed === 'string' ? account.feed.trim() : ''
    if (!feed || feed.startsWith('_')) continue
    if (!/^https?:\/\/\S+$/i.test(feed)) continue
    return feed
  }
  return null
}

/** The one line the blog pull prints when no account declares a feed. */
export const BLOG_NOT_CONFIGURED =
  `no blog feed configured - add "feed" to a blog account in config/accounts.json ` +
  `(see docs/examples/accounts.json)`
