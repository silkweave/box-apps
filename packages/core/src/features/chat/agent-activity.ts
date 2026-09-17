/**
 * What the room is told an agent turn is DOING, and the rule that keeps it safe to say.
 *
 * The channel gets one short line ("reading WAREHOUSE.md", "querying the warehouse"); the full
 * transcript stays behind the authenticated session viewer. That split is the design: names in the
 * channel, arguments in the auth-gated viewer. Summarizing here rather than on each client is what
 * makes it a real boundary - raw arguments never cross the chat wire at all, so no client bug can
 * leak them, there is one implementation instead of a TS one and a Dart one, and every reader sees
 * the same line.
 *
 * Engine-agnostic on purpose: this module never imports the worker protocol (core depends on
 * nothing here), so the server adapts its events into `AgentActivitySignal` and this stays pure and
 * testable. Same boundary `agent-trigger.ts` draws.
 */

/** A tool call as the summarizer needs it. `input` is READ here and never rendered verbatim. */
export interface AgentToolUse {
  name: string
  input?: unknown
}

/**
 * `waiting` means blocked on a human (an approval); `thinking`/`tool`/`writing` are progress.
 * `done` and `error` are terminal and tell a client to stop rendering a spinner.
 */
export type AgentActivityState = 'starting' | 'thinking' | 'tool' | 'writing' | 'waiting' | 'done' | 'error'

export interface AgentActivity {
  state: AgentActivityState
  /** One line, already sanitized and clamped. Safe to render in a channel verbatim. */
  label: string
  /** Tool calls seen this turn. Monotonic, so a client can say "12 steps" without a log. */
  toolCount: number
}

/** What the server observed, in terms this module understands. */
export type AgentActivitySignal =
  | { kind: 'turn_start' }
  | { kind: 'thinking' }
  | { kind: 'tool'; use: AgentToolUse }
  | { kind: 'tool_failed' }
  | { kind: 'writing' }
  | { kind: 'awaiting_approval'; toolName?: string }
  | { kind: 'approval_resolved' }
  | { kind: 'done' }
  | { kind: 'error'; detail?: string }

/** Longest label we will ever emit. A channel line, not a log line. */
const LABEL_LIMIT = 80
/** Longest sanitized argument fragment inside a label. */
const ARG_LIMIT = 60
/** A tool name we are willing to echo when we have no table entry for it. */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,40}$/

/** Input keys that may hold a path, in the order we prefer them. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath']

/**
 * Reduce one argument to something safe to say out loud.
 *
 * The whole safety story is that this is the ONLY way a value from `input` reaches a label, and it
 * always narrows: a path becomes its basename, a URL becomes its host, control characters and
 * newlines go, and the result is clamped. A basename is accepted exposure - "reading
 * credentials.json" names what was touched without disclosing a byte of it - while a command line,
 * a SQL string or a search pattern has no narrowing that keeps it useful, so those are never
 * rendered at all (see `labelForTool`, which answers with a fixed phrase instead).
 */
export function sanitizeArg(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // Control characters collapse to spaces: a label is ONE line, and a stray newline could
  // otherwise forge what reads as a second line of chat. Escapes, never literal bytes - matching
  // control characters is the POINT here, which is what the disable below records.
  // oxlint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, ' ')
  const flat = stripped.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return null
  const cut = flat.length > ARG_LIMIT ? `${flat.slice(0, ARG_LIMIT - 1)}…` : flat
  return cut
}

/** Last path segment, sanitized. Never the directory: the tree layout is not the room's business. */
export function basenameOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.replace(/[/\\]+$/, '')
  const segment = trimmed.split(/[/\\]/).pop() ?? ''
  return sanitizeArg(segment)
}

/** Host only. A path or query string can carry identifiers, and the host is enough to be useful. */
export function hostOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    return sanitizeArg(new URL(raw).host)
  } catch {
    return null
  }
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const firstPath = (input: unknown): string | null => {
  const record = asRecord(input)
  for (const key of PATH_KEYS) {
    const found = basenameOf(record[key])
    if (found !== null) return found
  }
  return null
}

/**
 * Split an MCP tool name into server and tool.
 *
 * Two spellings are live: Claude's `mcp__<server>__<Tool>` and codex's `<server>.<tool>`. Both are
 * matched loosely on purpose - a name we cannot split still ends up in the safe fallback rather
 * than in an exception.
 */
export function splitMcpName(name: string): { server: string; tool: string } | null {
  const underscored = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name)
  if (underscored) return { server: underscored[1], tool: underscored[2] }
  const dotted = /^([a-z0-9-]+)\.([A-Za-z0-9_-]+)$/.exec(name)
  if (dotted) return { server: dotted[1], tool: dotted[2] }
  return null
}

/**
 * One tool call becomes one human line.
 *
 * Keyed on the tool NAME, with at most one sanitized argument. Anything whose argument cannot be
 * narrowed safely (a shell command, a SQL string, a search pattern) gets a fixed phrase instead -
 * the room learns that a command ran without learning which, and the viewer has the rest.
 */
