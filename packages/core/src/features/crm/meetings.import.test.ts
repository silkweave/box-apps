// The machine write path for meetings (upsertImportedMeeting), against a throwaway warehouse. Every
// case here is one of the trust rules from the PRD stated as a behaviour: a second run must not
// undo a human, a machine may never say no_show, a moved meeting stays one row, and unchanged data
// must not even restamp the audit trail.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCrmMeeting, readCrmMeetingQueue, upsertCrmMeeting, upsertImportedMeeting } from './meetings.js'
import { upsertCrmAccount, upsertCrmContact } from './state.js'
import type { CrmImportedMeetingInput, CrmMeetingOutcome } from './types.js'

let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'box-crm-meetings-import-'))
  process.env.BOX_DATA_DIR = dir
  await upsertCrmAccount({ id: 'acme', name: 'Acme' })
  await upsertCrmAccount({ id: 'globex', name: 'Globex' })
  await upsertCrmContact({ id: 'jane', account_id: 'acme', name: 'Jane', email: 'jane@acme.com' })
  await upsertCrmContact({ id: 'hank', account_id: 'globex', name: 'Hank', email: 'hank@globex.com' })
})

afterAll(() => {
  delete process.env.BOX_DATA_DIR
  rmSync(dir, { recursive: true, force: true })
})

let seq = 0
const calendarRow = (over: Partial<CrmImportedMeetingInput> = {}): CrmImportedMeetingInput => ({
  id: `gcal:evt-${++seq}`,
  source: 'calendar',
  external_id: 'evt',
  scheduled_at: '2026-09-10T02:00:00Z',
  duration_min: 30,
  title: 'Discovery - Acme - Jane',
  attendee_email: 'jane@acme.com',
  external: { organizer: 'host@example.com', status: 'confirmed' },
  account_id: 'acme',
  contact_id: 'jane',
  matched_by: 'contact_email',
  kind: 'discovery',
  ...over,
})

describe('upsertImportedMeeting - insert and idempotency', () => {
  it('inserts a calendar row with the provider columns and the Box seeds', async () => {
    const input = calendarRow()
    const r = await upsertImportedMeeting(input)
    expect(r.op).toBe('inserted')
    expect(r.rescheduled).toBe(false)
    expect(r.meeting).toMatchObject({
      id: input.id,
      source: 'calendar',
      account_id: 'acme',
      contact_id: 'jane',
      matched_by: 'contact_email',
      kind: 'discovery',
      outcome: 'scheduled',
      rescheduled_count: 0,
      scheduled_at: '2026-09-10T02:00:00Z',
      duration_min: 30,
      attendee_email: 'jane@acme.com',
      title: 'Discovery - Acme - Jane',
      external: { organizer: 'host@example.com', status: 'confirmed' },
    })
  })

  it('does not write at all on a second identical run - the audit stamps keep the last real change', async () => {
    const input = calendarRow()
    const first = await upsertImportedMeeting(input)
    const again = await upsertImportedMeeting({ ...input, external: { status: 'confirmed', organizer: 'host@example.com' } })
    expect(again.op).toBe('unchanged')
    expect(again.meeting.updated_at).toBe(first.meeting.updated_at)
    expect(again.meeting.rescheduled_count).toBe(0)
  })

  it('treats sub-second precision on scheduled_at as the same time, not a reschedule', async () => {
    const input = calendarRow({ scheduled_at: '2026-09-10T02:00:00.000Z' })
    await upsertImportedMeeting(input)
    const r = await upsertImportedMeeting({ ...input, scheduled_at: '2026-09-10T02:00:00.750Z' })
    expect(r.op).toBe('unchanged')
    expect(r.meeting.rescheduled_count).toBe(0)
  })
})

describe('upsertImportedMeeting - the human wins', () => {
  it('re-asserts provider columns but never a human-edited kind, notes or account', async () => {
    const input = calendarRow()
    await upsertImportedMeeting(input)
    await upsertCrmMeeting({ id: input.id, kind: 'demo', notes: 'actually a demo, per the host', account_id: 'globex', contact_id: 'hank' })

    const r = await upsertImportedMeeting({
      ...input,
      title: 'Discovery - Acme - Jane (moved to Meet)',
      duration_min: 45,
      kind: 'discovery',
      notes: 'sync would love to overwrite this',
      account_id: 'acme',
      contact_id: 'jane',
      matched_by: 'contact_email',
    })
    expect(r.op).toBe('updated')
    expect(r.meeting.title).toBe('Discovery - Acme - Jane (moved to Meet)')
    expect(r.meeting.duration_min).toBe(45)
    expect(r.meeting.kind).toBe('demo')
    expect(r.meeting.notes).toBe('actually a demo, per the host')
    expect(r.meeting.account_id).toBe('globex')
    expect(r.meeting.contact_id).toBe('hank')
    expect(r.meeting.matched_by).toBe('manual')
  })

  it('never re-derives an account once it is set, even by the machine itself', async () => {
    const input = calendarRow({ account_id: 'acme', contact_id: null, matched_by: 'domain' })
    await upsertImportedMeeting(input)
    const r = await upsertImportedMeeting({ ...input, account_id: 'globex', contact_id: 'hank', matched_by: 'contact_email' })
    expect(r.op).toBe('unchanged')
    expect(r.meeting.account_id).toBe('acme')
    expect(r.meeting.matched_by).toBe('domain')
    expect(r.meeting.contact_id).toBeNull()
  })

  it('leaves a human-set no_show alone whatever the calendar says next', async () => {
    const input = calendarRow()
    await upsertImportedMeeting(input)
    await upsertCrmMeeting({ id: input.id, outcome: 'no_show' })
    for (const outcome of ['held', 'scheduled', 'cancelled'] as const) {
      const r = await upsertImportedMeeting({ ...input, outcome })
      expect(r.meeting.outcome).toBe('no_show')
    }
  })
})

