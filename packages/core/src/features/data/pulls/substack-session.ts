// Substack session cookies - how the private JSON API gets authenticated at all.
//
// Substack has no OAuth and no personal access token. The dashboard authenticates with a session
// COOKIE (`substack.sid`, alongside `connect.sid`), and the private API accepts nothing else. So the
// whole auth story here is: get that cookie, cache it, notice when it dies, get it again.
//
// **`POST /api/v1/login` is not a path that exists for us.** Probed live 2026-08-16 with and without
// a warmed browser-shaped cookie jar: both answer `401 {"error":"Please complete the captcha to
// continue","type":"single"}`. Substack captcha-gates password login unconditionally, so a
// server-side email+password+TOTP exchange cannot work no matter how faithfully the headers are
// forged. The credentials for it (SUBSTACK_EMAIL / SUBSTACK_PASSWORD / SUBSTACK_2FA_SECRET) are
// still load-bearing, just one level up: they drive the sign-in form inside the AUTHOR'S OWN headed
// Chrome on the browser host (chromatrix), where the captcha either never appears or a human can answer it.
//
// The resolution order, cheapest first:
//   1. `SUBSTACK_SID` cached in credentials.json - a cookie we already minted.
//   2. Harvest from the author's Chrome - the usual case, because a human logs into Substack there
//      like a person and the session simply sits in the profile.
//   3. Drive the sign-in form in that Chrome with the stored email/password/TOTP, then harvest.
//
// Every step ends by caching the cookie back into credentials.json (writeCredentials, the same
// rotate-on-use path a rotating refresh token takes), so the steady state is one cheap file read and no
// browser at all. `invalidateSubstackSession` is what turns a 401 mid-flight into a re-harvest
// rather than a failed run.

import { createHmac } from 'node:crypto'
import type { Page } from 'playwright-core'
import { browserIdentity } from '../browsers.js'
import { connectCDP, detach, firstContext } from '../cdp.js'
import { credential, writeCredentials } from '../../../credentials.js'
import { USER_AGENT } from '../../../http.js'

/** Cached session cookie for a substack account (credentials key). */
export const SID_KEY = 'SUBSTACK_SID'
/** The second cookie the dashboard sends. Optional: absent, we mirror `substack.sid` into it. */
export const CONNECT_SID_KEY = 'SUBSTACK_CONNECT_SID'
/** Credentials keys for the browser sign-in fallback: the human's own login, used by a machine. */
export const EMAIL_KEY = 'SUBSTACK_EMAIL'
export const PASSWORD_KEY = 'SUBSTACK_PASSWORD'
/** The TOTP shared secret (the base32 string behind the 2FA QR code). */
export const SECRET_KEY = 'SUBSTACK_2FA_SECRET'

export interface SubstackSession {
  /** `substack.sid` value. */
  sid: string
  /** `connect.sid` value, mirrored from `sid` when the browser did not carry a distinct one. */
  connect: string
  /** How this session was obtained - surfaced in run logs so a slow run explains itself. */
  source: 'cache' | 'browser' | 'login'
}

// --- TOTP ------------------------------------------------------------------------------------

/** RFC 4648 base32 → bytes. Padding and whitespace are tolerated; anything else is a typo in the
 *  secret, and a silently-wrong key would show up only as a rejected 2FA code minutes later. */
function base32Decode(secret: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = secret.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase()
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch)
    if (idx === -1) throw new Error(`${SECRET_KEY} is not valid base32 (bad character "${ch}")`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/**
 * The current 6-digit TOTP code for a base32 shared secret - RFC 6238 with the defaults every
 * authenticator app uses (SHA-1, 30s step, 6 digits). Written out rather than pulled from a package
 * because it is twenty lines and this repo has exactly one consumer.
 */
export function totp(secret: string, at: number = Date.now()): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)))
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  // Dynamic truncation: the low nibble of the last byte picks the 4-byte window to read.
  const offset = digest[digest.length - 1]! & 0x0f
  const code = digest.readUInt32BE(offset) & 0x7fffffff
  return String(code % 1_000_000).padStart(6, '0')
}

/**
 * Seconds left on the current TOTP step. The login flow waits for a fresh window when a code is
 * about to roll over: typing a code with 2 seconds of life left races the form submit, and the
 * failure ("invalid code") looks exactly like a wrong secret.
 */
export function totpSecondsRemaining(at: number = Date.now()): number {
  return 30 - Math.floor((at % 30_000) / 1000)
}

// --- cookie harvest --------------------------------------------------------------------------

/** Pull the substack cookies out of a running identity's Chrome profile. */
async function readCookiesFromBrowser(identity: string): Promise<{ sid?: string; connect?: string }> {
  const browser = await connectCDP(identity)
  try {
    const cookies = await firstContext(browser).cookies(['https://substack.com'])
    return {
      sid: cookies.find((c) => c.name === 'substack.sid')?.value,
      connect: cookies.find((c) => c.name === 'connect.sid')?.value,
    }
  } finally {
    await detach(browser)
  }
}