export function labelForTool(use: AgentToolUse): string {
  const name = use.name
  const input = use.input

  const mcp = splitMcpName(name)
  if (mcp !== null) {
    // The warehouse is the one MCP call worth naming specially: it is frequent and "querying the
    // warehouse" reads far better than "calling warehouse: execute_query". Never the SQL.
    if (/^(execute_)?query$/i.test(mcp.tool) || /warehouse/i.test(mcp.server)) return 'querying the warehouse'
    const server = sanitizeArg(mcp.server)
    const tool = sanitizeArg(mcp.tool)
    return server !== null && tool !== null ? clampLabel(`calling ${server}: ${tool}`) : 'calling a tool'
  }

  if (/^(read|read_file|view)$/i.test(name)) {
    const file = firstPath(input)
    return clampLabel(file !== null ? `reading ${file}` : 'reading a file')
  }
  if (/^(edit|write|apply_patch|multiedit|notebookedit)$/i.test(name)) {
    const file = firstPath(input)
    return clampLabel(file !== null ? `editing ${file}` : 'editing a file')
  }
  // Never the command line. There is no narrowing of a shell command that stays both safe and
  // useful, and a half-quoted one is worse than none.
  if (/^(bash|shell|local_shell|run_command|exec)$/i.test(name)) return 'running a command'
  // Never the pattern: a search string is user data as often as it is a regex.
  if (/^(grep|glob|search|rg|codebase_search)$/i.test(name)) return 'searching the repo'
  if (/^(webfetch|web_fetch|fetch)$/i.test(name)) {
    const host = hostOf(asRecord(input)['url'])
    return clampLabel(host !== null ? `reading ${host}` : 'fetching a page')
  }
  if (/^(websearch|web_search)$/i.test(name)) return 'searching the web'
  if (/^(task|agent|codexagent)$/i.test(name)) return 'working on a subtask'

  return SAFE_TOOL_NAME.test(name) ? clampLabel(`using ${name}`) : 'working'
}

const clampLabel = (label: string): string =>
  label.length > LABEL_LIMIT ? `${label.slice(0, LABEL_LIMIT - 1)}…` : label

/** Minimum gap between two emissions that do NOT change state. */
export const ACTIVITY_THROTTLE_MS = 1_000

/**
 * Turns a stream of signals into at most one line per second, plus every state transition.
 *
 * The throttle is here rather than at the fan-out because this is where "did anything actually
 * change" is knowable: a tool loop firing ten times a second collapses to one frame carrying the
 * latest label and the running count, while a transition (into `waiting`, into `error`) is felt
 * immediately because those are the ones a person is waiting on.
 *
 * `now` is passed in rather than read, so the tests are not timing-dependent.
 */
export class AgentActivityTracker {
  #state: AgentActivityState = 'starting'
  #label = 'starting'
  #toolCount = 0
  #lastEmitAt = 0
  #emitted = false

  /** The activity as it stands, whether or not it was emitted. */
  current(): AgentActivity {
    return { state: this.#state, label: this.#label, toolCount: this.#toolCount }
  }

  /**
   * Fold one signal in. Returns the activity to broadcast, or null when nothing should be sent.
   *
   * Null means "no news": either nothing changed, or the change is a label-only tick inside the
   * throttle window. A caller may always ask `current()` instead - which is what the mid-turn join
   * path does, since a client arriving late needs the state, not the history.
   */
  observe(signal: AgentActivitySignal, now: number): AgentActivity | null {
    const previous = this.#state
    const previousLabel = this.#label

    switch (signal.kind) {
      case 'turn_start':
        this.#state = 'starting'
        this.#label = 'starting'
        this.#toolCount = 0
        break
      case 'thinking':
        this.#state = 'thinking'
        this.#label = 'thinking'
        break
      case 'tool':
        this.#state = 'tool'
        this.#label = labelForTool(signal.use)
        this.#toolCount += 1
        break
      case 'tool_failed':
        // Deliberately not an error state: the model routinely recovers from a failed call, and
        // showing `error` here would claim the TURN failed when it has not.
        this.#state = 'tool'
        this.#label = 'a tool call failed - continuing'
        break
      case 'writing':
        this.#state = 'writing'
        this.#label = 'writing a reply'
        break
      case 'awaiting_approval': {
        this.#state = 'waiting'
        const tool = signal.toolName === undefined ? null : sanitizeArg(signal.toolName)
        this.#label = clampLabel(tool !== null ? `waiting for approval to use ${tool}` : 'waiting for approval')
        break
      }
      case 'approval_resolved':
        this.#state = 'tool'
        this.#label = 'continuing'
        break
      case 'done':
        this.#state = 'done'
        this.#label = 'done'
        break
      case 'error': {
        this.#state = 'error'
        // Sanitized like every other argument that reaches a label, not merely clamped. Today's
        // callers pass fixed strings and protocol enums, but `detail` is the one field on this
        // union that could plausibly be handed a raw worker message some day - and a newline in a
        // label forges what reads as a second line of chat.
        const detail = signal.detail === undefined ? null : sanitizeArg(signal.detail)
        this.#label = clampLabel(detail !== null ? `stopped: ${detail}` : 'stopped')
        break
      }
    }

    const changedState = this.#state !== previous
    const changedLabel = this.#label !== previousLabel
    if (!changedState && !changedLabel && this.#emitted) return null

    // A state transition is always felt immediately; a label-only tick waits its turn. Terminal
    // states bypass the throttle too - a client must never be left holding a stale spinner because
    // the last frame of a turn happened to land inside the window.
    const terminal = this.#state === 'done' || this.#state === 'error'
    if (!changedState && !terminal && this.#emitted && now - this.#lastEmitAt < ACTIVITY_THROTTLE_MS) return null

    this.#lastEmitAt = now
    this.#emitted = true
    return this.current()
  }
}
