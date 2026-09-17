// Access to the tenant voice-style layer (data/docs/identity/) for remote MCP sessions and, since
// 2026-08-12, for Settings → Channels. The voice markdown files are the enforceable style contract
// the content skills check drafts against; a session without the repo on disk (plugin-installed
// skills on another machine) reads them through the `voice-read` tool instead (added 2026-07-20 for
// remote operation), and writes them back through `voice-write`. The files stay markdown ON DISK
// under the Box instance rather than moving into the warehouse: /draft-content and /verify-content
// read them directly from a checkout, they want a diff and a git history, and a style rule is a
// document. Layering:
// voice-guide.md (stance) → voice/global.md → voice/@<author>.md → voice/<channel>.md →
// voice/<channel>@<author>.md.
//
// The person layer `voice/@<author>.md` was added 2026-08-05. An author writes in one language
// whatever the channel, and only the application of it moves (a professional register on LinkedIn,
// an enthusiast one on reddit), so the sentence habits belong in one file rather than copied into
// every `<channel>@<author>.md` and left to drift. It resolves BEFORE the channel file on purpose:
// a channel's rules are mechanical (length, formatting, what the platform renders) and must win
// over a personal habit where the two disagree.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { docsDir, instanceRelative } from '../../io.js'

export interface VoiceFile {
  /** Instance-relative path (e.g. docs/identity/voice/linkedin@dan.md). */
  path: string
  exists: boolean
  /** File body; empty string when the file does not exist (a missing overlay is legal). */
  content: string
}

/** One layer segment: lowercase, digits, dashes; must start alphanumeric (linkedin-article, dan). */
const SEG = /^[a-z0-9][a-z0-9-]*$/

function identityDir(): string {
  return join(docsDir(), 'identity')
}

function readOne(rel: string): VoiceFile {
  const abs = resolve(identityDir(), rel)
  // Defense in depth: segments are regex-validated, but re-check containment like planning/docs.ts.
  if (!abs.startsWith(identityDir() + sep)) throw new Error(`refusing to read outside identity/: ${abs}`)
  const exists = existsSync(abs)
  return { path: instanceRelative(abs), exists, content: exists ? readFileSync(abs, 'utf8') : '' }
}

/**
 * The applicable voice-style layers, most general first. Always returns the stance + global layer;
 * `author` adds the person layer (`@<author>.md`, channel-independent), `channel` adds the channel
 * file, and the two together add the author overlay. Missing files come back with `exists: false`
 * rather than erroring - the channel layer alone is a legal configuration and the caller decides
 * what a gap means. `author` alone is legal too: it answers "how does this person write", which is
 * a question worth asking without picking a channel first.
 */
export function readVoiceStyles(channel?: string, author?: string): VoiceFile[] {
  const files: VoiceFile[] = [readOne('voice-guide.md'), readOne(join('voice', 'global.md'))]
  if (author) {
    if (!SEG.test(author)) throw new Error(`invalid author "${author}" (use a-z, 0-9, -)`)
    files.push(readOne(join('voice', `@${author}.md`)))
  }
  if (channel) {
    if (!SEG.test(channel)) throw new Error(`invalid channel "${channel}" (use a-z, 0-9, -)`)
    files.push(readOne(join('voice', `${channel}.md`)))
    if (author) files.push(readOne(join('voice', `${channel}@${author}.md`)))
  }
  return files
}

/** One layer, named by the parts that identify it rather than by a path - the editor picks a channel
 *  and an author, never a filename. `channel: null` + `author: null` is `voice/global.md`. */
export interface VoiceLayerRef {
  /** A ContentChannel, or null for a channel-independent layer. */
  channel?: string | null
  /** A users.id (or `company` for the company page), or null for the channel's own file. */
  author?: string | null
}

/** The `voice/` file one ref names, relative to `identity/`. The stance file (`voice-guide.md`) is
 *  deliberately NOT addressable here: it is the argument behind the rules, not a rule, and it is
 *  edited as a document in the repo. */
function layerPath(ref: VoiceLayerRef): string {
  const channel = ref.channel?.trim() || null
  const author = ref.author?.trim() || null
  if (channel && !SEG.test(channel)) throw new Error(`invalid channel "${channel}" (use a-z, 0-9, -)`)
  if (author && !SEG.test(author)) throw new Error(`invalid author "${author}" (use a-z, 0-9, -)`)
  if (!channel && !author) return join('voice', 'global.md')
  if (!channel) return join('voice', `@${author}.md`)
  return join('voice', author ? `${channel}@${author}.md` : `${channel}.md`)
}

/** Read one addressable layer (missing = `exists: false`, empty body - a missing overlay is legal). */
export function readVoiceLayer(ref: VoiceLayerRef): VoiceFile {
  return readOne(layerPath(ref))
}

/**
 * Write one layer, creating it if it does not exist yet. Writing an EMPTY body is legal and means
 * "this layer says nothing" - it is kept as an empty file rather than deleted, because a file that
 * exists is how the editor shows a layer somebody deliberately cleared, and deleting on empty would
 * make "select all, delete, save" indistinguishable from never having written it.
 */
export function writeVoiceLayer(ref: VoiceLayerRef, content: string): VoiceFile {
  const rel = layerPath(ref)
  const abs = resolve(identityDir(), rel)
  if (!abs.startsWith(identityDir() + sep)) throw new Error(`refusing to write outside identity/: ${abs}`)
  mkdirSync(dirname(abs), { recursive: true })
  // Normalize the trailing newline the way every other doc write here does - a markdown file with no
  // final newline shows up as a whole-file diff the next time anything appends to it.
  writeFileSync(abs, content.endsWith('\n') || content === '' ? content : `${content}\n`, 'utf8')
  return readOne(rel)
}

/** Every layer file on disk, parsed back into the (channel, author) pair that names it. Drives the
 *  Channels editor's inventory: which overlays exist today, without the client guessing filenames. */
export function listVoiceLayers(): (VoiceLayerRef & { path: string; bytes: number })[] {
  const dir = join(identityDir(), 'voice')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => {
      const stem = e.name.slice(0, -3)
      const at = stem.indexOf('@')
      const channel = at === -1 ? stem : stem.slice(0, at)
      const author = at === -1 ? null : stem.slice(at + 1)
      return {
        channel: channel === 'global' ? null : channel || null,
        author,
        path: instanceRelative(join(dir, e.name)),
        bytes: readFileSync(join(dir, e.name), 'utf8').length,
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}
