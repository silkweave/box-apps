import { systemUserId } from '../../box-config.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentTrigger } from './agent-trigger.js'
import { listBlobs } from './blobs.js'
import { onChatEvent } from './bus.js'
import { parseMentionHandles } from './mentions.js'
import { CHAT_MIGRATIONS, migrateChat, type ChatMigration } from './migrations.js'
import { ChatStore, VISIBLE_SELECT, directSlug } from './store.js'
import {
  CHAT_ROOM_NAME_MAX,
  chatRoomName,
  ChatAccessError,
  ChatConflictError,
  ChatNotFoundError,
  ChatValidationError,
  type ChatBusEvent,
  type ChatEphemeralEvent,
  type ChatEvent,
  type ChatSender
} from './types.js'

const ALICE: ChatSender = { id: 'alice', display: 'Alice' }
const CAROL: ChatSender = { id: 'carol', display: 'Carol' }

/**
 * Pin the clock the store reads. Only `Date` is faked - the store arms no timers - and the real
 * clock comes back in afterEach. Used where a test wants to SAY what the clock reads (a backwards
 * step, a same-millisecond pair) rather than infer it from what the guard issued.
 */
const clockAt = (ms: number): void => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(ms)
}

/** The room's order-key guard, straight from the row - the invariant several cases pin. */
const headOf = (store: ChatStore, slug: string): number => {
  const room = store.roomBySlug(slug)!
  return (store.db.prepare('SELECT head_at AS n FROM rooms WHERE id = ?').get(room.id) as { n: number }).n
}

/** Collect only the ephemeral (outbox-less) events published while `fn` runs. */
const ephemerals = (fn: () => void): ChatEphemeralEvent[] => {
  const seen: ChatEphemeralEvent[] = []
  const off = onChatEvent((ev) => {
    if ('ephemeral' in ev) seen.push(ev)
  })
  try {
    fn()
  } finally {
    off()
  }
  return seen
}

