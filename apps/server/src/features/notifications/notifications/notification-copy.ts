// The words a nudge wears, per kind - shared by the transports and owned by nobody else.
//
// WHY a file of its own rather than a line in each transport: web push and FCM print the same
// title, and the day the copy for one kind changed in push.ts and not in fcm.ts, phone and browser
// would start disagreeing about what happened. WHY not a field on `NotificationDelivery`: the seam
// is transport-agnostic on purpose (delivery.ts's class comment), and a title IS transport - a Lark
// card would want different words entirely. So: pure functions of the delivery, called by each
// transport, living beside them.

import type { NotificationDelivery } from './delivery.js'

/**
 * The headline. A mention names the room because the room is where you go to answer it. A DM
 * (chat Track 14) names only the person: its slug is the derived `dm:<a>:<b>`, which is not a
 * place anyone recognises, and "Dan" over a preview is exactly what every messaging app shows.
 */
export function notificationTitle(delivery: NotificationDelivery): string {
  if (delivery.kind === 'dm') return delivery.actor
  return delivery.roomSlug ? `${delivery.actor} mentioned you in #${delivery.roomSlug}` : `${delivery.actor} mentioned you`
}

/**
 * The collapse key: two nudges with the same tag REPLACE each other on the device rather than
 * stacking. Per room and per kind, so a burst in one DM is one notification, and a DM from Dan
 * never swallows a mention from Dan in #general.
 */
export function notificationTag(delivery: NotificationDelivery): string {
  return `${delivery.kind}:${delivery.roomSlug ?? 'chat'}`
}
