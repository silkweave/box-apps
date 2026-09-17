---
name: verify-content
description: >
  Agent-verify a content piece before it's eligible to publish - check it against the voice hard-rules,
  its topic's claims ledger, and the channel's content profile (length/format/required fields),
  then record the verdict. Use when the user says "/verify-content <id>", "verify the reddit draft",
  or "run the content gate on <topic>". Records a verdict only; it NEVER publishes and NEVER
  moves a piece at all - only a human approves.
---

# /verify-content - the content quality gate

Run the verify lens over a content piece (or every piece of a topic) and record a structured
verdict via the `content-verify` MCP tool. **The verdict does not move the piece** (2026-08-13):
pass or fail, a draft stays a draft. What it records is findings, which a human then ticks off one by
one - Approve stays disabled until every finding is accepted. There is no `verified` status; it was
merged into `approved` on 2026-08-13, and the four live statuses are
`draft · approved · scheduled · published` (+ `archived` as an exit).

This is the gate that makes an approval mean something. It is the **only** lifecycle step the agent may
drive - the human transitions (`approve`, `schedule` / `publish-now`, `record-published`) are theirs
(CLAUDE.md operating rule #5: drafts are drafts, Claude never posts). Note `approved` SENDS NOTHING:
only a `scheduled` piece with its time passed is ever picked up by a publisher. Read [`CLAUDE.md`](../../../CLAUDE.md) first.

**What this gate is (and is not).** Per `features/content/OPERATOR.md` operator rule 4: facts were verified once,
at intake (the topic's claims ledger). This gate checks the draft *against* that ledger plus the
voice rules plus the channel profile - it does NOT re-verify facts, and it is a different pass from
the drafting smoke check (same rules, but this one records the verdict). Say so in the report. If
during the gate a ledger fact itself becomes contested (new data contradicts it), that is a
**reconciliation** for the author (operator rule 3), not a silent ledger edit.

## Mode - local checkout or remote Box?

**Local** (CWD is the Box checkout, `data/docs/` on disk): follow the steps as written. **Remote**
(this skill is installed on a machine with no checkout, talking to a Box over the tailnet): no repo
files, no `pnpm cli`, no `warehouse` MCP - use the `mcp__box__*` tools over the tailnet instead: the piece + body via `content-get`, the topic
doc (claims ledger) via `doc-read`, the channel profile from `content-list`'s `profiles` array
(NOT `profiles.ts`), voice layers via `voice-read {channel, author}`, the verdict via the
`content-verify` tool (the `pnpm cli` fallback below is local-only), tracker sync via
the topic via `topic-upsert`.

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

`$ARGUMENTS` is either:
- a **piece id** `<topic>/<channel>` (e.g. `claude-max-5x-vs-20x/reddit`) - verify that one, or
- a **topic slug** (e.g. `claude-max-5x-vs-20x`) - verify every piece under it.

## Step 1 - Gather grounding (per piece)

For each piece `<topic>/<channel>`:

1. **Structured state** - query the warehouse (read-only `warehouse` MCP):
   ```sql
   SELECT id, channel, kind, status, title, body_path, CAST(metadata AS VARCHAR) AS metadata
   FROM content_pieces WHERE id = '<topic>/<channel>';
   ```
   (Verify pieces in `draft`, or `approved` after a late edit. Skip `published`/`archived`
   unless the user explicitly asks - re-verifying an approved piece would knock it back a step.)
2. **Body** - Read the markdown body at `body_path` (e.g. `data/docs/content/<topic>/<channel>.md`).
3. **Claims ledger** - Read the topic's brief `data/docs/content/<topic>/topic.md`; find the claims
   ledger (every number flagged `official` / `unofficial` / `retired` / `inference`).
4. **Channel profile** - the constraints to check against. Read
   [`packages/core/src/content/profiles.ts`](../../../packages/core/src/content/profiles.ts) (the single source of truth)
   and use the entry for this channel: `limits` (perUnitChars / titleChars / units), `requires`
   (e.g. reddit → `subreddit`), `recommends` (e.g. reddit → `flair`), `voiceNotes`.
5. **Voice style (enforceable layer)** - Read all applicable layers:
   - [`data/docs/identity/voice/global.md`](../../../data/docs/identity/voice/global.md) - the hard rules that
     apply to every channel (incl. the **no-em-dash** rule),
   - `data/docs/identity/voice/<channel>.md` (e.g. `voice/reddit.md`) - the channel rules layered on top, and
   - `data/docs/identity/voice/<channel>@<author>.md` - the author overlay, where `<author>` is the piece's
     `author:` frontmatter (a `users.id`, or `company` for company-page posts; default `alice` when
     absent). Overlays tighten/flavor, never relax; a missing overlay file is fine (channel layer only).
     An overlay violation (writing carol's piece in alice's register, hype in a voice that bans it) is a
     `fail` like any other voice rule.
   These markdown files are the source of truth and are edited to iterate house style, so re-read them
   every run (they may have changed). [`voice-guide.md`](../../../data/docs/identity/voice-guide.md) holds the
   stance/attributes behind the rules - read it for context, but `voice/*.md` is what you check against.

## Step 2 - Verify (run a Workflow, three lenses)

You are authorized to call the `Workflow` tool. Run the three lenses in parallel, each returning
findings `{lens, severity, message}` where `severity` ∈ `fail | warn | pass` - **exactly these three,
nothing else**. `content-verify` refuses a verdict carrying any other value (an `info` crept in once and
rendered green for months). A human ticks every finding off before the piece can be approved, so each
one has to be worth reading on its own:

1. **voice** - does the body obey the voice rules in `voice/global.md` + `voice/<channel>.md` +
   the author overlay `voice/<channel>@<author>.md` (when present)?
   - **Mechanical global rules first (any hit = `fail`).** Scan the body (excluding any `--- … ---`
     frontmatter) for a literal em-dash `-` (U+2014); a single one is an automatic `fail`. Likewise the
     em-dash stand-ins the global file forbids: a double hyphen `--`, and a spaced en-dash ` – ` used as
     a dash. (A hyphen in a compound word, or a true numeric en-dash range like `200–600`, is fine.) Put
     the offending count and first snippet in the finding message so it's a quick fix.
   - **Judgment rules.** Marketing-speak, superlatives/banned-words, hype, fabricated social proof, fake
     urgency, growth-hacky CTAs, or thinly-veiled product placement = `fail`. Honest, technical,
     opinion-led, generous, weakness-named = `pass`. A piece that's clean but ignores the positive rules
     (specific numbers, a real opinion) earns a `warn`.
2. **claims** - reconcile every factual/numeric claim in the body against the claims ledger. A number
   that contradicts the ledger, or an `unofficial`/`retired`/`inference` figure presented as fact
   **without the in-text flag**, = `fail`. All claims grounded + flagged = `pass`.
   Also reconcile the **operational frontmatter** (`posting_note`, `asset`, and similar fields): a note
   asserting a blocker or state the ledger records as cleared (or vice versa) = `warn` - the human acts
   on those notes at posting time, so a stale one is a real hazard even though it never ships publicly.
   (Lesson of 2026-07-15: a posting_note still claimed "not on npm yet, LICENSE missing" a day after
   both blockers cleared, and passed the gate because the lenses only read the body.)
3. **constraints** - check the channel profile:
   - length within `limits.units` (words for blog/reddit; posts for an X thread; chars for linkedin),
   - no unit over a hard limit (`perUnitChars` - e.g. any X post > 280 chars = `fail`; `titleChars`),
   - every `requires` field present in the piece's `metadata` (e.g. reddit missing `subreddit` = `fail`).
   - every `recommends` field present (e.g. reddit `flair`) - **missing = `warn`, not `fail`**. Flair is
     a distribution *gate* on Reddit (a missing/wrong required flair gets the post auto-removed, killing
     reach before any upvote/comment signal applies), but the valid flair value is per-sub, so confirm
     the target sub's flairs immediately before posting rather than hard-failing here.

For an X thread, split the body on the `N/` markers and count chars per post. For required fields,
read them from the `metadata` JSON you queried in Step 1.

## Step 3 - Record the verdict (per piece)

`passed` = no `fail` findings. Call the **`content-verify`** MCP tool:
- `id` = the piece id,
- `passed` = true/false,
- `findings` = a JSON **array string** of `{lens, severity, message}` (include the notable `warn`/`pass`
  notes too, not just fails - the verdict is the record).

The tool records the verdict and does NOT move the piece (statuses were simplified 2026-08-13 - see
`features/content/SPEC.md`). **Do not**
call `content-set-status`, `content-publish`, or any posting tool from this skill.

**Fallback:** teammate sessions don't always have the `box` MCP wired (2026-07-20: Carol's session had
no `content-verify` tool). The CLI equivalent is a first-class path, not a hack:

```bash
pnpm cli content-verify --id "<topic>/<channel>" [--no-passed] --findings "$(cat findings.json)"
```

Write the findings JSON to the scratchpad first (shell-escaping an inline array breaks easily).
`pnpm cli` needs the Box running and reachable at `BOX_MCP_URL` (by default `http://localhost:8190/mcp`,
so this path is the Box host's).

## Step 4 - Sync the topic

A verdict that leaves the topic stale is only half-recorded (the 2026-07-15 lesson: every piece of
both showcase launches had cleared the gate while their trackers sat in `planned`). After recording the
verdict(s):

1. Query the topic's pieces: `SELECT status FROM content_pieces WHERE topic_id = '<topic>'`.
2. If the topic is still `planned`, a draft that cleared the gate says it is not an unreviewed idea
   any more:
   `pnpm cli topic-upsert --id <topic> --status active --actor <user>`, and update the
   `**Status:**` line in `data/docs/content/<topic>/topic.md` to match.
3. Never move a topic BACKWARD here, and never revive a `dropped` one - somebody killed that idea on
   purpose. A re-verify that reports fresh findings is a fact about the piece,
   not about the topic.

Content has no planning tasks since 2026-08-12 - a topic carries its own state - so there is nothing
else to close out.

`pnpm cli` needs the Box running and reachable at `BOX_MCP_URL` (by default `http://localhost:8190/mcp`,
so this path is the Box host's).

## Step 5 - Report

Summarize per piece: pass/fail, and the `fail`/`warn` findings (so the author
can fix the draft and re-run). If a piece failed on a missing required field (e.g. no `subreddit`), say
so explicitly - that's a one-line `content-upsert --metadata` fix, not a rewrite. Include what the
tracker sync did. Then **stop**: a verified piece still needs an explicit human sign-off, and then an
explicit schedule or publish, before anything goes out. The piece is still a `draft` when you finish -
that is correct, not an omission.

**Frame a FAIL as the gate working, not the work failing** - lead with what it caught and how small
the fix is, not with the red verdict (the 2026-07-20 session ended on an unframed FAIL and it read as
defeat). Then end with the **report contract** (`features/content/OPERATOR.md`, operator rule 1):

```
IDEA ──▶ DRAFT ──▶ VERIFY ──▶ APPROVE ──▶ PUBLISH
                     ▲ you are here (passed → awaiting approval | failed → one fix, then re-gate)
Next (pass): review + approve at https://box.example.ts.net/content/<id>
Next (fail): "/refine-content <id> <the one-line fix>" - it edits AND re-runs this gate in one pass
Blockers ahead: <posting_note items, credentials, pending approvals - or "none known">
```

Address it to the piece's **author**, dashboard link first.
