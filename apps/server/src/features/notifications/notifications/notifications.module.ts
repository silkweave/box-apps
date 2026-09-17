import { Module, type OnModuleInit } from '@nestjs/common'
import { CHAT_ALERT_TRANSPORT, registerAlertTransport } from '@silkweave/box-core'
import { NotificationsController, PushWorkerController } from './notifications.controller.js'
import { startNotificationDelivery } from './delivery.js'
import { registerWebPushTransport } from './push.js'
import { registerFcmTransport } from './fcm.js'

/** No provider for the data path: the chat SQLite handle is owned by ChatModule (which closes it),
 *  and the warehouse reads go through the same ephemeral-connection layer everything else uses.
 *  What this module DOES own is the delivery seam - see delivery.ts. */
@Module({
  controllers: [NotificationsController, PushWorkerController],
})
export class NotificationsModule implements OnModuleInit {
  onModuleInit(): void {
    // Idempotent, and a no-op until a transport is registered. Armed here rather than lazily so
    // that "is anything listening?" has one answer for the life of the process.
    startNotificationDelivery()
    // The first real transport (Track 9). False simply means VAPID is unconfigured - push is off
    // and the seam goes back to being a no-op that exists.
    registerWebPushTransport()
    // The second: the mobile app's FCM transport (device_tokens, chat migration 005). False
    // simply means push.*.FCM_SERVICE_ACCOUNT is unconfigured - device push is off.
    registerFcmTransport()
    // And the other direction of the glue: alerts routed `chat:<slug>` land in a chat room.
    registerAlertTransport(CHAT_ALERT_TRANSPORT)
  }
}
