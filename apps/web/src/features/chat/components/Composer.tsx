import { Extension } from '@tiptap/core'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, useEditor } from '@tiptap/react'
import { Placeholder } from '@tiptap/extensions'
import StarterKit from '@tiptap/starter-kit'
import { CornerDownRight, Paperclip, SendHorizontal, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@silkweave/box-ui'
import { useUsersData } from '../../../lib/useUsersData.ts'
import { filesToAttach, formatBytes, isAttachIntent, uploadAttachment } from '../lib/chatUploads.ts'
import type { ChatAttachment } from '../lib/chatTypes.ts'
import { MentionNode, tokenizeMentions } from './MentionNode.tsx'
import { MentionSuggest, type MentionSuggestHandle } from './MentionSuggest.tsx'

interface ComposerProps {
  /** Names where the message is going, e.g. "Message #general". */
  placeholder: string
  disabled: boolean
  /** `attachmentIds` are ids of already-uploaded orphans for this post to CLAIM; always empty in
   *  edit mode, since `chatEdit` has no attachment surface. */
  onSend: (body: string, attachmentIds: string[]) => Promise<void>
  /**
   * EDIT mode. Seeds the editor with an existing message's markdown and swaps the send icon for
   * Save/Cancel. Passing `onCancel` is what turns edit mode on - the two always travel together,
   * since an edit with no way out is a trap.
   *
   * The tradeoff, accepted deliberately (a product decision, 2026-08-26): editing now round-trips the body
   * through TipTap, so markdown is NORMALIZED on save even if you changed nothing (`*x*` may come
   * back as `_x_`, list markers may be rewritten). The previous plain-textarea edited the raw
   * source precisely to avoid that. It was traded for mentions, headings and the rest of the rich
   * surface being available while editing - which is what people actually reach for.
   */
  initialBody?: string
  onCancel?: () => void
  /**
   * The thread this composer is currently aimed at, or null for the room itself. ONE composer
   * serves both: retargeting it is a banner above the input, not a second editor mounted down in
   * the transcript. That is the phone's model, adopted here after it shipped on iOS - and the
   * argument is the same on both, only quieter on a desktop: a second TipTap instance per open
   * thread is a second draft, a second focus target and a second place a half-written message can
   * hide.
   */
  replyingTo?: { rootId: string; senderName: string } | null
  /** Aim the composer back at the room. Required whenever `replyingTo` can be non-null. */
  onCancelReply?: () => void
}

/**
 * The message box, on the same TipTap stack as the doc/content editors rather than a second
 * editing technology in one app. You type markdown and see it formatted as you go; `getMarkdown()`
 * is what gets posted, so the wire format stays plain markdown and MessageBody renders the exact
 * same subset on the way back out.
 *
 * Enter sends. That fights TipTap, whose extensions all bind Enter for block splitting, so the
 * keymap below claims it at high priority - with two deliberate exemptions, see SendKeymap.
 */
export function Composer({
  placeholder,
  disabled,
  onSend,
  initialBody,
  onCancel,
  replyingTo = null,
  onCancelReply,
}: ComposerProps) {
  const editMode = onCancel !== undefined
  // Needed to decide which `@handle` in a seeded body is a REAL person - see tokenizeMentions.
  const { data: users } = useUsersData()
  const [empty, setEmpty] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Uploaded and waiting to be CLAIMED by the next post. They are already on the server (as
   *  orphans) by the time they land here, so sending is a cheap id-claim rather than a second wait.
   *  An abandoned draft costs nothing: unclaimed orphans are swept after 24h. */
  const [pending, setPending] = useState<ChatAttachment[]>([])
  /** In-flight uploads. A count, not a boolean, because several files can be dropped at once. */
  const [uploading, setUploading] = useState(0)
  const [dragging, setDragging] = useState(false)
  // The real <input type=file> is hidden; the paperclip Button drives it, so the affordance can be
  // styled like every other control instead of looking like a browser default.
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Autofocusing on a phone throws the keyboard up over the room before the user has read anything.
  // Resolve once at mount: this only decides the INITIAL focus, so it does not need to react to a
  // resize.
  // Editing always focuses - the user just clicked Edit, so the keyboard coming up IS the intent.
  const [autoFocus] = useState(
    () => onCancel !== undefined || (globalThis.matchMedia?.('(min-width: 768px)').matches ?? false),
  )
  // Input MODALITY, not viewport width: on a touch keyboard Enter means "new line" (there is no
  // other way to get one - no Shift, no Mod) and the Send button is the send gesture, the way every
  // phone messenger works. Resolved once like autoFocus; a device does not change modality mid-chat.
  const [touchKeyboard] = useState(() => globalThis.matchMedia?.('(hover: none) and (pointer: coarse)').matches ?? false)
  const touchRef = useRef(touchKeyboard)

  // The keymap extension is built once (rebuilding it would recreate the editor and drop the
  // draft), so it cannot close over a fresh `submit` each render - it calls through this ref.
  const submitRef = useRef<() => void>(() => {})
  // Same shape for the placeholder: the extension is configured once, so it reads the CURRENT room
  // name through this ref (function placeholders are evaluated per decoration render - verified in
  // @tiptap/extensions createPlaceholderDecoration). Mutating the extension's options later does
  // NOT work in TipTap v3: Extendable.options is a getter that spreads a fresh object per access,
  // and the plugin captured its own snapshot at creation.
  const placeholderRef = useRef(placeholder)
  // The @-autocomplete publishes an imperative handle here. The keymap below is built once and
  // cannot close over React state, so it ASKS the menu what is going on instead. One keymap owns
  // Enter; there is no second plugin racing it for the key. See MentionSuggest.
  const suggestRef = useRef<MentionSuggestHandle | null>(null)
  // Same shape as submitRef: the keymap is built once and cannot close over a fresh prop.
  const cancelRef = useRef<(() => void) | undefined>(undefined)
  cancelRef.current = onCancel
  const editModeRef = useRef(editMode)
  editModeRef.current = editMode
  const onSendRef = useRef(onSend)
  onSendRef.current = onSend
  const usersRef = useRef(users)
  usersRef.current = users

  /**
   * Upload each file and queue it. Sequential rather than parallel: the server sweeps orphans
   * opportunistically ON the upload route, and the cap refusal is per-file, so serialising keeps
   * the error the user sees attached to the file that caused it.
   *
   * Edit mode never calls this - `chatEdit` cannot carry attachments.
   */
  const addFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return
    setError(null)
    setUploading((n) => n + files.length)
    for (const file of files) {
      try {
        const uploaded = await uploadAttachment(file)
        setPending((list) => [...list, uploaded])
      } catch (cause: unknown) {
        // The server's refusals are verbatim by design (the cap, the allowlist) and are the only
        // thing that tells the person why this file bounced.
        setError(cause instanceof Error ? cause.message : `Could not upload ${file.name}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }, [])

  const SendKeymap = useMemo(
    () =>
      Extension.create({
        name: 'chatSendKeymap',
        // Above StarterKit's block-splitting binds, which would otherwise swallow Enter first.
        priority: 1000,
        addKeyboardShortcuts() {
          const suggest = () => (suggestRef.current?.isOpen() ? suggestRef.current : null)
          return {
            // While the mention menu is open these keys belong to it. Returning false when it is
            // shut hands each key straight back to its normal meaning, so the menu costs nothing
            // when it is not showing.
            ArrowUp: () => {
              const menu = suggest()
              if (!menu) return false
              menu.move(-1)
              return true
            },
            ArrowDown: () => {
              const menu = suggest()
              if (!menu) return false
              menu.move(1)
              return true
            },
            Tab: () => suggest()?.commit() ?? false,
            Escape: () => {
              // The menu owns Escape while it is open; only once it is shut does Escape mean
              // "abandon this edit". Ordering matters - otherwise dismissing the mention menu
              // would throw away the whole edit.
              const menu = suggest()
              if (menu) {
                menu.close()
                return true
              }
              if (cancelRef.current) {
                cancelRef.current()
                return true
              }
              return false
            },
            Enter: ({ editor }) => {
              // Picking a teammate outranks sending: the menu is only open because the caret is
              // sitting in a half-typed handle, and sending `@to` helps nobody. This is also why
              // the touch-keyboard exemption is BELOW it - on a phone Enter makes a newline, but
              // with the menu up it still picks.
              if (suggest()?.commit()) return true
              // On a touch keyboard Enter never sends - it is the only way to make a new line
              // there, and the Send button is the send gesture (a product decision, 2026-08-21, from
              // phone). Mod-Enter still sends for a tablet with a hardware keyboard.
              if (touchRef.current) return false
              // The two places where a newline IS the point on desktop too: a fenced block (the
              // renderer highlights 18 grammars, and a code block you cannot add a second line to
              // is useless) and a list (Enter makes the next bullet). Returning false hands Enter
              // back to the default handler. Mod-Enter below is the escape hatch that sends from
              // inside either one.
              if (editor.isActive('codeBlock') || editor.isActive('listItem')) return false
              submitRef.current()
              return true
            },
            'Mod-Enter': () => {
              submitRef.current()
              return true
            },
          }
        },
      }),
    [],
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // h1-h3 only (deeper levels stay literal text). Both surfaces render a heading as a
        // SEMIBOLD BODY-SIZE line, not a document headline - chat is a conversation - but the
        // structure formats live as you type '# ' (originally disabled outright; overruled
        // 2026-08-21: '# heading' echoing back as escaped source read as broken, not as restraint).
        heading: { levels: [1, 2, 3] },
        // A horizontal rule inside a two-line message is noise.
        horizontalRule: false,
        // Underline has NO markdown representation, so getMarkdown() emits raw <u>...</u> - and
        // MessageBody renders with skipHtml and no rehype-raw, so an underlined word would be
        // silently DROPPED on the way back out. Removing the affordance is the honest fix.
        underline: false,
        link: { openOnClick: false },
      }),
      Markdown.configure({ markedOptions: { gfm: true } }),
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
      // Renders as a pill, serializes back to plain `@id` - the wire format is unchanged. See
      // MentionNode; that serializer is the contract with the server's parser.
      MentionNode,
      SendKeymap,
    ],
    autofocus: autoFocus,
    editorProps: {
      attributes: {
        class: 'chat-composer tiptap max-h-48 overflow-y-auto px-2 py-1.5 focus:outline-none',
      },
      // ProseMirror's own paste/drop listeners are NATIVE and sit on the inner contenteditable,
      // while React delegates at the root - so PM always runs FIRST and a preventDefault from the
      // wrapper below cannot preempt it. These two claim file payloads for us (returning true is
      // "handled, do nothing"), leaving the wrapper handlers to do the single upload. Without them
      // PM inserts the text half of a mixed payload and steals focus for ~50ms on a files-only
      // paste. They deliberately do NOT upload - one uploader, or a paste would attach twice.
      handlePaste: (_view, event) => filesToAttach(event.clipboardData).length > 0,
      handleDrop: (_view, event) => filesToAttach(event.dataTransfer).length > 0,
    },
    onUpdate: ({ editor }) => setEmpty(editor.isEmpty),
  })

  // Keep the ref pointing at a submit closure that sees the current props/editor.
  submitRef.current = () => {
    if (!editor || editor.isDestroyed || sending || disabled) return
    const body = editor.getMarkdown().trim()
    // An attachment with no words is a perfectly good message, so an empty body only blocks the
    // send when there is nothing to claim either. Still blocked while an upload is in flight -
    // sending now would strand the file that is still arriving.
    if (!body && pending.length === 0) return
    if (uploading > 0) return

    setSending(true)
    setError(null)

    // EDIT: no optimistic clear. The body stays on screen until the save resolves, because the
    // parent unmounts this editor on success - clearing first would flash an empty box, and on
    // failure there would be nothing to restore FROM.
    if (editModeRef.current) {
      void onSendRef.current(body, [])
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Failed to save'))
        .finally(() => setSending(false))
      return
    }

    // Clear optimistically so typing stays fluid; restore the draft if the send fails rather than
    // silently losing what the user wrote. Refocus in the same breath: sending is a continuation
    // of typing, and this runs inside the click/keypress gesture, which is what lets a phone KEEP
    // its keyboard up (a later programmatic focus would not bring it back). The editor stays
    // EDITABLE during the send - toggling setEditable(false) here is what used to orphan focus
    // onto <body>, and locking the box for the round-trip only ever blocked typing message two.
    // Cleared optimistically alongside the draft, and RESTORED together with it below: a failed
    // send must leave the ids claimable by the retry, not stranded until the orphan sweeper.
    const claimed = pending
    editor.chain().clearContent(true).focus().run()
    setEmpty(true)
    setPending([])
    void onSend(
      body,
      claimed.map((a) => a.id),
    )
      .catch((cause: unknown) => {
        editor.commands.setContent(body, { contentType: 'markdown', emitUpdate: false })
        // MERGE rather than overwrite: anything attached while the send was in flight is still
        // in `pending` and must survive, or it vanishes from the strip and is stranded on the
        // server until the 24h sweeper. Claimed ids go first so the original order holds.
        setPending((cur) => [...claimed, ...cur.filter((p) => !claimed.some((c) => c.id === p.id))])
        // Same round-trip gap as the edit seed: restored markdown carries mentions as plain text.
        tokenizeMentions(editor, (id) => usersRef.current?.some((u) => u.id === id) ?? false)
        setEmpty(editor.isEmpty)
        setError(cause instanceof Error ? cause.message : 'Failed to send')
        // The draft is back; put the caret after its last word so fixing and resending needs no
        // pointer round-trip.
        if (!editor.isDestroyed) editor.commands.focus('end')
      })
      .finally(() => setSending(false))
  }

  // Seed EDIT mode with the message's markdown, exactly once. `emitUpdate: false` keeps this out
  // of the undo history, so one Cmd-Z does not wipe the message back to empty; the caret goes to
  // the end so typing continues where the sentence left off.
  const seededRef = useRef(false)
  useEffect(() => {
    if (!editor || editor.isDestroyed || seededRef.current || initialBody === undefined) return
    seededRef.current = true
    editor.commands.setContent(initialBody, { contentType: 'markdown', emitUpdate: false })
    setEmpty(editor.isEmpty)
    editor.commands.focus('end')
  }, [editor, initialBody])

  // Then turn the seeded `@handle` TEXT back into mention tokens. Separate from the seed above
  // because it needs the users directory, which may still be in flight - so this waits for it
  // rather than blocking the seed (a body that renders late is worse than mentions that tokenize
  // late). Guarded to run exactly once: re-running on a later directory emit could tokenize a
  // half-typed `@da` out from under the caret.
  const tokenizedRef = useRef(false)
  useEffect(() => {
    if (!editor || editor.isDestroyed || !seededRef.current || tokenizedRef.current || !users) return
    tokenizedRef.current = true
    tokenizeMentions(editor, (id) => users.some((u) => u.id === id))
  }, [editor, users])

  // `isDestroyed`: TipTap v3 can tear down the eagerly-created editor via its 1ms scheduleDestroy
  // before an effect runs (the race DocEditor documents) - touching a dead instance throws.
  // Editability tracks the ROOM being usable (loading, no membership), deliberately not `sending`:
  // an in-flight send is not a reason to lock the box (message two starts now), and flipping
  // contenteditable off is what orphaned focus onto <body> and dropped the phone keyboard.
  // Double-send is prevented in submit by the `sending` guard, and the Send button disables itself.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    editor.setEditable(!disabled)
  }, [editor, disabled])

  // The placeholder must FOLLOW a room switch (#founders -> #general used to keep saying
  // "Message #founders"). The extension reads placeholderRef at render time; this effect updates
  // the ref and dispatches an empty transaction so the decoration re-renders now, not at the next
  // keystroke. The draft (and the caret) survive, which is the point of not keying the component
  // by slug instead.
  useEffect(() => {
    if (!editor || editor.isDestroyed || placeholderRef.current === placeholder) return
    placeholderRef.current = placeholder
    editor.view.dispatch(editor.state.tr)
  }, [editor, placeholder])

  // The editor frame is shared; only the chrome around it differs. Edit mode drops the room-level
  // padding (it renders inline, inside a message row) and trades the send icon for Save/Cancel.
  // Retargeting the composer focuses it. Clicking "Reply in thread" is a request to WRITE, and
  // with the box at the bottom of the room rather than under the message, a caret that stays where
  // it was is a click that appears to have done nothing. Keyed on the root id, so aiming at a
  // different thread re-focuses while a re-render does not.
  const replyRootId = replyingTo?.rootId ?? null
  useEffect(() => {
    if (replyRootId === null || editor === null) return
    editor.commands.focus('end')
  }, [replyRootId, editor])

  const frame = (
    <div
      className={cn(
        'relative flex items-end gap-1 rounded-lg border border-border bg-bg p-1 transition-colors focus-within:border-accent',
        dragging && 'border-accent bg-accent/5',
      )}>
      <MentionSuggest editor={editor} handleRef={suggestRef} />
      {!editMode && (
        <>
          <input
            ref={fileInputRef}
            type='file'
            multiple
            className='hidden'
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])])
              // Reset so picking the SAME file twice in a row still fires a change event.
              e.target.value = ''
            }}
          />
          <Button
            type='button'
            variant='ghost'
            size='icon-sm'
            // 36px, matching the editor's own line box - a 32px control next to a 36px input
            // leaves a sliver of dead space along the top of the frame.
            className='size-9'
            disabled={disabled || sending}
            aria-label='Attach a file'
            onClick={() => fileInputRef.current?.click()}>
            <Paperclip />
            <span className='sr-only'>Attach a file</span>
          </Button>
        </>
      )}
      <EditorContent editor={editor} className='min-w-0 flex-1' />
      {!editMode && (
        <Button
          type='button'
          size='icon-sm'
          className='size-9'
          disabled={disabled || sending || uploading > 0 || (empty && pending.length === 0)}
          aria-label='Send'
          onClick={() => submitRef.current()}>
          <SendHorizontal />
          <span className='sr-only'>Send</span>
        </Button>
      )}
    </div>
  )

  if (editMode) {
    return (
      <div className='flex flex-col gap-1.5 py-1'>
        {frame}
        <div className='flex items-center gap-2'>
          <Button size='sm' disabled={sending || empty} onClick={() => submitRef.current()}>
            {sending ? 'Saving…' : 'Save'}
          </Button>
          <Button variant='ghost' size='sm' disabled={sending} onClick={() => onCancel?.()}>
            Cancel
          </Button>
          <span className='text-label text-muted-foreground'>Escape to cancel</span>
        </div>
        {error && <p className='text-label text-danger'>{error}</p>}
      </div>
    )
  }

  return (
    <div
      className='shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4 sm:pb-4'
      // Paste and drop are scoped to the composer rather than the window: a drop anywhere else in
      // the app still means whatever that surface means, and a window-level handler would have to
      // guess.
      onPaste={(e) => {
        // Files only when the payload is not really text - see isAttachIntent. Ordinary text paste
        // falls straight through to TipTap, which has already handled it by the time this runs.
        const files = filesToAttach(e.clipboardData)
        if (files.length === 0) return
        e.preventDefault()
        void addFiles(files)
      }}
      onDragOver={(e) => {
        if (!isAttachIntent(e.dataTransfer.types)) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        // dragleave also fires when the pointer crosses into a CHILD element, which would flicker
        // the highlight off mid-drag. Only a leave that exits the composer entirely counts.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragging(false)
      }}
      onDrop={(e) => {
        const files = filesToAttach(e.dataTransfer)
        if (files.length === 0) return
        e.preventDefault()
        setDragging(false)
        void addFiles(files)
      }}>
      {replyingTo !== null && (
        // Small, quiet, and directly above the input, so the target of the next Enter is never
        // more than a glance away. It is the ONLY thing on screen that says where the message is
        // going, which is the cost of moving the box out of the thread - so it never scrolls.
        <div className='mb-1.5 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2 py-1 text-label'>
          <CornerDownRight className='size-3.5 shrink-0 text-muted-foreground' aria-hidden />
          <span className='truncate text-muted-foreground'>
            Replying to <span className='text-text'>{replyingTo.senderName}</span>
          </span>
          <button
            type='button'
            onClick={() => onCancelReply?.()}
            className='ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-text'
            aria-label='Cancel reply'>
            <X className='size-3.5' />
          </button>
        </div>
      )}
      <PendingAttachments
        pending={pending}
        uploading={uploading}
        onRemove={(id) => setPending((list) => list.filter((a) => a.id !== id))}
      />
      {frame}
      {error && <p className='mt-1 text-label text-danger'>{error}</p>}
    </div>
  )
}

/**
 * The uploaded-but-unsent files, above the input. Each is removable: a file attached by accident
 * should not force the person to send it or abandon the message.
 *
 * Removing only drops it from the claim list - the orphan stays on the server until the sweeper
 * takes it, which is the same outcome as closing the tab and costs nothing.
 */
function PendingAttachments({
  pending,
  uploading,
  onRemove,
}: {
  pending: ChatAttachment[]
  uploading: number
  onRemove: (id: string) => void
}) {
  if (pending.length === 0 && uploading === 0) return null

  return (
    <div className='mb-1.5 flex flex-wrap items-center gap-1.5'>
      {pending.map((a) => (
        <span
          key={a.id}
          className='flex items-center gap-1.5 rounded-md border border-border bg-bg py-1 pr-1 pl-2 text-label'>
          <span className='max-w-40 truncate'>{a.filename}</span>
          <span className='text-muted-foreground'>{formatBytes(a.bytes)}</span>
          <button
            type='button'
            onClick={() => onRemove(a.id)}
            className='rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-text'
            aria-label={`Remove ${a.filename}`}>
            <X className='size-3.5' />
          </button>
        </span>
      ))}
      {uploading > 0 && (
        <span className='text-label text-muted-foreground'>
          Uploading {uploading} file{uploading === 1 ? '' : 's'}…
        </span>
      )}
    </div>
  )
}
