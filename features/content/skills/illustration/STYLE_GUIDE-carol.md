# Illustration Style Guide - Carol (author: `carol`)

Carol's LinkedIn images are NOT the oil-painting protocol diagrams - that language
belongs to Alice (`STYLE_GUIDE-alice.md`). Carol's visual identity is a branded
card system: everything is derived from the company's own palette, wordmark and
typeface, and from that author's published corpus. Two generated-image lanes,
plus a reminder that a real photo or real screenshot is always on the table.

This is an **example** guide, and the second one on purpose: two authors with
genuinely different visual languages is what makes the per-author rule legible.
Keep the structure (lanes, fixed anchors, the open-loop law, the templates) and
swap the specifics - the hex values, the wordmark, the typeface - for your own
brand. Write the guide from a real corpus (an author's actual published images)
rather than inventing one; the anchors below are worked examples of the shape
that audit produces, not colours anyone has to keep.

The two design ideas the lanes are named for: "Orbital Silence" (stat cards)
and "The Hovering Cursor" (UI freeze-frames).

---

## 0. The one law: open a loop, never close it

The image's job is to make the viewer wonder - not to illustrate the post. Show
the number with no explanation, the question with no answer, the cursor before
the click. If the image already tells the story, the post never gets read. Every
concept must pass the Open-Loop Test: after seeing the image, does the viewer
still have a question only the post body answers?

## 1. Pick the lane

| The post's power is... | Lane |
|---|---|
| A number or a sharp question | **Lane A - stat/question card** |
| A moment or decision inside software | **Lane B - realistic UI freeze-frame** |
| An idea that maps to one physical scene | **Lane C - photoreal metaphor photo** |
| A personal founder moment, a real result | Consider a REAL photo or screenshot instead - flag it, don't generate |

Never mix lanes in one image. Never reach for Alice's glowing-orb metaphor kit.

## 2. Lane A - the card system ("Orbital Silence")

One note struck in a dark room, allowed to ring. Everything that is not the
number, the question, or the breath around them is removed.

**Fixed anchors:**

- **Format:** portrait 4:5 (`--aspect 4:5`), mobile-first feed real estate.
- **Background:** near-black navy `#0f172a`, subtle depth, with faint thin
  grey-blue orbital arcs (`#334155`, barely visible, curving through the frame)
  and 2-3 tiny bright-blue dots like plotted stars. Matte, astronomical - a
  chart of one data point against the dark.
- **Kicker (top-left):** a short horizontal accent-blue dash, then a lowercase
  kicker phrase in accent blue `#3b82f6`, small and bold (e.g. "not our best
  campaign. the average." / "the question no one asks").
- **Hero (upper-middle, enormous):** either
  - a giant stat in accent blue `#3b82f6` (e.g. "12.2%") - must survive a 120px
    thumbnail, or
  - a 2-line question in white bold with EXACTLY ONE word in accent blue,
    optionally ALL CAPS (e.g. "Who should you STOP messaging?").
- **Definition line (stat cards only):** white, bold, plain-spoken (e.g. "our
  all-time response rate").
- **Divider:** a short accent-blue underline rule.
- **Context line:** muted slate grey `#94a3b8`, 1-2 lines, the loop-opener,
  with the denominator when there's a number (e.g. "across 22,000 messages -
  every one we've ever sent." / "Your outreach data already knows.").
- **Footer (bottom-left):** the company wordmark in white - a small logo mark
  plus the company name, nothing else.
- **Type:** clean modern grotesque (Inter-like), extreme scale contrast between
  the three tiers: hero, definition, context. Generous negative space; wide
  margins; nothing crowds the edges.
- **Restraint:** two blues only (`#3b82f6`, with `#2563eb` allowed in gradients),
  one luminous accent per card, never a wash. White reserved for what must be
  read first.

## 3. Lane B - the UI freeze-frame ("The Hovering Cursor")

The most loaded moment in software is not the click - it is the half-second
before it. A believable product screen caught mid-thought, that could belong to
anyone reading the post.

**Fixed anchors:**

- **Format:** landscape (`--aspect 16:9`, crop to 1.91:1 if needed).
- **Realism:** real chrome, real density - a working calendar, settings panel,
  or inbox with plausible filler content. Nothing signals "designed". NO company
  branding, no navy card chrome, no logo.
- **Palette:** borrowed from the depicted product (product greys, one native
  accent color, soft elevation shadows). Colour does the pointing: the one
  decisive element is the only thing at full contrast/saturation.
- **The frozen tension** (pick one): a cursor parked on the decisive button,
  never pressed; a confirmation dialog lifted above a dimming scrim; a toggle
  just switched with its consequence visible; a limit slider pushed to max.
- **Withhold the resolution:** no success state, no confirmation, no aftermath.
  The button is hovered, never clicked.

Examples from the corpus: a Google-style calendar with a "Cancel this call?"
dialog, cursor resting on the Cancel button; a dark outreach-tool settings card
with "Auto Send" ticked and "Limit Per Day 25 / 25" maxed out.

## 3b. Lane C - the photoreal metaphor photo

The generated heir to Carol's real-metaphor-photo archetype (coin = odds, burst
pipe = a leak, snooze button = delay, traffic light = the call). One real-world
scene that IS the post's idea, shot like candid documentary photography - the
viewer should never clock it as generated.

**Fixed anchors:**

- **Format:** landscape (`--aspect 16:9`); metaphor photos are true scenes.
- **One metaphor, one beat:** a single object or moment that maps to the
  post's actual idea (a yellow card = warned not sent off; the uniformed
  captain in the security queue = rank doesn't skip the scanner). If the
  connection needs explaining, it's the wrong scene.
- **Photography, not illustration:** name the shot - candid documentary style,
  natural or golden-hour light, shallow depth of field, muted realistic
  colors, slight grain. Hands and human moments recur; warmth over gloss.
- **Anti-tell guards, every prompt:** "no text", "no real logos", "faces not
  clearly visible" (generated faces and brand marks are the giveaways; frame
  subjects from behind or out of focus).
- **Open loop still rules:** freeze the tension (the card raised, the tray not
  yet on the belt), never the aftermath.
- **No stock-clichés:** no handshakes, skylines, brains, robots, lightbulbs,
  posed laptop reactions. If it could sit on a generic SaaS landing page,
  reject the concept.

### 3b-i. The sporting motif bank (Lane C's default first look)

Sport is Carol's strongest metaphor family and the **first place to look** for a
Lane C concept - the rules are universally understood, so the image explains
itself without a caption, and the moment is already frozen mid-tension. Reach
here before inventing a new object.

Pick the sport whose rule *already means* what the post argues:

| The post is about... | The moment |
|---|---|
| A warning, not a punishment | The referee's **yellow card** raised, player out of focus |
| Doing the unglamorous work so someone else wins | The **domestique** pulling on the front, leader tucked in behind |
| Committing early and alone | The **breakaway** rider, peloton a blur on the horizon |
| Volume without position | The **peloton** packed shoulder to shoulder, nobody gaining |
| A second chance you can't waste | The **second serve**, ball at the top of the toss |
| Winning on a technicality you don't control | The **let cord**, ball balanced on the net tape |
| Being fractionally early and losing everything | The **offside flag** going up, the run already made |
| A judgement call that decides it | The **line-call replay**, ball's shadow on the chalk |
| Handover, and where things get dropped | The **relay baton** mid-exchange, both hands on it |
| Rank not exempting you from the process | The **captain's armband** in a queue like everyone else |

**Rules on top of Lane C's anchors:**

- **One sport per image, one beat.** Never mix codes, never show the result.
  The card is raised, not pocketed. The baton is in transit, never handed over.
- **Anonymity is mandatory.** No club crests, sponsor logos, national kit,
  recognisable faces, or real stadium identifiers. Generic kit in muted
  colours; subjects from behind, cropped, or out of focus. (Extends Lane C's
  anti-tell guards - a fake logo is the fastest way to look generated.)
- **The rule must be common knowledge.** If a reader has to know the sport's
  regulations to get it, it's the wrong moment. Yellow card, second serve and
  offside flag work; a cricket LBW review does not.
- **Documentary, not broadcast.** Pitchside/roadside candid framing, natural
  or floodlit light, shallow depth of field, slight grain. Never the glossy
  broadcast-graphic look.
- **Don't force it.** Sport is the first look, not the only one. If the post's
  idea doesn't map cleanly onto a rule, fall back to Lane C's object metaphors
  (coin, burst pipe, snooze button) rather than stretching for a sporting
  scene. A laboured metaphor is worse than a plain one.
- **Rotate.** Don't run the same sport two posts running. Across a month the
  bank should read as a signal, not a tic.

## 4. Text discipline (both lanes)

- Specify EVERY word on the image verbatim in the prompt, in quotes. Keep it
  minimal: a card is ~10-20 words total; a UI mockup uses short realistic
  UI strings.
- **No em-dashes in rendered text - ever.** Hyphens only (brand-wide rule).
- Numbers exact, never rounded, with denominators - and only numbers that come
  from the piece / its claims ledger. Never invent or decorate a signal.
- Lowercase kickers; sentence case elsewhere; selective ALL CAPS on at most one
  pivot word.

## 5. Never

- Oil-painting style, glowing orbs, purple accents, protocol-diagram metaphors
  (that's Alice's signal - keeping them apart is the point).
- Stock-clichés: handshakes, skylines, glowing brains, robots, lightbulbs,
  rockets, posed people at laptops.
- An image that answers the post's question or shows the resolution.
- Portrait for UI freeze-frames, landscape for cards (each lane keeps its
  orientation).
- More than one accent colour on a card.

## 6. Prompt templates

Lane A - stat card:

```
A minimal dark social media graphic, portrait 4:5, flat vector style.
Near-black navy background (#0f172a) with faint thin dark grey-blue orbital
arcs curving through the frame and two or three tiny bright blue dots, like an
astronomical chart. Top left: a short horizontal blue dash followed by the
small bold lowercase blue (#3b82f6) kicker text "[KICKER]". Upper middle,
enormous bold blue (#3b82f6) text: "[STAT]". Below it, large bold white text:
"[DEFINITION]". Below that a short blue underline rule, then muted slate grey
(#94a3b8) text: "[CONTEXT LINE]". Bottom left: small white [LOGO MARK] logo mark
next to the white words "[COMPANY NAME]". Clean modern grotesque typeface, extreme
type-scale contrast, generous negative space, matte, no other elements.
```

Lane A - question card: same template, replacing the STAT + DEFINITION block
with: `Upper middle, enormous bold white text on two lines: "[QUESTION]", with
the single word "[PIVOT WORD]" in blue (#3b82f6).`

Lane B - UI freeze-frame:

```
A realistic screenshot-style mockup of [THE PRODUCT SCREEN], landscape 16:9,
light/dark per the depicted product, with plausible filler content. [THE FROZEN
TENSION: e.g. "A centered white confirmation dialog floats above a dimmed
background, titled '[DIALOG TITLE]' with body text '[BODY]' and two buttons
'[SAFE]' and '[ACTION]'; a small cursor arrow rests on the '[ACTION]' button,
not yet clicking."] Soft material elevation shadows, believable UI density,
no brand logos, photorealistic screen rendering.
```

Render with the default pro model (`gemini-3-pro-image`) - both lanes depend on
reliable text rendering; don't draft these on `flash`. Cards: `--aspect 4:5`.
Freeze-frames: `--aspect 16:9`.
