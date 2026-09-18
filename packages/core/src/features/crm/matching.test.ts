// The five-rung matching ladder, against a throwaway warehouse.
//
// This is where a wrong answer is expensive in both directions: a false match silently blends two
// companies' histories, and a missed match leaves the operator with two accounts for one customer. The rungs
// are ordered strongest-first for that reason, and each one is pinned here.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { upsertImportedAccount, upsertImportedContact } from './import.js'
import { findAccountForImport, upsertCrmAccount, upsertCrmContact } from './state.js'
import { setInstanceDir, resetInstanceDir } from '../../testing.js'

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'box-crm-match-'))
  setInstanceDir(dir)

  // An account somebody created by hand, with a legal suffix on the name.
  await upsertCrmAccount({ id: 'northwind', name: 'Northwind Pte Ltd.', website: 'https://www.northwind.io' })
  // One with the company's LinkedIn urn recorded, and no website.
  await upsertCrmAccount({ id: 'bluebird', name: 'Bluebird Branding' })
  await upsertImportedContact({
    id: 'lead_bluebird_1',
    account_id: 'bluebird',
    name: 'Ella Wong',
    linkedin_url: 'https://www.linkedin.com/in/sam.lee',
    data_source_id: 'outreach',
    external_id: 'lead_bluebird_1',
  })
  // A contact with a LinkedIn URL but NO provider key - the hand-entered case rung 2 exists for.
  await upsertCrmContact({
    id: 'hand-typed-sam',
    account_id: 'northwind',
    name: 'Sam Someone',
    linkedin_url: 'http://linkedin.com/in/Sam.Someone/',
  })
})

afterAll(() => {
  resetInstanceDir()
  rmSync(dir, { recursive: true, force: true })
})

const ask = (over: Partial<Parameters<typeof findAccountForImport>[0]> = {}) =>
  findAccountForImport({ data_source_id: 'outreach', external_id: 'nobody', ...over })

describe('the ladder, rung by rung', () => {
  it('1. the provider key wins, even when every other signal points elsewhere', async () => {
    const hit = await ask({
      external_id: 'lead_bluebird_1',
      company_name: 'Northwind Pte Ltd.',   // would match `northwind` on the name rung
      website: 'https://www.northwind.io',  // and on the domain rung
    })
    expect(hit).toEqual({ account_id: 'bluebird', how: 'contact' })
  })

  it('2. a LinkedIn profile matches across spellings, including a hand-typed one', async () => {
    // Stored as `http://linkedin.com/in/Sam.Someone/`, asked with the canonical https/www form.
    const hit = await ask({ linkedin_url: 'https://www.linkedin.com/in/sam.someone' })
    expect(hit).toEqual({ account_id: 'northwind', how: 'linkedin' })
  })

  it('3. the company urn beats the name, and works with no website at all', async () => {
    await upsertImportedAccount({
      id: 'urn-co',
      name: 'Some Renamed Entity',
      data_source_id: 'outreach',
      external: { company_urn: 'urn:li:fs_salesCompany:15000011' },
    })
    // The name on the account no longer resembles what the provider sends - which is exactly when a
    // stable company id earns its keep.
    const hit = await ask({ company_urn: 'urn:li:fs_salesCompany:15000011', company_name: 'Bluebird Rebrand' })
    expect(hit).toEqual({ account_id: 'urn-co', how: 'company_urn' })
  })

  it('4. the company name matches once the legal form is stripped', async () => {
    expect(await ask({ company_name: 'Northwind' })).toEqual({ account_id: 'northwind', how: 'name' })
    expect(await ask({ company_name: 'NORTHWIND PTE LTD' })).toEqual({ account_id: 'northwind', how: 'name' })
  })

  it('5. the website domain matches when the name does not', async () => {
    const hit = await ask({ company_name: 'Completely Different Brand', website: 'http://northwind.io/pricing' })
    expect(hit).toEqual({ account_id: 'northwind', how: 'domain' })
  })

  it('5. a work email domain stands in for a missing website', async () => {
    const hit = await ask({ company_name: 'Nope Industries', email: 'someone@northwind.io' })
    expect(hit).toEqual({ account_id: 'northwind', how: 'domain' })
  })

  it('returns null rather than guessing, which is what makes a new account safe', async () => {
    expect(await ask({ company_name: 'Genuinely New Co', website: 'https://genuinely-new.com' })).toBeNull()
  })
})

describe('what must NOT match', () => {
  it('a free-mail address is a person, not a company', async () => {
    // Two unrelated leads both on gmail must never end up on one account.
    expect(await ask({ company_name: 'Unknown Co', email: 'someone@gmail.com' })).toBeNull()
  })

  it('an empty company name matches no account, however many have one', async () => {
    expect(await ask({ company_name: '' })).toBeNull()
    expect(await ask({ company_name: 'Ltd' })).toBeNull()
  })

  it('a non-LinkedIn URL in the LinkedIn field mints no key', async () => {
    expect(await ask({ linkedin_url: 'https://www.northwind.io' })).toBeNull()
  })

  it('a different company on the same name STEM does not collide', async () => {
    expect(await ask({ company_name: 'Northwind Systems' })).toBeNull()
  })
})

describe('the keys are maintained on write', () => {
  it('recomputes name_key when an account is renamed', async () => {
    await upsertCrmAccount({ id: 'renamer', name: 'Before Ltd' })
    expect(await ask({ company_name: 'Before' })).toEqual({ account_id: 'renamer', how: 'name' })
    await upsertCrmAccount({ id: 'renamer', name: 'After GmbH' })
    expect(await ask({ company_name: 'Before' })).toBeNull()
    expect(await ask({ company_name: 'After' })).toEqual({ account_id: 'renamer', how: 'name' })
  })

  it('recomputes linkedin_key when a contact URL is corrected', async () => {
    await upsertCrmContact({ id: 'fixme', account_id: 'bluebird', name: 'Typo Person', linkedin_url: 'https://www.linkedin.com/in/typo' })
    expect(await ask({ linkedin_url: 'https://linkedin.com/in/typo' })).toEqual({ account_id: 'bluebird', how: 'linkedin' })
    await upsertCrmContact({ id: 'fixme', linkedin_url: 'https://www.linkedin.com/in/correct' })
    expect(await ask({ linkedin_url: 'https://linkedin.com/in/typo' })).toBeNull()
  })
})
