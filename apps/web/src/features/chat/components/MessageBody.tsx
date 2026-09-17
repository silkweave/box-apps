import { isValidElement, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from './CodeBlock.tsx'
import { Mention, remarkMentions } from './mentions.tsx'

/**
 * Module-level, not inline in the render: react-markdown remounts every node when this object's
 * identity changes, which would tear down and re-highlight every code block on each keystroke
 * elsewhere in the room.
 *
 * Chat is not a document, so headings render at body weight. There is still no image renderer here:
 * uploads (Track 11) are a separate concern rendered by `Attachments` BELOW the body, not markdown
 * `![]()` syntax, and a remote image URL in a message body would be a tracking-pixel surface.
 * Note this is deliberately NOT the `.markdown-body` prose styling the TipTap doc surfaces use: a
 * message is a line in a conversation, not a page.
 */
const components: Components = {
  p: ({ children }) => <p className='whitespace-pre-wrap'>{children}</p>,

  /**
   * A hard break renders as NOTHING, because `whitespace-pre-wrap` on the paragraph above has
   * already drawn it.
   *
   * Markdown's hard break is "two spaces then a newline" (what the composer emits for Shift+Enter)
   * or "backslash then a newline". remark turns either into a `break` node AND leaves the newline
   * itself in the adjacent text node - verified by rendering, 2026-08-26. So a `<br/>` here is
   * always a SECOND break on top of the one pre-wrap is about to draw from that newline, which is
   * why "this is<Shift+Enter>awesome" came out with a blank line between.
   *
   * Dropping the element rather than dropping `pre-wrap` is the fix that covers everything: the
   * newline survives in the text either way, so this also repairs every message already stored with
   * a two-space break, and it keeps single newlines working for bodies that never went through the
   * composer at all (an agent posting over `chat-post` writes plain "\n" and nothing else).
   */
  br: () => null,

  a: ({ children, href }) => (
    <a href={href} target='_blank' rel='noreferrer noopener' className='text-primary underline underline-offset-2'>
      {children}
    </a>
  ),

  // A fenced block arrives as <pre><code>; unwrap it so `code` is the only place that has to tell
  // inline code from a block.
  pre: ({ children }) => <>{children}</>,

  code: ({ children, className }) => {
    const fence = /language-(\w+)/.exec(className ?? '')?.[1] ?? null
    const text = toText(children)

    // An untagged single-line span is inline code; anything fenced or multi-line is a block. Getting
    // this wrong turns every `foo` into a full-width panel.
    if (fence === null && !text.includes('\n')) {
      return <code className='rounded bg-muted px-1 py-0.5 font-mono text-code text-text'>{children}</code>
    }

    return <CodeBlock code={text.replace(/\n$/, '')} fence={fence} />
  },

  ul: ({ children }) => <ul className='my-1 list-disc space-y-0.5 pl-5'>{children}</ul>,
  ol: ({ children }) => <ol className='my-1 list-decimal space-y-0.5 pl-5'>{children}</ol>,

  blockquote: ({ children }) => (
    <blockquote className='my-1 border-l-2 border-accent/40 pl-3 text-muted-foreground'>{children}</blockquote>
  ),

  h1: ({ children }) => <p className='mt-1.5 font-semibold'>{children}</p>,
  h2: ({ children }) => <p className='mt-1.5 font-semibold'>{children}</p>,
  h3: ({ children }) => <p className='mt-1.5 font-semibold'>{children}</p>,

  hr: () => <hr className='my-2 border-border' />,

  table: ({ children }) => (
    <div className='my-1.5 overflow-x-auto'>
      <table className='w-full border-collapse border border-border text-label'>{children}</table>
    </div>
  ),
  th: ({ children }) => <th className='border border-border bg-muted/50 px-2 py-1 text-left'>{children}</th>,
  td: ({ children }) => <td className='border border-border px-2 py-1'>{children}</td>,

  // The ONLY span on this path: `remarkMentions` emits one per `@handle`. Author-written markup
  // cannot reach here (`skipHtml`), so this override cannot be triggered by a message body, and
  // `Mention` falls through to a plain span for anything it does not recognise anyway.
  span: Mention,
}

const plugins = [remarkGfm, remarkMentions]

/**
 * A markdown subset, rendered to React elements. Raw HTML in a message is never parsed -
 * `react-markdown` needs `rehype-raw` for that and we deliberately do not install it - so a message
 * body cannot inject markup. The only HTML on this path is shiki's own output.
 */
export function MessageBody({ body }: { body: string }) {
  return (
    <div className='text-body wrap-anywhere'>
      <Markdown remarkPlugins={plugins} skipHtml components={components}>
        {body}
      </Markdown>
    </div>
  )
}

/** Flattens a code node's children back to the raw source shiki needs. */
function toText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(toText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return toText(node.props.children)
  return ''
}
