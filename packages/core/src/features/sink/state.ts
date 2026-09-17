// The "sink" - a filesystem inbox under docs/sink/ for any doc that needs processing by a Claude
// Code session (a chat export, a research dump, a raw post idea). Each is a flat markdown file;
// `/ingest-sink <file>` picks one up and routes it (v1: post-idea → initiative). This module is the
// dashboard's read/write access to that folder. Paths are derived only from a validated filename and
// re-checked to stay inside docs/sink/ (no traversal) - mirrors planning/docs.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { docsDir, editorUri, instanceRelative } from '../../io.js'

export interface SinkDocMeta {
  /** Filename including extension, e.g. `post-idea-claude-max-plan.md`. */
  name: string
  /** Repo-relative path (docs/sink/<name>). */
  path: string
  /** Byte size on disk. */
  bytes: number
  /** Last-modified time, ISO string. */
  modified: string
  /** A short flattened preview of the body - drives the dashboard's card grid. */
  excerpt: string
}

export interface SinkDoc {
  name: string
  path: string
  content: string
  exists: boolean
  /** VS Code deep link that opens the doc from the dashboard (Remote-SSH aware - see io.editorUri). */
  editorUri: string
}

/** A sink filename: lowercase/digits start, then word chars/dot/dash, ending in `.md`. */
const NAME = /^[a-z0-9][a-z0-9._-]*\.md$/

function base(): string {
  return join(docsDir(), 'sink')
}

/** Validate a filename + resolve to an absolute path proven to live inside docs/sink/. */
function absPath(name: string): string {
  if (!NAME.test(name)) throw new Error(`invalid sink filename "${name}" (use a-z, 0-9, . _ - and a .md extension)`)
  const abs = resolve(base(), name)
  if (!abs.startsWith(base() + sep)) throw new Error(`refusing to access path outside docs/sink: ${abs}`)
  return abs
}


/**
 * List the processable sink docs: top-level `*.md` files only. Skips `README.md` and any
 * `_`-prefixed name (e.g. the `_done/` archive folder), so the list is exactly the queue. Newest
 * first by mtime.
 */
export function listSinkDocs(): SinkDocMeta[] {
  const dir = base()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md' && !e.name.startsWith('_'))
    .map((e) => {
      const abs = join(dir, e.name)
      const st = statSync(abs)
      return {
        name: e.name,
        path: instanceRelative(abs),
        bytes: st.size,
        modified: st.mtime.toISOString(),
        excerpt: excerptOf(abs),
      }
    })
    .sort((a, b) => b.modified.localeCompare(a.modified))
}

/** A short, flattened preview of a doc's body (frontmatter + markdown syntax stripped). */
function excerptOf(abs: string): string {
  try {
    const body = readFileSync(abs, 'utf8').replace(/^---\n[\s\S]*?\n---\n?/, '')
    return body.replace(/[#>*_`~[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180)
  } catch {
    return ''
  }
}

/** Read a sink doc; returns empty content (exists:false) when no file is there yet. */
export function readSinkDoc(name: string): SinkDoc {
  const abs = absPath(name)
  const exists = existsSync(abs)
  return {
    name,
    path: instanceRelative(abs),
    content: exists ? readFileSync(abs, 'utf8') : '',
    exists,
    editorUri: editorUri(abs),
  }
}

/** Write a sink doc (creating docs/sink/ as needed). The autosave target for the dashboard editor. */
export function writeSinkDoc(name: string, content: string): SinkDoc {
  const abs = absPath(name)
  mkdirSync(base(), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return { name, path: instanceRelative(abs), content, exists: true, editorUri: editorUri(abs) }
}

/** Create a new sink doc. Refuses to clobber an existing file (use writeSinkDoc to overwrite). */
export function createSinkDoc(name: string, content = ''): SinkDoc {
  const abs = absPath(name)
  if (existsSync(abs)) throw new Error(`sink doc "${name}" already exists`)
  return writeSinkDoc(name, content)
}

/** Delete a sink doc from the queue. Safe if the file is already gone; errors only on a bad name. */
export function deleteSinkDoc(name: string): void {
  const abs = absPath(name)
  if (existsSync(abs)) unlinkSync(abs)
}
