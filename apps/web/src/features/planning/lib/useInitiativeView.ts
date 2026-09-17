// Persistence for the Initiatives board's view state, built from the shared factory in
// `boardView.ts` - the same machinery Content and the CRM use, with the planning vocabulary. Presets
// are GLOBAL (tenant config, one list the whole team edits, every entry editable); only the live view
// is per-browser.

import { createViewStore, type ViewStore } from '../../data/lib/boardView.ts'
import {
  DEFAULT_VIEW,
  PLANNING_DEFAULT_PRESETS,
  normalizeViewState,
  sameView,
  type ViewState,
} from './planningView.ts'
import { appKey } from '@/lib/storage.ts'

export type InitiativeView = ViewStore<ViewState>

export const useInitiativeView = createViewStore<ViewState>({
  module: 'initiatives',
  storageKey: appKey('initiatives'),
  defaultView: DEFAULT_VIEW,
  defaultPresets: PLANNING_DEFAULT_PRESETS,
  normalize: normalizeViewState,
  same: sameView,
})
