// The CRM doc reserved-block format: the parse/serialize pair that carries an account's
// next-action prose (under `## Next move`) and its notes (under `## Notes`). Pure functions only -
// no disk, no warehouse. The load-bearing properties: byte-idempotent writes, lossless degradation
// on a mangled heading (notes are NEVER truncated, and an unterminated block can never swallow
// them), position-anchoring (headings inside notes never re-partition), frontmatter tolerance, and
// notes preserved byte-exact when only the block changes.

import { describe, expect, it } from 'vitest'
import {
  CRM_DOC_NEXT_HEADING,
  CRM_DOC_NOTES_HEADING,
  LEGACY_CRM_DOC_SENTINEL,
  absorbIntoCrmDoc,
  applyCrmDocRegions,
  convertLegacyCrmDoc,
  readCrmDocRegions,
  crmDocPath,
  parseCrmDoc,
  renderCrmDoc,
  updateCrmDocNextAction,
  updateCrmDocNotes,
} from './docs.js'

const NEXT = CRM_DOC_NEXT_HEADING // '## Next move'
const NOTES_H = CRM_DOC_NOTES_HEADING // '## Notes'
const NOTES = 'Demo 5 Jun. Strong call.\n\nICP: B2B, sales-led.'
const CANON = `${NEXT}\n\nChase Mark for the Friday slot.\n\n${NOTES_H}\n\n${NOTES}\n`

describe('parseCrmDoc', () => {
  it('splits a canonical doc into block and notes', () => {
    expect(parseCrmDoc(CANON)).toEqual({
      nextAction: 'Chase Mark for the Friday slot.',
      notes: NOTES,
    })
  })

  it('reads a doc with no structure as pure notes', () => {
    expect(parseCrmDoc(`${NOTES}\n`)).toEqual({ nextAction: '', notes: NOTES })
    expect(parseCrmDoc('')).toEqual({ nextAction: '', notes: '' })
  })

  it('reads an empty block (both headings, nothing between) as no next action', () => {
    expect(parseCrmDoc(`${NEXT}\n\n${NOTES_H}\n\n${NOTES}\n`)).toEqual({ nextAction: '', notes: NOTES })
  })

  it('reads a top-anchored notes heading alone as explicit no-next-action, heading excluded', () => {
    expect(parseCrmDoc(`${NOTES_H}\n\n${NOTES}\n`)).toEqual({ nextAction: '', notes: NOTES })
  })

  it('degrades editor-plausible manglings to all-notes without losing a byte of prose', () => {
    for (const opener of [
      'Next move', // heading toggled to plain text
      '### Next move', // demoted a level - the easy TipTap accident
      '## Next moves', // reworded
      '##Next move', // space eaten, no longer a heading
    ]) {
      const doc = `${opener}\n\nChase Mark.\n\n${NOTES_H}\n\n${NOTES}\n`
      const parsed = parseCrmDoc(doc)
      expect(parsed.nextAction).toBe('')
      expect(parsed.notes).toBe(doc.trim()) // everything, mangled opener included - nothing eaten
    }
  })

  it('degrades an UNTERMINATED opener to all-notes - deletion of ## Notes must never swallow the notes into the kanban column', () => {
    const doc = `${NEXT}\n\nChase Mark.\n\nLong prose with no headings at all.\n`
    expect(parseCrmDoc(doc)).toEqual({ nextAction: '', notes: doc.trim() })
  })

  it('tolerates case and level 1-2 on the opener, canonical or not', () => {
    for (const opener of ['# NEXT MOVE', '## next move', '# Next Move']) {
      expect(parseCrmDoc(`${opener}\n\nChase Mark.\n\n${NOTES_H}\n\n${NOTES}\n`)).toEqual({
        nextAction: 'Chase Mark.',
        notes: NOTES,
      })
    }
  })

  it('is position-anchored: a ## Next move typed inside the notes never re-partitions', () => {
    const doc = `Some prose first.\n\n${NEXT}\n\nlooks like a block but is notes\n\n${NOTES_H}\n`
    expect(parseCrmDoc(doc)).toEqual({ nextAction: '', notes: doc.trim() })
  })

  it("accepts a USER heading as the block terminator, keeping that heading in the notes - the deleted-## Notes case", () => {
    const doc = `${NEXT}\n\nChase Mark.\n\n## Meeting log\n\n${NOTES}\n`
    expect(parseCrmDoc(doc)).toEqual({
      nextAction: 'Chase Mark.',
      notes: `## Meeting log\n\n${NOTES}`,
    })
  })

  it('leaves ## headings deep inside the notes alone - only the FIRST terminator partitions', () => {
    const doc = `${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\nIntro.\n\n## Timeline\n\n2026-08-01 demo.\n\n## Next move\n\nnot a block\n`
    expect(parseCrmDoc(doc)).toEqual({
      nextAction: 'Chase Mark.',
      notes: `Intro.\n\n## Timeline\n\n2026-08-01 demo.\n\n## Next move\n\nnot a block`,
    })
  })

  it('skips leading YAML frontmatter - it belongs to neither region', () => {
    const doc = `---\nstatus: customer\n---\n${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\n${NOTES}\n`
    expect(parseCrmDoc(doc)).toEqual({ nextAction: 'Chase Mark.', notes: NOTES })
    // frontmatter + body, no structure: the body alone is notes
    expect(parseCrmDoc(`---\na: 1\n---\n${NOTES}\n`)).toEqual({ nextAction: '', notes: NOTES })
  })

  it('flattens a multi-line markdown block, embedded ### heading marks stripped, to one plain cache line', () => {
    const doc = `${NEXT}\n\nSend **screenshots** to [Luke](https://x.example)\nthen \`chase\` the team.\n### by Friday\n\n${NOTES_H}\n\nNotes.\n`
    expect(parseCrmDoc(doc).nextAction).toBe('Send screenshots to Luke then chase the team. by Friday')
  })

  it('handles a block-only doc (nothing under ## Notes yet)', () => {
    expect(parseCrmDoc(`${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n`)).toEqual({ nextAction: 'Chase Mark.', notes: '' })
  })

  it('accepts an EMPTY heading as terminator - TipTap emits bare ## when the heading text is deleted', () => {
    expect(parseCrmDoc(`${NEXT}\n\nChase Mark.\n\n##\n\n${NOTES}\n`)).toEqual({
      nextAction: 'Chase Mark.',
      notes: `##\n\n${NOTES}`,
    })
  })
})

