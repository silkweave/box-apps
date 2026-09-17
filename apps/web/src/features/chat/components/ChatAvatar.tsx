import { Avatar } from '@silkweave/box-ui'
import type { User } from '../../../user-types.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'

/**
 * The message-gutter avatar. A message carries `senderName` as a WRITE-TIME SNAPSHOT (see
 * `packages/core/src/chat/migrations.ts`) so history stays honest across renames, but the avatar is
 * chrome rather than history: resolving the sender against the live users directory is what gets the
 * real profile image and the same tint the rest of the app gives that person.
 *
 * When the sender does not resolve (left the team, or an id that never was one) we fall back to a
 * synthetic user built from the snapshot, so an unknown sender still renders as initials rather than
 * a hole in the layout.
 */
export function ChatAvatar({
  senderId,
  senderName,
  size = 'md',
}: {
  senderId: string
  senderName: string
  /** `xs` is the collapsed-thread participant cluster (three avatars on one text line); `sm` is a
   *  reply inside a thread, where a full-size avatar makes a sub-item look like a new topic. */
  size?: 'xs' | 'sm' | 'md'
}) {
  const { data: users } = useUsersData()
  const known = users?.find((u) => u.id === senderId)
  return (
    <Avatar
      user={known ?? syntheticUser(senderId, senderName)}
      size={size}
      className={size === 'xs' ? 'ring-1 ring-background' : undefined}
    />
  )
}

/** A throwaway User carrying just enough for Avatar's initials + tint (which keys off the id, so an
 *  unresolved sender keeps a stable colour). */
function syntheticUser(id: string, name: string): User {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return {
    id,
    first_name: parts[0] ?? '',
    last_name: parts.length > 1 ? (parts.at(-1) ?? '') : '',
    nickname: name.trim() || id,
    email: null,
    image: null,
    color: null,
    status: 'active',
    channels: {},
    has_token: false,
    sort: 0,
    created_at: '',
    updated_at: '',
  }
}
