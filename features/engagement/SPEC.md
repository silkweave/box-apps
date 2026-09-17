# `engagement` - pods, the tactical inbox, engagement verification

> **Install this one late.** `engagement` is an optional addon to `content`, not part of the first
> Box a team stands up (decided 2026-09-13). Pods and the tactical inbox only earn their keep once
> content is actually flowing, and the architecture already assumes that direction: engagement
> depends on `content` and reaches it only through the `content.piece.panel` slot, never the
> reverse, so content works perfectly well with this feature absent.

Three surfaces over one idea: someone should say something. **Pods** are topic networks of people
who amplify each other's posts - a pod holds members and curated pieces, and the engage-queue is
**derived** (pod content inside a recency window × pod members, author excluded, × the actions the
channel expects) minus what has already been recorded, so acting on a card makes it disappear. The
**tactical inbox** ("Replies") flattens the latest engagement snapshots plus the response-needed
rows of the events spine into one actionable list, with per-item done/snoozed state and a draft
reply an agent can write and a human copies out. **Engagement verification** is the deterministic
`pod-engagement-verify` op: it answers "did I engage" from the *engager's own* side - reddit's
public thread JSON, or their own logged-in Chrome over CDP for x and linkedin - and records the
engagement (karma included) only on a `confirmed` verdict.

- **dependsOn**: `data`, `content`.
  - From **`data`**: `browserIdentity` (`features/data/browsers.ts`, `config/browsers.json`:
    `users.id` → chromatrix identity) and `connectCDP` / `firstContext` / `detach`
    (`features/data/cdp.ts`) - the whole browser half of `verify/strategies.ts`. The inbox build
    also reads data's `snapshots` table directly (`github-engagement`, `hackernews`,
    `reddit-engagement`, latest row per channel).
  - From **`content`**: `pod_content` LEFT JOINs `content_pieces` to resolve a team piece's
    `topic_id` (`pods/state.ts`, `CONTENT_FROM`), and the `content.published` event is what feeds
    the auto-content hook. On the web: `ContentPiece` / `ContentChannel` types, `ChannelLabel`,
    and `useContentData` for topic titles in the Pods admin section.
  - From **core** (not a dependency, just core): the events spine (`listEvents`, `onEvent`),
    `users/state.ts` (`readUsers` for handles and karma labels), `accounts.ts`
    (`channelPlatform`), the warehouse record layer, and the run funnel.
- **Depended on by**: `alerts` (`dependsOn: ['data','planning','content','engagement']`), which
  imports `inboxDeepLink` and `dashboardUrl` from `engagement/inbox/inbox-map.ts` so an alert card
  can deep-link the exact Replies item the event created.
- **Removal**: `rm -rf` the three directories - but `alerts` must go with it (and `notifications`
). `pnpm features --check` names them. The six tables are left in the
  warehouse; nothing else reads them.

## Tables

`migrations: []` - the six models are the whole schema and there is no baseline DDL.