describe('updateCrmDocNextAction', () => {
  it('inserts the full canonical structure atop an unstructured doc, keeping the notes verbatim', () => {
    const out = updateCrmDocNextAction(`${NOTES}\n`, 'Chase Mark for the Friday slot.')
    expect(out).toBe(CANON)
  })

  it('is byte-idempotent: setting the same value twice changes nothing', () => {
    const once = updateCrmDocNextAction(`${NOTES}\n`, 'Chase Mark.')
    expect(updateCrmDocNextAction(once, 'Chase Mark.')).toBe(once)
  })

  it('replaces only the block bytes - notes with odd spacing preserved exactly', () => {
    const oddTail = `${NOTES_H}\n\n\n  indented note line\n\ttabbed\n\n`
    const doc = `${NEXT}\n\nOld action.\n\n${oddTail}`
    expect(updateCrmDocNextAction(doc, 'New action.')).toBe(`${NEXT}\n\nNew action.\n\n${oddTail}`)
  })

  it('keeps a re-cased opener and a user terminator heading byte-exact when replacing the block', () => {
    const doc = `# NEXT MOVE\n\nOld action.\n\n## Meeting log\n\n${NOTES}\n`
    expect(updateCrmDocNextAction(doc, 'New action.')).toBe(`# NEXT MOVE\n\nNew action.\n\n## Meeting log\n\n${NOTES}\n`)
  })

  it('clears the block but keeps both headings, so the panel keeps its editing surface', () => {
    expect(updateCrmDocNextAction(CANON, '')).toBe(`${NEXT}\n\n${NOTES_H}\n\n${NOTES}\n`)
  })

  it('clearing an unstructured doc is a no-op - no structure is invented to say nothing', () => {
    const doc = `${NOTES}\n`
    expect(updateCrmDocNextAction(doc, '')).toBe(doc)
  })

  it('builds a canonical doc from empty content', () => {
    expect(updateCrmDocNextAction('', 'Chase Mark.')).toBe(`${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n`)
  })

  it('inserts a block above a top-anchored ## Notes doc, preserving that heading line', () => {
    const doc = `${NOTES_H}\n\n${NOTES}\n`
    expect(updateCrmDocNextAction(doc, 'Chase Mark.')).toBe(`${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\n${NOTES}\n`)
  })

  it('inserts after frontmatter, preserving it byte-exact', () => {
    const fm = `---\nstatus: demo\n---\n`
    const out = updateCrmDocNextAction(`${fm}${NOTES}\n`, 'Chase Mark.')
    expect(out).toBe(`${fm}${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\n${NOTES}\n`)
  })

  it('leaves authored markdown in the block alone when the flattened value matches (cache echo)', () => {
    const doc = `${NEXT}\n\nSend **screenshots** to Luke.\n\n${NOTES_H}\n\n${NOTES}\n`
    expect(updateCrmDocNextAction(doc, 'Send screenshots to Luke.')).toBe(doc)
  })

  it('collapses a multi-line input value to one flowed line', () => {
    expect(updateCrmDocNextAction('', 'Chase Mark\nfor the slot.')).toBe(`${NEXT}\n\nChase Mark for the slot.\n\n${NOTES_H}\n`)
  })
})

