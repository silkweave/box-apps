// Mention parsing for chat message bodies. In @silkweave/box-core rather than the server so the one rule
// serves the NestJS controller, the tests and any future ops script - and so the store's tests can
// pin it without booting Nest. Kept out of types.ts on purpose: that file is the domain's shapes,
// this is behavior.

// A handle is `@` + a `users.id`-shaped slug: lowercase-alphanumeric start, then up to 62 more of
// [a-z0-9_-]. Matched case-insensitively and lowercased, because "@Alice" is clearly aimed at alice.
// The leading `(^|[...])` group is the boundary rule: start of string, whitespace, or an OPENING
// bracket/paren/quote. That single rule is what stops `foo@bar.com` from becoming a mention of
// "bar" - an email's `@` is always preceded by a word character. A closing-punctuation boundary
// (`,@alice`) is deliberately NOT accepted: nobody types that aiming at a person, and widening the
// rule is a one-character change if real usage proves otherwise.
const HANDLE_PATTERN = /(^|[\s([{<"'])@([a-z0-9][a-z0-9_-]{0,62})/gi

/**
 * Extract CANDIDATE mention handles from a message body: unique, order-preserving, lowercased.
 *
 * Candidates only, by design - this function does not know the user directory (users live in the
 * DuckDB warehouse, another engine). The server controller intersects the result with
 * `readUsers()` and passes only real ids to `ChatStore.post`, so a stray "@everyone" costs nothing
 * here. The rejected alternative - resolving against the directory inside core - would drag a
 * cross-engine read into a pure string function and make it untestable without a warehouse.
 *
 * Code is not prose: fenced blocks, inline `code` spans and markdown link targets `](...)` are
 * stripped before scanning, because "@alice" inside a snippet or a URL is a quotation, not a ping.
 */
export function parseMentionHandles(body: string): string[] {
  // Strip in this order: fences first (a fence legitimately contains backticks), then inline
  // spans, then link targets. Each strip substitutes a SPACE rather than deleting: deletion would
  // glue the stripped region's neighbors together, and "(`x`@alice)" must not lose its opening
  // bracket boundary to the splice. A manufactured space can only widen matching toward false
  // positives, which the directory intersection then discards - a false negative would silently
  // drop a real notification.
  const stripped = body
    // Fenced block; an UNTERMINATED fence swallows to end-of-string, matching how it renders.
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    // Inline span. Newlines excluded so one stray backtick cannot swallow the rest of the message.
    .replace(/`[^`\n]*`/g, ' ')
    // Markdown link target: the `](url)` half. The link TEXT half stays scannable - `[@alice](url)`
    // is aimed at alice even when the URL is not.
    .replace(/\]\([^)\n]*\)/g, '] ')

  const seen = new Set<string>()
  const handles: string[] = []
  for (const match of stripped.matchAll(HANDLE_PATTERN)) {
    const handle = match[2].toLowerCase()
    if (!seen.has(handle)) {
      seen.add(handle)
      handles.push(handle)
    }
  }
  return handles
}


/** The fields a mention menu ranks on. Names, not a user row: this module has no users dependency. */
export interface MentionCandidate {
  id: string
  /** The full display name, as the menu shows it. */
  name: string
  /** The short name, when there is one. Matched separately because people type it. */
  nickname?: string | null
}

/**
 * Order the mention menu, best first, and drop what does not match at all.
 *
 * The TESTED home of a rule with three implementations - this one, the web menu's mirror in
 * `MentionSuggest.tsx` (web does not depend on core), and `mention_picker.dart` on the phone.
 * Split out of the web menu on 2026-09-03, because filtering is not ranking. The menu used to keep
 * whatever order the users directory came in, so typing `@a` highlighted the first person whose
 * NAME merely contained an "a" - Enter picked the wrong human, and the fix from the typist's side
 * was to keep typing until the field narrowed to one. The reported symptom was exactly that: `@a`
 * did not select nova, `@ab` did.
 *
 * The tiers, in the order a typist means them:
 *
 * 0. the id EXACTLY - `@nova` is nova, whatever else contains those letters.
 * 1. the id by prefix - the id is the handle being typed, so it outranks any name.
 * 2. a name WORD by prefix - `@st` should reach "Alice Strand", and a surname is a word.
 * 3. a name anywhere - the last resort, kept because it is occasionally the only thing you recall.
 *
 * Ties break on the SHORTER id, then alphabetically: a shorter id shares more of its length with
 * what was typed, which is the same "closest match" instinct the tiers encode. Deliberately not
 * fuzzy - a typo-tolerant matcher would put a wrong person one Enter away, and this is a menu
 * whose mistakes notify somebody.
 */
export function rankMentionCandidates<T extends MentionCandidate>(
  candidates: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase()
  const scored: { tier: number; item: T }[] = []
  for (const item of candidates) {
    const tier = needle.length === 0 ? 1 : mentionTier(item, needle)
    if (tier === null) continue
    scored.push({ tier, item })
  }
  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.item.id.length !== b.item.id.length) return a.item.id.length - b.item.id.length
    return a.item.id.localeCompare(b.item.id)
  })
  return scored.map((s) => s.item)
}

function mentionTier(item: MentionCandidate, needle: string): number | null {
  const id = item.id.toLowerCase()
  if (id === needle) return 0
  if (id.startsWith(needle)) return 1
  const names = [item.name, item.nickname ?? ''].filter((n) => n.length > 0).map((n) => n.toLowerCase())
  // A name WORD, not the whole string: someone whose display name is "Alice Strand" has to be
  // reachable as @strand, and "strand" is not a prefix of "alice strand".
  if (names.some((n) => n.split(/\s+/).some((word) => word.startsWith(needle)))) return 2
  if (names.some((n) => n.includes(needle))) return 3
  return null
}
