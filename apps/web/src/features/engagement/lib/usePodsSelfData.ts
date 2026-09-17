import { useCallback, useEffect, useState } from 'react'
import { trpc } from '../../../lib/trpc.ts'
import { reloadSelfKarma } from './useSelfKarma.ts'
import type { EngagementAction, PodsSelfOverview } from '../pods-types.ts'

// Data layer for the SELF-scoped pods surface.
// Unlike the module-cached internal hooks, this is per-mount state: one signed-in participant, one
// view. Every mutation returns the fresh overview, so the state just swaps - no separate reload
// round trip.

function fromWire(d: unknown): PodsSelfOverview {
  const o = (d ?? {}) as Partial<PodsSelfOverview>
  return {
    me: (o.me ?? { id: '', kind: 'user', display: '' }) as PodsSelfOverview['me'],
    pods: o.pods ?? [],
    cards: o.cards ?? [],
    karma: o.karma ?? [],
    leaderboards: (o.leaderboards ?? {}) as PodsSelfOverview['leaderboards'],
  }
}

export interface PodsSelfData {
  data: PodsSelfOverview | null
  error: string | null
  engage: (pod_content_id: string, action: EngagementAction) => Promise<void>
  dismiss: (pod_content_id: string, action: EngagementAction) => Promise<void>
  submit: (input: { pod_id: string; channel: string; url: string; title?: string }) => Promise<void>
}

export function usePodsSelfData(): PodsSelfData {
  const [data, setData] = useState<PodsSelfOverview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    trpc.podsSelfOverview
      .query({})
      .then((d) => {
        if (alive) setData(fromWire(d))
      })
      .catch((e) => {
        if (alive) setError(String(e))
      })
    return () => {
      alive = false
    }
  }, [])

  const engage = useCallback(async (pod_content_id: string, action: EngagementAction) => {
    setData(fromWire(await trpc.podsSelfEngage.mutate({ pod_content_id, action })))
    // Verified pod engagements award karma - keep the topbar badge honest.
    void reloadSelfKarma()
  }, [])

  const dismiss = useCallback(async (pod_content_id: string, action: EngagementAction) => {
    setData(fromWire(await trpc.podsSelfDismiss.mutate({ pod_content_id, action })))
  }, [])

  const submit = useCallback(async (input: { pod_id: string; channel: string; url: string; title?: string }) => {
    setData(fromWire(await trpc.podsSelfSubmit.mutate(input)))
  }, [])

  return { data, error, engage, dismiss, submit }
}
