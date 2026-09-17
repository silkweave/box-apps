import { BOX_BRAND } from '@silkweave/box-core'

// The service worker source, served by Nest at /api/push/sw.js (see PushWorkerController).
//
// WHY a string in a .ts file rather than a static asset: the server build (swc) does not copy
// assets, and in dev EVERY non-reserved route is proxied to Vite - so the one place a SW can be
// served identically in both topologies is a reserved /api route. Its default scope would then be
// /api/push/, which covers nothing; the `Service-Worker-Allowed: /` response header is what lets
// the SPA register it with scope '/'.
//
// It handles two events, per the Track 9 spec: `push` renders the notification (unless the user
// is focused on that very room), `notificationclick` routes - the default click and the "Open"
// action focus a tab or open the app deep-linked to /chat/<slug>; "Mark read" calls the bell's
// own seen route (credentialed same-origin fetch - the receiving user is signed in) and shows
// nothing.

export const PUSH_SW_SOURCE = `'use strict'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

/**
 * The sender's avatar, styled like the app's: circular crop with a soft ring. Fetched from the
 * guarded same-origin proxy (cookies ride along) so the canvas stays readable - a cross-origin
 * CDN fetch without CORS would taint it. Returns a data URL, or null for the brand-icon fallback.
 */
async function roundedAvatar(actorId) {
  if (!actorId) return null
  try {
    const resp = await fetch('/api/push/avatar/' + encodeURIComponent(actorId), { credentials: 'include' })
    if (!resp.ok) return null
    const size = 192
    const bitmap = await createImageBitmap(await resp.blob())
    const canvas = new OffscreenCanvas(size, size)
    const ctx = canvas.getContext('2d')
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2)
    ctx.closePath()
    ctx.save()
    ctx.clip()
    ctx.drawImage(bitmap, 0, 0, size, size)
    ctx.restore()
    // The ring, on the same path: half the stroke falls outside the clip circle, reading as a
    // clean border like the app's Avatar chip.
    ctx.lineWidth = 6
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.stroke()
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

self.addEventListener('push', (event) => {
  if (!event.data) return
  let data
  try { data = event.data.json() } catch { return }
  event.waitUntil((async () => {
    // Never push to the room you are looking at: a notification duplicating a message rendering
    // two inches away is how people turn notifications off. "Looking at" = a FOCUSED window whose
    // route is this room.
    if (data.roomSlug) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // Path, not hash: the SPA moved to browser history on 2026-09-14. Whole segment, so a window
      // on /chat/general-2 does not swallow a push for general.
      const path = '/chat/' + data.roomSlug
      const onRoom = (w) => { const p = new URL(w.url).pathname; return p === path || p.indexOf(path + '/') === 0 }
      if (wins.some((w) => w.focused && onRoom(w))) return
    }
    const avatar = await roundedAvatar(data.actorId)
    await self.registration.showNotification(data.title || ${JSON.stringify(BOX_BRAND.name)}, {
      body: data.body || '',
      // One notification per mention, collapsed by room: same tag replaces, never stacks.
      tag: data.tag || 'box-chat',
      data: { url: data.url || '/', messageId: data.messageId || null },
      timestamp: data.at || Date.now(),
      // Rounded sender avatar, else the configured brand mark. Relative paths resolve against the SW's
      // own URL (/api/push/), so anchor explicitly to the origin.
      icon: avatar || new URL(${JSON.stringify(BOX_BRAND.icon192)}, self.location.origin).href,
      // macOS shows these behind hover → the chevron ("Options"). "Mark read" clears the bell row
      // without opening anything.
      actions: [
        { action: 'open', title: 'Open' },
        { action: 'mark-read', title: 'Mark read' }
      ]
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const info = event.notification.data || {}
  event.waitUntil((async () => {
    if (event.action === 'mark-read') {
      // The bell's own seen route, scoped to this mention. Credentialed: the receiving user's
      // session cookie rides the same-origin fetch; the CSRF header is the same one the SPA sends.
      if (info.messageId) {
        await fetch('/api/notifications/seen', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-box-csrf': '1' },
          body: JSON.stringify({ messageId: info.messageId })
        }).catch(() => undefined)
      }
      return
    }
    const url = info.url || '/'
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = wins.find((w) => w.focused) || wins[0]
    if (win) {
      await win.focus().catch(() => undefined)
      // The SPA listens for this and routes client-side (no reload). See lib/push.ts. postMessage
      // rather than win.navigate() so TanStack Router stays in charge.
      win.postMessage({ type: 'push:navigate', url })
      return
    }
    await self.clients.openWindow(url)
  })())
})
`
