// Substack's private JSON API - the one the dashboard itself calls, because there is no other.
//
// The official Substack Developer API (shipped January 2026) is a read-only DISCOVERY surface: a
// token from Settings, one documented endpoint (`GET /profile/search/linkedin/{handle}`), and terms
// that permit displaying public creator info. It cannot create a draft, publish a post, or read a
// subscriber count, so it is not what a publishing channel can be built on. Everything below runs
// against the private API instead, authenticated by a session cookie (substack-session.ts).
//
// **Two hosts, and the split is part of the endpoint rather than a detail.** The PUBLISHER surface
// (drafts, post management, stats, subscribers) lives on the publication host,
// `https://<pub>.substack.com/api/v1`; everything about you as a PERSON (profile, subscriptions,
// reader feed, Notes) lives on `https://substack.com/api/v1`. Calling either on the other's host
// answers 404, which is why `pubRequest` and `globalRequest` are separate.
//
// **Provenance.** Endpoint paths, body shapes and the header contract are cross-checked against
// marcomoauro/substack-mcp, which documents per call whether it was verified against the live API.
// Calls this repo has not itself exercised are marked UNVERIFIED at the method. Substack changes
// this API without notice: a 404 on a path that used to work is a re-survey, not a bug in the
// caller.
//
// Two header quirks, both load-bearing and both from that reference:
//   • `Referer` must look like the dashboard page that would make the call. Several endpoints 403
//     without it.
//   • `connect.sid` is sent alongside `substack.sid`. When the browser only carried one, we mirror
//     it, which is what the reference does too.

import { splitChannel } from '../../../accounts.js'
import { USER_AGENT } from '../../../http.js'
import { invalidateSubstackSession, substackSession } from './substack-session.js'

/** The publication API base for a publication origin (`https://x.substack.com` → `.../api/v1`). */
export function publicationApi(publicationUrl: string): string {
  return new URL('/api/v1', publicationUrl).toString()
}

export const SUBSTACK_GLOBAL_API = 'https://substack.com/api/v1'

/**
 * Thrown when Substack rejects the session cookie. Separate from a generic failure because it is
 * the one error worth RETRYING differently: the caller re-mints the cookie and tries once more,
 * rather than surfacing "401" to a human who would then go re-mint it by hand.
 */
export class SubstackAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubstackAuthError'
  }
}

export interface SubstackTarget {
  /** accounts.json account id. */
  account: string
  /** The account's owning users.id, whose browser backs the session. */
  owner: string
  /** Publication origin, e.g. `https://acme.substack.com`. */
  publication: string
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path under `/api/v1`, e.g. `/drafts`. */
  path: string
  body?: unknown
  /** Query params; null/undefined entries are DROPPED rather than serialized - `?query=null` is a
   *  search for the literal string "null", which silently returns nothing. */
  params?: Record<string, string | number | null | undefined>
  /** Dashboard page this call would come from; becomes the Referer. */
  referer?: string
  /** 'text' for the endpoints that do not answer JSON (the subscriber CSV export). */
  parse?: 'json' | 'text'
  /** Absolute URL, when the API hands one back (the export download). Overrides `path`. */
  url?: string
}

/**
 * One authenticated request, with a single automatic re-auth. A 401/403 means the cached cookie
 * died (they expire, and logging out elsewhere kills them); rather than failing the run we drop the
 * memo, re-mint from the author's browser, and replay the request exactly once. A second rejection
 * is real and propagates.
 */
async function request<T>(target: SubstackTarget, opts: RequestOptions, retried = false): Promise<T> {
  const session = await substackSession(target.account, target.owner, { force: retried })
  const base = opts.url ? null : publicationApi(target.publication)
  const url = new URL(opts.url ?? `${base}${opts.path}`)
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value))
  }

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    Cookie: `substack.sid=${session.sid}; connect.sid=${session.connect};`,
    Referer: new URL(opts.referer ?? '/publish/posts', target.publication).toString(),
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(url.toString(), {
    method: opts.method ?? 'GET',
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  })

  // Only a 401 means "this session is not signed in". A 403 means "signed in, but not allowed to do
  // that here" - an endpoint this publication does not expose, or Substack's browser-vs-curl gate -
  // and re-authenticating cannot fix either. Treating 403 as an auth failure was worse than useless:
  // it drove a full browser sign-in on every stats pull (two of the three headline-stats endpoints
  // 403 on a new publication) and then reported the endpoint problem as a login problem.
  if (res.status === 401) {
    if (!retried) {
      invalidateSubstackSession()
      return request<T>(target, opts, true)
    }
    throw new SubstackAuthError(
      `substack ${opts.method ?? 'GET'} ${url.pathname} → 401 even after re-authenticating. ` +
        `Log into Substack in ${target.owner}'s Chrome on the browser host and re-run.`,
    )
  }
  if (!res.ok) {
    // Substack explains the refusal in the body and the status alone rarely does; a 400 here is
    // usually an unexpected key, which this API rejects outright.
    const detail = await res.text().catch(() => '<unreadable body>')
    throw new Error(`substack ${opts.method ?? 'GET'} ${url.pathname} → ${res.status}: ${detail.slice(0, 400)}`)
  }
  return (opts.parse === 'text' ? await res.text() : await res.json()) as T
}