describe('upsertImportedMeeting - outcome by value', () => {
  it('refuses no_show from a machine outright', async () => {
    const input = calendarRow({ outcome: 'no_show' as unknown as CrmImportedMeetingInput['outcome'] })
    await expect(upsertImportedMeeting(input)).rejects.toThrow(/no machine may assert no_show/)
    expect(await readCrmMeeting(input.id)).toBeNull()
  })

  it('writes held and cancelled, and lets a cancelled event come back as scheduled', async () => {
    const input = calendarRow()
    await upsertImportedMeeting(input)
    expect((await upsertImportedMeeting({ ...input, outcome: 'cancelled' })).meeting.outcome).toBe('cancelled')
    expect((await upsertImportedMeeting({ ...input, outcome: 'scheduled' })).meeting.outcome).toBe('scheduled')
    expect((await upsertImportedMeeting({ ...input, outcome: 'held' })).meeting.outcome).toBe('held')
  })

  it('never demotes held: a run that cannot see the evidence says scheduled, a series cancel says cancelled', async () => {
    const input = calendarRow({ source: 'transcript', outcome: 'held', meet_code: 'gok-tusj-yjk' })
    await upsertImportedMeeting(input)
    for (const outcome of ['scheduled', 'cancelled'] as CrmMeetingOutcome[]) {
      const r = await upsertImportedMeeting({ ...input, source: 'calendar', outcome: outcome as 'scheduled' | 'cancelled' })
      expect(r.meeting.outcome).toBe('held')
    }
    // The calendar run did take the row over as a calendar row, and kept the transcript's meet code
    // because it did not say otherwise.
    const row = (await readCrmMeeting(input.id))!
    expect(row.source).toBe('calendar')
    expect(row.meet_code).toBe('gok-tusj-yjk')
  })

  it('leaves a past scheduled row in the queue rather than guessing', async () => {
    const input = calendarRow({ scheduled_at: '2020-01-01T09:00:00Z', account_id: 'acme', matched_by: 'title', contact_id: null })
    await upsertImportedMeeting(input)
    const queue = await readCrmMeetingQueue()
    expect(queue.map((m) => m.id)).toContain(input.id)
  })
})

describe('upsertImportedMeeting - reschedule is the same row', () => {
  it('bumps rescheduled_count and appends the prior time, keeping one row across moves', async () => {
    const input = calendarRow({ scheduled_at: '2026-09-10T02:00:00Z' })
    await upsertImportedMeeting(input)
    const moved = await upsertImportedMeeting({ ...input, scheduled_at: '2026-09-12T02:00:00Z' })
    expect(moved.op).toBe('updated')
    expect(moved.rescheduled).toBe(true)
    expect(moved.meeting.rescheduled_count).toBe(1)
    expect(moved.meeting.external.rescheduled_from).toEqual(['2026-09-10T02:00:00Z'])

    // A second move, with the provider sending a fresh bag that knows nothing of the writer's key.
    const twice = await upsertImportedMeeting({
      ...input,
      scheduled_at: '2026-09-15T03:00:00Z',
      external: { status: 'confirmed', rescheduled_from: ['a caller may not set this'] },
    })
    expect(twice.meeting.rescheduled_count).toBe(2)
    expect(twice.meeting.external).toEqual({
      status: 'confirmed',
      rescheduled_from: ['2026-09-10T02:00:00Z', '2026-09-12T02:00:00Z'],
    })

    // Still one row, and a re-run at the new time is a no-op.
    const again = await upsertImportedMeeting({ ...input, scheduled_at: '2026-09-15T03:00:00Z', external: { status: 'confirmed' } })
    expect(again.op).toBe('unchanged')
    expect(again.meeting.rescheduled_count).toBe(2)
  })
})

