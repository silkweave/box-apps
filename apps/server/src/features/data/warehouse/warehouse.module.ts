import { Module } from '@nestjs/common'
import { WarehouseService } from './warehouse.service.js'
import { WarehouseController } from './warehouse.controller.js'

@Module({
  controllers: [WarehouseController],
  providers: [WarehouseService],
  exports: [WarehouseService],
})
export class WarehouseModule {}
