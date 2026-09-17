// The chat agent's APPROVAL rules (chat Track 19): what a card says, what a reply means, and how
// many cards one turn may post.
//
// Here rather than in apps/server for the same reason as `agent-trigger.ts`: @silkweave/box-core is the only
// package with tests, and every rule below would otherwise be exercised only by a live worker
// raising a real permission request for real write-shaped work. The server module stays the I/O
// shell - sockets, timers, the store - around these pure functions.
//
// Nothing here touches the network, the clock (except through an injected `now`), or the store.

import type { ChatApprovalMeta } from './types.js'

/**
 * How long a permission request must stay unresolved before it is worth a message in the channel.
 *
 * The problem this solves is specific and was measured, not imagined: `questionBehavior: 'deny'`
 * already emits `permission_requested` immediately followed by
 * `permission_resolved{ resolvedBy: 'policy' }` for every AskUserQuestion, and a runner's own
 * policy rules resolve others the same way. A naive card-per-request would post, then instantly
 * strike through, several times a turn - training everyone to ignore the surface that exists to
 * be read. Anything that settles inside this window never reaches the room at all.
 *
 * Three seconds rather than one: a policy round-trip is milliseconds, and the cost of being
 * generous is three seconds of delay on a decision a human will take a minute to make anyway.
 */
export const APPROVAL_HOLD_MS = 3_000

/**
 * The most approval cards ONE turn may post into a room.
 *
 * A card is a durable message that badges the room, so an agent looping over fifty files is a
 * badge storm and a transcript nobody will scroll past. Past the cap the requests are still
 * answered - by the worker's own timeout policy, exactly as an unattended turn behaves today - and
 * the room is told once that it happened rather than being told fifty more times.
 */
export const APPROVAL_CARDS_PER_TURN = 8

/**
 * How long the WORKER waits before resolving a request with its timeout policy (a deny).
 *
 * Raised from the worker's 5 minute default to a human-paced 30 minutes, and this is the change
 * that was deliberately held back until now: until the channel could answer, that 5 minute default
 * was the only thing UNBLOCKING a turn nobody could approve. Raising it first would have made a
 * blocked turn hang six times longer for no gain. It ships WITH the cards, and with the watchdog
 * standing down while a turn is legitimately waiting (`awaitingApproval`), or the silence limit
 * would interrupt the very turn the room is deciding about.
 */
export const APPROVAL_TIMEOUT_MS = 30 * 60_000

/** The runner-authored framing of one request, as far as a card cares. */
export interface ApprovalCardInput {
  toolName: string
  /** Short noun phrase for the action, e.g. "Read file". */
  displayName?: string | undefined
  /** The full prompt sentence, e.g. "Claude wants to read foo.txt". */
  title?: string | undefined
  /** The subtitle, e.g. "Claude will have read access to ~/x". */
  description?: string | undefined
  /** Why the request was raised - for codex this is usually a sandbox refusal after the fact. */
  decisionReason?: string | undefined
  /**
   * The RAW tool input the runner is asking permission for (`PermissionRequest.input`).
   *
   * Only `command` is read, and only to render it as a fenced block instead of as a sentence. It
   * is the one field here that is model-authored rather than runner-authored, which is why nothing
   * else in it is touched: framing comes from the runner, and this is a quotation.
   */
  input?: Record<string, unknown> | undefined
}

/** No single runner-authored field may take over the transcript. Generous, but bounded. */
const FIELD_LIMIT = 400

/** A command gets more room than a sentence: it is the thing being decided about, and a truncated
 *  one is worse than useless - you cannot approve half a pipeline. Still bounded. */
const CODE_LIMIT = 1200

/** Tools whose request is a shell command, for the fallback in `commandOf`. `CodexCommand` and
 *  `Bash` both land here; a `Read` or an `Edit` never does. */
const COMMAND_TOOL = /bash|shell|command|exec|terminal/i

/**
 * Collapse one caller-authored field into a single safe line of markdown.
 *
 * Every field here is written by the RUNNER (or, for a chat-op card, the server), not the model -
 * but it quotes model-chosen or user-chosen content (a command line, a file path, a display name),
 * so it is untrusted for RENDERING purposes even though it is trusted for framing. Newlines are
 * collapsed so a crafted field cannot forge the card's own footer or a second heading, and the
 * whole thing is length-capped. Exported for the chat-op card, which is built to the same rules.
 */
