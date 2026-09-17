import { WorkerDeckClient, hostAuth, type SessionHandle } from '@workerdeck/client'
import type { ContentBlock, PermissionMode, PermissionRequest, SessionEvent } from '@workerdeck/protocol'
import { AgentTurnText, AGENT_SEED_HISTORY, AGENT_SESSION_APP, systemUserId, AgentActivityTracker, AgentMessageClaims, APPROVAL_CARDS_PER_TURN, APPROVAL_HOLD_MS, APPROVAL_TIMEOUT_MS, type AgentActivitySignal, type AgentDirective, agentProfileFor, approvalCapNotice, approvalCardBody, buildAgentPrime, buildAgentTurn, chatStore, emitChatEvent, evaluateTurnBudget, onChatEvent, parseAgentDirective, resolveAgentTrigger, resolvedCardBody, resolvePrincipalById, repoRoot, type AgentActivityFrame, type AgentTrigger, type ApprovalOutcome, type ChatAgentTurnMeta, type ChatApprovalMeta, type ChatBusEvent, type ChatMessage } from '@silkweave/box-core'
import { postAsAgent, writeCard } from './chat/cards.js'
import { verifyLoopback } from '../../agent/loopback-guard.js'
import { decideChatOp, hasChatOp } from './chat/chat-op-approvals.js'
import { agentWorkerUrl, proxyKey } from '../../agent/workerdeck.host.js'

/**
 * `@nova` answers in the channel (chat Track 15).
 *
 * Mention `nova` in a room, and this module runs an agent turn on the sibling workerdeck service
 * and writes the answer back into that same room as a message from nova.
 *
 * ## What this is NOT
 *
 * It is not the agent SIDEBAR. That one is per-USER and per-TASK, browser-initiated through the
 * `/agent` reverse proxy, with a human watching a transcript in `SessionPanel`. This is
 * per-CHANNEL and SERVER-owned: the server holds the `SessionHandle`, the channel holds the
 * conversation, and anyone in the room is the audience. They coexist and share nothing but the
 * worker process - a person can run their own sidebar session while nova works in #general.
 *
 * ## Why a bus subscriber and not a call from the chat controller
 *
 * The exact reasoning that put `notifications/delivery.ts` on the same bus, and this file is its
 * twin. `ChatStore.post` commits message + mentions + outbox in ONE transaction and publishes
 * strictly AFTER it, refusing to run inside an enclosing one - so a subscriber is guaranteed to be
 * reacting to something durably true. Starting an agent turn from inside the write path would let
 * a worker's REST latency hold a SQLite write transaction open, which is the one thing a
 * single-writer file database must never do.
 *
 * ## Why its own feature flag
 *
 * `CHAT_AGENT_ENABLED` rather than riding `AUTOMATION_ENABLED`. The risk profile is identical (a
 * seeded dev holds production credentials, so an armed chat agent there would run real turns doing
 * real MCP writes off test messages), so the same opt-in-everywhere rule applies. But tying it to
 * the scheduler's flag would mean "test the chat agent on dev" also arms every production
 * schedule. Two flags, same default-off story. LEAVE IT UNSET ON ANY DEV MACHINE unless you are
 * deliberately testing against a worker you own.
 *
 * ## The safety posture, stated once
 *
 * MCP authenticates as the configured system principal, an ADMIN by default. Anyone who can
 * address the agent can prompt that principal's MCP surface, including credential/configuration
 * mutations and service restart. CHAT_AGENT_DISALLOWED_TOOLS is empty; no replacement role
 * boundary sits underneath. The agent is off unless explicitly armed. Set agent.role to member
 * in config/box.json to restore the role boundary. user-invite-reveal has no MCP surface, so
 * permanent credentials are not returned by that tool to a model or left
 * in the transcript forever. nova's chat reads stay store-enforced by `canReadRoom`, and
 * `CHAT_AGENT_DISALLOWED_TOOLS` is the floor beneath the approvals. Chat bodies are untrusted input
 * to an LLM loop - bounded, not solved - but since 2026-09-13 the credential that loop holds cannot
 * reach the controls. That is the single most important consequence of having a second tier.
 */

/** Armed only when the flag is exactly '1' - same grammar as AUTOMATION_ENABLED, same reason. */
const chatAgentEnabled = (): boolean => process.env.CHAT_AGENT_ENABLED?.trim() === '1'

/** The engine nova's own profile is declared under. One identity, one profile - see Rollout. */
const AGENT_ENGINE = 'codex'

/**
 * The permission posture for a chat turn, decided 2026-09-01: READS are free, WRITES are approved.
 *
 * `default` maps (in the codex runner) to sandbox `read-only` + `GRANULAR_ASK` + approvals reviewer
 * `user`. The two wider modes are NOT what they look like. `auto` keeps the ask policy but sets the
 * reviewer to `auto_review` - the MODEL adjudicates its own requests, so an in-channel approval
 * surface would almost never be consulted. `acceptEdits` keeps a human reviewer but grants a
 * `workspace-write` sandbox over `cwd`, and cwd here is the CHECKOUT: on production that tree holds
 * `data/config/credentials.json`, `data.db`, `.env` and the running server's own source, and the
 * deploy contract is a fast-forward `git pull` that a local write breaks. Widening belongs with a
 * scratch cwd, not with a wider sandbox on the live checkout.
 */
const CHAT_AGENT_PERMISSION_MODE: PermissionMode = 'default'

/** Fast and affordable; chat answers are latency-sensitive and rarely need the frontier model. */
const CHAT_AGENT_MODEL = 'gpt-5.6-luna'

/** Luna offers low|medium|high|xhigh - and NO `ultra`, unlike sol/terra. Never hardcode `ultra`. */
const CHAT_AGENT_REASONING_EFFORT = 'medium'

/**
 * Close a room's session after this long without a turn.
 *
 * A session per room with no expiry grows its context forever and leaks a worker session (and its
 * engine process) on every server restart. The design already decided the part that makes an idle TTL
 * cheap: THE CHAT IS THE MEMORY. Every turn is seeded from the room's recent history, and
 * `chat-history` over MCP reaches further back, so a fresh session loses nothing that mattered - it
 * costs one seed's worth of tokens, which is exactly the trade session RESUMPTION was rejected for.
 * Bounding the lifetime is therefore strictly better than extending it.
 */
const SESSION_IDLE_TTL_MS = 60 * 60_000

/**
 * Interrupt a turn that has produced NO event for this long.
 *
 * Not a turn-duration cap: a long legitimate turn keeps emitting, and every event resets this. It
 * catches the wedge - a worker that stopped talking - which today holds a room's placeholder open
 * until the session errors or the server restarts. Suspended while a turn is legitimately blocked on an
 * approval, which is a wait with its own (worker-side) timeout.
 */
const TURN_SILENCE_LIMIT_MS = 10 * 60_000

/**
 * The hard floor beneath channel approvals: tools no click in chat may ever unlock.
 *
 * Empty ON PURPOSE, and the emptiness is the decision rather than an oversight. The reach a person
 * grants by clicking Approve - a command, a file write, as nova, in the checkout - IS the feature,
 * and a floor guessed before anyone has watched a real turn ask for anything would fence off work
 * the team wants while missing whatever actually turns out to be dangerous. What goes here is
 * shaped by real usage: a tool that gets approved reflexively, or one whose blast radius nobody
 * evaluating a one-line card can judge. The SEAM exists now so adding a name later is one line and
 * no redesign; `buildRunnerConfig` on the worker side is the second half of the same floor.
 *
 * Omitted from the create when empty - never send a field with nothing in it to an engine that may
 * not declare it.
 */
const CHAT_AGENT_DISALLOWED_TOOLS: readonly string[] = []

/**
 * How AskUserQuestion is treated. STILL `deny`, and this is the one piece of Track 19 that did
 * NOT flip with the rest.
 *
 * The plan paired the two, on the reasoning that a question rides the identical
 * `permission_requested` surface and answers ride back as `updatedInput.answers`. True on the wire,
 * and not enough: an approval card carries a BINARY decision, and approving a question with no
 * answers attached hands the model an empty choice - strictly worse than the current refusal,
 * which at least tells it to decide for itself. Flipping this needs an answer FORM (the questions,
 * their options, one selection per question) in the card and in the decision mutation, which is a
 * surface of its own rather than a flag.
 *
 * Note the hold window below already absorbs this mode's cost: `deny` emits a
 * `permission_requested` + `permission_resolved{ resolvedBy: 'policy' }` pair for every question,
 * and nothing that settles inside the window ever reaches the room.
 */
const CHAT_AGENT_QUESTION_BEHAVIOR = 'deny' as const

/** The optional per-session niceties, resolved against the profile rather than assumed. */
type SessionTuning = { model?: string; reasoningEffort?: string }

/** Cached per process, and only ever populated from a SUCCESSFUL probe (see `sessionTuning`). */
let tuningCache: { profile: string; tuning: SessionTuning } | null = null

/**
 * Resolve the optional niceties against what the profile actually declares.
 *
 * The worker 400s a field the engine forswears (docs/SERVER.md), so these are gated rather than
 * assumed - and the failure rule is OMIT, NEVER FAIL: a missing model or effort degrades to the
 * profile default, because "no answer at all because we insisted on Luna" is the wrong trade. A
 * failed probe is not cached, so a transient worker blip does not pin us to the defaults forever.
 */
async function sessionTuning(client: WorkerDeckClient, profile: string): Promise<SessionTuning> {
  if (tuningCache !== null && tuningCache.profile === profile) return tuningCache.tuning
  try {
    const { profiles } = await client.listProfiles()
    const info = profiles.find((p) => p.name === profile)
    const tuning: SessionTuning = {}
    const model = info?.models?.find((m) => m.value === CHAT_AGENT_MODEL)
    if (model !== undefined) tuning.model = model.value
    // Per-model efforts win: the catalog lists them per model, and they differ between models.
    const efforts = model?.reasoningEfforts ?? info?.capabilities?.reasoningEfforts
    if (efforts?.includes(CHAT_AGENT_REASONING_EFFORT) === true) {
      tuning.reasoningEffort = CHAT_AGENT_REASONING_EFFORT
    }
    tuningCache = { profile, tuning }
    return tuning
  } catch {
    return {}
  }
}

