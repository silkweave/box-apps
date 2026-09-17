// The hand-logged activity path, against a throwaway warehouse.
//
// The refusals are what matter here. A CRM where a human edit silently loses to the next sync, or
// where a "deleted" message comes back an hour later, teaches people not to trust it.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { deleteCrmActivity, logCrmActivity, readCrmActivities, upsertCrmActivity } from './activities.js'
import { deleteCrmAccount, deleteCrmContact, upsertCrmAccount, upsertCrmContact } from './state.js'
import { upsertUser } from '../../users/state.js'

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'box-crm-act-'))
  process.env.BOX_DATA_DIR = dir
  // `actor` is validated by the record layer, so a throwaway warehouse needs the person to exist.
  await upsertUser({ id: 'sam', first_name: 'Sam', last_name: 'Rivera' })
  await upsertCrmAccount({ id: 'acme', name: 'Acme' })
  await upsertCrmAccount({ id: 'other-co', name: 'Other Co' })
  await upsertCrmContact({ id: 'jane', account_id: 'acme', name: 'Jane Doe' })
  // A synced row, to prove the human path cannot touch it.
  await upsertCrmActivity({
    id: 'outreach:msg:m1',
    account_id: 'acme',
    contact_id: 'jane',
    channel: 'linkedin',
    direction: 'inbound',
    occurred_at: '2026-04-01 10:00:00',
    body: 'synced message',
  })
})