export function cardField(value: string | undefined): string | null {
  if (value === undefined) return null
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return null
  return flat.length <= FIELD_LIMIT ? flat : `${flat.slice(0, FIELD_LIMIT - 1).trimEnd()}…`
}

/**
 * The body of an approval card in its PENDING state.
 *
 * Renders the runner's own `title` / `description` / `decisionReason` rather than composing a
 * "the agent wants to run X" sentence, because the two engines do not share a TENSE: Claude asks
 * before a tool runs, while codex's command approval is usually an escalation AFTER its sandbox
 * already refused ("command failed; retry without sandbox?"). A sentence we wrote would be wrong
 * for one of them, and the runner is the only thing that knows which.
 *
 * NO REPLY GRAMMAR since 2026-09-09. The body used to end with "Reply `@nova approve` or `@nova deny
 * <reason>`", so a client that knew nothing about `meta` could still fulfil a decision by typing.
 * Both shipped clients render the card and its buttons now, and the footer was costing every card
 * a paragraph of instructions nobody used - see `parseAgentDirective` for the other half of the
 * removal. A card is answered by pressing a button, and by nothing else.
 */
export function approvalCardBody(input: ApprovalCardInput): string {
  const heading = cardField(input.displayName) ?? cardField(input.toolName) ?? 'a tool'
  const command = commandOf(input)
  const parts: string[] = [`**Approval needed - ${heading}**`]
  // DEDUPED against each other and against the command block (2026-09-09). The runners repeat
  // themselves: codex sent an identical `title` and `decisionReason` on every command card, and put
  // the command line in `description` as well - so a card said the same sentence twice and quoted
  // the command as prose underneath. Three paragraphs of noise on the surface whose whole job is to
  // be read before somebody grants a permission.
  const seen = new Set<string>()
  if (command !== null) seen.add(fold(command))
  const add = (value: string | undefined, wrap?: (text: string) => string): void => {
    const text = cardField(value)
    if (text === null) return
    const key = fold(text)
    if (seen.has(key)) return
    seen.add(key)
    parts.push(wrap === undefined ? text : wrap(text))
  }
  add(input.title)
  add(input.description)
  add(input.decisionReason, (text) => `_${text}_`)
  // LAST, and fenced: the command is what a reader checks before clicking, so it wants to sit
  // directly above the buttons rather than be buried between two sentences.
  if (command !== null) parts.push(fenced(command))
  return parts.join('\n\n')
}

/** Case- and whitespace-insensitive identity, for the dedupe above only. */
const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * The shell command this request is about, or null when it is not about one.
 *
 * `input.command` FIRST, because it is the actual argument the tool was called with rather than a
 * sentence written about it - Claude's `Bash` puts the command there and describes it in English in
 * `description`, so reading the prose would fence "List the files in docs" as if it were shell.
 *
 * The fallback exists because codex's command approval carries no `input.command` and puts the
 * command line in `description`. It is deliberately narrow - a command-shaped TOOL, and a field
 * that reads like a command line rather than like a sentence - because getting it wrong renders an
 * ordinary English subtitle in a monospace block, which reads as a bug.
 */
function commandOf(input: ApprovalCardInput): string | null {
  const raw = input.input?.['command']
  const argv =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw) && raw.every((part) => typeof part === 'string')
        ? raw.join(' ')
        : undefined
  const fromInput = codeField(argv)
  if (fromInput !== null) return fromInput
  if (!COMMAND_TOOL.test(input.toolName)) return null
  const described = codeField(input.description)
  return described !== null && looksLikeCommand(described) ? described : null
}

/** A shell-ish shape: a pipe/redirect/separator, a `-x`/`--x` flag, or an absolute path up front. */
const looksLikeCommand = (text: string): boolean => /[|&;><$]|(?:^|\s)--?\w|^\S*\//.test(text)

/**
 * A field kept as CODE: newlines survive (a script is not a sentence), and it is capped.
 *
 * The counterpart to `cardField`, which flattens newlines precisely so a crafted value cannot forge
 * a second paragraph. That defence is not needed here and would be wrong - what protects the fence
 * is `fenced` sizing itself past any backtick run in the content.
 */
function codeField(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.replace(/\r\n/g, '\n').trim()
  if (trimmed.length === 0) return null
  return trimmed.length <= CODE_LIMIT ? trimmed : `${trimmed.slice(0, CODE_LIMIT - 1).trimEnd()}…`
}

/**
 * Wrap a command in a `bash` fence the content cannot break out of.
 *
 * The fence is one backtick longer than the longest run inside it, which is CommonMark's own rule.
 * A fixed three-backtick fence would let a command containing ``` close it early and spill the rest
 * of the card - including the status line - into the room as ordinary markdown.
 */
