// Reddit inbox alert evaluator - the first concrete alert source. Fetches the browser-free `unread`
// inbox feed, ingests each entry (durable events row first, then realtime-rule alert rows), and
// flushes delivery at the end of the poll - the whole poll batch goes out as ONE Lark message per
// person, however many items it contained (the v2 batching guarantee for polled sources).
//
// Runs as a normal funnel action (`alerts-reddit`), so it's schedulable (the fast tier), inspectable
// in the Automation view, and its own failures are captured as automation_runs (a run.error alert
// source). See features/alerts/SPEC.md.

import { fetchInboxEvents, type RedditInboxEvent } from '../data/pulls/reddit-inbox.js'
import { todayUtc, type IngestProgress } from '../../ops/types.js'
import { ingestEvent } from './evaluate.js'
import { flushAlertsNow } from './flush.js'
import type { AlertEvent } from './types.js'

const EVENT_KIND = 'reddit.inbox'

/** The thread a notification belongs to (permalink up to the post id) - the traction subject. */
function threadOf(permalink: string): string {
  const m = permalink.match(/^(.*\/comments\/[a-z0-9]+)/i)
  return m ? m[1] : permalink
}

/** Normalize a Reddit inbox event into the generic AlertEvent (flat fields for the message template). */
function toAlertEvent(e: RedditInboxEvent): AlertEvent {
  return {
    kind: EVENT_KIND,
    dedup_key: e.id,
    event_at: e.updated,
    source: 'poll:reddit',
    actor: e.author,
    subject: threadOf(e.permalink),
    fields: {
      id: e.id,
      kind: e.kind,
      author: e.author,
      subreddit: e.subreddit,
      permalink: e.permalink,
      title: e.title,
      summary: e.summary,
    },
  }
}

/**
 * Ingest the current unread inbox: durable events rows first, fresh ones matched against the
 * enabled realtime rules. Returns the count fetched + newly recorded. Pure of delivery - the
 * action wrapper flushes.
 */
export async function evaluateRedditInbox(): Promise<{ fetched: number; recorded: number }> {
  const events = await fetchInboxEvents('unread')
  let recorded = 0
  for (const raw of events) {
    const r = await ingestEvent(toAlertEvent(raw))
    if (r.fresh) recorded++
  }
  return { fetched: events.length, recorded }
}

/** Funnel action wrapper - ingest → flush (one batched message), streaming a one-line summary. */
export async function* alertsRedditAction(): AsyncGenerator<IngestProgress> {
  yield { channel: 'alerts-reddit', phase: 'start', message: 'evaluating Reddit unread inbox…' }
  const { fetched, recorded } = await evaluateRedditInbox()
  yield { channel: 'alerts-reddit', phase: 'persist', message: `${recorded} new alert(s) from ${fetched} unread; delivering…` }
  const { delivered, suppressed, failed, messages } = await flushAlertsNow()
  const summary =
    `alerts-reddit: ${fetched} unread checked, ${recorded} new; ` +
    `delivered ${delivered} in ${messages} message(s), suppressed ${suppressed}, failed ${failed}`
  yield {
    channel: 'alerts-reddit',
    phase: 'done',
    message: summary,
    result: { channel: 'alerts-reddit', date: todayUtc(), summary },
  }
}
