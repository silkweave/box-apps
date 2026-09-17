// GA4 Data API client for the blog pull - service-account auth + daily runReport, ported from the
// legacy python (marketing-legacy/scripts/ga4_fetch.py) with zero new dependencies. Auth is the
// OAuth2 service-account JWT grant done by hand: RS256-sign a JWT with the key file's private_key
// (node:crypto), exchange it at the token endpoint, call runReport with the bearer token.
// Fail-loud per repo style: once credentials exist, any API failure throws with the response body.

import { existsSync, readFileSync } from 'node:fs'
import { createSign } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { instanceDir, repoRoot } from '../../../io.js'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta'

interface ServiceAccountKey {
  client_email: string
  private_key: string
}

/**
 * Resolve a credential path like `./.auth/gcp-service-account.json`. Relative paths resolve against
 * the engine repo root first (`.auth/` lives there per CLAUDE.md), then the tenant instance dir as
 * a fallback. Returns null when the file exists in neither place.
 */
export function resolveKeyFile(path: string): string | null {
  if (isAbsolute(path)) return existsSync(path) ? path : null
  for (const base of [repoRoot(), instanceDir()]) {
    const abs = resolve(base, path)
    if (existsSync(abs)) return abs
  }
  return null
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** Mint a short-lived access token via the service-account JWT bearer grant. */
export async function serviceAccountToken(keyFile: string, scope: string = SCOPE): Promise<string> {
  const key = JSON.parse(readFileSync(keyFile, 'utf8')) as ServiceAccountKey
  if (!key.client_email || !key.private_key) {
    throw new Error(`service-account key ${keyFile} is missing client_email/private_key`)
  }
  const iat = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(
    JSON.stringify({ iss: key.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }),
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  const jwt = `${header}.${claims}.${signer.sign(key.private_key, 'base64url')}`

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  if (!res.ok) throw new Error(`GA4 token grant → ${res.status}: ${(await res.text()).slice(0, 400)}`)
  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) throw new Error('GA4 token grant returned no access_token')
  return body.access_token
}

interface RunReportResponse {
  rows?: Array<{
    dimensionValues?: Array<{ value?: string }>
    metricValues?: Array<{ value?: string }>
  }>
}

async function runReport(token: string, property: string, body: unknown): Promise<RunReportResponse> {
  const res = await fetch(`${DATA_API}/${property}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`GA4 ${property}:runReport → ${res.status}: ${(await res.text()).slice(0, 400)}`)
  return (await res.json()) as RunReportResponse
}

/** GA4 returns `date` dimension values as YYYYMMDD - normalize to our YYYY-MM-DD form. */
function isoDate(raw: string): string {
  return /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw
}

/** `sessionDefaultChannelGroup` value → snake_case key ('Organic Search' → 'organic_search'). */
function channelKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unassigned'
}

export interface Ga4Day {
  date: string
  sessions: number
  total_users: number
  new_users: number
  pageviews: number
  channels: Record<string, number>
}

export interface Ga4Block {
  property: string
  range: { start: string; end: string }
  daily: Ga4Day[]
}

/**
 * Fetch daily website analytics for a date range (inclusive): sessions/users/new users/pageviews
 * per day plus per-day sessions by default channel group. Two runReport calls, merged by date.
 */
export async function fetchGa4Daily(opts: {
  keyFile: string
  propertyId: string
  start: string
  end: string
}): Promise<Ga4Block> {
  const property = `properties/${opts.propertyId}`
  const token = await serviceAccountToken(opts.keyFile)
  const dateRanges = [{ startDate: opts.start, endDate: opts.end }]

  const totals = await runReport(token, property, {
    dateRanges,
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'newUsers' }, { name: 'screenPageViews' }],
    limit: 1000,
  })
  const byChannel = await runReport(token, property, {
    dateRanges,
    dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    limit: 5000,
  })

  const days = new Map<string, Ga4Day>()
  const day = (date: string): Ga4Day => {
    let d = days.get(date)
    if (!d) {
      d = { date, sessions: 0, total_users: 0, new_users: 0, pageviews: 0, channels: {} }
      days.set(date, d)
    }
    return d
  }
  for (const row of totals.rows ?? []) {
    const date = isoDate(row.dimensionValues?.[0]?.value ?? '')
    if (!date) continue
    const m = (i: number) => Number(row.metricValues?.[i]?.value ?? 0)
    const d = day(date)
    d.sessions = m(0)
    d.total_users = m(1)
    d.new_users = m(2)
    d.pageviews = m(3)
  }
  for (const row of byChannel.rows ?? []) {
    const date = isoDate(row.dimensionValues?.[0]?.value ?? '')
    const group = row.dimensionValues?.[1]?.value ?? ''
    if (!date || !group) continue
    day(date).channels[channelKey(group)] = Number(row.metricValues?.[0]?.value ?? 0)
  }

  const daily = [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
  return { property, range: { start: opts.start, end: opts.end }, daily }
}
