import { Module, type OnModuleInit } from '@nestjs/common'
import { PLANNING_SIGNAL_HOOKS, registerSignalHooks, registerUserCleanup, unassignDeletedUser } from '@silkweave/box-core'
import { PlanningController } from './planning.controller.js'

@Module({
  controllers: [PlanningController],
})
export class PlanningModule implements OnModuleInit {
  onModuleInit(): void {
    // Planning depends on data; it registers what data needs from it (task-ledger rows on the
    // github channel, its outcome derive, re-pointing initiative bindings on a signal rename).
    registerSignalHooks(PLANNING_SIGNAL_HOOKS)
    // And what CORE needs from it: a deleted user leaves no initiative owner or task assignee
    // pointing at a ghost id. Core knows the user is going; only planning knows its own columns.
    registerUserCleanup('planning', unassignDeletedUser)
  }
}