describe('ChatStore', () => {
  let directory: string
  let store: ChatStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'box-chat-test-'))
    store = new ChatStore(join(directory, 'chat.db'))
  })

  afterEach(() => {
    vi.useRealTimers()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('seeds the default general room, open to everyone', () => {
    const general = store.roomBySlug('general')!
    expect(general.kind).toBe('room')
    // No join step exists any more: a channel is readable by every principal from the start.
    expect(store.canReadRoom(general.id, ALICE.id)).toBe(true)
    expect(store.canReadRoom(general.id, 'somebody-new')).toBe(true)
  })

  describe('threads', () => {
    it('a reply carries parentId, is issued its own key, and is a root-free timeline entry', () => {
      const root = store.post('general', ALICE, 'the question').payload
      const reply = store.post('general', CAROL, 'the answer', [], [], null, root.id).payload

      expect(reply.parentId).toBe(root.id)
      // A reply is an ordinary message on the outbox: its own key, after the root's, so it
      // counts as unread like any other message and the live feed needs no new frame type.
      expect(reply.createdAt).toBeGreaterThan(root.createdAt)

      // Flat (the default) still shows both, so a client that never learned about threads is
      // unaffected. Grouped shows the root only, with a summary hanging off it.
      expect(store.history('general', 'alice').messages.map((m) => m.id)).toEqual([root.id, reply.id])
      const grouped = store.history('general', 'alice', { roots: true }).messages
      expect(grouped.map((m) => m.id)).toEqual([root.id])
      expect(grouped[0].thread).toEqual({
        replyCount: 1,
        lastReplyAt: reply.createdAt,
        participants: ['carol']
      })
      // headAt is the guard, so it reflects the reply even though the page does not.
      expect(store.history('general', 'alice', { roots: true }).headAt).toBe(reply.createdAt)
    })

    it('re-parents a reply-to-a-reply onto the root: the hierarchy is one level deep', () => {
      const root = store.post('general', ALICE, 'root').payload
      const first = store.post('general', CAROL, 'first', [], [], null, root.id).payload
      const second = store.post('general', ALICE, 'second', [], [], null, first.id).payload

      expect(second.parentId).toBe(root.id)
      expect(store.thread('general', 'alice', root.id).replies.map((m) => m.id)).toEqual([first.id, second.id])
    })

    it('refuses a parent that is not a message of this room', () => {
      store.createRoom({ slug: 'side' }, ALICE)
      const elsewhere = store.post('side', ALICE, 'over here').payload
      expect(() => store.post('general', ALICE, 'reply', [], [], null, elsewhere.id)).toThrow(ChatNotFoundError)
      expect(() => store.post('general', ALICE, 'reply', [], [], null, 'no-such-id')).toThrow(ChatNotFoundError)
      // Refused, not silently posted top-level: a reply that lost its thread is worse than none.
      expect(store.history('general', 'alice').messages.map((m) => m.body)).toEqual([])
    })

    it('opens the whole thread from ANY message in it, root or reply', () => {
      const root = store.post('general', ALICE, 'root').payload
      const reply = store.post('general', CAROL, 'reply', [], [], null, root.id).payload

      for (const id of [root.id, reply.id]) {
        const page = store.thread('general', 'alice', id)
        expect(page.parent.id).toBe(root.id)
        expect(page.replies.map((m) => m.id)).toEqual([reply.id])
      }
    })

    it('drops the summary when the last reply is deleted - and the reply is simply gone', () => {
      const root = store.post('general', ALICE, 'root').payload
      const reply = store.post('general', CAROL, 'oops', [], [], null, root.id).payload
      store.deleteMessage('general', reply.id, 'carol')

      // No summary: an empty disclosure triangle nobody can open is worse than no triangle.
      expect(store.history('general', 'alice', { roots: true }).messages[0].thread).toBeUndefined()
      // No tombstone either: the count and the list agree because there is nothing to list.
      expect(store.thread('general', 'alice', root.id).replies).toEqual([])
      // The root itself is untouched by a reply's deletion.
      expect(store.message(root.roomId, root.id)?.body).toBe('root')
    })

    it('paging is over ROOTS, so a busy thread cannot push the timeline out from under a reader', () => {
      const root = store.post('general', ALICE, 'root').payload
      for (let i = 0; i < 10; i += 1) store.post('general', CAROL, `r${i}`, [], [], null, root.id)
      const later = store.post('general', ALICE, 'later').payload

      const page = store.history('general', 'alice', { roots: true, limit: 2 })
      expect(page.messages.map((m) => m.id)).toEqual([root.id, later.id])
      expect(page.nextCursor).toBeNull()
      expect(page.messages[0].thread?.replyCount).toBe(10)
    })

    it('a thread whose ROOT the agent wrote is the agent\'s, so a bare reply reaches it', () => {
      // nova posts something of its own (an announcement, a scheduled report, an orphan turn's
      // text) and somebody replies without tagging it. That reply is aimed at nova and nothing
      // else - the root's author is who you are replying TO.
      const ABI: ChatSender = { id: 'nova', display: 'Nova Atomic' }
      const root = store.post('general', ABI, 'The nightly ingest finished: 412 new stars.').payload
      store.post('general', ALICE, 'Which repos moved most?', [], [], null, root.id)
      expect(store.threadHasSender(root.id, 'nova')).toBe(true)
    })

    it('message() is a room-scoped point read - the agent trigger reads the root through it', () => {
      const root = store.post('general', ALICE, '@nova what is our star count?').payload
      expect(store.message(root.roomId, root.id)?.body).toBe('@nova what is our star count?')
      expect(store.message(root.roomId, 'no-such-id')).toBeNull()
      store.createRoom({ slug: 'other' }, CAROL)
      const other = store.roomBySlug('other')
      expect(store.message(other?.id ?? '', root.id)).toBeNull()
    })

    it('threadHasSender sees the root author and every replier still in the thread', () => {
      const root = store.post('general', ALICE, 'root').payload
      const reply = store.post('general', CAROL, 'reply', [], [], null, root.id).payload

      expect(store.threadHasSender(root.id, 'alice')).toBe(true)
      expect(store.threadHasSender(root.id, 'carol')).toBe(true)
      expect(store.threadHasSender(root.id, 'nova')).toBe(false)
      // A deleted contribution stops counting - the agent should not be re-summoned by a message
      // that no longer exists.
      store.deleteMessage('general', reply.id, 'carol')
      expect(store.threadHasSender(root.id, 'carol')).toBe(false)
    })

    it('a mention inside a thread still seeds the read pointer and notifies', () => {
      const root = store.post('general', ALICE, 'root').payload
      let reply: ChatEvent | undefined
      const events = ephemerals(() => {
        reply = store.post('general', ALICE, 'over to you @carol', ['carol'], [], null, root.id)
      })
      expect(events.filter((e) => e.type === 'mention.created').map((e) => e.userId)).toEqual(['carol'])
      // Carol had never opened the room: the mention seeds his pointer one key before the reply, so
      // the reply alone is owed - the root is not retroactively badged.
      const carol = store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!
      expect(carol.lastReadAt).toBe(reply!.at - 1)
      expect(carol.unread).toBe(1)
    })
  })

  describe('the order key (createdAt, issued by the room guard)', () => {
    it('is unique and strictly increasing across two connections to the same file', () => {
      // Two live handles on one database is the real deployment shape (server + a script).
      // better-sqlite3 is synchronous so the interleaving is deterministic, but every post still
      // runs its own IMMEDIATE transaction against a contended file, and the two handles share
      // NOTHING in memory - the row-side guard, not luck, is what keeps the keys distinct when
      // twenty posts land inside a couple of milliseconds.
      const second = new ChatStore(join(directory, 'chat.db'))
      try {
        const keys: number[] = []
        for (let i = 0; i < 20; i++) {
          keys.push((i % 2 === 0 ? store : second).post('general', i % 2 === 0 ? ALICE : CAROL, `m${i}`).payload.createdAt)
        }
        for (let i = 1; i < keys.length; i++) expect(keys[i]).toBeGreaterThan(keys[i - 1])
        expect(new Set(keys).size).toBe(20)
        // What history reads back is the same order the posts were issued in.
        expect(store.history('general', ALICE.id).messages.map((m) => m.createdAt)).toEqual(keys)
      } finally {
        second.close()
      }
    })

    it('issues consecutive keys to posts that share a millisecond', () => {
      clockAt(1_000)
      const a = store.post('general', ALICE, 'a').payload
      const b = store.post('general', CAROL, 'b').payload
      const c = store.post('general', ALICE, 'c').payload
      expect([a.createdAt, b.createdAt, c.createdAt]).toEqual([1_000, 1_001, 1_002])
      expect(headOf(store, 'general')).toBe(1_002)
    })

    // THE key risk of a time-shaped key, pinned: an NTP correction or a VM resume can move the
    // clock backwards, and a key read off the clock would then collide with or sort before one
    // already issued. The guard issues `MAX(head + 1, now)`, so order and uniqueness survive and
    // the keys run ahead of the clock until it catches up - the accepted cost.
    it('stays monotonic when the clock steps backwards, on either connection', () => {
      const second = new ChatStore(join(directory, 'chat.db'))
      try {
        clockAt(5_000)
        expect(store.post('general', ALICE, 'before the step').payload.createdAt).toBe(5_000)

        clockAt(4_000) // the clock steps back a second
        expect(second.post('general', CAROL, 'during, other handle').payload.createdAt).toBe(5_001)
        expect(store.post('general', ALICE, 'during, this handle').payload.createdAt).toBe(5_002)

        clockAt(9_000) // real time catches up; the key snaps back to the clock
        expect(store.post('general', CAROL, 'after').payload.createdAt).toBe(9_000)

        expect(store.history('general', ALICE.id).messages.map((m) => m.body)).toEqual([
          'before the step',
          'during, other handle',
          'during, this handle',
          'after'
        ])
      } finally {
        second.close()
      }
    })

    it('rolls the issued key back with the failed post', () => {
      clockAt(1_000)
      store.post('general', ALICE, 'first') // 1000
      const room = store.roomBySlug('general')!
      // Poison the NEXT key: at a frozen clock the guard will issue 1001, and a conflicting row
      // there makes the insert violate UNIQUE(room_id, created_at) - so the whole transaction,
      // guard bump included, must roll back.
      store.db
        .prepare(
          `INSERT INTO messages (id, room_id, sender_id, sender_name, body, created_at)
           VALUES ('poison', ?, 'x', 'x', 'x', 1001)`
        )
        .run(room.id)

      const seen: ChatBusEvent[] = []
      const off = onChatEvent((ev) => seen.push(ev))
      expect(() => store.post('general', ALICE, 'never lands')).toThrow()
      off()

      // Nothing was published for the failed post - publish happens only after commit.
      expect(seen).toHaveLength(0)
      // The guard rolled back to where it was, so after removing the poison row the same key is
      // issued cleanly rather than skipped.
      expect(headOf(store, 'general')).toBe(1_000)
      store.db.prepare(`DELETE FROM messages WHERE id = 'poison'`).run()
      expect(store.post('general', ALICE, 'retry').payload.createdAt).toBe(1_001)
      // And the outbox has exactly one event per surviving message, keyed like the message.
      expect(store.eventsAfter(0, ALICE.id, 100).map((e) => e.at)).toEqual([1_000, 1_001])
    })

    it('never re-issues a retired key: deleting the newest message does not rewind the guard', () => {
      clockAt(1_000)
      store.post('general', ALICE, 'stays')
      const newest = store.post('general', ALICE, 'goes').payload // 1001
      store.markRead('general', CAROL.id, newest.createdAt) // Carol has read through 1001
      store.deleteMessage('general', newest.id, ALICE.id)

      // Still 1001, not MAX(created_at) = 1000: a guard seeded from surviving rows would issue
      // 1001 again to the next message, which Carol's pointer already covers - born read, invisible.
      expect(headOf(store, 'general')).toBe(1_001)
      const next = store.post('general', ALICE, 'new').payload
      expect(next.createdAt).toBe(1_002)
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!.unread).toBe(1)
    })

    it('publishes each committed event on the bus, after commit, with increasing global ids', () => {
      const seen: ChatEvent[] = []
      // post() emits outbox rows only - an ephemeral here would double-count unread client-side.
      const off = onChatEvent((ev) => {
        expect('ephemeral' in ev).toBe(false)
        if (!('ephemeral' in ev)) seen.push(ev)
      })
      try {
        store.post('general', ALICE, 'a')
        store.post('general', CAROL, 'b')
      } finally {
        off()
      }
      expect(seen.map((e) => e.payload.body)).toEqual(['a', 'b'])
      expect(seen[1].id).toBeGreaterThan(seen[0].id)
      expect(seen[0].payload.senderName).toBe('Alice')
    })

    it('refuses to post inside an enclosing transaction (publish-after-commit)', () => {
      expect(() => store.transaction(() => store.post('general', ALICE, 'nested'))).toThrow(/enclosing transaction/)
    })
  })

  describe('history', () => {
    it('pages backwards from the cursor but returns oldest-first, ending with a null cursor', () => {
      clockAt(1_000)
      for (let i = 1; i <= 5; i++) store.post('general', ALICE, `m${i}`) // keys 1000..1004

      const first = store.history('general', ALICE.id, { limit: 2 })
      expect(first.messages.map((m) => m.createdAt)).toEqual([1_003, 1_004])
      expect(first.nextCursor).toBe(1_003)
      expect(first.headAt).toBe(1_004)

      const second = store.history('general', ALICE.id, { before: first.nextCursor!, limit: 2 })
      expect(second.messages.map((m) => m.createdAt)).toEqual([1_001, 1_002])
      expect(second.nextCursor).toBe(1_001)

      // The last page is short and reaches the start of the room: cursor null, nothing older.
      const last = store.history('general', ALICE.id, { before: second.nextCursor!, limit: 2 })
      expect(last.messages.map((m) => m.createdAt)).toEqual([1_000])
      expect(last.nextCursor).toBeNull()
    })

    it('a cursor stays valid when the message it was taken from is deleted mid-page', () => {
      clockAt(1_000)
      for (let i = 1; i <= 5; i++) store.post('general', ALICE, `m${i}`) // keys 1000..1004
      const first = store.history('general', ALICE.id, { limit: 2 }) // m4, m5; cursor 1003 (m4)
      const m4 = first.messages[0]

      // The client is holding cursor 1003 when m4 - the very message the cursor came from - and
      // m2 (inside the next page) are deleted. A cursor is a bare key compared with `<`, so the
      // next page is exactly what is older than 1003 and still exists: nothing skipped, nothing
      // repeated, no row needed for the cursor to resolve against.
      store.deleteMessage('general', m4.id, ALICE.id)
      const m2 = store.history('general', ALICE.id).messages.find((m) => m.body === 'm2')!
      store.deleteMessage('general', m2.id, ALICE.id)

      const second = store.history('general', ALICE.id, { before: first.nextCursor!, limit: 2 })
      expect(second.messages.map((m) => m.body)).toEqual(['m1', 'm3'])
      expect(second.nextCursor).toBeNull()
    })

    it('serves an empty room as an empty page with a null cursor', () => {
      const page = store.history('general', ALICE.id, {})
      expect(page.messages).toEqual([])
      expect(page.nextCursor).toBeNull()
      expect(page.headAt).toBe(0)
    })
  })

  describe('unread - a count over surviving messages past the pointer', () => {
    const carol = (): number => store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!.unread

    it('counts what is past the pointer, clamped and monotonic under markRead', () => {
      clockAt(1_000)
      store.post('general', ALICE, 'one') // 1000
      store.post('general', ALICE, 'two') // 1001
      // Nothing owed before Carol has ever read here: no pointer, no badge for the history.
      expect(carol()).toBe(0)

      // markRead answers with the stored pointer AND the recount - the number the other tabs
      // adopt - and this first one CREATES Carol's pointer: there is no join step before it.
      expect(store.markRead('general', CAROL.id, 1_000)).toEqual({ lastReadAt: 1_000, unread: 1 })
      store.post('general', ALICE, 'three') // 1002
      expect(carol()).toBe(2)
      expect(store.markRead('general', CAROL.id, 1_001)).toEqual({ lastReadAt: 1_001, unread: 1 })
      expect(carol()).toBe(1)

      // Clamped: a client can never ack past what the room has issued.
      expect(store.markRead('general', CAROL.id, 99_999)).toEqual({ lastReadAt: 1_002, unread: 0 })
      // Monotonic: a stale tab acking an old key must not resurrect unread.
      expect(store.markRead('general', CAROL.id, 1_000)).toEqual({ lastReadAt: 1_002, unread: 0 })
      expect(carol()).toBe(0)

      // The sender's own pointer came free with his FIRST post (born read), and his later two
      // did not move it: posting seeds a pointer, only markRead advances one.
      expect(store.roomsVisibleTo(ALICE.id).find((r) => r.slug === 'general')).toMatchObject({
        lastReadAt: 1_000,
        unread: 2
      })
    })

    it('decrements when an unread message is deleted, and holds when a read one is', () => {
      clockAt(1_000)
      const read = store.post('general', ALICE, 'read').payload // 1000
      store.markRead('general', CAROL.id, read.createdAt)
      const a = store.post('general', ALICE, 'a').payload // 1001
      store.post('general', ALICE, 'b') // 1002
      expect(carol()).toBe(2)

      // The whole point of counting rather than subtracting: the old
      // `next_seq - 1 - last_read_seq` would have stayed 2 here forever, which is why a hard
      // delete was impossible under it.
      store.deleteMessage('general', a.id, ALICE.id)
      expect(carol()).toBe(1)
      store.deleteMessage('general', read.id, ALICE.id)
      expect(carol()).toBe(1)
    })

    // The count is a correlated subquery per room; this pins that it is a covering range scan of
    // the (room_id, created_at) unique index and never a table scan - the cost argument in the
    // VISIBLE_SELECT comment, verified rather than assumed.
    it('is served by the (room_id, created_at) index, per EXPLAIN QUERY PLAN', () => {
      const plan = store.db
        .prepare(`EXPLAIN QUERY PLAN ${VISIBLE_SELECT} WHERE r.id = ?`)
        .all(CAROL.id, 'any') as { detail: string }[]
      // By ALIAS, not by index name: since the lastMessage preview joined in (2026-09-04) two
      // different steps use `messages_room_created`, and matching the first one found would silently
      // start asserting about the wrong subquery.
      const count = plan.find((step) => /\bmsg\b/.test(step.detail))
      expect(count?.detail).toMatch(/SEARCH msg USING COVERING INDEX messages_room_created \(room_id=\? AND created_at>\?\)/)
      expect(plan.some((step) => /SCAN msg\b/.test(step.detail))).toBe(false)
      // The preview costs one ordered lookup on the same index plus a primary-key fetch of that
      // single row - never a scan of the room's history.
      const newest = plan.find((step) => /\bx\b/.test(step.detail))
      expect(newest?.detail).toMatch(/SEARCH x USING INDEX messages_room_created \(room_id=\?\)/)
      expect(plan.some((step) => /SCAN (x|lm)\b/.test(step.detail))).toBe(false)
    })
  })

  describe('the lastMessage preview', () => {
    it('is the newest surviving message, and falls back to null when the room empties', () => {
      clockAt(2_000)
      const first = store.post('general', ALICE, 'first').payload
      const second = store.post('general', ALICE, 'second').payload
      const summary = () => store.roomsVisibleTo(ALICE.id).find((r) => r.slug === 'general')!
      expect(summary().lastMessage).toEqual({
        senderId: ALICE.id,
        senderName: ALICE.display,
        preview: 'second',
        at: second.createdAt
      })

      // A delete must move it BACK, which is the whole reason it reads the messages table rather
      // than `head_at` - the allocator guard outlives the message it was issued for.
      store.deleteMessage('general', second.id, ALICE.id)
      expect(summary().lastMessage?.preview).toBe('first')
      expect(summary().lastMessage?.at).toBe(first.createdAt)
      store.deleteMessage('general', first.id, ALICE.id)
      expect(summary().lastMessage).toBeNull()
    })

    it('collapses whitespace and truncates a long body', () => {
      store.post('general', ALICE, `line one\n\n   line   two`)
      expect(store.roomsVisibleTo(ALICE.id).find((r) => r.slug === 'general')!.lastMessage?.preview).toBe(
        'line one line two'
      )
      store.post('general', ALICE, 'x'.repeat(400))
      const preview = store.roomsVisibleTo(ALICE.id).find((r) => r.slug === 'general')!.lastMessage!.preview
      expect(preview.endsWith('…')).toBe(true)
      // 140 body chars plus the ellipsis: a hint about the conversation, not a copy of it.
      expect(preview).toHaveLength(141)
    })

    it('is visible to someone who has never opened the room, unlike unread', () => {
      store.post('general', ALICE, 'hello')
      const seen = store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!
      expect(seen.lastReadAt).toBeNull()
      expect(seen.unread).toBe(0)
      // A preview is a property of the room's content, and Carol can open the room and read every
      // word of it whenever he likes.
      expect(seen.lastMessage?.preview).toBe('hello')
    })
  })

  describe('readability - every channel is everybody\'s, a DM is its pair\'s', () => {
    /** Does Carol hold a room_members row in `general`? The table is per-user state now, so the
     *  test reads it directly rather than through a public "isMember" that no longer exists. */
    const danHasRow = (): boolean =>
      store.db
        .prepare('SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?')
        .get(store.roomBySlug('general')!.id, CAROL.id) !== undefined

    it('a user who has never touched a room can read it, post in it, and mark it read', () => {
      clockAt(1_000)
      store.createRoom({ slug: 'deploys' }, ALICE)
      store.post('deploys', ALICE, 'shipped') // 1000
      // Carol has never been near #deploys - no join, no invite, no row - and every verb works.
      expect(store.history('deploys', CAROL.id).messages.map((m) => m.body)).toEqual(['shipped'])
      const mine = store.post('deploys', CAROL, 'nice').payload // 1001
      expect(store.markRead('deploys', CAROL.id, mine.createdAt)).toEqual({ lastReadAt: 1_001, unread: 0 })
      expect(store.setReaction('deploys', mine.id, 'bob', '👍', true)).toHaveLength(1)
      expect(store.updateRoom('deploys', 'bob', { topic: 'ships' }).topic).toBe('ships')
    })

    it('reading writes no state; posting seeds the read pointer at your own message', () => {
      const hello = store.post('general', ALICE, 'hello').payload
      expect(store.history('general', CAROL.id).messages).toHaveLength(1)
      // Reading creates no row: `lastReadAt` stays null and the badge stays 0, so a glance at a
      // busy room does not badge it with everything ever said there.
      expect(danHasRow()).toBe(false)
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')).toMatchObject({
        lastReadAt: null,
        unread: 0
      })
      // Posting does seed one, at the head - his own words born read, Alice's earlier one too.
      const mine = store.post('general', CAROL, 'joins in').payload
      expect(danHasRow()).toBe(true)
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')).toMatchObject({
        lastReadAt: mine.createdAt,
        unread: 0
      })
      expect(mine.createdAt).toBeGreaterThan(hello.createdAt)
    })

    it('markRead CREATES the pointer for a first-time reader - there is no join step', () => {
      clockAt(1_000)
      store.post('general', ALICE, 'one') // 1000
      store.post('general', ALICE, 'two') // 1001
      expect(danHasRow()).toBe(false)

      // The first markRead is the row's birth, seeded at the acked key - not at the head, so
      // what he had not scrolled to stays owed; not at 0, so the history is not all owed.
      const seen = ephemerals(() => {
        expect(store.markRead('general', CAROL.id, 1_000)).toEqual({ lastReadAt: 1_000, unread: 1 })
      })
      expect(danHasRow()).toBe(true)
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')).toMatchObject({
        lastReadAt: 1_000,
        unread: 1
      })
      // Born like any other markRead: the same member.read, to his other tabs.
      expect(seen.map((e) => [e.type, e.userId, e.read])).toEqual([['member.read', CAROL.id, { lastReadAt: 1_000, unread: 1 }]])
      // And clamped on creation too: a first ack past the head lands on the head.
      expect(store.markRead('general', 'bob', 99_999)).toEqual({ lastReadAt: 1_001, unread: 0 })
    })

    it('filters the feed replay by READABILITY: every channel, only your own DMs', () => {
      store.post('general', ALICE, 'channel')
      store.openDirect(ALICE, 'bob')
      store.post(directSlug(ALICE.id, 'bob'), ALICE, 'between us')

      expect(store.eventsAfter(0, ALICE.id, 100).map((e) => e.payload.body)).toEqual(['channel', 'between us'])
      // Carol has never read #general and still receives it - otherwise an open room would silently
      // freeze until the next refetch and the UI would lie. The DM he is not in stays invisible.
      expect(store.eventsAfter(0, CAROL.id, 100).map((e) => e.payload.body)).toEqual(['channel'])
      // The cursor is exclusive: resuming from the high-water mark replays nothing.
      expect(store.eventsAfter(store.latestEventId(), ALICE.id, 100)).toEqual([])
    })

    it('canReadRoom is the one rule the feed filter uses', () => {
      const dm = store.openDirect(ALICE, 'bob')
      const general = store.roomBySlug('general')!
      expect(store.canReadRoom(general.id, CAROL.id)).toBe(true) // a channel: anyone, no row needed
      expect(store.canReadRoom(dm.id, CAROL.id)).toBe(false) // a DM: not one of the pair
      expect(store.canReadRoom(dm.id, ALICE.id)).toBe(true) // a DM: one of the pair
      expect(store.canReadRoom('no-such-room', ALICE.id)).toBe(false)
    })

    it('refuses everything on a room that does not exist, and duplicate creates', () => {
      expect(() => store.post('nope', ALICE, 'x')).toThrow(ChatNotFoundError)
      expect(() => store.history('nope', ALICE.id)).toThrow(ChatNotFoundError)
      expect(() => store.markRead('nope', ALICE.id, 1)).toThrow(ChatNotFoundError)
      expect(() => store.createRoom({ slug: 'general' }, ALICE)).toThrow(ChatConflictError)
    })

    it('still gates MUTATION on ownership, which openness does not loosen', () => {
      const posted = store.post('general', ALICE, 'mine').payload
      // Carol can read and post anywhere, and still cannot touch someone else's words.
      expect(store.history('general', CAROL.id).messages).toHaveLength(1)
      expect(() => store.editMessage('general', posted.id, CAROL.id, 'not yours')).toThrow(ChatAccessError)
      expect(() => store.deleteMessage('general', posted.id, CAROL.id)).toThrow(ChatAccessError)
    })
  })

  describe('the read pointer - per-user state, created lazily', () => {
    it('lists every channel for everyone, with a null pointer and no badge until they read', () => {
      store.createRoom({ slug: 'deploys' }, ALICE)
      store.post('deploys', ALICE, 'one')
      store.openDirect(ALICE, 'bob')

      const visible = store.roomsVisibleTo(CAROL.id)
      // Both channels, and not the DM between two other people.
      expect(visible.map((r) => r.slug)).toEqual(['deploys', 'general'])
      const deploys = visible.find((r) => r.slug === 'deploys')!
      // Carol holds no pointer, so there is none to report - and the badge reads 0 rather than
      // "everything ever said here". `lastReadAt === null` is the client's "never opened" test.
      expect(deploys.lastReadAt).toBeNull()
      expect(deploys.unread).toBe(0)
      expect(deploys.peer).toBeNull()
      // Alice's pointer in #deploys came with creating it (seeded at 0, then his post moved
      // nothing - posting never moves an existing pointer), and the seeded `general` gave nobody
      // a pointer: even Alice has none there until he reads or posts.
      const alice = store.roomsVisibleTo(ALICE.id)
      expect(alice.map((r) => r.slug)).toEqual(['deploys', 'dm:alice:bob', 'general'])
      expect(alice.find((r) => r.slug === 'deploys')!.lastReadAt).toBe(0)
      expect(alice.find((r) => r.slug === 'general')!.lastReadAt).toBeNull()
    })

    it('markRead moves neither the guard nor the outbox', () => {
      for (const body of ['one', 'two', 'three']) store.post('general', ALICE, body)
      const before = { head: headOf(store, 'general'), events: store.eventsAfter(0, ALICE.id, 100).length }

      store.markRead('general', CAROL.id, before.head)
      // A pointer is not an event: no key issued, no outbox row. Only a post may move either.
      expect(headOf(store, 'general')).toBe(before.head)
      expect(store.eventsAfter(0, ALICE.id, 100)).toHaveLength(before.events)

      store.post('general', ALICE, 'four')
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!.unread).toBe(1)
    })

    it('reading history moves nothing at all', () => {
      store.post('general', ALICE, 'one')
      const before = headOf(store, 'general')
      store.history('general', CAROL.id)
      expect(headOf(store, 'general')).toBe(before)
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!.lastReadAt).toBeNull()
    })

    it("a first-time poster's own message is born read", () => {
      for (const body of ['one', 'two', 'three']) store.post('general', ALICE, body)
      const mine = store.post('general', CAROL, 'my first').payload

      const carol = store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!
      // Seeded AFTER the key was issued, so the pointer includes his own message: nothing owed.
      expect(carol.lastReadAt).toBe(mine.createdAt)
      expect(carol.unread).toBe(0)
    })

    it('posting never moves an EXISTING pointer - backlog survives posting blind', () => {
      store.markRead('general', CAROL.id, 0) // Carol's pointer at 0: everything that lands is owed
      store.post('general', ALICE, 'one')
      store.post('general', ALICE, 'two')
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!.unread).toBe(2)

      store.post('general', CAROL, 'blind reply')
      // His two unread stay owed, plus the one he just wrote: OR IGNORE left the pointer alone,
      // and markRead remains the ONLY thing that moves an existing pointer.
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!.unread).toBe(3)
    })

    it('a room ends only by being deleted - nothing else takes it out of anybody\'s list', () => {
      store.createRoom({ slug: 'deploys' }, ALICE)
      store.post('deploys', CAROL, 'here')
      store.markRead('deploys', 'bob', 0)
      // Reading, posting and marking read only ever ADD per-user state; no verb in this store
      // removes a pointer row or a person from a channel.
      expect(store.roomsVisibleTo(CAROL.id).map((r) => r.slug)).toEqual(['deploys', 'general'])
      expect(store.roomsVisibleTo('bob').map((r) => r.slug)).toEqual(['deploys', 'general'])
      store.deleteRoom('deploys', 'bob')
      expect(store.roomsVisibleTo(CAROL.id).map((r) => r.slug)).toEqual(['general'])
    })
  })

  describe('ephemeral fan-out (no outbox row)', () => {
    it('markRead emits member.read with the STORED (clamped, monotonic) state, after commit', () => {
      clockAt(1_000)
      store.post('general', ALICE, 'one') // 1000
      store.post('general', ALICE, 'two') // 1001
      const seen = ephemerals(() => store.markRead('general', ALICE.id, 99_999))
      expect(seen).toHaveLength(1)
      expect(seen[0].type).toBe('member.read')
      expect(seen[0].userId).toBe(ALICE.id)
      // Clamped to the guard, not the client's 99999 - and carrying the recount, so the other
      // tabs adopt a number rather than extrapolating one.
      expect(seen[0].read).toEqual({ lastReadAt: 1_001, unread: 0 })
      // A stale ack broadcasts the newer stored pointer, never a regression.
      const stale = ephemerals(() => store.markRead('general', ALICE.id, 1_000))
      expect(stale[0].read).toEqual({ lastReadAt: 1_001, unread: 0 })
    })

    it('a refused markRead (a DM you are not in) emits nothing', () => {
      store.openDirect(ALICE, 'bob')
      const seen = ephemerals(() => {
        expect(() => store.markRead(directSlug(ALICE.id, 'bob'), CAROL.id, 1)).toThrow(ChatAccessError)
        expect(() => store.markRead('nope', CAROL.id, 1)).toThrow(ChatNotFoundError)
      })
      expect(seen).toHaveLength(0)
    })

    it('createRoom emits room.created to the room readers and issues NO key', () => {
      let summary: ReturnType<ChatStore['createRoom']> | undefined
      const seen = ephemerals(() => {
        summary = store.createRoom({ slug: 'deploys' }, ALICE)
      })
      expect(seen).toHaveLength(1)
      expect(seen[0].type).toBe('room.created')
      // Routed to the room's READERS (null), not just its creator: a new PUBLIC room should
      // appear live in everyone's sidebar now that it is visible without joining.
      expect(seen[0].userId).toBeNull()
      expect(seen[0].roomId).toBe(summary!.id)
      // Head-seeding is a no-op on a brand-new room: the guard is 0, so the creator seeds at 0.
      expect(summary!.lastReadAt).toBe(0)
      // The trap this design avoids: an outbox row would be a phantom message in a brand-new
      // empty room.
      expect(summary!.headAt).toBe(0)
      expect(summary!.unread).toBe(0)
      expect(store.eventsAfter(0, ALICE.id, 100)).toHaveLength(0)
    })

    it('a refused createRoom (duplicate slug) emits nothing', () => {
      store.createRoom({ slug: 'deploys' }, ALICE)
      const seen = ephemerals(() => {
        expect(() => store.createRoom({ slug: 'deploys' }, CAROL)).toThrow(ChatConflictError)
      })
      expect(seen).toHaveLength(0)
    })

    it('markRead and createRoom refuse an enclosing transaction (publish-after-commit)', () => {
      expect(() => store.transaction(() => store.markRead('general', ALICE.id, 1))).toThrow(/enclosing transaction/)
      expect(() => store.transaction(() => store.createRoom({ slug: 'x' }, ALICE))).toThrow(/enclosing transaction/)
    })
  })

  describe('edits and deletes', () => {
    /** The room's guard and the two members' unread, read straight from the store. */
    const counters = (): { head: number; aliceUnread: number; carolUnread: number } => {
      const unread = (id: string): number => store.roomsVisibleTo(id).find((r) => r.slug === 'general')!.unread
      return { head: headOf(store, 'general'), aliceUnread: unread(ALICE.id), carolUnread: unread(CAROL.id) }
    }

    it('edit replaces the body and stamps edited_at, leaving createdAt alone', () => {
      const posted = store.post('general', ALICE, 'frist').payload
      const edited = store.editMessage('general', posted.id, ALICE.id, 'first')
      expect(edited.body).toBe('first')
      expect(edited.editedAt).not.toBeNull()
      expect(edited.createdAt).toBe(posted.createdAt)
      // History, not just the return value: the stored row is what a reconnecting client converges on.
      const page = store.history('general', ALICE.id)
      expect(page.messages.at(-1)).toEqual(edited)
    })

    // THE bug this change was made for: the outbox payload is the whole message, body included,
    // and nothing ever removed it - so "deleted" text survived in events.payload and a client
    // resuming from an older cursor replayed it straight back onto the screen.
    it('delete is HARD - the row AND its outbox row are gone, so replay cannot resurrect it', () => {
      store.post('general', ALICE, 'stays')
      const posted = store.post('general', ALICE, 'the secret').payload
      const cursorBeforeAnything = 0
      expect(store.eventsAfter(cursorBeforeAnything, CAROL.id, 100).map((e) => e.payload.body)).toEqual([
        'stays',
        'the secret'
      ])

      const result = store.deleteMessage('general', posted.id, ALICE.id)
      expect(result).toEqual({
        roomId: posted.roomId,
        messageId: posted.id,
        deleted: [posted.id],
        blobs: 0,
        agentSessionDropped: false
      })

      // The row: gone from history, from the point read, and from the file.
      expect(store.history('general', ALICE.id).messages.map((m) => m.body)).toEqual(['stays'])
      expect(store.message(posted.roomId, posted.id)).toBeNull()
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(posted.id)).toEqual({ n: 0 })
      // The outbox row: a reconnect from ANY older cursor never sees the text again.
      expect(store.eventsAfter(cursorBeforeAnything, CAROL.id, 100).map((e) => e.payload.body)).toEqual(['stays'])
      expect(store.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE payload LIKE '%the secret%'`).get()).toEqual({
        n: 0
      })
      // The guard did NOT rewind (see the order-key cases): the head still names the retired key.
      expect(headOf(store, 'general')).toBe(posted.createdAt)
    })

    it('refuses a non-sender, even another reader of the room', () => {
      const posted = store.post('general', ALICE, 'mine').payload
      store.markRead('general', CAROL.id, posted.createdAt)
      expect(() => store.editMessage('general', posted.id, CAROL.id, 'yours')).toThrow(ChatAccessError)
      expect(() => store.deleteMessage('general', posted.id, CAROL.id)).toThrow(ChatAccessError)
      expect(store.history('general', ALICE.id).messages[0].body).toBe('mine')
    })

    it('a deleted message is not there: edit and a repeat delete both answer not-found', () => {
      const posted = store.post('general', ALICE, 'gone').payload
      store.deleteMessage('general', posted.id, ALICE.id)
      expect(() => store.editMessage('general', posted.id, ALICE.id, 'back')).toThrow(ChatNotFoundError)
      // Not idempotent, and it cannot be: nothing distinguishes a deleted id from one that never
      // existed. A double-tap from two tabs gets a 404 on the second, which is the honest answer.
      expect(() => store.deleteMessage('general', posted.id, ALICE.id)).toThrow(ChatNotFoundError)
    })

    it('refuses an unknown message id and a message from another room', () => {
      store.createRoom({ slug: 'deploys' }, ALICE)
      const posted = store.post('deploys', ALICE, 'elsewhere').payload
      expect(() => store.editMessage('general', posted.id, ALICE.id, 'x')).toThrow(ChatNotFoundError)
      expect(() => store.deleteMessage('general', 'no-such-id', ALICE.id)).toThrow(ChatNotFoundError)
    })

    it('edit issues NO key and writes NO outbox row, so no unread badge moves', () => {
      store.post('general', ALICE, 'one')
      const posted = store.post('general', ALICE, 'two').payload
      store.markRead('general', CAROL.id, posted.createdAt)
      const before = counters()
      const outboxBefore = store.eventsAfter(0, ALICE.id, 100).length

      store.editMessage('general', posted.id, ALICE.id, 'two (fixed)')

      // An outbox row here would be a phantom `message.created` in every client - and a moved
      // guard would let the edit badge a room for words everyone has already read.
      expect(counters()).toEqual(before)
      expect(store.eventsAfter(0, ALICE.id, 100)).toHaveLength(outboxBefore)
      expect(store.history('general', ALICE.id).headAt).toBe(posted.createdAt)
    })

    it('delete leaves the guard and every read pointer alone; only the counts move', () => {
      store.markRead('general', CAROL.id, 0) // Carol's pointer at 0, ahead of everything below
      const one = store.post('general', ALICE, 'one').payload // seeds Alice's pointer at 'one'
      const posted = store.post('general', ALICE, 'two').payload
      const before = counters()
      expect(before).toMatchObject({ aliceUnread: 1, carolUnread: 2 })

      store.deleteMessage('general', posted.id, ALICE.id)

      // Both owed 'two'; neither pointer was touched; the guard still names the retired key.
      expect(counters()).toEqual({ head: before.head, aliceUnread: 0, carolUnread: 1 })
      const pointer = (id: string): number | null => store.roomsVisibleTo(id).find((r) => r.slug === 'general')!.lastReadAt
      expect(pointer(ALICE.id)).toBe(one.createdAt)
      expect(pointer(CAROL.id)).toBe(0)
    })

    it('emits message.edited with the stored row and message.deleted with the row\'s identity only', () => {
      const posted = store.post('general', ALICE, 'before').payload
      const seen = ephemerals(() => {
        store.editMessage('general', posted.id, ALICE.id, 'after')
        store.deleteMessage('general', posted.id, ALICE.id)
      })
      expect(seen.map((e) => e.type)).toEqual(['message.edited', 'message.deleted'])
      for (const ev of seen) {
        expect(ev.ephemeral).toBe(true)
        expect(ev.roomId).toBe(posted.roomId)
        // null = fan out to the room's readers; the server applies the canReadRoom filter.
        expect(ev.userId).toBeNull()
        // The message's OWN key travels on the payload, so a client can locate the row it names.
        expect(ev.payload?.createdAt).toBe(posted.createdAt)
        expect(ev.payload?.id).toBe(posted.id)
      }
      expect(seen[0].payload?.body).toBe('after')
      // The delete frame says WHICH message went, never what it said.
      expect(seen[1].payload).toEqual({
        id: posted.id,
        roomId: posted.roomId,
        senderId: ALICE.id,
        senderName: 'Alice',
        body: '',
        createdAt: posted.createdAt,
        editedAt: expect.any(Number)
      })
    })

    describe('a thread root CASCADES', () => {
      const ABI: ChatSender = { id: 'nova', display: 'Nova' }

      it('takes every reply with it - rows, outbox rows, mentions, attachments - whoever wrote them', () => {
        store.markRead('general', CAROL.id, 0) // Carol's pointer at 0: everything below is owed
        const root = store.post('general', ALICE, 'root').payload
        const shot = store.attachmentCreate(CAROL.id, { filename: 'a.png', mime: 'image/png', bytes: Buffer.from('px') })
        const r1 = store.post('general', CAROL, 'reply @alice', ['alice'], [shot.id], null, root.id).payload
        const r2 = store.post('general', ALICE, 'reply two', [], [], null, root.id).payload
        const other = store.post('general', CAROL, 'unrelated').payload
        store.dismissNotification(CAROL.id, `message:${r2.id}`)
        expect(store.unseenMentionCount(ALICE.id)).toBe(1)

        // Alice owns the root and NOT r1 - the cascade is authorized by the root alone.
        const result = store.deleteMessage('general', root.id, ALICE.id)
        expect(result.deleted).toEqual([root.id, r1.id, r2.id])
        expect(result.blobs).toBe(1)

        expect(store.history('general', ALICE.id).messages.map((m) => m.id)).toEqual([other.id])
        expect(() => store.thread('general', ALICE.id, root.id)).toThrow(ChatNotFoundError)
        expect(store.eventsAfter(0, ALICE.id, 100).map((e) => e.payload.id)).toEqual([other.id])
        expect(store.unseenMentionCount(ALICE.id)).toBe(0)
        expect(store.attachmentById(shot.id)).toBeNull()
        expect(listBlobs(store.uploadsDir, Date.now()).blobs).toEqual([])
        expect(store.dismissedNotifications(CAROL.id)).toEqual([])
        // Carol's pointer never moved off 0 (posting leaves an existing member's pointer alone), so
        // he owed all four; the count now says exactly what survives past it - his own 'unrelated'.
        expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!.unread).toBe(1)
      })

      it('emits one message.deleted per message, ROOT FIRST, so a client can drop the thread on the first frame', () => {
        const root = store.post('general', ALICE, 'root').payload
        const r1 = store.post('general', CAROL, 'r1', [], [], null, root.id).payload
        const r2 = store.post('general', CAROL, 'r2', [], [], null, root.id).payload
        const seen = ephemerals(() => store.deleteMessage('general', root.id, ALICE.id))
        expect(seen.map((e) => [e.type, e.payload?.id, e.payload?.parentId])).toEqual([
          ['message.deleted', root.id, undefined],
          ['message.deleted', r1.id, root.id],
          ['message.deleted', r2.id, root.id]
        ])
      })

      it('deleting a REPLY does not cascade and leaves the root and its siblings', () => {
        const root = store.post('general', ALICE, 'root').payload
        const r1 = store.post('general', CAROL, 'r1', [], [], null, root.id).payload
        const r2 = store.post('general', CAROL, 'r2', [], [], null, root.id).payload
        expect(store.deleteMessage('general', r1.id, CAROL.id).deleted).toEqual([r1.id])
        expect(store.thread('general', ALICE.id, root.id).replies.map((m) => m.id)).toEqual([r2.id])
      })

      it('drops the room\'s agent session when the agent had written in the thread', () => {
        const room = store.roomBySlug('general')!
        const session = {
          roomId: room.id,
          workerSessionId: 'ws-1',
          streamingMessageId: null,
          lastWorkerSeq: 0,
          turnStartedAt: null,
          turnsThisHour: 3,
          windowStartedAt: 1_000
        }
        // A thread nova is NOT in: the session survives, budget and all.
        const quiet = store.post('general', ALICE, 'humans only').payload
        store.agentSessionSave(session)
        expect(store.deleteMessage('general', quiet.id, ALICE.id).agentSessionDropped).toBe(false)
        expect(store.agentSession(room.id)?.turnsThisHour).toBe(3)

        // A thread nova answered in: the row goes, so the next turn starts a fresh worker session
        // (and, because the session is per ROOM, so does the room's budget - the blast radius the
        // deleteMessage comment names).
        const ask = store.post('general', ALICE, '@nova hello', ['nova']).payload
        store.post('general', ABI, 'hello back', [], [], null, ask.id)
        expect(store.deleteMessage('general', ask.id, ALICE.id).agentSessionDropped).toBe(true)
        expect(store.agentSession(room.id)).toBeNull()

        // nova's own top-level message counts too: a thread of one is still nova's context.
        store.agentSessionSave(session)
        const announcement = store.post('general', ABI, 'nightly report').payload
        expect(store.deleteMessage('general', announcement.id, ABI.id).agentSessionDropped).toBe(true)
        expect(store.agentSession(room.id)).toBeNull()
      })
    })

    it('a refused edit or delete emits nothing', () => {
      const posted = store.post('general', ALICE, 'mine').payload
      const seen = ephemerals(() => {
        expect(() => store.editMessage('general', posted.id, CAROL.id, 'yours')).toThrow(ChatAccessError)
        expect(() => store.deleteMessage('general', 'no-such-id', ALICE.id)).toThrow(ChatNotFoundError)
      })
      expect(seen).toHaveLength(0)
    })

    it('refuses an enclosing transaction (publish-after-commit)', () => {
      const posted = store.post('general', ALICE, 'x').payload
      expect(() => store.transaction(() => store.editMessage('general', posted.id, ALICE.id, 'y'))).toThrow(
        /enclosing transaction/
      )
      expect(() => store.transaction(() => store.deleteMessage('general', posted.id, ALICE.id))).toThrow(
        /enclosing transaction/
      )
    })
  })

  describe('mentions - the invite surface and the notification bell', () => {
    const unread = (id: string, slug = 'general'): number =>
      store.roomsVisibleTo(id).find((r) => r.slug === slug)!.unread

    it('writes the mention row inside the post: ONE key for the message, no extra outbox row', () => {
      store.markRead('general', CAROL.id, 0) // Carol's pointer at 0: everything that lands is owed
      store.post('general', ALICE, 'before')
      expect(unread(CAROL.id)).toBe(1)
      const before = { head: headOf(store, 'general'), events: store.eventsAfter(0, ALICE.id, 100).length }

      const posted = store.post('general', ALICE, 'ping @bob', ['bob']).payload

      // Only the message's own key moved the guard: a mention writes NO outbox row, so it can
      // never put a phantom message in anybody's timeline.
      expect(headOf(store, 'general')).toBe(posted.createdAt)
      expect(headOf(store, 'general')).toBeGreaterThan(before.head)
      expect(store.eventsAfter(0, ALICE.id, 100)).toHaveLength(before.events + 1)
      // CAROL owes the two MESSAGES and nothing more - the mention did not disturb his pointer.
      expect(unread(CAROL.id)).toBe(2)

      const rows = store.mentionsFor('bob', 10)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        messageId: posted.id,
        roomId: posted.roomId,
        roomSlug: 'general',
        createdAt: posted.createdAt,
        senderId: ALICE.id,
        senderName: 'Alice',
        body: 'ping @bob',
        seenAt: null
      })
      expect(store.unseenMentionCount('bob')).toBe(1)
    })

    it('a mention of someone who has never opened the room seeds their pointer one key before it', () => {
      store.createRoom({ slug: 'side' }, ALICE)
      store.post('side', ALICE, 'setting up')
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'side')).toMatchObject({ lastReadAt: null, unread: 0 })

      const hey = store.post('side', ALICE, 'hey @carol', ['carol']).payload

      // Seeded one key BEFORE the mentioning message, not at the head and not at 0: the message
      // that named him is the one unread item. A head seed would badge nothing and leave no trace
      // of why the bell rang; a zero seed would badge him with the room's whole history.
      const carol = store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'side')!
      expect(carol.lastReadAt).toBe(hey.createdAt - 1)
      expect(carol.unread).toBe(1)
      expect(store.history('side', CAROL.id).messages.map((m) => m.body)).toEqual(['setting up', 'hey @carol'])
    })

    it("never resets an EXISTING pointer's backlog - OR IGNORE leaves the pointer alone", () => {
      store.markRead('general', CAROL.id, 0) // Carol's pointer at 0
      store.post('general', ALICE, 'one')
      store.post('general', ALICE, 'two')
      expect(unread(CAROL.id)).toBe(2)

      store.post('general', ALICE, 'and @carol should see this', ['carol'])

      // The older pointer survives: three owed (the backlog plus the mention), not one. markRead
      // stays the ONLY thing that moves an existing member's pointer.
      const carol = store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!
      expect(carol.lastReadAt).toBe(0)
      expect(carol.unread).toBe(3)
      // The mention row itself still landed.
      expect(store.unseenMentionCount(CAROL.id)).toBe(1)
    })

    it('mentioning yourself records nothing - you do not notify yourself', () => {
      const seen = ephemerals(() => store.post('general', ALICE, 'note to @alice', ['alice']))
      expect(seen).toHaveLength(0)
      expect(store.mentionsFor(ALICE.id, 10)).toEqual([])
      expect(store.unseenMentionCount(ALICE.id)).toBe(0)
      // The poster's own membership stays the ordinary head seed: his own words born read.
      expect(unread(ALICE.id)).toBe(0)
    })

    it('the same user twice in one message records one row and one ephemeral', () => {
      const seen = ephemerals(() => store.post('general', ALICE, '@carol and again @carol', ['carol', 'carol']))
      expect(store.mentionsFor(CAROL.id, 10)).toHaveLength(1)
      expect(seen.filter((e) => e.type === 'mention.created')).toHaveLength(1)
    })

    it('markMentionsSeen stamps once, is idempotent, and is scoped to the one user', () => {
      const first = store.post('general', ALICE, '@carol @bob', ['carol', 'bob']).payload
      store.post('general', ALICE, 'again @carol', ['carol'])

      // Scoped to one message when given: the second mention stays unseen.
      expect(store.markMentionsSeen(CAROL.id, first.id)).toBe(1)
      expect(store.unseenMentionCount(CAROL.id)).toBe(1)
      // And scoped to the one user throughout: bob's row was never touched.
      expect(store.unseenMentionCount('bob')).toBe(1)

      // The sweep stamps the rest; a second sweep finds nothing - seen_at is never restamped.
      expect(store.markMentionsSeen(CAROL.id)).toBe(1)
      expect(store.markMentionsSeen(CAROL.id)).toBe(0)
      expect(store.markMentionsSeen(CAROL.id, first.id)).toBe(0)
      expect(store.unseenMentionCount(CAROL.id)).toBe(0)
      expect(store.mentionsFor(CAROL.id, 10).every((m) => m.seenAt !== null)).toBe(true)
    })

    it("a deleted message's mention disappears from the bell - the row cascades with the message", () => {
      const posted = store.post('general', ALICE, 'oops @carol', ['carol']).payload
      expect(store.unseenMentionCount(CAROL.id)).toBe(1)

      store.deleteMessage('general', posted.id, ALICE.id)

      // ON DELETE CASCADE on mentions.message_id, enforced on this connection: no second
      // bookkeeping write, and the badge agrees with the list because neither has a row.
      expect(store.mentionsFor(CAROL.id, 10)).toEqual([])
      expect(store.unseenMentionCount(CAROL.id)).toBe(0)
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM mentions WHERE message_id = ?').get(posted.id)).toEqual({ n: 0 })
    })

    it('recentMessagesFor carries every readable room, never your own words, unread per row', () => {
      clockAt(1_000)
      store.createRoom({ slug: 'deploys' }, ALICE)
      store.post('deploys', ALICE, 'everyone hears this') // 1000, in a room Carol never opened
      clockAt(2_000)
      store.post('general', ALICE, 'one') // 2000
      store.post('general', ALICE, 'two') // 2001
      store.markRead('general', CAROL.id, 2_000) // Carol's pointer is born at 'one'
      store.post('general', CAROL, 'mine') // 2002, and his pointer stays at 'one'
      const gone = store.post('general', ALICE, 'gone').payload
      store.deleteMessage('general', gone.id, ALICE.id)
      // A DM between two other people is the one thing the bell must not carry.
      store.openDirect(ALICE, 'bob')
      store.post(directSlug(ALICE.id, 'bob'), ALICE, 'not for carol')

      const rows = store.recentMessagesFor(CAROL.id, 10)
      // Every channel, since migration 015 - there is no subscription to narrow it by - and never
      // a DM he is not in. His own message and the deleted one are absent; newest first.
      expect(rows.map((r) => r.body)).toEqual(['two', 'one', 'everyone hears this'])
      expect(rows.map((r) => r.roomSlug)).toEqual(['general', 'general', 'deploys'])
      // The sidebar's rule per row: 'two' sits past his pointer (at 'one'), 'one' does not, and in
      // #deploys he holds no pointer at all - so nothing there is owed, exactly as its badge reads 0.
      expect(rows.map((r) => r.unread)).toEqual([true, false, false])
    })

    it('the notification watermark starts at 0, upserts, and never moves backwards', () => {
      expect(store.notificationWatermark(ALICE.id, 'alerts')).toBe(0)
      store.setNotificationWatermark(ALICE.id, 'alerts', 41)
      expect(store.notificationWatermark(ALICE.id, 'alerts')).toBe(41)
      store.setNotificationWatermark(ALICE.id, 'alerts', 55)
      expect(store.notificationWatermark(ALICE.id, 'alerts')).toBe(55)
      // Monotonic: a stale tab acking an old high-water mark must not resurrect the badge.
      store.setNotificationWatermark(ALICE.id, 'alerts', 41)
      expect(store.notificationWatermark(ALICE.id, 'alerts')).toBe(55)
      // Scoped per (user, source) - one source's sweep says nothing about another's.
      expect(store.notificationWatermark(ALICE.id, 'other')).toBe(0)
      expect(store.notificationWatermark(CAROL.id, 'alerts')).toBe(0)
    })

    it('emits mention.created per user, AFTER the outbox event, with no outbox row of its own', () => {
      const seen: ChatBusEvent[] = []
      const off = onChatEvent((ev) => seen.push(ev))
      try {
        store.post('general', ALICE, 'hey @carol @bob', ['carol', 'bob'])
      } finally {
        off()
      }

      // The outbox row travels FIRST: a client that receives the mention has already ingested
      // the message it points at.
      expect(seen).toHaveLength(3)
      expect('ephemeral' in seen[0]).toBe(false)
      expect(seen[0].type).toBe('message.created')
      const mentions = seen.slice(1) as ChatEphemeralEvent[]
      expect(mentions.map((e) => e.type)).toEqual(['mention.created', 'mention.created'])
      // Per-user routing, like member.read: who was mentioned is nobody else's business.
      expect(mentions.map((e) => e.userId)).toEqual(['carol', 'bob'])
      for (const ev of mentions) {
        expect(ev.ephemeral).toBe(true)
        // The mentioning message itself, key and all - the same row the outbox frame carried.
        expect(ev.payload?.createdAt).toBe((seen[0] as ChatEvent).payload.createdAt)
        expect(ev.payload?.body).toBe('hey @carol @bob')
      }
      // Exactly one outbox row landed - the message's - and none for the mentions.
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 1 })
    })
  })

  describe('notification dismissal - tombstones, and the clear watermark', () => {
    it('records a dismissal, and is idempotent across repeats', () => {
      store.dismissNotification('carol', 'alert:abc')
      store.dismissNotification('carol', 'alert:abc')
      expect(store.dismissedNotifications('carol')).toEqual(['alert:abc'])
    })

    it('keeps dismissals per user', () => {
      store.dismissNotification('carol', 'alert:abc')
      expect(store.dismissedNotifications('alice')).toEqual([])
    })

    it('names rows from either engine with one key', () => {
      store.dismissNotification('carol', 'mention:m1')
      store.dismissNotification('carol', 'message:m2')
      store.dismissNotification('carol', 'alert:a3')
      expect(store.dismissedNotifications('carol').sort()).toEqual(['alert:a3', 'mention:m1', 'message:m2'])
    })

    it('clearing sets the watermark and prunes the tombstones it subsumes', () => {
      store.dismissNotification('carol', 'alert:abc')
      expect(store.notificationWatermark('carol', 'dismiss')).toBe(0)

      // Must be AFTER the tombstone was written - the prune compares the tombstone's own
      // dismissed_at, which is Date.now() at dismissal, not the dismissed item's timestamp.
      const through = Date.now() + 1_000
      store.clearNotifications('carol', through)

      expect(store.notificationWatermark('carol', 'dismiss')).toBe(through)
      // The watermark now covers that tombstone, so keeping the row would be dead weight - this
      // prune is the only thing that ever shrinks the table.
      expect(store.dismissedNotifications('carol')).toEqual([])
    })

    it('never moves the clear watermark backwards', () => {
      store.clearNotifications('carol', 5_000)
      store.clearNotifications('carol', 1_000)
      expect(store.notificationWatermark('carol', 'dismiss')).toBe(5_000)
    })

    it('a stale lower clear does not prune tombstones the real watermark does not cover', () => {
      store.clearNotifications('carol', 5_000)
      // Dismissed AFTER the watermark, so it is not subsumed by it.
      store.dismissNotification('carol', 'alert:later')
      // A stale caller replays an OLD clear. The watermark holds at 5000 (monotonic), and the
      // prune must run against the STORED value - pruning against the argument would delete a
      // tombstone that nothing else is covering, resurrecting a dismissed row.
      store.clearNotifications('carol', 1_000)
      expect(store.dismissedNotifications('carol')).toEqual(['alert:later'])
    })

    it('dismissing does not touch the read pointer', () => {
      const one = store.post('general', ALICE, 'one').payload
      store.markRead('general', CAROL.id, one.createdAt)
      const before = store.roomsVisibleTo('carol').find((r) => r.slug === 'general')?.lastReadAt
      expect(before).toBe(one.createdAt)
      store.dismissNotification('carol', 'message:whatever')
      store.clearNotifications('carol', Date.now())
      // Throwing a notification away is not reading a room: the sidebar answers a different
      // question, and only markRead may move this.
      expect(store.roomsVisibleTo('carol').find((r) => r.slug === 'general')?.lastReadAt).toBe(before)
    })

    it('the dismiss watermark is independent of the alert watermark', () => {
      store.setNotificationWatermark('carol', 'alert', 9_000)
      store.clearNotifications('carol', 5_000)
      expect(store.notificationWatermark('carol', 'alert')).toBe(9_000)
      expect(store.notificationWatermark('carol', 'dismiss')).toBe(5_000)
    })
  })
})

describe('parseMentionHandles', () => {
  it('finds handles at start, mid-string, and after opening punctuation', () => {
    expect(parseMentionHandles('@alice hello')).toEqual(['alice'])
    expect(parseMentionHandles('hello @alice')).toEqual(['alice'])
    expect(parseMentionHandles('(@alice) "@carol" [@bob]')).toEqual(['alice', 'carol', 'bob'])
  })

  it('requires a boundary before the @ - emails and infix @ never match', () => {
    expect(parseMentionHandles('mail someone@example.com please')).toEqual([])
    expect(parseMentionHandles('foo@bar')).toEqual([])
    // A comma is not an opener: nobody types ",@alice" aiming at a person.
    expect(parseMentionHandles('hi,@alice')).toEqual([])
  })

  it('trailing punctuation ends the handle without eating it', () => {
    expect(parseMentionHandles('thanks @alice!')).toEqual(['alice'])
    expect(parseMentionHandles('@alice, and @carol.')).toEqual(['alice', 'carol'])
  })

  it('never matches inside code - fences, unterminated fences, inline spans', () => {
    expect(parseMentionHandles('```\nping @alice\n```')).toEqual([])
    // An unterminated fence swallows to end-of-string, matching how it renders.
    expect(parseMentionHandles('before\n```js\n@alice\n')).toEqual([])
    expect(parseMentionHandles('run `@alice` for help')).toEqual([])
    expect(parseMentionHandles('`@alice` quoted, but really @carol')).toEqual(['carol'])
    expect(parseMentionHandles('```\n@a\n``` @carol ```\n@b\n```')).toEqual(['carol'])
  })

  it('skips markdown link targets but not link text', () => {
    expect(parseMentionHandles('[profile](https://x.com/@alice)')).toEqual([])
    expect(parseMentionHandles('[@alice](https://example.com/u)')).toEqual(['alice'])
  })

  it('dedupes case-insensitively, preserving first-seen order and lowercasing', () => {
    expect(parseMentionHandles('@carol @Alice @CAROL @alice')).toEqual(['carol', 'alice'])
  })

  it('a bare @ or an invalid start character is nothing', () => {
    expect(parseMentionHandles('@')).toEqual([])
    expect(parseMentionHandles('@ alice')).toEqual([])
    expect(parseMentionHandles('@-nope @_nope')).toEqual([])
  })

  it('returns CANDIDATES - the caller intersects with the user directory', () => {
    expect(parseMentionHandles('@no-such-user-yet')).toEqual(['no-such-user-yet'])
  })
})

