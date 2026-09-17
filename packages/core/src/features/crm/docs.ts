// Filesystem-backed markdown docs for CRM accounts. The structured row lives in DuckDB; the
// operator's prose lives on disk under docs/crm/, addressed by the account id (already a slug -
// see CRM_ACCOUNTS in warehouse/models.ts) so the path is a pure function of the id:
//   • account `acme-leeds` → docs/crm/acme-leeds.md
// Paths are derived only from validated slugs and re-checked to stay inside the base dir (no
// traversal). Mirrors planning/docs.ts, the way content/docs.ts already adapted it once.
//
// THE FORMAT - one file, two ATX-heading sections:
//
//   ---              (optional YAML frontmatter, tolerated because every sibling doc kind has one)
//   ...
//   ---
//   ## Next move
//
//   Chase Mark for the Friday slot.       ← the NEXT-ACTION block
//
//   ## Notes
//
//   Demo held 5 Jun. Strong call...       ← NOTES: everything from here on, free-form markdown
//
// Why headings: the delimiter has to survive a TipTap round trip (the editor loads the markdown,
// the user types, getMarkdown() autosaves), and this was MEASURED, not reasoned (2026-08-26, the
// initiative/task editor stack: StarterKit + Markdown.configure({ markedOptions: { gfm: true } })):
//   • an HTML comment is parsed and DROPPED - one keystroke deleted it from disk (this file's
//     first delimiter; the claim it survives was false for this stack),
//   • `[//]: # (...)` link-ref comments are dropped too,
//   • `***`/`---` thematic breaks survive but re-serialize as `---`, colliding with the YAML
//     frontmatter form at position 0 and with docSummary's SKIPPABLE rule line,
//   • an ATX heading survives BYTE-IDENTICAL - and TipTap renders it as a real heading, so the
//     reserved block looks like a block with no decoration extension at all.
//
// Decisions, stated because the parse/serialize pair enforces them:
//   • POSITION-ANCHORED: the next-move heading counts only as the FIRST content line after the
//     frontmatter. An innocent `## Next move` typed inside the notes can never re-partition the
//     doc, no matter how tolerant the heading matcher is - position is the guard, not spelling.
//   • The block ends at the FIRST subsequent level-1/2 heading, whatever its text. Canonically
//     that is `## Notes` (structural, excluded from the notes cache); a user heading (say the
//     operator deleted `## Notes` and their notes open with `## Meeting log`) terminates the
//     block just as well and stays part of the notes verbatim. An UNTERMINATED opener is treated
//     as unrecognizable - degradation must blank the next action, never inflate it by swallowing
//     the notes into the kanban column.
//   • TOLERANT ON READ, CANONICAL ON WRITE: the opener matches `#`/`##` + "next move",
//     case-insensitive (a human re-typing the heading is still saying "next move"); level 3+ is
//     NOT matched - TipTap's heading shortcuts make demotion an easy accident and a demoted
//     heading reads as ordinary notes structure. Writers emit the canonical `## Next move` /
//     `## Notes` for any NEW structure but leave a recognized variant's bytes alone.
//   • The block MAY be multi-line markdown - the editor cannot prevent it, so the format does not
//     pretend to. The derived `next_action` COLUMN is the block flattened to one plain-text line
//     (inline markdown and heading marks stripped, docSummary-style): it exists to be a kanban
//     one-liner and a sort key, not a second copy of the prose.
//   • Text before the first heading means the structure is NOT recognized - see failure behaviour.
//   • FAILURE BEHAVIOUR: anything unrecognizable (opener deleted, reworded, re-cased beyond the
//     rule, demoted to ###, unterminated, preceded by stray text) degrades to "no next action,
//     all of it is notes". Parsing only ever PARTITIONS the byte range - no branch can drop or
//     truncate the user's prose.
//   • Canonical docs always carry BOTH headings (even with an empty block), so the panel always
//     has a place to type the next move; but a heading-less doc is fully legal and reads as pure
//     notes, and the update helpers never insert structure just to clear a value.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { docsDir, editorUri, instanceRelative } from '../../io.js'

/** The canonical section headings - what writers emit. Readers are more tolerant (see header). */
export const CRM_DOC_NEXT_HEADING = '## Next move'
export const CRM_DOC_NOTES_HEADING = '## Notes'

/** The retired HTML-comment delimiter (2026-08-26, one day old): TipTap drops HTML comments on
 *  the first keystroke, measured. Kept only so migration 019 can convert docs written with it. */
export const LEGACY_CRM_DOC_SENTINEL = '<!-- next action above / notes below -->'

