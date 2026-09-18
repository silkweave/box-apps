# `reminders` - a date/time, a name, an optional description

One table and four procedures. A reminder is a moment in time, the thing to be reminded of, and
optionally a line about why. It has no status field, no repetition, no snooze and no delivery: the
only state it carries is `done_at`, and the only thing it does is sit in a list that an agent can
read and write. Everything a team wants beyond that - a notification, a recurrence, an owner - is a
customisation, and the app is deliberately small enough to make each of them an obvious edit.

- **dependsOn**: nothing. It is the reference for "an app that owns exactly one table": `sink` owns
  none, and every other app in the registry owns several and depends on `data`.
- **Removal**: `rm -rf` the three source directories, then `DROP TABLE reminders` if the rows are
  not wanted. Nothing else in the registry imports it.

## Tables

`reminders` (owned; `models: [REMINDERS]`, `migrations: []`).

| column | type | notes |
|---|---|---|
| `id` | text, PK | a UUID. A reminder is never addressed by name, and renaming one must not move it |
| `title` | text | what to be reminded of. Trimmed; blank is refused |
| `due_at` | timestamp | when. Stored naive-UTC, read back as ISO-Z by the record layer |
| `description` | text, null | the optional line. `''` on the way in becomes `NULL` |
| `done_at` | timestamp, null | NULL is open, a stamp is done. The whole lifecycle |
| `created_at` / `updated_at` | timestamp | `timestamps: true` |
| `created_by` / `updated_by` | text, null | `audit: true`, stamped from the caller's principal |

`due_at` is a `timestamp` rather than a `date` on purpose: a reminder with no time of day is a
to-do, and `planning`'s `tasks` already owns that shape. There is no `status` enum beside `done_at`
- two places to say one thing disagree the first time one of them is set.

Every write goes through `warehouse/model.ts` (`upsertRecord` / `deleteRecord`), so the timestamp
convention, the audit stamp, the enum validation and the `table:reminders` change-feed emit are
core's, not this app's. `packages/core/src/features/reminders/state.ts` contains no SQL.

## Procedures and tools

`RemindersController` (`@Controller('reminders')`, class-level `@UseGuards(AuthGuard)`):

| tRPC | MCP | what |
|---|---|---|
| `remindersList` (query) | `reminders-list` | every reminder, open ones first, then soonest first |
| `remindersUpsert` (mutation) | `reminder-upsert` | create (no `id`; needs `title` + `due_at`) or partially update |
| `remindersDone` (mutation) | `reminder-done` | complete (`done: true`) or reopen; the stamp is server-side |
| `remindersDelete` (mutation) | `reminder-delete` | remove one, returning the fresh list |

Procedure names are **derived**, not declared: the tRPC name is the controller prefix plus the
method name (`@Controller('reminders')` + `delete()` -> `remindersDelete`), while the MCP name is
whatever `@Mcp({ name })` says. The two do not have to agree and here they deliberately read
differently: tRPC names are namespaced by the controller, MCP tool names by the noun.

Timestamps come back as second-precision ISO-Z (`2026-10-01T09:00:00Z`), not
`Date#toISOString()`'s millisecond form - DuckDB's `TIMESTAMP` is naive and the record layer
re-attaches the `Z` on read.

`description: ''` clears the description - the `@Mcp()` adapter cannot express `| null`, so this is
the same convention `crm` and `planning` use. Validation lives in core's `state.ts`, so a tool call
and a click are refused for the same reason with the same sentence; the controller only turns that
sentence into a 400.

## Actions

None. Nothing here is schedulable, because nothing here delivers anything (see "What a team
customises").

## UI

- **Routes**: `/reminders`, one page. A reminder has no detail worth a route of its own.
- **Nav**: one entry, `Reminders`, icon `AlarmClock`, order band **750**.
- **Settings / shell / slots / docs**: none.
- `lib/useRemindersData.ts` is one `createDataStore` registered on `table:reminders`, so a write
  made by an agent through MCP lands in an open dashboard without a refresh.
- The due field is **two controls**: core's `DateInput` (date-only by design) plus a 24-hour `HH:MM`
  text input. `@silkweave/box-ui` has no date-TIME field, and a native `<input type='datetime-local'>`
  would reintroduce exactly the browser-locale formatting that `DateInput` exists to end.

## Env

None.

## npm dependencies

None. `deps.json` is `{}` - everything it renders comes from `@silkweave/box-ui`, `lucide-react` and
React, all of which core already brings.

## What a team customises

1. **Make it fire.** The app stores reminders; it does not deliver them. With `alerts` and
   `notifications` installed, the honest wiring is an `ActionSpec` on this feature that sweeps
   `due_at <= now() AND done_at IS NULL` and hands each one to the alert route, scheduled by
   `automation`. That is a real feature and is deliberately not here - it would make `reminders`
   depend on three other apps to do the one thing it does.
2. **Recurrence.** A `repeat` column (an RRULE string, or a simpler `every_days` int) plus a
   re-arm in `setReminderDone`. Migration `001`, and the first one this app will ever need.
3. **An owner.** `assignee`, a `UserPicker` in the row, and a filter to "mine". The audit columns
   already record who last touched a reminder, which is not the same question.
4. **The nav band**, in `apps/web/src/features/reminders/index.tsx`.
