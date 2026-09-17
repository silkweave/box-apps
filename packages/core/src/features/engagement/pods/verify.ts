// Pod engagement verification - the `pod-engagement-verify` automation op (parameterized:
// pod_content_id + participant_kind + participant_id). Reuses the deterministic per-(channel·action)
// strategy table in verify/strategies.ts, so pods get the same code-level checks the retired
// cross-team matrix had: reddit comment via public thread JSON (falling back to the engager's own
// session), x/linkedin via their own logged-in Chrome on the browser host (config/browsers.json). Verdict
// rules are unchanged: ambiguity is `unknown`, never `confirmed`; only `confirmed` records (and
// awards karma). See features/engagement/SPEC.md.

import { channelPlatform } from '../../../accounts.js'
import { runStrategy } from '../verify/strategies.js'
import { readUsers } from '../../../users/state.js'
import { todayUtc, type IngestProgress } from '../../../ops/types.js'
import { expectedActions, readPodsConfig } from './config.js'
import { readPodContent, readPodEngagements, readPodMembers, recordPodEngagement } from './state.js'
import type { EngagementAction, ParticipantKind } from './types.js'

export interface PodVerifyParams {
  pod_content_id: string
  participant_kind: ParticipantKind
  participant_id: string
  /** users.id performing the verify (audit stamp on the recorded row). */
  actor?: string
}

const CH = 'pod-engagement-verify' // progress-stream channel label

/**
 * The `pod-engagement-verify` automation action. Resolves the pod piece + the participant's channel
 * handle (`users.channels` - collaborators are users rows too), runs the (channel·action) strategy,
 * and on `confirmed` records the pod engagement (karma included). The terminal chunk's
 * result.summary is `<verdict>: <detail>` - the dashboard parses that.
 */
export async function* verifyPodEngagementAction(params: PodVerifyParams): AsyncGenerator<IngestProgress> {
  const { pod_content_id, participant_kind, participant_id } = params
  if (!pod_content_id || !participant_kind || !participant_id) {
    throw new Error(
      'pod-engagement-verify needs params { pod_content_id, participant_kind, participant_id } - run it from the Engagement view',
    )
  }
  yield { channel: CH, phase: 'start', message: `verifying ${pod_content_id} × ${participant_kind}:${participant_id}` }

  const piece = (await readPodContent()).find((c) => c.id === pod_content_id)
  if (!piece) throw new Error(`no pod content "${pod_content_id}"`)
  if (!piece.url) throw new Error(`pod content "${pod_content_id}" has no URL to check`)
  const members = await readPodMembers(piece.pod_id)
  if (!members.some((m) => m.participant_kind === participant_kind && m.participant_id === participant_id)) {
    throw new Error(`${participant_kind} "${participant_id}" is not a member of pod "${piece.pod_id}"`)
  }
  // ALL expected actions minus the ones already completed - a card can carry several (e.g.
  // linkedin → react + comment) and each is verified + recorded independently, so partial
  // progress sticks (react confirmed today, comment verified tomorrow).
  const actions = expectedActions(readPodsConfig(), piece.channel, piece.advice)
  if (actions.length === 0) {
    throw new Error(`channel "${piece.channel}" expects no engagement (config/pods.json, no advice actions)`)
  }
  const doneRows = (await readPodEngagements()).filter(
    (e) =>
      e.pod_content_id === pod_content_id &&
      e.participant_kind === participant_kind &&
      e.participant_id === participant_id &&
      e.status !== 'draft',
  )
  const remaining = actions.filter((a) => !doneRows.some((e) => e.action === a))
  if (remaining.length === 0) {
    const summary = `confirmed: all expected actions (${actions.join(', ')}) are already recorded`
    yield { channel: CH, phase: 'done', message: summary, result: { channel: CH, date: todayUtc(), summary } }
    return
  }

  // The participant's own handle on the channel's PLATFORM (linkedin-article → linkedin) -
  // users.channels is keyed by platform and is the source of truth for everyone (collaborators are
  // users rows too). Comment strategies match the handle in the thread, so they hard-require it;
  // toggle strategies (like/react) read button state and don't.
  const platform = channelPlatform(piece.channel)
  const login = (await readUsers()).find((u) => u.id === participant_id)?.channels?.[platform] ?? ''
  if (!login && remaining.includes('comment')) {
    throw new Error(
      `"${participant_id}" has no ${platform} handle in users.channels - set it in Settings → Users, then verify again`,
    )
  }

  const outcomes: { action: EngagementAction; verdict: string; detail: string }[] = []
  for (const action of remaining) {
    yield {
      channel: CH,
      phase: 'fetch',
      message: `strategy ${piece.channel}·${action} - checking ${piece.url}${login ? ` as ${login}` : ''}`,
    }
    const outcome = await runStrategy(piece.channel, action, piece.url, participant_id, login, pod_content_id)
    outcomes.push({ action, verdict: outcome.verdict, detail: outcome.detail })
    if (outcome.verdict === 'confirmed') {
      yield { channel: CH, phase: 'persist', message: `${action} confirmed - recording (${outcome.detail})` }
      await recordPodEngagement({
        pod_content_id,
        participant_kind,
        participant_id,
        action,
        status: 'verified',
        evidence: outcome.evidence ?? { method: 'browser', detail: outcome.detail },
        ...(params.actor ? { actor: params.actor } : {}),
      })
    }
  }

  // Overall verdict: confirmed only when EVERY remaining action confirmed; a single unknown makes
  // the whole run unknown (never claim "not found" when a check couldn't run).
  const overall = outcomes.every((o) => o.verdict === 'confirmed')
    ? 'confirmed'
    : outcomes.some((o) => o.verdict === 'unknown')
      ? 'unknown'
      : 'not_found'
  const summary = `${overall}: ${outcomes.map((o) => `${o.action}: ${o.verdict === 'confirmed' ? 'confirmed - ' : ''}${o.detail}`).join(' · ')}`
  yield { channel: CH, phase: 'done', message: summary, result: { channel: CH, date: todayUtc(), summary } }
}