| table | pk | what |
|---|---|---|
| `inbox_state` | `id` | done/snoozed state for one inbox item. **Open items have no row.** `status`, `done_at`, `note` |
| `inbox_drafts` | `item_id` | one draft reply per item: `channel`, `body`, `author` (the `users.id` whose voice it speaks in). Timestamps + audit |
| `pods` | `id` | a pod: `title`, `description`, `status` (`active`/`paused`/`archived`), `owner`, `sort`. Timestamps + audit |
| `pod_members` | `pod_id, participant_kind, participant_id` | membership: `role` (`admin`/`member`), `joined_at`, `created_by` |
| `pod_content` | `id` | a curated piece: `pod_id`, `source`, `content_id` (content's piece when `source='team'`), `submitter_kind`/`submitter_id`, `channel`, `url`, `title`, `advice` (json), `published_at`. Timestamps + audit |
| `pod_engagements` | `pod_content_id, participant_kind, participant_id, action` | the ONLY persisted card state: `status` (`verified`/`dismissed`/`draft`), `verified_at`, `evidence` (json), `karma_awarded`, `note`. Timestamps + audit |

Two derivations are never stored: the **cards** (`derivePodCards()`) and **karma**
(`computeKarma()`, a SQL rollup over verified rows, credited twice - `given` to the engager,
`received` to the piece's submitter, per pod and globally with `pod_id` null).

The rate itself is the exception: `karma_awarded` is **stamped onto the row** at record time from
`pods.json`, so re-pricing an action later never rewrites history. Karma is display only - it
never rations, gates or prioritises a card - and a dismissal awards none.

## Files on disk

- `<BOX_DATA_DIR>/config/pods.json` - owned by this feature. `windowDays` (default 14), `channels`
  (channel → the always-expected `actions`), `karma` (flat points per action; defaults
  like/react 1, repost/crosspost 2, comment 5), `autoContent` (`{ pod, channels, enabled? }`).
  Read at query time, so edits apply without a restart. A missing file means "no channel expects
  engagement".
- `<BOX_DATA_DIR>/_evidence/engagement/<pod_content_id>__<user>.png` - screenshots captured by the
  browser verify strategies; the stored path is instance-relative. A capture failure never
  downgrades a `confirmed` verdict.

## The web slot it fills

`engagement` renders a panel INSIDE content's piece detail page and content knows nothing about it:

```ts
// apps/web/src/features/engagement/index.tsx
slots: { 'content.piece.panel': [PodEngagementPanel] }
```

`content` owns the slot name and its props (`ContentDetailView.tsx` calls
`slotComponents<{ piece: ContentPiece }>('content.piece.panel')`); `engagement` is the contributor.
The panel shows which pods carry the piece, each member's per-action state (verified / dismissed /
draft saved / pending) and the karma the piece has received. **The dependent registers into the
dependency, never the reverse** - the same rule the server side follows, where `PodsModule`'s
`onModuleInit` calls core's `onEvent(onContentPublished)` rather than content calling pods.

## Procedures and tools

`InboxController` (`@Controller('inbox')`, class-level `@UseGuards(AuthGuard)`):

| tRPC | MCP | what |
|---|---|---|
| `inboxData` (query) | - | the actionable list, newest-first, built live from snapshots + events |
| `inboxState` (query) | - | every done/snoozed entry |
| `inboxSetDone` (mutation) | `InboxSetDone` | set `done`/`snoozed`, or `open` to delete the row |
| `inboxDrafts` (query) | - | every stored draft reply |
| `inboxDraftGet` (mutation) | `inbox-draft-get` | one item's draft, `null` when none |
| `inboxDraftSave` (mutation) | `inbox-draft-save` | upsert a draft; an empty body DELETES it |

`PodsController` (`@Controller('pods')`, `@UseGuards(AuthGuard)`) - the admin surface. It only
*records* engagements; it never engages on anyone's behalf:

| tRPC | MCP | what |
|---|---|---|
| `podsOverview` (query) | `pods-overview` | the whole picture: pods, members, content, engagements, derived cards, karma, the `autoContent` config |
| `podsUpsert` (mutation) | `pod-upsert` | create/edit a pod (slug id, `a-z0-9-`) |
| `podsDelete` (mutation) | `pod-delete` | delete a pod, cascading members, content and engagements |
| `podsAutoContentSet` (mutation) | `pod-auto-content-set` | flip `autoContent.enabled` in `pods.json`; it pauses, it never configures |
| `podsMemberAdd` (mutation) | `pod-member-add` | add or re-role a member (`joined_at` sticks to the original join) |
| `podsMemberRemove` (mutation) | `pod-member-remove` | remove a member |
| `podsContentUpsert` (mutation) | `pod-content-add` | curate a piece into a pod, with optional `advice` JSON |
| `podsContentDelete` (mutation) | `pod-content-delete` | remove a piece and its engagements |
| `podsEngagementRecord` (mutation) | `pod-engagement-record` | record a `verified` engagement (evidence defaults to `{"method":"manual"}`) |
| `podsEngagementDismiss` (mutation) | `pod-engagement-dismiss` | opt out of a card without recording a fake engagement |
| `podsEngagementDraft` (mutation) | `pod-engagement-draft` | save a member's own comment draft onto a card; refuses to overwrite a `verified` row, and an empty draft clears it |
| `podsEngagementVerify` (**subscription**) | `pod-engagement-verify` | start the verify op detached and stream its progress; the terminal chunk's `result.summary` is `<verdict>: <detail>` |

`PodsSelfController` (also `@Controller('pods')`) - the self-scoped mirror. Identity comes from the
request principal, never from a client-supplied id, so a caller can only act as themselves. tRPC
only, no MCP:

| tRPC | what |
|---|---|
| `podsSelfOverview` (query) | the caller's active pods, their cards, their karma rows, per-pod leaderboards |
| `podsSelfKarma` (query) | just global given/received - cheap enough for the topbar badge |
| `podsSelfEngage` (mutation) | self-attest an engagement (evidence `manual`) |
| `podsSelfDismiss` (mutation) | dismiss one of the caller's cards |
| `podsSelfSubmit` (mutation) | submit the caller's own post into a pod they belong to |

23 procedures, 15 of them also MCP tools.

## Actions

One, in core's run funnel (`actions.ts`):

| id | group | what |
|---|---|---|
| `pod-engagement-verify` | `Engagement` | `parameterized: true` - params `pod_content_id`, `participant_kind`, `participant_id` (+ `actor`). Resolves the piece, asserts membership, works out the remaining expected actions, runs the per-`(channel·action)` strategy for each, and records the ones that come back `confirmed` |

Verdict discipline: ambiguity is `unknown`, never `confirmed` - a false positive corrupts the
ledger, a false negative just means clicking Verify again. A run is `confirmed` only when every
remaining action confirmed; one `unknown` makes the whole run `unknown`.

## Events

- **In**: `PodsModule.onModuleInit` registers `onContentPublished` on core's events spine. A
  `content.published` event whose channel is listed in `autoContent.channels` mints a `pod_content`
  row in the configured pod. Idempotent on `(pod_id, content_id)`, so re-saves never duplicate a
  card.
- **Read**: the inbox build queries `events` for `x.reply`, `x.mention`, `x.quote`,
  `reddit.inbox`, `github.notification`, `linkedin.comment` over a 30-day window.
  `inbox-map.ts` is the one place that decides which event kinds are response-needed and what the
  resulting item id is - deliberately the SAME id the reddit snapshot items produce, so one
  engagement arriving by both paths is one item with one state row.

## UI

- **Routes**: `/engagement`, `/engagement/$section`, `/engagement/$section/$channel`,
  `/engagement/$section/$channel/$itemId`. One stateful view (`EngagementView`); the children only
  register path segments. `$section` is `inbox` | `replies` | `karma`, and an unknown section
  falls back to `inbox`, so old `/engagement/<channel>` links keep working. The deepest route is
  the landing target of an alert card's "Open in dashboard" button.
- **Sections**: *Inbox* is the active user's pod engage-queue (groupable by pod / author /
  channel, with a per-card dialog that records, dismisses, verifies, or holds a draft); *Replies*
  is the tactical inbox with channel filter, detail page and draft panel; *Karma* is the
  leaderboards.
