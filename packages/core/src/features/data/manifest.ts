import { defineCoreFeature } from '../../feature.js'
import { DATA_ACTIONS } from './actions.js'
import { DATA_MODELS } from './models.js'

/** The data feature: signals, their sources and pulls, circuit boards, presets. The foundation
 *  most other features depend on. */
export default defineCoreFeature({
  id: 'data',
  models: DATA_MODELS,
  baseline: [
    `CREATE OR REPLACE VIEW latest_signals AS
     SELECT channel, signal_id, label, signal_group, unit,
            last(value ORDER BY date) AS value, max(date) AS as_of
     FROM legacy_signal_points GROUP BY 1, 2, 3, 4, 5`,
  ],
  migrations: [],
  actions: DATA_ACTIONS,
})
