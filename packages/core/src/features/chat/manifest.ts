import { defineCoreFeature } from '../../feature.js'
import { CHAT_ACTIONS } from './actions.js'

/** Team chat: rooms, threads, mentions, reactions, the agent's seat. Its store is its own SQLite
 *  file (chat.db) with its own migration chain (migrations.ts), so it owns no warehouse tables. */
export default defineCoreFeature({
  id: 'chat',
  models: [],
  migrations: [],
  actions: CHAT_ACTIONS,
})
