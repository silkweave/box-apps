import { systemUserId } from '../../box-config.js'
import { describe, expect, it } from 'vitest'
import {
  AGENT_BUDGET_WINDOW_MS,
  AGENT_TURN_BUDGET,
  AgentMessageClaims,
  type AgentTriggerReads,
  agentDirectMessageFor,
  agentThreadReplyFor,
  agentTriggerFor,
  bodyAddressesAgent,
  buildAgentPrime,
  buildAgentSeed,
  buildAgentTurn,
  evaluateTurnBudget,
  parseAgentDirective,
  resolveAgentTrigger
} from './agent-trigger.js'
import type { ChatEphemeralEvent, ChatEvent, ChatMessage } from './types.js'

const message = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  roomId: 'r1',
  senderId: 'alice',
  senderName: 'Alice',
  body: '@nova what is up',
  createdAt: 1000,
  editedAt: null,
  ...over
})

const mention = (over: Partial<ChatEphemeralEvent> = {}): ChatEphemeralEvent => ({
  ephemeral: true,
  type: 'mention.created',
  roomId: 'r1',
  userId: systemUserId(),
  payload: message(),
  at: 1000,
  ...over
})

describe('agentTriggerFor', () => {
  it('accepts a mention of the agent and carries the ask', () => {
    const trigger = agentTriggerFor(mention())
    expect(trigger).toEqual({
      roomId: 'r1',
      messageId: 'm1',
      senderId: 'alice',
      senderName: 'Alice',
      body: '@nova what is up',
      at: 1000,
      // A top-level mention starts a thread ON the question, so the answer and every follow-up
      // collapse into one unit.
      threadRootId: 'm1',
      via: 'mention'
    })
  })

  it('threads the answer under the ask when the mention was itself written in a thread', () => {
    const trigger = agentTriggerFor(mention({ payload: message({ parentId: 'root1' }) }))
    expect(trigger?.threadRootId).toBe('root1')
  })

  it('ignores an outbox event - only the mention ephemeral is an ask', () => {
    const event: ChatEvent = { id: 1, roomId: 'r1', type: 'message.created', payload: message(), at: 1000 }
    expect(agentTriggerFor(event)).toBeNull()
  })

  it('ignores ephemerals aimed at somebody else', () => {
    expect(agentTriggerFor(mention({ userId: 'alice' }))).toBeNull()
    expect(agentTriggerFor(mention({ type: 'message.edited' }))).toBeNull()
  })

  // THE LOOP GUARD. The agent can post through chat-post, and that output naming @nova would
  // otherwise mint a mention row and re-trigger the agent on its own words, forever.
  it('refuses a mention the agent itself authored', () => {
    expect(agentTriggerFor(mention({ payload: message({ senderId: systemUserId() }) }))).toBeNull()
  })

  it('refuses a payload-less mention rather than inventing an empty ask', () => {
    expect(agentTriggerFor(mention({ payload: null }))).toBeNull()
  })
})

describe('parseAgentDirective', () => {
  it('strips the handle and keeps the ask', () => {
    expect(parseAgentDirective('@nova what is the star count?')).toEqual({
      kind: 'turn',
      text: 'what is the star count?'
    })
  })

  it('strips a trailing or mid-sentence handle too', () => {
    expect(parseAgentDirective('what is the star count, @nova')).toEqual({
      kind: 'turn',
      text: 'what is the star count,'
    })
  })

  it('reads a bare stop or cancel as an interrupt, case- and punctuation-insensitively', () => {
    for (const body of ['@nova stop', '@nova STOP', '@nova cancel', '@nova Cancel.', '@nova stop!']) {
      expect(parseAgentDirective(body), body).toEqual({ kind: 'interrupt' })
    }
  })

  // The grammar stays tiny on purpose: "stop the nightly ingest" is a REQUEST, not a cancel.
  it('does not read a stop-shaped request as an interrupt', () => {
    expect(parseAgentDirective('@nova stop the nightly ingest schedule')).toEqual({
      kind: 'turn',
      text: 'stop the nightly ingest schedule'
    })
    expect(parseAgentDirective('@nova cancel the publish task')).toEqual({
      kind: 'turn',
      text: 'cancel the publish task'
    })
  })

  it('leaves an email address alone - it was never a mention', () => {
    expect(parseAgentDirective('mail me at foo@nova.example')).toEqual({
      kind: 'turn',
      text: 'mail me at foo@nova.example'
    })
  })

  it('yields an empty ask for a bare mention', () => {
    expect(parseAgentDirective('@nova')).toEqual({ kind: 'turn', text: '' })
  })
})

