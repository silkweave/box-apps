import { MessageSquare, Plus, SquarePen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Outlet, useNavigate, useParams } from '@tanstack/react-router'
import { NewRoomDialog } from '../components/NewRoomDialog.tsx'
import { NewDirectDialog } from '../components/NewDirectDialog.tsx'
import { Avatar, Button, type NavItem, type Crumb, CenteredNote, AppShell } from '@silkweave/box-ui'
import { roomIcon } from '../lib/chatRoomIcons.ts'
import { chatRoomLabel, chatRoomTitle } from '../lib/chatRoomLabel.ts'
import { useChatRooms } from '../lib/useChatData.ts'
import type { ChatRoom } from '../lib/chatTypes.ts'
import type { User } from '../../../user-types.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { useGroupNav } from '../../../lib/nav.ts'

/**
 * The chat shell: the room list as the sidebar, one room's canvas through the Outlet. Mirrors
 * CrmLayout in shape.
 *
 * The sidebar lists the rooms the principal is a MEMBER of, which is the server's own answer
 * (`chatRooms` reads membership, not the room table) - so this nav is the membership list, and
 * opening a public room you are not in joins it. Unread is the server's COUNT of surviving messages
 * past the member's read pointer, adopted as-is - never a subtraction or a scan here.
 */
/** The other person in a DM, resolved against the directory the SPA already holds - or null while
 *  it is still loading, and for a peer who is no longer in it. */
function directPeer(room: ChatRoom, users: User[] | null): User | null {
  if (room.kind !== 'dm' || room.peer === null) return null
  return users?.find((u) => u.id === room.peer) ?? null
}

export function ChatLayout() {
  const groupNav = useGroupNav('chat')
  const navigate = useNavigate()
  const { room } = useParams({ strict: false }) as { room?: string }
  const { rooms, error, createRoom, openDirect } = useChatRooms()
  const { data: users } = useUsersData()
  const [creating, setCreating] = useState(false)
  const [messaging, setMessaging] = useState(false)

  // Landing on /chat with no room named is not a place anyone wants to be, so fall through to the
  // first room the moment the list resolves. It has to be an effect rather than the route's
  // beforeLoad: which rooms exist is a client-side fetch, so the router cannot know at guard time.
  // `replace` keeps the empty /chat out of history - otherwise Back from the first room lands on a
  // page that immediately forwards here again.
  // Prefer a named channel over a DM: channels are the shared work, and which DM sorts first is
  // an accident of whoever wrote last.
  const firstRoom = (rooms?.find((r) => r.kind !== 'dm') ?? rooms?.[0])?.slug
  useEffect(() => {
    if (!room && firstRoom) void navigate({ to: '/chat/$room', params: { room: firstRoom }, replace: true })
  }, [room, firstRoom, navigate])

  if (error)
    return (
      <CenteredNote>
        Failed to reach the API: {error}
        <br />
        Start the backend: <code>pnpm dev</code>.
      </CenteredNote>
    )
  if (!rooms) return <CenteredNote>Loading…</CenteredNote>

  // TWO strata: the team's channels, then direct messages. There is no third - every user is in
  // every channel, so there is nothing to "browse" into. Channels lead (a product decision, 2026-09-04) - the
  // shared work is there, and a DM list grows with people rather than with topics. Headings are
  // drawn only when both strata are occupied, so a sidebar of nothing but channels renders as it
  // always did.
  //
  // DMs sort by RECENCY, not by slug: a DM's slug is derived (`dm:<a>:<b>`) and alphabetical order
  // over it is meaningless to a human. `headAt` is the room's issued-key guard, which moves on
  // every post, so it is the cheapest honest "last activity" the sidebar already holds.
  const directs = rooms.filter((r) => r.kind === 'dm').sort((a, b) => b.headAt - a.headAt)
  const channels = rooms.filter((r) => r.kind !== 'dm')
  const split = channels.length > 0 && directs.length > 0
  const sectionOf = (r: ChatRoom): string | undefined =>
    !split ? undefined : r.kind === 'dm' ? 'Direct messages' : 'Rooms'
  const navItems: NavItem[] = [...channels, ...directs].map((r) => ({
    id: r.slug,
    // A DM is addressed by person: the derived slug is plumbing and must never reach a human.
    label: chatRoomLabel(r, users),
    // A room's own icon wins; `roomIcon` falls back to `hash`, which is what every room showed
    // before appearance existed. A DM shows the message glyph until the peer's avatar lands here
    // (FEATURES.md).
    icon: r.kind === 'dm' ? MessageSquare : roomIcon(r.icon),
    // A DM is a PERSON, so the row leads with their avatar rather than a glyph - the phone's list
    // has always done this. `leading` wins over `icon` when it resolves; the MessageSquare above
    // stays as the fallback for the window before the user directory loads (and for a peer who is
    // no longer in it), because a row that renders no leading element at all jumps sideways when
    // the names arrive.
    ...(r.kind === 'dm' && directPeer(r, users) !== null
      ? { leading: <Avatar user={directPeer(r, users)!} size='xs' /> }
      : {}),
    section: sectionOf(r),
    // The room you are looking at is being read, so it is never also "unread" - showing both makes
    // the badge flicker on every message arriving in the room already on screen. A room this user
    // has never opened holds no pointer and so carries no badge either.
    count: r.slug === room ? undefined : r.unread || undefined,
  }))

  const crumbs: Crumb[] = [{ label: 'Chat', onClick: room ? () => void navigate({ to: '/chat' }) : undefined }]
  if (room) crumbs.push({ label: chatRoomTitle(rooms.find((r) => r.slug === room), users) || `#${room}` })

  return (
    <AppShell
      items={navItems}
      activeId={room ?? ''}
      onSelect={(slug) => void navigate({ to: '/chat/$room', params: { room: slug } })}
      groupNav={groupNav}
      topbar={{ crumbs }}
      groupAction={
        <>
          <Button variant='ghost' size='icon-xs' aria-label='New direct message' onClick={() => setMessaging(true)}>
            <SquarePen />
          </Button>
          <Button variant='ghost' size='icon-xs' aria-label='New room' onClick={() => setCreating(true)}>
            <Plus />
          </Button>
        </>
      }>
      <Outlet />
      <NewRoomDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={async (input) => {
          const created = await createRoom(input)
          // The creator is the room's first member, so it is already in the sidebar - go straight
          // there rather than leaving them looking at the room they just left.
          void navigate({ to: '/chat/$room', params: { room: created.slug } })
        }}
      />
      <NewDirectDialog
        open={messaging}
        onOpenChange={setMessaging}
        onOpen={async (userId) => {
          // Idempotent server-side (the room id derives from the sorted pair), so picking somebody
          // you already have a DM with simply reopens it rather than creating a second one.
          const dm = await openDirect(userId)
          void navigate({ to: '/chat/$room', params: { room: dm.slug } })
        }}
      />
    </AppShell>
  )
}
