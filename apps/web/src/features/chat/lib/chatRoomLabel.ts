import type { ChatRoom } from './chatTypes.ts'
import { userName, type User } from '../../../user-types.ts'

/**
 * What a room is CALLED on screen. One helper because a room's label is never simply its slug:
 * a DM has two names - the derived slug the server addresses it by (`dm:alice:bob`) and the person
 * it is with - and since migration 014 a named room may carry a free-form DISPLAY name that the
 * slug grammar could not hold ("Dev Team"). Every surface that shows a room (sidebar, breadcrumb,
 * header, composer placeholder, notification) goes through here. A slug leaking into the UI where
 * a name exists is the bug this exists to prevent.
 *
 * Falls back to the peer's raw id when the directory has not loaded (or the peer was deleted): a
 * conversation with `bob` reads better than one with `dm:alice:bob` even before the names arrive.
 */
export function chatRoomLabel(room: ChatRoom | null | undefined, users: User[] | null): string {
  if (!room) return ''
  if (room.kind !== 'dm') return room.name ?? room.slug
  const peer = room.peer
  if (peer === null) return room.slug
  const found = users?.find((u) => u.id === peer)
  return found ? userName(found) : peer
}

/**
 * The same label with the channel sigil a named room carries in prose: `#deploys`.
 *
 * The sigil is worn only by a room being shown BY ITS ADDRESS. A room with a display name is shown
 * by that name and drops the `#`, because the hash announces "this is the thing you type" and a
 * display name is not - `#Dev Team` invites somebody to type an address that does not exist. A DM
 * is a person and never wears one either.
 */
export function chatRoomTitle(room: ChatRoom | null | undefined, users: User[] | null): string {
  if (!room) return ''
  if (room.kind === 'dm') return chatRoomLabel(room, users)
  return room.name ?? `#${room.slug}`
}

/**
 * Derive an address from a display name, the way the create dialog does while you type:
 * "Q4 Planning!" -> "q4-planning". Lowercased, every run of anything outside `[a-z0-9]` collapsed
 * to a single dash, dashes trimmed off both ends, and capped at the server's 64.
 *
 * It can return '' (a name of nothing but punctuation), which the caller treats as "no suggestion"
 * rather than as an address - the slug field is still the one the server validates.
 */
export function roomSlugFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}
