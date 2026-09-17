---
name: refine-content
description: >
  Revise an existing content draft along a direction - pivot the angle, dig deeper on a point, add a
  new source/resource/example, tighten it, or address the latest verify findings - while honoring the
  topic's claims ledger and the voice style, then re-verify. Use when the user says
  "/refine-content <id> <direction>", "refine the reddit draft", "pivot the post to lead with X", "dig
  deeper into Y", "add a source for Z", or "tighten this draft". Edits a draft and re-runs the gate; it
  NEVER publishes (drafts are drafts).
---

# /refine-content - revise a draft, then re-verify

Take one content piece and a **direction**, revise the body to match, keep it honest and on-voice, and
hand it back through the verify gate. This is **Exploration Mode** (model-in-the-loop editing). It is
the iterate step that keeps a piece in `draft`: a failed verify, a new idea, a better source, a sharper
angle. Publishing stays a separate, human-gated step.

Read [`CLAUDE.md`](../../../CLAUDE.md) first. Binding rules: **voice is sacred**, **honesty over reach**,
**never fabricate signals/social proof**, **drafts are drafts** (you do not post).

## Mode - local checkout or remote Box?

**Local** (CWD is the Box checkout, `data/docs/` on disk): follow the steps as written. **Remote**
(this skill is installed on a machine with no checkout, talking to a Box over the tailnet): no repo
files, no `pnpm cli`, no `warehouse` MCP - use the `mcp__box__*` tools over the tailnet: piece + body + last verdict via `content-get`, ledger via
`doc-read` (append ledger rows via `doc-save` - full patched doc, byte-careful), voice via
`voice-read`, profile from `content-list`'s `profiles`, body written back via `content-doc-save`,
status reset via `content-set-status`, verdict via `content-verify`.

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

`$ARGUMENTS` is `<id> <direction>`:
- `<id>` - the piece id `<topic>/<channel>` (e.g. `claude-max-5x-vs-20x/reddit`).
- `<direction>` - free-form, optional. What to change and why. Examples:
  - *pivot* - "lead with the ToS angle instead of pricing"
  - *deepen* - "dig deeper into the switching tax, give a concrete example"
  - *add a resource* - "add the official pricing page as a source", "work in the May 6 2026 change"
  - *tighten* - "cut 150 words", "trim to the profile range", "kill the throat-clearing"
  - *fix* - "address the verify findings"
  - If `<direction>` is empty, default to: **address the latest verify findings + enforce the voice
    style + tighten to the channel range.**

## Step 1 - Gather grounding

1. **Structured state** - query the warehouse (read-only `warehouse` MCP), including the last verdict:
   ```sql
   SELECT id, channel, kind, status, title, body_path,
          CAST(metadata AS VARCHAR) AS metadata, CAST(verify AS VARCHAR) AS verify
   FROM content_pieces WHERE id = '<topic>/<channel>';
   ```
2. **Body** - Read the markdown body at `body_path` (`data/docs/content/<topic>/<channel>.md`).
3. **Claims ledger** - Read the topic's brief, `data/docs/content/<topic>/topic.md`; find the claims ledger (every figure
   flagged `official` / `unofficial` / `retired` / `inference` + source). This is the honesty contract.
4. **Voice style** - Read [`data/docs/identity/voice/global.md`](../../../data/docs/identity/voice/global.md) +
   `data/docs/identity/voice/<channel>.md`. Re-read each run; they are edited to iterate house style.
5. **Channel profile** - [`packages/core/src/content/profiles.ts`](../../../packages/core/src/content/profiles.ts): the
   entry for this channel (`limits`, `requires`, `voiceNotes`).
6. If the piece is a `derived` adaptation and the direction changes the *argument* (not just channel
   shape), also read the `canonical` (`blog`) piece so the pivot stays consistent with the source.

## Step 2 - Refine (run a Workflow)

You are authorized to call the `Workflow` tool. Apply the direction to the body, then enforce the two
non-negotiables in parallel before writing:

1. **Apply the direction.** Pivot / deepen / add-resource / tighten / fix as asked. Preserve what was
   already working; change what the direction targets. Adapt from the existing body - don't rewrite the
   whole piece unless the direction is a full pivot.
2. **Honesty gate (the load-bearing step).** Any **new** factual or numeric claim the refine introduces
   must be:
   - **verified live** (`gh` / web - never remembered), then
   - **added to the claims ledger** in `data/docs/content/<topic>/topic.md` (append-only; a new row with
     its `official`/`unofficial`/`retired`/`inference` status + source URL), and
   - **flagged in-text** at the point it appears if it is anything other than `official`.
   - If a claim can't be grounded, **don't ship it** (or include it explicitly flagged as inference).
     Never fabricate a number, quote, or social proof to make the direction land.
   - If live verification **contradicts a figure the author supplied or already published**, don't
     just swap it: run the reconciliation (`features/content/OPERATOR.md`, operator rule 3) - both numbers side by
     side with the counting difference in plain language, then `AskUserQuestion` (use verified / keep
     with caveat / ask the data owner). The author decides; the ledger records why.
3. **Voice + constraints.** Enforce `voice/global.md` + `voice/<channel>.md`: **remove every em-dash
   `-`** (and `--`, spaced ` – `) - a single one is an automatic verify-fail - and strip any
   marketing-speak/superlatives the edit introduced. Keep the body within the channel profile's length
   limits. **Preserve the `--- … ---` frontmatter** verbatim.

## Step 3 - Write + reset the lifecycle

1. Write the revised body back to `data/docs/content/<topic>/<channel>.md` (Edit/Write), frontmatter intact.
2. **Put the piece back in `draft`** with the `reopen` transition (MCP `content-transition` with
   `{ id, transition: "reopen" }` - "Back to draft", which also clears any schedule). A piece already
   in `draft` needs nothing here. The edit invalidates any prior verdict, so it has to go back into
   the verifiable lane.
   - **If the piece was `approved`, `scheduled`, `published`, or `archived`**, refining it un-approves
     it - say so explicitly and confirm that's intended before reopening. Changing signed-off copy and
     silently keeping the approval would break the gate's meaning. A `scheduled` piece is ARMED (a
     publisher will send it at its time), and `reopen` stands it down as part of the same move.
   - `published` does NOT reopen: a published piece may only be archived (no silent un-publish). If
     the direction really applies to a published piece, say so and stop - that is the owner's call.
   - The four live statuses are `draft · approved · scheduled · published` (+ `archived` as an exit).
     `review`, `changes_requested` and `verified` were removed on 2026-08-13 and are refused on write.

## Step 4 - Re-verify + report (do NOT publish)

1. Run the gate: **`/verify-content <id>`** and let it record the new verdict. **Verify never moves
   the piece** - it records a verdict and the draft stays a draft; only a human approves. The gate also closes out the topic (see verify-content; content has no planning tasks since 2026-08-12) (topic
   `planned` → `active`, the doc's `**Status:**` line), so a refine that completes or breaks the gate
   updates the tracker with no extra step here.
2. Report: the direction applied, what changed, any **claims-ledger additions** (new rows + sources),
   the new verify verdict + status, and the length delta vs. before. Then **stop** - the owner decides what
   ships and when. Never call a publish/create-post tool from this skill.
3. End with the **report contract** (`features/content/OPERATOR.md`, operator rule 1): the stage map with the
   piece's *you are here* (VERIFY, passed or failed), ONE next action addressed to the author with
   the dashboard link first (`https://box.example.ts.net/content/<id>`), and any blockers ahead (posting notes,
   credentials, pending approval).

## Note - pivoting across channels

This skill refines **one piece**. If you pivot the `blog` canonical, the channel adaptations are now
out of sync - re-run `/refine-content <topic>/<channel> re-sync from the updated canonical` per
channel (or `/draft-content <topic>` to regenerate the adaptations from scratch).