/** A call against the publication host (drafts, stats, subscribers). */
export function pubRequest<T>(target: SubstackTarget, opts: RequestOptions): Promise<T> {
  return request<T>(target, opts)
}

/** A call against substack.com (your profile, the reader feed, Notes). */
export function globalRequest<T>(target: SubstackTarget, opts: RequestOptions): Promise<T> {
  return request<T>(target, { ...opts, url: `${SUBSTACK_GLOBAL_API}${opts.path}`, referer: opts.referer ?? '/' })
}

// --- shapes we actually read -------------------------------------------------------------------
// Only the fields this repo consumes are typed. The responses carry far more; narrowing here keeps
// the deriver honest about what it depends on.

export interface SubstackSelfProfile {
  id: number
  handle: string
  name: string
  publicationUsers?: { publication_id: number; role: string; publication?: { subdomain?: string; name?: string } }[]
}

export interface SubstackPublication {
  id: number
  name: string
  subdomain: string
  custom_domain?: string | null
  author_id?: number
}

/** One row of `/post_management/<status>`. */
export interface SubstackManagedPost {
  id: number
  title: string | null
  draft_title?: string | null
  slug?: string | null
  is_published?: boolean
  post_date?: string | null
  audience?: string
  canonical_url?: string | null
}

export interface SubstackDraftResponse {
  id: number
  draft_title?: string | null
  title?: string | null
  slug?: string | null
  is_published?: boolean
  canonical_url?: string | null
  email_sent_at?: string | null
  post_date?: string | null
}

/** Your own account on substack.com: id (needed for a draft's byline) and the publications you own. */
export function getSelfProfile(target: SubstackTarget): Promise<SubstackSelfProfile> {
  return globalRequest<SubstackSelfProfile>(target, { path: '/user/profile/self' })
}

/** The publication behind the configured host. */
export function getPublication(target: SubstackTarget): Promise<SubstackPublication> {
  return pubRequest<SubstackPublication>(target, { path: '/publication', referer: '/publish/settings' })
}

/**
 * Largest page `/post_management/*` accepts. Measured, not assumed: 50 answers 200 and **51 answers
 * 400** `{"param":"limit","msg":"Invalid value"}` (probed 2026-08-16 across 25/50/51/60/75/99/100/
 * 150/200). Asking for more is a hard failure, not a silent truncation, so anything wanting a deeper
 * archive has to page.
 */
export const POST_PAGE_MAX = 50

/**
 * One page of posts for ONE status. `order_by` is not optional on the API side for every status
 * ('scheduled' answers 400 without it), so it is always sent. The response is an envelope -
 * `{posts, offset, limit, total, isCapped}` - confirmed live.
 */
export function listPosts(
  target: SubstackTarget,
  opts: { status: 'drafts' | 'published' | 'scheduled'; limit?: number; offset?: number; orderBy?: string },
): Promise<SubstackManagedPost[] | { posts?: SubstackManagedPost[]; total?: number }> {
  return pubRequest(target, {
    path: `/post_management/${opts.status}`,
    params: {
      offset: opts.offset ?? 0,
      limit: Math.min(opts.limit ?? POST_PAGE_MAX, POST_PAGE_MAX),
      order_by: opts.orderBy ?? 'post_date',
      order_direction: 'desc',
    },
  })
}

/** Create a draft. `body` is the full draft record - see buildDraftBody in substack-publish.ts. */
export function createDraft(target: SubstackTarget, body: Record<string, unknown>): Promise<SubstackDraftResponse> {
  return pubRequest<SubstackDraftResponse>(target, {
    method: 'POST',
    path: '/drafts',
    body,
    referer: '/publish/post',
  })
}

/** Partial update: only the keys present change, the rest are left alone. */
export function updateDraft(
  target: SubstackTarget,
  draftId: number,
  body: Record<string, unknown>,
): Promise<SubstackDraftResponse> {
  return pubRequest<SubstackDraftResponse>(target, {
    method: 'PUT',
    path: `/drafts/${draftId}`,
    body,
    referer: '/publish/post',
  })
}

