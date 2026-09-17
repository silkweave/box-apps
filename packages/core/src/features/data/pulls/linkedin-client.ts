// LinkedIn Community Management API client - versioned REST GETs with the app's member token
// (config/credentials.json linkedin@<account>, minted by `pnpm linkedin:auth`). Access tokens live
// ~60 days; when LinkedIn issued a refresh token we renew it here automatically (proactively when
// close to expiry, reactively on a 401) so the daily pull keeps running unattended. Channel doc:
// features/data/SPEC.md.

import { readFileSync, writeFileSync } from 'node:fs'
import { defaultAccount } from '../../../accounts.js'
import { credential, credentialsPath, requireCredentials } from '../../../credentials.js'

/** Pinned Marketing API version (Linkedin-Version header) - bump deliberately, monthly sunsets.
 * (202506 sunset mid-2026; bumped to 202606 on 2026-07-17, good into mid-2027.) */
export const LINKEDIN_VERSION = '202606'

/** Renew this many days before LINKEDIN_TOKEN_EXPIRES_AT rather than risk a mid-pull expiry. */
const RENEW_AHEAD_DAYS = 14

export interface LinkedinTokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  refresh_token_expires_in?: number
  scope?: string
}

/** Persist a token exchange into credentials.json (shared with scripts/linkedin-auth.ts). */
export function saveLinkedinTokens(
  account: string,
  tok: LinkedinTokenResponse,
  personUrn?: string,
): void {
  const path = credentialsPath()
  const store = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    Record<string, Record<string, string>>
  >
  const entry = ((store.linkedin ??= {})[account] ??= {})
  entry.LINKEDIN_ACCESS_TOKEN = tok.access_token
  entry.LINKEDIN_TOKEN_EXPIRES_AT = new Date(Date.now() + tok.expires_in * 1000).toISOString()
  if (tok.refresh_token) {
    entry.LINKEDIN_REFRESH_TOKEN = tok.refresh_token
    if (tok.refresh_token_expires_in)
      entry.LINKEDIN_REFRESH_EXPIRES_AT = new Date(
        Date.now() + tok.refresh_token_expires_in * 1000,
      ).toISOString()
  }
  if (personUrn) entry.LINKEDIN_PERSON_URN = personUrn
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n')
}

export async function exchangeLinkedinToken(
  params: Record<string, string>,
): Promise<LinkedinTokenResponse> {
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`linkedin token exchange failed: ${res.status} ${body}`)
  return JSON.parse(body) as LinkedinTokenResponse
}

/**
 * OAuth client credentials for an account. The Community Management app is ONE shared app, so the
 * id/secret live channel-scoped under `linkedin` → `*` (credential() resolves that automatically;
 * a per-account entry would win if one ever existed). The DEFAULT account's entry is kept as a
 * legacy fallback for stores that predate the channel scope.
 */
