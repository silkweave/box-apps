import { Module, type OnModuleInit } from '@nestjs/common'
import { onContentPublished, onEvent } from '@silkweave/box-core'
import { PodsController } from './pods.controller.js'
import { PodsSelfController } from './pods-self.controller.js'

@Module({
  controllers: [PodsController, PodsSelfController],
})
export class PodsModule implements OnModuleInit {
  onModuleInit(): void {
    // Engagement depends on content: a published piece (content.published on the events spine)
    // is pushed into the configured pod. Content does not know pods exist.
    onEvent(onContentPublished)
  }
}