/** A room's live conversation with the agent. The DURABLE half is the `agent_sessions` row. */
interface RoomAgent {
  handle: SessionHandle
  workerSessionId: string
  /** The room's slug, captured once - event handlers are sync and cannot go look it up. */
  roomSlug: string
  /** Non-null exactly while a turn is in flight. */
  turn: TurnState | null
  /**
   * Whether this WORKER SESSION has been handed the standing instructions (`buildAgentPrime`).
   *
   * Keyed on the session and not the room, by living on the object `ensureSession` creates: a
   * deleted agent message DROPS the room's session to clear its context, and a restart ends every
   * session, so a room-keyed flag would send a bare follow-up into a worker that has never been
   * told who it is.
   */
  primed: boolean
  /**
   * The `createdAt` of the newest message this session has already been shown, or 0.
   *
   * Replaces the blind ten-message tail on every turn with "what is new since you last looked".
   * Strictly less data AND no gap: messages other people wrote between nova's turns used to be
   * swept up incidentally by the tail re-send, and are now sent exactly once. Resets with the
   * session, because a fresh worker knows nothing.
   */
  seededThrough: number
  /** Detaches the event listeners when the handle is dropped. */
  stopListening: () => void
  /**
   * Whether the attach socket is currently OPEN.
   *
   * Tracked because `approve`/`deny`/`send` do not throw on a dead socket - the client buffers the
   * frame into an outbox and retries the reconnect forever, silently. Without this, a decision
   * taken while the worker is down would rewrite the card to "**Approved** by Alice Strand"
   * for a command that will never run: a durable audit record asserting a grant that had no
   * effect, which is the single worst thing this surface can do.
   *
   * Starts false and is set by the handle's own `connectionChange`. Nothing can be pending before
   * the first open anyway - a permission request arrives OVER this socket.
   */
  connected: boolean
  /** Retires the session after `SESSION_IDLE_TTL_MS` with no turn. Re-armed on every settle. */
  idleTimer: ReturnType<typeof setTimeout> | null
  /** Fires when a turn goes quiet for `TURN_SILENCE_LIMIT_MS`. Reset by every session event. */
  watchdog: ReturnType<typeof setTimeout> | null
  /** Summarizes this room's turn into the one line the channel sees. Reset per turn. */
  activity: AgentActivityTracker
  /**
   * True while the worker is blocked on an approval nobody in chat can answer yet. The watchdog
   * must not fire here: the turn is not wedged, it is WAITING, and the worker's own approval
   * timeout already bounds it. Clearing this re-arms the watchdog with a fresh window.
   */
  awaitingApproval: boolean
  /**
   * Permission requests raised by this session that have not settled yet (Track 19), keyed by the
   * worker's request id. Lives on the SESSION rather than the turn because a request can outlive
   * this server's idea of which turn is running (see `adopt`), and because a decision arriving over HTTP
   * has only a room id to find it by.
   */
  approvals: Map<string, PendingApproval>
  /**
   * True from the moment WE abandon a turn (the watchdog interrupting it, or a dead session) until
   * the next turn starts. It exists to stop `adopt` resurrecting the turn we just gave up on.
   *
   * An interrupt is not instant: the engine keeps emitting for a beat after the frame is sent, and
   * those stragglers used to be harmless because only a whole `assistant_message` could seed an
   * orphan. Since a turn streams, a single leftover TOKEN can - and an orphan posts its text as a
   * NEW message, so the room would get a cryptic fragment right below "I interrupted this turn".
   */
  discarding: boolean
}

/**
 * One permission request, from the moment it is raised to the moment it settles.
 *
 * The whole state machine exists because of one asymmetry: a request may settle at ANY point,
 * including while the card announcing it is still being written to the database. There are
 * therefore three shapes this can be in - held (no card yet, `hold` armed), posting (`posting`
 * true, `messageId` not yet known), and posted (`messageId` set) - and a resolution has to do
 * something different in each. Getting that wrong leaves a card in the transcript with live
 * buttons that answer a request nobody holds, which is exactly the failure the durable card was
 * chosen to avoid.
 */
interface PendingApproval {
  requestId: string
  toolName: string
  /** The card's pending body, rendered once at request time and reused when it settles. */
  body: string
  /** Epoch ms the worker will resolve this itself, when it told us. */
  expiresAt: number | undefined
  /** The card message in the room; null while held, while posting, or when the cap refused it. */
  messageId: string | null
  /** Fires `APPROVAL_HOLD_MS` after the request - see `APPROVAL_HOLD_MS` for what it filters. */
  hold: ReturnType<typeof setTimeout> | null
  /** True between the decision to post the card and knowing its message id. */
  posting: boolean
  /** Set when this settled while `posting` was true; applied the moment the id is known. */
  settled: ApprovalOutcome | null
}

interface TurnState {
  /**
   * The placeholder message this turn is filling in, or NULL for an adopted orphan turn (see
   * `adopt`) - text the worker produced for a turn this server did not know had started, which is
   * delivered as a NEW message because there is no placeholder waiting for it.
   */
  messageId: string | null
  /** When this turn began, so a client can render elapsed time without inventing one. */
  startedAt: number
  /**
   * Assistant text so far: completed blocks plus whatever the current one has spelled out.
   *
   * The assembly rule (and the two ways of getting it wrong) lives in `AgentTurnText` in core,
   * where it is unit-tested. Note deltas do NOT share the blocks' uuid keying - every
   * `stream_delta` carries its own `randomUUID()`, so filing them that way would render one
   * paragraph per token.
   */
  text: AgentTurnText
  /**
   * Approval cards this turn has actually POSTED, against `APPROVAL_CARDS_PER_TURN`.
   *
   * Counted per TURN and not per session or per hour, because the failure it bounds is one turn
   * looping over fifty files: a burst inside a minute, which an hourly budget would not see coming
   * and a session-lifetime cap would eventually leak into an innocent turn.
   */
  approvalCards: number
  /** The cap notice is posted once per turn, not once per refused request. */
  capNoticed: boolean
  /**
   * The thread this turn lives in - the root of the ask. Everything the turn says goes here: the
   * placeholder, the cap notice, any card. Null in two cases that both mean TOP LEVEL: an adopted
   * orphan turn, which by definition has no ask to hang off, and a turn in a direct message with
   * the agent, where the room is the conversation (`AgentTrigger.threadRootId`).
   */
  threadRootId: string | null
}

const rooms = new Map<string, RoomAgent>()

/**
 * Per-room serialization. Two people mentioning @nova in the same second must not race each other
 * into creating two worker sessions for one room - the whole scope decision is one session per
 * room, and `Map.set` is not a mutex. Each room's work is chained onto its own promise; the chain
 * never rejects (every handler catches), so one failed turn cannot wedge the room forever.
 */
const queues = new Map<string, Promise<void>>()

function serialize(roomId: string, work: () => Promise<void>): void {
  const previous = queues.get(roomId) ?? Promise.resolve()
  const next = previous.then(work, work)
  queues.set(roomId, next)
  // `.catch` before `.finally` so the derived promise can never become an unhandled rejection
  // (process-fatal under Node's default) if a future `work` ever stops swallowing its own errors.
  void next
    .catch(() => undefined)
    .finally(() => {
      // Only clear if nothing else queued behind us, or the next arrival would chain onto a
      // resolved promise it has already been removed from and lose its ordering.
      if (queues.get(roomId) === next) queues.delete(roomId)
    })
}

let listening = false

/**
 * Arm the trigger. Called once at module init, exactly like `startNotificationDelivery()`.
 * Idempotent, so "is the chat agent live?" has one answer for the life of the process.
 *
 * Two things are armed here, and only one of them is behind the flag. The TURN machinery - sessions,
 * placeholders, the worker - runs only when `CHAT_AGENT_ENABLED` is exactly '1' and a worker booted.
 * The DECISION path (`decideApproval`, behind the card's buttons) is armed unconditionally,
 * because since chat-op approvals it answers cards that no agent raised: a human's own Claude Code
 * session can hold a `ChatRoomDelete` for approval in a deployment where nova never runs a turn, and
 * a card nobody can answer is worse than no card. A gate that was off would strand exactly the
 * deployments (dev, a seeded machine) where the flag is off. The decision path
 * runs no turn, creates no session and does no MCP write, so the reason the flag exists does not
 * apply to it.
 */
export function startChatAgent(): void {
  if (listening) return
  listening = true
  // BEFORE the flag checks, deliberately. A pending card is a promise the last process made and
  // this one cannot keep, and the case where the flag was just turned OFF - after an incident, say
  // - is exactly the case where stale cards exist. Leaving them pending would offer buttons that
  // answer nothing on a feature that is no longer even running.
  expireOrphanedCards()
  const armed = chatAgentEnabled() && agentWorkerUrl() !== undefined

  onChatEvent((event: ChatBusEvent) => {
    // A deleted message of nova's is a conversation the room has chosen to forget - see "The
    // agent's context" on ChatStore.deleteMessage. The store dropped the durable row; the LIVE
    // half is this module's handle, and it has to go too, or `ensureSession` would hand the next
    // mention the very session whose visible half was just erased. RETIRED rather than dropped:
    // the worker must close the session (and any turn still streaming into the deleted
    // placeholder), or it lingers as an orphan pinning an engine process until the next boot
    // sweep. Under the room queue so it cannot interleave with a turn that is starting. A
    // cascade emits one frame per message, so this may run several times for one thread; after
    // the first the map is empty and the rest are no-ops.
    if ('ephemeral' in event && event.type === 'message.deleted' && event.payload?.senderId === systemUserId()) {
      serialize(event.roomId, async () => {
        try {
          const live = rooms.get(event.roomId)
          if (live !== undefined) retire(event.roomId, live)
        } catch {
          /* a handle that will not detach cleanly is still forgotten; the room queue must not wedge */
        }
      })
      return
    }
    const trigger = triggerFrom(event)
    if (trigger === null) return
    // One message, one turn. Two of the three doors can open onto the same ask - a reply in the
    // agent's thread that ALSO writes "@nova", or any message in a DM with nova, arrives once as
    // `message.created` and once as `mention.created` - and a duplicated ask is a duplicated
    // answer, the shape of the double-post reported against production on 2026-09-02. Keyed by
    // message id and checked before anything else runs (the directive, the flag, the queue), so it
    // also absorbs a redelivered event from any other source. The window and its tests live in core.
    if (!claims.claim(trigger.messageId)) return
    const directive = parseAgentDirective(trigger.body)
    if (!armed) return
    // Never throw into the bus: its publisher is reacting to an already-committed write.
    serialize(trigger.roomId, () => handleTrigger(trigger, directive).catch(() => undefined))
  })

  if (!armed) return
  // Restart recovery is Track 16 (the streaming path is what has something to recover). What is
  // honest to do here is refuse to leave a half-written placeholder claiming a turn is running:
  // the process that owned those handles is gone.
  void reconcileOrphanedTurns()
  void sweepOrphanSessions()
}

/**
 * Which door this event came in by, if any: a message in a DM with nova, an explicit @nova mention,
 * or a reply inside a thread that belongs to the agent.
 *
 * The ordering of the doors, the thread-ownership rule and the DM check are all in core
 * (`resolveAgentTrigger`), where they are pinned by vitest against a fake store. What stays here is
 * the one thing a test cannot supply: the REAL store, whose `directPeer` / `message` /
 * `threadHasSender` are the facts the doors are decided on. `ChatStore` satisfies
 * `AgentTriggerReads` structurally, so it is passed as-is rather than wrapped.
 */