export function linkedinClientCreds(account: string): { clientId: string; clientSecret: string } {
  const id = credential('linkedin', account, 'LINKEDIN_CLIENT_ID')
  const secret = credential('linkedin', account, 'LINKEDIN_CLIENT_SECRET')
  if (id && secret) return { clientId: id, clientSecret: secret }
  const dflt = defaultAccount('linkedin').id
  const [clientId, clientSecret] = requireCredentials('linkedin', dflt, 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET')
  return { clientId, clientSecret }
}

/** Whether an account holds a usable member token set (minted via `pnpm linkedin:auth <account>`). */
export function linkedinAuthReady(account: string): boolean {
  return Boolean(
    credential('linkedin', account, 'LINKEDIN_ACCESS_TOKEN') &&
      credential('linkedin', account, 'LINKEDIN_PERSON_URN'),
  )
}

async function refreshAccessToken(account: string): Promise<string> {
  const refresh = credential('linkedin', account, 'LINKEDIN_REFRESH_TOKEN')
  if (!refresh)
    throw new Error(
      `linkedin@${account} token expired and no refresh token stored - re-run: pnpm linkedin:auth ${account}`,
    )
  const { clientId, clientSecret } = linkedinClientCreds(account)
  const tok = await exchangeLinkedinToken({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: clientId,
    client_secret: clientSecret,
  })
  saveLinkedinTokens(account, tok)
  return tok.access_token
}

/** The current access token, proactively refreshed when within RENEW_AHEAD_DAYS of expiry. */
async function accessToken(account: string): Promise<string> {
  const [token] = requireCredentials('linkedin', account, 'LINKEDIN_ACCESS_TOKEN')
  const expiresAt = credential('linkedin', account, 'LINKEDIN_TOKEN_EXPIRES_AT')
  const renewBy = Date.now() + RENEW_AHEAD_DAYS * 86_400_000
  if (expiresAt && Date.parse(expiresAt) < renewBy) {
    try {
      return await refreshAccessToken(account)
    } catch {
      return token // not expired yet - limp on and let the 401 path surface a real failure
    }
  }
  return token
}

/**
 * Authenticated GET against api.linkedin.com. `path` starts with `/rest/…` (versioned, gets the
 * Linkedin-Version header) or `/v2/…` (legacy resources like connections/networkSizes). One
 * automatic refresh-and-retry on 401.
 */
export async function linkedinGet<T>(path: string, account?: string): Promise<T> {
  const acct = account ?? defaultAccount('linkedin').id
  const get = async (token: string) =>
    fetch(`https://api.linkedin.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Restli-Protocol-Version': '2.0.0',
        ...(path.startsWith('/rest/') ? { 'Linkedin-Version': LINKEDIN_VERSION } : {}),
      },
    })
  let res = await get(await accessToken(acct))
  if (res.status === 401) res = await get(await refreshAccessToken(acct))
  if (!res.ok)
    throw new Error(`linkedin GET ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as T
}

/**
 * Authenticated POST against api.linkedin.com (same header/refresh semantics as linkedinGet).
 * Restli create endpoints return the new entity's URN in the `x-restli-id` header with an empty
 * body - the returned `id` is that URN (null if the endpoint sent none).
 */
export async function linkedinPost<T = unknown>(
  path: string,
  payload: unknown,
  account?: string,
): Promise<{ id: string | null; body: T | null }> {
  const acct = account ?? defaultAccount('linkedin').id
  const post = async (token: string) =>
    fetch(`https://api.linkedin.com${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Restli-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        ...(path.startsWith('/rest/') ? { 'Linkedin-Version': LINKEDIN_VERSION } : {}),
      },
      body: JSON.stringify(payload),
    })
  let res = await post(await accessToken(acct))
  if (res.status === 401) res = await post(await refreshAccessToken(acct))
  const text = await res.text()
  if (!res.ok) throw new Error(`linkedin POST ${path} failed: ${res.status} ${text.slice(0, 300)}`)
  const id = res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id')
  let body: T | null = null
  try {
    body = text ? (JSON.parse(text) as T) : null
  } catch {
    body = null
  }
  return { id, body }
}

/** The stored person URN (`urn:li:person:…`) - the `author` for member posts and analytics. */
export function linkedinPersonUrn(account?: string): string {
  const acct = account ?? defaultAccount('linkedin').id
  const [urn] = requireCredentials('linkedin', acct, 'LINKEDIN_PERSON_URN')
  return urn
}

/**
 * Upload an image for use in a post's `content.media`. Two-step Images API dance: initializeUpload
 * (an action, not a create - the new image's URN comes back in the JSON body, not `x-restli-id`) hands
 * back a one-time `uploadUrl`; the image bytes go there as a plain authenticated PUT. Returns the
 * `urn:li:image:…` to reference from `POST /rest/posts`.
 */
export async function linkedinUploadImage(bytes: Buffer, ownerUrn: string, account?: string): Promise<string> {
  const acct = account ?? defaultAccount('linkedin').id
  const token = await accessToken(acct)
  const initRes = await fetch('https://api.linkedin.com/rest/images?action=initializeUpload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Restli-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      'Linkedin-Version': LINKEDIN_VERSION,
    },
    body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
  })
  if (!initRes.ok) {
    throw new Error(`linkedin image initializeUpload failed: ${initRes.status} ${(await initRes.text()).slice(0, 300)}`)
  }
  const init = (await initRes.json()) as { value: { uploadUrl: string; image: string } }
  const uploadRes = await fetch(init.value.uploadUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: bytes,
  })
  if (!uploadRes.ok) {
    throw new Error(`linkedin image upload PUT failed: ${uploadRes.status} ${(await uploadRes.text()).slice(0, 300)}`)
  }
  return init.value.image
}