export interface CrmDoc {
  /** Repo-relative path (e.g. docs/crm/acme-leeds.md). */
  path: string
  content: string
  exists: boolean
  /** VS Code deep link that opens the doc from the dashboard (Remote-SSH aware - see io.editorUri). */
  editorUri: string
}

/** One path segment: lowercase, digits, dashes; must start alphanumeric. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/

function base(): string {
  return join(docsDir(), 'crm')
}

function slug(s: string, label: string): string {
  if (!SLUG.test(s)) throw new Error(`invalid ${label} slug "${s}" (use a-z, 0-9, -)`)
  return s
}

/** Absolute on-disk path for an account doc, validated to live inside docs/crm/. */
function absPath(accountId: string): string {
  const rel = `${slug(accountId, 'crm account')}.md`
  const abs = resolve(base(), rel)
  // Defense in depth: the resolved path must stay within the base directory.
  if (!abs.startsWith(base() + sep)) {
    throw new Error(`refusing to access path outside docs/crm: ${abs}`)
  }
  return abs
}

/** Repo-relative path (for display), without touching disk. */
export function crmDocPath(accountId: string): string {
  return instanceRelative(absPath(accountId))
}

/** Read an account doc; returns empty content (exists:false) when no file has been written yet. */
export function readCrmDoc(accountId: string): CrmDoc {
  const abs = absPath(accountId)
  const exists = existsSync(abs)
  return {
    path: instanceRelative(abs),
    content: exists ? readFileSync(abs, 'utf8') : '',
    exists,
    editorUri: editorUri(abs),
  }
}

/** Write an account doc (creating docs/crm/ as needed). Returns the repo-relative path. */
export function writeCrmDoc(accountId: string, content: string): CrmDoc {
  const abs = absPath(accountId)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return { path: instanceRelative(abs), content, exists: true, editorUri: editorUri(abs) }
}

/** Account ids that currently have a doc on disk (slug-named .md files) - migration 019's scan. */
export function listCrmDocIds(): string[] {
  if (!existsSync(base())) return []
  return readdirSync(base())
    .filter((f) => f.endsWith('.md') && SLUG.test(basename(f, '.md')))
    .map((f) => basename(f, '.md'))
    .sort()
}

// --- the reserved block: parse / serialize --------------------------------------------------------

/** Leading YAML frontmatter, when the doc opens with it (the docSummary regex, verbatim). */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

/** The next-move opener, matched on a trimmed line: level 1-2 only, case-insensitive text. */
const NEXT_HEADING = /^#{1,2}\s+next\s+move\s*$/i

/** The structural notes heading, same tolerance. */
const NOTES_HEADING = /^#{1,2}\s+notes\s*$/i

/** Any level-1/2 ATX heading (empty ones included - TipTap emits `##` when the text is deleted). */
const ANY_H2 = /^#{1,2}(\s.*)?$/

/** A line of `body`, with the offsets reassembly needs. `endNl` is just past its newline (or EOF). */
interface Line {
  start: number
  endNl: number
  text: string
}

function lineSpans(body: string): Line[] {
  const out: Line[] = []
  let pos = 0
  while (pos <= body.length) {
    const nl = body.indexOf('\n', pos)
    const end = nl === -1 ? body.length : nl
    out.push({ start: pos, endNl: nl === -1 ? body.length : nl + 1, text: body.slice(pos, end).trim() })
    if (nl === -1) break
    pos = nl + 1
  }
  return out
}

/**
 * The byte-exact partition of a doc. Reassembly invariant: every offset indexes into `body`, and
 * `content === fm + body` always - the helpers below only ever recombine slices of `body`, so no
 * branch can lose a byte.
 *
 *   • 'both'      - opener at top, terminated: a next-action block and a notes region exist.
 *   • 'notes-only'- a top-anchored notes heading with no block above it (hand-made, or a cleared
 *                   doc from before both-headings became canonical): explicit "no next action".
 *   • 'none'      - no recognized structure: the whole body is notes.
 */
interface DocSplit {
  fm: string
  body: string
  kind: 'both' | 'notes-only' | 'none'
  /** Offset of the opener (or notes-only heading) line start; bytes before it are blank lines. */
  headStart: number
  /** Just past the opener line's newline ('both') - where the block's bytes begin. */
  blockStart: number
  /** Terminator line start ('both'). */
  termStart: number
  /** Just past the terminator line's newline ('both'); for 'notes-only', past the heading line. */
  termEnd: number
  /** Terminator matched NOTES_HEADING (structural, excluded from the notes cache). */
  termStructural: boolean
}

