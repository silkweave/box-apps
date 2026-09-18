import { defineCoreFeature } from '../../feature.js'
import { REMINDERS_MODELS } from './models.js'

/** Reminders: a moment in time, a name, an optional description. One table, no dependencies. */
export default defineCoreFeature({
  id: 'reminders',
  models: REMINDERS_MODELS,
  migrations: [],
})