function triggerFrom(event: ChatBusEvent): AgentTrigger | null {
  return resolveAgentTrigger(event, chatStore())
}

/** One message, one turn - see the check in `startChatAgent` and the class in core. */
const claims = new AgentMessageClaims()

/**
 * Close worker sessions this process can no longer reach.
 *
 * At boot `rooms` is empty, so EVERY session the worker still holds for nova is by definition an
 * orphan: this server dropped its handle when the last process died and nothing will ever adopt it again.
 * Left alone they accumulate one per restart, each pinning an engine process and its context.
 *
 * Assumes ONE Box per worker, which is the deployment (the deployed Box owns :8787, a dev checkout
 * runs its own worker on another port). Two Boxes against one worker would sweep each other's
 * sessions, so give a second instance its own worker rather than sharing.
 */
async function sweepOrphanSessions(): Promise<void> {
  const target = agentWorkerUrl()
  if (!target) return
  try {
    const key = proxyKey()
    const client = new WorkerDeckClient({
      baseUrl: `${target}/v1`,
      ...hostAuth({ baseUrl: `${target}/v1`, key: key ?? '' }),
    })
    for (const session of await client.listSessions()) {
      const meta = session.meta ?? {}
      if (String(meta['app']) !== AGENT_SESSION_APP || String(meta['user']) !== systemUserId()) continue
      try {
        await client.deleteSession(session.id)
      } catch {
        /* one stubborn session must not stop the sweep */
      }
    }
  } catch {
    /* the worker may simply be down at boot; the sweep retries on the next restart */
  }
}

/**
 * At boot, every row that says "mid-turn" is lying - the handles died with the last process. Until
 * Track 16 teaches this to re-attach from `lastWorkerSeq`, say so in the transcript rather than
 * leaving a placeholder that never fills in.
 */
async function reconcileOrphanedTurns(): Promise<void> {
  try {
    const store = chatStore()
    for (const session of store.agentSessionsStreaming()) {
      const slug = store.roomSlugById(session.roomId)
      if (slug !== null && session.streamingMessageId !== null) {
        // Keep whatever the turn had already STREAMED. Before streaming this message was always
        // "…", so replacing it wholesale was strictly better; now it can hold the answer the room
        // is in the middle of reading, and a deploy mid-turn is routine. Every other interrupted
        // path in this file appends the note under the partial - this one used to be the exception.
        const note = '(interrupted by a restart - ask again)'
        const streamed = store.agentBody(session.roomId, session.streamingMessageId, systemUserId())
        const partial = streamed === null || streamed === PLACEHOLDER_BODY ? '' : streamed.trim()
        finalize(slug, session.streamingMessageId, partial.length > 0 ? `${partial}\n\n${note}` : note)
      }
      // The worker session is not closed here: it may still be running, and Track 16 wants it.
      store.agentSessionSave({ ...session, streamingMessageId: null, turnStartedAt: null })
    }
  } catch {
    /* recovery is best-effort; a failure here must not stop the server booting */
  }
}

/**
 * Settle approval cards that outlived the process that raised them (Track 19).
 *
 * A card says "pending" and renders buttons; the request it names lived in the last process's
 * worker socket. Nothing can answer it now, so leaving it is strictly worse than closing it: a
 * button that silently does nothing is the failure the durable card was chosen to avoid, and it
 * would sit in the transcript forever.
 *
 * Runs off a table scan rather than the `agent_sessions` rows, deliberately - a card can be in a
 * room whose turn had already ended, and the row would not know about it. It is one scan, once,
 * against a column that is NULL on all but a handful of messages.
 */
function expireOrphanedCards(): void {
  try {
    sweepOrphanedCards()
  } catch {
    /* best-effort, and its own try: a failure here must not stop the server booting */
  }
}

function sweepOrphanedCards(): void {
  const store = chatStore()
  // Worker cards only. Chat-op cards are swept by their own owner (`startChatOpApprovals`), from
  // ChatModule's init, so neither module needs the other to have booted.
  for (const card of store.pendingCards('approval')) {
    const meta = card.meta
    if (meta === undefined || meta.kind !== 'approval') continue
    const slug = store.roomSlugById(card.roomId)
    if (slug === null) continue
    writeCard(
      slug,
      card.id,
      resolvedCardBody(card.body, { state: 'expired', decidedBy: null }),
      { ...meta, state: 'expired', decidedBy: null, decidedAt: Date.now() }
    )
  }
}

async function handleTrigger(trigger: AgentTrigger, directive: AgentDirective): Promise<void> {
  const store = chatStore()
  const slug = store.roomSlugById(trigger.roomId)
  if (slug === null) return

  // Interrupt first, and BEFORE the budget: "stop" must always work, and a room that has just
  // exhausted its budget is exactly a room somebody wants to stop. Never counts as a turn.
  if (directive.kind === 'interrupt') {
    const live = rooms.get(trigger.roomId)
    if (live) live.handle.interrupt()
    return
  }

  // The loopback check, BEFORE a session is created or a placeholder is posted.
  //
  // nova's tools reach the Box by dialling the literal `127.0.0.1:<port>/mcp` out of its own
  // config.toml, so a turn is only safe when that address is THIS process. A VS Code port-forward
  // can own it silently (loopback-guard.ts carries the incident), and when it does, every write
  // the turn makes - a channel created, an initiative moved, a message posted - lands on whatever
  // is at the other end, with nova's real credentials.
  //
  // Refusing loudly in the channel rather than degrading: the asker is right there, and "I did
  // nothing and here is why" is the only honest answer. This runs per TURN, not once at boot,
  // because a tunnel appears and vanishes while the Box keeps running.
  const loopback = await verifyLoopback()
  if (!loopback.ours) {
    console.error(`  agent: REFUSING a turn in #${slug} - ${loopback.detail}`)
    await post(
      slug,
      `I am not running this turn. My tools reach the Box at 127.0.0.1, and right now that address is not this server - ${loopback.detail}. Anything I did would be written to that other instance with my credentials, so I would rather do nothing. (A VS Code Remote-SSH port forward is the usual cause.)`,
      trigger.threadRootId,
    )
    return
  }

  const existing = store.agentSession(trigger.roomId)
  const budget = evaluateTurnBudget(existing, Date.now())
  if (!budget.allowed) {
    await post(
      slug,
      `I have already run ${budget.limit} turns in this room this hour, so I am pausing here. Ask again a bit later.`,
      trigger.threadRootId,
    )
    return
  }

  let agent: RoomAgent
  try {
    agent = await ensureSession(trigger.roomId, slug)
  } catch (error) {
    // Never silent. An inert mention that used to do nothing, now visibly failing, is strictly
    // better than one that quietly still does nothing.
    await post(slug, `I could not start: ${reasonOf(error)}`, trigger.threadRootId)
    return
  }

  // Built BEFORE the placeholder is posted. `history()` returns the room's NEWEST messages, so
  // seeding afterwards would hand the model its own "…" as the last line of the room and push a
  // real message out of the ten-message window.
  const seed = await seedFor(agent, trigger, slug, directive.text)

  // A turn already in flight in this room is not a second session and not a queue - it is the
  // same conversation. Fold the new ask in with `send()` and let the running turn steer.
  // Captured once rather than re-read: nothing can null it between the check and the use today
  // (no await separates them), and a future await added here would otherwise be a TypeError.
  const running = agent.turn
  if (running !== null) {
    agent.handle.send(seed)
    persist(trigger.roomId, agent, budget.next, running.messageId)
    // Folding into a live turn restarts its silence window: this IS activity.
    armWatchdog(trigger.roomId, agent)
    return
  }

  // Threaded under the ask in a named room, always: a turn that runs for two minutes and streams
  // into the room used to shove every other conversation up the transcript, and now it fills in
  // inside a unit the room can collapse. In a DM with nova `threadRootId` is null for a top-level
  // ask and the placeholder lands at top level - the room IS the conversation there, and a thread
  // per exchange would hide every answer behind a disclosure triangle (`AgentTrigger.threadRootId`).
  // A DM between two humans that nova was asked into threads like a named room (the mention door
  // set `threadRootId`), and the post is authorized by the guest pass the mention row IS
  // (`ChatStore.isDirectGuest`) - nova is not a member there and never becomes one.
  // Same call either way: `post` reads null as "no parent", never as "missing".
  const placeholder = await post(slug, PLACEHOLDER_BODY, trigger.threadRootId)
  // That await is REAL (posting resolves nova's display name against the warehouse directory), so
  // the session can have died underneath us while it ran. Recreating here would race the queue;
  // saying so in the placeholder is honest and costs the asker one retry.
  if (rooms.get(trigger.roomId) !== agent) {
    finalize(slug, placeholder.id, '(the agent session ended before this turn could start - ask again)')
    return
  }

  agent.turn = {
    messageId: placeholder.id,
    startedAt: Date.now(),
    text: new AgentTurnText(),
    approvalCards: 0,
    capNoticed: false,
    threadRootId: trigger.threadRootId,
  }
  // DERIVED, not reset. A card can still be open here - a request raised for a worker turn this
  // server never tracked (the fold race) survives into the next turn - and clearing the flag blind would
  // arm the watchdog against work the room is still deciding about.
  agent.awaitingApproval = agent.approvals.size > 0
  agent.discarding = false
  // Resets the tracker (the session outlives the turn, so `toolCount` and the last label are
  // still turn N's) and puts a "starting" line under the placeholder immediately. Without this
  // the room stares at a bare "…" for however long the model thinks before its first tool call,
  // which is the exact silence this whole feature exists to fill.
  publishActivity(trigger.roomId, agent, [{ kind: 'turn_start' }])
  try {
    persist(trigger.roomId, agent, budget.next, placeholder.id)
    agent.handle.send(seed)
    armWatchdog(trigger.roomId, agent)
  } catch (error) {
    // Once `turn` is set, a throw would otherwise leave the room wedged forever: the placeholder
    // stays "…", `turn` stays non-null, and every later mention folds into a turn that never
    // started. Nothing recovers that short of a restart, so it is handled rather than swallowed.
    agent.turn = null
    settleRow(trigger.roomId)
    finalize(slug, placeholder.id, `I could not start: ${reasonOf(error)}`)
  }
}

/** An error as one honest line for the channel. */
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Post as nova. Mentions are deliberately NOT resolved - see `postAsAgent`. `parentId` threads the
 *  message under the ask, which is where every word of a turn belongs - see `handleTrigger`. */
const post = (slug: string, body: string, parentId: string | null = null): Promise<ChatMessage> =>
  postAsAgent(slug, body, null, parentId)