export function getDraft(target: SubstackTarget, draftId: number): Promise<SubstackDraftResponse> {
  return pubRequest<SubstackDraftResponse>(target, { path: `/drafts/${draftId}`, referer: '/publish/post' })
}

/**
 * Publish a draft. `send` is the irreversible half: an email cannot be recalled once it is out, so
 * every caller in this repo defaults it to false and a piece has to ask for the email explicitly.
 *
 * UNVERIFIED end to end (confirming it means publishing something real), but the path and the `send`
 * key are read off the dashboard bundle rather than guessed. `share_automatically`, which some
 * third-party clients send, appears nowhere in that bundle and is NOT sent here: an unexpected key
 * is a 400 on several of this API's endpoints.
 */
export function publishDraft(
  target: SubstackTarget,
  draftId: number,
  opts: { send: boolean },
): Promise<SubstackDraftResponse> {
  return pubRequest<SubstackDraftResponse>(target, {
    method: 'POST',
    path: `/drafts/${draftId}/publish`,
    body: { send: opts.send },
    referer: '/publish/post',
  })
}

/**
 * Upload an image and get back a Substack-hosted URL. The body is a DATA URI under `image`, not a
 * file or a remote URL - the editor builds it from `canvas.toDataURL()`. An external src in a post
 * body is stored but does not render, so every image has to come through here first.
 */
export function uploadImage(
  target: SubstackTarget,
  dataUri: string,
  postId?: number,
): Promise<{ id?: string; url: string; imageWidth?: number; imageHeight?: number; bytes?: number }> {
  return pubRequest(target, {
    method: 'POST',
    path: '/image',
    body: postId === undefined ? { image: dataUri } : { image: dataUri, postId },
    referer: '/publish/post',
  })
}

/** The three endpoints behind the dashboard's headline numbers. Fetched together because no one of
 *  them answers "how is the publication doing" on its own. */
export const PUBLICATION_STAT_PARTS = {
  summary: '/publish-dashboard/summary',
  open_rate: '/publication/stats/email_stats/30d_open_rate',
  views_30d: '/publication/stats/publication_traffic/30d_views',
} as const

/**
 * Fetch each headline-stats endpoint independently. One being down costs its own numbers, not the
 * whole snapshot: a pull that returns two thirds and names the third is strictly more useful than
 * one that returns nothing.
 */
export async function getPublicationStats(
  target: SubstackTarget,
): Promise<{ parts: Record<string, unknown>; errors: Record<string, string> }> {
  const names = Object.keys(PUBLICATION_STAT_PARTS) as (keyof typeof PUBLICATION_STAT_PARTS)[]
  const settled = await Promise.allSettled(
    names.map((name) => pubRequest<unknown>(target, { path: PUBLICATION_STAT_PARTS[name], referer: '/publish/stats' })),
  )
  const parts: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  settled.forEach((outcome, i) => {
    const name = names[i]!
    if (outcome.status === 'fulfilled') parts[name] = outcome.value
    else errors[name] = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
  })
  return { parts, errors }
}

/**
 * The per-post table behind the dashboard's Posts tab. Despite the path this is not an aggregate
 * email report: it is one row per post across the archive, paginated and sortable.
 *
 * The API answers **200 for an `order_by` it does not recognise** and returns an arbitrary order, so
 * a typo yields a ranking that looks authoritative and means nothing. Only pass a field name read
 * off a real response.
 */
export function getPostStats(
  target: SubstackTarget,
  opts: { limit?: number; offset?: number; orderBy?: string } = {},
): Promise<{ rows?: unknown[]; total?: number }> {
  return pubRequest(target, {
    path: '/publication/stats/email_stats',
    params: {
      // A much smaller ceiling than post_management's, and on a different scale: 20 answers 200 and
      // 24 answers 400 (probed 2026-08-16 at 1/5/10/20/24/25/50/100). Unknown paging params are
      // IGNORED rather than refused here - page_size, per_page and count all answer 200 and change
      // nothing - so `limit` is the only lever and guessing a bigger one just fails.
      limit: Math.min(opts.limit ?? POST_STATS_PAGE_MAX, POST_STATS_PAGE_MAX),
      offset: opts.offset ?? 0,
      order_by: opts.orderBy ?? 'post_date',
      order_direction: 'desc',
    },
    referer: '/publish/stats/emails',
  })
}

/** Largest page `/publication/stats/email_stats` accepts - see getPostStats. */
export const POST_STATS_PAGE_MAX = 20

/** Resolve `substack` / `substack@<id>` to its account id (the DEFAULT account for the bare channel). */
export function substackAccountId(channel: string, fallback: string): string {
  return splitChannel(channel).account ?? fallback
}
