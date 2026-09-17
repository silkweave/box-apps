---
name: illustration
description: Generate an on-brand illustration for a content piece via the Gemini image API (nano-banana / nano-banana-pro). Use when a piece needs a hero image, LinkedIn feed image, or blog graphic in the house style - "/illustration <topic-slug>", "generate an image for <piece>", "illustrate <concept>". Turns a concept into a styled prompt and renders it into the topic's folder.
---

# Illustration generator

Generate cohesive illustrations in the author's house style. The style is
**per-author** (like the voice overlays): Alice's signal is dark, moody,
oil-painted developer-protocol diagrams; Carol's is the brand-system dark-navy
stat/question cards and realistic UI freeze-frames. The workflow is:
**concept, then styled prompt, then rendered image, then attached asset**.

## When to use

The user asks for a hero/feed image for a content piece (usually by topic
slug), or "an illustration of [concept]". They give you a *concept* or a
*piece*, not a finished prompt - your job is to translate it into the right
author's style.

Note: Carol's posts also regularly use REAL images (photos/screenshots) - see the
"real photo" row in that guide's lane table. Generating is a deliberate per-post
call the user makes; don't silently default every post to this skill.

## Steps

1. **Read the author's style guide.** Resolve the author first: for a content
   piece, it's the draft's `author:` frontmatter (a `users.id`); for a bare
   concept, it's whoever is asking (default `alice`). Then load
   `STYLE_GUIDE-<author>.md` from this skill directory -
   `STYLE_GUIDE-alice.md` (oil-painting protocol diagrams, also the fallback
   when an author has no guide - say so rather than inventing a style) or
   `STYLE_GUIDE-carol.md` (brand card system + UI freeze-frames). Each guide
   defines its fixed anchors, palette, composition patterns, and prompt
   templates. Do not invent a style - apply the author's.

2. **Read the piece.** For a content piece, read the draft at
   `data/docs/content/<topic>/<channel>.md` (local checkout) or via
   `mcp__box__ContentGet` (remote). Find the ONE idea, then compose it per the
   author's guide: for **alice**, the single visual metaphor (split
   composition for "don't do X, do Y", else central-focal or flow, objects from
   the vocabulary bank); for **carol**, pick the lane (stat/question card vs UI
   freeze-frame) and make sure the image opens a loop the post closes - never
   the reverse.

3. **Write the prompt.** Fill the prompt template from the author's guide. Keep
   the fixed anchors near-verbatim; only the flexible slot changes (alice: the
   metaphor sentences; carol: the exact on-image text / the frozen-tension
   description). Text rules differ by author - alice defaults to "No text.",
   carol's images are text-led with every word specified verbatim (and no
   em-dashes ever). Save the prompt beside the target image as
   `data/docs/content/<topic>/<name>.prompt.txt` so it can be re-rendered
   or tweaked later.

4. **Confirm before spending.** Show the user the prompt and the target path
   before generating - image calls cost money. Proceed once they're happy (or if
   they said "just generate it").

5. **Generate.** From the Box repo root (loads `GEMINI_API_KEY` from `.env`):

   ```bash
   pnpm image -- --prompt-file data/docs/content/<topic>/<name>.prompt.txt \
     --out data/docs/content/<topic>/<name>.png
   ```

   The script prints the final output path on stdout (the extension may switch
   to match what the API returned, e.g. `.jpg`). Default model is
   `gemini-3-pro-image` (nano-banana-pro), `--aspect 16:9`, `--size 2K`.
   Author defaults: alice 16:9; carol `--aspect 4:5` for cards, 16:9 for UI
   freeze-frames - and always the pro model for carol (text-led images).
   On a remote plugin install there is no `pnpm image`; run the bundled script
   directly: `GEMINI_API_KEY=... node <this-skill-dir>/generate-image.mjs ...`.
   If the `mcp__box__*` tools are missing or 401 there, route to `/consult`
   (§ "my MCP isn't connecting") - usually a `BOX_MCP_TOKEN` that was revoked
   when a newer token was minted for that person; reveal the existing one
   rather than minting again.

6. **Show and attach.** Read the produced image back so the user sees it, and
   tell them the path. Then attach it to the piece via `metadata.assets`
   (`ContentUpsert`, deep-merged): **`{path: "<file>", usage: "feature"}`** - one
   physical copy in the topic folder, shared by every piece that references it
   (see `features/content/SPEC.md`). `feature` is THE image of a piece on every channel,
   LinkedIn feed image and blog cover alike; the publishers and the dashboard's
   asset panel both read it that way. Use `usage: "social"` only for a genuinely
   SECOND file - a feed-cropped variant on a piece whose feature is something
   else - never as the name for "the LinkedIn one". Writing `social` when there
   was already a `feature` is what published the wrong image on 2026-08-12.
   If the user wants tweaks, adjust the metaphor sentence and re-run - keep the
   anchors stable so the signal stays cohesive.

## Script reference

`generate-image.mjs` (in this skill directory) - zero-dependency, Node 22.18+.

| Flag | Default | Notes |
|------|---------|-------|
| `--prompt "<text>"` | - | The full composed prompt. |
| `--prompt-file <path>` | - | Read the prompt from a file instead. |
| `--out <path>` | `./<slug>.png` | Output path; extension follows the returned mime type. |
| `--model <id\|alias>` | `pro` | Aliases: `pro` (gemini-3-pro-image), `flash` (gemini-2.5-flash-image), `flash-2` (gemini-3.1-flash-image). |
| `--aspect <ratio>` | `16:9` | 16:9 blog/LinkedIn hero, 4:5 portrait feed, 1:1 square, 9:16 stories. |
| `--size <res>` | `2K` | `512`, `1K`, `2K`, `4K` (4K = pro only). |

**Auth:** requires `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) - a system-level var
in the repo-root `.env` (shape in `.env.example`). `pnpm image` loads it via
Node's `--env-file-if-exists`.

**Cost note:** `pro` (nano-banana-pro) is higher quality and pricier; suggest
`--model flash` for quick drafts or iterations, then a final `pro` render.
Exception: carol's images are text-led - `flash` garbles their typography, so
draft AND final on `pro` (iterate on wording in the prompt file instead).
