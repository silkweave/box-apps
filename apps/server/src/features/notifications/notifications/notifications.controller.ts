import { Body, Controller, Get, Header, NotFoundException, Param, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common'
import { ApiOkResponse, ApiProperty } from '@nestjs/swagger'
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator'
import { Trpc } from '@silkweave/nestjs'
import { chatStore, listAlerts, readUsers, type Principal } from '@silkweave/box-core'
import { pushVapidConfig } from './push.js'
import { PUSH_SW_SOURCE } from './push-sw.js'
import { AuthGuard } from '../../../auth/auth.guard.js'
import { Public } from '../../../auth/auth.decorators.js'
import type { PrincipalRequest } from '../../../auth/auth.decorators.js'

/**
 * The notification bell: ONE feed, TWO engines.
 *
 * Chat lives in SQLite (`chat.db`) and the alerts spine lives in the DuckDB warehouse. There is no
 * join here and there deliberately never will be - the merge is done in memory, over two bounded
 * reads, because the alternative (a DuckDB `ATTACH` of chat.db on the read path) would put the
 * interactive bell behind the warehouse's single-writer lock, which is exactly the coupling
 * `chat.db` exists to avoid. Both reads are capped at FEED_LIMIT, so "merge in memory" means
 * sorting at most a few dozen rows.
 *
 * Three sources, three different read models, each at the natural grain of its own store:
 *
 * | source        | lives in | "have I seen it?" is                                |
 * |---------------|----------|-----------------------------------------------------|
 * | chat mention  | chat.db  | `mentions.seen_at` - per row, so one can be dismissed |
 * | chat message  | chat.db  | `room_members.last_read_at` - the pointer that already exists |
 * | warehouse alert | data.db | a per-user WATERMARK in chat.db (`notification_reads`) |
 *
 * Three mechanisms looks like drift and is not: a mention is a thing addressed to you personally, a
 * message's read state was already solved by the room pointer (inventing a second one would let the
 * bell and the sidebar disagree about the same message), and an alert row lives in another engine
 * that must not take an interactive write on every bell open. A watermark is one row per user
 * rather than one row per alert per user, and the bell marks everything seen on open anyway.
 *
 * WHY the alert read-state lives in chat.db rather than the warehouse: it is a tiny interactive
 * write on a user gesture, which is precisely the shape DuckDB's ephemeral single-writer design is
 * wrong for. `chat.db` is the instance's store for small, hot, per-user state; it is only called
 * "chat" because chat got there first.
 */

/** How many of each source to read, and the cap on the merged feed. */
const FEED_LIMIT = 30

/** Bodies are chopped for the dropdown - the bell is a pointer to a conversation, not a reader. */
const PREVIEW_CHARS = 180

class NotificationDto {
  @ApiProperty({ description: 'Stable across refetches: `<kind>:<source row id>`' }) id!: string
  @ApiProperty({ enum: ['chat', 'alert'], description: 'Which engine it came from' }) source!: string
  @ApiProperty({ enum: ['mention', 'message', 'alert'], description: 'What it is. `mention` is the one that gets marked out' })
  kind!: string
  @ApiProperty({ description: 'Epoch ms - the single merge sort key across both engines' }) at!: number
  @ApiProperty({ description: 'Unseen by its own source rule (see the class comment)' }) unseen!: boolean
  @ApiProperty({
    description:
      "Room slug (`#general`) for chat in a named room, the sender's name for a chat item in a DM (its slug is the derived `dm:<a>:<b>`), rule/event title for an alert",
  })
  title!: string
  @ApiProperty({ description: 'Truncated body / rendered alert message' }) body!: string
  @ApiProperty({ required: false, nullable: true, description: "Sender's display name at write time" })
  actor!: string | null
  @ApiProperty({ required: false, nullable: true }) actorId!: string | null
  @ApiProperty({ required: false, nullable: true, description: 'Deep-link target for chat items' })
  roomSlug!: string | null
  @ApiProperty({ required: false, nullable: true }) messageId!: string | null
}

class NotificationsDto {
  @ApiProperty() generatedAt!: string
  @ApiProperty({ type: [NotificationDto], description: 'Newest first, both engines merged' })
  items!: NotificationDto[]
  @ApiProperty({ description: 'Unseen mentions. THIS is the number on the bell, with unseenAlerts' })
  unseenMentions!: number
  @ApiProperty({ description: 'Alerts newer than this user watermark' }) unseenAlerts!: number
}

class MarkSeenInputDto {
  @ApiProperty({
    required: false,
    description: 'Dismiss ONE mention by its message id. Omit to mark everything (mentions + alerts) seen',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  messageId?: string
}

class DismissInputDto {
  @ApiProperty({ description: "The bell item id to dismiss (`mention:<id>` / `message:<id>` / `alert:<id>`)" })
  @IsString()
  @MinLength(1)
  itemId!: string
}

class OkResultDto {
  @ApiProperty() ok!: boolean
}

class MarkSeenResultDto {
  @ApiProperty({ description: 'Mention rows stamped' }) mentions!: number
  @ApiProperty({ description: 'Whether the alert watermark was advanced' }) alerts!: boolean
}

class PushConfigDto {
  @ApiProperty({ description: 'False when the VAPID pair is unconfigured - the toggle should not render' })
  enabled!: boolean
  @ApiProperty({ required: false, nullable: true, description: 'VAPID public key (public by construction)' })
  publicKey!: string | null
}

class PushSubscribeInputDto {
  /** The push service URL the browser minted. Opaque; the row's identity. */
  @IsString()
  @MinLength(12)
  @MaxLength(2048)
  endpoint!: string
  @IsString()
  @MinLength(8)
  p256dh!: string
  @IsString()
  @MinLength(8)
  auth!: string
  @IsOptional()
  @IsString()
  @MaxLength(400)
  userAgent?: string
}

class PushSubscribeResultDto {
  @ApiProperty() ok!: boolean
}

class PushUnsubscribeInputDto {
  @IsString()
  @MinLength(12)
  @MaxLength(2048)
  endpoint!: string
}

class PushUnsubscribeResultDto {
  @ApiProperty({ description: 'Whether a row was actually removed (yours, and present)' }) removed!: boolean
}

class DeviceRegisterInputDto {
  /** The FCM registration token the app minted. Opaque; the row's identity. */
  @IsString()
  @MinLength(12)
  @MaxLength(4096)
  token!: string
  @IsString()
  @MaxLength(20)
  platform!: string
}

class DeviceRegisterResultDto {
  @ApiProperty() ok!: boolean
}

class DeviceUnregisterInputDto {
  @IsString()
  @MinLength(12)
  @MaxLength(4096)
  token!: string
}

class DeviceUnregisterResultDto {
  @ApiProperty({ description: 'Whether a row was actually removed (yours, and present)' }) removed!: boolean
}

/** The slice of Express's Response the avatar proxy touches - typed structurally because this
 *  codebase deliberately imports no express types (see main.ts, which uses node's http types). */
interface RawResponse {
  setHeader(name: string, value: string): void
  type(mime: string): void
  send(body: Buffer): void
}

/** Same gate as chat: notifications are personal and there is no anonymous rendering of them. */
function requirePrincipal(req: PrincipalRequest): Principal {
  const principal = req.principal
  if (!principal) throw new UnauthorizedException('notifications require a signed-in principal')
  return principal
}

const preview = (body: string): string =>
  body.length <= PREVIEW_CHARS ? body : `${body.slice(0, PREVIEW_CHARS).trimEnd()}…`

/** A named room is a place (`#general`); a DM is a person, and its slug is nothing a reader would
 *  recognise (Track 14) - so the row is titled by who wrote it. */
const bellTitle = (row: { roomKind: string; roomSlug: string; senderName: string }): string =>
  row.roomKind === 'dm' ? row.senderName : `#${row.roomSlug}`

/**
 * When an alert row became visible to a human, for watermark purposes.
 *
 * The row's own recording time bounds it: whatever the upstream claims happened, the Box could not
 * show it before it wrote it down. Clamping to that keeps a future `event_at` (a skewed upstream
 * clock, an external payload stamped in another timezone) from being permanently unseen against a
 * `Date.now()` watermark, while leaving every ordinary row - where the event precedes the write -
 * exactly as it was.
 *
 * Sorting and display still use `event_at`: when a thing happened and when you could first see it
 * are different questions, and only the second one is about read state.
 */
export function alertSeenKey(eventAtMs: number, createdAt: string): number {
  const recordedMs = Date.parse(createdAt)
  return Number.isNaN(recordedMs) ? eventAtMs : Math.min(eventAtMs, recordedMs)
}

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  /** tRPC query `notificationsList` - the bell's whole payload in one round trip. */
  @Get('list')
  @ApiOkResponse({ type: NotificationsDto })
  @Trpc()
  async list(@Req() req: PrincipalRequest): Promise<NotificationsDto> {
    const principal = requirePrincipal(req)
    const store = chatStore()

    const mentions = store.mentionsFor(principal.id, FEED_LIMIT)
    const messages = store.recentMessagesFor(principal.id, FEED_LIMIT)
    const watermark = store.notificationWatermark(principal.id, 'alert')
    const alerts = await listAlerts(FEED_LIMIT)

    // Dismissal is checked in TWO ways because "clear all" is a watermark and a single dismiss is
    // a tombstone - see ChatStore.clearNotifications for why. Read both up front so the filter
    // below is a pure predicate over already-fetched state.
    const clearedThrough = store.notificationWatermark(principal.id, 'dismiss')
    const dismissed = new Set(store.dismissedNotifications(principal.id))
    const isDismissed = (id: string, at: number): boolean => at <= clearedThrough || dismissed.has(id)

    // Read one extra page's worth so that dismissing items does not leave the dropdown short -
    // the slice back down to FEED_LIMIT happens after filtering.
    const items: NotificationDto[] = []

    for (const m of mentions) {
      if (isDismissed(`mention:${m.messageId}`, m.createdAt)) continue
      items.push({
        id: `mention:${m.messageId}`,
        source: 'chat',
        kind: 'mention',
        at: m.createdAt,
        unseen: m.seenAt === null,
        title: bellTitle(m),
        body: preview(m.body),
        actor: m.senderName,
        actorId: m.senderId,
        roomSlug: m.roomSlug,
        messageId: m.messageId,
      })
    }

    // A message that also mentions you appears ONCE, as the mention - the stronger claim on your
    // attention wins, and a doubled row in a dropdown reads as a bug.
    const mentioned = new Set(mentions.map((m) => m.messageId))
    for (const m of messages) {
      if (mentioned.has(m.messageId)) continue
      if (isDismissed(`message:${m.messageId}`, m.createdAt)) continue
      items.push({
        id: `message:${m.messageId}`,
        source: 'chat',
        kind: 'message',
        at: m.createdAt,
        unseen: m.unread,
        title: bellTitle(m),
        body: preview(m.body),
        actor: m.senderName,
        actorId: m.senderId,
        roomSlug: m.roomSlug,
        messageId: m.messageId,
      })
    }

    let unseenAlerts = 0
    for (const a of alerts) {
      // `created_at` is when the row was recorded; `event_at` is when the thing happened and is
      // nullable. Sort by the event where we have one, exactly like the digest does.
      const at = Date.parse(a.event_at ?? a.created_at)
      if (Number.isNaN(at)) continue
      // But do NOT answer "have I seen this" with the event time: `event_at` comes from an
      // upstream payload and can be in the FUTURE (a skewed clock, or a notifier that stamps an
      // event in another timezone). Both watermarks here are set to `Date.now()`, so a
      // future-stamped row is permanently unseen AND permanently un-clearable - and the bell's
      // mark-on-open then fights the reload forever, flashing the badge. See `alertSeenKey`.
      const seenAt = alertSeenKey(at, a.created_at)
      if (isDismissed(`alert:${a.id}`, seenAt)) continue
      const unseen = seenAt > watermark
      if (unseen) unseenAlerts += 1
      items.push({
        id: `alert:${a.id}`,
        source: 'alert',
        kind: 'alert',
        at,
        unseen,
        title: a.title ?? a.event_kind,
        body: preview(a.message),
        actor: null,
        actorId: null,
        roomSlug: null,
        messageId: null,
      })
    }

    items.sort((x, y) => y.at - x.at)

    return {
      generatedAt: new Date().toISOString(),
      items: items.slice(0, FEED_LIMIT),
      unseenMentions: store.unseenMentionCount(principal.id),
      unseenAlerts,
    }
  }

  /**
   * tRPC mutation `notificationsMarkSeen` - with a `messageId`, dismiss that one mention; without,
   * mark everything seen (the bell's open gesture).
   *
   * Note what this does NOT do: it never touches `room_members.last_read_at`. Marking the bell
   * seen must not silently mark rooms read - the sidebar badge answers "is there anything I have
   * not read", and only opening a room may clear it. Keeping these two pointers independent is why
   * a message's unseen state is READ from the room pointer but never WRITTEN through this path.
   */
  @Post('seen')
  @ApiOkResponse({ type: MarkSeenResultDto })
  @Trpc({ kind: 'mutation' })
  markSeen(@Body() body: MarkSeenInputDto, @Req() req: PrincipalRequest): MarkSeenResultDto {
    const principal = requirePrincipal(req)
    const store = chatStore()

    const mentions = store.markMentionsSeen(principal.id, body.messageId)
    if (body.messageId !== undefined) return { mentions, alerts: false }

    // The watermark is monotonic in the store, so a slow response racing a newer alert can only
    // ever fail to mark something seen - never un-see it.
    store.setNotificationWatermark(principal.id, 'alert', Date.now())
    return { mentions, alerts: true }
  }

  /**
   * tRPC mutation `notificationsDismiss` - throw ONE item out of the bell, whatever stratum it came
   * from. `itemId` is the bell's own id, which is the only key that names a chat row and a
   * warehouse row in the same breath.
   *
   * Dismissing also marks a mention SEEN. Not because they are the same state - they are not, and
   * `notification_dismissals` exists precisely because they are not - but because the badge counts
   * unseen mentions, and a mention you deliberately threw away must not keep nagging from a list it
   * is no longer in. The reverse does NOT hold: marking seen never dismisses.
   */
  @Post('dismiss')
  @ApiOkResponse({ type: OkResultDto })
  @Trpc({ kind: 'mutation' })
  dismiss(@Body() body: DismissInputDto, @Req() req: PrincipalRequest): OkResultDto {
    const principal = requirePrincipal(req)
    const store = chatStore()

    store.dismissNotification(principal.id, body.itemId)
    const mention = /^mention:(.+)$/.exec(body.itemId)
    if (mention !== null) store.markMentionsSeen(principal.id, mention[1])
    return { ok: true }
  }

  /**
   * tRPC mutation `notificationsClear` - empty the bell.
   *
   * One watermark write, not N tombstones, so it also covers items past the feed limit that this
   * client never saw - "clear all" has to mean all, not "all thirty I happened to be showing".
   * Everything is marked seen in the same breath so the badge cannot survive its own list.
   *
   * Still nothing here touches `room_members.last_read_at`: clearing the bell is not reading your
   * rooms, and the sidebar's badges must be untouched by it.
   */
  @Post('clear')
  @ApiOkResponse({ type: OkResultDto })
  @Trpc({ kind: 'mutation' })
  clear(@Req() req: PrincipalRequest): OkResultDto {
    const principal = requirePrincipal(req)
    const store = chatStore()
    const now = Date.now()

    store.clearNotifications(principal.id, now)
    store.markMentionsSeen(principal.id)
    store.setNotificationWatermark(principal.id, 'alert', now)
    return { ok: true }
  }
  /**
   * tRPC query `notificationsPushConfig` - what the SPA needs before it can subscribe (chat
   * Track 9). Follows the agent/config precedent: answers without leaking anything, since the
   * VAPID public key is public by construction. `enabled: false` means the pair is unconfigured
   * and every push surface should simply not render.
   */
  @Get('push/config')
  @ApiOkResponse({ type: PushConfigDto })
  @Trpc()
  pushConfig(): PushConfigDto {
    const vapid = pushVapidConfig()
    return { enabled: vapid !== null, publicKey: vapid?.publicKey ?? null }
  }

  /**
   * tRPC mutation `notificationsPushSubscribe` - store this browser's Web Push subscription.
   * Principal-stamped like every other chat write: the subscription belongs to the authenticated
   * user, the client never supplies a user id. Idempotent on the endpoint (the latest claim wins,
   * so a shared machine re-signed-in as someone else re-homes the subscription rather than
   * duplicating it).
   */
  @Post('push/subscribe')
  @ApiOkResponse({ type: PushSubscribeResultDto })
  @Trpc({ kind: 'mutation' })
  pushSubscribe(@Body() body: PushSubscribeInputDto, @Req() req: PrincipalRequest): PushSubscribeResultDto {
    const principal = requirePrincipal(req)
    chatStore().pushSubscribe(principal.id, {
      endpoint: body.endpoint,
      p256dh: body.p256dh,
      auth: body.auth,
      userAgent: body.userAgent ?? null,
    })
    return { ok: true }
  }

  /**
   * tRPC mutation `notificationsPushUnsubscribe` - the app-side revoke (the browser side is
   * `PushSubscription.unsubscribe()`, done by the client first). Scoped to the caller's own rows.
   */
  @Post('push/unsubscribe')
  @ApiOkResponse({ type: PushUnsubscribeResultDto })
  @Trpc({ kind: 'mutation' })
  pushUnsubscribe(@Body() body: PushUnsubscribeInputDto, @Req() req: PrincipalRequest): PushUnsubscribeResultDto {
    const principal = requirePrincipal(req)
    return { removed: chatStore().pushUnsubscribe(principal.id, body.endpoint) }
  }

  /**
   * tRPC mutation `notificationsDeviceRegister` - store the mobile app's FCM device token (the
   * native sibling of pushSubscribe; device_tokens is the FCM transport's own table). Principal-
   * stamped, idempotent on the token: a reinstall or a device re-signed-in as someone else
   * re-homes the row rather than duplicating it.
   */
  @Post('device/register')
  @ApiOkResponse({ type: DeviceRegisterResultDto })
  @Trpc({ kind: 'mutation' })
  deviceRegister(@Body() body: DeviceRegisterInputDto, @Req() req: PrincipalRequest): DeviceRegisterResultDto {
    const principal = requirePrincipal(req)
    chatStore().deviceTokenRegister(principal.id, body.token, body.platform)
    return { ok: true }
  }

  /**
   * tRPC mutation `notificationsDeviceUnregister` - the app-side revoke (sign-out). Scoped to
   * the caller's own rows, like pushUnsubscribe.
   */
  @Post('device/unregister')
  @ApiOkResponse({ type: DeviceUnregisterResultDto })
  @Trpc({ kind: 'mutation' })
  deviceUnregister(@Body() body: DeviceUnregisterInputDto, @Req() req: PrincipalRequest): DeviceUnregisterResultDto {
    const principal = requirePrincipal(req)
    return { removed: chatStore().deviceTokenUnregister(principal.id, body.token) }
  }

}

/**
 * Serves the service worker at /api/push/sw.js (chat Track 9). A separate, UNGUARDED controller:
 * the worker source contains no secrets, and the browser's registration fetch must never bounce
 * off auth. WHY an /api route at all: in dev every non-reserved route is proxied to Vite, so a
 * reserved path is the only one Nest serves identically in both topologies. Its natural scope
 * would be /api/push/ - the `Service-Worker-Allowed: /` header is what lets the SPA register it
 * at scope '/'. no-cache so a changed worker propagates on the browser's next update check.
 */
@Controller('push')
export class PushWorkerController {
  @Public() // no secrets in the worker source, and a registration fetch must never bounce off auth
  @Get('sw.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @Header('Service-Worker-Allowed', '/')
  @Header('Cache-Control', 'no-cache')
  worker(): string {
    return PUSH_SW_SOURCE
  }

  /**
   * The notification avatar, by user id - fetched by the SW (credentialed, so this stays guarded)
   * and rounded client-side before display. A PROXY on purpose: data-URI avatars cannot ride the
   * ~4KB push payload, CDN avatars may not send CORS headers (an SW canvas needs readable pixels),
   * and the image value never comes from the client, so there is no SSRF surface.
   */
  @Get('avatar/:id')
  @UseGuards(AuthGuard)
  async avatar(@Param('id') id: string, @Res() res: RawResponse): Promise<void> {
    const user = (await readUsers()).find((u) => u.id === id)
    const image = user?.image ?? null
    if (image === null) throw new NotFoundException(`no avatar for ${id}`)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    const dataUri = /^data:([^;,]+);base64,(.*)$/.exec(image)
    if (dataUri) {
      res.type(dataUri[1]!)
      res.send(Buffer.from(dataUri[2]!, 'base64'))
      return
    }
    const upstream = await fetch(image)
    if (!upstream.ok) throw new NotFoundException(`avatar for ${id} unreachable`)
    res.type(upstream.headers.get('content-type') ?? 'image/png')
    res.send(Buffer.from(await upstream.arrayBuffer()))
  }
}
