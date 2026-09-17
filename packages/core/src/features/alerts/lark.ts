// Send a Lark message as the bot, by shelling out to @silkweave/lark-mcp's `lark-cli` (ambient auth
// from its own token store - no app secret in this repo). Mirrors the repo's `gh api` subprocess
// pattern (src/core/pulls/github.ts). Uses msg_type `post` + a `md` element so markdown (bold,
// links, code) renders correctly - a plain `text` message renders markdown poorly. Fail-loud: a
// non-zero exit throws with the CLI's stderr so the alert row records a real delivery error.

import { execFileSync } from 'node:child_process'
import type { LarkTarget } from './routing.js'

/** `lark-cli` resolves on PATH; overridable for non-standard installs. */
const LARK_CLI = process.env.LARK_CLI ?? 'lark-cli'

function send(target: LarkTarget, msgType: string, content: string): void {
  try {
    execFileSync(
      LARK_CLI,
      ['im-message-send', '--receive-id', target.receive_id, '--receive-id-type', target.type,
        '--msg-type', msgType, '--content', content],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 },
    )
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    throw new Error(`lark-cli send failed: ${(e.stderr || e.stdout || e.message || String(err)).trim()}`)
  }
}

/**
 * Send a markdown message to a Lark target as the bot. `title` is the post header; `markdown` is the
 * body (rendered via the `md` post element). Throws on send failure.
 */
export function sendLarkMarkdown(target: LarkTarget, title: string, markdown: string): void {
  send(target, 'post', JSON.stringify({ en_us: { title, content: [[{ tag: 'md', text: markdown }]] } }))
}

/**
 * Send an interactive card as the bot (alerts v2 - the actionable replacement for plain posts;
 * `lark-cli im-message-send` supports cards natively via msg_type `interactive`). `card` is the
 * full Lark card JSON (config/header/elements). Throws on send failure.
 */
export function sendLarkCard(target: LarkTarget, card: Record<string, unknown>): void {
  send(target, 'interactive', JSON.stringify(card))
}