describe('push subscriptions (Track 9)', () => {
  let directory: string
  let store: ChatStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'box-chat-push-'))
    store = new ChatStore(join(directory, 'chat.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const SUB = { endpoint: 'https://push.example/ep-1', p256dh: 'pk', auth: 'ak', userAgent: 'Chrome' }

  it('subscribing is idempotent on the endpoint, and the latest claim wins', () => {
    store.pushSubscribe('alice', SUB)
    // Same endpoint re-claimed with fresh keys (or by another signed-in user): REPLACES, never
    // duplicates - the endpoint can only deliver to one device.
    store.pushSubscribe('carol', { ...SUB, p256dh: 'pk2', auth: 'ak2' })

    expect(store.pushSubscriptionsFor('alice')).toEqual([])
    const dans = store.pushSubscriptionsFor('carol')
    expect(dans).toHaveLength(1)
    expect(dans[0]).toMatchObject({ endpoint: SUB.endpoint, p256dh: 'pk2', auth: 'ak2', userId: 'carol' })
  })

  it('unsubscribe is scoped to the owner; the transport delete is not', () => {
    store.pushSubscribe('alice', SUB)
    // Another user cannot revoke alice's subscription...
    expect(store.pushUnsubscribe('carol', SUB.endpoint)).toBe(false)
    expect(store.pushSubscriptionsFor('alice')).toHaveLength(1)
    // ...but the transport's 404/410 prune deletes by endpoint alone.
    store.pushSubscriptionDelete(SUB.endpoint)
    expect(store.pushSubscriptionsFor('alice')).toEqual([])
  })

  it('last_seen_at stamps drive the stale prune', () => {
    store.pushSubscribe('alice', SUB)
    store.pushSubscribe('alice', { ...SUB, endpoint: 'https://push.example/ep-2' })
    const stale = 1_000 // long ago
    store.pushSubscriptionSeen(SUB.endpoint, stale)

    expect(store.pushPruneUnseenSince(stale + 1)).toBe(1)
    const left = store.pushSubscriptionsFor('alice')
    expect(left).toHaveLength(1)
    expect(left[0]!.endpoint).toBe('https://push.example/ep-2')
  })

  it('resolves a room id to its slug for deep links', () => {
    const general = store.roomBySlug('general')!
    expect(store.roomSlugById(general.id)).toBe('general')
    expect(store.roomSlugById('nope')).toBeNull()
  })
})

