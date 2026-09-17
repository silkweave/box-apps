// Content-addressed blob storage for chat attachments (Track 11). The bytes live on DISK, never
// in chat.db - a SQLite file holding screenshots is a backup problem (every VACUUM INTO snapshot
// would carry them) and a WAL problem (one paste becomes one huge write transaction) - and never
// in the warehouse. The layout matches how `data/` already treats big binary state: beside the
// database, addressed by content, and never travelling by git (`chat-uploads/` is in the tenant
// repo's .gitignore alongside chat.db itself).
//
// Layout: `<dir>/<sha256[0..2]>/<sha256>` - a two-hex-char fan-out, the git-objects shape, so no
// single directory grows unboundedly. No file extension on purpose: the name IS the content hash,
// and the mime type is row data in chat.db (one blob can back a `.png` and a `.PNG` and a
// misnamed `.jpg` at once - dedup means the name must not encode any one uploader's opinion).
//
// Everything here is SYNCHRONOUS on purpose. better-sqlite3 is synchronous, so keeping the fs half
// synchronous too means a row write and its blob write happen in one uninterrupted event-loop
// tick - no await point where a sweep or a concurrent upload could interleave. That is the
// in-process atomicity the GC reasoning in store.ts leans on (see gcAttachmentBlobs).

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Suffix marker for in-flight writes; reconcileBlobs treats stale ones as crash debris. */
const TMP_MARKER = '.tmp-'

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Where a blob lives (whether or not it exists yet). */
export function blobPath(dir: string, sha256: string): string {
  return join(dir, sha256.slice(0, 2), sha256)
}

/**
 * Write a blob at its content address, idempotently. Write-to-temp + rename, never a direct
 * write: rename is atomic on one filesystem, so the content address either holds the COMPLETE
 * bytes or nothing - a reader can never stream a half-written file. An existing blob is left
 * alone (same address = same content by construction; rewriting it buys nothing and would race
 * an in-flight read).
 */
export function writeBlob(dir: string, sha256: string, bytes: Buffer): void {
  const target = blobPath(dir, sha256)
  if (existsSync(target)) return
  mkdirSync(join(dir, sha256.slice(0, 2)), { recursive: true })
  const tmp = `${target}${TMP_MARKER}${randomUUID()}`
  writeFileSync(tmp, bytes)
  renameSync(tmp, target)
}

/** Delete a blob if present. Idempotent - the GC path may race a crash-recovery sweep. */
export function deleteBlob(dir: string, sha256: string): void {
  rmSync(blobPath(dir, sha256), { force: true })
}

/**
 * Walk the blob directory and report what is actually on disk, separating real blobs from stale
 * temp files (an interrupted writeBlob leaves a `.tmp-<uuid>` behind; anything older than
 * `tmpCutoffMs` cannot still be in flight, because writes are synchronous). This is the sweeper's
 * reconciliation source: rows are the truth about which blobs must LIVE, the directory is the
 * truth about which blobs EXIST, and the difference is garbage.
 */
export function listBlobs(dir: string, tmpCutoffMs: number): { blobs: string[]; staleTmp: string[] } {
  const blobs: string[] = []
  const staleTmp: string[] = []
  if (!existsSync(dir)) return { blobs, staleTmp }
  for (const prefix of readdirSync(dir)) {
    const prefixDir = join(dir, prefix)
    let names: string[]
    try {
      names = readdirSync(prefixDir)
    } catch {
      continue // a plain file at the prefix level is not ours; leave it alone
    }
    for (const name of names) {
      const tmpAt = name.indexOf(TMP_MARKER)
      if (tmpAt === -1) {
        blobs.push(name)
        continue
      }
      try {
        if (statSync(join(prefixDir, name)).mtimeMs < tmpCutoffMs) staleTmp.push(join(prefix, name))
      } catch {
        /* raced its own cleanup - already gone */
      }
    }
  }
  return { blobs, staleTmp }
}

/** Remove a stale temp file by its dir-relative path (as listBlobs reported it). */
export function deleteStaleTmp(dir: string, relPath: string): void {
  rmSync(join(dir, relPath), { force: true })
}