function fenced(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length))
  const ticks = '`'.repeat(Math.max(3, longest + 1))
  return `${ticks}bash\n${code}\n${ticks}`
}

/** What a settled card says at the bottom, in place of the reply grammar. */
export interface ApprovalOutcome {
  state: ChatApprovalMeta['state']
  /**
   * The `users.id` of the human who answered, or null when the worker resolved it itself.
   *
   * The ID, not the name. It is what lands in the card's `meta` and therefore what the audit
   * record keys on forever, and a display name is mutable and non-unique - the wrong thing to
   * pin history to.
   */
  decidedBy?: string | null
  /** That human's display name, for the PROSE. Falls back to the id when it is not supplied. */
  decidedByDisplay?: string | null
  /** The reason a denial carried, if any. */
  reason?: string | undefined
}

/**
 * Rewrite a card for its settled state, keeping everything above the footer.
 *
 * The card is updated IN PLACE (one `checkpointCard` write, no new key), so the transcript holds
 * one row per decision saying what was asked and who answered - forever, and without a second
 * message per approval turning a working channel into an audit log.
 *
 * Takes the pending body rather than the request so a card written by an older version of this
 * function still resolves correctly: the footer is identified by its own text, and a body that
 * does not carry it simply gets the status appended.
 */
export function resolvedCardBody(pendingBody: string, outcome: ApprovalOutcome): string {
  const above = pendingBody.split('\n\n').filter((part) => !isFooter(part))
  above.push(approvalStatusLine(outcome))
  return above.join('\n\n')
}

/**
 * A paragraph this function owns: the reply grammar, or a status line it wrote earlier.
 *
 * Dropping a PREVIOUS status line matters even though the caller enforces the one-way rule. The
 * caller's rule lives in one process's memory, and the alternative to being robust here is a card
 * that reads "**Approved** by Dan. **Denied** by Dan." - a transcript row that contradicts itself
 * forever, which is the one thing a durable audit record must not do.
 */
const isFooter = (part: string): boolean =>
  // The `Reply ...` prefix is LEGACY and stays forever: cards written before 2026-09-09 carry that
  // paragraph, and one of them settling years from now must still have it replaced by the status
  // line rather than stacking a second footer under instructions that no longer work.
  part.startsWith('Reply `@abi approve`') || /^\*\*(Approved|Denied|Expired|Pending)\b/.test(part)

/** The one line a settled card ends with. Exported for the tests that pin its wording. */
export function approvalStatusLine(outcome: ApprovalOutcome): string {
  const who = cardField(outcome.decidedByDisplay ?? outcome.decidedBy ?? undefined)
  const reason = cardField(outcome.reason)
  if (outcome.state === 'approved') return who === null ? '**Approved.**' : `**Approved** by ${who}.`
  if (outcome.state === 'denied') {
    const by = who === null ? '**Denied.**' : `**Denied** by ${who}.`
    return reason === null ? by : `${by} ${reason}`
  }
  if (outcome.state === 'expired') return '**Expired** - nobody answered in time, so it was refused.'
  return '**Pending.**'
}

/**
 * A settled card's body MINUS the status line, for a client whose own chrome already shows it.
 *
 * Both clients render the decision in the card's header ("Approved by Alice Strand, 06:47"),
 * so the stored body's closing "**Approved** by Alice Strand." repeats it three lines further
 * down. The line stays in the STORED body deliberately - that body is the durable audit record and
 * has to read correctly in a raw dump, in a search result, or on any client that never learns what
 * `meta` is - and is dropped only at render time.
 *
 * Mirrored in `ApprovalCard.tsx` and `agent_activity.dart`, which cannot import this package. This
 * is the source of truth for the rule; keep the three in step.
 */
export function approvalCardProse(body: string): string {
  const parts = body.split('\n\n')
  const last = parts.at(-1)
  if (last !== undefined && /^\*\*(Approved|Denied|Expired|Pending)\b/.test(last)) parts.pop()
  return parts.join('\n\n').trim()
}

/** The message posted once, when a turn hits `APPROVAL_CARDS_PER_TURN`. */
export function approvalCapNotice(limit: number = APPROVAL_CARDS_PER_TURN): string {
  return `I have asked for ${limit} approvals in this turn, which is the cap, so I am not posting any more cards. Anything else I needed permission for was refused - ask again if you want me to take another run at it.`
}
