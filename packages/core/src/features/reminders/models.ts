// The reminders feature's one table.

import type { ModelSpec } from '../../warehouse/model.js'

/**
 * A thing to be reminded of at a moment in time. Three fields carry the whole idea - when, what,
 * and (optionally) why - and `done_at` is the only state it has: NULL is open, a stamp is done.
 *
 * `due_at` is a `timestamp`, not a `date`: a reminder without a time of day is a to-do, and
 * planning's `tasks` already owns that shape. The record layer stores it naive-UTC and hands it
 * back as ISO-Z, so every caller sees one convention (warehouse/model.ts).
 */
export const REMINDERS: ModelSpec = {
  table: 'reminders',
  pk: ['id'],
  columns: {
    id: { kind: 'text' },
    title: { kind: 'text' },
    due_at: { kind: 'timestamp' },
    // NULL, not '', so "no description" is one value rather than two.
    description: { kind: 'text', nullable: true },
    // The entire lifecycle: NULL = open, a stamp = done at that moment. A `status` enum would be a
    // second place to say the same thing, and the two would disagree the first time one was set.
    done_at: { kind: 'timestamp', nullable: true },
  },
  timestamps: true,
  audit: true,
}

/** Every table this feature owns - what the manifest baselines at boot. */
export const REMINDERS_MODELS = [REMINDERS] as const