afterAll(() => {
  delete process.env.BOX_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('logging a touch by hand', () => {
  it('records a call against the contact, and derives the account from it', async () => {
    const row = await logCrmActivity({
      contact_id: 'jane',
      channel: 'call',
      direction: 'outbound',
      occurred_at: '2026-05-02',
      body: 'Called to walk through pricing. Wants a proposal by Friday.',
      actor: 'sam',
    })
    expect(row.id).toMatch(/^manual:/)
    expect(row.account_id).toBe('acme')
    // A bare date means the DAY, not whatever time the browser was in.
    expect(row.occurred_at.slice(0, 10)).toBe('2026-05-02')
    // Nothing may make it look synced.
    expect(row.data_source_id).toBeNull()
    expect(row.external_id).toBeNull()
  })

  it('shows up in the account stream beside the synced messages, in time order', async () => {
    const rows = await readCrmActivities('acme')
    expect(rows.map((r) => r.body)).toEqual([
      'synced message',
      'Called to walk through pricing. Wants a proposal by Friday.',
    ])
  })

  it('names the contact as the author of an inbound touch, and the actor for an outbound one', async () => {
    const inbound = await logCrmActivity({
      contact_id: 'jane',
      channel: 'letter',
      direction: 'inbound',
      body: 'Signed order form arrived by post.',
      actor: 'sam',
    })
    expect(inbound.author_name).toBe('Jane Doe')
    const outbound = await logCrmActivity({
      contact_id: 'jane',
      channel: 'email',
      direction: 'outbound',
      body: 'Sent the proposal.',
      actor: 'sam',
    })
    // The user's display name, not the raw users.id - "sam" beside "Ella Wong" reads as a bug.
    expect(outbound.author_name).toBe('Sam Rivera')
  })

  it('stores the instant it was given, not the server timezone shifted one', async () => {
    // The record layer runs timestamps through `new Date(value)`, and JS parses a space-separated
    // "2026-05-02 03:03:00" as LOCAL time. Handing it the naive form shifted every row by the
    // machine's offset - 8h on the Mac this was written on, silently and always the same way.
    const row = await logCrmActivity({
      contact_id: 'jane',
      channel: 'call',
      direction: 'inbound',
      occurred_at: '2026-05-02T03:03:00Z',
      body: 'timezone canary',
      actor: 'sam',
    })
    expect(row.occurred_at.slice(0, 19)).toBe('2026-05-02T03:03:00')
  })

  it('round-trips a row read back out of the warehouse without drifting', async () => {
    // A read gives the naive form; re-saving it must not re-interpret it as local time.
    const first = await logCrmActivity({
      contact_id: 'jane', channel: 'call', direction: 'inbound',
      occurred_at: '2026-05-03T09:30:00Z', body: 'round trip', actor: 'sam',
    })
    const again = await logCrmActivity({
      id: first.id, contact_id: 'jane', channel: 'call', direction: 'inbound',
      occurred_at: first.occurred_at, body: 'round trip, edited', actor: 'sam',
    })
    expect(again.occurred_at).toBe(first.occurred_at)
  })

  it('refuses an empty body - an empty touch records nothing', async () => {
    await expect(
      logCrmActivity({ contact_id: 'jane', channel: 'call', direction: 'inbound', body: '   ' }),
    ).rejects.toThrow(/body is required/)
  })

  it('refuses an unknown contact rather than orphaning the row', async () => {
    await expect(
      logCrmActivity({ contact_id: 'nobody', channel: 'call', direction: 'inbound', body: 'x' }),
    ).rejects.toThrow(/no contact/)
  })

  it('refuses a date it cannot parse instead of storing "now"', async () => {
    await expect(
      logCrmActivity({ contact_id: 'jane', channel: 'call', direction: 'inbound', body: 'x', occurred_at: 'last tuesday' }),
    ).rejects.toThrow(/not a date/)
  })
})

describe('editing and deleting', () => {
  it('edits its own row in place', async () => {
    const row = await logCrmActivity({ contact_id: 'jane', channel: 'call', direction: 'inbound', body: 'first take', actor: 'sam' })
    const edited = await logCrmActivity({
      id: row.id,
      contact_id: 'jane',
      channel: 'call',
      direction: 'inbound',
      body: 'corrected take',
      actor: 'sam',
    })
    expect(edited.id).toBe(row.id)
    expect(edited.body).toBe('corrected take')
  })

  it('REFUSES to edit a synced row, which the next sync would overwrite anyway', async () => {
    await expect(
      logCrmActivity({ id: 'outreach:msg:m1', contact_id: 'jane', channel: 'linkedin', direction: 'inbound', body: 'tampered' }),
    ).rejects.toThrow(/owned by a sync/)
  })

  it('REFUSES to delete a synced row, which the next backfill would re-create', async () => {
    await expect(deleteCrmActivity('outreach:msg:m1')).rejects.toThrow(/re-created by the next backfill/)
  })

  it('deletes a hand-logged row', async () => {
    const row = await logCrmActivity({ contact_id: 'jane', channel: 'other', direction: 'outbound', body: 'delete me', actor: 'sam' })
    expect(await deleteCrmActivity(row.id)).toEqual({ id: row.id, deleted: true })
    const rows = await readCrmActivities('acme')
    expect(rows.find((r) => r.id === row.id)).toBeUndefined()
  })

  it('reports a delete of something already gone without throwing', async () => {
    expect(await deleteCrmActivity('manual:not-a-real-row')).toEqual({ id: 'manual:not-a-real-row', deleted: false })
  })

  it('follows the contact when it is re-parented, rather than stranding history on the old account', async () => {
    const row = await logCrmActivity({ contact_id: 'jane', channel: 'call', direction: 'inbound', body: 'moves with jane', actor: 'sam' })
    await upsertCrmContact({ id: 'jane', account_id: 'other-co' })
    const moved = await readCrmActivities('other-co')
    expect(moved.map((r) => r.id)).toContain(row.id)
    expect(await readCrmActivities('acme')).toHaveLength(0)
    await upsertCrmContact({ id: 'jane', account_id: 'acme' })
  })
})

// The cascade. An activity is only ever reached by `account_id`, so a row left behind by a delete
// is both invisible and permanent - and the individual delete REFUSES synced rows, so there is no
// way to clean one up afterwards either. Deleting the parent has to take them.
describe('deleting the parent takes the conversation with it', () => {
  it('cascades from a contact, including the synced rows a hand-delete refuses', async () => {
    await upsertCrmAccount({ id: 'cascade-co', name: 'Cascade Co' })
    await upsertCrmContact({ id: 'casc-1', account_id: 'cascade-co', name: 'Cass One' })
    await upsertCrmContact({ id: 'casc-2', account_id: 'cascade-co', name: 'Cass Two' })
    await upsertCrmActivity({
      id: 'outreach:msg:c1',
      account_id: 'cascade-co',
      contact_id: 'casc-1',
      channel: 'linkedin',
      direction: 'inbound',
      occurred_at: '2026-04-01 10:00:00',
      body: 'synced, and unreachable once the contact is gone',
    })
    await logCrmActivity({ contact_id: 'casc-2', channel: 'call', direction: 'outbound', body: 'stays', actor: 'sam' })

    const report = await deleteCrmContact('casc-1')
    expect(report.activities_deleted).toBe(1)
    expect(report.warnings.join(' ')).toMatch(/1 activity row/)
    // Only the other contact's row survives.
    expect((await readCrmActivities('cascade-co')).map((r) => r.contact_id)).toEqual(['casc-2'])
  })

  it('cascades from an account, leaving no orphan rows', async () => {
    const report = await deleteCrmAccount('cascade-co')
    expect(report.deleted).toBe(true)
    expect(report.contacts_deleted).toBe(1)
    expect(report.activities_deleted).toBe(1)
    expect(report.warnings.join(' ')).toMatch(/conversation stream/)
    expect(await readCrmActivities('cascade-co')).toHaveLength(0)
  })

  it('reports zero rather than throwing when the account is already gone', async () => {
    const report = await deleteCrmAccount('cascade-co')
    expect(report.deleted).toBe(false)
    expect(report.activities_deleted).toBe(0)
  })
})
