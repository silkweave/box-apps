// On-demand chat backup to the same private GCS bucket as the warehouse. chat.db is the
// instance's small hot per-user state - chat itself, plus the notification watermarks and
// dismissals - it never travels by git and nothing else copies it anywhere (chat Track 12).
//
// Layout in the bucket, beside the warehouse's prefix:
//   chat/chat-<date>.sqlite   point-in-time snapshot (one per run date)
//   chat/chat-latest.sqlite   pointer to the newest
//
// The local copy is taken with VACUUM INTO, never cp: under WAL a copied .db opens perfectly
// clean and is silently missing every commit still in chat.db-wal - a backup that restores
// without complaint and has lost the last hour. Going through the process-wide store keeps the
// snapshot on the same connection as live writes, so it serializes with them.

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { chatPath } from './paths.js'
import { todayUtc } from '../../ops/types.js'
import { assertGcsBucketReachable, gcsBucketName, type BackupResult } from '../../warehouse/backup.js'
import { chatStore } from './store.js'

/** Snapshot chat.db (VACUUM INTO) and upload it to GCS as a dated snapshot + a `latest` pointer. */
export function backupChat(opts: { dryRun?: boolean } = {}): BackupResult {
  const dryRun = opts.dryRun ?? false
  const date = todayUtc()
  const bucket = gcsBucketName()
  const gs = `gs://${bucket}`
  const snapshot = `${gs}/chat/chat-${date}.sqlite`

  if (dryRun) return { bucket, snapshot, dryRun, summary: `dry run - would back up chat.db to ${snapshot}` }

  // Refuse rather than manufacture: chatStore() would happily CREATE an empty database at
  // chatPath(), and backing that up would overwrite `latest` with nothing.
  if (!existsSync(chatPath())) throw new Error(`no chat database at ${chatPath()}`)
  assertGcsBucketReachable(gs)

  const local = `${chatPath()}.backup-tmp`
  rmSync(local, { force: true }) // a leftover from a crashed run - VACUUM INTO refuses to overwrite
  chatStore().backupTo(local)
  try {
    execFileSync('gsutil', ['cp', local, snapshot], { stdio: 'pipe' })
    execFileSync('gsutil', ['cp', local, `${gs}/chat/chat-latest.sqlite`], { stdio: 'pipe' })
  } finally {
    rmSync(local, { force: true })
  }

  return { bucket, snapshot, dryRun, summary: `backed up chat.db → ${snapshot}` }
}
