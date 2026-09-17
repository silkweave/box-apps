import { PLANNING_STATUS_META, type PlanningStatus } from '../planning-types.ts'
import { Badge, type BadgeProps } from '@silkweave/box-ui'

// Map the planning tones onto the shared Badge variants so every pill in the app
// shares one source of badge styling.
const TONE_VARIANT: Record<'accent' | 'success' | 'danger' | 'muted', BadgeProps['variant']> = {
  accent: 'accent',
  success: 'success',
  danger: 'danger',
  muted: 'neutral',
}

/** Read-only status pill - one vocabulary, so one pill for initiatives and tasks alike. */
export function PlanningStatusPill({ status }: { status: PlanningStatus }) {
  const m = PLANNING_STATUS_META[status]
  return <Badge variant={TONE_VARIANT[m.tone]}>{m.label}</Badge>
}
