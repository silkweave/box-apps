import { Node, mergeAttributes, type Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import { cn } from '@/lib/utils'
import { Avatar } from '@silkweave/box-ui'
import { useAuth } from '../../../lib/useAuth.tsx'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { userName } from '../../../user-types.ts'
import { MENTION_RE, mentionLabel } from './mentions.tsx'

/**
 * The composer's mention TOKEN - an inline atom node, so a mention behaves like one object: one
 * backspace removes the whole thing, the caret steps over it rather than into it, and you cannot
 * end up having typed `@da` by editing the middle of someone's name.
 *
 * ## The invariant this node exists to protect
 *
 * **It serializes back to exactly `@<users.id>`.** The wire format is plain markdown and nothing
 * about that changes because the editor draws a pill - `renderMarkdown` below is the whole contract,
 * and it is what keeps `getMarkdown()` producing the same string the server's `parseMentionHandles`
 * has always parsed. A token that serialized to anything else (an HTML span, a link, a custom
 * `@[Name](user:id)` syntax) would mean the stored body and the rendered message disagree, and every
 * message ever posted before this node existed would stop highlighting.
 *
 * That is also why the node carries `id` and NOT the display name: the id is the handle, the name is
 * a rendering of it, resolved live from the directory in both surfaces.
 *
 * ## Why a React node view
 *
 * `@tiptap/react` is already a dependency, and going through it means the token reuses the real
 * `Avatar` - same image, same initials fallback, same per-user tint as the message gutter and the
 * user menu - instead of a second hand-rolled avatar in imperative DOM that would drift from it.
 */
export const MentionNode = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  // An ATOM: ProseMirror treats it as a single indivisible unit with no editable content inside.
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-mention'),
        renderHTML: (attributes) =>
          attributes.id === null ? {} : { 'data-mention': attributes.id as string },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-mention]' }]
  },

  /** The non-node-view fallback (copy to clipboard as HTML, SSR, a headless editor). It must still
   *  read as the handle, so nothing downstream sees an empty span. */
  renderHTML({ HTMLAttributes, node }) {
    return ['span', mergeAttributes(HTMLAttributes), `@${String(node.attrs.id ?? '')}`]
  },

  /** THE contract with the server. See the class comment - do not "improve" this. */
  renderMarkdown(node) {
    return `@${String(node.attrs?.id ?? '')}`
  },

  /** Plain text (drag out, copy as text/plain) is the handle too. */
  renderText({ node }) {
    return `@${String(node.attrs.id ?? '')}`
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionTokenView)
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          /**
           * Let punctuation swallow the space the menu inserts after a token.
           *
           * Picking from the menu has to leave a trailing space: the node serializes to bare
           * `@dan`, so typing straight after it would produce `@danhow` and silently mention a
           * person who does not exist. But that space is wrong the moment the next thing you type
           * is punctuation - "Hey there @Dan , how are you?" is not a sentence anyone wrote.
           *
           * So when punctuation lands directly after `<mention><space>`, the space goes with it.
           * The serialized result is `@dan,` which the server's parser reads as the handle `dan`
           * terminating at the comma - the boundary is preserved, the sentence is not mangled.
           */
          handleTextInput(view, from, to, text) {
            if (!/^[,.!?;:)\]]$/.test(text)) return false
            if (from < 2) return false
            if (view.state.doc.textBetween(from - 1, from) !== ' ') return false
            const preceding = view.state.doc.resolve(from - 1).nodeBefore
            if (preceding?.type.name !== 'mention') return false
            view.dispatch(view.state.tr.replaceWith(from - 1, to, view.state.schema.text(text)))
            return true
          },
        },
      }),
    ]
  },
})

