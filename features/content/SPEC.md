# `content` - topics, pieces, and gated publishing

The outward-facing writing pipeline. A **topic** (`content_topics`) is the idea - a brief, an owner,
the channels it should reach, a briefing doc; a **piece** (`content_pieces`) is that topic on ONE
channel, carrying the publishing lifecycle. Structured state sits in the warehouse, the markdown
body stays on disk under `docs/content/<topic>/`. Around those two tables the feature owns the
per-channel **profiles** (limits, required fields, whether a real sender exists), the layered
**voice** files the drafting and verification skills check against, a named **transition machine**
instead of a status dropdown, and the gated publishers for LinkedIn and Substack. It also ships the
seven agent skills that do the actual writing (`features/content/skills/`).

- **dependsOn**: `data`, `planning`.
  - From **`planning`**: the vocabulary only - `PLANNING_STATUSES` / `PlanningStatus`
    (`types.ts`, `models.ts`, and the web mirror in `content-types.ts`). A topic's status IS the
    planning status list (`planned`/`active`/`blocked`/`done`/`dropped`), imported rather than
    re-declared. Nothing here reads or writes an initiative.
  - From **`data`**: `autoRegisterDefinitions` (signal definitions, `state.ts`), the Substack
    client (`data/pulls/substack-client.js`), the LinkedIn client (`data/pulls/linkedin-client.js`),
    and the browser/CDP helpers `browserIdentity`, `connectCDP`, `detach`, `firstContext` for the
    LinkedIn newsletter-article path. It also registers INTO data (see Ports).
- **Depended on by**: `engagement` (`dependsOn: ['data', 'content']` - the pods board reads
  `useContentData`, `ChannelLabel` and the `ContentPiece`/`ContentChannel` types, and contributes the
  `content.piece.panel` slot) and `alerts` (`dependsOn: ['data', 'planning', 'content',
  'engagement']` - `alerts/linkedin.ts` imports `readContentPieces` and `ContentPiece`).
  `notifications` reaches it transitively through `alerts`.
- **Removal**: `rm -rf` the three directories takes `engagement`, `alerts` and `notifications` with
  it (`pnpm features --check` names them). The `content_topics` / `content_pieces` tables stop
  being created; existing rows are left in the warehouse. The markdown under `docs/content/` and the
  voice files under `docs/identity/` survive - the feature reads them, it does not own them.

## Tables

| table | pk | holds |
|---|---|---|
| `content_topics` | `id` | the parent idea: `title`, `brief`, `status` (enum = `PLANNING_STATUSES`), `owner`, `target_channels` (json), `doc_path`, `signal_ids` (json), `tags` (json), `due_date`, `sort`. Timestamps + audit columns. |
| `content_pieces` | `id` (`<topic>/<channel>`) | the idea on one channel: `topic_id`, `channel`, `kind` (enum `CONTENT_KINDS`), `source_id`, `status` (enum `CONTENT_STATUSES`), `title`, `body_path`, `verify` (json verdict), `review` (json human sign-off), `metadata` (json bag: subreddit, flair, assets, post_urn, send_email…), `published_at` / `published_url` / `published_by`, `scheduled_at`. Timestamps + audit columns. |

`migrations: []`, and the manifest declares no `baseline` DDL - both tables are created from their
`ModelSpec` by the boot-time `CREATE TABLE IF NOT EXISTS`.

**Files on disk** (not tables, but state the feature addresses by convention):
`docs/content/<topic>/topic.md` (the brief), `docs/content/<topic>/<channel>.md` (a piece's body),
any media in the same folder (one physical file shared by every piece of the topic),
`config/channel-profiles.json` (the per-channel overlay), and the voice layers
`docs/identity/voice-guide.md` + `docs/identity/voice/{global,@<author>,<channel>,<channel>@<author>}.md`.
Every path is derived from validated slugs and re-checked to stay inside its base dir.

## Ports it owns

- **`registerSignalHooks({ id: 'content', derive: deriveContentSignals })`** - registered into
  `data` from `ContentModule.onModuleInit`. Derives `content.published.<channel>` and
  `content.published_total` (cumulative published counts, dated by `published_at`) into a `content`
  signal channel.
- **`registerLinkedinPostSource(publishedLinkedinPosts)`** - also into `data`, from the same hook.
  Content tells data's LinkedIn pull which published member posts (`linkedin` /
  `linkedin-article`, status `published`, a `metadata.post_urn`, author not `company`) to fetch
  per-post analytics for. Note the direction: the dependency (`data`) owns the port, the dependent
  (`content`) fills it - the same shape one level up, where `engagement` fills content's slot.