describe('evaluateTurnBudget', () => {
  it('allows a first turn when the room has no row yet', () => {
    const verdict = evaluateTurnBudget(null, 1_000)
    expect(verdict.allowed).toBe(true)
    expect(verdict.next).toEqual({ turnsThisHour: 1, windowStartedAt: 1_000 })
  })

  it('counts up inside one window without moving its start', () => {
    const verdict = evaluateTurnBudget({ turnsThisHour: 3, windowStartedAt: 1_000 }, 2_000)
    expect(verdict.next).toEqual({ turnsThisHour: 4, windowStartedAt: 1_000 })
  })

  it('refuses the turn past the budget', () => {
    const at = { turnsThisHour: AGENT_TURN_BUDGET, windowStartedAt: 1_000 }
    const verdict = evaluateTurnBudget(at, 2_000)
    expect(verdict.allowed).toBe(false)
    expect(verdict.limit).toBe(AGENT_TURN_BUDGET)
  })

  // A refusal that restarted the clock would let a caller hold the budget open by continuing
  // to ask - the exact behavior of whoever is being rate-limited.
  it('does not restart the window on a refusal', () => {
    const at = { turnsThisHour: AGENT_TURN_BUDGET, windowStartedAt: 1_000 }
    expect(evaluateTurnBudget(at, 2_000).next).toEqual(at)
  })

  it('rolls the window over once it has expired, and that turn is allowed', () => {
    const at = { turnsThisHour: AGENT_TURN_BUDGET, windowStartedAt: 1_000 }
    const later = 1_000 + AGENT_BUDGET_WINDOW_MS
    const verdict = evaluateTurnBudget(at, later)
    expect(verdict.allowed).toBe(true)
    expect(verdict.next).toEqual({ turnsThisHour: 1, windowStartedAt: later })
  })
})

describe('agentThreadReplyFor', () => {
  const created = (over: Partial<ChatMessage> = {}): ChatEvent => ({
    id: 1,
    roomId: 'r1',
    type: 'message.created',
    payload: message({ body: 'and what about npm?', ...over }),
    at: 1000
  })

  it('accepts a reply inside a thread, with no mention at all', () => {
    const trigger = agentThreadReplyFor(created({ parentId: 'root1' }))
    expect(trigger).toEqual({
      roomId: 'r1',
      messageId: 'm1',
      senderId: 'alice',
      senderName: 'Alice',
      body: 'and what about npm?',
      at: 1000,
      threadRootId: 'root1',
      via: 'thread-reply'
    })
  })

  it('ignores a root message - being in the room is not being asked', () => {
    expect(agentThreadReplyFor(created())).toBeNull()
  })

  it("ignores the agent's own replies (the loop guard)", () => {
    expect(agentThreadReplyFor(created({ parentId: 'root1', senderId: systemUserId() }))).toBeNull()
  })

  it('ignores ephemerals and non-creation events', () => {
    expect(agentThreadReplyFor(mention())).toBeNull()
    expect(agentThreadReplyFor({ ...created({ parentId: 'root1' }), type: 'message.edited' })).toBeNull()
  })
})

/** A `message.created` outbox frame for one message. */
const created = (payload: ChatMessage, roomId = payload.roomId): ChatEvent => ({
  id: 1,
  roomId,
  type: 'message.created',
  payload,
  at: payload.createdAt
})

