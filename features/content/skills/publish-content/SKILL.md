---
name: publish-content
description: >-
  Publish an approved content piece (e.g. a blog post) from THIS machine by pulling the
  piece, its markdown body, and its image/video assets from a remote Box's `box` MCP server, then
  running the post-publish sync back into the Box: record the published URL + slug, flip the piece to
  published, advance the topic, and keep the topic brief's Status line
  in parity. Copy-paste publishing stays human-gated - the skill never auto-posts to a channel.
  Triggers - "/publish-content <slug>", "publish the keybridge blog post", "ship this piece to the blog".
---

# publish-content

Publish a content piece from a machine that is NOT the one the Box runs on, using that Box's `box`
MCP server over Tailscale. You pull everything you need (row, body, assets), do the
actual publish by hand in your blog workflow, then this skill writes the outcome back into the Box.

**Never** auto-post to any channel. Publishing is human-gated (operating rule #5). This skill
pulls content, records what a human published, and syncs tracker state - nothing else.

## Prerequisites (one-time)

1. The `box` MCP server is registered on this machine (tools appear as `mcp__box__*`):
   ```
   claude mcp add --transport http box https://box.example.ts.net/mcp
   ```
   (the gateway-fronted address, tailnet-only - Tailscale must be connected.) Verify with
   `mcp__box__content-list` returning JSON.
   `/mcp` needs a **bearer token** of any principal.
   Use your existing token (`pnpm auth:reveal <id>` on the Box host re-prints it; `pnpm auth:token <id>`
   only for a first-ever token - minting again revokes the old one everywhere) and register it, e.g.
   `claude mcp add --transport http box https://box.example.ts.net/mcp --header "Authorization: Bearer <token>"`.
   A 401 here means the token is missing, wrong-role, or revoked - do not work around the gate. If an
   older `box` entry points at `127.0.0.1:8190` (the Box host's own loopback, unreachable from
   anywhere else), `claude mcp remove box` and re-add it against the gateway URL above. Restart the
   session after changing `BOX_MCP_TOKEN`. Anything still broken: `/consult` (§ "my MCP isn't
   connecting").
2. Asset bytes ride plain HTTP, not MCP. This skill fetches them with `curl` from the same host.
   Base URL: `$BOX_BASE_URL` if set, else `https://box.example.ts.net`.
3. The acting user's `users.id` for audit/attribution stamps. Default `alice`; override with
   `$BOX_ACTOR`.

## Argument

`<slug>` - either a topic slug (defaults to its `blog` piece) or a full piece id
`<slug>/<channel>`. Channels: `blog reddit x linkedin hackernews`.
Example: `/publish-content keybridge-showcase-launch` -> piece `keybridge-showcase-launch/blog`.

## Steps

### 1. Resolve and inspect the piece
- Piece id = the arg if it contains `/`, else `<arg>/blog`.
- Call `mcp__box__content-get` with `{ id: <pieceId> }`. You get `{ piece, doc, assets }`.
- If `piece` is null, stop and report the id was not found (offer `mcp__box__content-list` to browse).
- Read `piece.status`. Gate:
  - `published` -> already published (`piece.published_url`). Stop unless the user explicitly wants to
    re-record a corrected URL.
  - `approved` / `scheduled` -> proceed.
  - `draft` -> approval is an explicit human action. Show the title + verify summary and ASK the
    user to confirm they approve it for publishing. Only on an explicit yes, call
    `mcp__box__content-transition` `{ id, transition: "approve", actor: <BOX_ACTOR> }`, then proceed.
    Never approve on the user's behalf without asking.
  - `archived` -> stop; it is out of the pipeline.

  (Statuses were simplified on 2026-08-13: `review` and `changes_requested` folded into `draft`,
  `verified` into `approved`. There are five now - draft, approved, scheduled, published, archived.)

### 2. Pull the body and assets locally
- Working dir: `./.publish/<pieceId with / -> _>/` (create it).
- Write `doc.content` to `<workingDir>/<channel>.md`. This is the exact body to publish.
- `content-get` returns each asset as a **reference** (`{ file, path }`), NOT its bytes. Fetch the
  bytes over HTTP **directly to disk** - never read/echo them into context (that is the whole point;
  a base64'd image or video would blow up the window):
  ```
  curl -fsSL "${BOX_BASE_URL:-https://box.example.ts.net}<asset.path>" -o "<workingDir>/<asset.file>"
  ```
  (`asset.path` is already `/api/content/asset/<topic>/<file>`.) Verify each with `file` and a
  size check (do NOT `cat` the bytes); report filename + type + size only.
- Summarize for the user: title, channel, char count, and the asset filenames + local paths.

### 3. Publish (human-gated hand-off)
- This skill does NOT know your blog's publishing mechanism. Hand the body + assets to the user's
  blog workflow (e.g. add the post to the Silkweave blog repo on this machine, commit, deploy), or
  guide the user to paste it into the channel. Follow the piece's voice/formatting as-is - do not
  rewrite it.
- Wait for the user to give you: (a) the **live published URL**, and (b) optionally the **slug** the
  blog assigned. Do not fabricate either. If the user is not ready, stop here cleanly - they can
  re-run the skill for the sync once it is live.

### 4. Sync back into the Box (full)
Do these in order, each with `actor: <BOX_ACTOR>`:

1. **Slug (optional).** If the user provided a slug, stamp it:
   `mcp__box__content-upsert` `{ id, metadata: '{"slug":"<slug>"}', actor }`.
   (`metadata` is a JSON *string*; it merges into existing metadata server-side.)
2. **Record the publish.** `mcp__box__content-publish`
   `{ id, published_url: "<url>", confirm: true, actor }`.
   This refuses unless the piece is `approved` or `scheduled`, flips it to
   `published`, stamps `published_url` + `published_at` + `published_by`, and drives the
   `content.published.<channel>` signal. (Same core call as the dashboard's `record-published`
   transition; `linkedin` is refused outright because that channel has a real sender.)
3. **(Removed 2026-08-12.)** Content has no planning tasks any more - a topic carries its own state,
   so there is no publish task to close. Skip straight to the topic.
   <!-- was: find the not-`done` task whose title/summary is about publishing/posting/shipping
   this piece's channel. If exactly one is obvious, `mcp__box__task-set-status`
   `{ id: <taskId>, status: "done", actor }`. If several plausibly match, list them and ask the user
   which to close (never guess-close multiple).
4. **Advance the topic (ask).** Re-read its pieces. If every live piece has published, core already
   moved the topic to `done` on the write; otherwise leave it `active`. Confirm with the user before
   `mcp__box__topic-upsert` `{ id: <topicSlug>, status: "<planned|active|blocked|done|dropped>", actor }`.
5. **Keep the doc Status line in parity.** `mcp__box__doc-read`
   the topic's brief (`content-doc-read` on `<topicSlug>/topic`). Find the `**Status:**` line and set
   it to the topic's new status (leave everything else byte-for-byte identical). Write it back with
   `mcp__box__content-doc-save` `{ id: "<topicSlug>/topic", content: "<full patched doc>" }`. -->
   If there is no `**Status:**` line, skip this step (do not invent one).

### 5. Report
Summarize what changed: piece -> published (URL, slug), topic status, whether
the doc Status line was updated. Note anything skipped and why. Remind the user the working-dir copy
under `./.publish/` is local scratch and safe to delete.

End with the pipeline map (`features/content/OPERATOR.md`, operator rule 1) marking PUBLISH done for this
piece, plus what (if anything) remains for the topic's other pieces - one next action, named.

## Notes / guardrails
- Absolute dates (`2026-07-15`), no em-dashes anywhere (house rule) - if you write into a Box doc
  via `doc-save`, keep plain dashes.
- Every write takes `actor` so the Box attributes it to the right user.
- If any MCP call errors with "refused", read the message - it usually means the piece has not
  cleared the gate yet, or `confirm` was not `true`. Fix the precondition; do not force around it.
- The content read tools (`content-list`, `content-get`, `topic-list`, `content-doc-read`) are
  read-only; the writes (`content-publish`, `content-transition`, `content-upsert`, `task-set-status`,
  `topic-upsert`, `content-doc-save`) all mutate state on the remote Box. Every call is
  authenticated: the Box is tailnet-only AND `/mcp` demands a `user`-role bearer token (see
  Prerequisites).
