// The three external LINKS on an account (R1/R2) and the duplicate guard on them (R3), against a
// throwaway warehouse.
//
// The guard is the part worth testing: in the live book one Stripe customer id was held by two
// accounts of the same customer, and once Stripe owns `mrr_usd` one customer id on two rows
// writes one subscription's revenue twice. It must refuse the second claim, must not refuse an
// account re-saving its own value, and must still let a link be cleared and moved.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCrmAccount, upsertCrmAccount } from './state.js'

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'box-crm-links-'))
  process.env.BOX_DATA_DIR = dir
  await upsertCrmAccount({ id: 'acme-scotland', name: 'Acme Scotland' })
  await upsertCrmAccount({ id: 'acme-leeds', name: 'Acme Leeds' })
})

afterAll(() => {
  delete process.env.BOX_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('account external links', () => {
  it('writes and reads back all three', async () => {
    await upsertCrmAccount({
      id: 'acme-scotland',
      stripe_customer_id: 'cus_EXAMPLE0000001',
      supabase_space_id: 'exspce01',
      whatsapp_group_jid: '120363000000000001@g.us',
    })
    const a = await readCrmAccount('acme-scotland')
    expect(a?.stripe_customer_id).toBe('cus_EXAMPLE0000001')
    expect(a?.supabase_space_id).toBe('exspce01')
    expect(a?.whatsapp_group_jid).toBe('120363000000000001@g.us')
  })

  it('leaves a link alone on a write that does not mention it', async () => {
    await upsertCrmAccount({ id: 'acme-scotland', next_action: 'send the renewal quote' })
    expect((await readCrmAccount('acme-scotland'))?.stripe_customer_id).toBe('cus_EXAMPLE0000001')
  })

  it('refuses a customer id already held by another account, naming the holder', async () => {
    await expect(
      upsertCrmAccount({ id: 'acme-leeds', stripe_customer_id: 'cus_EXAMPLE0000001' }),
    ).rejects.toThrow(/acme-scotland/)
    expect((await readCrmAccount('acme-leeds'))?.stripe_customer_id).toBeNull()
  })

  it('guards the space id and the group jid the same way', async () => {
    await expect(upsertCrmAccount({ id: 'acme-leeds', supabase_space_id: 'exspce01' })).rejects.toThrow(
      /already held/,
    )
    await expect(
      upsertCrmAccount({ id: 'acme-leeds', whatsapp_group_jid: '120363000000000001@g.us' }),
    ).rejects.toThrow(/already held/)
  })

  it('lets an account re-save its own value', async () => {
    await expect(
      upsertCrmAccount({ id: 'acme-scotland', stripe_customer_id: 'cus_EXAMPLE0000001' }),
    ).resolves.toBeTruthy()
  })

  it("clears with '' and then allows the other account to claim it", async () => {
    await upsertCrmAccount({ id: 'acme-scotland', stripe_customer_id: '' })
    expect((await readCrmAccount('acme-scotland'))?.stripe_customer_id).toBeNull()
    await upsertCrmAccount({ id: 'acme-leeds', stripe_customer_id: 'cus_EXAMPLE0000001' })
    expect((await readCrmAccount('acme-leeds'))?.stripe_customer_id).toBe('cus_EXAMPLE0000001')
  })

  it('trims a pasted value rather than storing the whitespace', async () => {
    await upsertCrmAccount({ id: 'acme-scotland', stripe_customer_id: '  cus_EXAMPLE0000002  ' })
    expect((await readCrmAccount('acme-scotland'))?.stripe_customer_id).toBe('cus_EXAMPLE0000002')
  })
})