- **Web slot `content.piece.panel`** - rendered by `ContentDetailView.tsx`, props
  `{ piece: ContentPiece }`. `engagement` contributes `PodEngagementPanel` into it
  (`apps/web/src/features/engagement/index.tsx`). Content never names engagement.

## Procedures and tools

`ContentController` (`@Controller('content')`, class-level `@UseGuards(AuthGuard)`):

| tRPC | MCP | what |
|---|---|---|
| `contentTopics` (query) | `topic-list` | every topic, in the team's order |
| `contentTopicUpsert` (mutation) | `topic-upsert` | create / partially update a topic - what the draft pipeline writes |
| `contentTopicDelete` (mutation) | `topic-delete` | delete a topic and cascade its pieces; reports how many, and how many were published |
| `contentTopicPending` (mutation) | `topic-pending-channels` | the target channels an ACTIVE topic still has no piece for (empty for anything unapproved) |
| `contentPieces` (query) | - | every piece + the channel profiles + the transition catalogue |
| `contentList` (mutation) | `content-list` | the piece ledger, optionally filtered to one topic |
| `contentGet` (mutation) | `content-get` | one piece + its markdown body + the topic's assets with REST paths |
| `contentUpsert` (mutation) | `content-upsert` | create / partially update a piece (metadata deep-merges) |
| `contentTransition` (mutation) | `content-transition` | move a piece by NAMING the transition (approve, schedule, publish-now, record-published, reopen, archive, verify) |
| `contentSetStatus` (mutation) | `content-set-status` | the quick status write, for authoring and agent bookkeeping |
| `contentVerify` (mutation) | `content-verify` | record an agent-verify verdict; refuses an unknown severity. Moves nothing |
| `contentFindingsApprove` (mutation) | `content-findings-approve` | tick verify findings off by position (or all of them). Moves nothing |
| `contentVoiceRead` (mutation) | `voice-read` | the LAYERED voice markdown for (channel, author) - what rules apply to this draft |
| `contentRemove` (mutation) | `content-delete` | delete a piece (its body stays on disk) |
| `contentAssets` (mutation) | - | list a topic folder's media files (the asset picker) |
| `contentDoc` (mutation) | - | read a piece's markdown body |
| `contentDocSave` (mutation) | `content-doc-save` | write a body (the editor's autosave target) |
| `contentPublish` (mutation) | `content-publish` | the gated, RECORD-ONLY publish: requires `confirm`, requires the piece cleared the gate, refuses `linkedin` (that channel has a real sender) |

Plus one plain REST route, no tRPC and no MCP: `GET /api/content/asset/:topic/:file` streams a
media file out of the topic folder - the `<img src>` behind `metadata.assets`.

`ChannelsController` (`@Controller('channels')`, class-level `@UseGuards(AuthGuard)`):

| tRPC | MCP | what |
|---|---|---|
| `channelsConfig` (query) | - | every channel's profile in force, the shipped defaults, which fields the team overrode, the voice-layer inventory, and the ids an overlay may be written for |
| `channelsProfileSet` (mutation) | `channel-profile-set` | overlay one channel's descriptive fields (`publish` is deliberately not settable) |
| `channelsProfileReset` (mutation) | `channel-profile-reset` | drop every override on one channel |
| `channelsVoiceRead` (mutation) | - | ONE voice layer's body, named by (channel, author) |
| `channelsVoiceSave` (mutation) | `voice-write` | write one layer, creating it if absent |

23 tRPC procedures, 18 MCP tools, 1 REST endpoint.

## Actions

Seven, all in the `Content` group, all publishers (`actions.ts`):

| id | schedulable | what |
|---|---|---|
| `linkedin-publish` | no (parameterized) | POST an approved `linkedin` piece via the Posts API (`content_id`, `confirm:"true"`) |
| `linkedin-publish-approved` | **yes** | the most urgent DUE `linkedin`/`linkedin-article` piece, cap 1/run, dry-run unless `LINKEDIN_PUBLISH_LIVE=1` |
| `linkedin-article-draft` | no (parameterized) | create a newsletter-article DRAFT in the author's browser (CDP; no article API exists) |
| `linkedin-article-publish` | no (parameterized) | full article publish in the author's browser: cover, title, body, announcement post (`confirm:"true"`) |
| `substack-draft` | no (parameterized) | push a `substack` piece into a Substack draft. Never publishes |
| `substack-publish` | no (parameterized) | publish a DUE `substack` piece via the private API; mails the list only if `metadata.send_email` |
| `substack-publish-due` | **yes** | the most urgent DUE substack piece, cap 1/run, dry-run unless `SUBSTACK_PUBLISH_LIVE=1` |

"DUE" is `isPublishDue`: status `scheduled` with `scheduled_at` in the past, and nothing else.
`approved` arms nothing.

## The lifecycle is a process, not a property

`transitions.ts` owns what a piece can do next, and the reason it is a named transition rather than
a status dropdown is an incident. When `approved` meant "any publisher may send this at will" and
the dashboard exposed the lifecycle as a status field, picking "Approved" on a LinkedIn piece
posted it publicly within five minutes, dressed up as a property edit (2026-07-30). So **`approved`
is a human sign-off that arms nothing**, and **`scheduled` is the only armed state and always
carries a visible `scheduled_at`** - `isPublishDue()` is one rule for every channel, and setting
`scheduled` without a time is refused in `upsertContent` itself, not merely at the transition.

- **A dialog is for required input or an outward consequence, and nothing else.**
  `transitionNeedsDialog(spec)` DERIVES that (`input` is required ∨ `outward`) rather than each
  entry declaring it, so a new transition cannot forget it. Confirming everything is the same as
  confirming nothing: it trains people to dismiss the dialog unread, and the one that has to
  survive that habit is the one standing in front of a real send.
- **Finding identity is positional.** `approved` lives on the finding inside the stored verdict, so
  a re-verify replaces the array and every tick resets with it. Findings regenerated against an
  edited draft are new findings; inheriting an old approval would be exactly the silent mis-accept
  per-finding approval exists to prevent.
- **Ticking is debounced for correctness, not feel.** A tick paints from local state and the whole
  burst flushes as ONE call. A request per click would be N read-modify-writes racing each other,
  and a lost one is silent - measured on a copy of production, 11 findings ticked concurrently left
  1 approved. The optimistic override is retired only once the stored verdict AGREES with it (never
  on a timer), and the panel flushes on unmount so navigating away cannot eat the last click.

Two data conventions worth knowing before writing a piece:

- **`feature` is THE image of a piece on every channel.** `social` is a second file for the case it
  was built for - a feed-cropped variant on a piece whose feature is something else - and it is
  never "the LinkedIn one". Both publishers read `feature` first, after a leftover `social`
  illustration silently won over the image a human had attached and marked `feature`.
- **Files are not visible; rows are.** The board renders warehouse rows, so a body written to
  `docs/content/<topic>/<channel>.md` appears only after a `content-upsert`, and it hangs under its
  topic only once that topic has its own row. And `scheduled_at` is stored as naive UTC because a
  DuckDB `TIMESTAMP` cast silently DROPS a string's offset: writes normalize, reads re-attach the
  `Z` (`warehouse/model.ts`).

The numbered **operator rules** the skills are written against live in
[`OPERATOR.md`](./OPERATOR.md); the numbering is cited by name, so do not renumber them.

## UI

- **Routes**: `/content` (the board), `/content/$topic` (the topic page: fields, brief, its pieces),
  `/content/$topic/$channel` (one piece: editor, transition wizard, verify findings, assets, slots).
  `$topic` is an intermediate layout that only forwards to its children.
- **Nav**: one entry, `Content`, icon `Megaphone`, order band **300**.
- **Settings**: one section, `Channels`, icon `MessagesSquare`, order **300** - the profile overlay
  editor plus the voice-layer editor (`ChannelsView`).
- **Shell / onSession**: none declared. `ContentLayout` passes `topbar={{ crumbs }}` to
  `AppShell`, which is the UI library's own prop, not the `shell.topbar` seam.
- **Slots**: content is the OWNER of `content.piece.panel` (see Ports); it contributes into none.
- **Data**: one shared store over `contentPieces` + `contentTopics`, reloaded on the change-feed
  keys `table:content_pieces`, `table:content_topics`, `docs:content`. Transitions are deliberately
  not optimistic - the server can refuse one.
- The body editor is behind a lazy chunk (`components/ContentBodyEditorLazy.tsx`).

## Env

From `apps/server/src/features/content/index.ts`:

| name | doc |
|---|---|
| `LINKEDIN_PUBLISH_LIVE` | `1` to let the scheduled LinkedIn publisher post for real (dry-run otherwise) |
| `SUBSTACK_PUBLISH_LIVE` | `1` to let the scheduled Substack publisher post for real (dry-run otherwise) |

The LinkedIn and Substack clients themselves live in `data` and carry their own credentials/session
requirements; those env entries belong to that feature, not this one.

## The skills

Seven, under `features/content/skills/`. The recipe copies them into `.claude/skills/` - they are
markdown procedures for a Claude Code session, not code, and nothing in the three source trees
imports them.

| skill | one line |
|---|---|
| `consult` | the concierge: answers "how do I / where does this live / what is next" and routes to one action. Never mutates state |
| `draft-content` | turn a topic into a canonical blog post plus channel adaptations. Drafts only, never publishes |
| `refine-content` | revise an existing draft along a direction (pivot, deepen, add a source, tighten, address findings), then re-verify |
| `verify-content` | the gate: check a piece against the voice hard-rules, the topic's claims ledger and the channel profile, then record the verdict via `content-verify` |
| `publish-content` | publish an approved piece from a machine that is not the Box, then sync back: record URL, flip to published, keep the brief in parity. Human-gated, never auto-posts |
| `illustration` | generate an on-brand illustration for a piece through the Gemini image API and attach it as an asset |
| `ingest-sink` | process a `docs/sink/` note into tracked planning state (initiative + tasks + a rationale doc) |

`draft-reply` and `engage` used to be here; they moved to `features/engagement/skills/` on
2026-09-13, because they save through `inbox-draft-save` and `pod-engagement-draft`, which that
feature owns, and `content` does not depend on `engagement`.

`ingest-sink` is the one skill that still reaches past this feature: it reads a note out of
`docs/sink/` (the `sink` feature's queue) and writes planning state. It stays here because `content`
depends on `planning` and the writing is the skill, but a Box without `sink` has nothing for it to
read. No feature covers all three, and a skill is prose, not an import, so nothing enforces this -
it is a judgement, recorded so the next person does not have to re-derive it.

## Admin-only

Since 2026-09-13 the Box has two tiers (`docs/core/AUTH.md` § 3), and the rule every feature applies is
one sentence: **an operation is admin-only when its blast radius is another person's identity or
credential, the service itself, or configuration wired to credentials.**

This feature's admin set is `channel-profile-set`, `channel-profile-reset`, `voice-write`.

A channel profile and the voice are configuration wired to the credentials that publish. Writing,
verifying and publishing a piece are a member's - that is the work.

## What a team customises

- **The channel vocabulary** - `CONTENT_CHANNELS` in `types.ts`
  (`blog`, `reddit`, `x`, `linkedin`, `linkedin-article`, `hackernews`, `substack`) and the matching
  `CHANNEL_PROFILE_DEFAULTS` in `profiles.ts`. It is a closed list: a channel with no entry has no
  profile, and an unknown key in the overlay file is ignored rather than becoming a phantom channel.
- **The profiles themselves** - label, `bodyKind`, `limits`, `voiceNotes`, `requires`, `recommends`.
  Editable at runtime in Settings → Channels, which writes `config/channel-profiles.json` as an
  OVERLAY (only the keys somebody changed). `channel` and the whole `publish` block are not
  overlayable: `publish.auto` describes what code exists, and no config can conjure a sender.
- **The voice and style guides** - `docs/identity/voice-guide.md` (the stance) and
  `docs/identity/voice/*.md`, layered global → `@<author>` → `<channel>` → `<channel>@<author>`.
  This is the biggest customisation surface and the one every skill reads. The shipped files are
  worked examples, not anybody's actual house style; a new team rewrites them.
- **The content gate** - `VERIFY_SEVERITIES` (`fail`/`warn`/`pass`) and the three lenses a finding
  can come from (`voice`, `claims`, `constraints`) in `types.ts`, plus the rule that every finding
  must be ticked before `approve` enables.
- **The lifecycle vocabulary** - `CONTENT_STATUSES` / `CONTENT_STAGES` / `CONTENT_KINDS` in
  `types.ts`, `TOPIC_STATUSES` (imported from planning - change it there, not here), and the
  transition catalogue's labels and `intent` copy in `transitions.ts`, which is what the confirm
  dialogs say.
- **Labels and order** - the nav entry and the settings section in
  `apps/web/src/features/content/index.tsx`, both at band 300.
