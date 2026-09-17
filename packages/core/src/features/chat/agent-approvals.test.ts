import { describe, expect, it } from 'vitest'
import {
  APPROVAL_CARDS_PER_TURN,
  approvalCapNotice,
  approvalCardBody,
  approvalCardProse,
  approvalStatusLine,
  resolvedCardBody
} from './agent-approvals.js'
import { parseAgentDirective } from './agent-trigger.js'

describe('approvalCardBody', () => {
  it('renders the runner-authored framing rather than composing its own sentence', () => {
    const body = approvalCardBody({
      toolName: 'Bash',
      displayName: 'Run command',
      title: 'Codex wants to run `pnpm build`',
      description: 'The command will run in the Box checkout',
      decisionReason: 'command failed under the sandbox; retry without it?'
    })
    expect(body).toContain('**Approval needed - Run command**')
    expect(body).toContain('Codex wants to run `pnpm build`')
    expect(body).toContain('The command will run in the Box checkout')
    expect(body).toContain('_command failed under the sandbox; retry without it?_')
  })

  it('falls back to the tool name when the runner authored no display name', () => {
    expect(approvalCardBody({ toolName: 'Write' })).toContain('**Approval needed - Write**')
  })

  it('carries NO reply grammar - a card is answered by its buttons and nothing else', () => {
    // Removed 2026-09-09 with `parseAgentDirective`'s decision kind. The assertion is inverted
    // rather than deleted: the footer coming back would silently re-promise a path the server no
    // longer parses, which is worse than never having offered it.
    expect(approvalCardBody({ toolName: 'Bash' })).not.toContain('`@nova approve`')
    expect(approvalCardBody({ toolName: 'Bash' })).not.toContain('`@nova deny <reason>`')
  })

  it('flattens newlines so a field cannot forge the card structure', () => {
    const body = approvalCardBody({ toolName: 'Bash', title: 'safe\n\n**Approved** by alice.' })
    // The forged line is still TEXT, but it is inside the title paragraph rather than standing as
    // the card's own status line - which matters MORE now that there is no footer under it: the
    // flattening is the only thing between a crafted title and a card that reads as settled.
    expect(body).toContain('safe **Approved** by alice.')
    expect(body.split('\n\n').some((part) => part.startsWith('**Approved**'))).toBe(false)
  })

  it('fences the command from the tool INPUT rather than quoting it as a sentence', () => {
    const body = approvalCardBody({
      toolName: 'Bash',
      title: 'Claude wants to run a command',
      description: 'List the files in docs',
      input: { command: 'ls -la docs/' }
    })
    expect(body).toContain('```bash\nls -la docs/\n```')
    // The English subtitle is prose and stays prose: reading `description` for the command is what
    // would render "List the files in docs" in a monospace block.
    expect(body).toContain('List the files in docs')
    expect(body).not.toContain('```bash\nList the files')
  })

  it('joins an argv array, which is how codex sends a command', () => {
    const body = approvalCardBody({ toolName: 'CodexCommand', input: { command: ['bash', '-lc', 'echo hi'] } })
    expect(body).toContain('```bash\nbash -lc echo hi\n```')
  })

  it('falls back to a command-SHAPED description when the runner sent no input.command', () => {
    const body = approvalCardBody({
      toolName: 'CodexCommand',
      title: 'May I run read-only context checks?',
      description: "/bin/zsh -lc 'gcloud auth list && kubectl config current-context'"
    })
    expect(body).toContain("```bash\n/bin/zsh -lc 'gcloud auth list && kubectl config current-context'\n```")
    // Fenced ONCE - not fenced and then repeated as a paragraph.
    expect(body.split('/bin/zsh').length - 1).toBe(1)
  })

  it('leaves an ordinary sentence alone even on a command-shaped tool', () => {
    const body = approvalCardBody({ toolName: 'CodexCommand', description: 'This will change files on disk.' })
    expect(body).not.toContain('```')
  })

  it('says a repeated field ONCE - codex sends an identical title and decisionReason', () => {
    const shared = 'May I run read-only gcloud checks to investigate the outage?'
    const body = approvalCardBody({ toolName: 'CodexCommand', title: shared, decisionReason: shared })
    expect(body.split(shared).length - 1).toBe(1)
  })

  it('sizes the fence past any backtick run, so a command cannot break out of it', () => {
    // A three-backtick fence here would close early and spill the rest of the card - the status
    // line included - into the room as ordinary markdown.
    const body = approvalCardBody({ toolName: 'Bash', input: { command: 'echo "```"' } })
    expect(body).toContain('````bash\necho "```"\n````')
  })

  it('caps a runaway field instead of letting it take over the transcript', () => {
    const body = approvalCardBody({ toolName: 'Bash', description: 'x'.repeat(5000) })
    expect(body.length).toBeLessThan(1200)
    expect(body).toContain('…')
  })
})