/**
 * Build what this turn sends the worker: the standing instructions ONLY on a session that has
 * never seen them, plus the per-turn half every time.
 *
 * Both side effects live here rather than at the call sites, because both are "this session has
 * now been told": the prime flag and the watermark. The caller sends the string it gets back on
 * either path (fresh turn or folded into a running one), so marking here cannot drift from what
 * was actually delivered.
 */
async function seedFor(
  agent: RoomAgent,
  trigger: AgentTrigger,
  slug: string,
  ask: string,
): Promise<string> {
  const store = chatStore()
  // nova is a member the moment the mention commits - or, in a DM between two humans, holds the
  // guest pass the mention row IS (`ChatStore.isDirectGuest`) - so this read is authorized by
  // construction either way.
  //
  // Inside a thread the CONTEXT is the thread, not the room: a follow-up like "and npm?" is
  // unreadable next to whatever the room was chatting about meanwhile, and perfectly clear next
  // to the question it follows. Falls back to the room tail for a top-level mention, which has no
  // thread yet - it is about to become the root of one - and for a top-level DM message, whose
  // conversation IS the room. A DM message written inside a thread reads its thread like a reply
  // does: for both those doors `threadRootId` is non-null exactly when there is a thread to read.
  const threadToRead = trigger.via === 'mention' ? null : trigger.threadRootId
  const page =
    threadToRead !== null
      ? threadTail(slug, threadToRead)
      : store.history(slug, systemUserId(), { limit: AGENT_SEED_HISTORY })
  const room = store.roomBySlug(slug)
  // The thread's root, for the line that says WHICH conversation this follow-up continues. Read
  // from the page when it is there (a thread page leads with its parent) rather than fetched
  // again; null for a top-level mention, which IS the root, and for a top-level DM message, which
  // has no thread at all (`threadRootId` null).
  const threadRoot =
    trigger.threadRootId === null || trigger.threadRootId === trigger.messageId
      ? null
      : (page.messages.find((m) => m.id === trigger.threadRootId) ??
        store.message(trigger.roomId, trigger.threadRootId))

  // A DM the agent was asked INTO rather than one it is in: the room is a DM, but the ask did not
  // come by the DM door (the sender's peer is the other human - see `resolveAgentTrigger`). Both
  // halves of the seed then avoid naming the room by its slug, which is an address that belongs
  // to the two people whose conversation it is.
  const guest = room?.kind === 'dm' && trigger.via !== 'dm'
  // Only what this session has not been shown. On a fresh session `seededThrough` is 0, so this
  // is the whole tail - the old behaviour, exactly where it is still wanted.
  const fresh = page.messages.filter((m) => m.createdAt > agent.seededThrough)
  const turn = buildAgentTurn({
    roomSlug: slug,
    recent: fresh,
    trigger,
    ask,
    threadRoot,
    directGuest: guest,
  })
  for (const message of page.messages) {
    if (message.createdAt > agent.seededThrough) agent.seededThrough = message.createdAt
  }
  // The trigger's own message is quoted as the ask, so it counts as seen even though the tail
  // builder drops it - otherwise it would be re-sent as "new" on the next turn.
  if (trigger.at > agent.seededThrough) agent.seededThrough = trigger.at

  if (agent.primed) return turn
  agent.primed = true
  // In a DM with nova the only human is whoever triggered this turn: the room has two members, the
  // other is nova, and nova's own messages never trigger (the loop guard). So the peer is the
  // trigger's sender and needs no directory read - and it is stable for the session, because the
  // session is per room and the room's membership is fixed (a DM refuses invites and leaves).
  const directPeer =
    trigger.via === 'dm' ? { id: trigger.senderId, name: trigger.senderName } : null
  // As a guest the two hosts are the asker and the asker's peer. The peer's name is the one
  // directory read in this seed, taken once per session for the same reason the DM peer needs
  // none: a DM's membership is fixed. Falls back to the id if the directory cannot name them - a
  // prime that says who is here is worth more than one that refuses to start over a display name.
  let directHosts: { id: string; name: string }[] | null = null
  if (guest) {
    const peerId = store.directPeer(trigger.roomId, trigger.senderId)
    const peer = peerId === null ? null : await resolvePrincipalById(peerId)
    directHosts = [
      { id: trigger.senderId, name: trigger.senderName },
      ...(peerId === null ? [] : [{ id: peerId, name: peer?.display ?? peerId }]),
    ]
  }
  return `${buildAgentPrime({ roomSlug: slug, roomTopic: room?.topic ?? null, directPeer, directHosts })}\n\n${turn}`
}

/** The tail of one thread, shaped like a history page so the seed builder cannot tell them apart.
 *  Trimmed to the same window a room tail gets: a thread is cheaper per message, not unbounded. */
function threadTail(slug: string, rootId: string): { messages: ChatMessage[] } {
  const page = chatStore().thread(slug, systemUserId(), rootId)
  const all = [page.parent, ...page.replies]
  return { messages: all.slice(-AGENT_SEED_HISTORY) }
}

function persist(
  roomId: string,
  agent: RoomAgent,
  budget: { turnsThisHour: number; windowStartedAt: number },
  streamingMessageId: string | null,
): void {
  chatStore().agentSessionSave({
    roomId,
    workerSessionId: agent.workerSessionId,
    streamingMessageId,
    lastWorkerSeq: agent.handle.lastSeq,
    turnStartedAt: streamingMessageId === null ? null : Date.now(),
    turnsThisHour: budget.turnsThisHour,
    windowStartedAt: budget.windowStartedAt,
  })
}

/**
 * The room's session, created on first use and kept WARM across turns for the life of the process.
 *
 * Warm, not durable. Durable parking was rejected for v1: it cannot preserve an in-flight turn
 * anyway, it is unproven on this deployment, and its only payoff is saving one seed's worth of
 * tokens - against a lifecycle state machine to own. When a session is gone, the CHAT is the
 * memory: the seed window plus `chat-history` reconstructs everything that mattered.
 */
async function ensureSession(roomId: string, slug: string): Promise<RoomAgent> {
  const live = rooms.get(roomId)
  if (live) return live

  const target = agentWorkerUrl()
  if (!target) throw new Error('no agent worker configured')

  // Profile resolution goes through the mapping like every other start - never a hard-coded name.
  // nova runs under ITS OWN profile (`nova:codex`), which is precisely what agent-profiles.json's
  // note asks for: the rule it states is that automation must not borrow a TEAMMATE's account.
  const profile = agentProfileFor(systemUserId(), AGENT_ENGINE)
  if (!profile) throw new Error(`no ${AGENT_ENGINE} profile is declared for ${systemUserId()}`)

  const key = proxyKey()
  // Straight to the worker, bypassing the `/agent` proxy: that proxy exists to authenticate a
  // BROWSER and enforce one-live-session-per-USER, and neither applies to a server-owned session
  // whose scope is a room (two people talking to nova in one channel is the feature, not a 409).
  // `hostAuth` and NOT a bare `headers`: the key has to reach BOTH transports, and they carry it
  // differently. REST takes an `authorization` header; the attach WebSocket takes `?key=` in the
  // URL, because a socket handshake cannot carry a custom header. Supplying only headers is the
  // silent failure - `createSession` (REST) succeeds, the socket is rejected unauthenticated, and
  // `send()` then buffers into a socket nobody reads, so the room answers "…" and nothing else.
  const client = new WorkerDeckClient({
    baseUrl: `${target}/v1`,
    ...hostAuth({ baseUrl: `${target}/v1`, key: key ?? '' }),
  })

  const info = await client.createSession({
    cwd: repoRoot(),
    profile,
    meta: { app: AGENT_SESSION_APP, user: systemUserId(), room: roomId, roomSlug: slug },
    // Reads free, writes approved - see CHAT_AGENT_PERMISSION_MODE. Until the channel becomes the
    // approval surface there is still nobody to approve, so this stays read-and-MCP-only in effect.
    permissionMode: CHAT_AGENT_PERMISSION_MODE,
    // Still denied, and NOT because nobody is watching any more - see CHAT_AGENT_QUESTION_BEHAVIOR.
    questionBehavior: CHAT_AGENT_QUESTION_BEHAVIOR,
    // Human-paced, and only safe now that the channel can actually answer. Ships together with the
    // watchdog standing down while `awaitingApproval` - without that, the silence limit would
    // interrupt the very turn the room is deliberating about, ten minutes in.
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
    ...(CHAT_AGENT_DISALLOWED_TOOLS.length > 0
      ? { disallowedTools: [...CHAT_AGENT_DISALLOWED_TOOLS] }
      : {}),
    ...(await sessionTuning(client, profile)),
  })

  const handle = client.attach(info.id, { afterSeq: 0 })
  const agent: RoomAgent = {
    handle,
    workerSessionId: info.id,
    roomSlug: slug,
    turn: null,
    primed: false,
    seededThrough: 0,
    stopListening: () => undefined,
    idleTimer: null,
    watchdog: null,
    activity: new AgentActivityTracker(),
    awaitingApproval: false,
    approvals: new Map(),
    connected: false,
    discarding: false,
  }
  const stopEvents = handle.on('event', (event: SessionEvent) => {
    try {
      onSessionEvent(roomId, agent, event)
    } catch {
      /* one malformed event must not tear down a live session */
    }
  })
  const stopConnection = handle.on('connectionChange', (open: boolean) => {
    agent.connected = open
  })
  agent.stopListening = () => {
    stopEvents()
    stopConnection()
  }
  rooms.set(roomId, agent)
  // A session created and then never used still expires: the TTL starts now, not at first turn.
  armIdle(roomId, agent)
  return agent
}

/**
 * Translate one worker event into chat. Track 16 adds the delta fan-out and the checkpoints.
 *
 * Ordering here is deliberate: TERMINAL events are handled first and unconditionally, because
 * they also arrive between turns (an idle timeout, an operator close, a worker restart) - and a
 * terminal event dropped while the room was idle would leave a dead handle cached in `rooms`
 * forever. Every later mention would then post a placeholder and `send()` into a socket nobody
 * reads (the client buffers and retries the reconnect indefinitely), so the room would answer
 * "…" and nothing else until the server restarted.
 */
/**
 * Translate one worker event into the summarizer's vocabulary.
 *
 * The mapping is where the ENGINE's shape is absorbed, which is why the summarizer itself knows
 * nothing about workerdeck. Note tool activity does not arrive as its own event: it rides as
 * `tool_use` blocks inside `assistant_message`, and outcomes as `tool_result` blocks inside a
 * synthetic `user_message`. Several signals can come from one event (a message that thinks, calls a
 * tool, then writes), and they are folded in order.
 */
