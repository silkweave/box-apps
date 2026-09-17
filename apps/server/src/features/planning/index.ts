import { defineServerFeature } from '../../feature.js'
import { PlanningModule } from './planning/planning.module.js'

/** Initiatives, tasks, sprints. */
export default defineServerFeature({ id: 'planning', module: PlanningModule })
