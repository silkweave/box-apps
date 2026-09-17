# `crm` - accounts, contacts, meetings, revenue, activities

The pipeline, worked one company at a time. An **account** is a company and, because there is
deliberately no Deal object, it is also the deal: `status` carries the whole lifecycle, so Lead,
Customer and Churned are three values of one column rather than three tables. Around it sit the
**contacts** (the humans at that company), the **meetings** (future appointments with an outcome),
the **revenue events** (invoices and payments, at the grain of the invoice) and the **activities**
(messages exchanged, append-only). Two write paths run side by side: a human one that physically
cannot express a provider-owned column, and a machine one (`import.ts`, `upsertImportedMeeting`,
`upsertImportedRevenueEvent`, `upsertCrmActivity`) that re-asserts provider columns on every run and
never overwrites a human's judgement. Rows the machine cannot attribute are written anyway and land
in the **assign queue**, because a row written nowhere visible is a row lost.

- **dependsOn**: `data`, and entirely on the WEB side - the board surface. `crm` imports data's
  `BoardKanban`, `BoardViewBar`, `GridHeader`, `GridFooter`, `presetIcon`
  (`features/data/components/board/*`), its saved-view store (`createViewStore`, `ViewStore`,
  `BoardBarSpec` from `features/data/lib/boardView.ts`) and `useDataSources`
  (`features/data/lib/useSourcesData.ts`, which labels a contact's origin on the detail page).
  Nothing in `packages/core/src/features/crm` or `apps/server/src/features/crm` imports another
  feature. Remove `data` and the accounts table, the pipeline board, the view bar and the saved
  views in the CRM sidebar all fail to resolve.
- **Depended on by**: nothing, since `relay` was removed on 2026-09-13. `relay` was the
  predecessor's webhook glue and the only caller of its outreach-tool sync; both went in the same
  commit. **The template ships no sync at all** - the machine write path above is the door a team's
  own sync calls into (see `AGENT.md` § 2, item 6).

## Tables

Five, all prefixed `crm_`. The prefix is load-bearing: it is what keeps "no `crm_*` table is ever
publicly reachable" a greppable, scannable claim. Every table carries `timestamps: true` and
`audit: true`, so the record layer manages `created_at` / `updated_at` and `created_by` /
`updated_by` (from the call's `actor`) on top of the declared columns.

| table | pk | what it holds |
|---|---|---|
| `crm_accounts` | `id` (a slug, `acme-uk`) | one company = one deal. `status`, `owner`, `source`, `referral_partner`, `mrr_usd` (the operator's hand-maintained pipeline weight, **not** a finance number, and typed rather than derived - see **What a team customises**), `close_probability`, `waiting_on`, `next_action(_at)`, `last_contacted_at`, subscription window, `website`, `tags`, `notes`, pause window, `loss_reason`, the renewal-risk triple, the three external links (`stripe_customer_id`, `supabase_space_id`, `whatsapp_group_jid`), an `external` JSON bag and the derived `name_key` |
| `crm_contacts` | `id` (the source's lead id verbatim, or a slug) | one human at exactly one account: `account_id`, `name`, `headline`, `email`, `phone`, `linkedin_url`, `role`, `is_primary` (int 0/1, at most one per account), `external_stage`, `tags`, `notes`, the derived `linkedin_key`, `last_activity_at` |
| `crm_meetings` | `id` (idempotency IS the pk; machine rows are namespaced, e.g. `gcal:<event>`) | one sales conversation with a lifecycle: `account_id`/`contact_id` (nullable - null means the assign queue), `kind`, `scheduled_at`, `duration_min`, `outcome`, `rescheduled_count`, `source`, `meet_code`, `attendee_email`, `title`, `matched_by`, `notes`, `external` (organizer, attendees, transcript path, `rescheduled_from[]`) |
| `crm_revenue_events` | `id` (namespaced, `hubspot:inv:...` / `stripe:inv:...`) | one money event at invoice grain: `account_id` (nullable = queue), `provider`, `kind`, `status`, `amount` + `currency` + `amount_usd` (frozen at `issued_at`'s rate) + `collected_usd` (struck once, at `paid_at`'s rate) + `fx_rate`/`fx_rate_month`, `issued_at`/`due_at`/`paid_at`/`refunded_at`, `period_months` and the **stored** coverage window `covers_from`/`covers_to`, `payer_email`, the external invoice/payment/subscription ids, `invoice_number`, `superseded_by`, `description`, `matched_by`, `notes` |
| `crm_activities` | `id` (`<provider>:msg:<message id>` for synced rows, `manual:<uuid>` for hand-logged ones) | one message exchanged with a contact: `account_id` (denormalized from the contact on purpose), `contact_id`, `channel`, `direction`, `occurred_at`, `body`, `subject`, `thread_id`/`thread_index`, `message_type`, `interaction_type`, `author_name`, `campaign_id`/`campaign_name`, `external` |

**Deleting a parent CASCADES to its activities** (2026-09-14), and it is the other half of the
"a synced row cannot be hand-deleted" refusal: `readCrmActivities` only ever queries by
`account_id`, so a row left behind by a parent delete is INVISIBLE, and the per-row delete refuses
synced rows, so it is also PERMANENT - with no backfill able to re-create it either. Both
`deleteCrmContact` and `deleteCrmAccount` therefore drop them by raw DELETE inside the same write,
and both reports carry `activities_deleted` plus a warning naming the count.

**Baseline DDL: none.** `migrations: []` in `manifest.ts` - the tables are created from the
`ModelSpec`s by `ensureSchema()`, and there is no bootstrap SQL, no index declaration and no DDL
foreign key (the warehouse has none anywhere; `account_id` integrity is enforced in the domain, in
`upsertCrmContact` / `upsertCrmMeeting`).

## Files on disk

`<BOX_DATA_DIR>/docs/crm/<account-id>.md` - the account's prose, one file per account, path a pure
function of the (already slug-shaped) id and re-checked to stay inside the base dir. The format is
two ATX sections: a `## Next move` block that must be the first content line after any frontmatter,
and `## Notes` (or any later level-1/2 heading) for the rest. Headings, rather than an HTML comment
delimiter, because TipTap measurably drops comments on round trip (`docs.ts` records the
measurement, 2026-08-26). `crm_accounts.next_action` and `crm_accounts.notes` are **derived caches**
of that file, refreshed on every doc write so the kanban card and the table sort have something
queryable.

Nothing else. A sync a team writes keeps its own configuration under `<BOX_DATA_DIR>/config/` and
its secrets in core's `config/credentials.json`, the way every other integration does.

## Four rules with reasons behind them

Salvaged on 2026-09-13 from the pre-split `docs/CONTENT.md`, which is gone. Each was learned the
expensive way.

**Primary contact is a FLAG on the contact (`is_primary`), never a pointer on the account.** A
pointer dangles on every contact delete and needs a fixup nobody remembers to write; a flag dies
with the row it describes. Three invariants, all in `state.ts`: the first contact of an account
becomes primary automatically, promoting one demotes every sibling in a single statement, and
deleting or re-parenting the primary promotes the oldest remaining contact and says so in the
delete report. An account with people and no primary is a silent broken state nothing surfaces,
which is why the promotion is automatic rather than a prompt.

**`status: 'archived'` is the honest "remove"; delete is for mistakes.** The rows never leave, which
is what makes "never re-import someone a human archived" true by construction: an archived account's
contacts still match and still refresh, they just emit no events and are hidden by default. A delete
cascades to the contacts, and any contact still active upstream comes back attached to a BRAND NEW
account with a re-seeded status, so owner, MRR, next action and notes are gone for good. The
account's markdown file is left on disk by a delete, the way planning docs are, so the prose is
recoverable even though the row is not.

**Do not pick a markdown delimiter for a WYSIWYG doc without round-tripping it through the actual
editor first.** The first attempt at the account doc used an HTML-comment sentinel, chosen because
`docSummary` already skips comments. Driving the real TipTap editor showed the comment is parsed and
DROPPED: one keystroke deleted the delimiter and the whole doc collapsed into notes with
`next_action` silently wiped. A probe of six candidates settled it: ATX headings, bold lines and
blockquotes survive byte-identical; `<!-- comment -->` and `[//]: # (ref)` are eaten. Parsing is
position-anchored (only a leading opener counts, so a `## Next move` typed inside the notes cannot
re-partition the file) and anything unrecognisable degrades to "no next action, all of it is notes"
without dropping a byte. The two headings are rendered as static chrome OUTSIDE both editors:
structure the editor never contains is structure the user cannot delete or mangle.

**When a deal has a shape, the shape wins over a typed MRR.** The foundation ships no shape -
product, plan, quantity and price are one team's commercial vocabulary, not the CRM's (a product
decision, 2026-09-14) - and stores `mrr_usd` as typed. The rule to carry over when a team adds one
(`AGENT.md` § "Adding a deal shape"): `mrr_usd` becomes DERIVED and a passed value is ignored, and
the UI shows MRR read-only exactly when something derives it, because an editable box would accept
a value the server discards and the edit would silently revert. Clear the plan and the box comes
back.

## Personal data

**This feature holds real people's data. Say it out loud before installing it.**

| table | categories |
|---|---|
| `crm_contacts` | full name, job headline, **email address**, **phone number**, LinkedIn profile URL, free-text notes about the person |
| `crm_activities` | the **body of real messages** (LinkedIn DMs, InMail subjects, hand-logged calls, emails and letters), who sent them, when, and under which campaign |
| `crm_meetings` | `attendee_email` kept **raw** (it is the matcher's input, and an unmatched row must stay re-matchable once a contact later gains an email), meeting titles, notes, organizer and attendee list in `external` |
| `crm_revenue_events` | `payer_email` raw, invoice numbers and amounts |
| `crm_accounts` | company-level, but `referral_partner` is a named human ("Sam at Acme"), `notes` is free text, and the docs on disk are prose about people |

Access is internal users only: `@Controller('crm')` carries a bare `@UseGuards(AuthGuard)`, so
collaborators are denied by the guard's deny-by-default, and over MCP the transport demands a
user-role bearer. Agents reading `crm-accounts` get real names - those must never reach a
public-facing draft.

**Removing the feature does NOT drop the tables** (`docs/core/SEAM.md` § 3.4: the data is the tenant's,
and `rm -rf` of code must never be the thing that destroys it). After an uninstall the `crm_*`
tables and every row in them are still in the warehouse, and the markdown docs are still under
`docs/crm/`. Purging them is a **separate, deliberate step** a human takes with intent - not a side
effect of removing a directory.

## Procedures and tools

`CrmController` (`@Controller('crm')`, class-level `@UseGuards(AuthGuard)`). Eighteen procedures,
seventeen of them also MCP tools.

| tRPC | MCP | what |
|---|---|---|
| `crmAccounts` (query) | `crm-accounts` | every account with its contacts nested; no server-side filtering - one payload behind one live store |
| `crmAccountUpsert` (mutation) | `crm-account-upsert` | create or partially update a company; Box-owned columns only. Refuses a `stripe_customer_id` / link already held by another account |
| `crmAccountDelete` (mutation) | `crm-account-delete` | remove a company and report what went with it - its contacts AND their activities (`contacts_deleted`, `activities_deleted`) |
| `crmContactUpsert` (mutation) | `crm-contact-upsert` | create or partially update a person; `account_id` required on create, re-parents on update; first contact becomes primary |
| `crmContactDelete` (mutation) | `crm-contact-delete` | remove a person and their activities (`activities_deleted`) and report: will the source re-send them, who was promoted to primary, is the account now uncallable |
| `crmActivities` (mutation) | `crm-activities` | every message with an account across all its contacts, oldest first |
| `crmActivityLog` (mutation) | `crm-activity-log` | the human write path - a call, an untracked email, a letter. Keyed `manual:<uuid>`; editing a synced row is refused |
| `crmActivityDelete` (mutation) | `crm-activity-delete` | hand-logged rows only (a synced message would just come back) |
| `crmMeetings` (mutation) | `crm-meetings` | a filtered list of meetings, newest first; filtering is SQL |
| `crmMeetingUpsert` (mutation) | `crm-meeting-upsert` | the human write path; on a `calendar`/`transcript` row it cannot express a provider-owned column at all |
| `crmMeetingDelete` (mutation) | `crm-meeting-delete` | a human undoing a mistake; warns when the row will be re-created by the next calendar run |
| `crmRevenueEvents` (mutation) | `crm-revenue-events` | a filtered list of money events; superseded rows hidden once, here, rather than deduplicated by every consumer |
| `crmRevenueEventUpsert` (mutation) | `crm-revenue-event-upsert` | the human write path; `kind` and the coverage window are the two fields it exists for |
| `crmRevenueEventDelete` (mutation) | `crm-revenue-event-delete` | same shape as the meeting delete |
| `crmAssignQueue` (mutation) | `crm-assign-queue` | everything a sync could not decide, both tables in one call |
| `crmDoc` (mutation) | `crm-doc-read` | one account's markdown doc from disk (empty if none yet) |
| `crmDocSave` (mutation) | `crm-doc-save` | write the doc, and re-derive the row's `next_action` / `notes` caches |
| `crmDocRegionsSave` (mutation) | - | the dashboard's autosave target, deliberately NOT an MCP tool: the panel owns two regions, an agent wants the whole markdown and keeps `crm-doc-save` |

Most reads are mutations on purpose: they carry an input body, and an input-less query is the only
query shape that reflects cleanly (the same call `planning`'s doc read makes).

The two machine writers - `upsertImportedMeeting` and `upsertImportedRevenueEvent`, plus
`upsertImportedAccount` / `upsertImportedContact` / `upsertCrmActivity` - are **not** exposed as MCP
tools. Nothing a model or a human types can reach them; they are library functions the syncs call.

## Actions

**None.** `manifest.ts` declares no `actions`, so `crm` contributes nothing to core's run funnel and
`automation` has nothing of its own to schedule here. There is no sync in the template; a team that
writes one against `import.ts` decides then whether it is an action (scheduled) or event-driven.

## UI

- **Routes**: `/crm` is a layout (`CrmLayout`) with three children - `/` (`CrmAccountsTable`, the
  index), `queue` (`CrmAssignQueue`) and `$id` (`CrmAccountDetailView`). `queue` is registered
  before `$id` so the static segment reads as the statement it is. Contacts get no route of their
  own; they live on the account page.
- **Nav**: one entry, `CRM`, icon `Contact`, order band **600**.
- **Settings / shell / slots / onSession**: none. `defineWebFeature` passes `routes` and `nav` only.
  The top-bar cluster on the accounts table is filled per-view with `TopBarActions` from
  `@silkweave/box-ui`, which is the shell extension seam rather than a manifest field.
- **Inside the layout**: a sidebar that is NAVIGATION, not a filter - the saved views (from data's
  view store) above, then the ten most recently opened accounts (per-browser `localStorage`; where
  you have been is not team state), plus an assign-queue entry badged with its count. Filtering
  lives in exactly one place, the view bar.
- **The accounts index** is two layouts over one view model: a full-width data grid with
  totallable columns, and a pipeline kanban you drag cards through (`CrmKanban` over data's
  `BoardKanban`).
- **The detail page** carries the account fields, the contacts list, the markdown doc (lazy -
  `CrmAccountDocLazy`, because TipTap is large), a conversation stream over `crm_activities`, a
  meetings panel and a money panel.
- **Live reload**: `useCrmData` registers `table:crm_accounts` and `table:crm_contacts`;
  `useCrmEvents` subscribes to `table:crm_meetings`, `table:crm_revenue_events` and
  `table:crm_activities`. Meetings, revenue and activities are fetched PER ACCOUNT and not folded
  into the accounts payload, which is already ~294KB.

## Env

**None declared.** `defineServerFeature({ id: 'crm', module: CrmModule })` has no `env` key, so
`pnpm typegen` prints nothing for it. Keep it that way when adding a sync: what a sync needs is
configuration, not env - a file under `<BOX_DATA_DIR>/config/` for its map of stages and spaces,
and its API key in `config/credentials.json` read through core's `credential()`. Unconfigured
should mean the sync does nothing, never that the feature fails to load.

## What a team customises

Everything below is a plain list in `packages/core/src/features/crm/types.ts` unless noted. Editing
an enum needs no migration until a Box has shipped rows with the old values; after that, a migration
in `migrations.ts` rewrites them.

- **The pipeline itself** - `CRM_ACCOUNT_STATUSES`:
  `stale -> meeting_requested -> meeting_booked -> demo -> proposal -> confirmed -> customer ->
  onboarding`, with `at_risk` / `churned` / `lost` / `archived` as the exits. Two derived sets ride
  on it: `CRM_PAYING_STATUSES` and `CRM_PIPELINE_STATUSES`. This is the single most team-specific
  thing in the feature.
- **Where deals come from** - `CRM_ACCOUNT_SOURCES` (`direct`, `inbound`, `outbound`, `referral`,
  `partner`, `existing`, `unknown`).
- **What you sell** - deliberately NOT in the foundation. No product, plan or price vocabulary
  ships and `mrr_usd` is typed by hand (a product decision, 2026-09-14: the deal shape is an
  optional spec a team implements on top of the CRM, on demand). `AGENT.md` § "Adding a deal
  shape" is that spec - the two axes, the derivation, and every file an enum column touches.
- **The people vocabularies** - `CRM_CONTACT_ROLES` (`decision_maker`, `buyer`, `user`, `other`),
  `CRM_WAITING_ON` (`me` / `them`), `CRM_ACTION_CHANNELS`, `CRM_ACTIVITY_CHANNELS` (with
  `CRM_ACTIVITY_CHANNEL_LABEL`) and `CRM_ACTIVITY_DIRECTIONS`.
- **Meetings and money** - `CRM_MEETING_KINDS` / `_OUTCOMES` / `_SOURCES` / `_MATCHED_BY`,
  `CRM_REVENUE_PROVIDERS` (`hubspot`, `stripe`, `manual`), `_KINDS`, `_STATUSES`, `_MATCHED_BY`, and
  `CRM_RENEWAL_RISKS`.
- **Column ownership** - `CRM_ACCOUNT_BOX_COLUMNS`, `CRM_ACCOUNT_FUTURE_PROVIDER_COLUMNS`,
  `CRM_CONTACT_PROVIDER_COLUMNS` / `_BOX_COLUMNS`, `CRM_MEETING_PROVIDER_COLUMNS` / `_BOX_COLUMNS`,
  `CRM_REVENUE_PROVIDER_COLUMNS` / `_BOX_COLUMNS`. Moving a column between the two lists is how a
  team decides whether a sync or a human owns it.
- **The matching rules** (`identity.ts` + `state.ts`). The five-rung ladder, strongest first:
  1. `contact` - a contact already carries this provider's external key (the steady state);
  2. `linkedin` - `linkedinKey()` on the profile URL matches;
  3. `company_urn` - an account carries the provider's stable company id (`external.company_urn`);
  4. `name` - `companyNameKey()` agrees ("Northwind Pte Ltd." = "Northwind");
  5. `domain` - `websiteDomain()` / `emailDomain()` agree.
  Rungs 1-3 are exact; 4 and 5 are judgements, which is why the rung is recorded on the row. No
  match returns null and the caller **creates** an account - a duplicate is visible and mergeable, a
  wrong merge silently blends two companies. The tunables: `LEGAL_SUFFIXES` (longest-first,
  Singapore-flavoured today: `pte ltd`, `sdn bhd`, ...), `LETTER_FOLDS`, and the `FREE_MAIL` set
  that stops a gmail address being read as a company domain.
- **The import's stage vocabulary** - `CRM_IMPORT_STAGES` (the upstream `external_stage` values
  that mean "still active at the source, will re-import"; the delete reports read it) and
  `CRM_ACCOUNT_STATUS_SEED` (what status a sync-created account is born with; nothing reads it
  today). Both are placeholders inherited from the predecessor's outreach tool - a team wiring a
  sync replaces them with the stages its source actually reports, and keeps a stage like
  "Interested" deliberately OUT of the CRM by simply not mapping it.
- **Labels and order** - the nav label and order band in `apps/web/src/features/crm/index.tsx`; the
  grid's offered columns, widths, hints and aggregates in `lib/crmView.ts` (`CRM_COLUMNS`,
  `PIPELINE_COLUMNS`, the closed-status set, the MRR chip buckets); the display labels in
  `crm-types.ts` (`CRM_ACCOUNT_SOURCE_LABEL`, `CRM_MEETING_KIND_LABEL`,
  `CRM_REVENUE_STATUS_LABEL`, ...).
