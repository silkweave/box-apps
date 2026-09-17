import { defineCoreFeature } from '../../feature.js'

/** Cron schedules over core's action registry, plus the run history view. The schedules live in
 *  config/schedules.json; the runs table (automation_runs) is core's, written by the ops funnel. */
export default defineCoreFeature({
  id: 'automation',
  models: [],
  migrations: [],
})
