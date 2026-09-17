import { defineCoreFeature } from '../../feature.js'
import { ENGAGEMENT_FEATURE_ACTIONS } from './actions.js'
import { ENGAGEMENT_MODELS } from './models.js'

/** Engagement pods, the tactical inbox, and the browser verification of engagements. */
export default defineCoreFeature({
  id: 'engagement',
  dependsOn: ['data', 'content'],
  models: ENGAGEMENT_MODELS,
  migrations: [],
  actions: ENGAGEMENT_FEATURE_ACTIONS,
})
