// Persistence for the Content board's view state, built from the shared factory in `boardView.ts` -
// the same machinery the CRM and Initiatives use, with Content's own vocabulary. Presets are GLOBAL
// (tenant config, one list the whole team edits, every entry editable); only the live view is
// per-browser.

import { createViewStore, type ViewStore } from '../../data/lib/boardView.ts'
import {
  CONTENT_DEFAULT_PRESETS,
  DEFAULT_CONTENT_VIEW,
  normalizeContentViewState,
  sameContentView,
  type ContentViewState,
} from './contentView.ts'
import { appKey } from '@/lib/storage.ts'

export type ContentView = ViewStore<ContentViewState>

export const useContentView = createViewStore<ContentViewState>({
  module: 'content',
  storageKey: appKey('content'),
  defaultView: DEFAULT_CONTENT_VIEW,
  defaultPresets: CONTENT_DEFAULT_PRESETS,
  normalize: normalizeContentViewState,
  same: sameContentView,
})
