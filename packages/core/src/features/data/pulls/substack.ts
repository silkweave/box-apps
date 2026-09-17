// Substack read sync - publication, archive, and the dashboard's headline stats → snapshot + signal.
//
// Unlike the HN/npm/blog pulls this one is AUTHENTICATED: a publication's subscriber count and open
// rate are not public, and the public surface (`/api/v1/archive`, `/feed`) carries only what a
// reader can see. So the pull runs on the same session cookie the publisher uses, and a run with no
// session fails loudly rather than quietly recording a public-only snapshot that would look like a
// collapse in the numbers.
//
// The whole raw response is snapshotted, not just the fields the deriver reads today. That is the
// standing rule for every pull here (history is append-only and re-derivable), and it earns its keep
// especially on this channel: the stats endpoints are undocumented, so a field we find later can be
// back-derived from snapshots we already have instead of being lost.

import { defaultAccount } from '../../../accounts.js'
import {
  getPublication,
  getPostStats,
  getPublicationStats,
  getSelfProfile,
  listPosts,
  POST_PAGE_MAX,
  type SubstackManagedPost,
  type SubstackTarget,
} from './substack-client.js'
import { persist, todayUtc, type IngestProgress, type PullResult } from './types.js'

/** Cap on how much of the archive to enumerate per run - a long-running publication should not make
 *  the daily pull unbounded. Newest first, so the cap drops the oldest posts, not the relevant ones. */
const MAX_POSTS = 200
/** Open drafts are a working state, not history - one page of the most recently touched is enough. */
const MAX_DRAFTS = 50

/** The default account's publication, as a client target. Substack is single-account here on
 *  purpose: one publication, one session. Add an account-scoped variant the day a second one
 *  exists, the way github did. */
function resolveTarget(): SubstackTarget {
  const acct = defaultAccount('substack')
  if (!acct.publication) {
    throw new Error(
      'substack default account has no `publication` in config/accounts.json - ' +
        'set it to the publication origin, e.g. "https://acme.substack.com"',
    )
  }
  return { account: acct.id, owner: acct.user, publication: acct.publication }
}

/** `/post_management/*` answers an envelope (`{posts, offset, limit, total, isCapped}`); tolerate a
 *  bare array too rather than assuming a shape this API is free to change. */
function postRows(res: SubstackManagedPost[] | { posts?: SubstackManagedPost[] }): SubstackManagedPost[] {
  return Array.isArray(res) ? res : (res.posts ?? [])
}

/**
 * Every post for a status, up to `max`, paging at the API's own ceiling. Paging is not optional:
 * `/post_management/*` refuses a limit above 50 with a 400 rather than truncating, so a publication
 * with a 60-post archive would otherwise fail the whole pull rather than return 50 of them.
 */
async function allPosts(
  target: SubstackTarget,
  status: 'published' | 'drafts',
  max: number,
  orderBy?: string,
): Promise<SubstackManagedPost[]> {
  const out: SubstackManagedPost[] = []
  while (out.length < max) {
    const page = await listPosts(target, {
      status,
      offset: out.length,
      limit: Math.min(POST_PAGE_MAX, max - out.length),
      ...(orderBy ? { orderBy } : {}),
    })
    const rows = postRows(page)
    out.push(...rows)
    // Short page means the end. Guarding on an empty page alone would spin forever against an API
    // that ignores a large offset and keeps returning the first page.
    if (rows.length < POST_PAGE_MAX) break
  }
  return out.slice(0, max)
}

/** Streaming ingest action - publication, archive, headline stats → snapshot + signal. */
export async function* ingestSubstack(opts: { date?: string } = {}): AsyncGenerator<IngestProgress> {
  const date = opts.date ?? todayUtc()
  const target = resolveTarget()
  yield { channel: 'substack', phase: 'start', message: `syncing ${target.publication}…` }

  const [profile, publication] = await Promise.all([getSelfProfile(target), getPublication(target)])
  yield { channel: 'substack', phase: 'fetch', message: `${publication.name} - reading the archive` }

  const published = await allPosts(target, 'published', MAX_POSTS)
  const drafts = await allPosts(target, 'drafts', MAX_DRAFTS, 'draft_updated_at')

  yield { channel: 'substack', phase: 'fetch', message: 'reading publication stats' }
  const { parts, errors } = await getPublicationStats(target)
  // The per-post table is fetched separately from the three headline endpoints because it answers
  // where two of them 403 (see deriveSubstack): on a young publication this is the only stats
  // surface that works, and losing it to a sibling's failure would leave the pull with nothing.
  let postStats: unknown = null
  try {
    postStats = await getPostStats(target)
  } catch (err) {
    errors.post_stats = err instanceof Error ? err.message : String(err)
  }

  const snapshot = {
    channel: 'substack',
    date,
    fetched_at: new Date().toISOString(),
    publication: {
      id: publication.id,
      name: publication.name,
      subdomain: publication.subdomain,
      custom_domain: publication.custom_domain ?? null,
      origin: target.publication,
    },
    profile: { id: profile.id, handle: profile.handle, name: profile.name },
    counts: { published: published.length, drafts: drafts.length },
    posts: published.map((p) => ({
      id: p.id,
      title: p.title ?? p.draft_title ?? null,
      slug: p.slug ?? null,
      post_date: p.post_date ?? null,
      audience: p.audience ?? null,
      canonical_url: p.canonical_url ?? null,
    })),
    // Raw and unreshaped: these endpoints are undocumented and their exact fields are what a future
    // deriver will want to mine.
    stats: parts,
    post_stats: postStats,
    stat_errors: errors,
  }

  yield { channel: 'substack', phase: 'persist', message: 'writing snapshot + deriving signals…' }
  await persist('substack', date, snapshot)

  const errNote = Object.keys(errors).length ? ` (stats unavailable: ${Object.keys(errors).join(', ')})` : ''
  const result: PullResult = {
    channel: 'substack',
    date,
    summary: `substack ${date}: ${published.length} published · ${drafts.length} drafts${errNote}`,
  }
  yield { channel: 'substack', phase: 'done', message: result.summary, result }
}