describe('agentDirectMessageFor (the DM door, pure half)', () => {
  it('accepts a plain top-level message from a human and lands the answer at TOP LEVEL', () => {
    const trigger = agentDirectMessageFor(created(message({ body: 'how many stars?' })))
    expect(trigger).toEqual({
      roomId: 'r1',
      messageId: 'm1',
      senderId: 'alice',
      senderName: 'Alice',
      body: 'how many stars?',
      at: 1000,
      // The room IS the conversation: no thread on the question, unlike a mention.
      threadRootId: null,
      via: 'dm'
    })
  })

  it('threads the answer only when the human was already inside a thread', () => {
    expect(agentDirectMessageFor(created(message({ parentId: 'root1' })))?.threadRootId).toBe('root1')
  })

  // THE LOOP GUARD, and the door where it matters most: the agent's placeholder and cards are
  // ordinary posts into the very room this door watches.
  it("refuses the agent's own message, from either event class", () => {
    const own = message({ senderId: systemUserId(), senderName: 'nova', body: '…' })
    expect(agentDirectMessageFor(created(own))).toBeNull()
    expect(agentDirectMessageFor(mention({ payload: own }))).toBeNull()
  })

  // Order independence: whichever of the two frames for one message lands first must produce the
  // SAME trigger, or the answer's layout would depend on the store's emission order.
  it('yields the identical trigger from the outbox frame and from the mention ephemeral', () => {
    const asked = message({ body: '@nova how many stars?' })
    expect(agentDirectMessageFor(mention({ payload: asked }))).toEqual(agentDirectMessageFor(created(asked)))
  })

  it('ignores ephemerals that are not a mention of the agent, and non-creation outbox types', () => {
    expect(agentDirectMessageFor(mention({ userId: 'carol' }))).toBeNull()
    expect(agentDirectMessageFor(mention({ type: 'message.edited' }))).toBeNull()
    expect(agentDirectMessageFor(mention({ payload: null }))).toBeNull()
    expect(agentDirectMessageFor({ ...created(message()), type: 'message.deleted' })).toBeNull()
  })

  // Its streamed checkpoints never reach this door at all: they are `message.edited` ephemerals.
  it('never fires on an edit, which is what a streaming checkpoint is on the bus', () => {
    const checkpoint = mention({
      type: 'message.edited',
      userId: null,
      payload: message({ senderId: systemUserId(), body: 'partial answer' })
    })
    expect(agentDirectMessageFor(checkpoint)).toBeNull()
  })
})

/** A fake store: `dm` names the peer `directPeer` reports (null = a named room), `roots` the
 *  messages `message()` can find, `agentIn` the threads `threadHasSender` says nova has spoken in. */
const reads = (over: { dm?: string | null; roots?: ChatMessage[]; agentIn?: string[] } = {}): AgentTriggerReads => ({
  directPeer: () => over.dm ?? null,
  message: (_roomId, id) => over.roots?.find((m) => m.id === id) ?? null,
  threadHasSender: (rootId, senderId) => senderId === systemUserId() && (over.agentIn ?? []).includes(rootId)
})

