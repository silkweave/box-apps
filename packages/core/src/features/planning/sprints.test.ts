import { describe, expect, it } from 'vitest'
import {
  burndown,
  capacityOn,
  checkSprint,
  datesBetween,
  dayVerdict,
  formatHours,
  hoursFor,
  isWeekend,
  previousWorkingDay,
  sprintCapacity,
  workingDays,
} from './sprints.js'
import { TITLE_MAX, assertTitleLength, normalizeEstimateHours } from './types.js'

describe('hour arithmetic', () => {
  it('sums the estimates', () => {
    expect(hoursFor([2, 2, 2, 2])).toBe(8)
    expect(hoursFor([])).toBe(0)
  })

  it('excludes unestimated tasks instead of counting them as zero-hour work', () => {
    // They are counted separately (`unsized`) - the missing estimate is the finding, not a 0.
    expect(hoursFor([2, null, undefined])).toBe(2)
  })

  it('formats hours the way every surface says them', () => {
    expect(formatHours(0)).toBe('0h')
    expect(formatHours(6)).toBe('6h')
    expect(formatHours(7.5)).toBe('7.5h')
  })
})

describe('normalizeEstimateHours', () => {
  it('rounds to a whole hour and clamps into 1-8', () => {
    expect(normalizeEstimateHours(3)).toBe(3)
    expect(normalizeEstimateHours(2.4)).toBe(2)
    expect(normalizeEstimateHours(12)).toBe(8)
    expect(normalizeEstimateHours(0.4)).toBe(1)
  })

  it('treats null, zero and negatives as "not estimated"', () => {
    expect(normalizeEstimateHours(null)).toBeNull()
    expect(normalizeEstimateHours(undefined)).toBeNull()
    expect(normalizeEstimateHours(0)).toBeNull()
    expect(normalizeEstimateHours(-3)).toBeNull()
  })
})

describe('dayVerdict', () => {
  it('asserts over when the estimates exceed capacity', () => {
    expect(dayVerdict(6, 5, 2)).toBe('over')
  })

  it('calls a day that fills most of it ok', () => {
    expect(dayVerdict(5, 5, 2)).toBe('ok')
    expect(dayVerdict(3, 5, 1)).toBe('ok')
  })

  it('asserts under when more than 40% of the day is idle', () => {
    expect(dayVerdict(1, 5, 1)).toBe('under')
    expect(dayVerdict(2, 5, 1)).toBe('under') // 2 < 3
  })

  it('distinguishes an empty day from an under-filled one', () => {
    expect(dayVerdict(0, 5, 0)).toBe('empty')
    expect(dayVerdict(1, 5, 1)).toBe('under')
  })

  it('reports work slotted onto a zero-capacity day as over, not under', () => {
    // A task on someone's day off is exactly what the check exists to catch.
    expect(dayVerdict(2, 0, 1)).toBe('over')
    expect(dayVerdict(0, 0, 0)).toBe('empty')
  })

  it('does not call an unestimated-only day over', () => {
    // Nothing planned but there IS a task: the missing estimate is the finding, not the utilisation.
    expect(dayVerdict(0, 5, 1)).toBe('under')
  })
})

describe('dates', () => {
  it('walks an inclusive range and refuses a reversed one', () => {
    expect(datesBetween('2026-09-01', '2026-09-03')).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(datesBetween('2026-09-03', '2026-09-01')).toEqual([])
    expect(datesBetween('2026-09-01', '2026-09-01')).toEqual(['2026-09-01'])
  })

  it('crosses a month and a DST boundary without dropping or duplicating a day', () => {
    // Europe's clocks go back on 2026-10-25. All arithmetic is UTC precisely so this stays 31 days.
    expect(datesBetween('2026-10-01', '2026-10-31')).toHaveLength(31)
    expect(datesBetween('2026-10-24', '2026-10-27')).toEqual([
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ])
  })

  it('walks back to the last WORKING day, so a Monday standup still shows Friday', () => {
    // 2026-09-07 is a Monday; 2026-09-04 the Friday before it.
    expect(previousWorkingDay('2026-09-07')).toBe('2026-09-04')
    // Saturday and Sunday both answer the same Friday - nothing was done on either.
    expect(previousWorkingDay('2026-09-05')).toBe('2026-09-04')
    expect(previousWorkingDay('2026-09-06')).toBe('2026-09-04')
    // Mid-week it is simply yesterday.
    expect(previousWorkingDay('2026-09-09')).toBe('2026-09-08')
    // Across a month boundary: 2026-10-01 is a Thursday.
    expect(previousWorkingDay('2026-10-01')).toBe('2026-09-30')
    // And across one that lands on a Monday: 2026-06-01 is a Monday, 2026-05-29 the Friday.
    expect(previousWorkingDay('2026-06-01')).toBe('2026-05-29')
  })

  it('knows the weekend', () => {
    expect(isWeekend('2026-09-05')).toBe(true) // Saturday
    expect(isWeekend('2026-09-06')).toBe(true) // Sunday
    expect(isWeekend('2026-09-07')).toBe(false) // Monday
  })

  it('subtracts weekends and days the calendar zeroes from the window', () => {
    const days = workingDays('2026-09-07', '2026-09-13', { hours_by_date: { '2026-09-09': 0 } })
    expect(days).toEqual(['2026-09-07', '2026-09-08', '2026-09-10', '2026-09-11'])
  })

  it('gives someone with zero hours no working days at all', () => {
    expect(workingDays('2026-09-07', '2026-09-11', { hours: 0 })).toEqual([])
  })

  it('counts a weekend the calendar puts hours on', () => {
    expect(workingDays('2026-09-05', '2026-09-07', { hours_by_date: { '2026-09-05': 4 } })).toEqual([
      '2026-09-05',
      '2026-09-07',
    ])
  })

  it('defaults to 5 hours and zeroes out non-working days', () => {
    expect(capacityOn('2026-09-07')).toBe(5)
    expect(capacityOn('2026-09-07', { hours: 3 })).toBe(3)
    expect(capacityOn('2026-09-05')).toBe(0) // Saturday
    expect(capacityOn('2026-09-07', { hours_by_date: { '2026-09-07': 0 } })).toBe(0)
  })

  it('lets the calendar override both the default and the weekend rule', () => {
    expect(capacityOn('2026-09-07', { hours: 5, hours_by_date: { '2026-09-07': 2 } })).toBe(2)
    expect(capacityOn('2026-09-05', { hours_by_date: { '2026-09-05': 3 } })).toBe(3) // a worked Saturday
    expect(capacityOn('2026-09-07', { hours: 0, hours_by_date: { '2026-09-07': 6 } })).toBe(6)
  })
})

