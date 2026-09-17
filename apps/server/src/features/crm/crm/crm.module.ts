import { Module } from '@nestjs/common'
import { CrmController } from './crm.controller.js'

@Module({
  controllers: [CrmController],
})
export class CrmModule {}
