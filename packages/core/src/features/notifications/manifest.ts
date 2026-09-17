import { defineCoreFeature } from '../../feature.js'

/** Glue: the bell that merges chat mentions with alerts, web/FCM push, and alert delivery into chat
 *  rooms. Depends on both chat and alerts so each stays deletable on its own. */
export default defineCoreFeature({
  id: 'notifications',
  dependsOn: ['chat', 'alerts'],
  models: [],
  migrations: [],
})