function signalsFor(event: SessionEvent): AgentActivitySignal[] {
  if (event.type === 'assistant_message') {
    const content = event.message.content
    if (typeof content === 'string') return content.trim().length > 0 ? [{ kind: 'writing' }] : []
    const signals: AgentActivitySignal[] = []
    for (const block of content) {
      // Narrowed via Extract like `textOf` does: the union carries an UnknownBlock whose `type` is
      // an open string, so a bare discriminant check does not narrow the payload fields.
      if (block.type === 'thinking') {
        signals.push({ kind: 'thinking' })
      } else if (block.type === 'tool_use') {
        const use = block as Extract<ContentBlock, { type: 'tool_use' }>
        signals.push({ kind: 'tool', use: { name: use.name, input: use.input } })
      } else if (block.type === 'text') {
        const text = block as Extract<ContentBlock, { type: 'text' }>
        if (text.text.trim().length > 0) signals.push({ kind: 'writing' })
      }
    }
    return signals
  }
  if (event.type === 'user_message') {
    const content = event.message.content
    if (typeof content === 'string') return []
    // A failed tool call is progress, not failure: the model routinely recovers, and calling the
    // TURN failed here would be a lie the room cannot check.
    return content.some(
      (block) => block.type === 'tool_result' && (block as Extract<ContentBlock, { type: 'tool_result' }>).is_error === true
    )
      ? [{ kind: 'tool_failed' }]
      : []
  }
  if (event.type === 'stream_delta') return [{ kind: 'writing' }]
  if (event.type === 'permission_requested') {
    return [{ kind: 'awaiting_approval', toolName: event.request.displayName ?? event.request.toolName }]
  }
  if (event.type === 'permission_resolved') return [{ kind: 'approval_resolved' }]
  if (event.type === 'status_changed' && event.status === 'awaiting_approval') return [{ kind: 'awaiting_approval' }]
  return []
}

/**
 * Broadcast the room's current activity, if the tracker says there is news.
 *
 * Routed to the ROOM (`userId: null`), so the controller applies the same `canReadRoom` filter it
 * applies to every other room-routed frame. The placeholder's id in `activity.messageId` locates
 * the anchor, and because this is an ephemeral it can never advance a client's cursor or mark
 * anything unread. An orphan turn (no placeholder) publishes nothing - there is no anchor to hang
 * it on.
 */
function publishActivity(roomId: string, agent: RoomAgent, signals: AgentActivitySignal[]): void {
  const turn = agent.turn
  if (turn === null || turn.messageId === null) return
  const now = Date.now()
  let latest = null
  for (const signal of signals) {
    const emitted = agent.activity.observe(signal, now)
    if (emitted !== null) latest = emitted
  }
  // NO signals means "re-publish where you are" - the one caller is `openTurnRow`, which has just
  // moved the turn onto a new row and needs the line to follow it. Without this the tracker's
  // deduplication would swallow the frame (nothing about the STATE changed, only the anchor) and
  // the room would keep a spinner on a message the turn has finished with.
  if (signals.length === 0) latest = agent.activity.current()
  if (latest === null) return
  try {
    emitChatEvent({
      ephemeral: true,
      type: 'agent.activity',
      roomId,
      userId: null,
      payload: null,
      activity: {
        messageId: turn.messageId,
        state: latest.state,
        label: latest.label,
        toolCount: latest.toolCount,
        startedAt: turn.startedAt,
        workerSessionId: agent.workerSessionId,
      },
      at: now,
    })
  } catch {
    /* progress is decoration: a failed publish must never disturb the turn producing it */
  }
}

/** The answer to `chatAgentStatus`: whether a turn is in flight here, and what it is doing. */
export interface ChatAgentStatus {
  active: boolean
  activity: AgentActivityFrame | null
}

/**
 * The current activity of this room's turn, read straight out of the in-memory tracker.
 *
 * The mid-turn-join read. `agent.activity` is an ephemeral and is never replayed, so a client that
 * opens a room (or reconnects its feed) while nova is working would otherwise see a bare
 * placeholder with no explanation until the next frame happened to land - and a turn thinking for
 * thirty seconds emits nothing at all in that window. This answers the same shape the ephemeral
 * carries, so a client can adopt it without a second code path.
 *
 * Read-only and allocation-light on purpose: it is called on every room open, and it must never be
 * able to disturb the turn it is describing. An orphan turn (no placeholder) reports inactive for
 * the same reason it publishes no activity - there is no anchor to hang a line on.
 */
export function chatAgentStatus(roomId: string): ChatAgentStatus {
  const agent = rooms.get(roomId)
  const turn = agent?.turn ?? null
  if (agent === undefined || turn === null || turn.messageId === null) return { active: false, activity: null }
  const current = agent.activity.current()
  return {
    active: true,
    activity: {
      messageId: turn.messageId,
      state: current.state,
      label: current.label,
      toolCount: current.toolCount,
      startedAt: turn.startedAt,
      workerSessionId: agent.workerSessionId,
    },
  }
}

function onSessionEvent(roomId: string, agent: RoomAgent, event: SessionEvent): void {
  if (event.type === 'session_error' || event.type === 'session_closed') {
    const turn = agent.turn
    if (turn !== null) {
      const note =
        event.type === 'session_error' ? `the run failed: ${event.message}` : `the session closed (${event.reason})`
      const body = assembled(turn)
      deliver(agent.roomSlug, turn, body ? `${body}\n\n(${note})` : `(${note})`, turnRecord(agent, turn, 'error'))
      // The turn is over even though nothing completed it - say so, or the room keeps a spinner
      // running for a session that no longer exists. Again before the turn is nulled.
      publishActivity(roomId, agent, [{ kind: 'error', detail: event.type }])
      agent.turn = null
      agent.discarding = true
    }
    // Unconditional, like the terminal handling around it: a request raised in a session that then
    // died is unanswerable whether or not this server thought a turn was running.
    expireApprovals(agent)
    drop(roomId)
    return
  }

  // Track whether the turn is BLOCKED rather than wedged. A turn waiting on an approval is not
  // wedged, it is WAITING - bounded by `approvalTimeoutMs` - so the watchdog stands down until it
  // resolves. `status_changed` is the belt to the request/resolve braces.
  // SET-ONLY, both of them. `status_changed` used to assign the flag, which quietly re-broke the
  // rule below: approve card A of two, the worker runs A's tool and reports `running`, the flag is
  // cleared with B still pending, and ten minutes later the watchdog interrupts a turn that is
  // legitimately waiting. Whether the worker re-emits `awaiting_approval` when it re-blocks is the
  // worker's business, and not something this file should be betting a turn on.
  if (event.type === 'permission_requested') agent.awaitingApproval = true
  else if (event.type === 'status_changed' && event.status === 'awaiting_approval') agent.awaitingApproval = true
  // `permission_resolved` deliberately does NOT clear the flag here - `settleApproval` below does,
  // and only once nothing is left open. Clearing on the event would stand the watchdog back UP
  // while the turn is still blocked on a SECOND card, and ten minutes later interrupt the very
  // turn the room is deliberating about. One resolved request is not an unblocked turn.

  // Track 19's two halves. Both run BEFORE the activity publish and the branches below, and
  // neither returns: a permission event is also ordinary progress, and the room's activity line
  // says "waiting for approval" off exactly the same frames.
  // Defensive, and honest about being unenforced TODAY: the protocol puts `replay` only on
  // assistant/user messages, so this is always false for permission events and the probe below is
  // currently dead. It stays because Track 16's re-attach is the change that makes replayed
  // permission events reachable, and re-carding one would post a button for a request that
  // belongs to a process that is gone. Written as a probe rather than a read because `replay` is
  // not on every member of the union.
  const replayed = 'replay' in event && event.replay === true
  if (event.type === 'permission_requested' && !replayed) {
    onPermissionRequested(roomId, agent, event.request)
  } else if (event.type === 'permission_resolved' && !replayed) {
    // The worker settled it: a timeout, a policy rule, or the decision WE sent a moment ago. The
    // last case finds nothing here, because `chatAgentDecide` records the human and clears the
    // entry synchronously - `resolvedBy: 'client'` cannot tell us WHICH human, so it must not be
    // what writes the card.
    settleApproval(agent, agent.approvals.get(event.requestId) ?? null, {
      // `timeout` is the one that becomes EXPIRED - nobody answered, and the card should say so
      // rather than implying a person refused. A policy deny is a real refusal by the runner's
      // own rules, so it reads as one, with no name attached to it.
      state:
        event.behavior === 'allow' ? 'approved' : event.resolvedBy === 'timeout' ? 'expired' : 'denied',
      decidedBy: null,
      reason: event.message,
    })
  }

  // Every event is a sign of life: the watchdog measures SILENCE, never turn duration, so a long
  // legitimate turn that keeps emitting is never interrupted.
  armWatchdog(roomId, agent)

  // Replayed history is recovery input: it rebuilds the tracker's state silently rather than
  // re-narrating a turn the room already watched.
  if (!('replay' in event) || event.replay !== true) publishActivity(roomId, agent, signalsFor(event))

  // The turn writing its answer, token by token. This is what makes a long turn readable while it
  // runs instead of a silent "…" followed by a wall of text.
  if (event.type === 'stream_delta') {
    const delta = assistantTextDelta(event)
    if (delta.length === 0) return
    const turn = adopt(agent)
    if (turn === null) return
    turn.text.pushDelta(delta)
    streamInto(roomId, agent)
    return
  }

  if (event.type === 'assistant_message') {
    // Replayed history is recovery input, never something to re-render into the channel.
    if (event.replay === true) return
    // Sub-agent chatter belongs in the worker's transcript, not in a team channel.
    if (event.parentToolUseId !== null) return
    const text = textOf(event.message.content)
    if (text.length === 0) return
    const block = adopt(agent)
    if (block === null) return
    block.text.completeBlock(event.uuid, text)
    // Forced: a block that just finished should land immediately rather than wait out the rate
    // limit. `poll` still refuses an unchanged body, so when the deltas already spelled this block
    // out in full - the common case - this costs no write at all.
    streamInto(roomId, agent, true)
    return
  }

  if (event.type === 'turn_result') {
    const turn = agent.turn
    // No turn and no accumulated text: the worker ended something that produced nothing to say.
    // Approvals are still expired first - this is the path a turn we ABANDONED takes (the watchdog
    // nulled the turn, then its `turn_result` finally arrived), and it was the one turn-end exit
    // that left a card pending with buttons nothing would ever answer.
    if (turn === null) {
      expireApprovals(agent)
      return
    }
    const body = assembled(turn)
    const answer =
      body.length > 0 ? body : (event.result?.trim() ?? '') || `I finished without producing an answer (${event.subtype}).`
    // Honesty over reach applies to the agent too: a turn that hit the turn or budget cap must
    // not read as a complete answer just because it produced some text before stopping.
    deliver(
      agent.roomSlug,
      turn,
      event.isError ? `${answer}\n\n(the turn ended early: ${event.subtype})` : answer,
      turnRecord(agent, turn, event.isError ? 'error' : 'done')
    )
    // BEFORE the turn is nulled: publishActivity needs the turn to know which message the line
    // hangs on, and `done`/`error` are the ONLY thing that stops a client's spinner. Every other
    // client backstop (a staleness age-out, the status read) is a slower, uglier version of this
    // frame - a turn that ends silently leaves the room watching a spinner for a finished answer.
    publishActivity(roomId, agent, [event.isError ? { kind: 'error', detail: event.subtype } : { kind: 'done' }])
    // The turn is over, so any request still open is moot: the worker will not act on an answer
    // for a turn that has ended, and a card left pending would offer buttons that do nothing.
    expireApprovals(agent)
    agent.turn = null
    agent.awaitingApproval = false
    agent.discarding = false
    settleRow(roomId)
    // The turn is over, so the room is idle again: stop the watchdog and start the TTL clock.
    armWatchdog(roomId, agent)
    armIdle(roomId, agent)
    return
  }
}