function split(content: string): DocSplit {
  const fm = FRONTMATTER.exec(content)?.[0] ?? ''
  const body = content.slice(fm.length)
  const none: DocSplit = {
    fm, body, kind: 'none', headStart: 0, blockStart: 0, termStart: 0, termEnd: 0, termStructural: false,
  }
  const ls = lineSpans(body)
  const first = ls.findIndex((l) => l.text !== '')
  if (first === -1) return none
  const opener = ls[first]
  if (NOTES_HEADING.test(opener.text)) {
    return { ...none, kind: 'notes-only', headStart: opener.start, termEnd: opener.endNl }
  }
  if (!NEXT_HEADING.test(opener.text)) return none
  for (let i = first + 1; i < ls.length; i++) {
    if (!ANY_H2.test(ls[i].text)) continue
    return {
      fm,
      body,
      kind: 'both',
      headStart: opener.start,
      blockStart: opener.endNl,
      termStart: ls[i].start,
      termEnd: ls[i].endNl,
      termStructural: NOTES_HEADING.test(ls[i].text),
    }
  }
  // Opener with no terminating heading: unrecognizable by design - degrading toward "all notes"
  // can only blank the kanban column, never swallow the notes into it.
  return none
}

/** Strip the inline markdown that would read as punctuation noise in a one-line cache value. */
const plainline = (md: string): string =>
  md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()

