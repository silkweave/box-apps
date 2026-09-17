---
name: engage
description: >
  Draft a pod engagement comment in the current user's own voice for ONE pod card - identify who is
  engaging, analyze the post behind the card, come up with a comment worth posting, write it in
  their author-overlay voice, and save it onto the card via `pod-engagement-draft`. Use when the
  user says "/engage <pod-content-id>" or pastes the snippet from the Engagement card dialog.
  Saves a DRAFT only; it NEVER posts, comments, reacts, or likes anything.
---

# /engage - draft a pod comment in the engager's voice

One pod card says "comment on this teammate's post". This skill writes that comment the engager
would write themselves, and hangs it on the card (the dashboard's card dialog renders it with a
Copy button). The human copies it, posts it on the channel, then hits **Verify** - this skill
**never sends** (operating rule #5).

Read [`CLAUDE.md`](../../../CLAUDE.md) first. Binding rules: **voice is sacred**, **honesty over
reach**, never fabricate facts, numbers, or experiences in a comment.

All `pnpm cli` calls below run from the deployed checkout, on the machine the Box runs on, with
that Box up. Its local address is reachable from that machine only - from anywhere else the only
reachable address is the Box's tailnet one, `https://box.example.ts.net`, and dashboard links are
plain paths (`https://box.example.ts.net/<path>`). If the `box` tools 401 or are missing, route
to `/consult`
(§ "my MCP isn't connecting"); the usual cause is a token that was revoked when a new one was
minted, and the fix is to reveal the existing token, never mint a second.

## Input

`$ARGUMENTS` is the **pod_content_id** - e.g. `acme-22-000-messages-12-2-res-mroj8e4p`. It is
the id baked into the card dialog's snippet, so a pasted `claude "/engage <id>"` line arrives
pre-filled. If empty, run `pnpm cli pods-overview`, list the open cards, and ask which one.

## Step 1 - Who is engaging

The draft is saved under ONE participant and written in THEIR voice - never guess between
teammates:

1. If the operator states it ("I'm Carol", "draft as bob"), use that.
2. Else map the machine identity: teammates working on a shared host have a home directory named
   for them, so `~/<name>` maps to users.id `<name>` (`~/alice` → `alice`, `~/carol` → `carol`).
   Only trust this where that convention actually holds.
3. If still ambiguous, **ask**.

Call the resolved users.id `$USER_ID` below.

## Step 2 - Load the card

`pnpm cli pods-overview` → find the card in `cards[]` where `pod_content_id` matches AND
`participant_id == $USER_ID`. From it take: `channel`, `actions` (a card can expect several, e.g.
react + comment), `url`, `title`, `author_id` (the teammate being amplified), `advice` (curator
hint), and any existing `draft_comment`.

- **No card for `$USER_ID`?** They may have already engaged/dismissed it, or not be a pod member.
  Say so and stop - never draft for a card that is not theirs.
- **`actions` does not include `comment`?** A like/react/repost needs no draft - say so and stop
  (remind them the reaction itself is theirs to do).
- An existing `draft_comment` is fine to replace (drafting again is an explicit ask), but show the
  old one and confirm before overwriting.

## Step 3 - Analyze the post

Understand what is actually being said before writing a word:

1. **The recorded body** (team pieces): if the pod content links a `content_id`, read
   `data/docs/content/<content_id>.md` - that is the post text verbatim.
2. **The live post**: open `url` READ-ONLY in the engager's own browser to see the post as
   published plus the comments already under it. Follow the `agent-browser` skill: lease a tab
   for that person's own browser identity, then drive it with
   `--session "$AGENT"`, and release the tab when done. Never react/comment from the browser -
   read only. If the browser is unreachable, work from the recorded body alone (reddit: the
   public `.json` of the thread also works over plain HTTP).
3. Note the post's core claim/tension, its numbers, and what existing commenters have already
   said - the draft must add something none of them did.

## Step 4 - Voice

Read the voice layers, exactly like /draft-content:
`data/docs/identity/voice/global.md` → `voice/<channel>.md` → the author overlay
`voice/<channel>@$USER_ID.md` (a missing overlay means channel layer only - never invent a
persona). The global hard rules apply in full - notably **no em-dash, ever**, no marketing-speak,
no AI-slop tells.

## Step 5 - Draft the comment

A good pod comment is a real contribution that happens to help a teammate, not applause:

- **Engage the idea, not the person.** Pick ONE point from the post and add to it: a first-hand
  experience, a sharper example, a genuine question, or a respectful counter. "Great post!" is a
  failure.
- **Only the engager's real experience.** If `$USER_ID` has no first-hand angle you know of, ask
  them for one rather than inventing it - a fabricated anecdote in their name is the worst
  possible outcome.
- **Don't repeat existing comments** (step 3). If everything worth saying is taken, say a
  question is the better move and draft that.
- **Length**: linkedin 1-4 sentences; reddit can breathe a little more. No links unless they add
  real value; never a link to our own product.
- **No em-dash**, no emoji unless the overlay explicitly allows it, no "As someone who…" openers.

Run the overlay's editing tests on the draft before saving.

## Step 6 - Save it onto the card

```bash
pnpm cli pod-engagement-draft \
  --pod-content-id <pod_content_id> \
  --participant-kind user \
  --participant-id $USER_ID \
  --action comment \
  --draft "<the full comment text>" \
  --actor $USER_ID
```

The server refuses if the engagement is already `verified` (a draft never downgrades a completed
engagement). The card stays in the queue with a "draft ready" badge; the dialog shows the draft
with a Copy button.

## Step 7 - Report

Show the final draft, then: "Saved onto the card - open the post from the Engagement Inbox
dialog, paste the comment, then hit Verify."

## Never

- Post, comment, react, like, or repost anything, on any channel, via API or browser.
- Draft for a different participant than the one resolved in step 1.
- Invent experiences, numbers, or opinions the engager doesn't hold.
- Save over a verified engagement (the server blocks it; don't route around it).
