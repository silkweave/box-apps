import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Avatar } from '@silkweave/box-ui'
import { useAuth } from '../../../lib/useAuth.tsx'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { userName, type User } from '../../../user-types.ts'

/**
 * Mentions on the render side.
 *
 * A mention is stored as PLAIN TEXT in the message body - `@alice`, the bare `users.id`. There is no
 * mention column and no entity array on the wire, deliberately: the body is the whole truth, so an
 * edit re-renders correctly with no second representation to keep in step, and the raw markdown a
 * user edits is the same text they typed. What the server persists separately (the `mentions` table
 * in chat.db) is a NOTIFICATION INDEX, not a rendering input - it is written once at post time and
 * answers "who must be told", never "how does this line look".
 *
 * The consequence to keep in mind: rendering resolves against the LIVE users directory, so a
 * renamed user's old messages show their new name. That is the opposite of `senderName`, which is a
 * write-time snapshot. Both are deliberate - the snapshot keeps authorship honest, the live lookup
 * keeps a mention clickable and correctly labelled.
 */

/**
 * The handle grammar, mirroring `parseMentionHandles` in `packages/core/src/chat/mentions.ts`.
 * Core is the authority (it decides who actually gets notified); this copy exists because the SPA
 * cannot import server-side core, the same reason `chatTypes.ts` mirrors the DTOs by hand. If you
 * change one, change both - a drift here shows as a highlighted mention that never notified, or a
 * notification with no highlight.
 *
 * The leading boundary is what stops `foo@bar.com` from rendering as a mention of `bar`.
 */
