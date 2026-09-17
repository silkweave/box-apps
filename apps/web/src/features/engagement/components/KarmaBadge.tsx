import { useNavigate } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, Trophy } from 'lucide-react'
import { useSelfKarma } from '../lib/useSelfKarma.ts'

/** The topbar karma tracker - the signed-in principal's global pod karma, both directions (given
 *  = engaging others, received = their own content), one click from the Engagement → Karma
 *  leaderboards. Renders nothing while loading or when there is no principal (transition mode) -
 *  karma is self-scoped, so there is nothing honest to show. */
export function KarmaBadge() {
  const karma = useSelfKarma()
  const navigate = useNavigate()
  if (karma === null) return null

  return (
    <button
      type='button'
      title='Your karma (given / received) - open the leaderboards'
      aria-label={`Your karma: ${karma.given} given, ${karma.received} received. Open the leaderboards.`}
      onClick={() => void navigate({ to: '/engagement/$section', params: { section: 'karma' } })}
      className='inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-body-sm text-muted-foreground transition-colors hover:bg-accent-tint hover:text-accent'>
      <Trophy className='size-4' />
      <span className='inline-flex items-center font-medium tabular-nums'>
        {karma.given}
        <ArrowUp className='size-3' />
      </span>
      <span className='inline-flex items-center font-medium tabular-nums'>
        {karma.received}
        <ArrowDown className='size-3' />
      </span>
    </button>
  )
}
