// The notification bell's data layer. ONE store, fed by two engines server-side (chat.db mentions
// and messages, the DuckDB alerts spine) and kept live by two client signals: the chat feed, which
// this module listens to WITHOUT opening a second subscription, and the changes bus, which is how
// a warehouse-side alert row announces itself.

import { useCallback } from 'react'
import { createDataStore } from '../../../lib/dataStore.ts'
import { registerStoreReloads } from '../../../lib/changeFeed.ts'
import { subscribeChatFrames } from '../../chat/lib/useChatData.ts'
import { trpc } from '../../../lib/trpc.ts'

/** One row in the dropdown. Mirrors NotificationDto in the server's notifications controller -
 *  hand-mirrored for the same reason chatTypes.ts is: the generated router flattens nested DTO
 *  arrays to `unknown[]`. */
export interface NotificationItem {
  id: string
  source: 'chat' | 'alert'
  kind: 'mention' | 'message' | 'alert'
  /** Epoch ms. The merge sort key - both engines are normalized onto it server-side. */
  at: number
  unseen: boolean
  title: string
  body: string
  actor: string | null
  actorId: string | null
  roomSlug: string | null
  messageId: string | null
}

export interface NotificationsPayload {
  generatedAt: string
  items: NotificationItem[]
  unseenMentions: number
  unseenAlerts: number
}

// The wire boundary, exactly as useChatData draws it: cast once, here, so no `as` leaks into the
// components.
const wire = {
  list: (): Promise<NotificationsPayload> =>
    trpc.notificationsList.query({}).then((d) => d as unknown as NotificationsPayload),
  markSeen: (messageId?: string): Promise<void> =>
    trpc.notificationsMarkSeen.mutate(messageId === undefined ? {} : { messageId }).then(() => undefined),
  dismiss: (itemId: string): Promise<void> => trpc.notificationsDismiss.mutate({ itemId }).then(() => undefined),
  clear: (): Promise<void> => trpc.notificationsClear.mutate({}).then(() => undefined),
}

const store = createDataStore<NotificationsPayload>(() => wire.list())

// Alerts are warehouse rows, and the warehouse DOES emit table:* invalidation on write - so the
// alert half of this feed refreshes the ordinary way. The chat half cannot use this bus (chat.db
// writes emit nothing on it, by design) and is handled by the frame listener below.
registerStoreReloads(['table:alerts'], store)

export const reloadNotifications = (): Promise<NotificationsPayload> => store.reload()

/**
 * Keep the bell live off the SHARED chat feed.
 *
 * Registered at module scope, once, rather than from the bell component: the badge has to be
 * correct the moment the dropdown is opened, which means the store must have been tracking while
 * it was closed. Only three frame types can change this feed, and all are cheap to react to:
 *
 * - `mention.created` - routed to this principal alone, so it always concerns us.
 * - `message.created` - only matters for a room we are a MEMBER of, but the frame does not carry
 *   membership, and asking the rooms store here would couple the two caches. A refetch is one
 *   small query; chat traffic at this instance's volume does not justify anything cleverer.
 * - `message.deleted` - a HARD delete takes the message's mention rows and its place in the
 *   recent-messages stratum with it, so an item in the dropdown may just have stopped existing.
 *   Deletes are rare; a refetch per delete costs nothing worth saving.
 *
 * Everything else (edits, read pointers, room lifecycle) is deliberately ignored: none of them
 * creates or removes a notification, and reacting would refetch on every keystroke-adjacent
 * ephemeral in the app.
 */
let armed = false
export function startNotifications(): void {
  if (armed) return
  armed = true
  subscribeChatFrames((frame) => {
    if (frame.type !== 'mention.created' && frame.type !== 'message.created' && frame.type !== 'message.deleted') return
    void store.reload().catch(() => undefined)
  })
}

export interface NotificationsHandle {
  data: NotificationsPayload | null
  error: string | null
  /** The number on the bell: things ADDRESSED to you (mentions) plus alerts. Deliberately NOT the
   *  unread message count - the sidebar already owns that, and a bell that duplicates it just
   *  makes two badges disagree while both are technically right. */
  badge: number
  /** Mark everything seen. The bell's open gesture. Resolves with the badge AFTER the server has
   *  reconciled - a caller needs that to tell "it worked" from "the server handed it straight
   *  back", which is the difference between acking again and looping forever. */
  markAllSeen: () => Promise<number>
  /** Throw one item out of the bell - any stratum, keyed by its bell id. */
  dismiss: (itemId: string) => Promise<void>
  /** Empty the bell. */
  clearAll: () => Promise<void>
}

export function useNotifications(enabled = true): NotificationsHandle {
  const { data, error } = store.useData(enabled)

  const markAllSeen = useCallback(async (): Promise<number> => {
    // Optimistic: the badge must fall the instant the dropdown opens, or it reads as broken while
    // the round trip is in flight. `unseen` is cleared on the rows too so the "new" marks clear
    // with it, then the reload reconciles against what the server actually stamped.
    store.set((cur) => ({
      ...cur,
      unseenMentions: 0,
      unseenAlerts: 0,
      items: cur.items.map((i) => (i.kind === 'message' ? i : { ...i, unseen: false })),
    }))
    await wire.markSeen()
    const settled = await store.reload()
    return settled.unseenMentions + settled.unseenAlerts
  }, [])

  const dismiss = useCallback(async (itemId: string): Promise<void> => {
    // Remove the row immediately - a dismiss that waits for a round trip before the item leaves
    // reads as a dead button. The reload reconciles, and a failed call simply puts it back.
    store.set((cur) => {
      const going = cur.items.find((i) => i.id === itemId)
      // Only an item that was still UNSEEN was contributing to the badge, and only mentions and
      // alerts contribute at all (a message never does - the sidebar owns that count).
      const wasCounted = going?.unseen === true
      return {
        ...cur,
        unseenMentions: cur.unseenMentions - (wasCounted && going?.kind === 'mention' ? 1 : 0),
        unseenAlerts: cur.unseenAlerts - (wasCounted && going?.kind === 'alert' ? 1 : 0),
        items: cur.items.filter((i) => i.id !== itemId),
      }
    })
    await wire.dismiss(itemId)
    await store.reload()
  }, [])

  const clearAll = useCallback(async (): Promise<void> => {
    store.set((cur) => ({ ...cur, items: [], unseenMentions: 0, unseenAlerts: 0 }))
    await wire.clear()
    await store.reload()
  }, [])

  return {
    data,
    error,
    badge: (data?.unseenMentions ?? 0) + (data?.unseenAlerts ?? 0),
    markAllSeen,
    dismiss,
    clearAll,
  }
}
