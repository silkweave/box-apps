import { Module } from '@nestjs/common'
import { defineServerFeature } from '../../feature.js'
import { ContentModule } from './content/content.module.js'
import { ChannelsController } from './channels/channels.controller.js'

/** Topics, pieces, channel profiles and voice. */
@Module({
  imports: [ContentModule],
  controllers: [ChannelsController],
})
class ContentFeatureModule {}

export default defineServerFeature({
  id: 'content',
  module: ContentFeatureModule,
  env: [
    { name: 'LINKEDIN_PUBLISH_LIVE', doc: '1 to let the scheduled LinkedIn publisher post for real (dry-run otherwise)' },
    { name: 'SUBSTACK_PUBLISH_LIVE', doc: '1 to let the scheduled Substack publisher post for real (dry-run otherwise)' },
  ],
})
