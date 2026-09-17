// Canonical keys for CRM matching.
//
// Every function here turns a messy human/provider value into a form two rows can be COMPARED on.
// They are pure, and they are deliberately in their own file: the matching ladder (crm/state.ts)
// and whatever sync feeds `import.ts` must agree byte for byte on what "the same" means, and the
// only way to guarantee that is one implementation with tests around it.
//
// None of these keys is authoritative. They are indexes into a judgement call - "probably the same
// company" - and the ladder records which rung matched so a wrong merge stays traceable.

/** Legal-form suffixes stripped when comparing company names. Longest first: `pte ltd` must be
 *  tried before `ltd`, or `northwind pte ltd` collapses to `northwind pte`. */
const LEGAL_SUFFIXES = [
  'pte ltd', 'pty ltd', 'sdn bhd', 'co ltd', 'pvt ltd', 'private limited',
  'limited', 'incorporated', 'corporation', 'holdings', 'group',
  'ltd', 'llc', 'llp', 'inc', 'corp', 'gmbh', 'ag', 'bv', 'nv', 'plc',
  'pty', 'pte', 'srl', 'spa', 'sa', 'as', 'ab', 'oy', 'kk', 'co',
]

/**
 * Letters NFKD does not decompose, because they are distinct letters rather than an accented base:
 * stripping combining marks leaves them intact and the `[^a-z0-9]` pass then eats them, turning
 * "Moller" into "m ller" and breaking the match it was supposed to make.
 */
const LETTER_FOLDS: [RegExp, string][] = [
  [/\u00f8|\u00d8/g, 'o'],   // o-slash
  [/\u00e6|\u00c6/g, 'ae'],
  [/\u0153|\u0152/g, 'oe'],
  [/\u00df/g, 'ss'],
  [/\u0111|\u0110|\u00f0|\u00d0/g, 'd'],
  [/\u00fe|\u00de/g, 'th'],
  [/\u0142|\u0141/g, 'l'],
  [/\u0131/g, 'i'],
]

/** Lowercase, fold the letters NFKD cannot, then strip combining marks. */
function foldLetters(input: string): string {
  let s = input.toLowerCase()
  for (const [re, to] of LETTER_FOLDS) s = s.replace(re, to)
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
}

/**
 * A company name reduced to a comparison key: `"Northwind Pte Ltd."` -> `"northwind"`.
 *
 * Lowercased, accents folded, `&` spelled out, punctuation dropped, whitespace collapsed, then
 * legal suffixes peeled off the END repeatedly (`"Acme Holdings Ltd"` -> `"acme"`).
 *
 * Returns `''` when nothing survives - a name that is ONLY a legal form ("Ltd") is not a key, and
 * an empty key must never match another empty key. Callers check for `''` before comparing.
 */
export function companyNameKey(name: string | null | undefined): string {
  let s = foldLetters(name ?? '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (!s) return ''
  // Repeat: "Acme Holdings Ltd" has two suffixes stacked.
  for (let pass = 0; pass < LEGAL_SUFFIXES.length; pass++) {
    const before = s
    for (const suffix of LEGAL_SUFFIXES) {
      if (s.endsWith(` ${suffix}`)) {
        s = s.slice(0, -(suffix.length + 1)).trim()
        break
      }
    }
    if (s === before) break
  }
  // A name that is ONLY a legal form ("Ltd", "Holdings") is not an identity. The loop above cannot
  // catch it: it peels a suffix preceded by a space, and there is nothing in front of this one.
  if (LEGAL_SUFFIXES.includes(s)) return ''
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * A LinkedIn profile URL reduced to a comparison key: the profile PATH, lowercased.
 *
 *   https://www.linkedin.com/in/sam.lee/?originalSubdomain=sg  ->  in/sam.lee
 *   http://sg.linkedin.com/in/Sam.Lee                          ->  in/sam.lee
 *
 * The host is discarded entirely (country subdomains are the same profile), as are the query, the
 * fragment and any trailing slash. A non-LinkedIn URL returns `''` rather than a key, because a
 * company website in the LinkedIn column is a data error, not an identity.
 */
export function linkedinKey(url: string | null | undefined): string {
  const raw = (url ?? '').trim()
  if (!raw) return ''
  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return ''
  }
  if (!/(^|\.)linkedin\.com$/i.test(parsed.hostname)) return ''
  const path = parsed.pathname.replace(/\/+$/, '').replace(/^\/+/, '').toLowerCase()
  if (!path) return ''
  // Keep only the identifying head: `in/<slug>`, `company/<slug>`, `sales/lead/<id>`. A deeper
  // path (`/in/sam.lee/recent-activity`) is the same profile.
  const parts = path.split('/')
  if (parts[0] === 'in' && parts[1]) return `in/${parts[1]}`
  if (parts[0] === 'company' && parts[1]) return `company/${parts[1]}`
  return parts.slice(0, 2).join('/')
}

/**
 * The registrable domain of a website: `"https://www.Bluebird-Branding.com/about?x=1"` ->
 * `"bluebird-branding.com"`.
 *
 * `www.` is stripped; nothing else is. This is NOT a public-suffix implementation - `foo.co.uk`
 * stays `foo.co.uk` because we never shorten, only normalise, so the worst case is two spellings
 * of one company failing to match rather than two companies wrongly matching.
 *
 * Returns `''` for a host with no dot (`localhost`) or a free mail provider, which identifies a
 * person and never a company.
 */
const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'outlook.com',
  'live.com', 'msn.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'mail.com', 'qq.com', '163.com', 'yandex.com', 'email.com',
])

export function websiteDomain(url: string | null | undefined): string {
  const raw = (url ?? '').trim()
  if (!raw) return ''
  let host: string
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return ''
  }
  host = host.replace(/^www\./, '')
  if (!host.includes('.')) return ''
  if (FREE_MAIL.has(host)) return ''
  return host
}

/** The domain of an email address, subject to the same free-provider rule. */
export function emailDomain(email: string | null | undefined): string {
  const at = (email ?? '').trim().toLowerCase().lastIndexOf('@')
  if (at < 0) return ''
  return websiteDomain((email ?? '').trim().toLowerCase().slice(at + 1))
}

/**
 * A slug usable as a `crm_accounts.id`.
 *
 * Tighter than `assertValidId` on purpose: an account id is also a FILENAME (`data/docs/crm/<id>.md`)
 * and `crmDocPath` enforces `^[a-z0-9][a-z0-9-]*$`, so an id that passes the looser check can still
 * 400 the doc route. Generating one that fails that regex would be a bug nobody sees until somebody
 * opens the account's notes.
 */
export function accountSlug(name: string | null | undefined, fallback = 'account'): string {
  const s = foldLetters(name ?? '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  // Must START with [a-z0-9]: a name of pure punctuation, or one starting with a digit-free symbol,
  // would otherwise produce an id the doc layer rejects.
  return /^[a-z0-9]/.test(s) ? s : fallback
}