/**
 * A permission request has been raised: start the clock, do not post yet (Track 19).
 *
 * The delay is the whole design. `questionBehavior: 'deny'` and the runner's own policy rules
 * resolve requests in milliseconds, and a card posted for each of those would appear and settle
 * several times a turn - training the room to ignore the one surface that exists to be read. So
 * nothing reaches the channel until a request has survived `APPROVAL_HOLD_MS` unresolved, which is
 * exactly the set of requests a human is actually needed for.
 */
function onPermissionRequested(roomId: string, agent: RoomAgent, request: PermissionRequest): void {
  // A turn we deliberately abandoned must not sprout new cards - the same rule `adopt` follows,
  // and for the same reason: an interrupt is not instant, so a request raised a beat after the
  // watchdog gave up would otherwise post a card right under "I interrupted this turn", for a turn
  // whose `turn_result` will never come back to expire it.
  if (agent.discarding) {
    denyRequest(agent, request.id, 'this turn was already abandoned')
    return
  }
  // A duplicate id would orphan the first entry's timer. The worker does not re-raise, but this
  // costs one lookup and the alternative is a leaked timer nobody can find.
  if (agent.approvals.has(request.id)) return
  const pending: PendingApproval = {
    requestId: request.id,
    toolName: request.toolName,
    body: approvalCardBody({
      toolName: request.toolName,
      displayName: request.displayName,
      title: request.title,
      description: request.description,
      decisionReason: request.decisionReason,
      // The raw tool input, so a shell command is rendered as a fenced block rather than quoted as
      // a sentence. `approvalCardBody` reads `command` and nothing else out of it.
      input: request.input,
    }),
    expiresAt: request.expiresAt,
    messageId: null,
    hold: null,
    posting: false,
    settled: null,
  }
  agent.approvals.set(request.id, pending)
  pending.hold = setTimeout(() => {
    pending.hold = null
    void postApprovalCard(roomId, agent, pending).catch(() => undefined)
  }, APPROVAL_HOLD_MS)
  // A pending card must never hold the process open - the same rule both other timers follow.
  pending.hold.unref?.()
}

/**
 * Post the card for a request that outlived the hold window.
 *
 * Every early return here ends with the request DENIED rather than merely uncarded, and that is
 * the important part: `approvalTimeoutMs` is now thirty minutes, so a request the room never hears
 * about is a turn frozen for half an hour. Refusing it immediately keeps the turn moving and lets
 * the model report what it could not do - which is what the seed already tells it to do.
 */
async function postApprovalCard(roomId: string, agent: RoomAgent, pending: PendingApproval): Promise<void> {
  // Settled, dropped, or a session we no longer own: whatever happens now, it is not our card.
  if (rooms.get(roomId) !== agent) return
  if (agent.approvals.get(pending.requestId) !== pending) return

  const turn = agent.turn
  if (turn !== null && turn.approvalCards >= APPROVAL_CARDS_PER_TURN) {
    if (!turn.capNoticed) {
      turn.capNoticed = true
      void post(agent.roomSlug, approvalCapNotice(), turn.threadRootId).catch(() => undefined)
    }
    refuse(agent, pending, `this room's per-turn approval cap (${APPROVAL_CARDS_PER_TURN}) was reached`)
    return
  }

  pending.posting = true
  // BEFORE the card is posted, not after: the card's order key is issued by `postAsAgent`, and any
  // text the worker emits while that await is in flight must already have a row of its own to land
  // in - otherwise it slips back above the card and undoes the split.
  if (turn !== null) closeTurnRow(roomId, agent, turn)
  let card: ChatMessage
  try {
    const meta: ChatApprovalMeta = {
      kind: 'approval',
      requestId: pending.requestId,
      workerSessionId: agent.workerSessionId,
      toolName: pending.toolName,
      state: 'pending',
      ...(pending.expiresAt === undefined ? {} : { expiresAt: pending.expiresAt }),
    }
    // In the turn's thread, so a room reading a conversation is not interrupted by a card about
    // a tool call made three messages into somebody else's question.
    card = await postAsAgent(agent.roomSlug, pending.body, meta, agent.turn?.threadRootId ?? null)
  } catch (error) {
    pending.posting = false
    refuse(agent, pending, `I could not post the approval card: ${reasonOf(error)}`)
    // The row was closed for a card that never arrived. Re-open it, or the rest of the turn stops
    // streaming and lands in one lump at the end for a split that bought nothing.
    if (turn !== null) await openTurnRow(roomId, agent, turn)
    return
  }
  pending.posting = false
  pending.messageId = card.id
  if (agent.turn !== null) agent.turn.approvalCards += 1

  // The await above is real, so the request may have settled while the card was being written.
  // The entry was deliberately left in place for exactly this: apply the outcome now that there is
  // finally a message to apply it to, rather than leaving live buttons over a settled decision.
  if (pending.settled !== null) settleApproval(agent, pending, pending.settled)

  // The other half of the split: the turn needs somewhere BELOW the card to keep writing.
  if (rooms.get(roomId) === agent && agent.turn === turn && turn !== null) await openTurnRow(roomId, agent, turn)
}

/**
 * Close the row a turn is writing into, so the next thing it says starts a NEW message.
 *
 * Half of the fix for the ordering complaint of 2026-09-09: a turn writes into ONE placeholder,
 * posted before the turn started, so everything it said after an approval landed in a row that
 * sorts above the card that unblocked it. The room read the work before the permission for it.
 *
 * Two cases, and the second is the one that is easy to miss. A row that has TEXT is flushed and
 * sealed - it keeps what it already said, forever, as its own message. A row that is still the
 * untouched "…" is DELETED, because leaving it would put an empty typing bubble above the card
 * that the turn's next sentence then fills in - which is the original bug again, and with two
 * cards in a row it would strand one empty bubble per card.
 *
 * Leaves `turn.messageId` null. Nothing writes without a row: `streamInto` returns early, and if
 * the turn ends before `openTurnRow` runs, `deliver` posts the remainder as a new message, which
 * is the right answer anyway.
 */
function closeTurnRow(roomId: string, agent: RoomAgent, turn: TurnState): void {
  const messageId = turn.messageId
  if (messageId === null) return
  const body = turn.text.poll(Date.now(), true)
  if (body !== null) finalize(agent.roomSlug, messageId, body)
  if (turn.text.render().length === 0) {
    try {
      chatStore().discardAgentPlaceholder(roomId, messageId, systemUserId(), PLACEHOLDER_BODY)
    } catch {
      /* a placeholder we cannot drop is a stray "…", not a reason to fail the card */
    }
  }
  turn.text.seal()
  turn.messageId = null
}

/**
 * Open a fresh row under the card and point the turn at it.
 *
 * Awaited by `postApprovalCard` rather than created lazily on the next text event, because lazy
 * creation races the turn's own end: `turn_result` is dispatched synchronously from a socket
 * callback, and a row posted after it would be a stray "…" nothing ever fills in.
 *
 * The row is a placeholder like any other, so the activity line re-anchors to it and the room sees
 * nova still working. Nothing has to clean it up if the turn says nothing more: every path that
 * ends a turn delivers a non-empty body (`turn_result` falls back to the runner's own result line,
 * and the error paths write their note), so the row is always filled in.
 */
async function openTurnRow(roomId: string, agent: RoomAgent, turn: TurnState): Promise<void> {
  try {
    const row = await post(agent.roomSlug, PLACEHOLDER_BODY, turn.threadRootId)
    // The awaits above are real: the turn may have ended, been abandoned, or been replaced while
    // the row was being written. Adopting it then would point a dead turn at a live row.
    if (rooms.get(roomId) !== agent || agent.turn !== turn) return
    turn.messageId = row.id
    // Repoint restart recovery at the row the turn is ACTUALLY writing into. Read-modify-save
    // rather than `persist`, which wants the turn's budget - a number this path does not have and
    // must not guess: rewriting it from a default would hand the room a free turn every approval.
    repointStreamingRow(roomId, row.id)
    // Re-anchor the activity line, which detached to the tail the moment the old row closed.
    publishActivity(roomId, agent, [])
    streamInto(roomId, agent, true)
  } catch {
    /* no row: the turn's remaining text is posted whole by `deliver` when it ends */
  }
}

/**
 * Refuse a request ourselves, because the channel could not be asked.
 *
 * Distinct from a human denial and deliberately not carded: there is nothing for the room to
 * decide, and a message per refusal is the badge storm the cap exists to prevent. The MODEL is
 * told why, which is what keeps the turn honest about what it could not do.
 */
function refuse(agent: RoomAgent, pending: PendingApproval, why: string): void {
  agent.approvals.delete(pending.requestId)
  if (pending.hold !== null) clearTimeout(pending.hold)
  pending.hold = null
  if (agent.approvals.size === 0) agent.awaitingApproval = false
  denyRequest(agent, pending.requestId, why)
}

/** Send a refusal for a request we are not tracking (or no longer tracking). Never throws. */
function denyRequest(agent: RoomAgent, requestId: string, why: string): void {
  try {
    agent.handle.deny(requestId, why)
  } catch {
    /* a dead handle refuses nothing; the session's own teardown finishes the turn */
  }
}

/**
 * Move a request to its final state: stop its timer, forget it, and rewrite its card if it has one.
 *
 * The three shapes from `PendingApproval` each need something different, and this is the only
 * place that knows all three:
 * - **posting** - the card is mid-write. Record the outcome and return; `postApprovalCard` applies
 *   it the moment the message id exists. Deleting the entry here would strand a pending card.
 * - **held** (no card, no write) - forget it. Nothing ever reached the room, which is the hold
 *   window doing its job.
 * - **posted** - rewrite body and meta together in one write, then forget it.
 *
 * Tolerates a null `pending` so every caller can hand it a lookup result without a guard: a
 * resolution for a request that was never tracked (a replay, a decision we already recorded) is a
 * legitimate no-op, not an error.
 */