- **Nav**: one entry, `Engagement`, icon `HeartHandshake`, order band **400**.
- **Settings**: one section, `Pods`, icon `Boxes`, order **400** - pod/member/content CRUD plus
  the auto-content toggle.
- **Slots**: `content.piece.panel` → `PodEngagementPanel` (above).
- **Shell topbar**: none. The karma badge is rendered by `EngagementView`'s own `AppShell`
  topbar, on purpose - karma is Engagement's number, not the app's. Note the badge is
  **principal-scoped** (`podsSelfKarma`) while the queue follows the **active** user from the
  top-right menu; the two disagree while impersonating.
- **onSession**: none.
- **Stores**: `usePodsData` reloads on `table:pods`, `table:pod_members`, `table:pod_content`,
  `table:pod_engagements`, `table:users`, `config:pods.json`; `useSelfKarma` on
  `table:pod_engagements`, `table:pod_content`. The queue additionally polls every 5s while
  visible, because drafts land from outside the tab (an agent over MCP).

## Env

The `ServerFeature` declares **no `env`**. Two things are still environment-sensitive:

- `DASHBOARD_URL` is read by `inbox/inbox-map.ts` (`dashboardUrl()`, `inboxDeepLink()`); unset
  simply means no deep links. It is `alerts` that consumes them, and `alerts` declares it.