describe('sprintCapacity', () => {
  const range = ['2026-09-07', '2026-09-11'] as const

  it('reports only people who appear in availability or hold a slotted task', () => {
    const loads = sprintCapacity(range[0], range[1], [
      { assignee: 'alice', slot_date: '2026-09-07', estimate_hours: 2 },
    ])
    expect([...new Set(loads.map((l) => l.user))]).toEqual(['alice'])
    expect(loads).toHaveLength(5) // one per day in the range
  })

  it('returns nothing for an empty sprint rather than a grid of the whole directory', () => {
    expect(sprintCapacity(range[0], range[1], [])).toEqual([])
  })

  it('ignores tasks that are unassigned or slotted outside the window', () => {
    const loads = sprintCapacity(range[0], range[1], [
      { assignee: null, slot_date: '2026-09-07', estimate_hours: 2 },
      { assignee: 'alice', slot_date: '2026-10-01', estimate_hours: 6 },
      { assignee: 'alice', slot_date: null, estimate_hours: 6 },
    ])
    expect(loads).toEqual([])
  })

  it('counts unestimated tasks separately from the planned hours', () => {
    const loads = sprintCapacity(range[0], range[1], [
      { assignee: 'alice', slot_date: '2026-09-07', estimate_hours: 2 },
      { assignee: 'alice', slot_date: '2026-09-07', estimate_hours: null },
    ])
    const mon = loads.find((l) => l.date === '2026-09-07')!
    expect(mon.taskCount).toBe(2)
    expect(mon.unsized).toBe(1)
    expect(mon.planned).toBe(2)
  })

  it('flags a task slotted onto a day off as over capacity', () => {
    const loads = sprintCapacity(
      range[0],
      range[1],
      [{ assignee: 'alice', slot_date: '2026-09-09', estimate_hours: 2 }],
      { alice: { hours_by_date: { '2026-09-09': 0 } } },
    )
    const wed = loads.find((l) => l.date === '2026-09-09')!
    expect(wed.hours).toBe(0)
    expect(wed.verdict).toBe('over')
  })
})

describe('checkSprint', () => {
  it('blocks on over-capacity days only, reporting the rest', () => {
    const loads = sprintCapacity(
      '2026-09-07',
      '2026-09-08',
      [
        { assignee: 'alice', slot_date: '2026-09-07', estimate_hours: 8 }, // 8h against 5h -> over
        { assignee: 'alice', slot_date: '2026-09-08', estimate_hours: 1 }, // 1h against 5h -> under
      ],
      {},
    )
    const check = checkSprint(loads)
    expect(check.ok).toBe(false)
    expect(check.over.map((l) => l.date)).toEqual(['2026-09-07'])
    expect(check.under.map((l) => l.date)).toEqual(['2026-09-08'])
  })

  it('passes a sprint whose days fit inside capacity', () => {
    const loads = sprintCapacity('2026-09-07', '2026-09-07', [
      { assignee: 'alice', slot_date: '2026-09-07', estimate_hours: 2 },
      { assignee: 'alice', slot_date: '2026-09-07', estimate_hours: 2 },
    ])
    expect(checkSprint(loads).ok).toBe(true)
  })
})

