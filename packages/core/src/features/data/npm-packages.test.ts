// The npm package list's parser. Everything here drives `parseNpmPackages` directly (it is pure);
// the one test that touches disk points the instance dir at a temp one, because "a Box with no
// npm-packages.json" is the state every fresh Box starts in and is the one this file most needs to
// pin down.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { allNpmPackages, parseNpmPackages, readNpmPackages } from './npm-packages.js'
import { setInstanceDir, resetInstanceDir } from '../../testing.js'

describe('parseNpmPackages', () => {
  it('reads the two declared lists, preserving file order', () => {
    const parsed = parseNpmPackages({ packages: ['acme', '@acme/core'], tracked: ['acme-standalone'] })
    expect(parsed.packages).toEqual(['acme', '@acme/core'])
    expect(parsed.tracked).toEqual(['acme-standalone'])
  })

  it('treats an empty list as an empty list - there is no seed', () => {
    // The opposite call from initiative-kinds: a board with no lanes is unusable, a Box that
    // publishes nothing to npm is not. Nothing may ever fill this in on the user's behalf.
    expect(parseNpmPackages({ packages: [], tracked: [] })).toEqual({ packages: [], tracked: [] })
  })

  it('ignores `_`-prefixed doc notes, as keys and as list entries', () => {
    const parsed = parseNpmPackages({
      _readme: ['what this file is for'],
      packages: ['_ replace these with your own', 'acme'],
      tracked: ['_ a standalone package', 'acme-standalone'],
    })
    expect(parsed.packages).toEqual(['acme'])
    expect(parsed.tracked).toEqual(['acme-standalone'])
  })

  it('drops a malformed entry rather than throwing, so one typo does not lose the rest', () => {
    const parsed = parseNpmPackages({
      packages: ['acme', '', '   ', 42, null, { name: 'nope' }, ['nested'], '  @acme/core  '],
      tracked: 'not-a-list',
    })
    expect(parsed.packages).toEqual(['acme', '@acme/core'])
    expect(parsed.tracked).toEqual([])
  })

  it('de-duplicates within a list and lets `tracked` win across them', () => {
    // A name in both would be fetched twice and register npm.pkg.<name> from two paths. `tracked`
    // wins because its promise - always its own signal, never gated on the top-N cut - is stronger.
    const parsed = parseNpmPackages({ packages: ['acme', 'acme', 'shared'], tracked: ['shared', 'shared'] })
    expect(parsed.packages).toEqual(['acme'])
    expect(parsed.tracked).toEqual(['shared'])
  })

  it('survives a body that is not an object at all', () => {
    for (const raw of [null, undefined, 'acme', 7, ['acme']])
      expect(parseNpmPackages(raw)).toEqual({ packages: [], tracked: [] })
  })
})

describe('readNpmPackages', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'box-npm-packages-'))
    mkdirSync(join(dir, 'config'), { recursive: true })
    setInstanceDir(dir)
  })
  afterEach(() => {
    resetInstanceDir()
  })

  it('returns empty lists when the file does not exist - the state every fresh Box is in', () => {
    expect(readNpmPackages()).toEqual({ packages: [], tracked: [] })
    expect(allNpmPackages()).toEqual([])
  })

  it('returns empty lists for unparseable JSON rather than taking the pull down', () => {
    writeFileSync(join(dir, 'config', 'npm-packages.json'), '{ packages: [oops', 'utf8')
    expect(readNpmPackages()).toEqual({ packages: [], tracked: [] })
  })

  it('reads a configured file, aggregate list first', () => {
    writeFileSync(
      join(dir, 'config', 'npm-packages.json'),
      JSON.stringify({ _readme: 'notes', packages: ['acme', '@acme/core'], tracked: ['acme-standalone'] }),
      'utf8',
    )
    expect(allNpmPackages()).toEqual(['acme', '@acme/core', 'acme-standalone'])
  })
})
