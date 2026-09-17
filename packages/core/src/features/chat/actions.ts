import { todayUtc, type ActionSpec, type IngestProgress } from '../../ops/types.js'
import { backupChat } from './backup.js'

async function* chatBackupAction(): AsyncGenerator<IngestProgress> {
  yield { channel: 'chat', phase: 'start', message: 'backing up chat.db to GCS' }
  const res = backupChat()
  yield { channel: 'chat', phase: 'done', message: res.summary, result: { channel: 'chat', date: todayUtc(), summary: res.summary } }
}

export const CHAT_ACTIONS: ActionSpec[] = [
  { id: 'chat-backup', label: 'Chat backup', group: 'Warehouse', description: 'Snapshot chat.db (VACUUM INTO) to the private GCS bucket', run: chatBackupAction },
]