describe('burndown', () => {
  // Mon 2026-09-07 to Fri 2026-09-11, one person at 8h/day. Scope: 4 tasks x 10h = 40h.
  const week = { start: '2026-09-07', end: '2026-09-11' }
  const avail = { carol: { hours: 8 } }
  const task = (hours: number, doneAt?: string) => ({
    estimate_hours: hours,
    status: doneAt ? 'done' : 'active',
    done_at: doneAt ?? null,
  })

  it('is one point per WORKING day, ending at zero', () => {
    const pts = burndown(week.start, week.end, [task(10), task(10), task(10), task(10)], avail)
    expect(pts.map((p) => p.date)).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
    ])
    // Every value is the END of its day, so day one already sits a step below the 40h total.
    expect(pts[0]?.ideal).toBe(32)
    expect(pts.at(-1)?.ideal).toBe(0)
  })

  it('leaves weekends OFF the axis entirely, rather than drawing them flat', () => {
    const pts = burndown('2026-09-11', '2026-09-14', [task(10)], avail)
    expect(pts.map((p) => p.date)).toEqual(['2026-09-11', '2026-09-14'])
    expect(pts.map((p) => p.ideal)).toEqual([5, 0])
  })

  it('keeps a day the calendar puts somebody on, weekend or not', () => {
    const pts = burndown('2026-09-11', '2026-09-14', [task(10)], {
      carol: { hours: 8, hours_by_date: { '2026-09-12': 4 } },
    })
    expect(pts.map((p) => p.date)).toEqual(['2026-09-11', '2026-09-12', '2026-09-14'])
  })

  it('burns the actual line on done_at, and stops it at today', () => {
    const pts = burndown(
      week.start,
      week.end,
      [task(10, '2026-09-07T09:00:00Z'), task(10, '2026-09-08T09:00:00Z'), task(10), task(10)],
      avail,
      '2026-09-09',
    )
    const on = (d: string) => pts.find((p) => p.date === d)?.remaining
    expect(on('2026-09-07')).toBe(30)
    expect(on('2026-09-08')).toBe(20)
    expect(on('2026-09-09')).toBe(20) // today, nothing done yet
    expect(on('2026-09-10')).toBeNull() // tomorrow is not a claim
    expect(on('2026-09-11')).toBeNull()
  })

  it('lands work finished on a skipped day on the NEXT working day', () => {
    // Sat 12th and Sun 13th are off the axis; the 10h done on the Saturday burns on the Monday.
    const pts = burndown('2026-09-11', '2026-09-14', [task(10, '2026-09-12T11:00:00Z'), task(10)], avail)
    expect(pts.find((p) => p.date === '2026-09-11')?.remaining).toBe(20)
    expect(pts.find((p) => p.date === '2026-09-14')?.remaining).toBe(10)
  })

  it('counts work finished before the window opened on day one', () => {
    const pts = burndown(week.start, week.end, [task(10, '2026-09-01T09:00:00Z'), task(10)], avail)
    expect(pts[0]?.remaining).toBe(10)
  })

  it('degrades to an even step per working day when nobody has availability', () => {
    // Mon-Thu with no roster: four working days, four equal steps.
    const pts = burndown('2026-09-07', '2026-09-10', [task(8)], {})
    expect(pts.map((p) => p.ideal)).toEqual([6, 4, 2, 0])
  })

  it('has nothing to say about a sprint with no dates or no scope', () => {
    expect(burndown('2026-09-11', '2026-09-07', [task(10)], avail)).toEqual([])
    const empty = burndown(week.start, week.end, [], avail)
    expect(empty.every((p) => p.ideal === 0 && p.remaining === 0)).toBe(true)
  })
})

describe('assertTitleLength', () => {
  const long = 'x'.repeat(TITLE_MAX + 1)

  it('accepts a title at the limit', () => {
    expect(() => assertTitleLength('task', 'i/t', 'x'.repeat(TITLE_MAX), undefined)).not.toThrow()
  })

  it('refuses an over-long title on create, and says where the detail goes', () => {
    expect(() => assertTitleLength('task', 'i/t', long, undefined)).toThrow(/max 64 - put the detail in the doc body/)
  })

  it('refuses an over-long title when an existing one is being CHANGED', () => {
    expect(() => assertTitleLength('task', 'i/t', long, 'the old short title')).toThrow(/title is 65 chars/)
  })

  // The whole point of the guard being conditional: 41 rows predate the rule with titles up to 363
  // chars, and flipping one to done must not fail because of prose the caller never mentioned.
  it('leaves a carried-forward legacy title alone', () => {
    expect(() => assertTitleLength('task', 'i/t', undefined, long)).not.toThrow()
    expect(() => assertTitleLength('task', 'i/t', long, long)).not.toThrow()
  })

  it('names the kind, so an initiative error does not read as a task one', () => {
    expect(() => assertTitleLength('initiative', 'growth', long, undefined)).toThrow(/^initiative growth:/)
  })
})
