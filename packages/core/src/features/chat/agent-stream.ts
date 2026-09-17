/**
 * The text an agent turn has produced so far, assembled from two DIFFERENT kinds of worker event.
 *
 * A turn does not hand this server one finished answer. It emits token-level `stream_delta`s while it
 * writes, then an `assistant_message` carrying the completed block, then possibly more of both
 * around tool calls. This module owns the one rule that makes those two streams add up to a single
 * body, so the server can stay a thin adapter and the rule itself stays testable.
 *
 * Engine-agnostic on purpose: it never imports the worker protocol (core depends on nothing there),
 * exactly like `agent-activity.ts` and `agent-trigger.ts`. The server translates events into
 * `pushDelta` / `completeBlock` calls and this stays pure.
 *
 * ## Why deltas are NOT keyed like blocks
 *
 * `completeBlock` is keyed by the message's own uuid because an `assistant_message` is the
 * authoritative snapshot of ITS OWN text and must REPLACE what came before for that uuid.
 *
 * Deltas cannot use that structure, and the temptation to reuse it is a real trap: both engine
 * runners stamp every `stream_delta` with its own fresh `randomUUID()`, so keying deltas by uuid
 * would file every single token as a separate block and render the answer as one paragraph per
 * token. Instead the in-flight text is ONE unkeyed buffer, and completing a block clears it -
 * because the block that just completed is the very text those deltas were spelling out. Getting
 * that clear wrong is the other trap: keep the buffer and the finished answer renders twice.
 */

/** How often a streaming turn may checkpoint its partial body, in ms. */
const DEFAULT_FLUSH_INTERVAL_MS = 500

export interface AgentTurnTextOptions {
  /**
   * Minimum gap between two non-forced flushes. Every flush is a SQLite UPDATE plus a room-wide
   * fan-out, so this is what stops a fast turn from writing once per token; the text is never
   * lost by waiting, only shown a beat later.
   */
  flushIntervalMs?: number
}

export class AgentTurnText {
  /** Completed blocks, in arrival order, keyed by the emitting message's uuid. */
  readonly #blocks = new Map<string, string>()
  /** The block currently being spelled out by deltas. Cleared when its `assistant_message` lands. */
  #streaming = ''
  /** The last body handed out by `poll`, so an unchanged body never costs a write. */
  #flushed: string | null = null
  /** Null until the first flush - "never flushed" is not the same as "flushed at epoch 0". */
  #lastFlushAt: number | null = null
  readonly #flushIntervalMs: number

  constructor(options: AgentTurnTextOptions = {}) {
    this.#flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  }

  /** Append one token's worth of assistant text. Callers filter out thinking and sub-agent deltas. */
  pushDelta(text: string): void {
    if (text.length === 0) return
    this.#streaming += text
  }

  /**
   * Record a finished assistant block and drop the in-flight buffer it was spelling out.
   *
   * Empty text still clears the buffer: a block that ended up with no text (all thinking, say)
   * must not leave a half-spelled fragment behind to be rendered forever.
   *
   * That empty case is DEFENSIVE, not currently reachable: the server returns early on empty text
   * rather than calling this, and with today's codex runner a delta-fed item always completes with
   * its text. It is left here (and tested) because the alternative - an engine that ends a
   * streamed block with nothing - would otherwise glue the orphaned fragment onto the next block.
   */
  completeBlock(uuid: string, text: string): void {
    this.#streaming = ''
    if (text.length === 0) return
    this.#blocks.set(uuid, text)
  }

  /** Everything the room should currently see: finished blocks, then whatever is being written. */
  render(): string {
    const parts = [...this.#blocks.values()].filter((block) => block.length > 0)
    if (this.#streaming.length > 0) parts.push(this.#streaming)
    return parts.join('\n\n').trim()
  }

  /**
   * The body to checkpoint right now, or `null` for "do not write".
   *
   * Returns null when the text has not changed since the last flush, when the rate limit has not
   * elapsed, or when there is nothing to say yet - an empty body would replace the "…" placeholder
   * with a blank message, which reads as a bug rather than as a turn about to start.
   *
   * `force` skips only the rate limit, never the other two: a caller that has just seen a block
   * complete wants it on screen immediately, but still must not write an unchanged or empty body.
   */
  poll(now: number, force = false): string | null {
    const body = this.render()
    if (body.length === 0) return null
    if (body === this.#flushed) return null
    if (!force && this.#lastFlushAt !== null && now - this.#lastFlushAt < this.#flushIntervalMs) return null
    this.#flushed = body
    this.#lastFlushAt = now
    return body
  }

  /**
   * Close the current message: forget everything said so far, so the next `render()` carries only
   * what the turn says NEXT.
   *
   * Exists for ONE caller - the approval card (2026-09-09). A turn writes into a single placeholder
   * posted before it started, so text produced after an approval landed in a row that sorts ABOVE
   * the card that unblocked it: the room read "created the file" before the permission to create
   * it. The server now flushes, seals here, and opens a fresh row after the card, which puts the
   * decision back where it happened.
   *
   * The in-flight buffer goes too, and losing it is correct rather than merely acceptable: a block
   * half spelled out by deltas is re-delivered WHOLE by its `assistant_message`, so the sentence
   * being typed when the card landed reappears intact in the new row instead of being split across
   * two messages at whatever character the approval interrupted it.
   *
   * `#flushed` and `#lastFlushAt` both reset, or the first write into the new row would be refused
   * as unchanged (it is a strict prefix of nothing) or held back by a rate limit the old row
   * started.
   */
  seal(): void {
    this.#blocks.clear()
    this.#streaming = ''
    this.#flushed = null
    this.#lastFlushAt = null
  }
}