/**
 * Sign in inside the identity's own Chrome, using the stored email/password and answering the TOTP
 * prompt from `SUBSTACK_2FA_SECRET`. Returns the cookies the successful login left behind.
 *
 * This is the LAST resort, and it deliberately refuses to be clever about failure. If a captcha
 * appears (Substack shows one on password login readily - it is why the server-side login endpoint
 * is unusable), the flow stops and leaves the tab OPEN so a human can finish the sign-in in the
 * chromatrix dashboard, the same contract redditLogin has. Half-solving a captcha by retrying is
 * how an account gets flagged.
 */
async function loginInBrowser(identity: string, account: string): Promise<{ sid?: string; connect?: string }> {
  const email = credential('substack', account, EMAIL_KEY)
  const password = credential('substack', account, PASSWORD_KEY)
  if (!email || !password) {
    throw new Error(
      `substack@${account} has no usable session and cannot sign itself in: set ${EMAIL_KEY} + ${PASSWORD_KEY} ` +
        `(and ${SECRET_KEY} if 2FA is on) in config/credentials.json, or just log into Substack once in ${identity}'s Chrome`,
    )
  }

  const browser = await connectCDP(identity)
  let keepTab = false
  try {
    const page = await firstContext(browser).newPage()
    await page.goto('https://substack.com/sign-in', { waitUntil: 'domcontentloaded' })

    // The page opens on the magic-link form (one email field + Continue); the password form is
    // behind this link. Structure read off the live page 2026-08-16: `a.login-option`, then
    // `input[name=email]` + `input[name=password]` + `button[type=submit]` in a form whose action
    // is https://substack.com/api/v1/login.
    //
    // waitFor, NOT isVisible: `isVisible()` resolves immediately and ignores a timeout option, so
    // checking it straight after domcontentloaded races the React render and silently answers false
    // for a link that is about to appear. That single mistake is what made the first version of this
    // flow "succeed" while never switching to the password form.
    const toPassword = page.getByText('Sign in with password', { exact: false }).first()
    await toPassword.waitFor({ state: 'visible', timeout: 20_000 })
    await toPassword.click()

    const passwordField = page.locator('input[name="password"]').first()
    await passwordField.waitFor({ state: 'visible', timeout: 20_000 })
    await page.locator('input[name="email"]').first().fill(email)
    await passwordField.fill(password)

    // Read the LOGIN CALL's own answer rather than inferring from the DOM. Substack states the
    // refusal in the response body ("Please complete the captcha to continue", a wrong password, an
    // MFA challenge); watching the page instead means guessing at rendered error text and, worse,
    // treating a silent failure as a success - which is exactly how a run ends up holding an
    // anonymous cookie and reporting nothing wrong.
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/v1/login'), { timeout: 45_000 }),
      page.locator('button[type="submit"]').first().click(),
    ])
    const body = await response.text().catch(() => '')

    if (!response.ok()) {
      keepTab = true
      if (/captcha/i.test(body) || (await captchaVisible(page))) {
        throw new Error(
          `substack sign-in hit a captcha in ${identity}'s browser. The tab is left open - solve it in the ` +
            'chromatrix dashboard, finish the sign-in, then re-run. (This is the same wall that makes ' +
            'POST /api/v1/login unusable from the server.)',
        )
      }
      throw new Error(`substack refused the sign-in for ${account} (${response.status()}): ${body.slice(0, 300)}`)
    }

    // 2FA, when the account has it on. The prompt is a single 6-digit field.
    const codeField = page.locator('input[name="code"], input[autocomplete="one-time-code"]').first()
    if (await codeField.isVisible().catch(() => false) || (await codeField.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false))) {
      const secret = credential('substack', account, SECRET_KEY)
      if (!secret) {
        keepTab = true
        throw new Error(
          `substack asked ${account} for a 2FA code and no ${SECRET_KEY} is configured. The tab is left open - ` +
            'enter the code by hand in the chromatrix dashboard, or add the secret to config/credentials.json',
        )
      }
      // Never type a code that is about to expire: the submit would race the rollover, and the
      // rejection is indistinguishable from a wrong secret.
      if (totpSecondsRemaining() < 5) await page.waitForTimeout(6_000)
      await codeField.fill(totp(secret))
      await page.locator('button[type="submit"]').first().click()
      await page.waitForTimeout(4_000)
    }

    // Landing anywhere outside /sign-in is the signal; the exact destination varies with whether the
    // account has a publication, unread notes, or an onboarding interstitial. A timeout here is not
    // fatal on its own - the caller's isSignedIn probe is the actual verdict - so it is swallowed,
    // but any on-page error text is carried into the failure message the caller will raise.
    await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 }).catch(() => undefined)

    const cookies = await firstContext(browser).cookies(['https://substack.com'])
    await page.close().catch(() => undefined)
    return {
      sid: cookies.find((c) => c.name === 'substack.sid')?.value,
      connect: cookies.find((c) => c.name === 'connect.sid')?.value,
    }
  } finally {
    await detach(browser, { keepTab })
  }
}

