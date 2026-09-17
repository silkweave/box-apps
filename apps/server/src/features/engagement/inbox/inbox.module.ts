import { Module } from '@nestjs/common'
import { InboxController } from './inbox.controller.js'

@Module({
  controllers: [InboxController],
})
export class InboxModule {}
