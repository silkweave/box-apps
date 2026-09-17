import { Module } from '@nestjs/common'
import { SinkController } from './sink.controller.js'

@Module({
  controllers: [SinkController],
})
export class SinkModule {}
