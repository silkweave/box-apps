import { useAuth } from '../../../lib/useAuth.tsx'
import type { Editor } from '@tiptap/core'
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Avatar } from '@silkweave/box-ui'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { useDirectRoom } from './DirectRoomContext.tsx'
import { userName, type User } from '../../../user-types.ts'

/**
 * @-autocomplete for the composer.
 *
 * Built by hand rather than on `@tiptap/suggestion`, for one concrete reason: the composer's
 * `SendKeymap` claims Enter at priority 1000 (Enter SENDS here, which fights every TipTap default),
 * and a suggestion plugin wants Enter too. Two independent keymaps racing for the same key is the
 * kind of thing that works until someone changes an extension's priority. Instead there is ONE
 * keymap, and it asks this component - through `handleRef` - whether a menu is open before it
 * decides what Enter means. The dependency we did not add is a bonus, not the reason.
 *
 * The menu never inserts a display name into the body. It inserts `@<users.id>`, because the id is
 * the handle the server parses and notifies on (`parseMentionHandles` in core). What the reader
 * sees is resolved at render time - see `mentions.tsx`.
 */

/** What the composer's keymap needs to know. Deliberately imperative: the keymap is created once,
 *  in a `useMemo`, and cannot close over React state. */
export interface MentionSuggestHandle {
  isOpen: () => boolean
  /** Move the highlight, wrapping at both ends. */
  move: (delta: number) => void
  /** Insert the highlighted user. Returns false when there was nothing to insert, so the keymap can
   *  fall through to its normal meaning for that key. */
  commit: () => boolean
  close: () => void
}

/** How many candidates the menu shows. Beyond a handful you should be typing, not scrolling. */
const MAX_ITEMS = 8


interface MentionSuggestProps {
  editor: Editor | null
  handleRef: RefObject<MentionSuggestHandle | null>
}

/**
 * In a DIRECT MESSAGE the menu offers the AGENT and nobody else (`DirectRoomContext`). A mention of
 * a third human in a DM is inert by design - `ChatStore.post` intersects the mention set with the
 * room's members, so it grants nothing and notifies nobody - and mentioning the one other person in
 * the room is addressing them in the third person. nova is the single exception, because "ask nova to
 * do this" has to work in a DM between two people. The phone's `mention_picker.dart` mirrors this.
 */
