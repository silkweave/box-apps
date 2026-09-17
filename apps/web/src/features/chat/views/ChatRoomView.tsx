import { Settings2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { Composer } from '../components/ComposerLazy.tsx'
import { Button, CenteredNote } from '@silkweave/box-ui'
import { AgentSessionDialog } from '../components/AgentActivity.tsx'
import { MessageList } from '../components/MessageList.tsx'
import { RoomSettingsDialog } from '../components/RoomSettingsDialog.tsx'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'
import { useAuth } from '../../../lib/useAuth.tsx'
import { chatRoomLabel, chatRoomTitle } from '../lib/chatRoomLabel.ts'
import { DirectRoomProvider } from '../components/DirectRoomContext.tsx'
import { useChatRoom } from '../lib/useChatData.ts'
import { useUsersData } from '../../../lib/useUsersData.ts'

/**
 * One room. The column is height-bounded rather than flowing, so the message list owns the only
 * scroll on the page and the composer stays pinned - AppShell's <main> would otherwise scroll the
 * composer off the bottom along with the history.
 */
export function ChatRoomView() {
  const { room } = useParams({ strict: false }) as { room?: string }
  const navigate = useNavigate()
  const { principal } = useAuth()
  // Who "my messages" means. The principal is authoritative (chat writes are always stamped with
  // it server-side); the active-user picker is the transition-mode fallback, and the server
  // refuses anything the affordance gets wrong anyway.
  const currentUserId = principal?.id ?? getActiveUserId()
  const { data: users } = useUsersData()
  const {
    messages,
    activity,
    unreadAfter,
    nextCursor,
    loadingMore,
    loadOlder,
    send,
    editMessage,
    deleteMessage,
    react,
    decideApproval,
    threads,
    expandedThreads,
    loadingThreads,
    toggleThread,
    replyInThread,
    topic,
    loading,
    error,
    updateRoom,
    deleteRoom,
    room: summary,
  } = useChatRoom(room ?? null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Switching rooms with the dialog open would leave it editing the room you just left.
  useEffect(() => setSettingsOpen(false), [room])
  /**
   * The thread the composer is aimed at, or null for the room. ONE composer serves both - it is
   * retargeted by a banner above the input rather than by mounting a second editor down inside the
   * thread. Ported from the iOS app, where the argument is loudest (two focusable composers on a
   * phone means the wrong one has focus half the time), but it holds here too: a second TipTap
   * instance is a second draft in a place that can scroll out of sight.
   *
   * Per ROOM-OPEN state: switching rooms must not carry a target into a thread that is not there.
   */
  const [replyingTo, setReplyingTo] = useState<{ rootId: string; senderName: string } | null>(null)
  useEffect(() => setReplyingTo(null), [room])
  // The target has to survive being deleted out from under the draft: a cascading delete takes the
  // root, and a composer still pointing at it would post into a thread that no longer exists.
  useEffect(() => {
    if (replyingTo !== null && !messages.some((m) => m.id === replyingTo.rootId)) setReplyingTo(null)
  }, [messages, replyingTo])

  /** Route the one composer: the room, or the thread it is currently aimed at. */
  const onSend = useCallback(
    async (body: string, attachmentIds: string[]): Promise<void> => {
      if (replyingTo === null) {
        await send(body, attachmentIds)
        return
      }
      await replyInThread(replyingTo.rootId, body, attachmentIds)
      // The target deliberately SURVIVES a successful reply - you almost always write two, and
      // being dropped back to the room between them is how the second one lands in the timeline.
    },
    [replyingTo, send, replyInThread],
  )
  /** The agent session whose transcript is open, or null. Held HERE rather than in the activity
   *  line so that the turn finishing (which unmounts the line) does not close it mid-read. */
  const [sessionView, setSessionView] = useState<string | null>(null)

  const isDirect = summary?.kind === 'dm'
  const peerLabel = chatRoomLabel(summary, users)
  // What this room is CALLED - the display name if it has one, `#slug` otherwise. Never the raw
  // slug: a room called "Dev Team" must not say "Message #dev-team" at the bottom of its own page.
  const roomTitle = chatRoomTitle(summary, users) || `#${room ?? ''}`

  if (!room) return <CenteredNote>Pick a room to start reading.</CenteredNote>
  if (error) return <CenteredNote>{error}</CenteredNote>

  return (
    // The provider wraps the whole room, not just the composer: the edit composer is mounted from
    // inside MessageList, and it must offer the same mention set as the one at the bottom.
    <DirectRoomProvider value={isDirect}>
      <div className='flex h-full min-h-0 flex-col'>
        <header className='flex h-9 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-4'>
          {/* A DM has no topic and never will (the server refuses the patch), so the header carries
              the person instead - the derived `dm:<a>:<b>` slug is plumbing and never shown. */}
          <p className='truncate text-body-sm text-muted-foreground'>{isDirect ? peerLabel : topic}</p>
          {/* A DM is not a channel: its address is derived from the pair and it has no name, topic
              or icon to change, so the server refuses every patch and the affordance is simply not
              offered. Anyone may rename, re-icon and even delete a CHANNEL; there is no role gate
              (2026-09-06), because the gate that matters is the one that keeps a MODEL out. */}
          {isDirect ? null : (
            <Button
              variant='ghost'
              size='icon-xs'
              aria-label='Room settings'
              className='ml-auto shrink-0'
              onClick={() => setSettingsOpen(true)}>
              <Settings2 />
            </Button>
          )}
        </header>

        {loading ? (
          <CenteredNote>Loading…</CenteredNote>
        ) : (
          <MessageList
            messages={messages}
            unreadAfter={unreadAfter}
            nextCursor={nextCursor}
            loadingMore={loadingMore}
            onLoadMore={loadOlder}
            activity={activity}
            onViewSession={setSessionView}
            currentUserId={currentUserId}
            onEdit={editMessage}
            onDelete={deleteMessage}
            onReact={react}
            onDecide={decideApproval}
            threads={threads}
            expandedThreads={expandedThreads}
            loadingThreads={loadingThreads}
            onToggleThread={toggleThread}
            replyingTo={replyingTo}
            onReplyTo={setReplyingTo}
          />
        )}

        <Composer
          placeholder={
            replyingTo === null
              ? isDirect
                ? `Message ${peerLabel}`
                : `Message ${roomTitle}`
              : `Reply to ${replyingTo.senderName}`
          }
          disabled={loading}
          onSend={onSend}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
        />
        <AgentSessionDialog sessionId={sessionView} onClose={() => setSessionView(null)} />
        {summary !== null && !isDirect && (
          <RoomSettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            room={summary}
            onSave={async (patch) => {
              const updated = await updateRoom(patch)
              // A rename moved the ADDRESS: this route still names the old slug, and every read it
              // makes from here on would 404. `replace`, because the old slug is not a place to go
              // back to - it no longer resolves.
              if (updated.slug !== room) {
                void navigate({ to: '/chat/$room', params: { room: updated.slug }, replace: true })
              }
              return updated
            }}
            onDelete={async (confirmSlug) => {
              const result = await deleteRoom(confirmSlug)
              // The room is gone; the layout picks the first room that is left. Only on a real
              // delete - a held `pending` leaves the room exactly where it was.
              if (result.status === 'deleted') void navigate({ to: '/chat', replace: true })
              return result
            }}
          />
        )}
      </div>
    </DirectRoomProvider>
  )
}