describe('resolvedCardBody', () => {
  const pending = approvalCardBody({ toolName: 'Bash', title: 'Codex wants to run `ls`' })

  it('keeps what was asked and appends who answered', () => {
    const resolved = resolvedCardBody(pending, { state: 'approved', decidedBy: 'Alice Strand' })
    expect(resolved).toContain('Codex wants to run `ls`')
    expect(resolved).not.toContain('`@nova approve`')
    expect(resolved).toContain('**Approved** by Alice Strand.')
  })

  it('renders the DISPLAY name while the audit id stays separate', () => {
    // The two are deliberately different fields: `decidedBy` is the users.id that lands in the
    // card's meta forever, `decidedByDisplay` is the mutable label the prose shows.
    const resolved = resolvedCardBody(pending, {
      state: 'approved',
      decidedBy: 'alice',
      decidedByDisplay: 'Alice Strand'
    })
    expect(resolved).toContain('**Approved** by Alice Strand.')
    expect(resolved).not.toContain('by alice')
  })

  it('falls back to the id when no display name was supplied', () => {
    expect(approvalStatusLine({ state: 'approved', decidedBy: 'alice' })).toBe('**Approved** by alice.')
  })

  it('carries a denial reason, because that reason is what reaches the model', () => {
    const resolved = resolvedCardBody(pending, { state: 'denied', decidedBy: 'Carol', reason: 'not on prod' })
    expect(resolved).toContain('**Denied** by Carol. not on prod')
  })

  it('says an expiry was nobody, not somebody', () => {
    const resolved = resolvedCardBody(pending, { state: 'expired', decidedBy: null })
    expect(resolved).toContain('**Expired**')
    expect(resolved).not.toContain('by ')
  })

  it('names no human when the worker resolved it by policy', () => {
    expect(approvalStatusLine({ state: 'approved', decidedBy: null })).toBe('**Approved.**')
  })

  it('is idempotent enough that resolving twice does not stack footers', () => {
    const once = resolvedCardBody(pending, { state: 'approved', decidedBy: 'Carol' })
    const twice = resolvedCardBody(once, { state: 'denied', decidedBy: 'Carol', reason: 'changed my mind' })
    expect(twice.match(/\*\*Approved\*\*/g)).toBeNull()
    expect(twice).toContain('**Denied** by Carol.')
  })
})


describe('approvalCardProse', () => {
  it('drops the status line the card header already shows, and nothing else', () => {
    const settled = resolvedCardBody(approvalCardBody({ toolName: 'Bash', title: 'run ls' }), {
      state: 'approved',
      decidedBy: 'alice',
      decidedByDisplay: 'Alice Strand'
    })
    expect(settled).toContain('**Approved** by Alice Strand.')
    const prose = approvalCardProse(settled)
    expect(prose).toContain('run ls')
    expect(prose).toContain('**Approval needed - Bash**')
    expect(prose).not.toContain('**Approved**')
  })

  it('leaves a PENDING body untouched - there is no status line to drop', () => {
    const pending = approvalCardBody({ toolName: 'Bash', title: 'run ls' })
    expect(approvalCardProse(pending)).toBe(pending)
  })
})

describe('parseAgentDirective', () => {
  it('leaves stop and cancel as interrupts', () => {
    expect(parseAgentDirective('@nova stop')).toEqual({ kind: 'interrupt' })
  })

  it('reads a bare approve as an ORDINARY ASK, not a decision', () => {
    // The decision kind was removed on 2026-09-09: a card is answered by its buttons. What used to
    // be swallowed as a decision now reaches the model as a turn, which is the honest reading of a
    // word somebody typed at the agent - and the reason the removal is safe is that the card it
    // would have answered is still sitting there with two live buttons on it.
    expect(parseAgentDirective('@nova approve')).toEqual({ kind: 'turn', text: 'approve' })
    expect(parseAgentDirective('@nova deny we are mid-deploy')).toEqual({
      kind: 'turn',
      text: 'deny we are mid-deploy'
    })
  })

  it('leaves an ordinary ask alone', () => {
    expect(parseAgentDirective('@nova approve the draft for me')).toEqual({
      kind: 'turn',
      text: 'approve the draft for me'
    })
  })
})

describe('approvalCapNotice', () => {
  it('names the cap that applied', () => {
    expect(approvalCapNotice()).toContain(String(APPROVAL_CARDS_PER_TURN))
  })
})
