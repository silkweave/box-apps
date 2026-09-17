import { describe, expect, it } from 'vitest'
import { AgentTurnText } from './agent-stream.js'

describe('AgentTurnText', () => {
  describe('assembling deltas and blocks', () => {
    it('renders nothing before anything arrives', () => {
      expect(new AgentTurnText().render()).toBe('')
    })

    it('spells out an in-flight block from its deltas', () => {
      const t = new AgentTurnText()
      t.pushDelta('Hel')
      t.pushDelta('lo ')
      t.pushDelta('world')
      expect(t.render()).toBe('Hello world')
    })

    it('does NOT duplicate the answer when the block completes', () => {
      // The trap: deltas spell out the text, then assistant_message carries the SAME text again.
      const t = new AgentTurnText()
      t.pushDelta('Hello ')
      t.pushDelta('world')
      t.completeBlock('uuid-1', 'Hello world')
      expect(t.render()).toBe('Hello world')
    })

    it('keeps the completed block authoritative when it differs from the deltas', () => {
      const t = new AgentTurnText()
      t.pushDelta('Hello wor')
      t.completeBlock('uuid-1', 'Hello world.')
      expect(t.render()).toBe('Hello world.')
    })

    it('renders several blocks as paragraphs, in arrival order', () => {
      const t = new AgentTurnText()
      t.completeBlock('a', 'first')
      t.completeBlock('b', 'second')
      expect(t.render()).toBe('first\n\nsecond')
    })

    it('re-emitting a block REPLACES it rather than appending', () => {
      const t = new AgentTurnText()
      t.completeBlock('a', 'draft')
      t.completeBlock('b', 'other')
      t.completeBlock('a', 'final')
      expect(t.render()).toBe('final\n\nother')
    })

    it('streams a second block after the first completed one', () => {
      const t = new AgentTurnText()
      t.completeBlock('a', 'first')
      t.pushDelta('sec')
      expect(t.render()).toBe('first\n\nsec')
      t.completeBlock('b', 'second')
      expect(t.render()).toBe('first\n\nsecond')
    })

    it('an empty completed block still clears a half-spelled buffer', () => {
      const t = new AgentTurnText()
      t.pushDelta('half written')
      t.completeBlock('a', '')
      expect(t.render()).toBe('')
    })

    it('ignores empty deltas', () => {
      const t = new AgentTurnText()
      t.pushDelta('')
      expect(t.render()).toBe('')
    })
  })

  describe('poll - what may actually be written', () => {
    it('never returns an empty body (the "…" placeholder is better than a blank message)', () => {
      expect(new AgentTurnText().poll(1000)).toBeNull()
    })

    it('returns the body on the first poll', () => {
      const t = new AgentTurnText({ flushIntervalMs: 500 })
      t.pushDelta('hi')
      expect(t.poll(0)).toBe('hi')
    })

    it('rate-limits a second flush', () => {
      const t = new AgentTurnText({ flushIntervalMs: 500 })
      t.pushDelta('hi')
      expect(t.poll(1000)).toBe('hi')
      t.pushDelta(' there')
      expect(t.poll(1200)).toBeNull()
      expect(t.poll(1500)).toBe('hi there')
    })

    it('force skips the rate limit', () => {
      const t = new AgentTurnText({ flushIntervalMs: 500 })
      t.pushDelta('hi')
      expect(t.poll(1000)).toBe('hi')
      t.pushDelta(' there')
      expect(t.poll(1100, true)).toBe('hi there')
    })

    it('force does NOT re-write an unchanged body', () => {
      const t = new AgentTurnText({ flushIntervalMs: 500 })
      t.pushDelta('hi')
      expect(t.poll(1000)).toBe('hi')
      expect(t.poll(9000, true)).toBeNull()
    })

    it('force does NOT write an empty body', () => {
      expect(new AgentTurnText().poll(1000, true)).toBeNull()
    })

    it('a delta that completes into identical text costs no second write', () => {
      // The turn's last flush already showed the whole block; assistant_message must be a no-op.
      const t = new AgentTurnText({ flushIntervalMs: 0 })
      t.pushDelta('Hello world')
      expect(t.poll(1000)).toBe('Hello world')
      t.completeBlock('a', 'Hello world')
      expect(t.poll(2000, true)).toBeNull()
    })

    it('reports growth across a multi-block turn', () => {
      const t = new AgentTurnText({ flushIntervalMs: 0 })
      t.pushDelta('one')
      expect(t.poll(0)).toBe('one')
      t.completeBlock('a', 'one')
      t.pushDelta('two')
      expect(t.poll(1)).toBe('one\n\ntwo')
      t.completeBlock('b', 'two!')
      expect(t.poll(2)).toBe('one\n\ntwo!')
    })
  })

  describe('seal - splitting a turn across an approval card', () => {
    it('drops what was already written so the next row starts empty', () => {
      const t = new AgentTurnText({ flushIntervalMs: 0 })
      t.completeBlock('a', 'checking the docs folder')
      expect(t.poll(0, true)).toBe('checking the docs folder')
      t.seal()
      expect(t.render()).toBe('')
      t.completeBlock('b', 'created docs/TEST-001.md')
      // Only the NEW text. Without the seal this would carry both halves and the row below the
      // card would repeat everything the row above it already said.
      expect(t.poll(1, true)).toBe('created docs/TEST-001.md')
    })

    it('lets an identical sentence through again, which the flush guard would otherwise eat', () => {
      // The realistic shape of a retry: the same line written either side of an approval. Without
      // resetting `#flushed`, `poll` refuses it as unchanged and the new row stays "…" forever.
      const t = new AgentTurnText({ flushIntervalMs: 0 })
      t.completeBlock('a', 'retrying')
      expect(t.poll(0, true)).toBe('retrying')
      t.seal()
      t.completeBlock('b', 'retrying')
      expect(t.poll(1, true)).toBe('retrying')
    })

    it('discards a half-spelled block, which its assistant_message re-delivers whole', () => {
      const t = new AgentTurnText({ flushIntervalMs: 0 })
      t.pushDelta('I am about to')
      t.seal()
      expect(t.render()).toBe('')
      t.completeBlock('a', 'I am about to create the file, and I did')
      expect(t.poll(1, true)).toBe('I am about to create the file, and I did')
    })
  })
})