/** The block flattened to one plain line: comment lines dropped, heading marks stripped, joined. */
const flatten = (md: string): string =>
  plainline(
    md
      .split(/\r?\n/)
      .filter((l) => !/^\s*<!--.*-->\s*$/.test(l))
      .map((l) => l.replace(/^\s*#{1,6}\s+/, ''))
      .join(' '),
  )

/** A column value normalized for the block: whitespace runs (newlines included) become one space. */
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** `fm` ready to prepend when we are about to write content after it. */
const fmPart = (fm: string): string => (fm !== '' && !fm.endsWith('\n') ? `${fm}\n` : fm)

/**
 * Parse a doc into the two derived cache values. `nextAction` is the block flattened to one plain
 * line (empty when the structure is unrecognized - see the failure behaviour in the header);
 * `notes` is the raw markdown of the notes region, trimmed: after the structural notes heading,
 * from a user terminator heading (inclusive - it is their prose), or the whole body when there is
 * no structure. Frontmatter belongs to neither.
 */
export function parseCrmDoc(content: string): { nextAction: string; notes: string } {
  const s = split(content)
  if (s.kind === 'none') return { nextAction: '', notes: s.body.trim() }
  if (s.kind === 'notes-only') return { nextAction: '', notes: s.body.slice(s.termEnd).trim() }
  return {
    nextAction: flatten(s.body.slice(s.blockStart, s.termStart)),
    notes: (s.termStructural ? s.body.slice(s.termEnd) : s.body.slice(s.termStart)).trim(),
  }
}

/**
 * The two regions as RAW markdown - the read side of the dashboard's region save.
 *
 * Identical partition to `parseCrmDoc`, minus the flattening: `parseCrmDoc` returns the next action
 * as the one-line plain-text CACHE value (that is what the column is for), which is the wrong thing
 * to seed an editor with. Round-tripping a block through the flattened form would strip whatever
 * inline markdown the user authored in it the moment they next typed. The panel therefore reads
 * through here and writes through `applyCrmDocRegions`; the column keeps coming from `parseCrmDoc`.
 *
 * Note the write path still collapses the block to one line (`collapse`), so inline marks survive a
 * round trip but paragraph breaks inside the block do not. That is the intended model - the block
 * IS the kanban one-liner - and it is why the panel's top editor disables block-level nodes.
 */
export function readCrmDocRegions(content: string): CrmDocRegions {
  const s = split(content)
  if (s.kind === 'none') return { nextAction: '', notes: s.body.trim() }
  if (s.kind === 'notes-only') return { nextAction: '', notes: s.body.slice(s.termEnd).trim() }
  return {
    nextAction: s.body.slice(s.blockStart, s.termStart).trim(),
    notes: (s.termStructural ? s.body.slice(s.termEnd) : s.body.slice(s.termStart)).trim(),
  }
}

/**
 * Set the next-action block from a plain-text value, disturbing nothing else in the file.
 *   • Same value (compared flattened, so authored markdown in the block survives a cache echo):
 *     the content is returned unchanged, byte for byte.
 *   • 'both': only the bytes BETWEEN the opener line and the terminator line are replaced - a
 *     re-cased opener or a user terminator heading keeps its exact bytes.
 *   • 'notes-only': a canonical opener + block is inserted above the notes heading.
 *   • 'none' + a real value: the full canonical structure is inserted at the top (after any
 *     frontmatter), the existing body becoming the notes verbatim.
 *   • 'none' + '': returned unchanged - clearing an absent block inserts no structure.
 * Setting the same value twice is therefore byte-idempotent.
 */
export function updateCrmDocNextAction(content: string, nextAction: string): string {
  const target = collapse(nextAction)
  const s = split(content)
  if (s.kind === 'none') {
    if (target === '') return content
    const rest = s.body.replace(/^(?:[ \t]*\r?\n)+/, '') // shed leading blank lines, keep the rest verbatim
    return `${fmPart(s.fm)}${CRM_DOC_NEXT_HEADING}\n\n${target}\n\n${CRM_DOC_NOTES_HEADING}\n${rest === '' ? '' : `\n${rest}`}`
  }
  if (s.kind === 'notes-only') {
    if (target === '') return content
    return `${fmPart(s.fm)}${CRM_DOC_NEXT_HEADING}\n\n${target}\n\n${s.body.slice(s.headStart)}`
  }
  if (flatten(s.body.slice(s.blockStart, s.termStart)) === flatten(target)) return content
  return `${s.fm}${s.body.slice(0, s.blockStart)}${target === '' ? '\n' : `\n${target}\n\n`}${s.body.slice(s.termStart)}`
}

/**
 * Replace the notes region from a plain value, preserving the frontmatter and the block byte-exact.
 * Unchanged value (compared trimmed) returns the content untouched, so hand-formatted whitespace
 * never reflows. When the notes region begins at a USER heading (a content terminator), the region
 * - their heading included - is replaced and the canonical notes heading is installed, so the
 * block cannot be left unterminated by a notes write. On an unstructured doc the whole body IS the
 * notes and is replaced; no structure is invented.
 */
export function updateCrmDocNotes(content: string, notes: string): string {
  const target = notes.replace(/\r\n/g, '\n').trim()
  const s = split(content)
  const tailFor = (t: string): string => (t === '' ? '' : `\n${t}\n`)
  if (s.kind === 'none') {
    if (s.body.trim() === target) return content
    return target === '' ? s.fm : `${fmPart(s.fm)}${target}\n`
  }
  if (s.kind === 'notes-only' || s.termStructural) {
    if (s.body.slice(s.termEnd).trim() === target) return content
    const kept = s.body.slice(0, s.termEnd)
    return `${s.fm}${kept.endsWith('\n') ? kept : `${kept}\n`}${tailFor(target)}`
  }
  // 'both' with a user heading as terminator: the region from that heading on IS the notes.
  if (s.body.slice(s.termStart).trim() === target) return content
  return `${s.fm}${s.body.slice(0, s.termStart)}${CRM_DOC_NOTES_HEADING}\n${tailFor(target)}`
}

/** A fresh canonical doc: both headings always, block and notes under them when non-empty. */
export function renderCrmDoc(nextAction: string, notes: string): string {
  const na = collapse(nextAction)
  const body = notes.replace(/\r\n/g, '\n').trim()
  return `${CRM_DOC_NEXT_HEADING}\n${na === '' ? '' : `\n${na}\n`}\n${CRM_DOC_NOTES_HEADING}\n${body === '' ? '' : `\n${body}\n`}`
}

/** The two editing regions of the dashboard's locked-block panel - see applyCrmDocRegions. */
export interface CrmDocRegions {
  nextAction: string
  notes: string
}

/**
 * Apply a region-save from the dashboard panel: both regions onto the doc currently on disk. The
 * panel holds the two headings as app CHROME (the ContentBodyEditor frontmatter-split precedent),
 * so what arrives here is only the content of each region - the structure is asserted by the
 * surface, not typed by the user.
 *
 * Composition of the two update helpers, NEXT ACTION FIRST. The order was checked, not assumed:
 * the four doc kinds all commute in end state (updateCrmDocNotes re-installs `## Notes` when the
 * region began at a user heading, and updateCrmDocNextAction inserts the full structure on an
 * unstructured doc - whichever runs first, the other lands on a recognized doc and the same bytes
 * result). Next-action-first is chosen anyway because it structures the doc EARLY: on a degraded
 * doc it converts the whole body into the notes region verbatim, so the subsequent notes update is
 * a plain in-region replacement instead of a whole-body rewrite - the less destructive path is the
 * one that runs second.
 *
 * Guarantees, in the order they matter:
 *   • UNCHANGED REGIONS ARE A BYTE NO-OP - even on a degraded doc. An open-and-autosave must never
 *     rewrite a hand-authored file's structure behind the user's back; canonicalization is earned
 *     by an actual edit.
 *   • A save that changes anything leaves the doc RECOGNIZED. The helpers already canonicalize
 *     every path except one - an unstructured doc whose next action stayed '' (they never insert
 *     structure just to clear a value) - so that residue is canonicalized here: both headings,
 *     the (already-applied) notes below, no byte of prose dropped or duplicated. This is the
 *     hand-mangled-doc transition: the panel loaded the entire body as notes, the user typed into
 *     the empty top region (or edited the notes), and the file must come out canonical.
 *   • Byte-idempotent: applying the same regions twice equals applying them once.
 */
export function applyCrmDocRegions(content: string, regions: CrmDocRegions): string {
  let out = updateCrmDocNextAction(content, regions.nextAction)
  out = updateCrmDocNotes(out, regions.notes)
  if (out === content) return content
  if (split(out).kind === 'none') {
    const s = split(out)
    out = `${fmPart(s.fm)}${renderCrmDoc(regions.nextAction, s.body)}`
  }
  return out
}

/**
 * Fold legacy COLUMN values into a doc, additively - migration 018's content step, shaped like
 * `prependSummary` was for 013: idempotent by CONTENT, not just by the ledger, because the docs
 * travel in the tenant repo while the migration ledger travels in data.db. A doc that already
 * carries a next action keeps it; a doc that already carries notes keeps them EVEN IF they differ
 * from the column (the doc is the source of truth; the column is a possibly-stale cache by the
 * time a second checkout re-runs this). Only a blank doc is rendered fresh.
 */
export function absorbIntoCrmDoc(content: string, nextAction: string, notes: string): string {
  if (content.trim() === '') {
    return collapse(nextAction) !== '' || notes.trim() !== '' ? renderCrmDoc(nextAction, notes) : content
  }
  let out = content
  if (notes.trim() !== '' && parseCrmDoc(out).notes === '') out = updateCrmDocNotes(out, notes)
  if (collapse(nextAction) !== '' && parseCrmDoc(out).nextAction === '') out = updateCrmDocNextAction(out, nextAction)
  return out
}

/**
 * Convert a doc written in the retired HTML-comment format (head above the sentinel, notes below)
 * to the heading format, preserving any frontmatter. Returns null when there is nothing to do: a
 * blank doc, no sentinel line, or a doc that already parses as heading-format - the last guard is
 * what makes a NOTES body that merely mentions the old sentinel string safe from re-partition
 * forever. Migration 019's per-file step; content-idempotent because the output never contains a
 * bare sentinel line at 'none' kind again.
 */
export function convertLegacyCrmDoc(content: string): string | null {
  if (content.trim() === '') return null
  const s = split(content)
  if (s.kind !== 'none') return null
  for (const l of lineSpans(s.body)) {
    if (l.text === LEGACY_CRM_DOC_SENTINEL) {
      const head = s.body.slice(0, l.start)
      const tail = s.body.slice(l.endNl)
      return `${fmPart(s.fm)}${renderCrmDoc(head, tail)}`
    }
  }
  return null
}

/**
 * Mirror a warehouse-side write of `next_action` / `notes` INTO the doc, so the column path
 * (grid cells, the crm-account-upsert MCP tool) can never leave the doc stale - the
 * syncContentDocFrontmatter precedent, pointing the other way. Only the provided fields are
 * touched; the other region is preserved byte-exact. Creates the doc when none exists and a real
 * value arrived; never creates an empty file. Returns whether anything was written. Throws on I/O
 * failure - the CALLER keeps it best-effort (a doc that cannot be synced must never fail the
 * warehouse write).
 */
export function syncCrmDocFields(accountId: string, fields: { next_action?: string; notes?: string }): boolean {
  const doc = readCrmDoc(accountId)
  if (!doc.exists) {
    const na = fields.next_action ?? ''
    const notes = fields.notes ?? ''
    if (collapse(na) === '' && notes.trim() === '') return false
    writeCrmDoc(accountId, renderCrmDoc(na, notes))
    return true
  }
  let content = doc.content
  if (fields.notes !== undefined) content = updateCrmDocNotes(content, fields.notes)
  if (fields.next_action !== undefined) content = updateCrmDocNextAction(content, fields.next_action)
  if (content === doc.content) return false
  writeCrmDoc(accountId, content)
  return true
}
