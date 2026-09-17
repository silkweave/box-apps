# `sink` - the inbox of markdown notes

A filesystem queue. Anything that arrives as prose and is not yet tracked state - a chat export, a
research dump, a raw post idea - lands as a flat markdown file under `<BOX_DATA_DIR>/docs/sink/`.
The dashboard lists the queue, edits a file inline with autosave, and hands an agent the one command
that processes it. **It owns no warehouse table**: the files on disk are the state.

- **dependsOn**: nothing. The smallest feature in the Box, and the reference for "a feature that is
  only a view over something core already has" (`docsDir()` from `io.ts`).
- **Removal**: `rm -rf` the three directories. Nothing depends on it; the files under `docs/sink/`
  survive untouched, because the feature never owned them - it read them.

## Tables

None. `models: []`, `migrations: []`.

## Files on disk

`<BOX_DATA_DIR>/docs/sink/*.md`, top level only. The queue is every `*.md` except `README.md` and
any `_`-prefixed name, newest first by mtime - so `_done/` is an archive folder, not a queue entry.
A filename must match `^[a-z0-9][a-z0-9._-]*\.md$` and every path is re-resolved and proven to sit
inside `docs/sink/` before it is touched (`packages/core/src/features/sink/state.ts`, the same
traversal guard as `planning/docs.ts`).

## Procedures and tools

`SinkController` (`@Controller('sink')`, class-level `@UseGuards(AuthGuard)`):

| tRPC | MCP | what |
|---|---|---|
| `sinkDocs` (query) | - | the queue: name, path, bytes, modified, a flattened 180-char excerpt |
| `sinkDoc` (mutation) | `sink-read` | one doc's body (`exists:false` + empty content when absent) |
| `sinkDocSave` (mutation) | `sink-save` | write a doc - the dashboard editor's autosave target |
| `sinkDocCreate` (mutation) | `sink-create` | add one; refuses to clobber an existing name |
| `sinkDocDelete` (mutation) | `sink-delete` | remove one, returning the fresh queue |

The reads are mutations on purpose: they take an input body, and an input-less query is the only
shape that reflects cleanly here (same call as the planning doc read).

## Actions

None. The sink contributes nothing to core's run funnel - there is nothing to schedule.

## UI

- **Routes**: `/sink` (the queue as a card grid) and `/sink/$file` (the same view, editing that
  file). One stateful view reading the `$file` param; the child route only registers the segment.
- **Nav**: one entry, `Sink`, icon `FolderInput`, order band **700**.
- **Settings / shell / slots**: none.
- The editor is `@silkweave/box-ui`'s markdown editor behind a lazy chunk
  (`components/SinkBodyEditorLazy.tsx`) - TipTap is large and the queue view does not need it.

## Env

None.

## What a team customises

Very little, which is the point. The realistic edits are the nav `label` and `order`, and what the
detail view's "Copy" button puts on the clipboard: today `/ingest-sink <name>`, the skill that
routes a note into tracked state. That skill ships with **`content`**
(`features/content/skills/ingest-sink/`), not here - it writes initiatives and pieces, which are
planning's and content's tables. A Box with `sink` but not `content` gets the queue and the editor,
and the copy button points at a command nobody installed: change the string.