describe('resolveAgentTrigger (the doors, ordered, against the store)', () => {
  it('a plain message in a DM whose other member is the agent triggers a turn', () => {
    const trigger = resolveAgentTrigger(created(message({ body: 'hi' })), reads({ dm: systemUserId() }))
    expect(trigger).toMatchObject({ via: 'dm', threadRootId: null, body: 'hi' })
  })

  // The pure candidate fires everywhere; the store is what makes it a DM door.
  it('a plain message in a NAMED channel does not trigger without a mention', () => {
    expect(resolveAgentTrigger(created(message({ body: 'hi' })), reads({ dm: null }))).toBeNull()
  })

  it("a plain message in somebody else's DM does not trigger - the peer is not the agent", () => {
    expect(resolveAgentTrigger(created(message({ body: 'hi' })), reads({ dm: 'carol' }))).toBeNull()
  })

  it("the agent's own message in the DM never triggers (the loop guard survives the store check)", () => {
    const own = message({ senderId: systemUserId(), body: '…' })
    expect(resolveAgentTrigger(created(own), reads({ dm: 'alice' }))).toBeNull()
    expect(resolveAgentTrigger(created(own), reads({ dm: systemUserId() }))).toBeNull()
  })

  it('a mention in a named channel still comes in by the mention door, threaded on the question', () => {
    expect(resolveAgentTrigger(mention(), reads({ dm: null }))).toMatchObject({ via: 'mention', threadRootId: 'm1' })
  })

  // In the DM the DM rule dominates: a mention there is redundant, not a different layout.
  it('a mention INSIDE a DM with the agent comes in by the DM door, at top level', () => {
    expect(resolveAgentTrigger(mention(), reads({ dm: systemUserId() }))).toMatchObject({
      via: 'dm',
      threadRootId: null
    })
  })

  it('a reply in a DM with the agent is a DM ask in that thread, whoever the root addressed', () => {
    const reply = created(message({ parentId: 'root1', body: 'and npm?' }))
    // No root on file and nova has not spoken in the thread: the thread-reply door would refuse.
    expect(resolveAgentTrigger(reply, reads({ dm: systemUserId() }))).toMatchObject({ via: 'dm', threadRootId: 'root1' })
  })

  it("a reply in a named room reaches the agent only when the thread is the agent's", () => {
    const reply = created(message({ parentId: 'root1', body: 'and npm?' }))
    expect(resolveAgentTrigger(reply, reads())).toBeNull()
    expect(resolveAgentTrigger(reply, reads({ agentIn: ['root1'] }))).toMatchObject({ via: 'thread-reply' })
    expect(
      resolveAgentTrigger(reply, reads({ roots: [message({ id: 'root1', body: '@nova deploy?' })] }))
    ).toMatchObject({ via: 'thread-reply', threadRootId: 'root1' })
  })

  // A DM between two HUMANS the agent was asked into (the store's guest pass, 2026-09-04): the
  // sender's peer is the other human, so the DM door declines and the ask arrives by the mention
  // door, threaded on the question - the DM door must never widen to a room two people are using
  // for their own conversation.
  it('a mention in a DM between two humans comes in by the MENTION door, threaded on the ask', () => {
    expect(resolveAgentTrigger(mention(), reads({ dm: 'carol' }))).toMatchObject({ via: 'mention', threadRootId: 'm1' })
    // The outbox frame for the same message is not an ask on its own: only the summons is.
    expect(resolveAgentTrigger(created(message()), reads({ dm: 'carol' }))).toBeNull()
    // A plain message between the two of them is nobody's ask.
    expect(resolveAgentTrigger(created(message({ body: 'just between us' })), reads({ dm: 'carol' }))).toBeNull()
    // A follow-up inside the thread the ask started still reaches the agent, by the thread door.
    const reply = created(message({ id: 'm2', parentId: 'm1', body: 'and npm?', senderId: 'carol', senderName: 'Carol' }))
    expect(resolveAgentTrigger(reply, reads({ dm: 'alice', roots: [message()] }))).toMatchObject({
      via: 'thread-reply',
      threadRootId: 'm1'
    })
  })
})

describe('AgentMessageClaims (one message, one turn)', () => {
  it('admits an id once', () => {
    const claims = new AgentMessageClaims()
    expect(claims.claim('m1')).toBe(true)
    expect(claims.claim('m1')).toBe(false)
    expect(claims.claim('m2')).toBe(true)
  })

  it('forgets the oldest claim past the window, so the set cannot grow forever', () => {
    const claims = new AgentMessageClaims(3)
    for (const id of ['a', 'b', 'c', 'd']) expect(claims.claim(id)).toBe(true)
    // 'a' was evicted when 'd' landed; the three newest are still held.
    expect(claims.claim('a')).toBe(true)
    expect(claims.claim('d')).toBe(false)
  })

  // The double fire, end to end through the doors: a DM message that also writes "@nova" arrives
  // as `message.created` and as `mention.created`. `ChatStore.post` emits them in that order
  // today, and this pins that the outcome does not depend on it - one turn, DM-shaped, either way.
  it('a message that both mentions nova and is a DM to nova resolves to ONE turn, whichever frame is first', () => {
    const asked = message({ body: '@nova how many stars?' })
    const frames = [created(asked), mention({ payload: asked })]
    const store = reads({ dm: systemUserId() })
    for (const order of [frames, [...frames].reverse()]) {
      const claims = new AgentMessageClaims()
      const turns = order
        .map((frame) => resolveAgentTrigger(frame, store))
        .filter((trigger) => trigger !== null && claims.claim(trigger.messageId))
      expect(turns).toHaveLength(1)
      expect(turns[0]).toMatchObject({ messageId: 'm1', via: 'dm', threadRootId: null })
    }
  })

  // The same property for the older pair of doors, which is where the claim window came from.
  it('a reply in the agent\'s thread that also writes "@nova" resolves to ONE turn', () => {
    const asked = message({ parentId: 'root1', body: '@nova and npm?' })
    const store = reads({ agentIn: ['root1'] })
    const claims = new AgentMessageClaims()
    const turns = [created(asked), mention({ payload: asked })]
      .map((frame) => resolveAgentTrigger(frame, store))
      .filter((trigger) => trigger !== null && claims.claim(trigger.messageId))
    expect(turns).toHaveLength(1)
  })
})

