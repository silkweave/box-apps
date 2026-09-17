import { defineCoreFeature } from '../../feature.js'
import { CRM_MODELS } from './models.js'

/** Accounts, contacts, meetings, revenue events, activities. Personal data. */
export default defineCoreFeature({
  id: 'crm',
  dependsOn: ['data'],
  models: CRM_MODELS,
  migrations: [],
})
