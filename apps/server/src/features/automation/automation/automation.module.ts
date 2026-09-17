import { Module } from '@nestjs/common'
import { AutomationController } from './automation.controller.js'
import { SchedulerService } from './scheduler.service.js'

@Module({
  controllers: [AutomationController],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class AutomationModule {}
