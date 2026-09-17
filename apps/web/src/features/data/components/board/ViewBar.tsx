// This Box's board bar: `@silkweave/box-ui/board`'s controlled `BoardViewBar`, bound to a module's
// `ViewStore` and given the preset control to draw in its slot.
//
// The split is the library's contract, not a preference. The BAR is chrome - layout, search,
// grouping, sort, filters, columns - and knows nothing about where a view is kept. WHERE it is kept
// is entirely this app's: a module-level store, localStorage for the live view, the URL for which
// preset you are on, and the team's shared preset list on the server. `PresetPicker` is passed in
// rather than lifted for exactly that reason - a preset is a server record.
//
// The one cast lives here, for the reason `boardView` already states: a module narrows each filter
// axis to its own enum, and a narrowed array is not assignable through an index signature. The bar
// only ever reads and writes string arrays, so merging its patch back into `S` is safe.

import { BoardViewBar, type BoardBarSpec } from '@silkweave/box-ui/board'
import { PresetPicker } from './PresetPicker.tsx'
import type { BaseViewState, ViewStore } from '../../lib/boardView.ts'

/** The library's spec plus the one line only the preset control needs. */
export type ViewBarSpec = BoardBarSpec & {
  /** What saving captures, e.g. "the current layout, filters, grouping and columns". */
  savesHint: string
}

export function ViewBar<S extends BaseViewState>({ view: v, spec }: { view: ViewStore<S>; spec: ViewBarSpec }) {
  return (
    <BoardViewBar
      value={v.view}
      onChange={(patch) => v.setView((prev) => ({ ...prev, ...patch }) as S)}
      spec={spec}
      presets={<PresetPicker view={v} savesHint={spec.savesHint} noun={spec.noun} />}
    />
  )
}
