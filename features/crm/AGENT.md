# Installing `crm`

The recipe. Read [`SPEC.md`](./SPEC.md) first for what the feature is - in particular the
**Personal data** section, which is the reason this one deserves a deliberate decision rather than a
reflex. This file is how it gets into a Box and what to change afterwards.

## 1. Install

**Install `data` first.** `crm` declares `dependsOn: ['data']` and uses its board surface (the
kanban, the view bar, the grid header/footer, the saved-view store). `pnpm features --check` will
say so in as many words if it is missing.

**The scaffold is the working code**, not a copy of it (see `features/README.md`). `box adopt`
fetches it from the registry at its tag, byte-exact, and rewrites the registries and skill links:

```bash
box registry validate                  # confirm the index offers crm, and at which version
box adopt crm                          # fetches the four directories and anything it dependsOn
pnpm install && pnpm build             # adoption changes package.json; tests resolve via build/
pnpm verify                            # features:check, lint:deps, typegen, typecheck, lint, tests
pnpm schema:check                      # diagnostic, not part of verify: run it after a schema change
```

In this checkout `crm` is already installed; the above is what a fresh Box runs.

**Do not rename the directory.** The name is the migration ledger namespace (`crm:<name>` in
`schema_migrations`) and it is the same string in all three trees. `crm` ships `migrations: []`
today - the tables come from the `ModelSpec`s - but the rule has no exceptions, and the day someone
adds `001` a renamed directory re-runs history under a new key.

The core tests come with it: 9 files, 166 tests (`identity`, `matching`, `docs`, `accounts`,
`activities`, `account-links`, `meetings.import`, `revenue.import`, `revenue`). They are the
executable half of the matching and ownership rules; do not delete them while customising the
vocabularies.

Nothing else is edited. The five `crm_*` tables are created on first boot by `ensureSchema()`.

## 2. Customise for the team

In descending order of how wrong the defaults will be:

1. **The pipeline** - `CRM_ACCOUNT_STATUSES` in `packages/core/src/features/crm/types.ts`. The
   shipped ladder is
   `stale -> meeting_requested -> meeting_booked -> demo -> proposal -> confirmed -> customer ->
   onboarding` with `at_risk` / `churned` / `lost` / `archived` as exits. Keep
   `CRM_PAYING_STATUSES` and `CRM_PIPELINE_STATUSES` in step, and check `CLOSED`/`PIPELINE_COLUMNS`
   in `apps/web/src/features/crm/lib/crmView.ts` - the kanban's default columns are derived there.
