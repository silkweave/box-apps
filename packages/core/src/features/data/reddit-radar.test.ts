// The topic radar's listening list. Everything here drives `parseRedditRadar` directly (it is
// pure); the tests that touch disk point the instance dir at a temp one, because "a Box with no
// reddit-radar.json" is the state every fresh Box starts in and is the one this file most needs to
// pin down. The snapshot test at the bottom pins the OTHER half of the fix: a stored scan carries
// the subs and topics that produced it.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseRedditRadar, readRedditRadar, redditRadarConfigured } from './reddit-radar.js'
import { setInstanceDir, resetInstanceDir } from '../../testing.js'

describe('parseRedditRadar', () => {
  it('reads both declared lists, preserving file order', () => {
    const parsed = parseRedditRadar({ subs: ['typescript', 'node'], topics: ['acme', 'invoice reconciliation'] })
    expect(parsed.subs).toEqual(['typescript', 'node'])
    expect(parsed.topics).toEqual(['acme', 'invoice reconciliation'])
  })

  it('treats an empty list as an empty list - there is no seed', () => {
    // The only seed available would be somebody else's target communities and product keywords,
    // which is the bug this file exists to fix. Nothing may ever fill it in on the user's behalf.
    expect(parseRedditRadar({ subs: [], topics: [] })).toEqual({ subs: [], topics: [] })
  })

  it('ignores `_`-prefixed doc notes, as keys and as list entries', () => {
    const parsed = parseRedditRadar({
      _readme: ['what this file is for'],
      subs: ['_ replace these with your own', 'typescript'],
      topics: ['_ your product words', 'acme'],
    })
    expect(parsed.subs).toEqual(['typescript'])
    expect(parsed.topics).toEqual(['acme'])
  })

  it('drops a malformed entry rather than throwing, so one typo does not lose the rest', () => {
    const parsed = parseRedditRadar({
      subs: ['typescript', '', '   ', 42, null, { name: 'nope' }, ['nested'], '  node  '],
      topics: 'not-a-list',
    })
    expect(parsed.subs).toEqual(['typescript', 'node'])
    expect(parsed.topics).toEqual([])
  })

  it('accepts the three ways a subreddit gets written down, and de-duplicates case-insensitively', () => {
    const parsed = parseRedditRadar({
      subs: ['typescript', 'r/typescript', '/r/TypeScript/', 'node'],
      topics: ['acme', 'ACME', 'acme  cloud'],
    })
    expect(parsed.subs).toEqual(['typescript', 'node'])
    expect(parsed.topics).toEqual(['acme', 'acme cloud'])
  })

  it('survives a body that is not an object at all', () => {
    for (const raw of [null, undefined, 'typescript', 7, ['typescript']])
      expect(parseRedditRadar(raw)).toEqual({ subs: [], topics: [] })
  })
})

describe('redditRadarConfigured', () => {
  it('needs both halves - subs with no topics match nothing, topics with no subs have nowhere to look', () => {
    expect(redditRadarConfigured({ subs: [], topics: [] })).toBe(false)
    expect(redditRadarConfigured({ subs: ['typescript'], topics: [] })).toBe(false)
    expect(redditRadarConfigured({ subs: [], topics: ['acme'] })).toBe(false)
    expect(redditRadarConfigured({ subs: ['typescript'], topics: ['acme'] })).toBe(true)
  })
})

describe('readRedditRadar', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'box-reddit-radar-'))
    mkdirSync(join(dir, 'config'), { recursive: true })
    setInstanceDir(dir)
  })
  afterEach(() => {
    resetInstanceDir()
  })

  it('returns empty lists when the file does not exist - the state every fresh Box is in', () => {
    const cfg = readRedditRadar()
    expect(cfg).toEqual({ subs: [], topics: [] })
    expect(redditRadarConfigured(cfg)).toBe(false)
  })

  it('returns empty lists for unparseable JSON rather than taking the pull down', () => {
    writeFileSync(join(dir, 'config', 'reddit-radar.json'), '{ subs: [oops', 'utf8')
    expect(readRedditRadar()).toEqual({ subs: [], topics: [] })
  })

  it('reads a configured file', () => {
    writeFileSync(
      join(dir, 'config', 'reddit-radar.json'),
      JSON.stringify({ _readme: 'notes', subs: ['r/typescript'], topics: ['acme'] }),
      'utf8',
    )
    expect(readRedditRadar()).toEqual({ subs: ['typescript'], topics: ['acme'] })
  })

  it('stamps a stored scan with the subs and topics that produced it', () => {
    // The property the radar snapshot must hold, asserted on the same shape redditRadar builds.
    // `candidates[].matched` is only interpretable against the topic list it was matched with, so
    // an edit to config/reddit-radar.json between the pull and any later read must not be able to
    // change what a stored row means. Same rule the engagement inbox builder follows when it reads
    // whose account a snapshot is from the snapshot rather than from live config.
    writeFileSync(
      join(dir, 'config', 'reddit-radar.json'),
      JSON.stringify({ subs: ['typescript'], topics: ['acme'] }),
      'utf8',
    )
    const atPullTime = readRedditRadar()
    const snapshot = {
      channel: 'reddit-radar',
      date: '2026-09-14',
      window_days: 14,
      subs: atPullTime.subs,
      topics: atPullTime.topics,
      candidates: [{ subreddit: 'typescript', matched: ['acme'] }],
    }

    // The team re-aims the radar the next morning.
    writeFileSync(
      join(dir, 'config', 'reddit-radar.json'),
      JSON.stringify({ subs: ['node'], topics: ['widgets'] }),
      'utf8',
    )
    expect(readRedditRadar()).toEqual({ subs: ['node'], topics: ['widgets'] })

    // Yesterday's scan still says what it actually scanned and what it actually matched on.
    expect(snapshot.subs).toEqual(['typescript'])
    expect(snapshot.topics).toEqual(['acme'])
    for (const c of snapshot.candidates) {
      expect(snapshot.subs).toContain(c.subreddit)
      for (const m of c.matched) expect(snapshot.topics).toContain(m)
    }
  })
})
