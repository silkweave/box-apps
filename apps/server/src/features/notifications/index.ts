import { defineServerFeature } from '../../feature.js'
import { NotificationsModule } from './notifications/notifications.module.js'

/**
 * The bell, web + FCM push, alert delivery into chat. Glue over chat and alerts.
 *
 * No `env`. Push is configured like every other channel secret, in
 * `<BOX_DATA_DIR>/config/credentials.json` under `push.*`: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`
 * and `VAPID_SUBJECT` (all three, or web push stays off - see notifications/push.ts). This manifest
 * declared `PUSH_VAPID_PUBLIC_KEY` / `PUSH_VAPID_PRIVATE_KEY` until 2026-09-13; no code has ever
 * read either name, so the boot-time report was pointing operators at the wrong place.
 */
export default defineServerFeature({
  id: 'notifications',
  module: NotificationsModule,
})