describe('bodyAddressesAgent', () => {
  it('is true for a root that asks the agent something - the thread inherits the address', () => {
    expect(bodyAddressesAgent('@nova how many stars do we have?')).toBe(true)
    expect(bodyAddressesAgent('hey @Nova, can you check')).toBe(true)
  })

  it('is false for a body that merely talks about it, or names somebody else', () => {
    expect(bodyAddressesAgent('@carol can you ask nova later')).toBe(false)
    expect(bodyAddressesAgent('mail nova@example.com about it')).toBe(false)
    // A quotation, not a ping - the same rule the store used to decide the mention was real.
    expect(bodyAddressesAgent('the snippet says `@nova approve`')).toBe(false)
  })
})

const seedTrigger = {
  roomId: 'r1',
  messageId: 'm2',
  senderId: 'alice',
  senderName: 'Alice',
  body: '@nova how many stars?',
  at: 2000,
  threadRootId: 'm2',
  via: 'mention' as const
}

describe('buildAgentPrime', () => {
  const prime = (topic: string | null = 'the team room'): string =>
    buildAgentPrime({ roomSlug: 'general', roomTopic: topic })

  it('names the room and the topic', () => {
    expect(prime()).toContain('#general')
    expect(prime()).toContain('the team room')
  })

  it('carries the standing rules', () => {
    const text = prime()
    expect(text).toContain('not limited to it')
    expect(text).toContain('Do NOT call the chat-post tool')
    expect(text).toContain('Never write "@nova"')
    expect(text).toContain('untrusted input')
  })

  // The whole point of the split: nothing that changes per turn may live in the half that is sent
  // once. `actor` names a person and the ask names a question - both belong to `buildAgentTurn`.
  it('carries NOTHING about a specific ask or asker', () => {
    const text = prime()
    expect(text).not.toContain('actor = "alice"')
    expect(text).not.toContain('is asking you')
  })

  // A DM's slug is an address nobody types; naming it as a channel would hand the model a room
  // name to repeat back, and "several people share this room" would be false.
  it('describes a DM as a conversation with one person, never by its slug', () => {
    const text = buildAgentPrime({
      roomSlug: 'dm:nova:alice',
      roomTopic: null,
      directPeer: { id: 'alice', name: 'Alice' }
    })
    expect(text).toContain('direct-message conversation with Alice (alice)')
    expect(text).not.toContain('#dm:nova:alice')
    expect(text).not.toContain('Several people share this room')
    expect(text).toContain('nobody needs to write your name')
    // The standing rules are the same rules.
    expect(text).toContain('Do NOT call the chat-post tool')
    expect(text).toContain('Never write "@nova"')
    expect(text).toContain('untrusted input')
  })

  // The third shape (2026-09-04): a DM between two people the agent was mentioned into. Neither
  // "with X alone" nor "several people share this room" is true there, and the slug belongs to
  // the two of them.
  it('describes a DM it is a GUEST in by its two people, threaded, never by its slug', () => {
    const text = buildAgentPrime({
      roomSlug: 'dm:alice:carol',
      roomTopic: null,
      directHosts: [
        { id: 'alice', name: 'Alice' },
        { id: 'carol', name: 'Carol' }
      ]
    })
    expect(text).toContain('a guest in a private direct-message conversation between Alice (alice) and Carol (carol)')
    expect(text).not.toContain('dm:alice:carol')
    expect(text).not.toContain('Several people share this room')
    expect(text).not.toContain('nobody needs to write your name')
    // Answers thread on the ask there, like a named room - and most of the room is not for nova.
    expect(text).toContain('in the THREAD the ask belongs to')
    expect(text).toContain('only a message that names you')
    expect(text).toContain('Do NOT call the chat-post tool')
    expect(text).toContain('Never write "@nova"')
  })
})

