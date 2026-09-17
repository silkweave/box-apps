import type { ActionSpec } from '../../ops/types.js'
import type { ParticipantKind } from './pods/types.js'
import { verifyPodEngagementAction } from './pods/verify.js'

export const ENGAGEMENT_FEATURE_ACTIONS: ActionSpec[] = [
  {
    id: 'pod-engagement-verify',
    label: 'Verify pod engagement',
    group: 'Engagement',
    description: "Confirm a pod member's engagement from their own session (params: pod_content_id, participant_kind, participant_id)",
    parameterized: true,
    run: ({ params }) =>
      verifyPodEngagementAction({
        pod_content_id: params?.pod_content_id ?? '',
        participant_kind: (params?.participant_kind ?? 'user') as ParticipantKind,
        participant_id: params?.participant_id ?? '',
        ...(params?.actor ? { actor: params.actor } : {}),
      }),
  },
]
