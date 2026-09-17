import { defineCoreFeature } from '../../feature.js'
import { PLANNING_MODELS } from './models.js'

/** Initiatives, tasks and sprints - the body of work and its argument. */
export default defineCoreFeature({
  id: 'planning',
  dependsOn: ['data'],
  models: PLANNING_MODELS,
  migrations: [
    {
      // Sprint tasks (2026-09-14): a task made straight onto the sprint grid belongs to the sprint
      // and to no initiative, so `tasks.initiative_id` stops being NOT NULL. Shape only, no rows
      // touched - every existing task keeps its initiative, and a sprint task is only ever born by
      // `createSprintTask`. A fresh Box gets this from the ModelSpec; this is for a Box that already
      // booted on the old shape.
      name: '001-sprint-tasks',
      statements: [`ALTER TABLE tasks ALTER COLUMN initiative_id DROP NOT NULL`],
    },
  ],
})
