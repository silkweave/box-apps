// Which blog feed a Box pulls. `blogFeed()` reads config/accounts.json, so every test here points the
// instance dir at a temp one; "a Box with no accounts.json" is the state every fresh Box starts in
// and is the one this file most needs to pin down, because the bug it replaces was a constant that
// made every Box pull the author's feed with no override path at all.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BLOG_NOT_CONFIGURED, blogFeed } from './blog-feed.js'
import { setInstanceDir, resetInstanceDir } from '../../testing.js'

describe('blogFeed', () => {
  let dir: string

  const writeAccounts = (body: unknown): void =>
    writeFileSync(join(dir, 'config', 'accounts.json'), JSON.stringify(body), 'utf8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'box-blog-feed-'))
    mkdirSync(join(dir, 'config'), { recursive: true })
    setInstanceDir(dir)
  })
  afterEach(() => {
    resetInstanceDir()
  })

  it('is null when there is no accounts.json at all - the state every fresh Box is in', () => {
    expect(blogFeed()).toBeNull()
  })

  it('is null when accounts.json has no blog channel, and when the blog account declares no feed', () => {
    writeAccounts({ github: [{ id: 'alice', user: 'alice', default: true, login: 'alice' }] })
    expect(blogFeed()).toBeNull()
    writeAccounts({ blog: [{ id: 'acme', user: 'alice', default: true, login: 'acme' }] })
    expect(blogFeed()).toBeNull()
  })

  it('reads the feed off the blog account', () => {
    writeAccounts({ blog: [{ id: 'acme', user: 'alice', default: true, login: 'acme', feed: ' https://www.acme.dev/rss.xml ' }] })
    expect(blogFeed()).toBe('https://www.acme.dev/rss.xml')
  })

  it('prefers the default account, and falls back to a non-default one that has a feed', () => {
    writeAccounts({
      blog: [
        { id: 'bob', user: 'bob', login: 'bob', feed: 'https://bob.example/feed.xml' },
        { id: 'acme', user: 'alice', default: true, login: 'acme', feed: 'https://www.acme.dev/rss.xml' },
      ],
    })
    expect(blogFeed()).toBe('https://www.acme.dev/rss.xml')

    // Default has no feed of its own: the member blog is still a blog this Box can pull.
    writeAccounts({
      blog: [
        { id: 'acme', user: 'alice', default: true, login: 'acme' },
        { id: 'bob', user: 'bob', login: 'bob', feed: 'https://bob.example/feed.xml' },
      ],
    })
    expect(blogFeed()).toBe('https://bob.example/feed.xml')
  })

  it('drops a malformed feed rather than throwing, and reads as not-configured', () => {
    for (const feed of ['', '   ', 'www.acme.dev/rss.xml', 'ftp://acme.dev/rss.xml', 42, null, ['https://acme.dev/rss.xml']]) {
      writeAccounts({ blog: [{ id: 'acme', user: 'alice', default: true, login: 'acme', feed }] })
      expect(blogFeed()).toBeNull()
    }
  })

  it('ignores a `_`-prefixed doc note in the feed field', () => {
    writeAccounts({ blog: [{ id: 'acme', user: 'alice', default: true, login: 'acme', feed: '_ put your RSS URL here' }] })
    expect(blogFeed()).toBeNull()
  })

  it('is null for unparseable JSON rather than taking the pull down', () => {
    writeFileSync(join(dir, 'config', 'accounts.json'), '{ blog: [oops', 'utf8')
    expect(blogFeed()).toBeNull()
  })

  it('names the file and the example in the line the pull prints', () => {
    expect(BLOG_NOT_CONFIGURED).toContain('config/accounts.json')
    expect(BLOG_NOT_CONFIGURED).toContain('docs/examples/accounts.json')
  })
})
