---
name: ingest-sink
description: >
  Process a doc from the data/docs/sink/ inbox - refine it and turn it into tracked planning state.
  Use when the user says "/ingest-sink <file>", "process this sink doc", "log this idea", or points
  at a data/docs/sink/*.md file to be worked up. Routes ANY kind of work (content post-ideas, infra/feature
  ideas, OSS-PR targets, strategy/offerings) into a signals-bound initiative + tasks + a rationale doc.
requires: [content, planning, sink]
---

# /ingest-sink - process a sink doc into tracked work

The **sink** (`data/docs/sink/`) is the inbox: any doc that needs processing by a Claude Code session - a
chat export, a research dump, a raw post idea, a feature idea, an offering pitch. This skill picks one
up, **triages** it, and routes it into tracked planning state (a warehouse initiative + tasks + a
narrative doc).

The sink is **not** content-only. Any idea worth *tracking as a body of work* is in scope - a public
post, an internal tool, an OSS-PR campaign, a go-to-market play. The output shape is always the same
(**initiative + tasks + doc**); what changes per kind is the `kind` value, the tasks, the signal
binding, and how much public-facing verification is required.

Read [`CLAUDE.md`](../../../CLAUDE.md) operating rules first. The ones that bind here:
**honesty over reach**, **dates absolute**, **verify before you claim**, **drafts are drafts** (you
never publish). **Voice is sacred** binds only when the work is public-facing (the content route).

## Mode - local checkout or remote Box?

**Local** (CWD is the Box checkout, `data/docs/` on disk): follow the steps as written. **Remote**
(this skill is installed on a machine with no checkout, talking to a Box over the tailnet): no repo
files, no `pnpm cli`, no `warehouse` MCP - use the `mcp__box__*` tools over the tailnet: sink docs via `sink-read` / `sink-create` / `sink-save`,
grounding reads via `initiatives-get` / `content-list`, voice via `voice-read`. There is no remote
`pnpm idea:apply` - apply the plan directly with the `initiative-upsert` + `task-upsert` +
`doc-save` tools (same data, tool-shaped; targets via `initiative-upsert`'s target fields). Archive
the processed sink doc with `sink-delete` after its content is fully carried into the initiative
doc (remote has no `_done/` move). Everything else (preflight user check via the dashboard or an admin,
report contract) applies unchanged.

**Content ideas do NOT become initiatives (2026-08-12).** If the sink doc is a post idea, it becomes a
content **topic** (`topic-upsert`, status `planned` - an idea awaiting review) with its brief in
`data/docs/content/<slug>/topic.md`, and it gets no tasks. Everything else - features, capabilities,
defects, bets, decisions - is still an initiative with tasks, exactly as below. The line is whether
the work is a standing operational routine (content is) or a body of work beyond the default ops
scope (an initiative is).

**If the `box` tools are missing or 401ing, stop and route to `/consult`** (§ "my MCP isn't
connecting") rather than falling back to a degraded path. First check WHICH machine you are on: on
the Box host the checkout is present, skills are unprefixed, there is no plugin or marketplace, and
`mcp__box__*` is optional (Local mode runs on `pnpm cli`) - so missing `box` tools there are normal,
not a fault. Remote, they are the only data path and their absence IS the fault. Three facts that resolve almost every
case: the only reachable host is the Box's tailnet address, `https://box.example.ts.net` (a `box`
entry pointing at `127.0.0.1:8190` is the Box host's own loopback, reachable from nowhere else, and
must be removed and re-added against the tailnet URL; dashboard links are plain paths,
`https://box.example.ts.net/<path>`); the credential is
`BOX_MCP_TOKEN`, set per person, and a session must be restarted after it changes; and each person
has exactly ONE token that never expires, so a 401 usually means someone minted a NEW token and
silently revoked theirs - the fix is to have an admin REVEAL the existing one
(Settings -> Users -> View access token, or `pnpm auth:reveal <id>` on the Box host), never to
mint a second. Revealing is deliberately NOT an MCP tool - an agent cannot read anyone's token.

## Input

`$ARGUMENTS` is normally a sink filename (e.g. `IDEA_ALERTS.md`). It may also be raw text or a URL.
Resolve it:
- A bare name or path → read `data/docs/sink/<name>`.
- Raw text → use it directly.
- A URL → fetch it (note: claude.ai share links are JS-rendered SPAs and can't be fetched - ask the
  user to paste the content instead).

## Step 0 - Preflight (content route, first run / non-default author)

When the work is **content** and the owner/author is anyone other than `alice` (or the user states
publish intent, e.g. "post tomorrow"), check the runway BEFORE building anything, so no blocker is
discovered at publish time (the 2026-07-20 lesson: Carol's LinkedIn token question surfaced at 12:52
and was still open when the session ended):

1. **User row** - `SELECT id, role, status FROM users WHERE id='<author>'` (warehouse MCP): must be
   `active`. If not, flag it - access delivery is `pnpm cli user-link` (a short-lived sign-in link),
   or `pnpm auth:reveal <id>` on the host for their MCP config. NEVER `user-invite`, which rotates
   the token and breaks that user's headless pipelines.
2. **Voice overlay** - does `data/docs/identity/voice/<channel>@<author>.md` exist for each intended
   channel? A missing overlay is workable (channel layer only) but say so now, not at draft time.
3. **Channel credentials** - does `data/config/credentials.json` hold the author's account for each
   channel they intend to publish on (e.g. a `linkedin` entry for `carol`)? Read only the keys/shape,
   never print secret values. Missing = a publish blocker; name it in the report and route the fix
   to an admin.
4. **Dashboard access** - can the author see the result? If their access was never delivered (or
   they can't log in), send them a sign-in link now (reveal, not rotate) over whatever this team
   actually uses - chat if this Box has `chat`, otherwise however you normally reach them.

Report the preflight result in one short block up front: `ready` or the blocker list with owners.
Then continue - preflight blocks publish, not planning.

## Step 1 - Triage: classify the kind, then confirm the route

Read the doc and decide **what kind of work it is**. `kind` is validated against the team's OWN list
(tenant config, editable in Settings → Initiative kinds), so a value outside it is refused on write.
The table below is the list this template seeds - **check the live one with `initiative-kinds`** if a doc
does not obviously fit a row here, since the team can have added a lane since:

| If the doc is… | `kind` | Route |
|---|---|---|
| A post idea / argument / opinion worth **publishing** | `content` | **Content route** (below) - voice + claims ledger required |
| An **internal tool / feature / infra** idea for this repo | `infra` | **Work route** - often warrants a spec at `docs/prd-<slug>.md` too |
| A repo/target to land a **Silkweave PR** into | `oss-pr` | **Work route** - see [`silkweave-pr-targets.md`](../../../data/docs/initiatives/silkweave-pr-targets.md) |
| A **go-to-market / offering / strategy** play | `strategy` | **Work route** |
| A channel-growth push | `channel-growth` | **Work route** |
| A **product feature / workstream** on a shipped product | `product` | **Work route** |
| Something the product **cannot do at all today** | `capability` | **Work route** - often a foundation others wait on |
| A **defect group** found on a call, in a standup, or in the product | `bug` | **Work route** - rate the tasks with `priority` |
| A **company bet** - revenue, hiring, a market, a channel test | `business` | **Work route** |
| An **open question that needs settling**, with options and a recommendation | `decision` | **Work route** - the doc holds the options; close it by resolving, not shipping |
| Nothing more specific | `general` | **Work route** |
| Something with **no trackable body of work** (a transcript to summarize, a raw research dump) | - | Say so plainly and ask how the user wants it handled - **don't force-fit** it into an initiative |

If the kind is ambiguous, or the doc could plausibly be tracked-work vs. discard, **ask the user with
`AskUserQuestion`** before building anything (e.g. offer: track as an initiative / write a spec / both
/ just archive). Don't force-fit a non-post-idea into the content route - that was the old v1 limit;
it's gone now.

**Author decisions wait for the author** (`features/content/OPERATOR.md`, operator rule 2): when the source doc
holds multiple candidate ideas/posts and the initiative's owner is not you-the-driver's principal,
the *selection* belongs to that owner. Present the qualified shortlist via `AskUserQuestion`
addressed to them by name, and if they are not the one at the keyboard (screen share, impersonated
session), record the pick as **pending the author** and deliver the shortlist to them
instead of accepting a proxy "yes please".

## Step 2 - Refine + plan

Gather grounding first so the plan binds to reality, not memory:

- List the **real** signals to bind to (don't invent signal_ids):
  `mcp__warehouse__execute_query` → `SELECT DISTINCT channel, signal_id, label FROM legacy_signal_points ORDER BY 1,2`.
- Glance at an existing initiative doc of a **similar kind** for house style
  ([`silkweave-pr-targets.md`](../../../data/docs/initiatives/silkweave-pr-targets.md) for work;
  [`claude-max-5x-vs-20x.md`](../../../data/docs/initiatives/claude-max-5x-vs-20x.md) for content).
- **Content route only:** also read [`data/docs/identity/voice-guide.md`](../../../data/docs/identity/voice-guide.md).

For a **content** post-idea (the highest-bar route), prescribe a **multi-agent Workflow** (you are
authorized to call the `Workflow` tool here) with three roles - pass the raw doc + voice guide + signal
list into the prompts:

1. **Refine** - sharpen the angle / tension / the real take; strip marketing-speak; keep it
   builder-to-builder. Output the refined thesis + outline.
2. **Verify** (parallel with Refine) - web-check the load-bearing factual claims. Return a **claims
   ledger**: each claim tagged `verified` (with source) | `unofficial` (estimate / third-party) |
   `retired` (no longer published). Mandatory for public-facing work - per CLAUDE.md rule #4, anything
   not verified must be flagged in the doc, never stated as fact.
   This is **the intake fact-check** - the ONE place facts get verified in the whole pipeline
   (later, drafting smoke-checks wording and `/verify-content` gates the draft *against* this
   ledger; neither re-verifies facts). Say so when you run it. And when a verified figure
   **contradicts a number the author supplied or already published**, do not assert the new figure:
   run the reconciliation (`features/content/OPERATOR.md`, operator rule 3) - both numbers side by side, the
   counting difference in plain language (window / what's counted / scope), then `AskUserQuestion`:
   use the verified figure / keep theirs with a caveat / ask the data owner. The ledger
   records which figure won and why.
3. **Plan** (after 1+2) - emit ONE plan JSON (shape below).

For **non-content** work (infra / oss-pr / strategy / …) the same three beats apply but scale down -
a full Workflow is optional; doing it inline is fine:
- **Refine** - sharpen the problem, the tension, and the approach. For an infra/feature idea, name the
  key design tradeoff and reuse of existing modules; strip hand-waving.
- **Verify** - check the load-bearing facts appropriate to the kind (an OSS-PR target's stars/activity
  via `gh`; an infra idea's assumptions about what already exists in the repo). Internal specs don't
  need a public claims ledger - use an **Open questions / design decisions** section instead. Public
  claims still get the ledger.
- **Plan** - emit the plan JSON with the right `kind`, tasks that fit the work, and an honest signal
  binding.

### Plan JSON shape (all kinds)

```json
{
  "initiative": {
    "id": "<kebab-slug>", "title": "...",
    "status": "planned", "kind": "<one of the enum in the triage table>", "owner": "alice",
    "signal_ids": ["<real.signal.id>"],
    "target": { "signal_id": "<real.signal.id>", "value": 100, "by_date": "2026-09-30", "baseline": 40 },
    "value_customer": "<high|med|low|none>", "value_company": "<high|med|low|none>",
    "effort": "<s|m|l|xl>",
    "blocked_by": ["<initiative-id-this-waits-on>"],
    "tags": ["<free-form-label>"],
    "sort": 3
  },
  "tasks": [
    {"id": "<slug>/<step>", "title": "...", "status": "planned", "rank": 1, "effort": "<s|m|l|xl>"},
    {"id": "<slug>/<step>", "title": "...", "status": "planned", "rank": 2,
     "effort": "<s|m|l|xl>", "priority": "<1|2|3 stars - omit when you have no basis>", "tags": ["<label>"]}
  ],
  "doc": "# Initiative - <Title>\n\n**Status:** planned · **Kind:** <kind> · **Owner:** <user id>\n\n## The take\n...\n\n## Why it's worth doing\n...\n\n## Affected signals\n- `<signal>` - ...\n"
}
```

Rules for the plan:
- **`kind`** is validated against the team's configured list - pick one from the triage table, or from
  `initiative-kinds` if the team has added lanes. An unlisted value is refused, and the refusal names
  every allowed value.
- **The judgement dimensions** (`value_customer`, `value_company`, `effort`) are what make the item
  sortable against everything else on the board. Set them when the doc supports a call, and **leave
  them out when it doesn't** - `null` reads as "not yet judged", which is honest; guessing `med`
  to fill the field is not. Same rule as signals: never fabricate.
  - `value_customer` - worth to the people we serve. `value_company` - worth to us (revenue,
    retention, differentiation, our own operating leverage). They differ often; that is the point.
  - `effort` - size in HOURS, and the two scopes read differently. An **initiative**: `s` under a
    day · `m` a day to a week · `l` a week to a month · `xl` more. A **task**: `s` under an hour ·
    `m` 1-4h · `l` 4-8h · `xl` more than a day's work. Size the tasks and you can leave the
    initiative's off - the dashboard rolls it up from them, and flags a hand-set size the tasks
    contradict.
- **`blocked_by`** lists initiative ids this one waits on. Only use ids you have confirmed exist
  (list initiatives first); the server refuses unknown ids and cycles. An initiative that others wait
  on is a *foundation* - that is derived from these edges, so there is nothing to set for it.
- **`tags`** are free-form labels, lowercased server-side. Use them for the axes that don't have a
  column: product area, the customer who asked, the source. Reuse an existing tag over inventing a
  near-duplicate (list them first).
- **`priority`** is a 1-3 star rating on either an initiative or a task - `3` matters most. It
  replaced the old defect-only `severity` (p1/p2/p3/fixed) on 2026-08-24. Same honesty rule as the
  value axes: leave it out when the doc gives you no basis, rather than defaulting everything to 2.
- **No `summary` field any more** (2026-08-24). The one-liner the board shows under a title is the
  FIRST PARAGRAPH of the doc, derived on every doc save - so open `doc` with the sentence you would
  have put in `summary`, and write it for a reader.
- **`signal_ids`** must bind only to signal that exist in the catalog you listed. Bind
  **honestly**:
  - *Content* has no outcome signal yet - bind to the reach signal (`blog.posts`, `x.impressions`,
    `reddit.top_post_score`, `content.published_total`) and note the outcome could be derived later.
  - *Infra / enabling work* often has **no** natural outcome signal - bind to the nearest genuinely
    affected signal and say so in the doc; if there truly is none, an empty list is allowed, but prefer
    the nearest honest one. **Never fabricate a signal.**
  - *OSS-PR* binds to the stars/downloads/PR-merged signal it's meant to move.
  - *Product / capability / bug / business / decision* usually has no signal in this warehouse yet -
    an empty list is fine and expected. Carry the argument in `value_customer`/`value_company` and
    the evidence in the doc instead of inventing a binding.
- **Target (optional but encouraged when the doc names a concrete goal)**: the nested `target`
  object (`signal_id`/`value`/`by_date`/`baseline`, matching core's `InitiativeTarget`) sets the
  initiative's goal on one bound signal. The baseline is the signal' CURRENT value (fetch it, don't
  guess). The alert evaluator fires `initiative.target_reached` / `initiative.target_missed` off it,
  so only set a target the owner actually committed to - skip it for open-ended work. (`idea:apply`
  also lifts legacy flattened `target_*` fields into the nested shape, but author the nested form.)
- **Tasks** fit the kind - the funnel differs:
  - *Content:* `outline` (+ claims ledger) → `blog-draft` → `voice-check` → `cross-post`.
  - *Infra:* `design-review` → the build steps (one per component) → verify/ship.
  - *OSS-PR:* `scout` → `score/shortlist` → `de-risk (issue first)` → `open PR` → `merged`.
- **The doc** is the narrative (the take, why it's worth doing, affected signals, open questions). For
  **content**, it MUST include the claims ledger. For an **infra/feature** idea, when the design is
  non-trivial, also write a **separate technical spec** under `docs/prd-<slug>.md` (see
  [`AUTH.md`](../../../docs/AUTH.md) for the pattern) and have the initiative
  doc link to it - the initiative doc stays the *narrative*, the PRD holds the *design*.

Pick a stable `id` slug from the thesis (e.g. `claude-max-5x-vs-20x`, `alerts-event-listener`).

## Step 3 - Apply (deterministic, no server needed)

Write the plan JSON to the scratchpad and apply it:

```bash
pnpm idea:apply <path-to-plan.json>
```

This upserts the initiative + tasks and writes `data/docs/initiatives/<slug>.md`. It's idempotent. If the
doc body contains many escapes (a claims-ledger table, code fences), author the JSON with a tiny node
script and `JSON.stringify` rather than hand-escaping - hand-escaped `\n`-heavy JSON is easy to break.

## Step 4 - Confirm + archive

- Confirm the rows landed: `mcp__warehouse__execute_query` →
  `SELECT id, status, kind, signal_ids FROM initiatives WHERE id='<slug>'` and its tasks.
- Move the processed sink file into the archive so the queue stays clean:
  `git mv data/docs/sink/<name> data/docs/sink/_done/<name>` (or `mv` if untracked).

## Step 5 - Report

Tell the user: the initiative slug + dashboard link (`https://box.example.ts.net/initiatives/<slug>`), the doc path (and the PRD
path if you wrote one), the bound signals, and the task funnel. The initiative stays **status: planned** -
nothing is promoted or published.

End with the **report contract** (`features/content/OPERATOR.md`, operator rule 1) - for content initiatives:

```
IDEA ──▶ DRAFT ──▶ VERIFY ──▶ APPROVE ──▶ PUBLISH
  ▲ you are here (ingested; claims fact-checked)
Next: review the initiative at https://box.example.ts.net/initiatives/<slug>, then say "/draft-content <slug>"
Blockers ahead: <preflight findings, unresolved claims - or "none known">
```

For **work** initiatives the next step is executing the first task (e.g. the design review or the
scout) - still name it as ONE action with its link. Never end a run without "here is where you are,
here is the one thing to do next".
