import { CheckCheck } from 'lucide-react'
import { EmptyState } from '@silkweave/box-ui'

interface InboxZeroProps {
  /** How many items were handled (gives the screen a sense of accomplishment). */
  handledCount: number
  /** True before any items have ever arrived, vs. having cleared a real queue. */
  neverHadItems?: boolean
}

// The three sentences are the feature's, the screen they sit on is the library's (`EmptyState`).
// Which of the three you get is a rule about this inbox - an empty queue you have never used does
// not deserve the same congratulation as one you just cleared - and that rule is not something a
// component library can hold.
export function InboxZero({ handledCount, neverHadItems }: InboxZeroProps) {
  return (
    <EmptyState
      icon={<CheckCheck className='size-7' />}
      title='Inbox Zero'
      description={
        neverHadItems
          ? 'Nothing needs a reply right now. New comments, reviews, and mentions will show up here as they arrive.'
          : handledCount > 0
            ? `You've handled ${handledCount} engagement${handledCount === 1 ? '' : 's'}. Nothing left to follow up on - nicely done.`
            : 'Everything here has been followed up on. Nothing left to engage with.'
      }
    />
  )
}