describe('backup (Track 12)', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'box-chat-bak-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('backupTo takes a consistent snapshot that includes WAL-resident commits', () => {
    const store = new ChatStore(join(directory, 'chat.db'))
    try {
      // Under WAL these commits live in chat.db-wal until a checkpoint; a `cp` of chat.db alone
      // would lose them, which is exactly why backupTo is VACUUM INTO and not a file copy.
      store.post('general', ALICE, 'first')
      store.post('general', ALICE, 'second')

      const target = join(directory, 'snapshot.sqlite')
      store.backupTo(target)

      const copy = new Database(target, { readonly: true })
      try {
        expect((copy.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(2)
        // The migration ledger travels with the snapshot, so a restore knows where it stands.
        expect((copy.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(
          CHAT_MIGRATIONS.length
        )
      } finally {
        copy.close()
      }

      // SQLite refuses to overwrite an existing target, and that refusal is kept.
      expect(() => store.backupTo(target)).toThrow()
    } finally {
      store.close()
    }
  })

  it('snapshots before a pending migration on an existing database, and only then', () => {
    // A fresh database running its whole chain gets NO snapshot - dev boots and tests stay clean.
    const fresh = join(directory, 'fresh.db')
    new ChatStore(fresh).close()
    expect(existsSync(`${fresh}.pre-${CHAT_MIGRATIONS[0]!.name}.bak`)).toBe(false)

    // An EXISTING database (a ledger with rows) facing pending work snapshots first. Seed one
    // with a foreign one-migration chain, then open the real store over it.
    const file = join(directory, 'chat.db')
    const seeded = new Database(file)
    migrateChat(seeded, [{ name: '000-seed', up: (d) => d.exec('CREATE TABLE a (x)') }])
    seeded.close()

    new ChatStore(file).close()
    const snapshot = `${file}.pre-${CHAT_MIGRATIONS[0]!.name}.bak`
    expect(existsSync(snapshot)).toBe(true)
    const copy = new Database(snapshot, { readonly: true })
    try {
      // The copy is the state BEFORE the real chain ran: table a exists, rooms does not.
      expect(copy.prepare(`SELECT name FROM sqlite_master WHERE name = 'a'`).get()).toBeDefined()
      expect(copy.prepare(`SELECT name FROM sqlite_master WHERE name = 'rooms'`).get()).toBeUndefined()
    } finally {
      copy.close()
    }

    // Reopening with nothing pending adds nothing: still exactly one snapshot beside the file.
    new ChatStore(file).close()
    expect(readdirSync(directory).filter((name) => name.endsWith('.bak'))).toEqual([
      `chat.db.pre-${CHAT_MIGRATIONS[0]!.name}.bak`
    ])
  })

  it('keeps only the newest two pre-migration snapshots', () => {
    const directory = mkdtempSync(join(tmpdir(), 'box-chat-prune-'))
    const file = join(directory, 'chat.db')

    // Four stale snapshots from earlier boundaries, oldest first so mtime ordering is unambiguous.
    const older = ['000-a', '001-b', '002-c', '003-d'].map((name, index) => {
      const path = `${file}.pre-${name}.bak`
      writeFileSync(path, 'stale')
      utimesSync(path, index + 1, index + 1)
      return path
    })

    // An existing database facing pending work: it snapshots, then prunes.
    const seeded = new Database(file)
    migrateChat(seeded, [{ name: '000-seed', up: (d) => d.exec('CREATE TABLE a (x)') }])
    seeded.close()
    new ChatStore(file).close()

    const fresh = `${file}.pre-${CHAT_MIGRATIONS[0]!.name}.bak`
    expect(existsSync(fresh)).toBe(true)
    // The new one plus the newest stale one survive; the other three are gone.
    expect(readdirSync(directory).filter((name) => name.endsWith('.bak')).sort()).toEqual(
      [basename(fresh), basename(older[3]!)].sort()
    )
    rmSync(directory, { recursive: true, force: true })
  })
})

describe('migrateChat', () => {
  it('applies once, keyed by name, and rolls a failing migration back whole', () => {
    const directory = mkdtempSync(join(tmpdir(), 'box-chat-mig-'))
    const db = new Database(join(directory, 'chat.db'))
    try {
      const good: ChatMigration = { name: '001-good', up: (d) => d.exec('CREATE TABLE a (x)') }
      expect(migrateChat(db, [good])).toEqual(['001-good'])
      // Idempotent: the ledger, not the schema, decides what runs.
      expect(migrateChat(db, [good])).toEqual([])

      const bad: ChatMigration = {
        name: '002-bad',
        up: (d) => {
          d.exec('CREATE TABLE b (x)')
          throw new Error('backfill lost rows')
        }
      }
      expect(() => migrateChat(db, [good, bad])).toThrow('backfill lost rows')
      // The half-applied DDL and the ledger row vanished together: rerunnable, never half-done.
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'b'`).get()).toBeUndefined()
      expect(db.prepare(`SELECT name FROM schema_migrations`).all()).toEqual([{ name: '001-good' }])
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('migration 010 - the time order key, and the purge of the soft deletes', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'box-chat-010-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  })

  /** A pre-010 row, in the shape `post()` wrote it then. `deleted` is a soft-delete stamp. */
  interface OldRow {
    id: string
    seq: number
    at: number
    sender: string
    body: string
    deleted?: number
    parent?: string
    /** What the outbox payload still says the body was - the leak this migration closes. */
    leaked?: string
  }

  const OLD_ROWS: OldRow[] = [
    { id: 'm1', seq: 1, at: 1_000, sender: 'alice', body: 'one' },
    { id: 'm2', seq: 2, at: 1_000, sender: 'alice', body: 'two, same millisecond' },
    { id: 'm3', seq: 3, at: 999, sender: 'carol', body: 'three, after a backwards clock step' },
    { id: 'm4', seq: 4, at: 5_000, sender: 'alice', body: '', deleted: 5_500, leaked: 'the tombstoned root' },
    { id: 'm5', seq: 5, at: 5_001, sender: 'carol', body: 'a reply under the tombstone', parent: 'm4' },
    { id: 'm6', seq: 6, at: 6_000, sender: 'alice', body: 'six' },
    { id: 'm7', seq: 7, at: 6_001, sender: 'nova', body: 'seven, a reply', parent: 'm6' },
    { id: 'm8', seq: 8, at: 7_000, sender: 'alice', body: '', deleted: 7_100, leaked: 'the newest, deleted' }
  ]

  /**
   * Build a database exactly as the shipped chain left it before 010 (the first nine migrations,
   * run for real), then write rows through the OLD columns the way the old store did - the outbox
   * payload carrying the original body, a soft delete blanking only the row, `next_seq` past the
   * last seq, and an events counter far past the surviving rows (rooms had been purged).
   */
  const seedPre010 = (): string => {
    const file = join(directory, 'chat.db')
    const db = new Database(file)
    migrateChat(db, CHAT_MIGRATIONS.slice(0, 9))
    const general = (db.prepare(`SELECT id FROM rooms WHERE slug = 'general'`).get() as { id: string }).id
    const message = db.prepare(
      `INSERT INTO messages (id, room_id, seq, sender_id, sender_name, body, created_at, edited_at, deleted_at, meta, parent_id)
       VALUES (@id, @room, @seq, @sender, @sender, @body, @at, NULL, @deleted, NULL, @parent)`
    )
    const event = db.prepare(
      `INSERT INTO events (id, room_id, seq, type, payload, actor_id, created_at)
       VALUES (@eid, @room, @seq, 'message.created', @payload, @sender, @at)`
    )
    for (const row of OLD_ROWS) {
      message.run({
        id: row.id,
        room: general,
        seq: row.seq,
        sender: row.sender,
        body: row.body,
        at: row.at,
        deleted: row.deleted ?? null,
        parent: row.parent ?? null
      })
      event.run({
        eid: 100 + row.seq,
        room: general,
        seq: row.seq,
        sender: row.sender,
        at: row.at,
        payload: JSON.stringify({
          id: row.id,
          roomId: general,
          seq: row.seq,
          senderId: row.sender,
          senderName: row.sender,
          body: row.leaked ?? row.body,
          createdAt: row.at,
          editedAt: null,
          deletedAt: null,
          ...(row.parent === undefined ? {} : { parentId: row.parent })
        })
      })
    }
    db.prepare(`UPDATE rooms SET next_seq = 9 WHERE id = ?`).run(general)
    db.prepare(`UPDATE sqlite_sequence SET seq = 500 WHERE name = 'events'`).run()
    const member = db.prepare(
      'INSERT INTO room_members (room_id, user_id, joined_at, last_read_seq) VALUES (?, ?, 1, ?)'
    )
    member.run(general, 'alice', 3)
    member.run(general, 'carol', 5) // read through the reply that is about to be purged
    member.run(general, 'bob', 0)
    const mention = db.prepare(
      'INSERT INTO mentions (message_id, user_id, room_id, seq, created_at, seen_at) VALUES (?, ?, ?, ?, ?, NULL)'
    )
    mention.run('m2', 'carol', general, 2, 1_000)
    mention.run('m5', 'carol', general, 5, 5_001)
    const attachment = db.prepare(
      `INSERT INTO attachments (id, message_id, uploader_id, filename, mime, bytes, sha256, created_at)
       VALUES (?, ?, 'carol', 'a.png', 'image/png', 2, ?, 1)`
    )
    attachment.run('att5', 'm5', 'a'.repeat(64))
    attachment.run('att7', 'm7', 'b'.repeat(64))
    const dismiss = db.prepare('INSERT INTO notification_dismissals (user_id, item_id, dismissed_at) VALUES (?, ?, 1)')
    dismiss.run('carol', 'message:m8')
    dismiss.run('carol', 'alert:x')
    db.prepare(
      `INSERT INTO agent_sessions (room_id, worker_session_id, last_worker_seq, turns_this_hour, window_started_at, updated_at)
       VALUES (?, 'ws-1', 0, 2, 1, 1)`
    ).run(general)
    db.close()
    return file
  }

  it('derives unique order-preserving keys, translates every pointer, and purges the tombstones', () => {
    const file = seedPre010()
    // Opening runs 010, and the constructor's foreign_key_check must pass on what it left.
    const store = new ChatStore(file)
    try {
      const room = store.roomBySlug('general')!

      // The keys: an increasing created_at stays put, the same-millisecond pair is nudged apart,
      // the backwards-stepped row is carried forward - and the ORDER readers saw (seq's) holds.
      const page = store.history('general', 'alice')
      expect(page.messages.map((m) => [m.id, m.createdAt])).toEqual([
        ['m1', 1_000],
        ['m2', 1_001],
        ['m3', 1_002],
        ['m6', 6_000],
        ['m7', 6_001]
      ])
      // The guard is seeded from EVERY key derived, purged rows included: 7000 was m8's.
      expect(headOf(store, 'general')).toBe(7_000)
      expect(page.headAt).toBe(7_000)

      // The purge: both tombstones, and the reply that hung under the tombstoned root.
      for (const id of ['m4', 'm5', 'm8']) expect(store.message(room.id, id)).toBeNull()
      expect(store.thread('general', 'alice', 'm6').replies.map((m) => m.id)).toEqual(['m7'])

      // The pointers: "everything at or below seq N" becomes the key of the newest message at
      // or below it, over ALL rows - carol's pointer sat on m5, which is purged, and still lands on
      // m5's key so he does not owe m1..m3 again.
      const pointer = (user: string): { lastReadAt: number | null; unread: number } => {
        const summary = store.roomsVisibleTo(user).find((r) => r.slug === 'general')!
        return { lastReadAt: summary.lastReadAt, unread: summary.unread }
      }
      expect(pointer('alice')).toEqual({ lastReadAt: 1_002, unread: 2 })
      expect(pointer('carol')).toEqual({ lastReadAt: 5_001, unread: 2 })
      expect(pointer('bob')).toEqual({ lastReadAt: 0, unread: 5 })

      // The outbox: the doomed rows' events are gone WITH the leaked bodies they carried, the
      // survivors are re-keyed, and each stored payload now agrees with its row.
      const events = store.eventsAfter(0, 'alice', 100)
      expect(events.map((e) => [e.id, e.at, e.payload.id])).toEqual([
        [101, 1_000, 'm1'],
        [102, 1_001, 'm2'],
        [103, 1_002, 'm3'],
        [106, 6_000, 'm6'],
        [107, 6_001, 'm7']
      ])
      expect(events[1].payload.createdAt).toBe(1_001)
      expect('seq' in events[1].payload).toBe(false)
      expect('deletedAt' in events[1].payload).toBe(false)
      for (const leaked of ['the tombstoned root', 'the newest, deleted']) {
        expect(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE payload LIKE ?').get(`%${leaked}%`)).toEqual({ n: 0 })
      }
      // The AUTOINCREMENT counter survived the rebuild: the next outbox id is past the OLD
      // counter (500), not past the surviving rows (107) - a cursor a client holds stays unique.
      clockAt(2_000)
      const next = store.post('general', { id: 'alice', display: 'Alice' }, 'after the migration')
      expect(next.id).toBe(501)
      // And the guard, not the clock, issued the key: 7000 was retired by m8, so 7001.
      expect(next.payload.createdAt).toBe(7_001)

      // The rest of the purge, as a live delete would have done it.
      expect(store.mentionsFor('carol', 10).map((m) => [m.messageId, m.createdAt])).toEqual([['m2', 1_001]])
      expect(store.attachmentById('att5')).toBeNull()
      expect(store.attachmentById('att7')?.messageId).toBe('m7')
      expect(store.dismissedNotifications('carol')).toEqual(['alert:x'])
      // The agent row is not the migration's business (a restart drops every live session anyway).
      expect(store.agentSession(room.id)?.workerSessionId).toBe('ws-1')

      // Track 12's snapshot was taken before the rebuild.
      expect(existsSync(`${file}.pre-010-time-order-key.bak`)).toBe(true)
    } finally {
      store.close()
    }
  })

  it('refuses to guess when an outbox row has no message behind it, and stays rerunnable', () => {
    const file = seedPre010()
    const db = new Database(file)
    const general = (db.prepare(`SELECT id FROM rooms WHERE slug = 'general'`).get() as { id: string }).id
    db.prepare(
      `INSERT INTO events (id, room_id, seq, type, payload, actor_id, created_at)
       VALUES (999, ?, 42, 'message.created', '{}', 'alice', 1)`
    ).run(general)
    db.close()

    expect(() => new ChatStore(file)).toThrow(/outbox row/)
    // Rolled back whole: no ledger row, the old schema intact, so a repaired file migrates cleanly.
    const check = new Database(file)
    try {
      expect(check.prepare(`SELECT name FROM schema_migrations WHERE name = '010-time-order-key'`).get()).toBeUndefined()
      expect(check.prepare(`SELECT next_seq FROM rooms WHERE id = ?`).get(general)).toEqual({ next_seq: 9 })
      check.prepare('DELETE FROM events WHERE id = 999').run()
    } finally {
      check.close()
    }
    new ChatStore(file).close()
  })
})

describe('reactions (Track 10)', () => {
  let directory: string
  let store: ChatStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'box-chat-test-'))
    store = new ChatStore(join(directory, 'chat.db'))
  })

  afterEach(() => {
    vi.useRealTimers()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('groups by emoji and names everyone in it, oldest first', () => {
    clockAt(5_000)
    const message = store.post('general', ALICE, 'shipped it').payload
    clockAt(6_000)
    store.setReaction('general', message.id, 'alice', '🎉', true)
    // The clock is stepped rather than left alone because the tiebreak inside ONE millisecond is
    // user_id, not arrival - see the statement's comment. This pins the ordinary case.
    clockAt(7_000)
    const groups = store.setReaction('general', message.id, 'carol', '🎉', true)

    expect(groups).toEqual([{ emoji: '🎉', users: ['alice', 'carol'], count: 2 }])
  })

  it('orders a same-millisecond tie deterministically rather than by arrival', () => {
    clockAt(5_000)
    const message = store.post('general', ALICE, 'shipped it').payload
    // carol reacts FIRST. The assertion below is only meaningful because arrival order and
    // user_id order disagree here - keep them disagreeing if these fixtures are ever renamed.
    store.setReaction('general', message.id, 'carol', '🎉', true)
    store.setReaction('general', message.id, 'alice', '🎉', true)
    // A list shown to people that reshuffles between two reads reads as activity that did not
    // happen, so the tie breaks on user_id and carol loses despite going first.
    expect(store.reactionsForMessage(message.id)).toEqual([
      { emoji: '🎉', users: ['alice', 'carol'], count: 2 }
    ])
  })

  // THE invariant of this track: the polite gesture must not be the one that interrupts people.
  it('moves no order key, writes no outbox row, and never notifies', () => {
    const message = store.post('general', ALICE, 'shipped it').payload
    store.markRead('general', CAROL.id, message.createdAt)
    const headBefore = headOf(store, 'general')
    const unreadBefore = store.roomsVisibleTo('carol').find((r) => r.slug === 'general')!.unread
    const eventsBefore = (store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n

    store.setReaction('general', message.id, 'carol', '👍', true)

    expect(headOf(store, 'general')).toBe(headBefore)
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(eventsBefore)
    expect(store.roomsVisibleTo('carol').find((r) => r.slug === 'general')!.unread).toBe(unreadBefore)
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM mentions').get() as { n: number }).n).toBe(0)
  })

  it('does not stamp the message as edited', () => {
    const message = store.post('general', ALICE, 'shipped it').payload
    store.setReaction('general', message.id, 'carol', '👍', true)
    expect(store.history('general', 'alice').messages[0].editedAt).toBeNull()
  })

  it('is idempotent both ways, and stays silent when nothing changed', () => {
    const message = store.post('general', ALICE, 'shipped it').payload

    const first = ephemerals(() => store.setReaction('general', message.id, 'carol', '👍', true))
    expect(first.map((e) => e.type)).toEqual(['reaction.added'])

    // The double-tap: the PK swallows it, so there is nothing for a reader to be told.
    const again = ephemerals(() => store.setReaction('general', message.id, 'carol', '👍', true))
    expect(again).toEqual([])
    expect(store.reactionsForMessage(message.id)).toEqual([{ emoji: '👍', users: ['carol'], count: 1 }])

    const off = ephemerals(() => store.setReaction('general', message.id, 'carol', '👍', false))
    expect(off.map((e) => e.type)).toEqual(['reaction.removed'])
    expect(store.reactionsForMessage(message.id)).toEqual([])

    // Removing what is not there converges rather than refusing.
    expect(ephemerals(() => store.setReaction('general', message.id, 'carol', '👍', false))).toEqual([])
  })

  it('fans out to the ROOM, carrying the complete group list rather than a delta', () => {
    const message = store.post('general', ALICE, 'shipped it').payload
    store.setReaction('general', message.id, 'alice', '🎉', true)

    const [event] = ephemerals(() => store.setReaction('general', message.id, 'carol', '👍', true))
    expect(event.type).toBe('reaction.added')
    // null = the room's readers, exactly like message.edited.
    expect(event.userId).toBeNull()
    expect(event.reaction).toEqual({
      messageId: message.id,
      userId: 'carol',
      emoji: '👍',
      // Both groups, in palette order, so a client ADOPTS state instead of incrementing a counter
      // it may have missed a frame for.
      reactions: [
        { emoji: '👍', users: ['carol'], count: 1 },
        { emoji: '🎉', users: ['alice'], count: 1 }
      ]
    })
  })

  it('names the thread root when the reacted-to message is a reply', () => {
    const root = store.post('general', ALICE, 'the question').payload
    const reply = store.post('general', CAROL, 'the answer', [], [], null, root.id).payload
    const [event] = ephemerals(() => store.setReaction('general', reply.id, 'alice', '👍', true))
    expect(event.reaction?.parentId).toBe(root.id)
  })

  it('refuses an emoji outside the palette', () => {
    const message = store.post('general', ALICE, 'shipped it').payload
    expect(() => store.setReaction('general', message.id, 'carol', '🦆', true)).toThrow(ChatValidationError)
    // And free text, which is the failure mode the fixed palette exists to prevent.
    expect(() => store.setReaction('general', message.id, 'carol', 'lgtm, ship it', true)).toThrow(
      ChatValidationError
    )
  })

  it('is gated by READABILITY, not by senderhood', () => {
    // Reacting to somebody else's message in a channel you have never opened is fine - you are
    // already allowed to do the louder thing and post in it.
    const message = store.post('general', ALICE, 'shipped it').payload
    expect(store.setReaction('general', message.id, 'carol', '👍', true)).toHaveLength(1)

    // A DM between two other people is the one room a third person cannot reach.
    store.openDirect(ALICE, 'bob')
    const inside = store.post(directSlug(ALICE.id, 'bob'), ALICE, 'between us').payload
    expect(() => store.setReaction(directSlug(ALICE.id, 'bob'), inside.id, 'carol', '👍', true)).toThrow(ChatAccessError)
  })

  it('refuses a message that is not in this room', () => {
    store.createRoom({ slug: 'side' }, ALICE)
    const elsewhere = store.post('side', ALICE, 'over here').payload
    expect(() => store.setReaction('general', elsewhere.id, 'alice', '👍', true)).toThrow(ChatNotFoundError)
  })

  it('arrives with history and with an expanded thread, so a reload does not lose them', () => {
    const root = store.post('general', ALICE, 'the question').payload
    const reply = store.post('general', CAROL, 'the answer', [], [], null, root.id).payload
    store.setReaction('general', root.id, 'carol', '👍', true)
    store.setReaction('general', reply.id, 'alice', '🎉', true)

    const flat = store.history('general', 'alice').messages
    expect(flat[0].reactions).toEqual([{ emoji: '👍', users: ['carol'], count: 1 }])
    expect(flat[1].reactions).toEqual([{ emoji: '🎉', users: ['alice'], count: 1 }])

    const thread = store.thread('general', 'alice', root.id)
    expect(thread.parent.reactions).toEqual([{ emoji: '👍', users: ['carol'], count: 1 }])
    expect(thread.replies[0].reactions).toEqual([{ emoji: '🎉', users: ['alice'], count: 1 }])
  })

  it('is ABSENT rather than empty on a message nobody reacted to', () => {
    store.post('general', ALICE, 'quiet')
    expect(store.history('general', 'alice').messages[0]).not.toHaveProperty('reactions')
  })

  // The edit ephemeral REPLACES the client's copy of the message wholesale, so an edit that
  // dropped the reactions would visually clear them for everyone but the editor.
  it('survives an edit, and rides the edit ephemeral', () => {
    const message = store.post('general', ALICE, 'shipped it').payload
    store.setReaction('general', message.id, 'carol', '👍', true)
    const [event] = ephemerals(() => store.editMessage('general', message.id, 'alice', 'shipped it, finally'))
    expect(event.type).toBe('message.edited')
    expect(event.payload?.reactions).toEqual([{ emoji: '👍', users: ['carol'], count: 1 }])
  })

  // The only cleanup a delete needs, and it is the FK's rather than deleteMessage's.
  it('goes with the message it is on, and with a cascading thread root', () => {
    const root = store.post('general', ALICE, 'the question').payload
    const reply = store.post('general', CAROL, 'the answer', [], [], null, root.id).payload
    store.setReaction('general', root.id, 'carol', '👍', true)
    store.setReaction('general', reply.id, 'alice', '🎉', true)

    store.deleteMessage('general', root.id, 'alice')
    expect((store.db.prepare('SELECT COUNT(*) AS n FROM message_reactions').get() as { n: number }).n).toBe(0)
  })
})

describe('attachments (Track 11)', () => {
  let directory: string
  let store: ChatStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'box-chat-att-'))
    store = new ChatStore(join(directory, 'chat.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const PNG = Buffer.from('pretend-png-bytes')

  const upload = (who: ChatSender = ALICE, bytes: Buffer = PNG, filename = 'shot.png') =>
    store.attachmentCreate(who.id, { filename, mime: 'image/png', bytes })

  /** Real blobs currently on disk (temp debris excluded) - the GC assertions' ground truth. */
  const blobsOnDisk = (): string[] => listBlobs(store.uploadsDir, Date.now()).blobs

  it('an orphan is readable ONLY by its uploader - there is no room yet for canReadRoom to ask', () => {
    const a = upload()
    expect(store.attachmentForRead(a.id, ALICE.id).id).toBe(a.id)
    expect(a.messageId).toBeNull()
    // Not even another signed-in teammate: until a post claims it, the upload is composer state.
    expect(() => store.attachmentForRead(a.id, CAROL.id)).toThrow(ChatAccessError)
    expect(() => store.attachmentForRead('no-such-id', ALICE.id)).toThrow(ChatNotFoundError)
  })

  it('a posted attachment is readable by exactly the readers canReadRoom admits, re-checked per read', () => {
    // A channel: CAROL never opened it, and readability is the rule - the same one the feed applies.
    // The two assertions are deliberately the same predicate twice: attachmentForRead must agree
    // with canReadRoom because it IS canReadRoom.
    const a = upload()
    const event = store.post('general', ALICE, 'screenshot of the bug', [], [a.id])
    expect(store.canReadRoom(event.roomId, CAROL.id)).toBe(true)
    expect(store.attachmentForRead(a.id, CAROL.id).messageId).toBe(event.payload.id)

    // A DM: its pair are the ACL, so the third person is refused - for the attachment exactly as
    // for the words it rode in with.
    store.openDirect(ALICE, 'bob')
    const b = upload(ALICE, Buffer.from('secret-bytes'))
    const secret = store.post(directSlug(ALICE.id, 'bob'), ALICE, 'for our eyes', [], [b.id])
    expect(store.canReadRoom(secret.roomId, CAROL.id)).toBe(false)
    expect(() => store.attachmentForRead(b.id, CAROL.id)).toThrow(ChatAccessError)
    expect(store.attachmentForRead(b.id, ALICE.id).id).toBe(b.id)
    expect(store.attachmentForRead(b.id, 'bob').id).toBe(b.id)
  })

  it('claiming is atomic with the post: refusals name the reason and roll the whole post back', () => {
    const a = upload(ALICE)

    // Someone else's upload: refused, and NOTHING of the failed post survives - no message, no
    // read pointer, no moved guard (a rolled-back post must not retire a key).
    expect(() => store.post('general', CAROL, 'stealing your screenshot', [], [a.id])).toThrow(ChatAccessError)
    expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!.lastReadAt).toBeNull()
    expect(store.attachmentById(a.id)!.messageId).toBeNull()
    expect(headOf(store, 'general')).toBe(0)
    expect(store.post('general', ALICE, 'mine after all', [], [a.id]).payload.attachments?.map((x) => x.id)).toEqual([a.id])

    // Already claimed: refused as a conflict - re-parenting would tear it out of the first message.
    expect(() => store.post('general', ALICE, 'again', [], [a.id])).toThrow(ChatConflictError)
    // Unknown (or already swept): refused as not-found.
    expect(() => store.post('general', ALICE, 'ghost', [], ['no-such-id'])).toThrow(ChatNotFoundError)
  })

  it('dedups identical bytes into one blob on disk, while every upload keeps its own row', () => {
    const a = upload(ALICE, PNG, 'shot.png')
    const b = upload(CAROL, PNG, 'same-shot-different-name.png')
    expect(a.id).not.toBe(b.id)
    expect(a.sha256).toBe(b.sha256)
    expect(blobsOnDisk()).toEqual([a.sha256])
  })

  it('deleting one message never deletes a blob another message still references', () => {
    const a = upload(ALICE)
    const b = upload(ALICE) // same bytes - same blob, second row
    const first = store.post('general', ALICE, 'take one', [], [a.id])
    const second = store.post('general', ALICE, 'take two', [], [b.id])

    store.deleteMessage('general', first.payload.id, ALICE.id)
    // The deleted message's rows are HARD-deleted (the body is wiped on delete; a screenshot is
    // more content than a sentence)...
    expect(store.attachmentById(a.id)).toBeNull()
    expect(() => store.attachmentForRead(a.id, ALICE.id)).toThrow(ChatNotFoundError)
    // ...but the blob survives: the refcount says take-two still needs it.
    expect(blobsOnDisk()).toEqual([a.sha256])

    store.deleteMessage('general', second.payload.id, ALICE.id)
    expect(blobsOnDisk()).toEqual([])
  })

  it('sweeps expired orphans (rows then unreferenced blobs) and reconciles disk garbage', () => {
    const old = upload(ALICE, Buffer.from('never-posted'))
    const fresh = upload(ALICE, Buffer.from('still-composing'))
    const posted = upload(ALICE, Buffer.from('posted-long-ago'))
    store.post('general', ALICE, 'shipped', [], [posted.id])
    // Backdate the never-posted orphan AND the posted row past the window: only the orphan may
    // go - age alone must never sweep something a message references.
    const backdate = store.db.prepare('UPDATE attachments SET created_at = ? WHERE id = ?')
    backdate.run(Date.now() - 60_000, old.id)
    backdate.run(Date.now() - 60_000, posted.id)
    // Plant a rowless blob (a crashed upload's debris): reconciliation should collect it too.
    const debris = 'ab'.padEnd(64, '0')
    mkdirSync(join(store.uploadsDir, 'ab'), { recursive: true })
    writeFileSync(join(store.uploadsDir, 'ab', debris), 'junk')

    expect(store.sweepOrphanAttachments(30_000)).toBe(1)

    expect(store.attachmentById(old.id)).toBeNull()
    expect(store.attachmentById(fresh.id)!.id).toBe(fresh.id)
    expect(store.attachmentById(posted.id)!.messageId).not.toBeNull()
    expect(blobsOnDisk().sort()).toEqual([fresh.sha256, posted.sha256].sort())
  })

  it('a message cannot be deleted from under its attachment rows - the FK gap is the loud error', () => {
    // deleteMessage removes attachment rows first; this pins that a path which forgets to would
    // FAIL rather than strand blobs with nothing left to refcount them (the 006 design note).
    const a = upload(ALICE)
    const event = store.post('general', ALICE, 'anchored', [], [a.id])
    expect(() => store.db.prepare('DELETE FROM messages WHERE id = ?').run(event.payload.id)).toThrow(/FOREIGN KEY/)
    expect(store.attachmentForRead(a.id, ALICE.id).id).toBe(a.id)
  })

  it('message payloads carry attachment metadata through post, the outbox and history', () => {
    const a = upload(ALICE)
    const event = store.post('general', ALICE, 'with receipt', [], [a.id])
    expect(event.payload.attachments?.map((x) => x.id)).toEqual([a.id])
    expect(event.payload.attachments![0].messageId).toBe(event.payload.id)

    // The outbox stored the payload WITH attachments (one JSON, written in the posting
    // transaction), so feed replay and live delivery agree with history forever.
    const replayed = store.eventsAfter(0, CAROL.id, 10)
    expect(replayed[replayed.length - 1].payload.attachments?.map((x) => x.id)).toEqual([a.id])

    const page = store.history('general', CAROL.id)
    expect(page.messages[page.messages.length - 1].attachments?.map((x) => x.id)).toEqual([a.id])
    // And a message WITHOUT attachments has no field at all - absent, not [], matching pre-006
    // payloads (see the ChatMessage.attachments comment).
    store.post('general', ALICE, 'plain words')
    const again = store.history('general', CAROL.id)
    expect('attachments' in again.messages[again.messages.length - 1]).toBe(false)
  })
})

describe('the chat agent (Track 15)', () => {
  let directory: string
  let store: ChatStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'box-chat-agent-'))
    store = new ChatStore(join(directory, 'chat.db'))
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const ABI: ChatSender = { id: 'nova', display: 'Nova' }

  describe('discardAgentPlaceholder - the approval card\'s row split', () => {
    it('drops an untouched placeholder and announces it', () => {
      const placeholder = store.post('general', ABI, '…')
      const seen = ephemerals(() => {
        expect(store.discardAgentPlaceholder(placeholder.roomId, placeholder.payload.id, ABI.id, '…')).toBe(true)
      })
      expect(store.history('general', ABI.id).messages.map((m) => m.id)).not.toContain(placeholder.payload.id)
      expect(seen.map((e) => e.type)).toEqual(['message.deleted'])
    })

    // The whole reason this is not `deleteMessage`: that one drops the room's agent session
    // whenever nova wrote any of what went, which mid-turn would take the LIVE turn's budget
    // counters and session pointer with it - every single time a card was posted.
    it('leaves the room\'s agent session alone', () => {
      const placeholder = store.post('general', ABI, '…')
      store.agentSessionSave({
        roomId: placeholder.roomId,
        workerSessionId: 'ws-1',
        streamingMessageId: placeholder.payload.id,
        lastWorkerSeq: 3,
        turnStartedAt: 1000,
        turnsThisHour: 2,
        windowStartedAt: 500
      })
      store.discardAgentPlaceholder(placeholder.roomId, placeholder.payload.id, ABI.id, '…')
      const session = store.agentSession(placeholder.roomId)
      expect(session?.workerSessionId).toBe('ws-1')
      expect(session?.turnsThisHour).toBe(2)
    })

    it('refuses a row that has been WRITTEN into - it is an answer now, not a placeholder', () => {
      const placeholder = store.post('general', ABI, '…')
      store.checkpointBody(placeholder.roomId, placeholder.payload.id, ABI.id, 'the docs folder exists')
      expect(store.discardAgentPlaceholder(placeholder.roomId, placeholder.payload.id, ABI.id, '…')).toBe(false)
      expect(store.history('general', ABI.id).messages.at(-1)?.body).toBe('the docs folder exists')
    })

    it('refuses another sender\'s message, another room, and one that has a reply', () => {
      const mine = store.post('general', ALICE, '…')
      expect(store.discardAgentPlaceholder(mine.roomId, mine.payload.id, ABI.id, '…')).toBe(false)

      const other = store.createRoom({ slug: 'other', topic: null }, ALICE)
      const agentMsg = store.post('general', ABI, '…')
      expect(store.discardAgentPlaceholder(other.id, agentMsg.payload.id, ABI.id, '…')).toBe(false)

      // A placeholder somebody replied to is a message in a conversation: deleting it would take
      // the reply's parent out from under it.
      store.post('general', ALICE, 'what are you doing?', [], [], null, agentMsg.payload.id)
      expect(store.discardAgentPlaceholder(agentMsg.roomId, agentMsg.payload.id, ABI.id, '…')).toBe(false)
    })
  })

  describe('checkpointBody - the agent write path', () => {
    it('rewrites the body and leaves NO edit marker', () => {
      const placeholder = store.post('general', ABI, '…')
      const updated = store.checkpointBody(placeholder.roomId, placeholder.payload.id, ABI.id, 'the finished answer')
      expect(updated?.body).toBe('the finished answer')
      // The whole reason this is not editMessage: an agent answer must never wear "(edited)",
      // which the clients render off editedAt !== null.
      expect(updated?.editedAt).toBeNull()
      expect(store.history('general', ABI.id).messages.at(-1)?.editedAt).toBeNull()
    })

    // The invariant the entire ephemeral family exists to protect: only a post may move a room's
    // guard or write to its outbox. A checkpoint that did either would put a phantom message in
    // every member's sidebar on every few seconds of every turn.
    it('issues no key and writes no outbox row', () => {
      const placeholder = store.post('general', ABI, '…')
      const headBefore = store.history('general', ABI.id).headAt
      const eventsBefore = store.latestEventId()

      store.checkpointBody(placeholder.roomId, placeholder.payload.id, ABI.id, 'first checkpoint')
      store.checkpointBody(placeholder.roomId, placeholder.payload.id, ABI.id, 'second checkpoint')

      expect(store.history('general', ABI.id).headAt).toBe(headBefore)
      expect(store.latestEventId()).toBe(eventsBefore)
      expect(store.history('general', ABI.id).messages.at(-1)?.createdAt).toBe(placeholder.payload.createdAt)
    })

    it('emits nothing at all - announcing the new body is the caller\'s business', () => {
      const placeholder = store.post('general', ABI, '…')
      const seen = ephemerals(() => {
        store.checkpointBody(placeholder.roomId, placeholder.payload.id, ABI.id, 'quietly')
      })
      expect(seen).toEqual([])
    })

    // The authorization IS the statement, so a guessed id cannot reach another sender's words
    // or across rooms - it returns null rather than writing.
    it('refuses another sender\'s message, another room, and a deleted one', () => {
      const mine = store.post('general', ALICE, 'my own words')
      expect(store.checkpointBody(mine.roomId, mine.payload.id, ABI.id, 'hijacked')).toBeNull()
      expect(store.history('general', ALICE.id).messages.at(-1)?.body).toBe('my own words')

      const other = store.createRoom({ slug: 'other', topic: null }, ALICE)
      const agentMsg = store.post('general', ABI, '…')
      expect(store.checkpointBody(other.id, agentMsg.payload.id, ABI.id, 'wrong room')).toBeNull()

      store.deleteMessage('general', agentMsg.payload.id, ABI.id)
      expect(store.checkpointBody(agentMsg.roomId, agentMsg.payload.id, ABI.id, 'too late')).toBeNull()
    })

    it('returns null for a message that does not exist', () => {
      const room = store.roomBySlug('general')!
      expect(store.checkpointBody(room.id, 'no-such-message', ABI.id, 'x')).toBeNull()
    })
  })

  describe('approval cards - meta round-trip and the boot sweep', () => {
    const workerCard = (requestId: string) => ({
      kind: 'approval' as const,
      requestId,
      workerSessionId: 'ws-1',
      toolName: 'Bash',
      state: 'pending' as const
    })
    const opCard = (requestId: string, roomId: string) => ({
      kind: 'chat-op' as const,
      requestId,
      op: 'room-delete' as const,
      roomId,
      label: 'Delete #general',
      requestedBy: 'nova',
      state: 'pending' as const,
      expiresAt: 1_000
    })

    it('carries BOTH card kinds through post, the outbox and history', () => {
      const room = store.roomBySlug('general')!
      const worker = store.post('general', ABI, 'worker card', [], [], workerCard('req-1'))
      const op = store.post('general', ABI, 'op card', [], [], opCard('req-2', room.id))
      expect(worker.payload.meta?.kind).toBe('approval')
      expect(op.payload.meta?.kind).toBe('chat-op')

      const page = store.history('general', ABI.id)
      expect(page.messages.at(-2)?.meta).toEqual(workerCard('req-1'))
      expect(page.messages.at(-1)?.meta).toEqual(opCard('req-2', room.id))
      const replayed = store.eventsAfter(0, ABI.id, 10)
      expect(replayed.at(-1)?.payload.meta).toEqual(opCard('req-2', room.id))
    })

    it('degrades an unknown kind to a plain message rather than a broken card', () => {
      const posted = store.post('general', ABI, 'from the future')
      store.db
        .prepare('UPDATE messages SET meta = ? WHERE id = ?')
        .run(JSON.stringify({ kind: 'poll', state: 'pending' }), posted.payload.id)
      expect('meta' in store.history('general', ABI.id).messages.at(-1)!).toBe(false)
    })

    it('lists pending cards PER KIND, so each owner sweeps its own at boot', () => {
      const room = store.roomBySlug('general')!
      const worker = store.post('general', ABI, 'worker card', [], [], workerCard('req-1'))
      const op = store.post('general', ABI, 'op card', [], [], opCard('req-2', room.id))
      store.post('general', ABI, 'plain words')
      expect(store.pendingCards('approval').map((m) => m.id)).toEqual([worker.payload.id])
      expect(store.pendingCards('chat-op').map((m) => m.id)).toEqual([op.payload.id])

      // A settled card is no longer pending; a deleted one is nobody's to settle.
      store.checkpointCard(room.id, op.payload.id, ABI.id, 'op card - expired', {
        ...opCard('req-2', room.id),
        state: 'expired',
        decidedBy: null
      })
      expect(store.pendingCards('chat-op')).toEqual([])
      store.deleteMessage('general', worker.payload.id, ABI.id)
      expect(store.pendingCards('approval')).toEqual([])
    })

    it('survives a corrupt meta cell in the sweep rather than throwing out of it', () => {
      const room = store.roomBySlug('general')!
      const posted = store.post('general', ABI, 'corrupt')
      store.db.prepare('UPDATE messages SET meta = ? WHERE id = ?').run('{not json', posted.payload.id)
      const op = store.post('general', ABI, 'op card', [], [], opCard('req-2', room.id))
      expect(store.pendingCards('chat-op').map((m) => m.id)).toEqual([op.payload.id])
    })

    it('checkpointCard moves body and meta together, with no edit marker', () => {
      const room = store.roomBySlug('general')!
      const op = store.post('general', ABI, 'op card', [], [], opCard('req-2', room.id))
      const settled = store.checkpointCard(room.id, op.payload.id, ABI.id, '**Denied** by Alice.', {
        ...opCard('req-2', room.id),
        state: 'denied',
        decidedBy: ALICE.id,
        decidedAt: 5
      })
      expect(settled?.body).toBe('**Denied** by Alice.')
      expect(settled?.meta).toMatchObject({ kind: 'chat-op', state: 'denied', decidedBy: ALICE.id })
      expect(settled?.editedAt).toBeNull()
      // Sender is part of the authorization: another sender's id rewrites nothing.
      expect(store.checkpointCard(room.id, op.payload.id, ALICE.id, 'hijacked', opCard('req-2', room.id))).toBeNull()
    })

    it('an agent-turn record round-trips and is NOT a pending card', () => {
      const room = store.roomBySlug('general')!
      const placeholder = store.post('general', ABI, '\u2026')
      const record = {
        kind: 'agent-turn' as const,
        workerSessionId: 'ws-9',
        startedAt: 1000,
        endedAt: 4500,
        toolCount: 4,
        state: 'done' as const
      }
      const landed = store.checkpointCard(room.id, placeholder.payload.id, ABI.id, 'here is the answer', record)
      expect(landed?.body).toBe('here is the answer')
      expect(landed?.meta).toEqual(record)
      // Streaming a turn must not look like an edit, for the record exactly as for the body.
      expect(landed?.editedAt).toBeNull()
      // The boot sweep settles PENDING CARDS. A turn record carries no decision, so it must be
      // invisible to both sweeps - otherwise every answer nova ever gave would be swept as an
      // unanswered approval on the next restart.
      expect(store.pendingCards('approval')).toEqual([])
      expect(store.pendingCards('chat-op')).toEqual([])
      // And it survives a re-read from disk, which is the whole reason it is a column.
      expect(store.history('general', ABI.id).messages.at(-1)?.meta).toEqual(record)
    })

    it('messageCount is the same number deleteRoom reports', () => {
      const room = store.roomBySlug('general')!
      store.post('general', ALICE, 'one')
      const two = store.post('general', ALICE, 'two')
      store.deleteMessage('general', two.payload.id, ALICE.id)
      expect(store.messageCount(room.id)).toBe(1)
      expect(store.deleteRoom('general', ALICE.id).messages).toBe(1)
    })
  })

  describe('agent_sessions - the row behind the socket', () => {
    const row = (over: Partial<Parameters<ChatStore['agentSessionSave']>[0]> = {}) => ({
      roomId: store.roomBySlug('general')!.id,
      workerSessionId: 'ws-1',
      streamingMessageId: null,
      lastWorkerSeq: 0,
      turnStartedAt: null,
      turnsThisHour: 0,
      windowStartedAt: 1000,
      ...over
    })

    it('round-trips, and is null for a room that never talked to the agent', () => {
      const roomId = store.roomBySlug('general')!.id
      expect(store.agentSession(roomId)).toBeNull()
      const saved = store.agentSessionSave(row({ turnsThisHour: 3 }))
      expect(store.agentSession(roomId)).toEqual(saved)
      expect(saved.turnsThisHour).toBe(3)
    })

    // One session per ROOM is the scope decision, so the second save must REPLACE rather than
    // add - the uniqueness is the feature.
    it('a second save replaces the row rather than adding one', () => {
      const roomId = store.roomBySlug('general')!.id
      store.agentSessionSave(row({ workerSessionId: 'ws-1' }))
      store.agentSessionSave(row({ workerSessionId: 'ws-2', turnsThisHour: 5 }))
      const stored = store.agentSession(roomId)
      expect(stored?.workerSessionId).toBe('ws-2')
      expect(stored?.turnsThisHour).toBe(5)
    })

    it('lists exactly the rooms that were mid-turn - restart recovery\'s only question', () => {
      const general = store.roomBySlug('general')!.id
      const other = store.createRoom({ slug: 'other', topic: null }, ALICE).id
      store.agentSessionSave(row({ roomId: general, streamingMessageId: 'm-live', turnStartedAt: 5 }))
      store.agentSessionSave(row({ roomId: other, streamingMessageId: null }))

      const streaming = store.agentSessionsStreaming()
      expect(streaming.map((s) => s.roomId)).toEqual([general])
      expect(streaming[0].streamingMessageId).toBe('m-live')
    })

    it('delete forgets the room, idempotently', () => {
      const roomId = store.roomBySlug('general')!.id
      store.agentSessionSave(row())
      store.agentSessionDelete(roomId)
      expect(store.agentSession(roomId)).toBeNull()
      expect(() => store.agentSessionDelete(roomId)).not.toThrow()
    })
  })
})

describe('channel management (reshape, purge)', () => {
  let directory: string
  let store: ChatStore

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'box-chat-mgmt-'))
    store = new ChatStore(join(directory, 'chat.db'))
    // Nothing to join first: the seeded `general` is everybody's, and every management call below
    // is gated on readability alone (migration 015) - a channel grants that to every principal.
  })

  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  describe('updateRoom - rename, name, topic, icon', () => {
    it('renames in place, keeping the room id and its order-key guard', () => {
      clockAt(1_000)
      const before = store.post('general', ALICE, 'one')
      const updated = store.updateRoom('general', ALICE.id, { slug: 'lobby', topic: 'hello' })
      expect(updated.id).toBe(before.roomId)
      expect(updated.slug).toBe('lobby')
      expect(updated.topic).toBe('hello')
      // The guard survived: the next message continues past the last key rather than restarting,
      // which is what keeps every pointer and cursor built on it valid.
      expect(store.post('lobby', ALICE, 'two').payload.createdAt).toBe(1_001)
    })

    it('distinguishes "leave the topic alone" from "clear it"', () => {
      store.updateRoom('general', ALICE.id, { topic: 'standup' })
      expect(store.updateRoom('general', ALICE.id, { slug: 'general' }).topic).toBe('standup')
      expect(store.updateRoom('general', ALICE.id, { topic: null }).topic).toBeNull()
    })

    it('refuses a rename onto a live room', () => {
      store.createRoom({ slug: 'random' }, ALICE)
      expect(() => store.updateRoom('general', ALICE.id, { slug: 'random' })).toThrow(ChatConflictError)
    })

    it('is open to anyone who can read the room - there is no membership to gate on', () => {
      // Carol has never read, posted in or been mentioned in #general, and may still reshape it:
      // every channel is everybody's, and the only gate left is readability.
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!.lastReadAt).toBeNull()
      expect(store.updateRoom('general', CAROL.id, { topic: 'anyone may' }).topic).toBe('anyone may')
      // Reshaping is not reading: it seeds no pointer either.
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!.lastReadAt).toBeNull()
    })

    it('emits room.updated to READERS', () => {
      const seen = ephemerals(() => store.updateRoom('general', ALICE.id, { topic: 'x' }))
      expect(seen.map((e) => [e.type, e.userId])).toEqual([['room.updated', null]])
    })
  })

  describe('room display name (migration 014)', () => {
    it('is null until set, and chatRoomName falls back to the slug', () => {
      const room = store.roomBySlug('general')!
      expect(room.name).toBeNull()
      expect(chatRoomName(room)).toBe('general')
      const named = store.updateRoom('general', ALICE.id, { name: 'The General Store' })
      expect(named.name).toBe('The General Store')
      expect(chatRoomName(named)).toBe('The General Store')
    })

    it('is not an address: the slug still is, and the name is free to collide', () => {
      store.createRoom({ slug: 'deploys', name: 'Ships' }, ALICE)
      store.createRoom({ slug: 'releases', name: 'Ships' }, ALICE)
      // Two rooms, one label - allowed on purpose. Lookups go by slug and are unaffected.
      expect(store.roomBySlug('deploys')!.name).toBe('Ships')
      expect(store.roomBySlug('releases')!.name).toBe('Ships')
      expect(store.roomBySlug('Ships')).toBeNull()
    })

    it('trims, strips control characters, and treats blank as a clear', () => {
      expect(store.updateRoom('general', ALICE.id, { name: '  Dev Team  ' }).name).toBe('Dev Team')
      expect(store.updateRoom('general', ALICE.id, { name: 'Dev\u0000\nTeam' }).name).toBe('DevTeam')
      // A name of nothing but whitespace is a clear, not a name - the same thing an empty string
      // means on the wire, so both spellings of "no name" land in one state.
      expect(store.updateRoom('general', ALICE.id, { name: '   ' }).name).toBeNull()
      expect(store.updateRoom('general', ALICE.id, { name: 'Kept' }).name).toBe('Kept')
      expect(store.updateRoom('general', ALICE.id, { topic: 'x' }).name).toBe('Kept')
      expect(store.updateRoom('general', ALICE.id, { name: null }).name).toBeNull()
    })

    it('refuses one longer than the cap', () => {
      expect(() => store.updateRoom('general', ALICE.id, { name: 'x'.repeat(CHAT_ROOM_NAME_MAX + 1) })).toThrow(
        ChatValidationError
      )
    })
  })

  describe('room icon (migration 013)', () => {
    it('is null until picked, survives an unrelated patch, and clears on an explicit null', () => {
      expect(store.roomBySlug('general')!.icon).toBeNull()
      expect(store.updateRoom('general', ALICE.id, { icon: 'rocket' }).icon).toBe('rocket')
      // The same undefined/null split `topic` has: patching something else leaves the icon alone.
      expect(store.updateRoom('general', ALICE.id, { topic: 'ships' }).icon).toBe('rocket')
      expect(store.updateRoom('general', ALICE.id, { icon: null }).icon).toBeNull()
    })

    it('can be set at create time, and reaches the summary a client reads', () => {
      const created = store.createRoom({ slug: 'deploys', icon: 'server' }, ALICE)
      expect(created.icon).toBe('server')
      expect(store.roomsVisibleTo(ALICE.id).find((r) => r.slug === 'deploys')!.icon).toBe('server')
    })

    it('refuses a name that is not in the curated list - the column has no CHECK to do it', () => {
      // @ts-expect-error - the point of the test is the RUNTIME guard, which is what stands between
      // an unvalidated caller (a script, an older client) and a room every client draws as blank.
      expect(() => store.updateRoom('general', ALICE.id, { icon: 'not-an-icon' })).toThrow(ChatValidationError)
      // @ts-expect-error - same, on the create path.
      expect(() => store.createRoom({ slug: 'nope', icon: 'skull' }, ALICE)).toThrow(ChatValidationError)
      expect(store.roomBySlug('nope')).toBeNull()
    })
  })

  describe('deleteRoom - the purge, and the only way a room ends', () => {
    it('destroys the room and everything cascading off it', () => {
      const hello = store.post('general', ALICE, 'hello @carol', [CAROL.id]).payload
      const hi = store.post('general', CAROL, 'hi').payload
      store.markRead('general', 'bob', 0)
      store.setReaction('general', hi.id, ALICE.id, '👍', true)
      store.dismissNotification(CAROL.id, `mention:${hello.id}`)
      store.dismissNotification(CAROL.id, `message:${hi.id}`)
      store.dismissNotification(CAROL.id, 'alert:x')
      const room = store.roomBySlug('general')!

      const result = store.deleteRoom('general', ALICE.id)
      expect(result).toEqual({ roomId: room.id, slug: 'general', messages: 2, blobs: 0 })
      expect(store.roomBySlug('general')).toBeNull()
      expect(store.roomsVisibleTo(ALICE.id)).toEqual([])
      // The cascade: messages, outbox events, mentions and every read-pointer row went with the row.
      const count = (table: string): number =>
        (store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE room_id = ?`).get(room.id) as { n: number }).n
      expect([count('messages'), count('events'), count('mentions'), count('room_members')]).toEqual([0, 0, 0, 0])
      // And the mention row is gone with it, so nobody is left holding a bell for a room that
      // cannot be opened; the reactions went through the messages, and the bell tombstones for
      // its items were pruned by hand - only the unrelated one survives.
      expect(store.unseenMentionCount(CAROL.id)).toBe(0)
      expect(store.reactionsForMessage(hi.id)).toEqual([])
      expect(store.dismissedNotifications(CAROL.id)).toEqual(['alert:x'])
    })

    it('unlinks the blobs it held the last reference to, and spares the shared ones', () => {
      store.createRoom({ slug: 'other' }, ALICE)
      const bytes = Buffer.from('shared-bytes')
      const mine = store.attachmentCreate(ALICE.id, { filename: 'a.png', mime: 'image/png', bytes })
      const theirs = store.attachmentCreate(ALICE.id, { filename: 'b.png', mime: 'image/png', bytes })
      const only = store.attachmentCreate(ALICE.id, {
        filename: 'c.png',
        mime: 'image/png',
        bytes: Buffer.from('only-here')
      })
      store.post('general', ALICE, 'shared', [], [mine.id, only.id])
      store.post('other', ALICE, 'also shared', [], [theirs.id])

      const result = store.deleteRoom('general', ALICE.id)
      // One blob unlinked (the one only this room referenced); the deduped one survives because
      // another room's message still points at it - deleting your copy must not tear it out of
      // somebody else's message.
      expect(result.blobs).toBe(1)
      expect(listBlobs(store.uploadsDir, Date.now()).blobs).toEqual([theirs.sha256])
    })

    it('deletes a room that has an agent session row (no cascade there - it is deleted by hand)', () => {
      const room = store.roomBySlug('general')!
      store.agentSessionSave({
        roomId: room.id,
        workerSessionId: 'w1',
        streamingMessageId: null,
        lastWorkerSeq: 0,
        turnStartedAt: null,
        turnsThisHour: 0,
        windowStartedAt: Date.now()
      })
      expect(() => store.deleteRoom('general', ALICE.id)).not.toThrow()
      expect(store.agentSession(room.id)).toBeNull()
    })

    it('routes room.deleted by AUDIENCE at emit time: everyone for a channel, the pair for a DM', () => {
      // A channel is everybody's, so its deletion is told to everybody - not merely to whoever
      // happened to hold a read pointer in it.
      store.markRead('general', CAROL.id, 0)
      const channelSeen = ephemerals(() => store.deleteRoom('general', ALICE.id))
      expect(channelSeen.map((e) => [e.type, e.userId])).toEqual([['room.deleted', null]])

      // A DM's audience is read off its member rows a moment before they cascade away - the one
      // place the old "capture the members first" trick is still doing real work.
      const dm = store.openDirect(ALICE, CAROL.id)
      const pairSeen = ephemerals(() => store.deleteRoom(dm.slug, ALICE.id))
      expect(pairSeen.every((e) => e.type === 'room.deleted' && e.roomId === dm.id)).toBe(true)
      expect(pairSeen.map((e) => e.userId).sort()).toEqual([ALICE.id, CAROL.id])
    })

    it('is open to anyone who can read the room, which for a channel is everyone', () => {
      // Carol never touched #general; he can still delete it. Anything stricter (an admin role, the
      // in-channel approval for API callers) is layered on by the server, not by the store.
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === 'general')!.lastReadAt).toBeNull()
      expect(store.deleteRoom('general', CAROL.id).slug).toBe('general')
      expect(store.roomBySlug('general')).toBeNull()
    })

    it('a DM can be deleted by either of its pair and by nobody else', () => {
      const dm = store.openDirect(ALICE, CAROL.id)
      expect(() => store.deleteRoom(dm.slug, 'bob')).toThrow(ChatAccessError)
      expect(store.deleteRoom(dm.slug, CAROL.id).roomId).toBe(dm.id)
      expect(store.roomBySlug(dm.slug)).toBeNull()
    })
  })

  describe('moderation - deleting somebody else\'s message', () => {
    it('refuses by default and allows only with the explicit flag', () => {
      const posted = store.post('general', CAROL, 'oops')
      expect(() => store.deleteMessage('general', posted.payload.id, ALICE.id)).toThrow(ChatAccessError)
      const removed = store.deleteMessage('general', posted.payload.id, ALICE.id, { anySender: true })
      expect(removed.deleted).toEqual([posted.payload.id])
      expect(store.message(posted.roomId, posted.payload.id)).toBeNull()
    })

    it('has no equivalent for EDIT - deleting is moderation, editing would be forgery', () => {
      const posted = store.post('general', CAROL, 'my words')
      expect(() => store.editMessage('general', posted.payload.id, ALICE.id, 'not my words')).toThrow(ChatAccessError)
    })
  })
})