/** Whether a captcha challenge is on screen - hCaptcha/Turnstile both mount an iframe we can see. */
async function captchaVisible(page: Page): Promise<boolean> {
  const frame = page.locator('iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[title*="captcha" i]')
  if (await frame.first().isVisible({ timeout: 3_000 }).catch(() => false)) return true
  return page.locator('text=/complete the captcha/i').first().isVisible({ timeout: 1_000 }).catch(() => false)
}

// --- resolution ------------------------------------------------------------------------------

/**
 * Is this cookie pair actually SIGNED IN?
 *
 * This probe is not defensive programming, it is the load-bearing step. **Substack sets
 * `substack.sid` on anonymous visitors too** (verified 2026-08-16: the cookie was present in a
 * browser profile that was not logged into Substack at all, and every API call with it answered
 * 401). So "a substack.sid exists" says nothing about whether anyone is logged in, and a resolver
 * that trusts its presence hands the caller a cookie that cannot work, skips the sign-in fallback it
 * was supposed to trigger, and turns a recoverable state into a hard 401.
 *
 * `/user/profile/self` is the cheapest thing that requires a real session, and it lives on
 * substack.com, so the probe does not need a publication to be configured yet.
 */
async function isSignedIn(sid: string, connect: string): Promise<boolean> {
  try {
    const res = await fetch('https://substack.com/api/v1/user/profile/self', {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        Cookie: `substack.sid=${sid}; connect.sid=${connect};`,
      },
    })
    return res.ok
  } catch {
    // A transport failure is not evidence the cookie is bad; treat it as "unknown, keep going" and
    // let the real call report the network problem in its own words.
    return true
  }
}

/** In-process memo, so a pull making twenty calls resolves (and probes) once. */
let memo: { account: string; session: SubstackSession } | null = null

/**
 * The session cookie for a substack account, in ascending order of cost: the cached one, the
 * author's own Chrome, then a sign-in driven inside that Chrome. Each candidate is PROBED before it
 * is accepted (see isSignedIn), so a stale or anonymous cookie falls through to the next step
 * instead of being handed out. `force` skips the cache, which is what a 401 mid-run triggers.
 */
export async function substackSession(
  account: string,
  owner: string,
  opts: { force?: boolean } = {},
): Promise<SubstackSession> {
  if (!opts.force && memo?.account === account) return memo.session

  const accept = (sid: string, connect: string | undefined, source: SubstackSession['source']) => {
    const session: SubstackSession = { sid, connect: connect ?? sid, source }
    // writeCredentials is read-modify-write + atomic, so caching here cannot clobber a concurrent
    // edit to another channel's keys.
    writeCredentials('substack', account, {
      [SID_KEY]: sid,
      ...(connect ? { [CONNECT_SID_KEY]: connect } : {}),
    })
    memo = { account, session }
    return session
  }

  if (!opts.force) {
    const sid = credential('substack', account, SID_KEY)
    const connect = credential('substack', account, CONNECT_SID_KEY)
    if (sid && (await isSignedIn(sid, connect ?? sid))) {
      const session: SubstackSession = { sid, connect: connect ?? sid, source: 'cache' }
      memo = { account, session }
      return session
    }
  }

  const identity = browserIdentity(owner)
  if (!identity) {
    throw new Error(
      `substack@${account} needs a session cookie and "${owner}" has no browser in config/browsers.json. ` +
        `Either add one, or paste a ${SID_KEY} into config/credentials.json by hand (DevTools → Application → Cookies).`,
    )
  }

  const harvested = await readCookiesFromBrowser(identity)
  if (harvested.sid && (await isSignedIn(harvested.sid, harvested.connect ?? harvested.sid))) {
    return accept(harvested.sid, harvested.connect, 'browser')
  }

  const logged = await loginInBrowser(identity, account)
  if (!logged.sid) {
    throw new Error(`signed in as substack@${account} but no substack.sid cookie was set - the login did not take`)
  }
  if (!(await isSignedIn(logged.sid, logged.connect ?? logged.sid))) {
    throw new Error(
      `substack@${account} finished the sign-in flow in ${identity}'s browser but the resulting cookie is still ` +
        'anonymous. Log in by hand in the chromatrix dashboard and re-run.',
    )
  }
  return accept(logged.sid, logged.connect, 'login')
}

/**
 * Forget the cached session after the API rejects it. Only the in-process memo is dropped, NOT the
 * stored cookie: `substackSession(..., {force: true})` is what re-mints, and it overwrites the
 * stored value on success. Deleting the credential here would turn one transient 401 into a
 * permanently unauthenticated channel if the re-mint then failed.
 */
export function invalidateSubstackSession(): void {
  memo = null
}
