import { defineCoreFeature } from '../../feature.js'
import { CONTENT_ACTIONS } from './actions.js'
import { CONTENT_MODELS } from './models.js'

/** Topics and pieces: the content lifecycle, channel profiles, voice, gated publishing. */
export default defineCoreFeature({
  id: 'content',
  dependsOn: ['data', 'planning'],
  models: CONTENT_MODELS,
  migrations: [],
  actions: CONTENT_ACTIONS,
})