- The browser verify path goes through data's CDP client, whose `CHROMATRIX_URL`,
  `CHROMATRIX_IDENTITY` and `CHROMATRIX_TOKEN` belong to `data`.

## Admin-only

Since 2026-09-13 the Box has two tiers (`docs/core/AUTH.md` § 3), and the rule every feature applies is
one sentence: **an operation is admin-only when its blast radius is another person's identity or
credential, the service itself, or configuration wired to credentials.**

This feature's admin set is `pod-member-add`, `pod-member-remove`.

Membership decides whose name appears on an engage queue, so it is about other people. Pods,
curated content, the inbox and recording an engagement are a member's.

## What a team customises

- **`config/pods.json`** is the real configuration surface: which channels expect what
  (`channels`), how long a card stays live (`windowDays`), what each action is worth (`karma`),
  and whether published pieces auto-land in a pod (`autoContent`).
- **The action vocabulary** - `EngagementAction` in `verify/types.ts`:
  `like | react | comment | repost | crosspost`. Adding one means a karma default, an entry in
  `ACTION_META`/`ACTION_ICON` on the web, and probably a verify strategy.
- **Verify strategies** - `verify/strategies.ts` maps `"<channel>:<action>"` to a checker. Mapped
  today: `reddit:comment`, `x:like`, `x:repost`, `linkedin:react`, `linkedin:comment`,
  `linkedin-article:react`, `linkedin-article:comment`. Anything else answers `unknown` with
  "record manually" - never fatal.
- **Pod shape** - pods, their members and roles (`admin`/`member`), the per-piece `advice`
  (`actions` ADD to the channel base, they never suppress it; `hint`; `draft_comment`).
- **`PodStatus`** (`active`/`paused`/`archived`) - only `active` pods produce cards.
- **The inbox vocabularies** - `InboxChannel` and the ~16 `InboxKind` values in `inbox/types.ts`,
  and the channel labels in the web's `inbox-types.ts`.
- **Nav/settings labels and order** (both band 400) in `index.tsx`.
- **The agent commands** the UI offers: `/engage <pod-content-id>` on a card, `/draft-reply
  <item-id>` on an inbox item. Both skills ship under `features/engagement/skills/` (moved here
  from `content` on 2026-09-13).
- Two vocabularies are **deliberately frozen**: `ParticipantKind` is `'user'` only and
  `PodContentSource` is `'team'` only. The external-collaborator tier was removed on 2026-09-10;
  the columns stay because they are part of three composite primary keys.

## What needs a real browser

`x:like`, `x:repost`, `linkedin:react` and `linkedin:comment` (and their `linkedin-article`
twins) verify by opening the page in **the engager's own logged-in Chrome**, reached over CDP
through chromatrix, with the identity looked up in `config/browsers.json` by `users.id`.
Operationally that means:

- a machine with a persistent, human-logged-in headed Chrome per participant, and the chromatrix
  gateway reachable from the server;
- an undeclared identity, an unreachable gateway or a logged-out session is an `unknown` verdict
  with an actionable message - never an exception, so the card's manual-record fallback always
  stays available;
- these checks are inherently brittle against platform DOM drift, which is why each strategy keeps
  more than one selector path and why `unknown` exists;
- `reddit:comment` needs no browser on the happy path (public thread JSON), and only falls back to
  the engager's session when reddit IP-blocks the server;
- comment strategies hard-require the participant's handle in `users.channels[<platform>]`
  (Settings → Users); toggle strategies (like/react) read button state and do not.

**A LinkedIn comment check must scroll first.** Comments hydrate only once the block nears the
viewport, `window.scrollTo` is inert on those pages and `<main>` is the scroll container - a post
carrying a fresh comment verified as "none" until scrolled (observed live 2026-07-22). The comment
DOM also has two shapes, and the only stable anchor in the hashed-class one is the per-comment
`aria-label="View more options for …'s comment."` button, so the strategy climbs from that rather
than matching a class. Any new reader of post-comment DOM starts from the same two assumptions.
