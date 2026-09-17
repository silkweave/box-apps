// Markdown → the Substack post body, which is a ProseMirror document rather than HTML or markdown.
//
// This is the real cost of publishing to Substack over its API. The editor stores posts as a
// ProseMirror doc and `POST /drafts` takes that doc as a JSON STRING under `draft_body`; markdown
// handed to it arrives literally, so `## Heading` renders as the characters `## Heading`. Every
// piece in this repo is authored as markdown, so something has to do this translation, and it may
// as well be one tested function rather than a habit of hand-writing node trees.
//
// The node vocabulary is not invented and not taken from a third-party client: it is the schema
// marcomoauro/substack-mcp published after reading it off live drafts and live published posts.
// Two traps that cost other clients a silent mis-render, both encoded here:
//
//   • The code block is `highlighted_code_block`, NOT `codeBlock`. `python-substack` declares the
//     latter and Substack does not render a node by that name.
//   • An ordered list numbers from `attrs.order`, NOT `attrs.start`. The editor writes both, so
//     reading one of its documents suggests either would do; a list given only `start` is stored
//     verbatim, answers 200, and then numbers from 1 with no error anywhere.
//
// Images are the one thing this cannot do alone: an `image2` src has to be a Substack-hosted URL
// (an external one is stored and simply does not render), so the caller passes `resolveImage`,
// which uploads and returns the hosted URL. An unresolvable image THROWS rather than being dropped
// or passed through - a post that silently loses its illustration is worse than a publish that
// refuses.

/** A ProseMirror node in the Substack schema. Loose by design: attrs vary per node type. */
export interface DocNode {
  type: string
  attrs?: Record<string, unknown>
  content?: DocNode[]
  text?: string
  marks?: { type: string; attrs?: Record<string, unknown> }[]
}

export interface SubstackDoc {
  type: 'doc'
  content: DocNode[]
}

export interface DocOptions {
  /**
   * Turn a markdown image src into a Substack-hosted URL. Called once per image. Returning
   * undefined is an error the caller wanted to hear about, not a licence to skip the image.
   */
  resolveImage?: (src: string) => string | undefined
}

export type Mark = { type: string; attrs?: Record<string, unknown> }

// --- inline ------------------------------------------------------------------------------------

// One alternation, matched earliest-first, so nesting is handled by recursion rather than by a
// pass per mark. Order inside the group matters only for equal start positions: `**` has to be
// tried before `*` or bold reads as an empty italic.
const INLINE_TOKEN =
  /(`[^`]+`)|(!?\[[^\]]*\]\([^)\s]+\))|(\*\*[\s\S]+?\*\*)|(__[\s\S]+?__)|(~~[\s\S]+?~~)|(\*[^*\s][\s\S]*?\*)|(_[^_\s][\s\S]*?_)/

/**
 * Inline markdown → text nodes carrying marks. Recursive: the span inside a token is parsed again
 * with the new mark appended, so `**[a](b)**` becomes one text node with both `strong` and `link`
 * rather than either mark winning.
 */
export function inlineNodes(text: string, marks: Mark[] = []): DocNode[] {
  if (!text) return []
  const match = INLINE_TOKEN.exec(text)
  if (!match) return [textNode(text, marks)]

  const out: DocNode[] = []
  const before = text.slice(0, match.index)
  if (before) out.push(textNode(before, marks))

  const token = match[0]
  if (token.startsWith('`')) {
    // Code spans are literal all the way down: no recursion, or a backtick-quoted `**` would bold.
    out.push(textNode(token.slice(1, -1), [...marks, { type: 'code' }]))
  } else if (token.startsWith('![')) {
    // An inline image inside a paragraph has no representation in this schema (captionedImage is a
    // block). Rendering its alt text keeps the sentence readable and loses nothing a reader can see.
    out.push(textNode(token.slice(2, token.indexOf(']')), marks))
  } else if (token.startsWith('[')) {
    const close = token.indexOf('](')
    const label = token.slice(1, close)
    const href = token.slice(close + 2, -1)
    out.push(...inlineNodes(label, [...marks, { type: 'link', attrs: { href } }]))
  } else if (token.startsWith('**') || token.startsWith('__')) {
    out.push(...inlineNodes(token.slice(2, -2), [...marks, { type: 'strong' }]))
  } else if (token.startsWith('~~')) {
    out.push(...inlineNodes(token.slice(2, -2), [...marks, { type: 'strikethrough' }]))
  } else {
    out.push(...inlineNodes(token.slice(1, -1), [...marks, { type: 'em' }]))
  }

  out.push(...inlineNodes(text.slice(match.index + token.length), marks))
  return out
}

