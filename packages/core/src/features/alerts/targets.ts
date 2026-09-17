// Initiative-target evaluator - the consumer the `initiatives.target` column never had (it was
// written by the dashboard and rendered as a progress bar, but nothing ever ACTED on it). After a
// run that may have moved signals, compare every live target against its bound signal and put the
// outcome on the events spine:
//
//   • `initiative.target_reached` - the signal hit the target value. Fires once per (initiative,
//     signal, target value) thanks to the events dedup, so re-deriving is a no-op.
//   • `initiative.target_missed` - the target has a `by_date` that passed with the signal short.
//     Fires once per (initiative, signal, by_date).
//
// Alert rules in config/alerts.json can match these kinds for Lark delivery; without a rule they
// still land durably in `events` (digests + history). Best-effort like evaluateSignalRules - never
// throws into the run funnel.

import { withRead } from '../../warehouse/db.js'
import { readRecords } from '../../warehouse/model.js'
import { INITIATIVES } from '../planning/models.js'
import type { Initiative } from '../planning/types.js'
import { ingestEvent } from './evaluate.js'

interface LatestPoint {
  value: number
  as_of: string
}

/** Evaluate every live initiative target; returns how many events were freshly recorded. */
export async function evaluateInitiativeTargets(): Promise<{ recorded: number }> {
  try {
    const initiatives = await readRecords<Initiative>(INITIATIVES, {
      where: `target IS NOT NULL AND status NOT IN ('done', 'dropped')`,
    })
    let recorded = 0
    const today = new Date().toISOString().slice(0, 10)
    for (const initiative of initiatives) {
      const target = initiative.target
      if (!target?.signal_id || typeof target.value !== 'number') continue
      const point = (
        await withRead<LatestPoint>(
          `SELECT value, CAST(as_of AS VARCHAR) AS as_of FROM latest_signals WHERE signal_id = ?`,
          [target.signal_id],
        )
      )[0]
      if (!point) continue

      const baseline = target.baseline ?? 0
      const fields: Record<string, string> = {
        initiative: initiative.id,
        title: initiative.title,
        signal_id: target.signal_id,
        value: String(point.value),
        target: String(target.value),
        baseline: String(baseline),
        by_date: target.by_date ?? '',
        as_of: point.as_of,
      }
      if (point.value >= target.value) {
        const res = await ingestEvent({
          kind: 'initiative.target_reached',
          dedup_key: `${initiative.id}:${target.signal_id}:${target.value}`,
          event_at: `${point.as_of}T00:00:00.000Z`,
          source: 'funnel',
          subject: initiative.id,
          fields,
        })
        if (res.fresh) recorded++
      } else if (target.by_date && target.by_date < today) {
        const res = await ingestEvent({
          kind: 'initiative.target_missed',
          dedup_key: `${initiative.id}:${target.signal_id}:${target.by_date}`,
          event_at: `${target.by_date}T00:00:00.000Z`,
          source: 'funnel',
          subject: initiative.id,
          fields,
        })
        if (res.fresh) recorded++
      }
    }
    return { recorded }
  } catch {
    return { recorded: 0 }
  }
}
