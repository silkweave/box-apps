// Filesystem-backed markdown bodies for content pieces. The structured lifecycle lives in DuckDB; the
// narrative body lives on disk under docs/content/, addressed by the piece id (a slug path) so the path
// is a pure function of the id:
//   • piece `claude-max-5x-vs-20x/reddit` → docs/content/claude-max-5x-vs-20x/reddit.md
// Paths are derived only from validated slugs and re-checked to stay inside the base dir (no traversal).
// Mirrors src/core/planning/docs.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { docsDir, editorUri, instanceRelative } from '../../io.js'

export interface ContentDoc {
  /** Repo-relative path (e.g. docs/content/claude-max-5x-vs-20x/reddit.md). */
  path: string
  content: string
  exists: boolean
  /** VS Code deep link that opens the body from the dashboard (Remote-SSH aware - see io.editorUri). */
  editorUri: string
}

/** One path segment: lowercase, digits, dashes; must start alphanumeric. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/

function base(): string {
  return join(docsDir(), 'content')
}

function slug(s: string, label: string): string {
  if (!SLUG.test(s)) throw new Error(`invalid ${label} slug "${s}" (use a-z, 0-9, -)`)
  return s
}

/** Absolute on-disk path for a piece body, validated to live inside docs/content/. */
function absPath(id: string): string {
  const parts = id.split('/')
  if (parts.length !== 2) throw new Error(`content id "${id}" must be "<topic>/<channel>"`)
  const rel = join(slug(parts[0], 'topic'), `${slug(parts[1], 'channel')}.md`)
  const abs = resolve(base(), rel)
  if (!abs.startsWith(base() + sep)) {
    throw new Error(`refusing to access path outside docs/content: ${abs}`)
  }
  return abs
}

/** Repo-relative path (for the body_path convention), without touching disk. */
export function contentDocPath(id: string): string {
  return instanceRelative(absPath(id))
}

/** Read a piece body; returns empty content (exists:false) when no file has been written yet. */
export function readContentDoc(id: string): ContentDoc {
  const abs = absPath(id)
  const exists = existsSync(abs)
  return {
    path: instanceRelative(abs),
    content: exists ? readFileSync(abs, 'utf8') : '',
    exists,
    editorUri: editorUri(abs),
  }
}

/** Write a piece body (creating the topic folder as needed). Returns the repo-relative path. */
export function writeContentDoc(id: string, content: string): ContentDoc {
  const abs = absPath(id)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return { path: instanceRelative(abs), content, exists: true, editorUri: editorUri(abs) }
}

/**
 * Read one scalar field out of a doc's leading YAML frontmatter block (e.g. `author`). Returns
 * undefined when there's no frontmatter block or the key isn't present - callers fall back from
 * there. Deliberately dumb (single-line `key: value`, matching the writer in
 * syncContentDocFrontmatter below) - frontmatter here is a small, hand-authored key set, not
 * general YAML.
 */
export function readFrontmatterField(content: string, key: string): string | undefined {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return undefined
    const m = lines[i].match(/^([A-Za-z0-9_-]+):(\s*)(.*)$/)
    if (m && m[1] === key) return m[3].trim().replace(/^"(.*)"$/, '$1')
  }
  return undefined
}

// --- frontmatter write-back (warehouse → on-disk YAML) --------------------------------------------

/** Metadata keys mirrored from the warehouse row into the doc frontmatter on every lifecycle write. */
const FRONTMATTER_METADATA_KEYS = ['flair', 'subreddit', 'author'] as const

/** YAML-encode a scalar, reusing the previous line's quote style; quote only when a plain scalar is unsafe. */
function formatYamlValue(value: string, previousRaw: string): string {
  const wasQuoted = /^".*"$/.test(previousRaw.trim())
  if (wasQuoted) return JSON.stringify(value)
  if (value === '' || /^[\s]|[\s]$|: |:$|^[#&*!|>%@`"'-]/.test(value)) return JSON.stringify(value)
  return value
}

/**
 * Mirror the authoritative lifecycle fields (status, title, and a few channel metadata keys) from the
 * warehouse row back into the body's leading YAML frontmatter, so the on-disk `status:`/`title:`/`flair:`
 * never drift from the app (e.g. a title edited in the dashboard must reach the markdown). No-op when
 * there is no file yet or no frontmatter block. Only rewrites keys that already exist in the
 * frontmatter, except `status`, which is always kept current (inserted if missing). `title` is synced
 * only when non-empty, so a create with a blank title never blanks an authored heading. Kept
 * best-effort by the caller: a doc that can't be synced must never fail the warehouse write.
 */
export function syncContentDocFrontmatter(
  id: string,
  fields: { status: string; title?: string; metadata: Record<string, unknown> },
): boolean {
  const abs = absPath(id)
  if (!existsSync(abs)) return false
  const raw = readFileSync(abs, 'utf8')
  const lines = raw.split('\n')
  if (lines[0]?.trim() !== '---') return false
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return false

  const desired: Record<string, string> = { status: fields.status }
  // title is a top-level column (not metadata); only mirror it when it carries a real value.
  if (typeof fields.title === 'string' && fields.title.length > 0) desired.title = fields.title
  for (const k of FRONTMATTER_METADATA_KEYS) {
    const v = fields.metadata[k]
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') desired[k] = String(v)
  }

  let changed = false
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):(\s*)(.*)$/)
    if (!m || !(m[1] in desired)) continue
    const next = `${m[1]}: ${formatYamlValue(desired[m[1]], m[3])}`
    if (lines[i] !== next) {
      lines[i] = next
      changed = true
    }
    delete desired[m[1]]
  }
  // status is authoritative and must always be present; add it at the top of the block if the doc lacked it.
  if ('status' in desired) {
    lines.splice(1, 0, `status: ${formatYamlValue(desired.status, '')}`)
    changed = true
  }
  if (changed) writeFileSync(abs, lines.join('\n'), 'utf8')
  return changed
}

// --- assets (media files referenced by metadata.assets) -------------------------------------------

/** One flat filename: no separators/traversal, must start alphanumeric, needs an extension. */
const ASSET_FILE = /^[a-zA-Z0-9][a-zA-Z0-9._ -]*\.[a-zA-Z0-9]+$/

/** Media types the asset route serves; anything else is refused. */
const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
}

/**
 * Absolute on-disk path + mime for an asset file in a topic's folder, validated the same way
 * piece bodies are (slug + flat filename, re-checked to stay inside docs/content/). Throws on an
 * unknown extension or a missing file.
 */
export function contentAssetFile(topicId: string, file: string): { abs: string; mime: string } {
  if (!ASSET_FILE.test(file) || file.includes('..')) throw new Error(`invalid asset filename "${file}"`)
  const mime = ASSET_MIME[extname(file).toLowerCase()]
  if (!mime) throw new Error(`unsupported asset type "${extname(file)}"`)
  const abs = resolve(base(), slug(topicId, 'topic'), file)
  if (!abs.startsWith(base() + sep)) throw new Error(`refusing to access path outside docs/content: ${abs}`)
  if (!existsSync(abs)) throw new Error(`no asset "${file}" in docs/content/${topicId}/`)
  return { abs, mime }
}

/** List the servable asset files (by extension) in a topic's folder, for the dashboard picker. */
export function listContentAssets(topicId: string): string[] {
  const dir = join(base(), slug(topicId, 'topic'))
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => ASSET_FILE.test(f) && ASSET_MIME[extname(f).toLowerCase()] !== undefined)
    .sort()
}
