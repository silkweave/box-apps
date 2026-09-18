import { defineServerFeature } from '../../feature.js'
import { RemindersModule } from './reminders/reminders.module.js'

/** Reminders: one table, one controller, no env and no background work. */
export default defineServerFeature({ id: 'reminders', module: RemindersModule })