describe('updateCrmDocNotes', () => {
  it('replaces the notes region, preserving frontmatter, block and headings', () => {
    const fm = `---\na: 1\n---\n`
    const doc = `${fm}${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\nOld notes.\n`
    expect(updateCrmDocNotes(doc, 'New notes.')).toBe(`${fm}${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\nNew notes.\n`)
  })

  it('replaces the whole body of an unstructured doc without inventing structure', () => {
    expect(updateCrmDocNotes(`Old notes.\n`, 'New notes.')).toBe('New notes.\n')
  })

  it('is a byte no-op when the trimmed value already matches - hand formatting never reflows', () => {
    const doc = `${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\n\n${NOTES}\n\n`
    expect(updateCrmDocNotes(doc, NOTES)).toBe(doc)
  })

  it('clears the notes, keeping both headings', () => {
    expect(updateCrmDocNotes(CANON, '')).toBe(`${NEXT}\n\nChase Mark for the Friday slot.\n\n${NOTES_H}\n`)
  })

  it('re-installs the canonical ## Notes when the region began at a USER heading - a notes write must not unterminate the block', () => {
    const doc = `${NEXT}\n\nChase Mark.\n\n## Meeting log\n\nOld notes.\n`
    expect(updateCrmDocNotes(doc, 'New notes.')).toBe(`${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\nNew notes.\n`)
  })

  it('writes under a top-anchored ## Notes doc, keeping the heading line', () => {
    expect(updateCrmDocNotes(`${NOTES_H}\n\nOld.\n`, 'New.')).toBe(`${NOTES_H}\n\nNew.\n`)
  })
})

describe('renderCrmDoc', () => {
  it('renders the canonical shapes, both headings always present', () => {
    expect(renderCrmDoc('Chase Mark.', NOTES)).toBe(`${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\n${NOTES}\n`)
    expect(renderCrmDoc('', NOTES)).toBe(`${NEXT}\n\n${NOTES_H}\n\n${NOTES}\n`)
    expect(renderCrmDoc('Chase Mark.', '')).toBe(`${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n`)
  })

  it('round-trips through parseCrmDoc', () => {
    expect(parseCrmDoc(renderCrmDoc('Chase Mark.', NOTES))).toEqual({
      nextAction: 'Chase Mark.',
      notes: NOTES,
    })
  })
})

describe('absorbIntoCrmDoc (migration 018 content step)', () => {
  it('renders a blank doc fresh from the columns', () => {
    expect(absorbIntoCrmDoc('', 'Chase Mark.', NOTES)).toBe(`${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\n${NOTES}\n`)
    expect(absorbIntoCrmDoc('', '', NOTES)).toBe(`${NEXT}\n\n${NOTES_H}\n\n${NOTES}\n`)
  })

  it('leaves a blank doc blank when the columns are blank too', () => {
    expect(absorbIntoCrmDoc('', '', '  ')).toBe('')
  })

  it('is idempotent by content: re-running on a migrated doc changes nothing', () => {
    const once = absorbIntoCrmDoc('', 'Chase Mark.', NOTES)
    expect(absorbIntoCrmDoc(once, 'Chase Mark.', NOTES)).toBe(once)
  })

  it('adds a missing block above existing notes without touching them', () => {
    expect(absorbIntoCrmDoc(`${NOTES}\n`, 'Chase Mark.', NOTES)).toBe(`${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\n${NOTES}\n`)
  })

  it('never clobbers a doc that already carries different prose - the doc wins', () => {
    const doc = `${NEXT}\n\nHand-written action.\n\n${NOTES_H}\n\nHand-written notes.\n`
    expect(absorbIntoCrmDoc(doc, 'Stale column action.', 'Stale column notes.')).toBe(doc)
  })

  it('fills only the empty region of a partial doc', () => {
    const blockOnly = `${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n`
    expect(absorbIntoCrmDoc(blockOnly, 'Stale column action.', NOTES)).toBe(`${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\n${NOTES}\n`)
  })
})

