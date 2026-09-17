# Illustration Style Guide - Alice (author: `alice`, and the fallback)

Alice's visual language for blog / LinkedIn illustrations, derived from a
proven oil-painting prompt. Every image should read as part of the same signal:
a moody, luminous, oil-painted developer-protocol diagram. (Carol's images use a
different system entirely - `STYLE_GUIDE-carol.md`. This file is also the
fallback for authors without their own guide.)

The recipe is **fixed anchors + one flexible idea**. Keep the anchors verbatim;
the only thing that changes between images is the *visual metaphor* in the
middle.

---

## 1. One-line identity

> A dark, moody oil-painting-style digital illustration of a technical concept
> rendered as a physical scene - deep navy/indigo, glowing focal points, clean
> geometric shapes, the look of developer tooling UI and protocol diagrams.

## 2. Fixed anchors (include in every prompt, near-verbatim)

These are what make the signal cohere. Don't paraphrase them away.

| Anchor | Phrase to keep |
|--------|----------------|
| Style preset | `Style Preset: Oil Painting` (as the first line) |
| Medium | "A dark, moody digital illustration showing ..." |
| Palette | "Deep navy and indigo background with purple and soft blue accent lighting." |
| Light behavior | focal elements are "glowing", "luminous", "saturated and spilling light" |
| Form language | "Clean geometric shapes." |
| Reference | "Inspired by developer tooling UI and protocol diagrams." |
| Restraint | "Minimal, technical aesthetic." |
| No text | "No text." (see §7 for the exception) |
| Format | "Wide format, 16:9 aspect ratio." |

## 3. The flexible slot - the metaphor

Exactly one idea per image, expressed as a **physical scene** that stands in for
an abstract technical concept. The strongest version is a **before/after or
problem/solution split**:

> "On one side, [the problem state]. On the other side, [the resolved state]."

This mirrors the source image (overflowing context window vs clean summary +
deferred storage) and is the house composition. Use it whenever the post argues
"don't do X, do Y."

When there's no contrast to draw, fall back to a **single central metaphor**
(§5).

## 4. Color & light

- **Background:** deep navy to indigo gradient. Think `#0A0E27`-`#1A1B4B`.
- **Accents:** purple (`#7C3AED`-ish) and soft blue (`#3B82F6`-ish) lighting.
- **Focal point:** one luminous element - an orb, a stream, a card - that is
  clearly the brightest thing and "spills" light onto nearby surfaces.
- **Measure through saturation:** overload / problem = over-saturated, spilling,
  too-bright. Calm / resolved = evenly lit, contained, organized.
- Keep it dark overall. The glow only works against darkness.

## 5. Composition patterns

1. **Split (default):** problem on the left, solution on the right, an arrow /
   funnel / pipe / fork connecting them. Best for "anti-pattern vs pattern".
2. **Flow:** data moves left to right through a transformation (stream, funnel,
   orb). Best for pipelines, protocols, request lifecycles.
3. **Central focal:** one glowing object dead-center with supporting elements
   orbiting it. Best for "introducing concept X".
4. **Stack / shelf:** organized storage, layers, shelves. Best for memory,
   caching, persistence, deferral.

## 6. Vocabulary bank - concept to physical object

Translate the abstract into objects from this kit so images stay on-brand:

| Technical concept | Render as |
|-------------------|-----------|
| Data / payload | a glowing stream; dense grid blocks of JSON/text |
| LLM context window | a small luminous orb that can over-saturate and spill |
| Too much data / overload | an overflowing funnel; a flooded orb |
| Summary / compaction | a small clean "summary card" |
| Deferred / lazy / offloaded | a glowing annotation tag; redirected flow |
| Storage / memory / cache | calm, organized shelves or stacked layers |
| Routing / dispatch | a fork, junction, or switchboard of glowing pipes |
| Tools / adapters | interchangeable geometric modules plugged into a hub |
| Streaming | a continuous luminous ribbon of discrete chunks |
| Type safety / schema | a precise lattice or grid that payloads snap into |
| Errors / failure | a fracture, a dropped/dark fragment, a broken pipe |
| Auth / security | a glowing gate, key, or membrane |
| Verification / claims | a gate or membrane that stamps, tethers, or holds back cards |

Extend the kit, but keep new objects geometric, glowing, and protocol-diagram-like.

## 7. Hard constraints

- **Aspect ratio:** 16:9 wide by default (LinkedIn/blog hero). 1:1 for square
  social, 4:5 for portrait feed real estate, 9:16 for stories. Pass via `--aspect`.
- **No text by default.** Image models garble text. State "No text." explicitly.
- **Exception:** `gemini-3-pro-image` (the default model) renders *short* labels
  reliably. If a label genuinely aids the metaphor (like "deferred" in the
  source), you may name *one or two* short labels and drop "No text." Never ask
  for paragraphs or UI chrome full of text.
- **Geometric, not painterly-chaotic.** "Clean geometric shapes" keeps the oil
  texture from turning muddy.

## 8. Prompt template (fill the brackets, keep the rest)

```
Style Preset: Oil Painting

A dark, moody digital illustration showing [ONE-SENTENCE METAPHOR].
[For a split:] On one side, [PROBLEM STATE rendered as objects]. On the other
side, [RESOLVED STATE rendered as objects]. [Describe how light/saturation marks
the difference.] Minimal, technical aesthetic. Deep navy and indigo background
with purple and soft blue accent lighting. No text. Clean geometric shapes.
Inspired by developer tooling UI and protocol diagrams. Wide format, 16:9 aspect
ratio.
```

## 9. Worked examples

**Source (context-window overflow):** the canonical example - overflowing funnel
into a saturated orb vs. a clean summary card + "deferred" data redirected to
organized shelves.

**"tRPC end-to-end type safety":**
> Style Preset: Oil Painting
>
> A dark, moody digital illustration showing a glowing data payload traveling
> through a transparent geometric lattice that runs unbroken from a server block
> on the left to a client block on the right. The payload snaps perfectly into
> matching slots at both ends, the lattice glowing where types align. Minimal,
> technical aesthetic. Deep navy and indigo background with purple and soft blue
> accent lighting. No text. Clean geometric shapes. Inspired by developer tooling
> UI and protocol diagrams. Wide format, 16:9 aspect ratio.

**"One Action, many adapters":**
> Style Preset: Oil Painting
>
> A dark, moody digital illustration showing a single luminous core cube at
> center, with identical glowing data streams radiating outward into several
> distinct geometric ports - a terminal, an API gateway, a chat orb - each
> port-shaped differently but fed by the same core. Minimal, technical aesthetic.
> Deep navy and indigo background with purple and soft blue accent lighting. No
> text. Clean geometric shapes. Inspired by developer tooling UI and protocol
> diagrams. Wide format, 16:9 aspect ratio.
