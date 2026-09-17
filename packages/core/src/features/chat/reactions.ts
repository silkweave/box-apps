// The reaction palette and its one rule (chat Track 10). Pure: no store, no clock, no network.
//
// Here rather than in the store because both ends need it - the store REFUSES anything outside the
// palette, and the clients render exactly this list in exactly this order. A palette that lived in
// the web bundle would drift from what the server accepts, and the first symptom would be a picker
// offering an emoji the server rejects.

import type { ChatReactionGroup } from './types.js'

/**
 * The whole reaction vocabulary. FIXED, and free text is refused.
 *
 * The spec's reason, stated once: an `emoji` column that accepts free text is really a string
 * column, and the first person to react with a paragraph proves it. Beyond storage, an open set
 * makes the grouped pill row unbounded - a room of six can put six different skin-tone variants of
 * the same thumb on one message, and the message then renders as a wall of ones.
 *
 * Twelve, chosen to cover the gestures a working channel actually makes: acknowledgement, thanks,
 * amusement, celebration, attention, and "this is done". Deliberately no thumbs-down: the room has
 * words for disagreement, and a one-click anonymous-ish downvote on a colleague's message is a
 * different product than this one.
 *
 * ORDER IS THE UI ORDER. The first six are what a hover bar shows without opening anything.
 */
export const CHAT_REACTION_EMOJI = [
  '👍',
  '🎉',
  '❤️',
  '😂',
  '👀',
  '✅',
  '🚀',
  '🔥',
  '🙏',
  '💯',
  '😮',
  '😢'
] as const

export type ChatReactionEmoji = (typeof CHAT_REACTION_EMOJI)[number]

/** How many of the palette a compact hover bar offers before the rest need a picker. */
export const CHAT_REACTION_QUICK_COUNT = 6

const PALETTE = new Set<string>(CHAT_REACTION_EMOJI)

/** Is this one of the twelve? The store's gate, and the clients' assertion against their own list. */
export function isReactionEmoji(emoji: string): emoji is ChatReactionEmoji {
  return PALETTE.has(emoji)
}

/**
 * Group raw reaction rows into what a message carries, palette order first.
 *
 * Palette order rather than "most reacted first" or "first reacted first": a pill row that
 * REORDERS as counts change moves the target out from under a finger that is already on its way
 * down, and mis-clicking a reaction is a mistake that shows up in somebody else's channel. A
 * stable row is worth more than a ranked one here.
 *
 * Rows must be ordered oldest-first by the caller; `users` preserves that, so "who reacted first"
 * survives into the tooltip.
 */
export function groupReactions(
  rows: readonly { userId: string; emoji: string }[]
): ChatReactionGroup[] {
  const byEmoji = new Map<string, string[]>()
  for (const row of rows) {
    const users = byEmoji.get(row.emoji)
    if (users === undefined) byEmoji.set(row.emoji, [row.userId])
    else users.push(row.userId)
  }
  const groups: ChatReactionGroup[] = []
  for (const emoji of CHAT_REACTION_EMOJI) {
    const users = byEmoji.get(emoji)
    if (users === undefined) continue
    groups.push({ emoji, users, count: users.length })
    byEmoji.delete(emoji)
  }
  // Anything left is an emoji the palette has since DROPPED, with rows already in the database.
  // Rendered rather than hidden: the row is a fact somebody created, and silently vanishing
  // reactions on a deploy is worse than one pill in an unexpected position. Appended, so the
  // palette's own order still holds for everything a client can still add.
  for (const [emoji, users] of byEmoji) groups.push({ emoji, users, count: users.length })
  return groups
}
