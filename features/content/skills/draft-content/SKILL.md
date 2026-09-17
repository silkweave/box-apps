---
name: draft-content
description: >
  Generate outward-facing drafts for a content topic - a canonical blog post plus channel
  adaptations (reddit/x/linkedin). Use when the user says "/draft-content <slug>", "draft the posts
  for <topic>", or "write the cross-channel content". Produces voice-checked drafts only; it
  NEVER publishes (drafts are drafts).
---

# /draft-content - canonical post + channel adaptations

Turn a content TOPIC into a set of drafts: one **canonical** long-form blog post, then
per-channel adaptations of it. Output lands under `data/docs/content/<slug>/` with every file
`status: draft`. This is **Exploration Mode** (model-in-the-loop generation). Publishing is a separate,
human-gated step - see [`data/docs/content/README.md`](../../../data/docs/content/README.md).

Read [`CLAUDE.md`](../../../CLAUDE.md) first. Binding rules: **voice is sacred**, **honesty over
reach**, **never fabricate signals/social proof**, **drafts are drafts** (you do not post).

## Mode - local checkout or remote Box?

**Local** (CWD is the Box checkout, `data/docs/` on disk): follow the steps as written. **Remote**
(this skill is installed on a machine with no checkout, talking to a Box over the tailnet): no repo
files, no `pnpm cli`, no `warehouse` MCP - use the `mcp__box__*` tools over the tailnet: the topic's brief + ledger via `content-doc-read`, voice layers via
`voice-read {channel, author}`, channel constraints from `content-list`'s `profiles` array (the
`docs/channels/*` briefs are not remotely readable - keep remote drafts to channels whose profile +
voice files carry enough, and say so when they don't), bodies written via `content-doc-save`, rows
via `content-upsert`, the topic via `topic-upsert`.

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

`$ARGUMENTS` is the topic slug (e.g. `claude-max-5x-vs-20x`).

## Step 1 - Gather grounding

- Read the topic's brief: `data/docs/content/<slug>/topic.md` (the take + the **claims ledger** - honor it;
  flag unofficial/retired numbers as such in every draft).
- Read the topic's row for its `target_channels` and status (`content-list --topic <slug>`, or the
  topic page). What it declares decides the channel set - see below.
- Read the original sink source if it's still around (`data/docs/sink/_done/<…>.md`) for raw detail.
- Read the voice style - the enforceable layer `/verify-content` will check the drafts against:
  - [`data/docs/identity/voice/global.md`](../../../data/docs/identity/voice/global.md) - global hard rules
    (notably **no em-dash, ever** - generate every draft without a single `-`),
  - `data/docs/identity/voice/<channel>.md` for each target channel below, and
  - the **author overlay** `data/docs/identity/voice/<channel>@<author>.md` when it exists. The author
    is who the piece speaks as: a `users.id` (alice/carol/bob) or `company` for company-page
    posts; default `alice` unless the topic or the user says otherwise. Write it into the
    draft's `author:` frontmatter. A missing overlay = channel layer only - NEVER invent a persona
    for an author who hasn't defined one (carol's is a scaffold; flag that author's drafts for their own edit).
  [`voice-guide.md`](../../../data/docs/identity/voice-guide.md) gives the stance behind the rules.
- Read the brief for each target channel:
  - Blog - [`docs/channels/blog-seo/README.md`](../../../docs/channels/blog-seo/README.md)
  - Reddit - [`docs/channels/reddit/README.md`](../../../docs/channels/reddit/README.md) +
    [`STRATEGY.md`](../../../docs/channels/reddit/STRATEGY.md)
  - X - [`docs/channels/x/README.md`](../../../docs/channels/x/README.md)
  - LinkedIn - [`docs/channels/linkedin/README.md`](../../../docs/channels/linkedin/README.md) +
    [`data/docs/identity/silkweave-org.md`](../../../data/docs/identity/silkweave-org.md) (the company-page voice)

### The channel set comes from the TOPIC, not from this prompt

