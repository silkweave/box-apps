// Filesystem-backed markdown docs for initiatives + tasks. The structured state lives in DuckDB; the
// long-form doc body lives on disk under docs/initiatives/, addressed by slug so the path is a pure
// function of the id (decided 2026-06-24):
//   • initiative `silkweave-pr-targets`            → docs/initiatives/silkweave-pr-targets.md
//   • task        `silkweave-pr-targets/invoicerr` → docs/initiatives/silkweave-pr-targets/invoicerr.md
// Paths are derived only from validated slugs and re-checked to stay inside the base dir (no traversal).

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { docsDir, editorUri, instanceRelative } from '../../io.js'

export type DocKind = 'initiative' | 'task'

export interface PlanningDoc {
  /** Repo-relative path (e.g. docs/initiatives/silkweave-pr-targets/invoicerr.md). */
  path: string
  content: string
  exists: boolean
  /** VS Code deep link that opens the doc from the dashboard (Remote-SSH aware - see io.editorUri). */
  editorUri: string
}

/** One path segment: lowercase, digits, dashes; must start alphanumeric. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/

function base(): string {
  return join(docsDir(), 'initiatives')
}

/** Validate a slug segment or throw. */
function slug(s: string, label: string): string {
  if (!SLUG.test(s)) throw new Error(`invalid ${label} slug "${s}" (use a-z, 0-9, -)`)
  return s
}

/** Absolute on-disk path for a doc, validated to live inside docs/initiatives/. */
function absPath(kind: DocKind, id: string): string {
  let rel: string
  if (kind === 'initiative') {
    rel = `${slug(id, 'initiative')}.md`
  } else {
    const parts = id.split('/')
    if (parts.length !== 2) throw new Error(`task id "${id}" must be "<initiative>/<task>"`)
    rel = join(slug(parts[0], 'initiative'), `${slug(parts[1], 'task')}.md`)
  }
  const abs = resolve(base(), rel)
  // Defense in depth: the resolved path must stay within the base directory.
  if (abs !== resolve(base(), rel) || !abs.startsWith(base() + sep)) {
    throw new Error(`refusing to access path outside docs/initiatives: ${abs}`)
  }
  return abs
}

/** Repo-relative path (for display / the doc_path convention), without touching disk. */
export function planningDocPath(kind: DocKind, id: string): string {
  return instanceRelative(absPath(kind, id))
}

/** Read a doc; returns empty content (exists:false) when no file has been written yet. */
export function readPlanningDoc(kind: DocKind, id: string): PlanningDoc {
  const abs = absPath(kind, id)
  const exists = existsSync(abs)
  return {
    path: instanceRelative(abs),
    content: exists ? readFileSync(abs, 'utf8') : '',
    exists,
    editorUri: editorUri(abs),
  }
}

/** Write a doc (creating the initiative folder as needed). Returns the repo-relative path. */
export function writePlanningDoc(kind: DocKind, id: string, content: string): PlanningDoc {
  const abs = absPath(kind, id)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return { path: instanceRelative(abs), content, exists: true, editorUri: editorUri(abs) }
}

/**
 * Move a doc file when its id changes (e.g. a task re-keyed to a new initiative). No-op if no file was
 * ever written for the source. Refuses to clobber an existing destination. Both ids are slug-validated
 * and traversal-checked via absPath.
 */
export function movePlanningDoc(kind: DocKind, fromId: string, toId: string): void {
  // The SOURCE is allowed to be unaddressable. A task id that is not a `<initiative>/<task>` slug
  // path has no doc path, so by definition it has no doc to move - and the whole point of re-keying
  // such a row is to give it one. Throwing here made the repair impossible: rekeyTask writes the row
  // first and moves the doc second, so a legacy bare id left the row re-keyed and the call in
  // pieces. The DESTINATION still validates, because writing outside docs/initiatives is the thing
  // absPath exists to prevent.
  let from: string
  try {
    from = absPath(kind, fromId)
  } catch {
    return
  }
  const to = absPath(kind, toId)
  if (from === to || !existsSync(from)) return
  if (existsSync(to)) throw new Error(`refusing to move doc: destination already exists (${instanceRelative(to)})`)
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
}

/**
 * Remove an initiative's task-doc folder (`docs/initiatives/<id>/`) if it's now empty - used after an
 * initiative slug rename moves every task doc out of the old folder. No-op if missing or non-empty.
 */
export function removeEmptyInitiativeDir(initiativeId: string): void {
  const dir = join(base(), slug(initiativeId, 'initiative'))
  if (!existsSync(dir)) return
  try {
    rmdirSync(dir) // throws ENOTEMPTY when other docs remain - intentionally left in place
  } catch {
    /* non-empty or otherwise in use: leave it */
  }
}

// --- the summary, derived --------------------------------------------------------------------
//
// A planning row's `summary` stopped being a field anyone types on 2026-08-24. It was a plain-text
// box sitting next to a markdown doc that said the same thing, and the two drifted the moment either
// was edited. The doc is now the only place the prose lives; `summary` is a CACHE of the doc's first
// paragraph, refreshed on every doc save (see `savePlanningDoc`), so the board's one-line context
// under each title costs no filesystem read and can never disagree with what the doc says.

/** Lines that are structure rather than prose - skipped when hunting for the first paragraph. */
const SKIPPABLE = [
  /^#{1,6}\s/, // an ATX heading
  /^>\s?/, // a blockquote
  /^(\*\*\*|---|___)\s*$/, // a rule
  /^\s*(<!--|<)/, // html / a comment
  /^\*\*[^*]+:\*\*/, // a metadata line: **Status:** …, **Owner:** …
  /^(```|~~~)/, // a fence
  /^\s*[-*+]\s/, // a bullet
  /^\s*\d+\.\s/, // an ordered item
  /^\|/, // a table row
]

/** Strip the inline markdown that would read as punctuation noise in a one-line preview. */
function plain(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** How much of a doc reads as a summary. Long enough to be a sentence, short enough to be a row. */
const SUMMARY_MAX = 240

/**
 * The first real paragraph of a markdown doc, flattened to one line - frontmatter, headings, rules,
 * `**Status:**`-style metadata lines and code fences skipped. Empty when the doc has no prose yet.
 */
export function docSummary(content: string): string {
  let body = content
  // YAML frontmatter, when the doc opens with it.
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body)
  if (fm) body = body.slice(fm[0].length)

  const lines = body.split(/\r?\n/)
  const para: string[] = []
  let fenced = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (para.length === 0) {
      if (line === '' || SKIPPABLE.some((re) => re.test(line))) continue
      para.push(line)
      continue
    }
    // Inside the paragraph now: it ends at the first blank line or structural line.
    if (line === '' || SKIPPABLE.some((re) => re.test(line))) break
    para.push(line)
  }

  const text = plain(para.join(' '))
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : text
}

/**
 * Put a legacy `summary` at the very top of a doc, once. Used by the 013 migration that moved every
 * stored summary into its doc; a no-op when the doc already opens with that text, so a re-run (or a
 * second checkout pointed at the same tenant) cannot duplicate it.
 */
export function prependSummary(content: string, summary: string): string {
  const text = summary.trim()
  if (!text) return content
  if (content.trimStart().startsWith(text)) return content
  return content.trim() === '' ? `${text}\n` : `${text}\n\n${content.trimStart()}`
}
