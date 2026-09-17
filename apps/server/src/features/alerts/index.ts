import { defineServerFeature } from '../../feature.js'
import { AlertsModule } from './alerts/alerts.module.js'

/** Alert rules, the alert feed, the evaluators. */
export default defineServerFeature({ id: 'alerts', module: AlertsModule })