describe('convertLegacyCrmDoc (migration 019, sentinel -> headings)', () => {
  const S = LEGACY_CRM_DOC_SENTINEL

  it('converts a canonical legacy doc', () => {
    expect(convertLegacyCrmDoc(`Chase Mark.\n\n${S}\n\n${NOTES}\n`)).toBe(
      `${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\n${NOTES}\n`,
    )
  })

  it('converts a legacy doc with an empty head (sentinel at top)', () => {
    expect(convertLegacyCrmDoc(`${S}\n\n${NOTES}\n`)).toBe(`${NEXT}\n\n${NOTES_H}\n\n${NOTES}\n`)
  })

  it('preserves frontmatter', () => {
    const fm = `---\na: 1\n---\n`
    expect(convertLegacyCrmDoc(`${fm}Chase Mark.\n\n${S}\n\n${NOTES}\n`)).toBe(
      `${fm}${NEXT}\n\nChase Mark.\n\n${NOTES_H}\n\n${NOTES}\n`,
    )
  })

  it('returns null when there is nothing to convert - blank, no sentinel, or already heading-format', () => {
    expect(convertLegacyCrmDoc('')).toBeNull()
    expect(convertLegacyCrmDoc(`${NOTES}\n`)).toBeNull()
    // A heading-format doc whose NOTES merely mention the old sentinel must never re-partition.
    expect(convertLegacyCrmDoc(`${NEXT}\n\nChase.\n\n${NOTES_H}\n\nThe old marker was ${S} - retired.\n`)).toBeNull()
  })

  it('is content-idempotent: the converted output converts to null', () => {
    const converted = convertLegacyCrmDoc(`Chase Mark.\n\n${S}\n\n${NOTES}\n`)!
    expect(convertLegacyCrmDoc(converted)).toBeNull()
  })
})

describe('applyCrmDocRegions (the locked-block panel save)', () => {
  it('THE degraded transition: typing a next move into a hand-mangled doc canonicalizes it with every byte of prose intact, once', () => {
    // A doc someone mangled by hand: opener demoted, so it parses as all-notes. The panel loaded
    // nextAction '' and notes = the entire body; the user then typed into the empty top region.
    const mangled = `### Next move\n\nOld action text.\n\n${NOTES_H}\n\n${NOTES}\n`
    const loaded = parseCrmDoc(mangled)
    expect(loaded).toEqual({ nextAction: '', notes: mangled.trim() })
    const out = applyCrmDocRegions(mangled, { nextAction: 'Call Bob.', notes: loaded.notes })
    expect(out).toBe(`${NEXT}\n\nCall Bob.\n\n${NOTES_H}\n\n${mangled}`)
    // Round trip: the block is the new value, the notes are the old body - nothing eaten, nothing doubled.
    expect(parseCrmDoc(out)).toEqual({ nextAction: 'Call Bob.', notes: mangled.trim() })
  })

  it('degraded doc + empty next action + edited notes still canonicalizes (the residual path)', () => {
    const out = applyCrmDocRegions(`just prose, no structure\n`, { nextAction: '', notes: 'edited prose' })
    expect(out).toBe(`${NEXT}\n\n${NOTES_H}\n\nedited prose\n`)
    expect(parseCrmDoc(out)).toEqual({ nextAction: '', notes: 'edited prose' })
  })

  it('unchanged regions are a byte no-op on a canonical doc', () => {
    const loaded = parseCrmDoc(CANON)
    expect(applyCrmDocRegions(CANON, loaded)).toBe(CANON)
  })

  it('unchanged regions are a byte no-op on a DEGRADED doc - no restructuring behind the user', () => {
    const mangled = `Next move\n\nplain text opener\n\n${NOTES}\n`
    const loaded = parseCrmDoc(mangled)
    expect(applyCrmDocRegions(mangled, loaded)).toBe(mangled)
  })

  it('is byte-idempotent: applying the same regions twice equals applying them once', () => {
    const regions = { nextAction: 'Call Bob.', notes: 'Fresh notes.' }
    const once = applyCrmDocRegions(`old prose\n`, regions)
    expect(applyCrmDocRegions(once, regions)).toBe(once)
  })

  it('applies both regions to a canonical doc', () => {
    const out = applyCrmDocRegions(CANON, { nextAction: 'New action.', notes: 'New notes.' })
    expect(out).toBe(`${NEXT}\n\nNew action.\n\n${NOTES_H}\n\nNew notes.\n`)
  })

  it('preserves a user terminator heading byte-exact when only the block changes', () => {
    const doc = `${NEXT}\n\nOld.\n\n## Meeting log\n\n${NOTES}\n`
    const loaded = parseCrmDoc(doc)
    const out = applyCrmDocRegions(doc, { nextAction: 'New.', notes: loaded.notes })
    expect(out).toBe(`${NEXT}\n\nNew.\n\n## Meeting log\n\n${NOTES}\n`)
  })

  it('preserves frontmatter through the degraded canonicalization', () => {
    const fm = `---\nstatus: demo\n---\n`
    const out = applyCrmDocRegions(`${fm}loose prose\n`, { nextAction: 'Call Bob.', notes: 'loose prose' })
    expect(out).toBe(`${fm}${NEXT}\n\nCall Bob.\n\n${NOTES_H}\n\nloose prose\n`)
  })

  it('builds a canonical doc from empty content, and leaves empty-on-empty empty', () => {
    expect(applyCrmDocRegions('', { nextAction: 'Call Bob.', notes: 'Notes.' })).toBe(
      `${NEXT}\n\nCall Bob.\n\n${NOTES_H}\n\nNotes.\n`,
    )
    expect(applyCrmDocRegions('', { nextAction: '', notes: '' })).toBe('')
  })
})

