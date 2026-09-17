---
name: draft-reply
description: >
  Draft a reply to a tactical-Inbox item (a reddit reply, an x mention, a linkedin comment) in the
  item owner's author-overlay voice, and save it to the item's draft panel via `inbox-draft-save`.
  Use when the user says "/draft-reply <item-id>", "draft a reply to that comment", or pastes an
  inbox item id from the dashboard. Saves a DRAFT only; it NEVER posts or sends anything.
---

# /draft-reply - draft an inbox reply in the owner's voice

Take one inbox item (someone engaged us: a comment, reply, or mention), draft the response the item
owner would write, and attach it to the item's **draft panel** on the dashboard's
`https://box.example.ts.net/engagement/replies/<channel>/<id>` detail page. The human copies it out and posts it themselves - this skill
**never sends** (operating rule #5).

Read [`CLAUDE.md`](../../../CLAUDE.md) first. Binding rules: **voice is sacred**, **honesty over
reach**, never fabricate facts or numbers in a reply.

## Input

`$ARGUMENTS` is the **InboxItem.id** - e.g. `linkedin:comment:urn:li:comment:(…)`,
`reddit:comment-reply:t1_abc123`, `x:reply:x:1234567890`. A `<channel>/` prefix (as in the detail
URL) is tolerated - strip it. If empty, ask which item to draft for.

All server calls go to the Box's tailnet address, `https://box.example.ts.net` (never a
`127.0.0.1` URL - that is the Box host's own loopback and resolves nowhere else); dashboard links
are plain paths, `https://box.example.ts.net/<path>`. If the
`box` tools are missing or 401, route to `/consult` (§ "my MCP isn't connecting") rather than working
around the gate - the usual cause is a token silently revoked by a newer mint, fixed by revealing
the existing one.

## Step 1 - Load the item + its context

1. **The item**: `pnpm cli inbox-data` is not a tool - read it over tRPC via the warehouse instead:
   the item id encodes the platform id; fetch the full list from the server (`curl -s
   https://box.example.ts.net/trpc/inboxData` or the `cli` proxy's `InboxData`-equivalent) and find the
   row. Its `body`/`snippet` is what they said; `url` is the thread; `target`/`title` is what of
   ours they engaged.
2. **Thread context**: open the `url` for the surrounding conversation -
   - reddit: append `.json` to the permalink (public JSON);
   - linkedin/x: the event fields already carry the comment text; fetch the published piece's body
     (`data/docs/content/<content_id>` when the item's `target` is a content id) for what the post said.
3. **The owner + voice**: the item's owner is the channel account owner (config/accounts.json;
   linkedin/x items derived from our published pieces carry the piece's author in `target` →
   `content` table `metadata.author`). Read the voice layers, exactly like /draft-content:
   `data/docs/identity/voice/global.md` → `voice/<channel>.md` → the **author overlay**
   `voice/<channel>@<owner>.md` (fall back to the channel file if no overlay exists).

## Step 2 - Draft the reply

- Reply to what they actually said - answer the question, acknowledge the point, add one real
  detail. Never generic engagement-speak ("Thanks for sharing!").
- Match the channel register: reddit = peer conversation, plain; linkedin = warm-professional,
  short; x = tight, one or two sentences.
- Hard rules from `global.md` apply (notably: **no em-dash, ever**).
- Keep it SHORT - a reply, not a post. If a real answer needs facts you don't have, say so in the
  draft with a `[[fill: …]]` placeholder rather than inventing one.

## Step 3 - Save it

Save via the MCP tool (empty body clears a draft):

```bash
pnpm cli inbox-draft-save \
  --item-id "<the full item id>" \
  --channel "<inbox channel>" \
  --body "<the draft text>" \
  --author "<owner users.id>" \
  --actor "<owner users.id>"
```

Confirm with `pnpm cli inbox-draft-get --item-id "<id>"`, then tell the user one line: where the
draft lives (the `https://box.example.ts.net/engagement/replies/<channel>/<id>` detail page) and what tone you took. Do NOT post the
reply anywhere.
