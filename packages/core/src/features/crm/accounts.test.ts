// The account write path's plain rules, against a throwaway warehouse: what `upsertCrmAccount`
// refuses, and what it leaves alone.
//
// `mrr_usd` is the one worth pinning. The foundation stores it AS TYPED - there is no deal shape to
// derive it from (a product decision, 2026-09-14) - so the guarantee a team builds on is that a typed
// value survives every unrelated write to the cent. A deal shape (features/crm/AGENT.md, "Adding a
// deal shape") puts a derivation in front of the same seam; this file says what the seam does
// without one, and is where that recipe's three pins go.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCrmAccount, upsertCrmAccount } from './state.js'

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'box-crm-accounts-'))
  process.env.BOX_DATA_DIR = dir
})

afterAll(() => {
  delete process.env.BOX_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('mrr_usd is stored as typed', () => {
  it('keeps the typed value to the cent', async () => {
    await upsertCrmAccount({ id: 'acme', name: 'Acme', mrr_usd: 332.33 })
    expect((await readCrmAccount('acme'))?.mrr_usd).toBe(332.33)
  })

  it('survives an unrelated write untouched', async () => {
    await upsertCrmAccount({ id: 'acme', next_action: 'send the proposal', close_probability: 60 })
    const a = await readCrmAccount('acme')
    expect(a?.mrr_usd).toBe(332.33)
    expect(a?.close_probability).toBe(60)
  })

  it('clears with null, and a later write does not resurrect it', async () => {
    await upsertCrmAccount({ id: 'acme', mrr_usd: null })
    expect((await readCrmAccount('acme'))?.mrr_usd).toBeNull()
    await upsertCrmAccount({ id: 'acme', notes: 'nothing agreed yet' })
    expect((await readCrmAccount('acme'))?.mrr_usd).toBeNull()
  })

  it('refuses a negative number rather than storing a negative pipeline', async () => {
    await expect(upsertCrmAccount({ id: 'acme', mrr_usd: -1 })).rejects.toThrow(/cannot be negative/)
  })
})

describe('the other write-time guards', () => {
  it('refuses a close probability outside 0-100', async () => {
    await expect(upsertCrmAccount({ id: 'acme', close_probability: 101 })).rejects.toThrow(/between 0 and 100/)
    await expect(upsertCrmAccount({ id: 'acme', close_probability: -5 })).rejects.toThrow(/between 0 and 100/)
  })

  it('refuses an owner that is not a user', async () => {
    await expect(upsertCrmAccount({ id: 'acme', owner: 'nobody-here' })).rejects.toThrow(/nobody-here/)
  })

  it('refuses a pause window that ends before it starts', async () => {
    await expect(
      upsertCrmAccount({ id: 'acme', paused_since: '2026-09-10', paused_until: '2026-09-01' }),
    ).rejects.toThrow(/before paused_since/)
  })
})
