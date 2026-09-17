// Persistence for the CRM board's view state, built from the shared factory in `boardView.ts` - the
// same machinery Content and Initiatives use, with the CRM's own vocabulary. Presets are GLOBAL
// (tenant config, one list the whole team edits, every entry editable); only the live view is
// per-browser.

import { createViewStore, type ViewStore } from '../../data/lib/boardView.ts'
import {
  CRM_DEFAULT_PRESETS,
  DEFAULT_CRM_VIEW,
  normalizeCrmViewState,
  sameCrmView,
  type CrmViewState,
} from './crmView.ts'
import { appKey } from '@/lib/storage.ts'

export type CrmView = ViewStore<CrmViewState>

export const useCrmView = createViewStore<CrmViewState>({
  module: 'crm',
  storageKey: appKey('crm'),
  defaultView: DEFAULT_CRM_VIEW,
  defaultPresets: CRM_DEFAULT_PRESETS,
  normalize: normalizeCrmViewState,
  same: sameCrmView,
})
