import { Module } from '@nestjs/common'
import { RemindersController } from './reminders.controller.js'

@Module({
  controllers: [RemindersController],
})
export class RemindersModule {}