**Ask the topic what it owes before you decide what to write.** An approved topic declares its
`target_channels`, and the server already computes the difference between those and the pieces that
exist:

```bash
pnpm cli topic-pending-channels --id <slug>      # or the MCP tool of the same name
```

It returns the target channels the topic has **no piece for yet** - which is exactly the set to
draft. Use it in this order:

1. **The user named a subset** - that wins. Say which channels you are skipping and why.
2. **Otherwise use `topic-pending-channels`.** Draft exactly what it returns.
3. **It returns empty** - either the topic is not approved (the gate doing its job: empty for
   anything not `active`), or every target channel already has a piece. Do NOT silently fall back to
   a default set. Say which of the two it is and stop; re-drafting an existing piece is
   `/refine-content`, not this skill.
4. **The topic has no row at all** (a doc-only idea) - then there is nothing to ask. Fall back to
   **blog (canonical) + reddit + x + linkedin** and register the topic in Step 3 with those as its
   `--target-channels`.

If what you are about to draft disagrees with `target_channels`, **say so before drafting** rather
than quietly writing a channel the topic never asked for.

## Step 2 - Generate (run a Workflow)

You are authorized to call the `Workflow` tool here. Structure it as:

1. **Canonical** - write the full blog post from the topic's brief + raw source. Long-form, honest,
   opinion-led; lead with the idea, not the product. Run a voice-check pass on it.
2. **Adapt (fan-out)** - one agent per remaining channel, each given the canonical post + that
   channel's brief, producing a channel-shaped draft (Reddit: idea-first, title that promises something
   specific, product-last or absent; X: a tight thread, and per `voice/x.md` credit any mid-tier
   creator whose work the thread genuinely rests on - see the
   [`x-creator-mentions` playbook](../../../data/docs/initiatives/x-creator-mentions-playbook.md);
   LinkedIn: story-lesson in the author's own
   voice - personal overlay for a person, `linkedin@company.md` for page posts).
   Adapt from the canonical - don't re-derive the argument from scratch.
3. **Smoke check (per draft)** - a final pass checking each draft against `voice/global.md` +
   `voice/<channel>.md` and the claims ledger. **Mechanical first: grep each draft for `-` (and `--`,
   spaced ` – `) and remove every one** by rewriting the sentence - this is an automatic verify-fail, so
   no draft ships with one. Then the judgment rules (no marketing-speak/superlatives, no fabricated
   proof, no thinly-veiled placement) and the ledger (every unofficial/retired number flagged in-text).
   This pass is **advisory, not the gate** (`features/content/OPERATOR.md`, operator rule 4): it applies the same
   rules `/verify-content` will enforce so wording drifts get fixed early, but it records nothing.
   NEVER report a draft as having "passed" - report "smoke check clean; the formal gate
   (`/verify-content`) is still ahead", so a later gate fail never reads as the tool contradicting
   itself.

## Step 3 - Write the drafts

Write each to `data/docs/content/<slug>/<channel>.md` with frontmatter:

```markdown
---
status: draft
channel: reddit            # blog | reddit | x | linkedin
source: blog               # canonical the draft adapts from (blog itself is the canonical)
topic: <slug>
author: alice             # who the piece speaks as: users.id, or company (company page)
created: <YYYY-MM-DD>       # today, absolute date
---
```

`blog.md` is the canonical (`source: blog` / itself). For Reddit, note the target subreddit + the
intended **flair** (a gate - a missing/wrong required flair gets the post auto-removed) + that rules
and flairs must be re-checked immediately before posting.

## Step 3b - Register the topic + each piece on the Content board

A draft on disk that has no `content` row is invisible to the dashboard (the 2026-07-20 lesson: Carol
was sent to the Content board before the row existed). **The dashboard renders warehouse rows, not
files** - writing markdown does nothing for it on its own.

