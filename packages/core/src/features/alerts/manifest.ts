import { defineCoreFeature } from '../../feature.js'
import { ALERTS_ACTIONS } from './actions.js'
import { ALERTS_MODELS } from './models.js'

/** Alert rules over the events spine and the signals: evaluators, the alert ledger, delivery. */
export default defineCoreFeature({
  id: 'alerts',
  dependsOn: ['data', 'planning', 'content', 'engagement'],
  models: ALERTS_MODELS,
  migrations: [],
  actions: ALERTS_ACTIONS,
})