export const MENTION_RE = /(^|[\s([{'"])@([a-z0-9][a-z0-9_-]{0,62})/gi

/**
 * The property key the id arrives under on the hast node.
 *
 * VERIFIED, not assumed (2026-08-24, rendered through react-markdown v10 + remark-gfm): an unknown
 * `data-*` key set via `hProperties` reaches the component's `node.properties` VERBATIM as
 * `data-mention` - it is NOT camelCased to `dataMention` the way hast's known-attribute table would
 * do. `readHandle` still checks both, because that mapping is a detail of a dependency rather than
 * a contract, and the cost of being wrong is a mention silently rendering as plain text.
 */
const MENTION_PROP = 'data-mention'

/**
 * The slice of MDAST this file needs, declared structurally rather than imported.
 * `@types/mdast` is only a transitive dependency here (react-markdown's), so it does not resolve
 * from `apps/web` under pnpm's strict layout - importing it would typecheck on one machine and not
 * the next. These four shapes are all the walk below touches.
 */
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: Record<string, unknown>
}

/**
 * A remark plugin that splits `@handle` out of text nodes into their own inline node.
 *
 * It runs over the MDAST rather than over the raw string on purpose: the tree already knows which
 * spans are code, and `@` inside a fenced block or a `backtick span` must stay literal. Doing this
 * with a regex over the source would have to re-implement code detection, badly.
 *
 * The node is emitted as a `span` via `data.hName`, which is the supported way to get a custom
 * inline through `react-markdown` without `rehype-raw` (which we deliberately do not install - see
 * MessageBody). The id travels in `hProperties` and is read back off `node.properties` in `Mention`.
 */
export function remarkMentions() {
  return (tree: MdNode) => {
    visit(tree)
  }
}

/** Depth-first walk that rewrites text nodes, skipping the subtrees where an `@` is not a mention:
 *  code (inline and fenced) and a link's own children (the label of `[@alice](...)` is not a ping). */
function visit(node: MdNode): void {
  if (node.type === 'inlineCode' || node.type === 'code' || node.type === 'link' || node.type === 'linkReference') {
    return
  }
  if (!Array.isArray(node.children)) return

  const next: MdNode[] = []
  let changed = false

  for (const child of node.children) {
    if (child.type !== 'text' || typeof child.value !== 'string') {
      visit(child)
      next.push(child)
      continue
    }
    const split = splitMentions(child.value)
    if (split === null) {
      next.push(child)
      continue
    }
    changed = true
    next.push(...split)
  }

  if (changed) node.children = next
}

/** Returns null when the text holds no mention, so an unchanged node keeps its identity. */
function splitMentions(value: string): MdNode[] | null {
  MENTION_RE.lastIndex = 0
  if (!MENTION_RE.test(value)) return null
  MENTION_RE.lastIndex = 0

  const out: MdNode[] = []
  let cursor = 0

  for (let match = MENTION_RE.exec(value); match !== null; match = MENTION_RE.exec(value)) {
    const [whole, boundary, handle] = match
    const start = match.index + boundary.length
    if (start > cursor) out.push({ type: 'text', value: value.slice(cursor, start) })
    out.push({
      type: 'text',
      value: `@${handle}`,
      data: { hName: 'span', hProperties: { 'data-mention': handle.toLowerCase() } },
    })
    cursor = match.index + whole.length
  }

  if (cursor < value.length) out.push({ type: 'text', value: value.slice(cursor) })
  return out
}

/**
 * One rendered mention, as a TOKEN: a small avatar plus the person's FIRST name.
 *
 * A short name, not the full display name, because a mention is how you address someone in a
 * sentence - "Hey @Dan, how are you?" reads like speech; "Hey @Dan Smith" reads like a database.
 * The avatar carries the identification the surname would otherwise be doing, and it is the same
 * face the gutter and the user menu use, so the person is recognizable before the word is read.
 *
 * A handle that does not resolve against the live directory renders as the plain text the author
 * typed: a token for `@nobody` would imply a notification that was never sent.
 *
 * BASELINE, not centring: the pill is `inline-block`, never `inline-flex`. An inline-flex container
 * takes its baseline from its FIRST flex item, and an image has no text baseline, so the browser
 * falls back to that item's bottom margin edge - which drops the label below the surrounding
 * sentence, and no amount of `align-middle` or translate fudging fixes it because that is
 * correcting the wrong thing. `inline-block` takes its baseline from its last in-flow LINE BOX,
 * i.e. from the label, so the token and the sentence share one baseline for free. The avatar is
 * pulled onto that line by `align-middle` on the AVATAR alone, at 16px so it sits inside the body
 * line height instead of stretching it.
 *
 * `leading-5` on the pill is the second half of that: the label would otherwise inherit the body's
 * 24px line-height, making the pill 26px tall and growing every line that happens to contain a
 * mention by 2px - which reads as uneven spacing in a multi-line message.
 *
 * The AVATAR is then taken out of flow entirely (absolute, centred with `top-1/2 -translate-y-1/2`)
 * and the pill reserves its width with `pl-[22px]` = 3 + 16 + 3. That is the only way the inset is
 * actually equal on all three sides: in flow, the avatar's vertical position came from
 * `vertical-align` against the TEXT BASELINE while its horizontal position came from the pill's
 * padding - two unrelated quantities, so "3px from the left, 3px from the top" could only ever be a
 * coincidence. Out of flow, both come from the same box.
 *
 * Measured, not guessed (2026-08-26): baseline delta 0px, pill 22px inside a 24px line box, and the
 * avatar 3px from left / top / bottom.
 */
export function Mention({ node, children }: { node?: unknown; children?: ReactNode }) {
  const handle = readHandle(node)
  const { principal } = useAuth()
  const { data: users } = useUsersData()

  if (handle === null) return <span>{children}</span>

  const user = users?.find((u) => u.id === handle) ?? null
  if (user === null) return <span>{children}</span>

  const isMe = principal?.id === handle
  return (
    <span
      className={cn(
        'relative mx-px inline-block rounded-full py-px pr-1.5 pl-[22px] leading-5',
        isMe ? 'bg-accent/25 ring-1 ring-accent/40 ring-inset' : 'bg-primary/10',
      )}
      title={isMe ? `${userName(user)} (you)` : userName(user)}>
      <Avatar
        user={user}
        size='xs'
        className='absolute top-1/2 left-[3px] size-4 -translate-y-1/2 text-[9px]'
      />
      <span className={cn('font-medium', isMe ? 'text-text' : 'text-primary')}>{mentionLabel(user)}</span>
    </span>
  )
}

/**
 * The name a token wears: the NICKNAME (a product decision, 2026-08-26).
 *
 * It is what the users directory already presents as a person's handle (`@Alice`, `@Bob`), so a
 * token reads as the same name people use to address each other rather than as whatever is in the
 * first-name field. `first_name` then `id` are the fallbacks for a directory row that never filled
 * one in - the same ladder `userName` walks, with nickname promoted to the front.
 */
export function mentionLabel(user: User): string {
  return user.nickname?.trim() || user.first_name?.trim() || user.id
}

/** Pull the handle back off the hast node the remark plugin produced. Anything else that reaches
 *  the `span` renderer (there is nothing today - `skipHtml` means no author-written markup) is not
 *  a mention and renders untouched. */
function readHandle(node: unknown): string | null {
  if (typeof node !== 'object' || node === null) return null
  const properties = (node as { properties?: Record<string, unknown> }).properties
  if (!properties) return null
  const raw = properties[MENTION_PROP] ?? properties.dataMention
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/** Does this body mention the given user? Used by the notification bell to mark an item. The
 *  message list no longer tints the row it is in (2026-09-04) - a permanent blue rule on a message
 *  you have already read reads as "unread", which is the bell's job, not the transcript's.
 *  Cheap enough to run per rendered message; it is one regex pass. */
export function bodyMentions(body: string, userId: string | null): boolean {
  if (!userId) return false
  MENTION_RE.lastIndex = 0
  for (let match = MENTION_RE.exec(body); match !== null; match = MENTION_RE.exec(body)) {
    if (match[2].toLowerCase() === userId.toLowerCase()) return true
  }
  return false
}
