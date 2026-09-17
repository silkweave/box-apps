import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { highlight } from '../../../lib/highlighter.ts'

interface CodeBlockProps {
  code: string
  /** The fence tag as typed, e.g. `ts`. Null for an untagged fence. */
  fence: string | null
}

/** A fenced code block in a chat message. `cp-shiki` is what hands the dual-theme output in
 *  globals.css its colors - without that class every token renders at the inherited body color. */
export function CodeBlock({ code, fence }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    void highlight(code, fence).then((result) => {
      if (live) setHtml(result.html)
    })
    // The grammar loads over the network, so a message edited or re-rendered mid-load must not have
    // the stale result win.
    return () => {
      live = false
    }
  }, [code, fence])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    await navigator.clipboard.writeText(code)
    setCopied(true)
  }

  return (
    <div className='group/code relative my-1.5 overflow-hidden rounded-md border border-border bg-sidebar'>
      <button
        type='button'
        onClick={() => void copy()}
        className='absolute top-1.5 right-1.5 rounded border border-border bg-bg/80 p-1 text-muted-foreground opacity-0 backdrop-blur transition-opacity group-hover/code:opacity-100 hover:text-text focus-visible:opacity-100'
        aria-label={copied ? 'Copied' : 'Copy code'}>
        {copied ? <Check className='size-3' /> : <Copy className='size-3' />}
      </button>

      {/* shiki escapes the source while tokenizing, so its output is the only HTML injected here.
          Raw message text never reaches this path - react-markdown has no HTML parser enabled. */}
      {html ? (
        <div className='cp-shiki overflow-x-auto p-3 text-code' dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className='overflow-x-auto p-3 text-code'>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
}