describe('direct messages (Track 14)', () => {
  let directory: string
  let store: ChatStore
  const BOB: ChatSender = { id: 'bob', display: 'Bob' }
  const SLUG = 'dm:alice:carol'
  const dmCount = (): number => (store.db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE kind = 'dm'").get() as { n: number }).n
  /** A DM's member rows, straight from the table: the two-member invariant is what every DM rule
   *  rests on, and since migration 015 no public surface lists them (nothing needs to). */
  const memberIds = (slug: string): string[] =>
    (
      store.db
        .prepare('SELECT user_id FROM room_members WHERE room_id = ? ORDER BY user_id')
        .all(store.roomBySlug(slug)!.id) as { user_id: string }[]
    ).map((row) => row.user_id)

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'box-chat-test-'))
    store = new ChatStore(join(directory, 'chat.db'))
  })

  afterEach(() => {
    vi.useRealTimers()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('derives the address from the SORTED pair, so both sides compute the same slug', () => {
    expect(directSlug('alice', 'carol')).toBe(SLUG)
    expect(directSlug('carol', 'alice')).toBe(SLUG)
    expect(directSlug('nova', 'alice')).toBe('dm:alice:nova')
  })

  it('opens a two-member room whose summary names the OTHER person on each side', () => {
    const opened = store.openDirect(ALICE, CAROL.id)
    expect(opened).toMatchObject({ slug: SLUG, kind: 'dm', topic: null, peer: CAROL.id })
    // Born like createRoom's room: head 0, both pointers at the head, nothing owed, no outbox row.
    expect(opened.headAt).toBe(0)
    expect(opened.lastReadAt).toBe(0)
    expect(opened.unread).toBe(0)
    expect(store.eventsAfter(0, ALICE.id, 100)).toHaveLength(0)
    expect(memberIds(SLUG)).toEqual([ALICE.id, CAROL.id])
    // Carol did not ask for it and is in it anyway - that is what a DM is - and HIS peer is Alice.
    const dans = store.roomsVisibleTo(CAROL.id).find((r) => r.slug === SLUG)!
    expect(dans).toMatchObject({ kind: 'dm', lastReadAt: 0, peer: ALICE.id, unread: 0 })
    // A named room has no peer, and every pre-existing room is a named one.
    expect(store.roomsVisibleTo(ALICE.id).find((r) => r.slug === 'general')).toMatchObject({ kind: 'room', peer: null })
    expect(store.roomBySlug('general')!.kind).toBe('room')
  })

  it('is idempotent both ways round: open(a, b) then open(b, a) is ONE room, announced once', () => {
    let first: ReturnType<ChatStore['openDirect']> | undefined
    let second: ReturnType<ChatStore['openDirect']> | undefined
    const seen = ephemerals(() => {
      first = store.openDirect(ALICE, CAROL.id)
      second = store.openDirect(CAROL, ALICE.id)
    })
    expect(second!.id).toBe(first!.id)
    expect(dmCount()).toBe(1)
    // room.created once, to READERS - which for a private two-member room is exactly the two of
    // them, so the peer's sidebar grows live. The re-open changed nothing and says nothing.
    expect(seen.map((e) => [e.type, e.userId, e.roomId])).toEqual([['room.created', null, first!.id]])
    expect(store.openDirect(ALICE, CAROL.id).id).toBe(first!.id)
  })

  it('re-opening never moves an existing pointer, and re-asserts a missing member row', () => {
    const dm = store.openDirect(ALICE, CAROL.id)
    store.post(SLUG, ALICE, 'hi')
    // Carol owes one message; Carol opening the DM (the client resolving its slug) must not read it for him.
    expect(store.openDirect(CAROL, ALICE.id).unread).toBe(1)
    // Nothing in the store can remove a DM member, but a hand-edit can - and the next open repairs
    // the two-member invariant rather than handing back a one-member "DM".
    store.db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(dm.id, CAROL.id)
    expect(store.openDirect(ALICE, CAROL.id).peer).toBe(CAROL.id)
    expect(memberIds(SLUG)).toEqual([ALICE.id, CAROL.id])
  })

  it('the SCHEMA holds the uniqueness: a second row at the address is a constraint error, and a second connection finds the first room', () => {
    const first = store.openDirect(ALICE, CAROL.id)
    // Bypass the find-or-create entirely: what refuses here is the UNIQUE index on rooms.slug, not
    // the SELECT that openDirect ran first. That is the guarantee a script that never takes the
    // transaction still gets.
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO rooms (id, slug, topic, kind, head_at, created_by, created_at, updated_at)
           VALUES ('dup', ?, NULL, 'dm', 0, 'alice', 1, 1)`
        )
        .run(first.slug)
    ).toThrow(/UNIQUE constraint failed: rooms\.slug/)
    // A second store on the same file - the shape a script beside the server has - resolves the
    // same pair to the room the first one created.
    const other = new ChatStore(join(directory, 'chat.db'))
    try {
      expect(other.openDirect(CAROL, ALICE.id).id).toBe(first.id)
    } finally {
      other.close()
    }
    expect(dmCount()).toBe(1)
  })

  it('refuses a DM with yourself, and an id the derivation could not disambiguate', () => {
    const seen = ephemerals(() => {
      expect(() => store.openDirect(ALICE, ALICE.id)).toThrow(ChatValidationError)
      expect(() => store.openDirect(ALICE, 'a:b')).toThrow(ChatValidationError)
      expect(() => store.openDirect(ALICE, '')).toThrow(ChatValidationError)
    })
    expect(seen).toHaveLength(0)
    expect(dmCount()).toBe(0)
  })

  it('is invisible to a third person: not listed, not readable, not writable, not replayed', () => {
    const dm = store.openDirect(ALICE, CAROL.id)
    store.post(SLUG, ALICE, 'between us')
    expect(store.roomsVisibleTo(BOB.id).map((r) => r.slug)).toEqual(['general'])
    expect(store.canReadRoom(dm.id, BOB.id)).toBe(false)
    const seen = ephemerals(() => {
      expect(() => store.history(SLUG, BOB.id)).toThrow(ChatAccessError)
      expect(() => store.post(SLUG, BOB, 'hello?')).toThrow(ChatAccessError)
      // The one room where a first markRead does NOT create a pointer: a third row here would
      // break the pair. Readability refuses it before the pointer rule is even reached.
      expect(() => store.markRead(SLUG, BOB.id, 1)).toThrow(ChatAccessError)
      expect(() => store.updateRoom(SLUG, BOB.id, { topic: 'x' })).toThrow(ChatAccessError)
      expect(() => store.deleteRoom(SLUG, BOB.id)).toThrow(ChatAccessError)
    })
    expect(seen).toHaveLength(0)
    expect(memberIds(SLUG)).toEqual([ALICE.id, CAROL.id])
    // The feed's replay filter is READABLE_PREDICATE too: the outbox row exists for Carol, not Bob.
    expect(store.eventsAfter(0, BOB.id, 100)).toHaveLength(0)
    expect(store.eventsAfter(0, CAROL.id, 100)).toHaveLength(1)
  })

  it('has exactly two member rows, and only openDirect ever writes one', () => {
    store.openDirect(ALICE, CAROL.id)
    // Everything a channel would seed a pointer for - a post, a mention, a markRead - leaves a
    // DM's rows exactly as the open wrote them: the pair IS the ACL, and the pointers ride on it.
    const hi = store.post(SLUG, ALICE, 'hi @carol @bob', [CAROL.id, BOB.id]).payload
    store.markRead(SLUG, CAROL.id, hi.createdAt)
    store.markRead(SLUG, ALICE.id, hi.createdAt)
    expect(memberIds(SLUG)).toEqual([ALICE.id, CAROL.id])
    expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === SLUG)).toMatchObject({ lastReadAt: hi.createdAt, unread: 0 })
    expect(store.history(SLUG, CAROL.id).messages).toHaveLength(1)
  })

  it('cannot be renamed, re-topiced or given an icon - and the schema pins its kind to its address', () => {
    store.openDirect(ALICE, CAROL.id)
    const seen = ephemerals(() => {
      expect(() => store.updateRoom(SLUG, ALICE.id, { slug: 'alice-carol' })).toThrow(ChatValidationError)
      expect(() => store.updateRoom(SLUG, ALICE.id, { topic: 'lunch' })).toThrow(ChatValidationError)
      expect(() => store.updateRoom(SLUG, ALICE.id, { icon: 'rocket' })).toThrow(ChatValidationError)
    })
    expect(seen).toHaveLength(0)
    // The CHECK from migration 015: even raw SQL cannot turn a 1:1 history into a channel under
    // its slug - `kind` and the `dm:` namespace are pinned to each other.
    expect(() => store.db.prepare(`UPDATE rooms SET kind = 'room' WHERE slug = ?`).run(SLUG)).toThrow(
      /CHECK constraint failed/
    )
    expect(store.roomBySlug(SLUG)).toMatchObject({ slug: SLUG, kind: 'dm', topic: null })
  })

  it('reserves the dm: namespace - a named room cannot be created at, or renamed into, a DM address', () => {
    expect(() => store.createRoom({ slug: SLUG }, ALICE)).toThrow(ChatValidationError)
    expect(() => store.createRoom({ slug: 'dm:anything' }, ALICE)).toThrow(ChatValidationError)
    store.createRoom({ slug: 'lobby' }, ALICE)
    expect(() => store.updateRoom('lobby', ALICE.id, { slug: 'dm:x:y' })).toThrow(ChatValidationError)
    expect(store.roomBySlug(SLUG)).toBeNull()
    expect(store.roomBySlug('lobby')!.slug).toBe('lobby')
    // And the other direction of the same CHECK: a channel cannot be declared a DM by hand.
    expect(() => store.db.prepare(`UPDATE rooms SET kind = 'dm' WHERE slug = 'lobby'`).run()).toThrow(
      /CHECK constraint failed/
    )
  })

  it('directPeer names the other member for the notification seam, and null for anything else', () => {
    const dm = store.openDirect(ALICE, CAROL.id)
    expect(store.directPeer(dm.id, ALICE.id)).toBe(CAROL.id)
    expect(store.directPeer(dm.id, CAROL.id)).toBe(ALICE.id)
    // A channel has no peer, whether or not the viewer holds a pointer there.
    store.post('general', CAROL, 'hi')
    store.post('general', ALICE, 'hi back')
    expect(store.directPeer(store.roomBySlug('general')!.id, ALICE.id)).toBeNull()
    expect(store.directPeer('no-such-room', ALICE.id)).toBeNull()
  })

  it('a message in a DM is an ordinary post: one key, one outbox row, the peer badged, and the bell knows the kind', () => {
    store.openDirect(ALICE, CAROL.id)
    const event = store.post(SLUG, ALICE, 'hello carol')
    expect(event.type).toBe('message.created')
    expect(headOf(store, SLUG)).toBe(event.at)
    expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === SLUG)!.unread).toBe(1)
    // The sender owes their own message too, exactly as a room CREATOR does: both were seeded at
    // head 0 by the open, and posting never moves an existing pointer (markRead is the only thing
    // that does - see "backlog survives posting blind"). The client marks the open room read.
    expect(store.roomsVisibleTo(ALICE.id).find((r) => r.slug === SLUG)!.unread).toBe(1)
    expect(store.markRead(SLUG, ALICE.id, event.at).unread).toBe(0)
    // The bell's recent stratum carries roomKind, so a DM row can be titled by its sender rather
    // than by a slug nobody typed.
    expect(store.recentMessagesFor(CAROL.id, 10).map((r) => [r.roomKind, r.roomSlug, r.senderName])).toEqual([
      ['dm', SLUG, 'Alice']
    ])
  })

  it('a mention inside a DM can address only who is already there - no third member is ever granted', () => {
    store.openDirect(ALICE, CAROL.id)
    const seen = ephemerals(() => store.post(SLUG, ALICE, '@carol @bob look at this', [CAROL.id, BOB.id]))
    // The peer's mention is recorded (bell row, mention.created); Bob's is inert text.
    expect(seen.filter((e) => e.type === 'mention.created').map((e) => e.userId)).toEqual([CAROL.id])
    expect(memberIds(SLUG)).toEqual([ALICE.id, CAROL.id])
    expect(store.roomsVisibleTo(BOB.id).map((r) => r.slug)).toEqual(['general'])
    expect(store.mentionsFor(BOB.id, 10)).toHaveLength(0)
    const dans = store.mentionsFor(CAROL.id, 10)
    expect(dans).toHaveLength(1)
    expect(dans[0].roomKind).toBe('dm')
    // The DM rule is the exception, not the norm: in a channel a mention still seeds the pointer.
    store.createRoom({ slug: 'war-room' }, ALICE)
    const ping = store.post('war-room', ALICE, '@bob', [BOB.id]).payload
    expect(store.roomsVisibleTo(BOB.id).find((r) => r.slug === 'war-room')).toMatchObject({
      lastReadAt: ping.createdAt - 1,
      unread: 1
    })
  })

  // The ONE exception to the intersection above (2026-09-04): the agent is mentionable in a DM
  // between two people, and what it gets is a GUEST PASS - read and post while a surviving
  // message mentions it - never a third member row. See `ChatStore.isDirectGuest`.
  describe('the agent as a guest - @nova in a DM between two people', () => {
    const ABI: ChatSender = { id: systemUserId(), display: 'nova' }
    const mentionRows = (roomId: string, userId: string): number =>
      (
        store.db
          .prepare('SELECT COUNT(*) AS n FROM mentions WHERE room_id = ? AND user_id = ?')
          .get(roomId, userId) as { n: number }
      ).n

    it('is a REAL mention - a row and a summons - and grants no membership: the pair stays the pair', () => {
      const dm = store.openDirect(ALICE, CAROL.id)
      const seen = ephemerals(() =>
        store.post(SLUG, ALICE, '@nova @bob can you look at this?', [systemUserId(), BOB.id])
      )
      // The agent is summoned; the third human is inert text - one intersection decides both.
      expect(seen.filter((e) => e.type === 'mention.created').map((e) => e.userId)).toEqual([systemUserId()])
      expect(mentionRows(dm.id, systemUserId())).toBe(1)
      expect(mentionRows(dm.id, BOB.id)).toBe(0)
      expect(memberIds(SLUG)).toEqual([ALICE.id, CAROL.id])
      expect(store.canReadRoom(dm.id, BOB.id)).toBe(false)
      expect(store.roomsVisibleTo(BOB.id).map((r) => r.slug)).toEqual(['general'])
      // The pass: readable by id and by slug, for the agent alone.
      expect(store.canReadRoom(dm.id, systemUserId())).toBe(true)
      expect(store.history(SLUG, systemUserId()).messages.map((m) => m.body)).toEqual([
        '@nova @bob can you look at this?'
      ])
    })

    it('the summons resolves by the MENTION door, threaded on the ask - the DM door does not misfire', () => {
      store.openDirect(ALICE, CAROL.id)
      const seen = ephemerals(() => store.post(SLUG, ALICE, '@nova how many stars?', [systemUserId()]))
      const summons = seen.find((e) => e.type === 'mention.created')!
      // The REAL store as the trigger's reads: Alice's peer is Carol, so the DM door declines and the
      // mention door takes it - a thread on the question, like a mention in #general.
      expect(resolveAgentTrigger(summons, store)).toMatchObject({
        via: 'mention',
        senderId: ALICE.id,
        threadRootId: summons.payload!.id
      })
      // A plain message between the two of them is nobody's ask.
      expect(resolveAgentTrigger(store.post(SLUG, CAROL, 'just between us'), store)).toBeNull()
    })

    it('can post its answer into the thread, readable by both, without becoming a member', () => {
      const dm = store.openDirect(ALICE, CAROL.id)
      const ask = store.post(SLUG, ALICE, '@nova how many stars?', [systemUserId()]).payload
      const answer = store.post(SLUG, ABI, '1,234', [], [], null, ask.id).payload
      expect(answer.parentId).toBe(ask.id)
      expect(store.thread(SLUG, CAROL.id, ask.id).replies.map((m) => m.senderId)).toEqual([systemUserId()])
      expect(store.history(SLUG, ALICE.id).messages.map((m) => m.senderId)).toEqual([ALICE.id, systemUserId()])
      // Still exactly two member rows: no pointer seed on the post, none on the mention.
      expect(memberIds(SLUG)).toEqual([ALICE.id, CAROL.id])
      // Both humans owe the answer as unread, exactly as they would in a DM with nova.
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === SLUG)!.unread).toBe(2)
      // No pointer: no sidebar row, no bell row, and markRead refuses to create one - the one
      // room where a first markRead is not a birth, because a third row would break the pair.
      // Nor may the guest purge the conversation it was asked into.
      expect(store.roomsVisibleTo(systemUserId()).map((r) => r.slug)).toEqual(['general'])
      expect(store.mentionsFor(systemUserId(), 10)).toHaveLength(0)
      expect(store.recentMessagesFor(systemUserId(), 10).map((r) => r.roomId)).not.toContain(dm.id)
      expect(() => store.markRead(SLUG, systemUserId(), answer.createdAt)).toThrow(ChatAccessError)
      expect(() => store.deleteRoom(SLUG, systemUserId())).toThrow(ChatAccessError)
      expect(memberIds(SLUG)).toEqual([ALICE.id, CAROL.id])
      expect(store.roomBySlug(SLUG)).not.toBeNull()
    })

    it('has no pass before a mention, and loses it when the ask is deleted (the row cascades)', () => {
      const dm = store.openDirect(ALICE, CAROL.id)
      store.post(SLUG, ALICE, 'hi carol')
      expect(store.canReadRoom(dm.id, systemUserId())).toBe(false)
      expect(() => store.history(SLUG, systemUserId())).toThrow(ChatAccessError)
      expect(() => store.post(SLUG, ABI, 'hello?')).toThrow(ChatAccessError)
      const ask = store.post(SLUG, ALICE, '@nova look', [systemUserId()]).payload
      store.post(SLUG, ABI, 'looking', [], [], null, ask.id)
      expect(store.canReadRoom(dm.id, systemUserId())).toBe(true)
      store.deleteMessage(SLUG, ask.id, ALICE.id)
      expect(mentionRows(dm.id, systemUserId())).toBe(0)
      expect(store.canReadRoom(dm.id, systemUserId())).toBe(false)
      expect(() => store.history(SLUG, systemUserId())).toThrow(ChatAccessError)
      expect(() => store.post(SLUG, ABI, 'still here?')).toThrow(ChatAccessError)
      // The pair's own history survived the revocation untouched.
      expect(store.history(SLUG, CAROL.id).messages.map((m) => m.body)).toEqual(['hi carol'])
    })

    it('leaves directPeer and the summary peer on the human pair - a guest has no peer', () => {
      const dm = store.openDirect(ALICE, CAROL.id)
      const ask = store.post(SLUG, ALICE, '@nova', [systemUserId()]).payload
      store.post(SLUG, ABI, 'yes?', [], [], null, ask.id)
      expect(store.directPeer(dm.id, ALICE.id)).toBe(CAROL.id)
      expect(store.directPeer(dm.id, CAROL.id)).toBe(ALICE.id)
      expect(store.directPeer(dm.id, systemUserId())).toBeNull()
      expect(store.directPeer(dm.id, BOB.id)).toBeNull()
      expect(store.roomsVisibleTo(ALICE.id).find((r) => r.slug === SLUG)).toMatchObject({
        kind: 'dm',
        peer: CAROL.id,
        lastReadAt: 0
      })
      expect(store.roomsVisibleTo(CAROL.id).find((r) => r.slug === SLUG)).toMatchObject({
        kind: 'dm',
        peer: ALICE.id,
        lastReadAt: 0
      })
    })

    it('is the agent alone: a mention row for a human is no pass, and a channel still seeds the agent a pointer', () => {
      const dm = store.openDirect(ALICE, CAROL.id)
      const ask = store.post(SLUG, ALICE, '@nova @bob', [systemUserId(), BOB.id]).payload
      // Even a row planted by hand for a human is not a pass - the rule is keyed on WHO, not on
      // the row alone - and the DM stays invisible to Bob.
      store.db
        .prepare('INSERT INTO mentions (message_id, user_id, room_id, created_at, seen_at) VALUES (?, ?, ?, ?, NULL)')
        .run(ask.id, BOB.id, dm.id, ask.createdAt)
      expect(store.canReadRoom(dm.id, BOB.id)).toBe(false)
      expect(() => store.history(SLUG, BOB.id)).toThrow(ChatAccessError)
      expect(() => store.post(SLUG, BOB, 'hi')).toThrow(ChatAccessError)
      // Outside a DM nothing changed: in a channel a mention still seeds nova a pointer one key
      // before the ask, so the ask is the one thing owed.
      store.createRoom({ slug: 'war-room' }, ALICE)
      const summons = store.post('war-room', ALICE, '@nova', [systemUserId()]).payload
      expect(store.roomsVisibleTo(systemUserId()).find((r) => r.slug === 'war-room')).toMatchObject({
        lastReadAt: summons.createdAt - 1,
        unread: 1
      })
    })

    it('a DM WITH nova is unchanged: a member, its peer, the DM door and top-level answers', () => {
      const dm = store.openDirect(ALICE, systemUserId())
      const withAbi = 'dm:alice:nova'
      expect(dm).toMatchObject({ slug: withAbi, peer: systemUserId(), lastReadAt: 0 })
      expect(memberIds(withAbi)).toEqual([ALICE.id, systemUserId()])
      expect(store.directPeer(dm.id, ALICE.id)).toBe(systemUserId())
      expect(store.directPeer(dm.id, systemUserId())).toBe(ALICE.id)
      // A plain message is the DM door's ask, at top level - and so is one that writes "@nova".
      expect(resolveAgentTrigger(store.post(withAbi, ALICE, 'how many stars?'), store)).toMatchObject({
        via: 'dm',
        threadRootId: null
      })
      const seen = ephemerals(() => store.post(withAbi, ALICE, '@nova and npm?', [systemUserId()]))
      expect(seen.filter((e) => e.type === 'mention.created').map((e) => e.userId)).toEqual([systemUserId()])
      expect(resolveAgentTrigger(seen.find((e) => e.type === 'mention.created')!, store)).toMatchObject({
        via: 'dm',
        threadRootId: null
      })
      // nova answers as a member at top level, and marks the DM read like any member would.
      const answer = store.post(withAbi, ABI, '1,234').payload
      expect(answer.parentId).toBeUndefined()
      expect(store.markRead(withAbi, systemUserId(), answer.createdAt).unread).toBe(0)
      expect(memberIds(withAbi)).toEqual([ALICE.id, systemUserId()])
      expect(store.roomsVisibleTo(systemUserId()).map((r) => r.slug)).toEqual([withAbi, 'general'])
    })
  })

  it('refuses an enclosing transaction (publish-after-commit)', () => {
    expect(() => store.transaction(() => store.openDirect(ALICE, CAROL.id))).toThrow(/enclosing transaction/)
  })
})

describe('migration 012 - the room kind', () => {
  it('backfills every existing room as a named room, installs the DM check, and snapshots first', () => {
    const directory = mkdtempSync(join(tmpdir(), 'box-chat-012-'))
    const path = join(directory, 'chat.db')
    try {
      // A database exactly as the shipped chain left it before 012 (eleven migrations, run for
      // real), with rooms written through the OLD column set - there is no kind to write.
      const old = new Database(path)
      migrateChat(old, CHAT_MIGRATIONS.slice(0, 11))
      const insert = old.prepare(
        `INSERT INTO rooms (id, slug, topic, visibility, head_at, created_by, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 0, 'alice', 1, 1)`
      )
      insert.run('r-deploys', 'deploys', 'public')
      // Private and empty of members: the shape 015 purges. (A private room WITH members would
      // make 015 refuse the whole chain - see its own tests - so this seed cannot carry one.)
      insert.run('r-sekrit', 'sekrit', 'private')
      old.prepare('INSERT INTO room_members (room_id, user_id, joined_at, last_read_at) VALUES (?, ?, 1, 0)').run(
        'r-deploys',
        'alice'
      )
      old.close()

      const store = new ChatStore(path)
      try {
        expect(existsSync(`${path}.pre-012-direct-messages.bak`)).toBe(true)
        expect(
          (store.db.prepare('SELECT name FROM schema_migrations ORDER BY applied_at, name').all() as { name: string }[]).map(
            (r) => r.name
          )
        ).toContain('012-direct-messages')
        // Every pre-existing row - the seeded general included - is a named room, and reads as one.
        // (sekrit is absent because 015, further down the same chain, purged the abandoned
        // private channel; 012 itself backfilled it as a named room like the rest.)
        expect(store.db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE kind <> 'room'").get()).toEqual({ n: 0 })
        expect(store.roomsVisibleTo('alice').map((r) => [r.slug, r.kind, r.peer])).toEqual([
          ['deploys', 'room', null],
          ['general', 'room', null]
        ])
        expect(store.roomBySlug('sekrit')).toBeNull()
        // Alice's pre-migration member row in #deploys is his read pointer now, and nothing else.
        expect(store.roomsVisibleTo('alice').find((r) => r.slug === 'deploys')!.lastReadAt).toBe(0)
        // The check is live on the old rows too (015 rehung it on the slug): a channel cannot be
        // declared a DM.
        expect(() => store.db.prepare(`UPDATE rooms SET kind = 'dm' WHERE slug = 'deploys'`).run()).toThrow(
          /CHECK constraint failed/
        )
        // And the new path works on the migrated file.
        expect(store.openDirect(ALICE, CAROL.id).kind).toBe('dm')
      } finally {
        store.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('migration 015 - every channel is open, and rooms.visibility goes', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'box-chat-015-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  const count = (db: Database.Database, sql: string): number => (db.prepare(sql).get() as { n: number }).n

  /** Every room, in the shape a post-015 reader sees it: what the rebuild must carry value for value. */
  const roomRows = (db: Database.Database): { slug: string }[] =>
    db
      .prepare('SELECT id, slug, name, topic, kind, icon, head_at, created_by, created_at, updated_at FROM rooms ORDER BY slug')
      .all() as { slug: string }[]

  /**
   * A database exactly as the shipped chain left it before 015 (fourteen migrations, run for
   * real), holding what production holds on the day this ships: an open channel, a DM, and a
   * PRIVATE channel nobody is left in - `founders`, five messages, zero member rows - with
   * everything that can hang off a room hanging off it, all written through the old column set.
   * `extra` adds whatever rooms one case needs on top.
   */
  const seedPre015 = (extra: (db: Database.Database) => void = () => {}): string => {
    const file = join(directory, 'chat.db')
    const db = new Database(file)
    migrateChat(db, CHAT_MIGRATIONS.slice(0, 14))
    const room = db.prepare(
      `INSERT INTO rooms (id, slug, name, topic, visibility, kind, icon, head_at, created_by, created_at, updated_at)
       VALUES (@id, @slug, @name, @topic, @visibility, @kind, @icon, @head, 'alice', 1, 2)`
    )
    room.run({ id: 'r-deploys', slug: 'deploys', name: 'Ships', topic: 'what shipped', visibility: 'public', kind: 'room', icon: 'rocket', head: 1_001 })
    room.run({ id: 'r-founders', slug: 'founders', name: null, topic: 'just us', visibility: 'private', kind: 'room', icon: 'lock', head: 2_005 })
    room.run({ id: 'r-dm', slug: 'dm:alice:carol', name: null, topic: null, visibility: 'private', kind: 'dm', icon: null, head: 3_000 })
    const member = db.prepare('INSERT INTO room_members (room_id, user_id, joined_at, last_read_at) VALUES (?, ?, 1, ?)')
    member.run('r-deploys', 'alice', 1_001)
    member.run('r-deploys', 'carol', 999) // mentioned in, under the old rules
    member.run('r-dm', 'alice', 3_000)
    member.run('r-dm', 'carol', 0)
    const message = db.prepare(
      `INSERT INTO messages (id, room_id, sender_id, sender_name, body, created_at, parent_id)
       VALUES (@id, @room, @sender, @sender, @body, @at, @parent)`
    )
    const event = db.prepare(
      `INSERT INTO events (room_id, type, payload, actor_id, created_at) VALUES (@room, 'message.created', @payload, @sender, @at)`
    )
    for (const row of [
      { id: 'm1', room: 'r-deploys', sender: 'alice', body: 'shipped', at: 1_000, parent: null },
      { id: 'm2', room: 'r-deploys', sender: 'alice', body: 'and @carol should know', at: 1_001, parent: null },
      { id: 'f1', room: 'r-founders', sender: 'alice', body: 'founders one', at: 2_001, parent: null },
      { id: 'f2', room: 'r-founders', sender: 'alice', body: 'founders two', at: 2_002, parent: null },
      { id: 'f3', room: 'r-founders', sender: 'alice', body: 'a reply', at: 2_003, parent: 'f2' },
      { id: 'f4', room: 'r-founders', sender: 'alice', body: 'with a screenshot', at: 2_004, parent: null },
      { id: 'f5', room: 'r-founders', sender: 'alice', body: 'and @carol, who has since left', at: 2_005, parent: null },
      { id: 'm3', room: 'r-dm', sender: 'alice', body: 'just us', at: 3_000, parent: null }
    ]) {
      message.run(row)
      event.run({
        ...row,
        payload: JSON.stringify({
          id: row.id,
          roomId: row.room,
          senderId: row.sender,
          senderName: row.sender,
          body: row.body,
          createdAt: row.at,
          editedAt: null
        })
      })
    }
    const mention = db.prepare('INSERT INTO mentions (message_id, user_id, room_id, created_at, seen_at) VALUES (?, ?, ?, ?, NULL)')
    mention.run('m2', 'carol', 'r-deploys', 1_001)
    mention.run('f5', 'carol', 'r-founders', 2_005)
    db.prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, 1)').run('f1', 'alice', '👍')
    db.prepare(
      `INSERT INTO attachments (id, message_id, uploader_id, filename, mime, bytes, sha256, created_at)
       VALUES ('att-f4', 'f4', 'alice', 'shot.png', 'image/png', 2, ?, 1)`
    ).run('f'.repeat(64))
    const dismiss = db.prepare('INSERT INTO notification_dismissals (user_id, item_id, dismissed_at) VALUES (?, ?, 1)')
    dismiss.run('carol', 'mention:f5')
    dismiss.run('carol', 'message:f1')
    dismiss.run('carol', 'mention:m2')
    dismiss.run('carol', 'alert:x')
    const session = db.prepare(
      `INSERT INTO agent_sessions (room_id, worker_session_id, last_worker_seq, turns_this_hour, window_started_at, updated_at)
       VALUES (?, ?, 0, 2, 1, 1)`
    )
    session.run('r-deploys', 'ws-deploys')
    session.run('r-founders', 'ws-founders')
    extra(db)
    db.close()
    return file
  }

  it('purges a private channel nobody is in, opens every other channel, leaves a DM to its pair, and carries every survivor value for value', () => {
    const file = seedPre015()
    // What the rebuild must carry, read BEFORE 015 runs: every room but the doomed one, whole.
    const pre = new Database(file, { readonly: true })
    const survivorsBefore = roomRows(pre).filter((r) => r.slug !== 'founders')
    pre.close()

    // Opening runs 015, and the constructor's foreign_key_check must pass on what it left - the
    // rebuilt rooms table is the parent of messages, events, mentions, room_members and
    // agent_sessions, and the purge deleted by hand what no cascade would have taken with foreign
    // keys off. A dangling child row anywhere would have failed this line.
    const store = new ChatStore(file)
    try {
      // Snapshot first. The purge is the one branch that removes data, and this file is what
      // makes it reversible: `founders` and its five messages are all still in it, private.
      const bak = `${file}.pre-015-open-channels.bak`
      expect(existsSync(bak)).toBe(true)
      const snapshot = new Database(bak, { readonly: true })
      try {
        expect(count(snapshot, `SELECT COUNT(*) AS n FROM rooms WHERE slug = 'founders' AND visibility = 'private'`)).toBe(1)
        expect(count(snapshot, `SELECT COUNT(*) AS n FROM messages WHERE room_id = 'r-founders'`)).toBe(5)
        expect(count(snapshot, `SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '015-open-channels'`)).toBe(0)
      } finally {
        snapshot.close()
      }

      // The column is gone, and every survivor - the seeded general, the open channel, the DM -
      // came across value for value, minus the one cell that no longer exists.
      const columns = (store.db.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]).map((c) => c.name)
      expect(columns).not.toContain('visibility')
      expect(columns).toEqual(expect.arrayContaining(['id', 'slug', 'name', 'topic', 'kind', 'icon', 'head_at', 'created_by', 'created_at', 'updated_at']))
      expect(roomRows(store.db)).toEqual(survivorsBefore)
      expect(count(store.db, 'SELECT COUNT(*) AS n FROM rooms')).toBe(3)

      // THE PURGE: `founders` and everything that hung off it, table by table - the same set
      // deleteRoom takes. Nothing orphaned: not a message, a reply, an outbox row, a mention, a
      // reaction, an attachment row, a bell tombstone, or the agent's session row.
      expect(store.roomBySlug('founders')).toBeNull()
      expect(count(store.db, `SELECT COUNT(*) AS n FROM messages WHERE room_id = 'r-founders'`)).toBe(0)
      expect(count(store.db, `SELECT COUNT(*) AS n FROM events WHERE room_id = 'r-founders'`)).toBe(0)
      expect(count(store.db, `SELECT COUNT(*) AS n FROM mentions WHERE room_id = 'r-founders'`)).toBe(0)
      expect(count(store.db, `SELECT COUNT(*) AS n FROM message_reactions WHERE message_id LIKE 'f%'`)).toBe(0)
      expect(count(store.db, 'SELECT COUNT(*) AS n FROM attachments')).toBe(0)
      expect(count(store.db, `SELECT COUNT(*) AS n FROM agent_sessions WHERE room_id = 'r-founders'`)).toBe(0)
      expect(count(store.db, `SELECT COUNT(*) AS n FROM room_members WHERE room_id = 'r-founders'`)).toBe(0)
      expect(store.dismissedNotifications('carol').sort()).toEqual(['alert:x', 'mention:m2'])
      // And the totals say the purge took exactly the doomed room's rows and nobody else's.
      expect(count(store.db, 'SELECT COUNT(*) AS n FROM messages')).toBe(3)
      expect(count(store.db, 'SELECT COUNT(*) AS n FROM events')).toBe(3)
      expect(count(store.db, 'SELECT COUNT(*) AS n FROM mentions')).toBe(1)
      expect(count(store.db, 'SELECT COUNT(*) AS n FROM room_members')).toBe(4)
      expect(count(store.db, 'SELECT COUNT(*) AS n FROM agent_sessions')).toBe(1)

      // The survivors' children are exactly where they were, guard included.
      expect(store.history('deploys', 'bob').messages.map((m) => m.id)).toEqual(['m1', 'm2'])
      expect(store.eventsAfter(0, 'bob', 100).map((e) => e.payload.id)).toEqual(['m1', 'm2'])
      expect(headOf(store, 'deploys')).toBe(1_001)
      expect(store.history('deploys', 'bob').headAt).toBe(1_001)
      expect(store.mentionsFor('carol', 10).map((m) => m.messageId)).toEqual(['m2'])
      expect(store.agentSession('r-deploys')?.workerSessionId).toBe('ws-deploys')
      expect(store.roomBySlug('deploys')).toMatchObject({ name: 'Ships', topic: 'what shipped', icon: 'rocket', createdBy: 'alice', createdAt: 1 })

      // Every pointer survived as a pointer: the old member rows are read state now, nothing else.
      expect(store.roomsVisibleTo('carol').map((r) => [r.slug, r.lastReadAt, r.unread])).toEqual([
        ['deploys', 999, 2],
        ['dm:alice:carol', 0, 1],
        ['general', null, 0]
      ])
      expect(store.roomsVisibleTo('alice').find((r) => r.slug === 'deploys')).toMatchObject({ lastReadAt: 1_001, unread: 0 })
      // The bell carries the open channel for someone who was never in it, and never the DM.
      expect(store.recentMessagesFor('bob', 10).map((r) => r.roomSlug)).toEqual(['deploys', 'deploys'])

      // The DM is exactly as closed as it was: its pair, and nobody else.
      const dm = store.roomBySlug('dm:alice:carol')!
      expect(dm.kind).toBe('dm')
      expect(store.canReadRoom(dm.id, 'bob')).toBe(false)
      expect(() => store.history('dm:alice:carol', 'bob')).toThrow(ChatAccessError)
      expect(store.directPeer(dm.id, 'alice')).toBe('carol')
      expect(store.roomsVisibleTo('carol').find((r) => r.slug === 'dm:alice:carol')).toMatchObject({ peer: 'alice' })
      expect(store.history('dm:alice:carol', 'carol').messages.map((m) => m.id)).toEqual(['m3'])

      // The rebuilt table kept its constraints: the slug is still unique, and the kind is pinned
      // to the address in both directions.
      expect(() =>
        store.db
          .prepare(`INSERT INTO rooms (id, slug, kind, created_at, updated_at) VALUES ('dup', 'deploys', 'room', 1, 1)`)
          .run()
      ).toThrow(/UNIQUE constraint failed: rooms\.slug/)
      expect(() => store.db.prepare(`UPDATE rooms SET kind = 'room' WHERE id = 'r-dm'`).run()).toThrow(/CHECK constraint failed/)
      expect(() => store.db.prepare(`UPDATE rooms SET kind = 'dm' WHERE id = 'r-deploys'`).run()).toThrow(/CHECK constraint failed/)

      // And the live paths work on the migrated file: a first markRead by a stranger, a new room,
      // a new DM, a delete that cascades.
      expect(store.markRead('deploys', 'bob', 1_000)).toEqual({ lastReadAt: 1_000, unread: 1 })
      expect(store.createRoom({ slug: 'fresh' }, ALICE).kind).toBe('room')
      expect(store.openDirect(ALICE, 'bob').kind).toBe('dm')
      store.deleteRoom('deploys', 'bob')
      expect(count(store.db, `SELECT COUNT(*) AS n FROM messages WHERE room_id = 'r-deploys'`)).toBe(0)
    } finally {
      store.close()
    }
  })

  it('refuses a private channel that still has members - naming each, rolled back whole, rerunnable by either remedy', () => {
    const file = seedPre015((db) => {
      const room = db.prepare(
        `INSERT INTO rooms (id, slug, visibility, kind, head_at, created_by, created_at, updated_at)
         VALUES (?, ?, 'private', 'room', ?, 'alice', 1, 1)`
      )
      room.run('r-sekrit', 'sekrit', 4_001)
      room.run('r-board', 'board', 5_000)
      const member = db.prepare('INSERT INTO room_members (room_id, user_id, joined_at, last_read_at) VALUES (?, ?, 1, ?)')
      member.run('r-sekrit', 'alice', 4_001)
      member.run('r-sekrit', 'carol', 4_000)
      member.run('r-board', 'alice', 5_000)
      const message = db.prepare(
        `INSERT INTO messages (id, room_id, sender_id, sender_name, body, created_at) VALUES (?, ?, 'alice', 'alice', ?, ?)`
      )
      message.run('s1', 'r-sekrit', 'hush', 4_000)
      message.run('s2', 'r-sekrit', 'psst', 4_001)
      message.run('b1', 'r-board', 'board only', 5_000)
    })

    // Both slugs named, and nothing decided for either.
    expect(() => new ChatStore(file)).toThrow(/private channel\(s\) still have members - board, sekrit/)

    // Rolled back whole: no ledger row, the old column intact - and, the part that matters, the
    // purge branch did NOT run either: `founders` is still there with its five messages.
    const check = new Database(file)
    try {
      expect(check.prepare(`SELECT name FROM schema_migrations WHERE name = '015-open-channels'`).get()).toBeUndefined()
      expect(check.prepare(`SELECT visibility FROM rooms WHERE id = 'r-founders'`).get()).toEqual({ visibility: 'private' })
      expect(count(check, `SELECT COUNT(*) AS n FROM messages WHERE room_id = 'r-founders'`)).toBe(5)
      expect(count(check, 'SELECT COUNT(*) AS n FROM rooms')).toBe(6)
      expect(count(check, 'SELECT COUNT(*) AS n FROM attachments')).toBe(1)
      // The two remedies, one per room, against the still-intact old schema: publish sekrit,
      // hand board to the purge by removing its members.
      check.prepare(`UPDATE rooms SET visibility = 'public' WHERE id = 'r-sekrit'`).run()
      check.prepare(`DELETE FROM room_members WHERE room_id = 'r-board'`).run()
    } finally {
      check.close()
    }

    const store = new ChatStore(file)
    try {
      // sekrit is open with its history and its pointers - the operator said so; board and
      // founders are gone, with everything under them.
      expect(store.history('sekrit', 'bob').messages.map((m) => m.body)).toEqual(['hush', 'psst'])
      expect(store.roomsVisibleTo('carol').find((r) => r.slug === 'sekrit')).toMatchObject({ lastReadAt: 4_000, unread: 1 })
      expect(store.roomBySlug('board')).toBeNull()
      expect(store.roomBySlug('founders')).toBeNull()
      expect(count(store.db, `SELECT COUNT(*) AS n FROM messages WHERE room_id IN ('r-board', 'r-founders')`)).toBe(0)
      expect(count(store.db, 'SELECT COUNT(*) AS n FROM rooms')).toBe(4)
    } finally {
      store.close()
    }
  })

  it('refuses a row whose kind disagrees with its slug namespace, and stays rerunnable', () => {
    const file = seedPre015((db) => {
      // A DM-kinded row at a channel address: nothing in the store can write one, so a database
      // holding one has been hand-edited, and the migration must not guess which half is right.
      db.prepare(
        `INSERT INTO rooms (id, slug, visibility, kind, head_at, created_by, created_at, updated_at)
         VALUES ('r-odd', 'not-a-dm', 'private', 'dm', 0, 'alice', 1, 1)`
      ).run()
    })

    expect(() => new ChatStore(file)).toThrow(/slug namespace/)
    // Rolled back whole: no ledger row, the old column intact, the purge not run, so a repaired
    // file migrates cleanly.
    const check = new Database(file)
    try {
      expect(check.prepare(`SELECT name FROM schema_migrations WHERE name = '015-open-channels'`).get()).toBeUndefined()
      expect(check.prepare(`SELECT visibility FROM rooms WHERE id = 'r-founders'`).get()).toEqual({ visibility: 'private' })
      expect(count(check, `SELECT COUNT(*) AS n FROM messages WHERE room_id = 'r-founders'`)).toBe(5)
      check.prepare(`DELETE FROM rooms WHERE id = 'r-odd'`).run()
    } finally {
      check.close()
    }
    const store = new ChatStore(file)
    try {
      expect(store.roomBySlug('founders')).toBeNull()
      expect(count(store.db, 'SELECT COUNT(*) AS n FROM rooms')).toBe(3)
    } finally {
      store.close()
    }
  })
})