function settleApproval(agent: RoomAgent, pending: PendingApproval | null, outcome: ApprovalOutcome): void {
  if (pending === null) return
  if (pending.posting) {
    pending.settled = outcome
    return
  }
  if (pending.hold !== null) clearTimeout(pending.hold)
  pending.hold = null
  agent.approvals.delete(pending.requestId)
  // The turn is only unblocked when NOTHING is left open - see the `permission_resolved` comment.
  if (agent.approvals.size === 0) agent.awaitingApproval = false
  if (pending.messageId === null) return
  const meta: ChatApprovalMeta = {
    kind: 'approval',
    requestId: pending.requestId,
    workerSessionId: agent.workerSessionId,
    toolName: pending.toolName,
    state: outcome.state,
    ...(pending.expiresAt === undefined ? {} : { expiresAt: pending.expiresAt }),
    decidedBy: outcome.decidedBy ?? null,
    decidedAt: Date.now(),
  }
  writeCard(agent.roomSlug, pending.messageId, resolvedCardBody(pending.body, outcome), meta)
}

/** Expire every card still open in this room. Called on every path that ends a turn. */
function expireApprovals(agent: RoomAgent): void {
  // A SNAPSHOT, not the live iterator: `settleApproval` deletes from this same map as it goes.
  // Deleting the current entry mid-iteration happens to be defined behaviour, but relying on that
  // makes the loop's correctness depend on a callee never touching a second entry.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const pending of [...agent.approvals.values()]) {
    settleApproval(agent, pending, { state: 'expired', decidedBy: null })
  }
}

/** What a decision attempt did, in one line the caller can hand straight to a human. */
export interface ChatAgentDecisionResult {
  ok: boolean
  detail: string
}

/** The human answering a card: a `users.id` and the display name written into the card's prose.
 *  Resolved from the principal or the directory - never taken from the request body. It carried a
 *  `role` until 2026-09-10, when roles were removed; membership was already the real rule (see
 *  chat-op-approvals.ts). */
export interface ApprovalActor {
  id: string
  display: string
}

/**
 * Answer an approval card of EITHER kind - the one mutation behind both cards' buttons.
 *
 * Two registries hold pending cards: this module's worker requests (keyed to a live session) and
 * the chat-op registry (keyed to nothing but the server's memory). A caller always names its card
 * by `requestId`, which is what the card it clicked carries. The router is
 * here rather than in either registry because the reply-grammar dispatch already lives here, and
 * the chat-op module must stay importable by this one without a cycle.
 *
 * A named id is looked up in the chat-op registry FIRST: those ids are minted here (UUIDs), while
 * a worker's are whatever the worker chose, so the one registry whose ids we control is the one
 * that can be asked "is this yours?" with certainty. The oldest-card rule compares the cards'
 * order keys (createdAt, unique per room) - the only ordering a reader can predict from what is
 * on their screen - rather than preferring one kind, because whichever was asked first is the one
 * a typed reply answers.
 */
export function decideApproval(input: {
  roomId: string
  /** Always named now. The card carries it, and since 2026-09-09 a card is the ONLY way to answer -
   *  so there is no longer a caller that has to mean "whichever one is oldest". */
  requestId: string
  workerSessionId?: string | null
  action: 'approve' | 'deny'
  reason?: string
  actor: ApprovalActor
}): ChatAgentDecisionResult {
  return hasChatOp(input.requestId) ? decideChatOp(input) : chatAgentDecide(input)
}

/**
 * Answer a WORKER approval from the channel.
 *
 * **Fully synchronous, and that is load-bearing.** Two people clicking Approve in the same second
 * must not both reach `handle.approve`: the second would answer a request the worker has already
 * resolved, and the card would be rewritten twice with two different names on it. Because nothing
 * here awaits, the entry is found and deleted inside one turn of the event loop, so the second
 * caller finds nothing and is told so.
 *
 * `workerSessionId` is checked when the caller supplies one, so a card left on screen from a
 * session that has since been replaced cannot answer a fresh turn's question - the request ids are
 * a worker's, and nothing stops two sessions minting the same one.
 */
function chatAgentDecide(input: {
  roomId: string
  requestId: string
  workerSessionId?: string | null
  action: 'approve' | 'deny'
  reason?: string
  actor: ApprovalActor
}): ChatAgentDecisionResult {
  const agent = rooms.get(input.roomId)
  if (agent === undefined) {
    return { ok: false, detail: 'there is no agent session in this room right now' }
  }
  if (
    input.workerSessionId !== undefined &&
    input.workerSessionId !== null &&
    input.workerSessionId !== agent.workerSessionId
  ) {
    return { ok: false, detail: 'that card belongs to an earlier session - it can no longer be answered' }
  }
  const pending = agent.approvals.get(input.requestId) ?? null
  if (pending === null) {
    return { ok: false, detail: 'nothing is waiting for a decision here' }
  }
  // A card whose write has not landed cannot be answered yet: the outcome would be recorded
  // against a message id nobody has, and `postApprovalCard` would then apply a decision made
  // before the room could see what it was deciding.
  if (pending.posting) {
    return { ok: false, detail: 'that card is still being posted - try again in a moment' }
  }

  // Checked rather than caught, because `approve`/`deny` DO NOT THROW on a dead socket: the client
  // buffers the frame and retries the reconnect forever. A decision taken while the worker is down
  // would therefore stamp "**Approved** by <name>" onto a card for work that will never run - a
  // permanent audit record of a grant that had no effect. Refusing is the honest answer, and the
  // card stays answerable for when the socket is back.
  if (!agent.connected) {
    return { ok: false, detail: 'the agent worker is not reachable right now - try again in a moment' }
  }

  const reason = (input.reason ?? '').trim()
  try {
    if (input.action === 'approve') agent.handle.approve(pending.requestId)
    else agent.handle.deny(pending.requestId, reason.length > 0 ? reason : `denied by ${input.actor.id}`)
  } catch (error) {
    // Not expected to fire (see above) and kept anyway: the alternative to a belt here is a card
    // silently consumed by a client that grew a throw.
    return { ok: false, detail: `I could not send that decision: ${reasonOf(error)}` }
  }
  // AFTER the send. Safe against the double-click race for the same reason the whole function is:
  // no await splits the send from the delete inside `settleApproval`.
  settleApproval(agent, pending, {
    // The ID goes in `meta` and the DISPLAY NAME goes in the prose (`resolvedCardBody` renders
    // `decidedByDisplay`). A forever audit record must key on the stable identifier, not on a
    // mutable non-unique label - this repo has already paid for that lesson once, with a display
    // name that resolved on exactly one machine and nowhere else.
    state: input.action === 'approve' ? 'approved' : 'denied',
    decidedBy: input.actor.id,
    decidedByDisplay: input.actor.display,
    reason,
  })
  // Re-arm the silence watchdog with a FRESH window, rather than counting the minutes the room
  // spent deciding. Necessary rather than tidy: the watchdog was stood down while the turn was
  // blocked, and if the approved work then hangs without emitting anything, no event will ever
  // come along to re-arm it - which is the exact wedge the watchdog exists to catch.
  //
  // `armWatchdog` refuses while `awaitingApproval` is still set, and `settleApproval` clears that
  // flag ONLY once nothing is left open - so a turn still blocked on a second card correctly keeps
  // the watchdog standing down. Clearing the flag here would be finding #3 all over again.
  armWatchdog(input.roomId, agent)
  return {
    ok: true,
    detail: input.action === 'approve' ? 'approved' : 'denied',
  }
}


/**
 * The assistant text carried by one `stream_delta`, or `''` for a delta that must not reach chat.
 *
 * The worker's `event` field is an opaque passthrough of the ENGINE's own streaming event
 * (`{ type: string; [key: string]: unknown }`), so every field is checked rather than trusted.
 * Both runners normalize to the same Anthropic-shaped envelope, which is why one reader serves
 * codex and claude alike: `content_block_delta` wrapping either a `text_delta` or a
 * `thinking_delta`.
 *
 * Two kinds are dropped on purpose:
 * - **`thinking_delta`** - reasoning is the worker's transcript, not the channel. Streaming it
 *   would put the model's private deliberation in front of the whole team, and it is exactly the
 *   content `textOf` already refuses for completed blocks.
 * - **sub-agent deltas** (`parentToolUseId !== null`) - same rule `assistant_message` applies:
 *   sub-agent chatter belongs in the transcript.
 */
function assistantTextDelta(event: Extract<SessionEvent, { type: 'stream_delta' }>): string {
  if (event.parentToolUseId !== null) return ''
  const inner = event.event
  if (inner.type !== 'content_block_delta') return ''
  const delta: unknown = inner.delta
  if (typeof delta !== 'object' || delta === null) return ''
  const shape = delta as { type?: unknown; text?: unknown }
  if (shape.type !== 'text_delta') return ''
  return typeof shape.text === 'string' ? shape.text : ''
}

/**
 * Show the room what the turn has written so far, if there is anything new worth writing.
 *
 * Deliberately timer-free. A pending timer would be a second writer racing the turn's own
 * `turn_result`, and the failure it produces is the worst one available here: a stale partial
 * landing AFTER the final answer, leaving the room reading a truncated reply forever. Flushing
 * only on the events that carry text means the terminal write is always last by construction.
 *
 * The cost of that choice is that the final few tokens before a pause are not shown until the next
 * event - which is invisible, because `turn_result` writes the complete body moments later.
 *
 * An ORPHAN turn (no placeholder) streams nothing: there is no message to fill in, and its text is
 * posted whole when the turn ends.
 */
function streamInto(roomId: string, agent: RoomAgent, force = false): void {
  const turn = agent.turn
  if (turn === null || turn.messageId === null) return
  const body = turn.text.poll(Date.now(), force)
  if (body === null) return
  // The same write the terminal path uses: body + the `message.edited` ephemeral both clients
  // already replace-by-id on. A partial checkpoint and a final one differ only in what comes next.
  finalize(agent.roomSlug, turn.messageId, body)
}

/**
 * The turn this session is producing text for, creating an ORPHAN turn when this server has none.
 *
 * There is one real window that produces an orphan, and it is on the feature's promoted path.
 * A second mention folds into a turn that has ALREADY ended on the worker (the `turn_result` was
 * in flight when the server decided to fold), so the worker starts a FRESH turn while the server
 * clears the one it thought was running. Without adoption every event of that new turn would hit a
 * null turn and be dropped: the asker gets silence, having already been charged for the turn.
 *
 * An orphan carries no placeholder (`messageId: null`), so `deliver` posts its text as a new
 * message rather than filling one in.
 */
