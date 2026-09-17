# Installing `engagement`

The recipe. Read [`SPEC.md`](./SPEC.md) first for what the feature is; this is how it gets into a
Box and what to change afterwards.

## 1. Install

**Install `data` and `content` first.** `engagement` imports both (`features/README.md`), and
`pnpm features --check` refuses a `dependsOn` that names a feature the Box does not have.

**The scaffold is the working code**, not a copy of it (see `features/README.md`). `box adopt`
fetches it from the registry at its tag, byte-exact, and rewrites the registries and skill links:

```bash
box registry validate                  # confirm the index offers engagement, and at which version
box adopt engagement                   # fetches the four directories and anything it dependsOn
pnpm install && pnpm build             # adoption changes package.json; tests resolve via build/
pnpm verify                            # features:check, lint:deps, typegen, typecheck, lint, both suites
pnpm schema:check                      # diagnostic, not part of verify: run it after a schema change
```

In this checkout `engagement` is already installed; the above is what a fresh Box runs.

**Do not rename the directory.** The name is the migration ledger namespace (`<feature>:<name>` in
`schema_migrations`) and the same string in all three trees. `engagement` ships `migrations: []`
today - the six tables come straight from `models.ts` - but the rule has no exceptions.

This feature carries two skills of its own (moved here from `content` on 2026-09-13, because they
drive this feature's tools):

```bash
mkdir -p .claude/skills && cp -R features/engagement/skills/* .claude/skills/
```

`engage/` writes a pod comment draft via `pod-engagement-draft`; `draft-reply/` writes an inbox
draft via `inbox-draft-save`. Without them copied, the `/engage` and `/draft-reply` buttons in the
UI hand the user a command nothing implements.

Nothing else is edited.

## 2. Customise for the team

1. **Write `<BOX_DATA_DIR>/config/pods.json`.** Without it no channel expects an engagement and
   the queue is permanently empty - this is the one required step.

   ```jsonc
   {
     "windowDays": 14,
     "channels": { "x": { "actions": ["like", "repost"] }, "linkedin": { "actions": ["react"] } },
     "karma": { "like": 1, "react": 1, "repost": 2, "comment": 5, "crosspost": 2 },
     "autoContent": { "pod": "launch", "channels": ["linkedin", "x"], "enabled": true }
   }
   ```

   It is read at query time, so edits apply without a restart. `autoContent` is what makes a
   published `content` piece appear as a card by itself; leave it `null` to curate by hand.
2. **Create the pods and their members** - Settings → Pods, or `pnpm cli pod-upsert` /
   `pod-member-add`. Only `active` pods produce cards, and a piece's own submitter never gets a
   card for it.
3. **Set each member's channel handles** in Settings → Users (`users.channels`, keyed by
   platform). Comment verification hard-requires them; like/react verification does not.
4. **Map browsers** in `config/browsers.json` (`users.id` → chromatrix identity) if the team wants
   x/linkedin verification rather than manual attestation. That file belongs to `data`.
5. **Vocabularies** in `verify/types.ts` (`EngagementAction`) and `inbox/types.ts`
   (`InboxChannel`, `InboxKind`). Adding an action needs a karma rate, an `ACTION_META` /
   `ACTION_ICON` entry in `apps/web/src/features/engagement/engagement-types.ts`, and usually a
   `runStrategy` case. Leave `ParticipantKind` and `PodContentSource` alone - they are frozen
   single-value enums holding down three composite primary keys.
6. **Labels and order** in `apps/web/src/features/engagement/index.tsx`: nav `Engagement` and the
   `Pods` settings section are both band 400. "Pods", "karma" and "Replies" are this team's words;
   change them in `index.tsx` and in `EngagementView.tsx`'s `SECTIONS` if they are not yours.
7. **Nothing to add to `.env`** - the feature declares no `env`. `DASHBOARD_URL` (deep links out
   of alert cards) and the `CHROMATRIX_*` variables are declared by `alerts` and `data`.

## 3. Prove it

```bash
pnpm dev
```

- `http://localhost:8190/settings/pods` - create a pod, add two members, add a piece with a URL
  on a channel that `pods.json` covers.