describe('buildAgentTurn', () => {
  const turn = (over: Partial<Parameters<typeof buildAgentTurn>[0]> = {}): string =>
    buildAgentTurn({ roomSlug: 'general', recent: [], trigger: seedTrigger, ask: 'how many stars?', ...over })

  it('names who is asking and what they asked', () => {
    const text = turn()
    expect(text).toContain('Alice (alice) is asking you:')
    expect(text).toContain('how many stars?')
  })

  // The rule whose absence is SILENT: actor defaults to nova and is not validated, so a turn that
  // forgets it stamps every audit trail with the service account and nothing errors. It is
  // per-turn and not per-session because the asker changes.
  it('instructs the agent to stamp the asking human as actor, every turn', () => {
    expect(turn()).toContain('actor = "alice"')
    expect(turn({ trigger: { ...seedTrigger, senderId: 'carol', senderName: 'Carol' } })).toContain('actor = "carol"')
  })

  // The seed carries the ask in full; carrying it twice invites the model to answer it twice.
  it('excludes the triggering message from the history tail', () => {
    const text = turn({
      recent: [
        message({ id: 'm1', body: 'earlier chatter', senderName: 'Carol', senderId: 'carol' }),
        message({ id: 'm2', body: '@nova how many stars?' })
      ]
    })
    expect(text).toContain('earlier chatter')
    expect(text.match(/how many stars\?/g)).toHaveLength(1)
  })

  it('frames the tail as what is NEW rather than as the room', () => {
    const text = turn({ recent: [message({ id: 'm1', body: 'earlier chatter' })] })
    expect(text).toContain('New messages since you last looked')
  })

  // One warm session serves a whole ROOM, so a follow-up must say which conversation it continues
  // or turn N+1 in thread B reads as a continuation of thread A.
  it('names the thread a follow-up belongs to', () => {
    const text = turn({
      trigger: { ...seedTrigger, via: 'thread-reply', threadRootId: 'm0' },
      threadRoot: message({ id: 'm0', body: 'how do I deploy this?' })
    })
    expect(text).toContain('how do I deploy this?')
    expect(text).toContain('follow-up in the thread')
  })

  it('says a top-level mention starts a new thread', () => {
    expect(turn()).toContain('starts a new thread')
  })

  // A DM ask is not a mention and must not be framed as one; at top level the answer stays in the
  // conversation, and inside a thread it names the thread like a follow-up does.
  it('frames a DM ask as written directly to the agent, top level or in its thread', () => {
    const dm = { ...seedTrigger, via: 'dm' as const, threadRootId: null, body: 'how many stars?' }
    const top = turn({ trigger: dm })
    expect(top).toContain('Alice wrote this to you directly')
    expect(top).toContain('not in a thread')
    expect(top).not.toContain('mentioned')
    const threaded = turn({
      trigger: { ...dm, threadRootId: 'm0' },
      threadRoot: message({ id: 'm0', body: 'about the deploy' })
    })
    expect(threaded).toContain('inside the thread that began: "about the deploy"')
    expect(threaded).not.toContain('mentioned')
  })

  // A guest DM (2026-09-04) keeps the mention framing - the ask DID come by the mention door and
  // the answer DOES start a thread - but the room is never named by its slug.
  it('never names a DM it is a guest in by its slug, for a mention or a thread follow-up', () => {
    const asked = turn({ roomSlug: 'dm:alice:carol', directGuest: true })
    expect(asked).toContain('You were mentioned in this conversation. This starts a new thread')
    expect(asked).not.toContain('dm:alice:carol')
    const follow = turn({
      roomSlug: 'dm:alice:carol',
      directGuest: true,
      trigger: { ...seedTrigger, via: 'thread-reply', threadRootId: 'm2' }
    })
    expect(follow).toContain('a thread of yours in this conversation')
    expect(follow).not.toContain('dm:alice:carol')
    // Without the flag the slug is the room's name, as it always was.
    expect(turn({ roomSlug: 'dm:alice:carol' })).toContain('You were mentioned in #dm:alice:carol')
  })

  it('handles a bare mention by telling the agent to ask what is needed', () => {
    expect(turn({ ask: '' })).toContain('ask what they need')
  })
})

describe('buildAgentSeed', () => {
  const seed = (recent: ChatMessage[] = []): string =>
    buildAgentSeed({
      roomSlug: 'general',
      roomTopic: 'the team room',
      recent,
      trigger: seedTrigger,
      ask: 'how many stars?'
    })

  // A fresh session gets both halves, in that order.
  it('is the prime half followed by the turn half', () => {
    const text = seed()
    expect(text).toContain('You are Nova')
    expect(text).toContain('Alice (alice) is asking you:')
    expect(text.indexOf('You are Nova')).toBeLessThan(text.indexOf('is asking you'))
  })
})
