import { describe, expect, it } from 'vitest'
import { rankMentionCandidates } from './mentions.js'

describe('rankMentionCandidates', () => {
  // Id LENGTHS are load-bearing here, not decoration: the empty-query order below is "shortest id
  // first, then alphabetical", so a rename that changes a length changes the expected order.
  const people = [
    { id: 'alice', name: 'Alice Strand' },
    { id: 'carol', name: 'Carol Malone' },
    { id: 'dave', name: 'Dave Adams' },
    { id: 'abi', name: 'Abi', nickname: 'abi' },
    { id: 'bob', name: 'Bob Amira' }
  ]

  const ids = (query: string): string[] => rankMentionCandidates(people, query).map((p) => p.id)

  // The reported bug, exactly: `@a` used to highlight whoever came first in the directory and
  // merely had an "a" in their name, so Enter picked the wrong human.
  it('puts an id prefix above a name match on a single letter', () => {
    expect(ids('a')[0]).toBe('abi')
  })

  it('puts an exact id first even when a longer id shares the prefix', () => {
    expect(rankMentionCandidates([...people, { id: 'abigail', name: 'Abigail Zed' }], 'abi')[0]?.id).toBe('abi')
  })

  it('reaches a person by a name WORD, not just the leading word', () => {
    expect(ids('stran')).toEqual(['alice'])
  })

  it('still finds a name substring as a last resort', () => {
    expect(ids('alon')).toEqual(['carol'])
  })

  it('drops what does not match at all', () => {
    expect(ids('zzz')).toEqual([])
  })

  it('offers everyone, shortest id first then alphabetical, on an empty query', () => {
    expect(ids('')).toEqual(['abi', 'bob', 'dave', 'alice', 'carol'])
  })
})
