import { Check, Trophy, X } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { Badge, UserChip } from '@silkweave/box-ui'
import type { ContentPiece } from '../../content/content-types.ts'
import { ACTION_ICON, ACTION_META } from '../engagement-types.ts'
import { usePodsData } from '../lib/usePodsData.ts'
import type { EngagementAction, PodContent, PodEngagement, PodsOverview } from '../pods-types.ts'

// Which pods carry this piece, who has engaged, karma received. Contributed to content's piece
// detail page through the `content.piece.panel` slot (engagement depends on content, never the
// reverse).

/** All actions a pod piece expects: the derived card carries the full set while the piece is in the
 *  recency window; advice + already-recorded rows keep expired pieces honest afterwards. */
function expectedActionsOf(row: PodContent, pods: PodsOverview, engs: PodEngagement[]): EngagementAction[] {
  const card = pods.cards.find((c) => c.pod_content_id === row.id)
  const advice = row.advice?.actions ?? (row.advice?.action ? [row.advice.action] : [])
  return [...new Set([...(card?.actions ?? []), ...advice, ...engs.map((e) => e.action)])]
}

export function PodEngagementPanel({ piece }: { piece: ContentPiece }) {
  const { data: pods } = usePodsData()
  if (!pods) return null
  const rows = pods.content.filter((pc) => pc.content_id === piece.id)
  if (rows.length === 0) return null

  const allEngs = pods.engagements.filter((e) => rows.some((r) => r.id === e.pod_content_id))
  const received = allEngs.filter((e) => e.status === 'verified').reduce((s, e) => s + e.karma_awarded, 0)

  return (
    <section className='mt-6 rounded-lg border border-border bg-surface p-4 shadow-(--shadow-sm)'>
      <div className='flex items-center gap-2'>
        <Trophy className='size-4 text-muted-foreground' />
        <h2 className='text-body-sm font-medium text-text'>Engagement</h2>
        <Badge variant={received > 0 ? 'success' : 'neutral'} className='py-0' title='Karma this piece earned from verified engagements'>
          {received} karma received
        </Badge>
        <Link
          to='/engagement/$section'
          params={{ section: 'inbox' }}
          className='ml-auto text-label text-muted-foreground transition-colors hover:text-accent'
          title='Open your engage queue'>
          Open queue
        </Link>
      </div>

      {rows.map((row) => {
        const pod = pods.pods.find((p) => p.id === row.pod_id)
        const engs = pods.engagements.filter((e) => e.pod_content_id === row.id)
        const actions = expectedActionsOf(row, pods, engs)
        const members = pods.members.filter(
          (m) =>
            m.pod_id === row.pod_id &&
            !(m.participant_kind === row.submitter_kind && m.participant_id === row.submitter_id),
        )
        return (
          <div key={row.id} className='mt-3'>
            <div className='mb-2 text-label text-muted-foreground'>
              In pod{' '}
              <Link
                to='/settings/$section'
                params={{ section: 'pods' }}
                className='font-medium text-text transition-colors hover:text-accent'
                title='Manage pods in Settings'>
                {pod?.title ?? row.pod_id}
              </Link>
              {row.advice?.hint && <> · {row.advice.hint}</>}
            </div>
            <ul className='flex flex-col gap-1.5'>
              {members.map((m) => {
                return (
                  <li key={`${m.participant_kind}:${m.participant_id}`} className='flex items-center gap-2'>
                    <UserChip userId={m.participant_id} showName />
                    <span className='ml-auto flex items-center gap-1.5'>
                      {actions.map((a) => {
                        const eng = engs.find(
                          (e) =>
                            e.participant_kind === m.participant_kind &&
                            e.participant_id === m.participant_id &&
                            e.action === a,
                        )
                        const label = ACTION_META[a]?.label ?? a
                        const Icon = ACTION_ICON[a]
                        const variant =
                          eng?.status === 'verified' ? 'success' : eng?.status === 'dismissed' ? 'neutral' : eng?.status === 'draft' ? 'info' : 'accent'
                        const state =
                          eng?.status === 'verified' ? 'done' : eng?.status === 'dismissed' ? 'dismissed' : eng?.status === 'draft' ? 'draft saved' : 'pending'
                        return (
                          <Badge key={a} variant={variant} title={`${label} - ${state}`} className='inline-flex items-center gap-0.5 py-0.5'>
                            {eng?.status === 'verified' && <Check className='size-3' />}
                            {eng?.status === 'dismissed' && <X className='size-3' />}
                            {Icon ? <Icon className='size-3' aria-label={label} /> : label}
                          </Badge>
                        )
                      })}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
