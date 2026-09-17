// Lark card rendering (alerts v2) - build the interactive-card JSON for every delivery shape:
// one card per flush per person, whether it carries a single alert or a batch. Cards replace the
// plain-text posts: header color-coded by class, the full event text in the body, and buttons
// deep-linking to the dashboard Inbox item (tailnet-only, by design) + the platform permalink.
// Pure functions - no I/O; sending is lark.ts, orchestration is deliver.ts.

import { inboxDeepLink, dashboardUrl } from '../engagement/inbox/inbox-map.js'
import type { AlertRecord } from './types.js'

/** How many alerts a batch card lists individually before collapsing to "+ N more". */
export const BATCH_LIST_MAX = 10

/** Human title per event kind (single-alert cards; batches get a count title). */
export function titleFor(eventKind: string): string {
  switch (eventKind) {
    case 'reddit.inbox':
      return '💬 New Reddit reply'
    case 'github.notification':
      return '🐙 GitHub notification'
    case 'github.pr_merged':
      return '🎉 PR merged'
    case 'github.star':
      return '⭐ New star'
    case 'x.reply':
      return '💬 New X reply'
    case 'x.mention':
      return '📣 X mention'
    case 'x.quote':
      return '🔁 X quote'
    case 'x.repost':
      return '🔁 X repost'
    case 'x.like':
      return '❤️ X like'
    case 'x.follow':
      return '➕ New X follower'
    case 'linkedin.comment':
      return '💬 New LinkedIn comment'
    case 'run.error':
      return '⚠️ Op error'
    case 'signal.increase':
      return '📈 Signal moved'
    case 'signal.threshold':
      return '🎯 Signal threshold'
    case 'traction.spike':
      return '🔥 Post taking off'
    case 'digest.daily':
      return '🗞️ Daily engagement digest'
    default:
      return '🔔 Alert'
  }
}

/** Header color by class: response-needed = blue, wins = green, waves = orange, failures = red. */
function templateFor(eventKind: string): string {
  if (eventKind === 'run.error') return 'red'
  if (eventKind === 'traction.spike') return 'orange'
  if (eventKind === 'digest.daily') return 'purple'
  if (eventKind.startsWith('signal.') || eventKind === 'github.pr_merged' || eventKind === 'github.star') return 'green'
  return 'blue'
}

interface CardButton {
  label: string
  url: string
  primary?: boolean
}

function button(b: CardButton): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: b.label },
    type: b.primary ? 'primary' : 'default',
    url: b.url,
  }
}

function card(title: string, template: string, elements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  }
}

/** External permalink an alert carries, if any (payload url/permalink - set by the normalizers). */
function externalUrl(alert: AlertRecord): string | null {
  const url = alert.payload.url ?? alert.payload.permalink
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null
}

function buttonsFor(alert: AlertRecord): Array<Record<string, unknown>> {
  const buttons: CardButton[] = []
  const deepLink = inboxDeepLink(alert.event_kind, alert.dedup_key, alert.payload)
  if (deepLink) buttons.push({ label: 'Open in dashboard', url: deepLink, primary: true })
  const external = externalUrl(alert)
  if (external) buttons.push({ label: 'Open link', url: external, primary: buttons.length === 0 })
  return buttons.length > 0 ? [{ tag: 'action', actions: buttons.map(button) }] : []
}

/** Card for a single alert: kind header + the full rendered message + action buttons. */
export function singleAlertCard(alert: AlertRecord): Record<string, unknown> {
  return card(titleFor(alert.event_kind), templateFor(alert.event_kind), [
    { tag: 'markdown', content: alert.message },
    ...buttonsFor(alert),
  ])
}

/**
 * Card for a batched flush to one person: the first BATCH_LIST_MAX alerts listed individually
 * (each line is the alert's rendered message), then a single "+ N more" line. One button into the
 * dashboard Inbox - per-item deep links stay usable inside each listed line's markdown links.
 */
export function batchAlertCard(alerts: AlertRecord[]): Record<string, unknown> {
  const listed = alerts.slice(0, BATCH_LIST_MAX)
  const rest = alerts.length - listed.length
  const kinds = new Set(alerts.map((a) => a.event_kind))
  const template = kinds.size === 1 ? templateFor(alerts[0].event_kind) : 'blue'
  const title = kinds.size === 1 ? `${titleFor(alerts[0].event_kind)} (${alerts.length})` : `🔔 ${alerts.length} new alerts`

  // Messages can carry the full event text (untruncated at intake) - clamp per LINE here so a
  // 10-item batch stays scannable; the detail lives behind the deep link.
  const clamp = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}…` : s)
  const lines = listed.map((a) => `- ${clamp(a.message.replace(/\s+/g, ' '))}`)
  if (rest > 0) lines.push(`**+ ${rest} more**`)

  const elements: Array<Record<string, unknown>> = [{ tag: 'markdown', content: lines.join('\n') }]
  const base = dashboardUrl()
  if (base) {
    elements.push({
      tag: 'action',
      actions: [button({ label: 'Open Replies', url: `${base}/engagement/replies`, primary: true })],
    })
  }
  return card(title, template, elements)
}
