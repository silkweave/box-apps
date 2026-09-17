# `content` - the operator contract

The rules the content skills are written against. They are cited by number from
`features/content/skills/*/SKILL.md` and from `features/engagement/skills/*/SKILL.md`, so the
numbering is load-bearing: renumber a rule and you silently change what nine skills mean.

They exist for one reason. The pipeline is meant to be runnable by somebody who is not a developer,
and every rule below is the shape that made that true. Written from the working pipeline on
2026-09-13, salvaged out of the pre-split `docs/CONTENT.md`.

## The map

```
IDEA ──▶ DRAFT ──▶ VERIFY ──▶ APPROVE ──▶ PUBLISH
author    machine    machine     author      machine
picks     writes,    gates       approves    posts
          author     (voice+
          answers    claims+
                     format)
```

The author's whole job is three verbs: **pick** (which idea becomes a post), **answer** (the
factual questions the pipeline cannot settle alone), **approve** (the only step that makes anything
public). Everything else is the machine's.

If a skill is about to ask the operator for anything outside those three verbs - a terminal
command, a file path, a repo concept - that is a process bug. Do the work for them, or hand it to
whoever owns the Box.

The lifecycle beneath the map is `draft → approved → [scheduled] → published`, plus `archived` as
an exit, and it is a set of named transitions rather than a status field. `approved` is a human
sign-off that arms nothing; `scheduled` is the only armed state and always carries a visible
`scheduled_at`. See `SPEC.md` § The lifecycle is a process, not a property.

## Rule 1 - every report ends with the map

Every skill's final message ends with three things:

1. **the stage map above, with a "you are here" marker**;
2. **ONE next action, phrased dashboard-first** - the Box's link for the piece
   (`/content/<topic>/<channel>`) before any slash command;
3. **any known blockers AHEAD of the current stage** - missing credentials, unresolved claims,
   a pending approval - so nothing is discovered at publish time.

One next action, not a menu. The map is what tells a non-developer where they are without asking.

## Rule 2 - author decisions wait for the author

Decisions that carry the author's name belong to the piece's `author`, not to whoever is at the
keyboard: which idea becomes the post, how a contested claim resolves, whether a piece is approved.

Ask via `AskUserQuestion`, addressed to them by name. If the author is not driving the session, do
**not** accept a proxy "yes" - record it as **pending the author** and deliver the question through
whatever channel the Box routes alerts to, or as a note on the piece.

This is the same rule the server enforces at the other end: a drafting pipeline authenticated as a
user caps itself at `draft`, and only a human moves a piece to `approved`.

## Rule 3 - contested numbers get a reconciliation, not a verdict

When verification contradicts a number the author supplied or published, do not silently swap it.
Present both figures side by side with the counting difference in plain language - the window, what
was counted, what was excluded, the scope - then offer the choice via `AskUserQuestion`:

- use the verified figure;
- keep the author's figure with a caveat;
- ask the data owner.

The topic's claims ledger records which figure won and why. A skill that picks for them turns a
disagreement about counting into an unexplained edit.

## Rule 4 - verification passes are named, never repeated silently

There are three distinct passes and they are not interchangeable:

| pass | when | what it does |
|---|---|---|
| **intake verification** | `/ingest-sink` | facts are verified ONCE, into the claims ledger |
| **the smoke check** | `/draft-content`, `/refine-content` | advisory only - it is not the gate |
| **the gate** | `/verify-content` | checks the draft AGAINST the ledger, the voice layers and the channel profile |

The gate does **not** re-verify facts. Every skill states which pass it is running, and a piece
that passed the smoke check is reported as exactly that, with "the formal gate is still ahead".

The gate is also advice a human accepts, not a wall: `content-verify` records a verdict and moves
the piece nowhere, and the way past a finding is ticking it off after reading it. See `SPEC.md`
§ The lifecycle is a process, not a property for why finding identity is positional.

## No skill posts to a channel

None of the content skills publish. `/publish-content` **records** a publish a human performed; it
does not perform one. `/draft-content`, `/refine-content` and `/illustration` produce drafts and
assets. `/verify-content` records a verdict. `/engage` and `/draft-reply` (now under
`features/engagement/skills/`) save drafts a human copies out.

Skills sync the planning tracker as they finish and keep a `**Status:**` line in the initiative's
doc matching the warehouse. Statuses only ever move forward.