- `http://localhost:8190/engagement` - the Inbox section shows the other member's card for that
  piece (switch the active user in the top-right menu to see it), with the expected actions as
  badges and the karma badge in the top bar. "I did this" records it and the card disappears;
  "Not this one" dismisses it.
- `http://localhost:8190/engagement/replies` - the tactical inbox. Empty until `data` has pulled
  a `github-engagement` / `hackernews` / `reddit-engagement` snapshot or the events spine has a
  response-needed row; empty is a correct answer on a fresh Box. Open an item, save a draft, come
  back - it is still there.
- `http://localhost:8190/engagement/karma` - the leaderboards, once one engagement is verified.
- Open a published piece in `content` - the **Engagement** panel is rendered there by this
  feature's `content.piece.panel` slot contribution.

Agent-side:

```bash
pnpm cli pods-overview                 # pods, members, content, engagements, cards, karma
pnpm cli pod-upsert                    # and pod-member-add / pod-content-add
pnpm cli pod-engagement-record         # attest one
pnpm cli pod-engagement-draft          # what /engage writes
pnpm cli pod-engagement-verify         # the real check; streams progress, lands in automation_runs
pnpm cli inbox-draft-save              # what /draft-reply writes
pnpm cli InboxSetDone                  # mark an inbox item done/snoozed/open
```

`pod-engagement-verify` also appears in the Automation view's action catalog (group
`Engagement`), and every run lands in `automation_runs` like any other op.

## 4. Remove

**There is no removal command.** This code is yours: delete the directories, then check that
nothing else in your Box still imports `engagement` and prune the npm packages
`features/engagement/deps.json` declares that no remaining feature needs.


```bash
rm -rf packages/core/src/features/engagement apps/server/src/features/engagement \
       apps/web/src/features/engagement
pnpm features && pnpm verify
```

**`alerts` must go too** - it imports `inboxDeepLink`/`dashboardUrl` from
`engagement/inbox/inbox-map.ts` and declares `engagement` in `dependsOn`; and removing `alerts`
takes `notifications` (chat + alerts) with it. `pnpm features --check`
names each one. The six tables stay in the warehouse, unread; `config/pods.json` and
`_evidence/engagement/` are left on disk.

## Gotchas

- **No `pods.json`, no cards.** A channel absent from `channels` expects nothing, so the piece
  produces no card at all, silently. Same for a paused/archived pod and for a piece older than
  `windowDays`.
- **Cards are derived, engagements are stored.** The only way to change the queue is to write a
  `pod_engagements` row (or move the piece/member/config). A `draft` row is the exception: it does
  NOT clear the card, it hangs the member's pre-written comment on it.
- **A draft must never downgrade a verified row.** `podsEngagementDraft` refuses when a `verified`
  engagement already exists, and an empty draft only ever deletes a `draft` row. If you add a
  write path, keep both guards - the rows carry karma and evidence.
- **Ambiguity is `unknown`, never `confirmed`.** A false positive corrupts the karma ledger
  permanently; a false negative costs one more click. Any new strategy inherits that rule.
- **The browser strategies need a real, logged-in session** on a machine running chromatrix. An
  unreachable browser is an `unknown` verdict with a message, not an exception - do not "fix" that
  by throwing.
- **Two identities on one screen.** The topbar karma badge is principal-scoped
  (`podsSelfKarma`); the engage-queue follows the ACTIVE user from the top-right menu. They
  legitimately disagree while impersonating.
- **`PodsSelfController` takes identity from the request principal only.** Never accept a
  participant id from the client on a `self/*` route.
- **Inbox item ids are the contract.** `inbox-map.ts` must keep minting the same ids as the
  snapshot path in `build.ts`, or one engagement becomes two items with two state rows and an
  alert card's deep link lands on nothing.
- **`index.tsx` sits on the web feature-registry import cycle.** Never read a registry binding at
  module scope there, and load the app in a browser after touching it (`CLAUDE.md`).
- After a controller change, boot once (or `pnpm typegen`) so `appRouter.d.ts` is rewritten, or
  the web typecheck is stale against the 23 procedures.
