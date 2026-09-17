// The matching ladder is only as good as these keys: every wrong merge and every missed match in
// the CRM sync is a disagreement about what "the same" means. Pure functions, so pinned hard.

import { describe, expect, it } from 'vitest'
import {
  accountSlug,
  companyNameKey,
  emailDomain,
  linkedinKey,
  websiteDomain,
} from './identity.js'

describe('companyNameKey', () => {
  it('strips the legal form, which is the case that motivated it', () => {
    // The real lead that started this: "Northwind Pte Ltd." vs an account called "Northwind".
    expect(companyNameKey('Northwind Pte Ltd.')).toBe('northwind')
    expect(companyNameKey('Northwind')).toBe('northwind')
  })

  it('peels STACKED suffixes, not just the last one', () => {
    expect(companyNameKey('Acme Holdings Ltd')).toBe('acme')
    expect(companyNameKey('Acme Group Inc.')).toBe('acme')
  })

  it('tries the longest suffix first, or `pte ltd` leaves `pte` behind', () => {
    expect(companyNameKey('Shiok Pte Ltd')).toBe('shiok')
    expect(companyNameKey('Shiok Sdn Bhd')).toBe('shiok')
  })

  it('folds case, accents, punctuation and ampersands', () => {
    expect(companyNameKey('Café Møller & Sons')).toBe('cafe moller and sons')
    expect(companyNameKey('  BLUEBIRD   BRANDING  ')).toBe('bluebird branding')
  })

  it('returns empty for a name that is ONLY a legal form, so two blanks never match', () => {
    expect(companyNameKey('Ltd')).toBe('')
    expect(companyNameKey('   ')).toBe('')
    expect(companyNameKey(null)).toBe('')
    expect(companyNameKey(undefined)).toBe('')
  })

  it('does not collapse two genuinely different companies', () => {
    expect(companyNameKey('Acme Leeds')).not.toBe(companyNameKey('Acme London'))
  })
})

describe('linkedinKey', () => {
  it('ignores the things that vary between two copies of one profile URL', () => {
    const expected = 'in/sam.lee'
    expect(linkedinKey('https://www.linkedin.com/in/sam.lee')).toBe(expected)
    expect(linkedinKey('https://www.linkedin.com/in/sam.lee/')).toBe(expected)
    expect(linkedinKey('http://linkedin.com/in/Sam.Lee')).toBe(expected)
    expect(linkedinKey('https://sg.linkedin.com/in/sam.lee')).toBe(expected)
    expect(linkedinKey('https://www.linkedin.com/in/sam.lee?originalSubdomain=sg')).toBe(expected)
    expect(linkedinKey('www.linkedin.com/in/sam.lee')).toBe(expected)
  })

  it('keeps only the identifying head of a deeper path', () => {
    expect(linkedinKey('https://www.linkedin.com/in/sam.lee/recent-activity/all/')).toBe('in/sam.lee')
  })

  it('distinguishes a person from a company', () => {
    expect(linkedinKey('https://www.linkedin.com/company/bluebird')).toBe('company/bluebird')
    expect(linkedinKey('https://www.linkedin.com/company/bluebird')).not.toBe(linkedinKey('https://www.linkedin.com/in/bluebird'))
  })

  it('refuses a non-LinkedIn URL rather than minting a key from it', () => {
    // A company website pasted into the LinkedIn column is a data error, not an identity - and a
    // key here would merge every contact who made the same mistake.
    expect(linkedinKey('https://www.bluebirdbranding.com')).toBe('')
    expect(linkedinKey('not a url at all !!')).toBe('')
    expect(linkedinKey('')).toBe('')
    expect(linkedinKey(null)).toBe('')
  })

  it('refuses a bare linkedin.com with no profile path', () => {
    expect(linkedinKey('https://www.linkedin.com/')).toBe('')
  })
})

describe('websiteDomain', () => {
  it('normalises to the registrable host', () => {
    expect(websiteDomain('https://www.Bluebird-Branding.com/about?x=1')).toBe('bluebird-branding.com')
    expect(websiteDomain('bluebirdbranding.com')).toBe('bluebirdbranding.com')
  })

  it('never shortens a multi-label domain, so two companies cannot collide', () => {
    // No public-suffix list: foo.co.uk stays whole. Worst case is a missed match, never a wrong one.
    expect(websiteDomain('https://foo.co.uk')).toBe('foo.co.uk')
    expect(websiteDomain('https://a.example.com')).toBe('a.example.com')
    expect(websiteDomain('https://b.example.com')).not.toBe(websiteDomain('https://a.example.com'))
  })

  it('refuses free mail providers and hostless values', () => {
    expect(websiteDomain('https://gmail.com')).toBe('')
    expect(websiteDomain('http://localhost')).toBe('')
    expect(websiteDomain('')).toBe('')
  })
})

describe('emailDomain', () => {
  it('takes the company domain from a work address', () => {
    expect(emailDomain('Sam.Lee@Bluebird-Branding.com')).toBe('bluebird-branding.com')
  })

  it('returns nothing for a personal address, which identifies a person not a company', () => {
    expect(emailDomain('sam.lee@gmail.com')).toBe('')
    expect(emailDomain('not-an-email')).toBe('')
  })

  it('uses the LAST @, so a quoted local part cannot smuggle a domain', () => {
    expect(emailDomain('"weird@thing"@bluebird-branding.com')).toBe('bluebird-branding.com')
  })
})

describe('accountSlug', () => {
  it('produces an id the DOC layer will also accept (^[a-z0-9][a-z0-9-]*$)', () => {
    const doc = /^[a-z0-9][a-z0-9-]*$/
    for (const name of ['Bluebird Branding Solutions', 'Café Møller & Sons', '3M', 'a-b-c']) {
      expect(accountSlug(name)).toMatch(doc)
    }
  })

  it('falls back rather than minting an id the doc route would 400 on', () => {
    expect(accountSlug('!!!')).toBe('account')
    expect(accountSlug('')).toBe('account')
    expect(accountSlug(null)).toBe('account')
  })

  it('never ends in a dash after truncation', () => {
    expect(accountSlug('a'.repeat(59) + ' bcdef')).not.toMatch(/-$/)
  })
})
