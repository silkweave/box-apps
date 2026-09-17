import { registerStoreReloads } from '../../../lib/changeFeed.ts'
import { createDataStore } from '../../../lib/dataStore.ts'
import { trpc } from '../../../lib/trpc.ts'
import { getActiveUserId } from '../../../lib/useActiveUser.ts'
import { reloadSelfKarma } from './useSelfKarma.ts'
import type {
  EngagementAction,
  EngagementAdvice,
  ParticipantKind,
  Pod,
  PodContentSource,
  PodMemberRole,
  PodsOverview,
  PodStatus,
} from '../pods-types.ts'

/** The active user as the mutation's `actor` audit stamp. */
const actor = (): string | undefined => getActiveUserId() ?? undefined

// One shared store (see dataStore.ts) of the whole internal picture; views filter client-side.
// Any mutation forces a reload.
function fromWire(d: unknown): PodsOverview {
  const o = (d ?? {}) as Partial<PodsOverview>
  return {
    autoContent: o.autoContent ?? null,
    pods: (o.pods ?? []) as Pod[],
    members: o.members ?? [],
    content: o.content ?? [],
    engagements: o.engagements ?? [],
    cards: o.cards ?? [],
    karma: o.karma ?? [],
  }
}

const store = createDataStore<PodsOverview>(() => trpc.podsOverview.query({}).then(fromWire))
registerStoreReloads(
  ['table:pods', 'table:pod_members', 'table:pod_content', 'table:pod_engagements', 'table:users', 'config:pods.json'],
  store,
)

export const reloadPods = (): Promise<PodsOverview> => store.reload()

// --- pods ---
export async function upsertPod(input: { id: string; title?: string; description?: string; status?: PodStatus; owner?: string; sort?: number }): Promise<void> {
  await trpc.podsUpsert.mutate({ ...input, actor: actor() })
  await store.reload()
}
export async function deletePod(id: string): Promise<void> {
  await trpc.podsDelete.mutate({ id, actor: actor() })
  await store.reload()
}
export async function setAutoContentEnabled(enabled: boolean): Promise<void> {
  await trpc.podsAutoContentSet.mutate({ enabled, actor: actor() })
  await store.reload()
}

// --- membership ---
export async function addMember(pod_id: string, kind: ParticipantKind, participant_id: string, role?: PodMemberRole): Promise<void> {
  await trpc.podsMemberAdd.mutate({ pod_id, participant_kind: kind, participant_id, role, actor: actor() })
  await store.reload()
}
export async function removeMember(pod_id: string, kind: ParticipantKind, participant_id: string): Promise<void> {
  await trpc.podsMemberRemove.mutate({ pod_id, participant_kind: kind, participant_id, actor: actor() })
  await store.reload()
}

// --- content curation ---
export async function upsertPodContent(input: {
  id?: string
  pod_id: string
  source?: PodContentSource
  content_id?: string
  submitter_kind?: ParticipantKind
  submitter_id?: string
  channel: string
  url: string
  title?: string
  advice?: EngagementAdvice
  published_at?: string
}): Promise<void> {
  const { advice, ...rest } = input
  await trpc.podsContentUpsert.mutate({
    ...rest,
    advice: advice ? JSON.stringify(advice) : undefined,
    actor: actor(),
  })
  await store.reload()
}
export async function deletePodContent(id: string): Promise<void> {
  await trpc.podsContentDelete.mutate({ id, actor: actor() })
  await store.reload()
}

// --- engagements ---
export async function recordPodEngagement(
  pod_content_id: string,
  kind: ParticipantKind,
  participant_id: string,
  action: EngagementAction,
  note?: string,
): Promise<void> {
  await trpc.podsEngagementRecord.mutate({
    pod_content_id,
    participant_kind: kind,
    participant_id,
    action,
    evidence: JSON.stringify({ method: 'manual' }),
    note,
    actor: actor(),
  })
  await store.reload()
  // Verified pod engagements award karma - keep the topbar badge honest.
  void reloadSelfKarma()
}
/** A card's still-open actions. */
const remainingOf = (card: { actions: EngagementAction[]; done_actions: EngagementAction[] }): EngagementAction[] =>
  card.actions.filter((a) => !card.done_actions.includes(a))