/**
 * The pill inside the editor. Deliberately the same shape as the rendered-message token in
 * `mentions.tsx` (avatar + first name), because the promise the composer makes is "this is what you
 * are about to send" - two different treatments would break that.
 *
 * `contentEditable={false}` is what stops the browser putting a caret inside the pill; the atom flag
 * handles ProseMirror's model, this handles the DOM.
 *
 * `inline-block` rather than `inline-flex` for the baseline reason spelled out in mentions.tsx -
 * keep the two in step, since the whole promise of the composer token is that it looks like what
 * you are about to send.
 */
function MentionTokenView({ node }: { node: { attrs: Record<string, unknown> } }) {
  const id = typeof node.attrs.id === 'string' ? node.attrs.id : ''
  const { principal } = useAuth()
  const { data: users } = useUsersData()
  const user = users?.find((u) => u.id === id) ?? null
  const isMe = principal?.id === id

  return (
    <NodeViewWrapper as='span' className='inline'>
      <span
        contentEditable={false}
        className={cn(
          'relative mx-px inline-block rounded-full py-px leading-5 select-none',
          user ? 'pr-1.5 pl-[22px]' : 'px-1.5',
          isMe ? 'bg-accent/25 ring-1 ring-accent/40 ring-inset' : 'bg-primary/10',
        )}
        title={user ? (isMe ? `${userName(user)} (you)` : userName(user)) : `@${id}`}>
        {user && (
          <Avatar
            user={user}
            size='xs'
            className='absolute top-1/2 left-[3px] size-4 -translate-y-1/2 text-[9px]'
          />
        )}
        <span className={cn('font-medium', isMe ? 'text-text' : 'text-primary')}>
          {user ? mentionLabel(user) : `@${id}`}
        </span>
      </span>
    </NodeViewWrapper>
  )
}

/**
 * Turn plain `@handle` text in the editor into real mention nodes.
 *
 * This is the missing half of the markdown round-trip. The node SERIALIZES to `@id`, but nothing
 * parses `@id` back - `@tiptap/markdown` would need a custom marked tokenizer for that - so
 * `setContent(body, 'markdown')` returns every mention as plain text. Harmless on the
 * failed-draft restore path; very visible when EDITING a message, which is where it was found.
 *
 * Doing it on the ProseMirror doc rather than in the markdown parser is the cheaper correct answer:
 * the doc already knows what is code, the same `MENTION_RE` decides what a handle is, and there is
 * no dependency on marked's internals.
 *
 * Two things it deliberately does NOT do. It skips handles that do not resolve to a real user
 * (`isKnown`), because a token for `@lunch` would promise a notification nobody gets. And it does
 * not go into the undo history (`addToHistory: false`), so the first Cmd-Z after opening an edit
 * undoes something the USER did rather than this rewrite.
 */
export function tokenizeMentions(editor: Editor, isKnown: (id: string) => boolean): void {
  if (editor.isDestroyed) return
  const { state } = editor
  const mentionType = state.schema.nodes.mention
  if (!mentionType) return

  const hits: { from: number; to: number; id: string }[] = []
  state.doc.descendants((node, pos, parent) => {
    if (!node.isText || typeof node.text !== 'string') return
    // Same exclusions as the renderer: `@` inside code is literal.
    if (parent?.type.name === 'codeBlock') return
    if (node.marks.some((m) => m.type.name === 'code')) return

    MENTION_RE.lastIndex = 0
    for (let m = MENTION_RE.exec(node.text); m !== null; m = MENTION_RE.exec(node.text)) {
      const id = m[2].toLowerCase()
      if (!isKnown(id)) continue
      // m[1] is the leading boundary (whitespace/bracket), which is NOT part of the mention.
      const from = pos + m.index + m[1].length
      hits.push({ from, to: from + 1 + m[2].length, id })
    }
  })
  if (hits.length === 0) return

  // Apply BACKWARDS: each replacement changes the document length, so working from the end keeps
  // every earlier offset valid without remapping.
  const tr = state.tr
  for (const hit of hits.reverse()) {
    tr.replaceWith(hit.from, hit.to, mentionType.create({ id: hit.id }))
  }
  editor.view.dispatch(tr.setMeta('addToHistory', false))
}