export function MentionSuggest({ editor, handleRef }: MentionSuggestProps) {
  const { agent } = useAuth()
  const { data: users } = useUsersData()
  const direct = useDirectRoom()
  const [query, setQuery] = useState<string | null>(null)
  const [anchor, setAnchor] = useState(0)
  const [index, setIndex] = useState(0)
  // Set while `commit` rewrites the document: the resulting transaction would otherwise be read
  // back as "the user is typing `@alice`" and reopen the menu on the text we just inserted.
  const closingRef = useRef(false)

  const items = useMemo(() => {
    if (query === null || !users) return []
    // Revoked
    // users are dropped here too: the row still exists so their history renders, but offering one
    // as a mention target would promise a notification nobody can collect.
    const eligible = users.filter(
      (u) => u.status !== 'revoked' && (!direct || u.id === agent?.id),
    )
    return rankMentions(eligible, query).slice(0, MAX_ITEMS)
  }, [query, users, direct, agent?.id])

  const open = query !== null && items.length > 0

  // Re-read the text before the caret on every transaction. Cheaper than it looks - it is one
  // `textBetween` over the current block, not the document - and it is the only way to catch the
  // caret being MOVED into or out of a half-typed handle, which an `onUpdate`-only hook misses.
  useEffect(() => {
    if (!editor) return
    const sync = () => {
      if (closingRef.current) return
      const found = readQuery(editor)
      if (found === null) {
        setQuery(null)
        return
      }
      setQuery(found.query)
      setAnchor(found.from)
      setIndex(0)
    }
    editor.on('transaction', sync)
    return () => {
      editor.off('transaction', sync)
    }
  }, [editor])

  // Clamp rather than let the highlight dangle past a list that just got shorter as the user typed.
  useEffect(() => {
    setIndex((i) => (items.length === 0 ? 0 : Math.min(i, items.length - 1)))
  }, [items.length])

  const commit = useCallback(
    (chosen?: number): boolean => {
      if (!editor || editor.isDestroyed || !open) return false
      const user = items[chosen ?? index]
      if (!user) return false

      closingRef.current = true
      setQuery(null)
      // Replace `@partial` with the TOKEN plus a trailing space, in one step. The space matters
      // twice over: it is what makes the next word typed an ordinary word rather than more of the
      // handle, and it satisfies the boundary rule the server's parser applies to whatever follows.
      //
      // The node serializes back to `@id`, so `getMarkdown()` is byte-identical to what inserting
      // plain text used to produce - see MentionNode.
      editor
        .chain()
        .focus()
        .insertContentAt({ from: anchor, to: editor.state.selection.$from.pos }, [
          { type: 'mention', attrs: { id: user.id } },
          { type: 'text', text: ' ' },
        ])
        .run()
      // Release on the next tick, after the insertion's own transaction has been observed.
      globalThis.setTimeout(() => {
        closingRef.current = false
      }, 0)
      return true
    },
    [editor, open, items, index, anchor],
  )

  // Publish the imperative handle for the composer's keymap. Written on every render so the
  // closures it hands out always see current state.
  handleRef.current = {
    isOpen: () => open,
    move: (delta: number) =>
      setIndex((i) => (items.length === 0 ? 0 : (i + delta + items.length) % items.length)),
    commit: () => commit(),
    close: () => setQuery(null),
  }

  useEffect(
    () => () => {
      handleRef.current = null
    },
    [handleRef],
  )

  if (!open) return null

  return (
    <div
      // Anchored to the composer's border box, opening UPWARD: the composer sits at the bottom of
      // the room and a downward menu would open off-screen.
      className='absolute bottom-full left-0 z-50 mb-1 w-64 overflow-hidden rounded-lg border border-border bg-bg shadow-lg'
      role='listbox'
      aria-label='Mention a teammate'>
      {items.map((user, i) => (
        <button
          key={user.id}
          type='button'
          role='option'
          aria-selected={i === index}
          className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-body ${
            i === index ? 'bg-muted' : 'hover:bg-muted/60'
          }`}
          // The menu must not steal focus from the editor - a blur would collapse the selection
          // and `commit` would insert at the wrong place.
          onMouseDown={(e) => {
            e.preventDefault()
            commit(i)
          }}
          onMouseEnter={() => setIndex(i)}>
          <Avatar user={user} size='sm' />
          <span className='min-w-0 flex-1 truncate'>{userName(user)}</span>
          <span className='shrink-0 font-mono text-label text-muted-foreground'>@{user.id}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Order the menu, best first, and drop what does not match at all.
 *
 * RANKING, not merely filtering, which is what this used to do (2026-09-03). The old version kept
 * whatever order the users directory came in, so a single letter highlighted whoever happened to
 * come first with that letter ANYWHERE in their name: typing `@a` did not select nova, and Enter
 * picked the wrong human until you had typed enough to narrow the field to one. Reported from real use.
 *
 * The tiers, in the order a typist means them:
 *
 * 0. the id EXACTLY - `@nova` is nova, whatever else contains those letters.
 * 1. the id by prefix - the id IS the handle being typed, so it outranks any name.
 * 2. a name WORD by prefix - `@st` should reach "Alice Strand"; a surname is a word.
 * 3. a name anywhere - the last resort, kept because it is occasionally all you recall.
 *
 * Ties break on the SHORTER id, then alphabetically. Deliberately not fuzzy: a typo-tolerant
 * matcher puts the wrong person one Enter away, and this is a menu whose mistakes notify somebody.
 *
 * Mirrors `rankMentionCandidates` in @silkweave/box-core, which is where the rule is TESTED - web does not
 * depend on core (same reason as useCrmDoc), so this is a mirror, not an import. The phone's
 * `mention_picker.dart` is a third copy in Dart, already prefix-first. Change them together.
 */
function rankMentions(users: readonly User[], query: string): User[] {
  const needle = query.trim().toLowerCase()
  const scored: { tier: number; user: User }[] = []
  for (const user of users) {
    const tier = needle.length === 0 ? 1 : mentionTier(user, needle)
    if (tier === null) continue
    scored.push({ tier, user })
  }
  scored.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.user.id.length !== b.user.id.length) return a.user.id.length - b.user.id.length
    return a.user.id.localeCompare(b.user.id)
  })
  return scored.map((s) => s.user)
}

function mentionTier(user: User, needle: string): number | null {
  const id = user.id.toLowerCase()
  if (id === needle) return 0
  if (id.startsWith(needle)) return 1
  const names = [userName(user), user.nickname].filter((n) => n.length > 0).map((n) => n.toLowerCase())
  if (names.some((n) => n.split(/\s+/).some((word) => word.startsWith(needle)))) return 2
  if (names.some((n) => n.includes(needle))) return 3
  return null
}

/**
 * The half-typed handle immediately before the caret, or null.
 *
 * Mirrors the leading-boundary rule in `mentions.tsx` / core's `parseMentionHandles`: the `@` must
 * start the block or follow whitespace or an opening bracket, so typing an email address does not
 * pop a menu. Code is excluded for the same reason it is excluded from parsing - `@` there is
 * literal.
 */
function readQuery(editor: Editor): { query: string; from: number } | null {
  const { state } = editor
  const selection = state.selection
  if (!selection.empty) return null
  if (editor.isActive('codeBlock') || editor.isActive('code')) return null

  const $from = selection.$from
  const blockStart = $from.start()
  if ($from.pos < blockStart) return null
  const before = state.doc.textBetween(blockStart, $from.pos, '\n', '\0')

  const match = /(?:^|[\s([{'"])@([a-z0-9_-]*)$/i.exec(before)
  if (match === null) return null

  const query = match[1]
  return { query, from: $from.pos - query.length - 1 }
}