function textNode(text: string, marks: Mark[]): DocNode {
  return marks.length ? { type: 'text', text, marks } : { type: 'text', text }
}

// --- blocks ------------------------------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^(\s*)[-*+]\s+(.*)$/
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/
const FENCE = /^```(\w*)/
const QUOTE = /^>\s?(.*)$/
const IMAGE_ONLY = /^!\[([^\]]*)\]\(([^)\s]+)\)$/

/** Indent width of a list line, in spaces (a tab counts as four). */
function indentOf(raw: string): number {
  return raw.replace(/\t/g, '    ').match(/^ */)![0].length
}

/**
 * Markdown → a Substack document. Supports what this repo's bodies actually contain: headings,
 * paragraphs, nested bullet/ordered lists, blockquotes, fenced code, rules, links and inline marks,
 * and standalone images. Anything more exotic (tables, footnotes, raw HTML) is out of scope and
 * arrives as plain paragraph text rather than being silently dropped.
 */
export function markdownToSubstackDoc(markdown: string, opts: DocOptions = {}): SubstackDoc {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  return { type: 'doc', content: parseBlocks(lines, opts) }
}

function parseBlocks(lines: string[], opts: DocOptions): DocNode[] {
  const out: DocNode[] = []
  let i = 0

  while (i < lines.length) {
    const raw = lines[i]!
    const line = raw.trim()

    if (!line) {
      i++
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      // Fenced code is scanned before anything else and consumes blank lines verbatim - a blank
      // line inside a snippet is part of the snippet, not a block break.
      const language = fence[1] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) body.push(lines[i++]!)
      i++ // the closing fence
      out.push({
        type: 'highlighted_code_block',
        // An unrecognised language is accepted and then rendered as plain text, so omitting beats
        // guessing: no info string means let Substack auto-detect.
        ...(language ? { attrs: { language: language.toLowerCase() } } : {}),
        content: [{ type: 'text', text: body.join('\n') }],
      })
      continue
    }

    if (RULE.test(line)) {
      out.push({ type: 'horizontal_rule' })
      i++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      out.push({
        type: 'heading',
        attrs: { level: heading[1]!.length },
        content: inlineNodes(heading[2]!.trim()),
      })
      i++
      continue
    }

    const image = IMAGE_ONLY.exec(line)
    if (image) {
      out.push(imageNode(image[2]!, image[1] ?? '', opts))
      i++
      continue
    }

    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!.trim())) {
        inner.push(QUOTE.exec(lines[i]!.trim())![1]!)
        i++
      }
      // A blockquote holds paragraphs and lists, never bare text, so its contents go back through
      // the block parser.
      out.push({ type: 'blockquote', content: parseBlocks(inner, opts) })
      continue
    }

    if (BULLET.test(raw) || ORDERED.test(raw)) {
      const start = i
      const startsOrdered = ORDERED.test(raw)
      const baseIndent = indentOf(raw)
      // A list runs on across blank lines (a loose list is still one list), but ONLY while the items
      // at its own indent keep the same marker. Without that last condition a bulleted list followed
      // by a numbered one swallows it: the numbers become bullets and the ordered list vanishes,
      // silently and with no error anywhere. Nested items (deeper indent) always continue - they
      // belong to the item above regardless of their marker.
      const continuesList = (l: string): boolean =>
        (BULLET.test(l) || ORDERED.test(l)) && (indentOf(l) > baseIndent || ORDERED.test(l) === startsOrdered)
      while (i < lines.length) {
        const l = lines[i]!
        if (continuesList(l)) i++
        else if (!l.trim() && i + 1 < lines.length && continuesList(lines[i + 1]!)) i++
        else if (l.trim() && indentOf(l) > baseIndent && i > start) i++ // wrapped continuation of an item
        else break
      }
      out.push(parseList(lines.slice(start, i)))
      continue
    }

    // Paragraph: consecutive plain lines, joined by a space the way markdown means them. A single
    // newline inside a paragraph is a soft wrap in a body written for a blog, not a line break.
    const para: string[] = []
    while (i < lines.length) {
      const l = lines[i]!
      if (!l.trim() || HEADING.test(l.trim()) || RULE.test(l.trim()) || QUOTE.test(l.trim())) break
      if (FENCE.test(l.trim()) || BULLET.test(l) || ORDERED.test(l) || IMAGE_ONLY.test(l.trim())) break
      para.push(l.trim())
      i++
    }
    out.push({ type: 'paragraph', content: inlineNodes(para.join(' ')) })
  }

  return out
}

/** One list block (already sliced out), including nested items, at the shallowest indent present. */
function parseList(lines: string[]): DocNode {
  const itemLines = lines.filter((l) => l.trim())
  const baseIndent = Math.min(...itemLines.map(indentOf))
  const firstOrdered = ORDERED.exec(itemLines.find((l) => indentOf(l) === baseIndent) ?? '')
  const ordered = Boolean(firstOrdered)

  const items: DocNode[] = []
  let current: string[] | null = null
  const flush = () => {
    if (!current) return
    const [head, ...rest] = current
    const nested = rest.filter((l) => l.trim())
    items.push({
      type: 'list_item',
      // An item's text lives in a paragraph, never directly in the item.
      content: [
        { type: 'paragraph', content: inlineNodes(head!) },
        ...(nested.length ? [parseList(nested.map((l) => l.slice(baseIndent + 2)))] : []),
      ],
    })
    current = null
  }

  for (const line of itemLines) {
    const isItem = indentOf(line) === baseIndent && (BULLET.test(line) || ORDERED.test(line))
    if (isItem) {
      flush()
      const m = ORDERED.exec(line) ?? BULLET.exec(line)
      current = [(ORDERED.test(line) ? m![3] : m![2])!.trim()]
    } else if (current) {
      current.push(line)
    }
  }
  flush()

  if (!ordered) return { type: 'bullet_list', content: items }
  // `order` is the attr that renders; `start` rides along because the editor writes both and a
  // round trip through the editor should not look like an edit.
  const from = Number(firstOrdered![2])
  return { type: 'ordered_list', attrs: { order: from, start: from }, content: items }
}

/** A standalone image, as the captionedImage wrapper Substack requires. */
function imageNode(src: string, alt: string, opts: DocOptions): DocNode {
  const resolved = opts.resolveImage?.(src)
  if (!resolved) {
    throw new Error(
      `image "${src}" is not hosted by Substack and could not be uploaded. An external src is stored ` +
        'but never renders, so the post would publish with a missing image. Add the file to the topic ' +
        "folder and list it in the piece's assets, or drop the image from the body.",
    )
  }
  return {
    type: 'captionedImage',
    content: [
      { type: 'image2', attrs: { src: resolved, alt: alt || null } },
      ...(alt ? [{ type: 'caption', content: inlineNodes(alt) }] : []),
    ],
  }
}

/** Node counts by type, so a caller can confirm what it asked for actually landed. Validation
 *  cannot do this job: a document with no code block is exactly as valid as one with three. */
export function summarizeDoc(doc: SubstackDoc): Record<string, number> {
  const counts: Record<string, number> = {}
  const walk = (node: DocNode) => {
    if (node.type !== 'text' && node.type !== 'doc') counts[node.type] = (counts[node.type] ?? 0) + 1
    node.content?.forEach(walk)
  }
  doc.content.forEach(walk)
  return counts
}
