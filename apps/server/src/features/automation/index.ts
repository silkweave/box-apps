import { defineServerFeature } from '../../feature.js'
import { AutomationModule } from './automation/automation.module.js'

/** The cron scheduler, the schedules config surface, run history, the self-restart. */
export default defineServerFeature({
  id: 'automation',
  module: AutomationModule,
  env: [{ name: 'AUTOMATION_ENABLED', doc: '1 arms the scheduler; anything else leaves every timer off (the safe default on a dev machine)' }],
})