2. **The deal shape** - none ships. `mrr_usd` is typed by hand; product, plan, quantity and price
   are one team's commercial vocabulary and deliberately not the foundation's (a product decision,
   2026-09-14). If this team wants MRR derived from what it sells, follow
   [Adding a deal shape](#adding-a-deal-shape-products-plans-pricing) below - second on this list
   because a wrong price table is a wrong pipeline weight on every card.
3. **The rest of the vocabularies** - sources, contact roles, meeting kinds/outcomes/sources,
   revenue providers/kinds/statuses, renewal risks, activity channels. Enum edits need no migration
   until the Box has shipped rows carrying the old values; after that, add a migration in
   `migrations.ts` that rewrites them.
4. **Who owns which column** - the `*_BOX_COLUMNS` / `*_PROVIDER_COLUMNS` lists. Moving a column
   between them is the decision "may a sync overwrite this?", and the input DTOs in
   `apps/server/src/features/crm/crm/crm.controller.ts` are shaped to match, so a tool call can
   never fight a sync.
5. **The matching rules** - `identity.ts`. `LEGAL_SUFFIXES` is longest-first and currently
   Singapore/UK-flavoured (`pte ltd`, `sdn bhd`, `pty ltd`); add the forms this team's customers
   actually register under, and keep the longest-first ordering or `northwind pte ltd` collapses to
   `northwind pte`. `FREE_MAIL` is what stops a gmail address being read as a company domain.
   `matching.test.ts` pins all five rungs - change the rules, change the test.
6. **A sync**, if this team has an outreach or billing source to mirror. The template ships none -
   the predecessor's went with `relay` on 2026-09-13. Write it against the machine path, which is
   the only door that can write a provider-owned column: `upsertImportedAccount` /
   `upsertImportedContact` (`import.ts`), `upsertCrmActivity`, `upsertImportedMeeting` and
   `upsertImportedRevenueEvent`; resolve accounts through `findAccountForImport` and record the
   rung it returns; write the company's stable id to `external.company_urn` so rung 3 can find it
   next time. Keep the configuration in `<BOX_DATA_DIR>/config/<source>.json` - a `data_source_id`,
   an `actor` (a real `users.id`: a sync acting for a person stamps the person, and the record layer
   REFUSES an unknown one on every audited write, so a typo here is a failed sync, not a silent
   one), and a stage map keyed on the source's **stage id**, never its name - and the key in
   `config/credentials.json`. Set `CRM_IMPORT_STAGES` to the stages your source reports as still
   active. No file should mean "not configured", never an error.
7. **Labels and order** - the nav label and order band (600) in
   `apps/web/src/features/crm/index.tsx`; the offered grid columns, their widths, hints and footer
   aggregates in `lib/crmView.ts`; the display label maps in `crm-types.ts`.

There is no `env` to set and no seed to run.

## 3. Prove it

```bash
pnpm dev
```

- `http://localhost:8190/crm` - the accounts board. Empty is fine on a fresh Box. **New account**
  writes a row; the sidebar shows the saved views and (once you open one) recent accounts; the
  layout toggle swaps the grid for the pipeline kanban and a card drags between status columns.
- `http://localhost:8190/crm/<account-id>` - the detail page: fields, contacts, the markdown doc
  (type in **Next move**, then check `<BOX_DATA_DIR>/docs/crm/<account-id>.md` on disk - the heading
  and the prose are really there, and the row's `next_action` now matches), the conversation stream,
  the meetings panel and the money panel.
- `http://localhost:8190/crm/queue` - the assign queue. Empty until a sync writes an unattributed
  row, a past meeting is still `scheduled`, or a paid recurring row has no coverage window.

Agent-side, the same surface is MCP:

```bash
pnpm cli crm-accounts
pnpm cli crm-account-upsert   # create or patch a company
pnpm cli crm-contact-upsert   # a person at it
pnpm cli crm-meetings         # filtered, newest first
pnpm cli crm-revenue-events
pnpm cli crm-assign-queue     # everything a sync could not decide
pnpm cli crm-doc-read / crm-doc-save
pnpm cli crm-activities / crm-activity-log / crm-activity-delete
```

Seventeen tools in total (every procedure except `crmDocRegionsSave`, which is the dashboard's
region autosave and deliberately has no MCP name). Remember what comes back: `crm-accounts` returns
real people's names and emails. They must never land in a public-facing draft.

## 4. Remove

**There is no removal command.** This code is yours: delete the directories, then check that
nothing else in your Box still imports `crm` and prune the npm packages
`features/crm/deps.json` declares that no remaining feature needs.


```bash
rm -rf packages/core/src/features/crm apps/server/src/features/crm apps/web/src/features/crm
pnpm features && pnpm verify
```

**Nothing depends on `crm`** since `relay` was removed on 2026-09-13, so this removal never
cascades.

**The data survives.** The five `crm_*` tables and every row in them stay in the warehouse, and the
markdown docs stay under `<BOX_DATA_DIR>/docs/crm/`. Re-adding the feature later simply resumes on
the same rows - that is the point of removal being a code operation. Deleting the accounts, the
contacts, the message bodies and the docs is a **separate, deliberate step**, taken by a human with
intent (`docs/core/SEAM.md` § 3.4: the data is the tenant's). Do it explicitly, not as a side effect.

## Adding a deal shape (products, plans, pricing)

The foundation stores `crm_accounts.mrr_usd` as a number somebody typed. It carries no product,
plan, quantity or price column and no price list: those are one team's commercial vocabulary, and
the template shipped one company's - two product lines, eight plan names, a USD list - until
2026-09-14, when it was decided that the CRM ships the foundation and the deal shape is an optional
spec a team implements on top of it, on demand. This section is that spec. The running example is a
hypothetical team selling two product lines, `platform` and `managed`, on a few billing terms.

### Two axes, on purpose

**Product is WHAT they buy; plan is HOW they are billed.** Keep them as two columns. Fold them into
one (`platform_monthly`, `managed_annual`, ...) and the list multiplies with every new term, a plan
comes to mean a billing term for one product and a package tier for the other, and "the managed
tier, billed quarterly" becomes inexpressible without minting a new value. Two axes means every
plan belongs to exactly one product (the price table says which) and the term is a property of the
plan. A plan from the other product's list on an account is always a mistake and a silent one - it
would derive a plausible number off the wrong price list - so the write path refuses it.

### Why derive MRR instead of typing it

`mrr_usd` exists so the pipeline can be sorted and weighed. Once a deal has a shape, the shape IS
the number: `quantity x unit price / months in the term`. Deriving it in one place, on write, is
what stops three roundings of one price landing in one column - in the predecessor's book the same
price entered by hand three times sat as 332, 332.3 and 332.33, which no report can group on. The
rules that follow:

- **Derived wins over a passed `mrr_usd`, by design.** When the shape can imply a number, whatever
  was typed alongside is ignored, and the UI shows MRR read-only exactly then - an editable box
  would accept a value the server discards, so the edit would silently revert.
- **When the shape cannot imply a number** - no plan, or a custom plan with no price set - the
  derivation returns null and the typed `mrr_usd` survives untouched. That is what keeps every row
  predating the shape exactly as it was.
- **A discount is derived, never stored**: `1 - unit_price / list_price`. Storing it is a second
  copy of the price waiting to drift.
- **Round to cents once, at the end**: `Math.round((quantity * unit) / months * 100) / 100`, with
  `quantity ?? 1` and `unit ?? listUsd`. A `listUsd: null` plan (custom pricing) must carry an
  explicit unit price or derive nothing.

### The checklist

An enum column crosses six places. This is the list, in the order that keeps the tree
type-checking between steps; `pnpm verify` catches a miss in the first four, the last two only
show in a browser.

1. **The core vocabulary** - `packages/core/src/features/crm/types.ts`. The unions and their
   arrays (`CrmAccountProduct` / `CRM_ACCOUNT_PRODUCTS`, `CrmAccountPlan` / `CRM_ACCOUNT_PLANS`),
   a `CRM_PLAN_PRICING: Record<CrmAccountPlan, { product; months; listUsd: number | null }>`
   table, and `deriveMrrUsd()` / `planDiscountPct()` as pure functions over
   `{ quantity, plan, unit_price_usd }`. Add the fields to `CrmAccount` and `CrmAccountInput`, and
   the column names to BOTH `CRM_ACCOUNT_BOX_COLUMNS` and `CRM_ACCOUNT_FUTURE_PROVIDER_COLUMNS` - a
   billing provider knows quantity, interval and price, and declaring that now is what stops a
   hand-maintained shape being silently overwritten the day it connects.
2. **The ModelSpec** - `models.ts`, `CRM_ACCOUNTS.columns`:
   `product: { kind: 'text', default: "'platform'", enum: CRM_ACCOUNT_PRODUCTS }`,
   `plan: { kind: 'text', nullable: true, enum: CRM_ACCOUNT_PLANS }`,
   `quantity: { kind: 'int', nullable: true }`, `unit_price_usd: { kind: 'float', nullable: true }`.
   The `enum` is the app-level CHECK constraint, and it is checked on the values a WRITE passes,
   never on read and never on what is already stored: a row carrying a value the list no longer
   names reads back fine, and `upsertCrmAccount` - which re-sends every column it resolves - refuses
   it on that row's next edit until the value is fixed, while the narrow doc-cache upsert in
   `saveCrmDoc` does not (which is why it is narrow). A fresh Box gets the columns from the
   baseline; **a Box that already has `crm_accounts` does not** - the baseline is `CREATE TABLE IF
   NOT EXISTS` - so also append the feature's first migration to `manifest.ts`
   (`{ name: '001-deal-shape', statements: ['ALTER TABLE crm_accounts ADD COLUMN IF NOT EXISTS product TEXT DEFAULT \'platform\'', ...] }`,
   one ALTER per column). Two DuckDB facts shape that statement, both measured on 2026-09-14: `IF
   NOT EXISTS` is honoured, so the same ALTER is safe to re-run; and `ADD COLUMN` refuses a
   constraint ("Adding columns with constraints not yet supported"), so write `DEFAULT` without
   `NOT NULL` - the NOT NULL in the ModelSpec holds on fresh Boxes, and on older ones the record
   layer writes every column explicitly anyway, so a null never lands. `pnpm schema:check` (a
   diagnostic; run it yourself, `verify` does not) proves the migration applies fresh, on reboot,
   and onto a Box that enabled `crm` later, and warns if it touches a table outside `crm_*`.
3. **The resolve-before-write block** - `state.ts`, `upsertCrmAccount`, at the comment that names
   itself as the seam. Resolve each new column the way the pause window is resolved
   (`input.x !== undefined ? input.x : (prev?.x ?? default)`), refuse a plan whose product is not
   the account's, then
   `const mrr = deriveMrrUsd({ quantity, plan, unit_price_usd }) ?? (input.mrr_usd !== undefined ? input.mrr_usd : (prev?.mrr_usd ?? null))`,
   and write the new columns in the `upsertRecord` call. Refuse a negative quantity beside the
   negative-MRR guard.
4. **The controller DTOs** - `apps/server/src/features/crm/crm/crm.controller.ts`. On
   `CrmAccountDto` an `@ApiProperty({ enum: CRM_ACCOUNT_PLANS })` per enum column; on
   `UpsertCrmAccountDto` an `@ApiProperty` plus `@IsOptional() @IsIn(CRM_ACCOUNT_PLANS)` per enum
   column, `@IsInt()` / `@IsNumber()` for the numbers. The description is what an agent reads over
   MCP, so say there that setting a plan makes `mrr_usd` derived and a passed value is ignored.
   `pnpm typegen` (part of `verify`) then rewrites `apps/web/src/generated/appRouter.d.ts`.
5. **The web mirror** - `apps/web/src/features/crm/crm-types.ts` is hand-written on purpose
   (`apps/web` does not depend on `@silkweave/box-core`): the same unions and arrays, a
   `CRM_ACCOUNT_PRODUCT_LABEL` / `CRM_ACCOUNT_PLAN_LABEL` map for the selects, the price table
   again, a `plansForProduct()` filter, and copies of `deriveMrrUsd` / `planDiscountPct` so the
   detail page can explain the number it shows. Add the fields to `CrmAccount` there and to
   `CrmAccountUpsert` in `lib/useCrmData.ts`.
6. **The UI control** - `views/CrmAccountDetailView.tsx`, the Deal card. A product select; a plan
   select over `plansForProduct(account.product)` with a sentinel item for "no plan" (the select
   needs a real value, null does not travel), where switching product clears a plan that no longer
   belongs because the server would refuse it; quantity and unit-price inline edits (the placeholder
   shows the list price); and the MRR field switching to a read-only figure with a "derived" badge,
   the discount, and the arithmetic spelled out whenever `deriveMrrUsd(account)` is non-null.
   Optionally a column and footer aggregate in `lib/crmView.ts` (`CRM_COLUMNS`).

Then the test. `accounts.test.ts` already pins what the seam does without a shape (a typed
`mrr_usd` survives every unrelated write, to the cent); add three pins beside it: a plan plus a
quantity stores the derived `mrr_usd` and ignores a passed one; a row with no plan keeps its typed
value across a later, unrelated write; and a plan from the other product's list is refused. The
third is what makes the two axes safe.

### If the list should be data rather than code

The recipe above compiles the vocabulary in, which is right for a list that changes when the
pricing page does. If this team's list changes more often than that - a new tier every quarter, a
partner rate per region - copy the planning feature's precedent instead: `config/initiative-kinds.json`,
read by `packages/core/src/features/planning/kinds.ts`. Its header states the argument in full; the
short version is that the built-ins survive as a SEED rather than a floor (a `seeded` flag, so a
deleted entry stays deleted instead of being helpfully restored by the next read), ids are
immutable because they are stored on rows, and the ModelSpec's `enum` becomes a THUNK
(`enum: () => planIds()`) so the write-time gate reads whatever the team's list says at write time
rather than what it said at import time. The price table then lives in the same file, the UI reads
it through a query instead of a compiled map, and a stored row can name a plan the file no longer
lists - which reads back fine and is refused on that account's next edit - so copy planning's
delete guard too and refuse to remove a plan an account still carries.

## Gotchas

- **Two write paths, and the human one is the narrow one.** `upsertCrmAccount` /
  `upsertCrmContact` / `upsertCrmMeeting` / `upsertCrmRevenueEvent` cannot express a provider-owned
  or structural column at all. A sync uses `import.ts`, `upsertImportedMeeting`,
  `upsertImportedRevenueEvent`, `upsertCrmActivity` - library functions with no MCP tool. If you
  need a sync to write something, widen the machine path, never the tool DTO.
- **`crm_accounts.mrr_usd` is not a finance number.** It is the operator's hand-maintained pipeline
  weight. Do not sum it into anything presented as revenue; `crm_revenue_events` is the sales-side
  money view, and the books live elsewhere.
- **Coverage windows are stored, not derived.** `covers_from` / `covers_to` exist because computing
  them from `paid_at + period_months` manufactures fake churn and fake new business on every late
  renewal. Likewise `amount_usd` is frozen at `issued_at`'s rate and `collected_usd` is a second
  column at `paid_at`'s rate - never rewrite the first when a row is paid. A refund is a status
  change plus `refunded_at`, never a negative row.
- **No machine may write `no_show`.** `scheduled` on a past meeting is an open question, not a
  state, and the assign queue is the only place it can be closed. A sync writing `scheduled` never
  overwrites `held`.
- **An account id is also a filename.** `accountSlug()` is tighter than core's `assertValidId` -
  `^[a-z0-9][a-z0-9-]*$` - because `docs/crm/<id>.md` must be a legal path. Generate ids through it,
  or the doc route 400s on an account nobody can open.
- **The doc format is position-anchored.** `## Next move` counts only as the first content line
  after any frontmatter; anything unrecognizable degrades to "no next action, all of it is notes"
  and never truncates the user's prose. Do not swap the ATX headings for an HTML comment - it was
  measured, and TipTap drops comments on round trip.
- **The editor chunk is lazy.** Import `CrmAccountDocLazy`, never `CrmAccountDoc` directly, or the
  accounts board pulls TipTap in with it.
- **`index.tsx` sits on the web feature-registry import cycle.** Never read a registry binding at
  module scope, and load the app in a browser after touching it - `pnpm verify` has no runtime step
  (`CLAUDE.md`).
- **Dev ports are 8190 / 5190.** `:8090` is the predecessor engine, still running beside this
  template's development Box; a Box on that port collides with it or, worse, gets mistaken for it.
- **Export `LC_ALL=en_US.UTF-8` before grepping this feature.** `identity.ts` contains non-ASCII
  escapes and several files carry non-ASCII bullets; macOS grep silently skips any file with a
  non-ASCII byte.
- **After a controller change, boot once (or `pnpm typegen`)** so `appRouter.d.ts` is rewritten, or
  the web typecheck is stale.
