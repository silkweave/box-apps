// Presentation for the server-computed `health` state. The VERDICT is never recomputed here - core
// signalHealth owns it - this file only decides how each state looks and reads, once, so a card,
// a board node and a legend never disagree.

import type { SignalHealth, Signal } from '../../../types.ts'
import { formatNumber } from '../../../lib/format.ts'

interface HealthLook {
  label: string
  /** Text/border tone class. */
  tone: string
  /** The stroke color for a board edge or a dot, as a CSS value. */
  color: string
  /** What the state actually claims - the tooltip, because "off track" needs its reason. */
  hint: string
}

const LOOKS: Record<SignalHealth, HealthLook> = {
  met: { label: 'Met', tone: 'text-success', color: 'var(--success)', hint: 'The target value has been reached' },
  // Deliberately NOT the same green as `met`: on a board of dots, "reached it" and "still going,
  // looking fine" are different answers and must not share a color.
  on_track: {
    label: 'On track',
    tone: 'text-accent',
    color: 'var(--accent)',
    hint: 'Not met yet, and nothing observed says it is failing',
  },
  off_track: {
    label: 'Off track',
    tone: 'text-danger',
    color: 'var(--danger)',
    hint: 'Behind: the deadline passed, the pace is behind, or the number moved away from its baseline',
  },
  no_data: {
    label: 'No data',
    tone: 'text-warning',
    color: 'var(--warning)',
    hint: 'A target is set but the signal has no observation to judge it against',
  },
  no_target: {
    label: 'No target',
    tone: 'text-muted-foreground',
    color: 'var(--border)',
    hint: 'Nobody has said what good looks like for this signal - not a failure',
  },
}

export const healthLook = (h: SignalHealth): HealthLook => LOOKS[h] ?? LOOKS.no_target

/** "$32,650 / $35K" - the progress line a target earns, or null when there is nothing to show. */
export function targetProgress(signal: Signal, latest: number | null): string | null {
  if (!signal.target) return null
  const goal = `${formatNumber(signal.target.value)}${signal.unit ? ` ${signal.unit}` : ''}`
  if (latest == null) return `target ${goal}`
  return `${formatNumber(latest)} / ${goal}`
}