**First, make sure the TOPIC has a row.** Content is two objects since 2026-08-12 and neither is an
an initiative: a **topic** (the idea, its brief, its target channels) and a **piece** per channel under
it. A topic written by the weekly pipeline already exists as `planned`; a doc-only idea has no row at
all, so none of its pieces will show up under it. Register it before the pieces - and note the
review gate: a topic being drafted is `active` (approved), never `planned`.

```bash
pnpm cli topic-upsert --id <slug> --title "<title>" --status active \
  --owner <author> --target-channels "<blog,linkedin,…>" --actor <author>
```

Then, for **every** draft written, upsert its row:

```bash
pnpm cli content-upsert --id "<slug>/<channel>" --topic-id <slug> --channel <channel> \
  --kind <canonical|derived> --status draft --title "<title>" --actor <author>
```

(or the `content-upsert` / `topic-upsert` MCP tools; flags are kebab-case - `--topic-id`).
Set per-channel metadata while you're there (`subreddit`, `flair`, `author`). **More than one piece
on the same channel** (e.g. a Reddit megathread *comment* now plus a standalone *post* later) needs a
**distinct id** - the id is a free slug path, not forced to `<slug>/<channel>`, so use
`<slug>/reddit-megathread-comment` and pass an explicit `--body-path` matching the file. **Confirm the
rows landed** with `content-list --topic-id <slug>` (and `topic-list`) before
you report - if they are not listed, the dashboard will not show them.

**Always pass `--actor <author>` (the human), on the topic and every piece.** The `actor` audit
stamp **defaults to the authenticated principal**, which may be the configured service
account over `box` MCP, so omitting it can attribute the work to the agent instead of its owner. Set
`--actor` to the piece's `author` (`alice` unless the topic says otherwise), and put that same id
in `metadata.author` and the topic `--owner`. `created_by` is fixed at insert, so a row created
under the wrong actor must be deleted and recreated with the right one (the markdown body survives a
`content` delete).

And when the claims ledger
carries any **unresolved publish blocker** (a figure to re-verify, a date to confirm), copy it into
the piece's `posting_note` metadata - the person publishing sees the piece, not the ledger, so a
blocker that lives only in the ledger will be missed at posting time.

## Step 4 - Sync the topic

Drafts on disk under a topic that still says `planned` is half-done work (the 2026-07-15 lesson:
both showcase launches shipped verified drafts while their trackers sat stale). Content has no
planning tasks since 2026-08-12 - a topic carries its own state - so this step is now one move:

1. If the topic is still `planned`, drafting it underway makes it approved:
   `pnpm cli topic-upsert --id <slug> --status active --actor <author>`. Only move **forward** -
   never regress an `active`/`done` topic, and never quietly un-drop a `dropped` one (somebody killed
   that idea on purpose; ask instead).
2. Keep the brief in sync: the topic's doc is `data/docs/content/<slug>/topic.md`.

`pnpm cli` is a client of the running server's `/mcp`. If the server is down, start it (`pnpm dev`)
or flag the sync as **pending** in your report - never leave it silently undone.

## Step 5 - Report (do NOT publish)

List the draft paths and a short **publish checklist** per channel (from `data/docs/content/README.md`):
which are auto-capable (Reddit via the wired MCP, human-gated), which are manual (LinkedIn relay, blog
= git push to the blog), and the cost note for X. Include what the tracker sync did (task +
topic status). Then **stop** - the piece's owner decides what ships and when. Never call a
publish/create-post tool from this skill.

End with the **report contract** (`features/content/OPERATOR.md`, operator rule 1):

```
IDEA ──▶ DRAFT ──▶ VERIFY ──▶ APPROVE ──▶ PUBLISH
           ▲ you are here (drafts written, smoke check clean; the formal gate is still ahead)
Next: read your draft at https://box.example.ts.net/content/<slug>/<channel>, then say "/verify-content <slug>"
Blockers ahead: <posting_note items, missing credentials - or "none known">
```

Address the next step to the piece's **author** (they review their own draft) - dashboard link
first, slash command second.
