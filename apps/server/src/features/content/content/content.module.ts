import { Module, type OnModuleInit } from '@nestjs/common'
import { deriveContentSignals, publishedLinkedinPosts, registerLinkedinPostSource, registerSignalHooks } from '@silkweave/box-core'
import { ContentController } from './content.controller.js'

@Module({
  controllers: [ContentController],
})
export class ContentModule implements OnModuleInit {
  onModuleInit(): void {
    // Content depends on data; it registers its outcome derive and tells the LinkedIn pull which
    // published posts to fetch per-post analytics for.
    registerSignalHooks({ id: 'content', derive: deriveContentSignals })
    registerLinkedinPostSource(publishedLinkedinPosts)
  }
}
