import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

// Makes an X thread's posts visible in the WYSIWYG without touching the markdown. An X body is one
// document split into posts on `N/` markers (1/ 2/ …); we draw a view-only divider + live char-count
// chip before each post. These are ProseMirror *decorations* - they never enter the doc, so
// editor.getMarkdown() still serializes the plain `1/ …` text and the file stays readable.

export interface ThreadPostStat {
  /** Document position just before the post's first block (where the divider widget is placed). */
  pos: number
  /** 0-based post index. */
  index: number
  /** Rendered character count of the whole post (all its blocks). */
  chars: number
}

/**
 * Group the doc's top-level blocks into thread posts on `N/` markers and count each post's text. Pure
 * and shared with the header summary, so the inline chips and the "N over" count are always computed
 * the same way from the same doc and can never disagree.
 */
export function threadPostStats(doc: PMNode): ThreadPostStat[] {
  const posts: { pos: number; index: number; texts: string[] }[] = []
  let current: { pos: number; index: number; texts: string[] } | null = null
  doc.forEach((node, offset) => {
    const text = node.textContent
    const isMarker = /^\s*\d+\//.test(text)
    if (isMarker || current == null) {
      current = { pos: offset, index: posts.length, texts: [text] }
      posts.push(current)
    } else {
      current.texts.push(text)
    }
  })
  // Join blocks with a blank line so the count mirrors the markdown a post serializes to.
  return posts.map((p) => ({ pos: p.pos, index: p.index, chars: p.texts.join('\n\n').trim().length }))
}

/** Build the divider + count-chip DOM for one post. Plain CSS classes (styled in globals.css) so the
 *  imperatively-created node survives Tailwind purging. */
function divider(stat: ThreadPostStat, max: number): HTMLElement {
  const el = document.createElement('div')
  el.className = 'x-post-divider' + (stat.index === 0 ? ' x-post-divider--first' : '')
  el.contentEditable = 'false'
  const pill = document.createElement('span')
  pill.className = 'x-post-chip' + (stat.chars > max ? ' x-post-chip--over' : '')
  pill.textContent = `${stat.index + 1}/  ${stat.chars}/${max}`
  el.appendChild(pill)
  return el
}

/** Extension factory: only added for thread-channel bodies. `max` is the per-post char cap. */
export const XThreadPosts = Extension.create<{ max: number }>({
  name: 'xThreadPosts',
  addOptions() {
    return { max: 280 }
  },
  addProseMirrorPlugins() {
    const max = this.options.max
    return [
      new Plugin({
        key: new PluginKey('xThreadPosts'),
        props: {
          decorations(state) {
            const stats = threadPostStats(state.doc)
            if (stats.length === 0) return DecorationSet.empty
            const decos = stats.map((s) =>
              // key includes the count so the chip re-renders (and recolors) when the post length changes.
              Decoration.widget(s.pos, () => divider(s, max), { side: -1, key: `xpost-${s.index}-${s.chars}` }),
            )
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
})