describe('readCrmDocRegions (raw regions, for seeding the panel editors)', () => {
  const doc = [
    '## Next move',
    '',
    'Chase **Mark** about the [proposal](https://x.test).',
    '',
    '## Notes',
    '',
    'Demo held 5 Jun.',
  ].join('\n')

  it('returns the block as RAW markdown, unlike the flattened cache value', () => {
    expect(readCrmDocRegions(doc).nextAction).toBe('Chase **Mark** about the [proposal](https://x.test).')
    // parseCrmDoc is the column cache: same region, flattened to plain text.
    expect(parseCrmDoc(doc).nextAction).toBe('Chase Mark about the proposal.')
  })

  it('agrees with parseCrmDoc on notes, and on both regions when the block is plain', () => {
    expect(readCrmDocRegions(doc).notes).toBe(parseCrmDoc(doc).notes)
    const plain = '## Next move\n\nCall them.\n\n## Notes\n\nBody.\n'
    expect(readCrmDocRegions(plain)).toEqual(parseCrmDoc(plain))
  })

  it('degrades exactly as parseCrmDoc does: unrecognized structure is all notes', () => {
    const mangled = 'Just some prose nobody structured.\n'
    expect(readCrmDocRegions(mangled)).toEqual({ nextAction: '', notes: 'Just some prose nobody structured.' })
  })

  it('round-trips inline marks through a region save (the fidelity this exists for)', () => {
    // Seed the editor from the raw region, save it back unchanged: the block survives byte-exact.
    expect(applyCrmDocRegions(doc, readCrmDocRegions(doc))).toBe(doc)
  })

  it('keeps the marks once the user EDITS the block - where the flattened seed loses them', () => {
    // An unchanged save is safe either way (updateCrmDocNextAction has a flatten-equality guard),
    // so the loss only shows up after a real edit. That edit is what this accessor exists for.
    const edit = (seed: string): string =>
      applyCrmDocRegions(doc, { nextAction: `${seed} Today.`, notes: readCrmDocRegions(doc).notes })

    expect(edit(readCrmDocRegions(doc).nextAction)).toContain('**Mark**')
    expect(edit(parseCrmDoc(doc).nextAction)).not.toContain('**Mark**')
  })
})

describe('crmDocPath', () => {
  it('maps an account id to docs/crm/<id>.md', () => {
    expect(crmDocPath('acme-leeds').replace(/\\/g, '/')).toBe('docs/crm/acme-leeds.md')
  })

  it('refuses non-slug ids - uppercase, dots, traversal, separators', () => {
    for (const bad of ['Acme-Leeds', 'a.b', '..', '../x', 'a/b', '-lead', '']) {
      expect(() => crmDocPath(bad)).toThrow()
    }
  })
})
