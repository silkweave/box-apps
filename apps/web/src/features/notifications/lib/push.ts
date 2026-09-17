// Web push, the client half (chat Track 9). The server half is
// apps/server/src/notifications/push.ts; the worker itself is served by Nest at /api/push/sw.js
// (a reserved /api route is the only path served identically in dev - where everything else is
// proxied to Vite - and prod; its Service-Worker-Allowed header is what permits scope '/').
//
// Push is opt-in per browser, per user, and revocable from the app: the toggle in the
// notification bell drives usePush(). Browser permission alone is not the state - a user who
// denied at the OS level and a user who never asked look identical from the server, so the state
// machine below distinguishes them.

import { useCallback, useEffect, useState } from 'react'
import { trpc } from '../../../lib/trpc.ts'

const SW_URL = '/api/push/sw.js'

interface PushConfig {
  enabled: boolean
  publicKey: string | null
}

export type PushState =
  /** This browser cannot do Web Push at all (or the page is not a secure context). */
  | 'unsupported'
  /** The server has no VAPID pair configured - render nothing. */
  | 'unconfigured'
  /** The user denied notification permission at the browser/OS level; only they can undo that. */
  | 'denied'
  | 'off'
  | 'on'
  /** A transition is in flight - disable the control. */
  | 'busy'

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** The standard VAPID key conversion: base64url → the BufferSource subscribe() wants. */
function applicationServerKey(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + padding).replaceAll('-', '+').replaceAll('_', '/')
  const raw = atob(base64)
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0))
}

async function workerRegistration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register(SW_URL, { scope: '/' })
}

/**
 * The bell toggle's state machine. Reads server config once, then reflects this browser's actual
 * subscription; enable() runs the permission + subscribe dance, disable() revokes on the server
 * FIRST (the capability dies even if the browser-side unsubscribe then fails) and unsubscribes
 * locally after.
 */
export function usePush(): { state: PushState; enable: () => void; disable: () => void } {
  const [state, setState] = useState<PushState>('busy')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!pushSupported()) return setState('unsupported')
      const config = (await trpc.notificationsPushConfig.query({}).catch(() => null)) as PushConfig | null
      if (cancelled) return
      if (!config?.enabled || config.publicKey === null) return setState('unconfigured')
      if (Notification.permission === 'denied') return setState('denied')
      const registration = await navigator.serviceWorker.getRegistration(SW_URL)
      const subscription = await registration?.pushManager.getSubscription()
      if (!cancelled) setState(subscription ? 'on' : 'off')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const enable = useCallback(() => {
    void (async () => {
      setState('busy')
      try {
        // Permission must be requested from a user gesture - this callback is one (the toggle).
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') return setState(permission === 'denied' ? 'denied' : 'off')
        const config = (await trpc.notificationsPushConfig.query({})) as PushConfig
        if (!config.enabled || config.publicKey === null) return setState('unconfigured')
        const registration = await workerRegistration()
        const subscription = await registration.pushManager.subscribe({
          // Required by Chrome, and honest: every push here renders a notification (or is
          // deliberately swallowed because the room is focused, which Chrome permits).
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(config.publicKey) as BufferSource,
        })
        const json = subscription.toJSON()
        if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('subscription missing keys')
        await trpc.notificationsPushSubscribe.mutate({
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth: json.keys.auth,
          userAgent: navigator.userAgent,
        })
        setState('on')
      } catch {
        setState('off')
      }
    })()
  }, [])

  const disable = useCallback(() => {
    void (async () => {
      setState('busy')
      try {
        const registration = await navigator.serviceWorker.getRegistration(SW_URL)
        const subscription = await registration?.pushManager.getSubscription()
        if (subscription) {
          await trpc.notificationsPushUnsubscribe.mutate({ endpoint: subscription.endpoint })
          await subscription.unsubscribe()
        }
      } finally {
        setState('off')
      }
    })()
  }, [])

  return { state, enable, disable }
}

/**
 * The worker's notificationclick posts `{type: 'push:navigate', url}` instead of calling
 * WindowClient.navigate(), so the router routes client-side with no reload. Wire it once at
 * app mount; returns the unlisten.
 */
export function listenPushNavigate(onNavigate: (path: string) => void): () => void {
  if (!('serviceWorker' in navigator)) return () => undefined
  const handler = (event: MessageEvent): void => {
    const data = event.data as { type?: string; url?: string } | null
    if (data?.type !== 'push:navigate' || typeof data.url !== 'string') return
    // url is '/chat/<slug>' since browser history replaced hash routing (2026-09-14). Both the
    // worker and the notifications it has already shown are CACHED on the client: a notification
    // delivered before the change carries '/#/chat/<slug>' in its data, and the worker forwards
    // whatever it holds - so accept both spellings rather than routing an old click to '/'. Do not
    // "clean this up" while any browser may still hold a pre-change notification.
    const [path, hash] = data.url.split('#')
    onNavigate(hash ? hash : path || '/')
  }
  navigator.serviceWorker.addEventListener('message', handler)
  return () => navigator.serviceWorker.removeEventListener('message', handler)
}