describe('upsertImportedMeeting - the assign queue', () => {
  it('writes an unmatched row with account_id null, and fills it on a later run once it resolves', async () => {
    const input = calendarRow({ attendee_email: 'new@nowhere.example', account_id: null, contact_id: null, matched_by: null, kind: 'other' })
    const first = await upsertImportedMeeting(input)
    expect(first.meeting.account_id).toBeNull()
    expect(first.meeting.matched_by).toBeNull()
    expect((await readCrmMeetingQueue()).map((m) => m.id)).toContain(input.id)

    const matched = await upsertImportedMeeting({ ...input, account_id: 'acme', contact_id: 'jane', matched_by: 'contact_email' })
    expect(matched.op).toBe('updated')
    expect(matched.meeting).toMatchObject({ account_id: 'acme', contact_id: 'jane', matched_by: 'contact_email' })
  })

  it('does not re-fill a row a human deliberately sent back to the queue', async () => {
    const input = calendarRow()
    await upsertImportedMeeting(input)
    await upsertCrmMeeting({ id: input.id, account_id: '' })
    const cleared = (await readCrmMeeting(input.id))!
    expect(cleared.account_id).toBeNull()
    expect(cleared.matched_by).toBe('manual')

    const r = await upsertImportedMeeting(input)
    expect(r.op).toBe('unchanged')
    expect(r.meeting.account_id).toBeNull()
    expect(r.meeting.matched_by).toBe('manual')
  })
})

describe('upsertImportedMeeting - refusals', () => {
  it('refuses a slug id, a manual source, and taking over a manual row', async () => {
    await expect(upsertImportedMeeting(calendarRow({ id: 'acme-discovery' }))).rejects.toThrow(/keyed "gcal:/)
    await expect(
      upsertImportedMeeting(calendarRow({ source: 'manual' as unknown as CrmImportedMeetingInput['source'] })),
    ).rejects.toThrow(/source must be calendar or transcript/)

    await upsertCrmMeeting({ id: 'gcal:hand-made', scheduled_at: '2026-09-01T00:00:00Z', title: 'a phone call' })
    await expect(upsertImportedMeeting(calendarRow({ id: 'gcal:hand-made' }))).rejects.toThrow(/exists as a manual row/)
  })

  it('refuses an attribution without its rubric, a manual rubric, and a dangling account or contact', async () => {
    await expect(upsertImportedMeeting(calendarRow({ matched_by: null }))).rejects.toThrow(/come together/)
    await expect(upsertImportedMeeting(calendarRow({ account_id: null, contact_id: null }))).rejects.toThrow(/come together/)
    await expect(
      upsertImportedMeeting(calendarRow({ matched_by: 'manual' as unknown as CrmImportedMeetingInput['matched_by'] })),
    ).rejects.toThrow(/human path's stamp/)
    await expect(upsertImportedMeeting(calendarRow({ account_id: 'nope', contact_id: null }))).rejects.toThrow(/does not exist/)
    await expect(upsertImportedMeeting(calendarRow({ contact_id: 'hank' }))).rejects.toThrow(/belongs to account "globex"/)
    await expect(upsertImportedMeeting(calendarRow({ account_id: null, matched_by: null, contact_id: 'jane' }))).rejects.toThrow(
      /contact_id needs account_id/,
    )
  })
})

describe('upsertCrmMeeting - source belongs to the row', () => {
  it('refuses to downgrade a calendar row to manual, and keeps the provider refusal armed', async () => {
    const input = calendarRow()
    await upsertImportedMeeting(input)

    // The bug this pins: `source: 'manual'` on an existing calendar row used to be believed, which
    // unlocked every provider-owned column and left the row for a sync that would then refuse it.
    await expect(
      upsertCrmMeeting({ id: input.id, source: 'manual', scheduled_at: '2030-01-01T00:00:00Z' }),
    ).rejects.toThrow(/source is calendar and cannot be changed to manual/)

    const after = await readCrmMeeting(input.id)
    expect(after?.source).toBe('calendar')
    expect(after?.scheduled_at).toBe(input.scheduled_at)

    // ...and with no source in the input at all, the refusal still reads the STORED source.
    await expect(upsertCrmMeeting({ id: input.id, scheduled_at: '2030-01-01T00:00:00Z' })).rejects.toThrow(
      /owned by the calendar sync/,
    )
  })

  it('accepts a no-op source that agrees with the row, and still takes the Box columns', async () => {
    const input = calendarRow()
    await upsertImportedMeeting(input)
    const r = await upsertCrmMeeting({ id: input.id, source: 'calendar', notes: 'ran long' })
    expect(r.source).toBe('calendar')
    expect(r.notes).toBe('ran long')
  })

  it('still lets a human create a manual row, and lets it stay manual', async () => {
    await upsertCrmMeeting({ id: 'acme-phone-call', scheduled_at: '2026-09-01T00:00:00Z', title: 'a phone call' })
    const r = await upsertCrmMeeting({ id: 'acme-phone-call', source: 'manual', duration_min: 20 })
    expect(r.source).toBe('manual')
    expect(r.duration_min).toBe(20)
  })
})