function adopt(agent: RoomAgent): TurnState | null {
  // A turn we deliberately abandoned must not come back as an orphan - see `discarding`.
  if (agent.discarding) return null
  if (agent.turn === null) {
    agent.turn = {
      messageId: null,
      startedAt: Date.now(),
      text: new AgentTurnText(),
      approvalCards: 0,
      capNoticed: false,
      // No ask to hang off - an orphan's text lands as a new top-level message, which is also
      // the only honest place for it: nobody asked it here.
      threadRootId: null,
    }
  }
  return agent.turn
}

/**
 * The durable trace of a finished turn, stamped onto the answer it produced.
 *
 * Built from the turn and the activity tracker rather than from the last frame, because the frame
 * a client holds may be several signals stale by the time a turn ends - and `toolCount` is the one
 * number a reader asks about afterwards ("what did it actually do?"), so it must be the final one.
 */
function turnRecord(agent: RoomAgent, turn: TurnState, state: 'done' | 'error'): ChatAgentTurnMeta {
  return {
    kind: 'agent-turn',
    workerSessionId: agent.workerSessionId,
    startedAt: turn.startedAt,
    endedAt: Date.now(),
    toolCount: agent.activity.current().toolCount,
    state,
  }
}

/**
 * Land a turn's text: into the row it is writing, or as a NEW message when it has none.
 *
 * Two ways to have none, and they want the same write. An ORPHAN turn never had a placeholder
 * (the server did not know it had started, so nothing was posted to fill in). A SPLIT turn had one and
 * closed it to let an approval card through (`closeTurnRow`), then ended before `openTurnRow`
 * landed the next one. Both are "post what is left, wherever the turn lives".
 *
 * The record rides along on that post since 2026-09-09. It used to be dropped, which was defensible
 * when only orphans reached here - an orphan is already a turn this server never saw start. It is not
 * defensible for a split turn, which is an ordinary turn that happened to be interrupted by a card:
 * losing its record would take the "session" link off a perfectly normal answer.
 *
 * Fire-and-forget: this runs inside a synchronous socket callback, and a failed post must not
 * propagate into the handle's event dispatch.
 */
function deliver(slug: string, turn: TurnState, body: string, record?: ChatAgentTurnMeta): void {
  if (turn.messageId !== null) {
    finalize(slug, turn.messageId, body, record)
    return
  }
  void postAsAgent(slug, clamp(body), record ?? null, turn.threadRootId).catch(() => undefined)
}

/** Text blocks only, in order. Thinking and tool calls are the worker's transcript, not chat. */
function textOf(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content.trim()
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

const assembled = (turn: TurnState): string => turn.text.render()

/**
 * Write the turn's text into its placeholder and tell the room.
 *
 * Used for BOTH the mid-turn checkpoints that make a turn stream (see `streamInto`) and the final
 * write when the turn ends - they are the same operation, and the row carries no "still writing"
 * state, so a client that misses a partial simply sees the next one. `checkpointBody` never sets
 * `edited_at`, so a turn that checkpointed forty times still shows no "(edited)" marker.
 *
 * The announcement rides the EXISTING `message.edited` ephemeral carrying the final row with
 * `editedAt: null`. Both shipped clients already replace-by-id on that frame and neither renders
 * "(edited)" when `editedAt` is null - so even the delta-ignorant Flutter client gets the finished
 * answer live, with zero client changes. A new `message.finalized` type was rejected for exactly
 * that reason: it would leave every un-updated client showing "…" until the next history fetch,
 * for no gain over a frame both clients already understand as "this stored row changed".
 */
function finalize(slug: string, messageId: string, body: string, record?: ChatAgentTurnMeta): void {
  try {
    const store = chatStore()
    const room = store.roomBySlug(slug)
    if (!room) return
    // `record` is set ONLY on the write that ends a turn, never on a mid-turn checkpoint: it is the
    // durable trace of the turn, and stamping it forty times would be forty identical rewrites of a
    // column whose value is only knowable at the end anyway. Same statement either way - the card
    // path already writes body and meta together under the same sender+room+id clause. A deleted
    // placeholder matches nothing and the write is silently dropped: the delete wins.
    const stored =
      record === undefined
        ? store.checkpointBody(room.id, messageId, systemUserId(), clamp(body))
        : store.checkpointCard(room.id, messageId, systemUserId(), clamp(body), record)
    if (stored === null) return
    emitChatEvent({
      ephemeral: true,
      type: 'message.edited',
      roomId: stored.roomId,
      userId: null,
      payload: stored,
      at: Date.now(),
    })
  } catch {
    /* a failed finalize must not tear the session down; the body converges on the next turn */
  }
}

/**
 * The 8000-char contract every client sized its rendering to (`ChatPostInputDto`). Track 16 splits
 * a long turn into continuation messages at paragraph breaks; until then, keep the promise and say
 * plainly that the rest was cut rather than letting a client meet a body it was never promised.
 */
const BODY_LIMIT = 8000

/** What a turn's message says before it has written anything. Recovery checks for it by value. */
const PLACEHOLDER_BODY = '…'
const clamp = (body: string): string =>
  body.length <= BODY_LIMIT ? body : `${body.slice(0, BODY_LIMIT - 40).trimEnd()}\n\n(…truncated)`

/**
 * Point the room's `streaming_message_id` at a different row, mid-turn.
 *
 * Restart recovery finds a wedged turn by that column and fills the row in with an apology, so it
 * has to name the row the turn is currently writing into - which changes every time an approval
 * card splits the turn (see `openTurnRow`). Leaves `turn_started_at` and every budget column
 * exactly as they are: this is a pointer move inside one turn, not the start of another.
 */
function repointStreamingRow(roomId: string, streamingMessageId: string): void {
  try {
    const store = chatStore()
    const session = store.agentSession(roomId)
    if (session) store.agentSessionSave({ ...session, streamingMessageId })
  } catch {
    /* recovery converges on the next turn; never throw out of an event callback */
  }
}

/** Clear the row's mid-turn pointers. The budget columns are deliberately left alone. */
function settleRow(roomId: string): void {
  try {
    const store = chatStore()
    const session = store.agentSession(roomId)
    if (session) store.agentSessionSave({ ...session, streamingMessageId: null, turnStartedAt: null })
  } catch {
    /* the row converges on the next turn; never throw out of an event callback */
  }
}

/** Stop both timers. Called on every path that stops owning the session. */
function clearTimers(agent: RoomAgent): void {
  if (agent.idleTimer !== null) clearTimeout(agent.idleTimer)
  if (agent.watchdog !== null) clearTimeout(agent.watchdog)
  agent.idleTimer = null
  agent.watchdog = null
  // The hold timers too. They are per-REQUEST rather than per-session, so they are the one family
  // of timers that would otherwise survive the session they belong to - each waking up to post a
  // card into a room whose handle has already been detached.
  for (const pending of agent.approvals.values()) {
    if (pending.hold !== null) clearTimeout(pending.hold)
    pending.hold = null
  }
}

/**
 * Arm (or re-arm) the idle TTL. Only meaningful between turns - a running turn is not idle, and
 * `settle` is what re-arms it once the turn ends.
 */
function armIdle(roomId: string, agent: RoomAgent): void {
  if (agent.idleTimer !== null) clearTimeout(agent.idleTimer)
  agent.idleTimer = setTimeout(() => {
    // Re-check under the room queue: a mention may have arrived while the timer was pending.
    serialize(roomId, async () => {
      const live = rooms.get(roomId)
      if (live !== agent) return
      if (live.turn !== null) {
        // A turn started after the timer was armed. Not idle; the next settle re-arms.
        armIdle(roomId, live)
        return
      }
      retire(roomId, live)
    })
  }, SESSION_IDLE_TTL_MS)
  // A pending TTL must never hold the process open.
  agent.idleTimer.unref?.()
}

/** Arm the per-turn silence watchdog, unless the turn is legitimately blocked on an approval. */
function armWatchdog(roomId: string, agent: RoomAgent): void {
  if (agent.watchdog !== null) clearTimeout(agent.watchdog)
  agent.watchdog = null
  if (agent.turn === null || agent.awaitingApproval) return
  agent.watchdog = setTimeout(() => {
    const live = rooms.get(roomId)
    if (live !== agent || live.turn === null || live.awaitingApproval) return
    const turn = live.turn
    const body = assembled(turn)
    const note = `no activity for ${Math.round(TURN_SILENCE_LIMIT_MS / 60_000)} minutes - I interrupted this turn`
    // Interrupt first so the worker stops, then say so honestly. A partial answer is reported as
    // partial: a wedged turn must never read as a completed one.
    try {
      live.handle.interrupt()
    } catch {
      /* the handle may already be dead; the finalize below is what the room needs either way */
    }
    publishActivity(roomId, live, [{ kind: 'error', detail: 'silence' }])
    expireApprovals(live)
    live.turn = null
    live.discarding = true
    deliver(live.roomSlug, turn, body ? `${body}\n\n(${note})` : `(${note})`, turnRecord(live, turn, 'error'))
    settleRow(roomId)
    armIdle(roomId, live)
  }, TURN_SILENCE_LIMIT_MS)
  agent.watchdog.unref?.()
}

/**
 * Deliberately retire a live session: tell the WORKER to close it, then forget it.
 *
 * The distinction from `drop` matters. `drop` reacts to a session that is already gone, so it only
 * lets go of our end. This one is us deciding to end a session that is still alive, and detaching
 * without closing is exactly how the worker accumulates orphans - each holding an engine process -
 * one per server restart, forever.
 */
function retire(roomId: string, agent: RoomAgent): void {
  try {
    agent.handle.closeSession()
  } catch {
    /* best effort: if the worker is unreachable the session is not ours to tidy anyway */
  }
  drop(roomId)
}

/** Forget a dead session so the next mention recreates one. */
function drop(roomId: string): void {
  const agent = rooms.get(roomId)
  if (!agent) return
  // Unconditional, and idempotent on the session-death path (the map is already empty there). It
  // makes "no posted card outlives its session" an invariant of LETTING GO rather than a property
  // of having covered every caller: the idle-TTL retire is otherwise a route to a forever-pending
  // card whose buttons answer "there is no agent session in this room right now".
  expireApprovals(agent)
  clearTimers(agent)
  agent.stopListening()
  agent.handle.detach()
  rooms.delete(roomId)
  // The ROW SURVIVES, and that is the point: it carries the room's turn budget. Deleting it here
  // would reset the backstop exactly when a session is failing repeatedly - handing an unlimited
  // window to the one room that is misbehaving. Nothing reads `worker_session_id` to decide
  // whether to recreate (the in-memory `rooms` map does that), so a stale id costs nothing and
  // the next turn overwrites it.
  settleRow(roomId)
}