/** Record ALL of a card's remaining actions as a manual attestation (one reload at the end). */
export async function recordPodEngagementAll(
  card: { pod_content_id: string; participant_kind: ParticipantKind; participant_id: string; actions: EngagementAction[]; done_actions: EngagementAction[] },
  note?: string,
): Promise<void> {
  for (const action of remainingOf(card)) {
    await trpc.podsEngagementRecord.mutate({
      pod_content_id: card.pod_content_id,
      participant_kind: card.participant_kind,
      participant_id: card.participant_id,
      action,
      evidence: JSON.stringify({ method: 'manual' }),
      note,
      actor: actor(),
    })
  }
  await store.reload()
  void reloadSelfKarma()
}

/** Dismiss ALL of a card's remaining actions ("not engaging this one"). */
export async function dismissPodEngagementAll(
  card: { pod_content_id: string; participant_kind: ParticipantKind; participant_id: string; actions: EngagementAction[]; done_actions: EngagementAction[] },
  note?: string,
): Promise<void> {
  for (const action of remainingOf(card)) {
    await trpc.podsEngagementDismiss.mutate({
      pod_content_id: card.pod_content_id,
      participant_kind: card.participant_kind,
      participant_id: card.participant_id,
      action,
      note,
      actor: actor(),
    })
  }
  await store.reload()
}

/** Save (or overwrite) the participant's own comment DRAFT for one card. Never touches karma;
 *  the server refuses to downgrade an already-verified engagement. */
export async function draftPodEngagement(
  pod_content_id: string,
  kind: ParticipantKind,
  participant_id: string,
  action: EngagementAction,
  draft: string,
): Promise<void> {
  await trpc.podsEngagementDraft.mutate({
    pod_content_id,
    participant_kind: kind,
    participant_id,
    action,
    draft,
    actor: actor(),
  })
  await store.reload()
}
export async function dismissPodEngagement(
  pod_content_id: string,
  kind: ParticipantKind,
  participant_id: string,
  action: EngagementAction,
  note?: string,
): Promise<void> {
  await trpc.podsEngagementDismiss.mutate({
    pod_content_id,
    participant_kind: kind,
    participant_id,
    action,
    note,
    actor: actor(),
  })
  await store.reload()
}

/**
 * Kick the backend `pod-engagement-verify` op for one card and resolve with its verdict. The op
 * checks from the engager's own side (reddit: public JSON; x/linkedin: their Chrome on the browser host)
 * and records the engagement itself (karma included) on `confirmed` - we just reload so the card
 * disappears. The run is detached server-side, so navigating away never kills the check. Rejects
 * only on infra errors (unknown piece, not a member) - an unreachable browser is a normal
 * `unknown` verdict.
 */
export function verifyPodEngagement(
  card: { pod_content_id: string; participant_kind: ParticipantKind; participant_id: string },
  onProgress?: (message: string) => void,
): Promise<{ verdict: 'confirmed' | 'not_found' | 'unknown'; detail: string }> {
  return new Promise((resolve, reject) => {
    let summary = ''
    trpc.podsEngagementVerify.subscribe(
      {
        pod_content_id: card.pod_content_id,
        participant_kind: card.participant_kind,
        participant_id: card.participant_id,
        actor: actor(),
      },
      {
        onData: (p: unknown) => {
          const chunk = p as { message?: string; result?: { summary?: string } }
          if (chunk.message) onProgress?.(chunk.message)
          if (chunk.result?.summary) summary = chunk.result.summary
        },
        onError: (e: { message: string }) => reject(new Error(e.message)),
        onComplete: () => {
          const m = /^(confirmed|not_found|unknown):\s*([\s\S]*)$/.exec(summary)
          const result = m
            ? { verdict: m[1] as 'confirmed' | 'not_found' | 'unknown', detail: m[2] }
            : { verdict: 'unknown' as const, detail: summary || 'the verify run ended without a verdict' }
          if (result.verdict === 'confirmed') {
            void store.reload()
              .finally(() => reloadSelfKarma())
              .finally(() => resolve(result))
          } else {
            resolve(result)
          }
        },
      },
    )
  })
}

export function usePodsData(): { data: PodsOverview | null; error: string | null } {
  return store.useData()
}
