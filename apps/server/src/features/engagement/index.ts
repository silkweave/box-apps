import { Module } from '@nestjs/common'
import { defineServerFeature } from '../../feature.js'
import { PodsModule } from './pods/pods.module.js'
import { InboxModule } from './inbox/inbox.module.js'

/** Engagement pods and the tactical inbox. */
@Module({ imports: [PodsModule, InboxModule] })
class EngagementModule {}

export default defineServerFeature({ id: 'engagement', module: EngagementModule })
