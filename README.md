# Silkweave Box apps

The reference apps for [Silkweave Box](https://github.com/silkweave/box), and the registry index
that `box adopt` reads.

**If you want an app, you do not need this repository.** From your own Box:

```bash
box adopt crm
```

That fetches the app's four directories byte-exact from a tag here and copies them into your Box.
After that **the code is yours**. There is no update command and no merge path back: you customise
it, rename it, delete the half you do not want. When a newer version ships, the app's
`features/<id>/CHANGELOG.md` is what an agent reads to apply what still makes sense to the code you
now have.

## What is here

| | |
|---|---|
| `registry.json` | the published index: id, version, tag, core range, dependencies |
| `features/<id>/` | each app's SPEC, AGENT recipe, changelog, compatibility and npm declarations |
| `packages/core`, `apps/server`, `apps/web` | each app's three source trees |
| `box/` | the foundation, as a pinned git submodule. Canonical in `silkweave/box`. |

Ten apps: alerts, automation, chat, content, crm, data, engagement, notifications, planning, sink.

## Working on the apps

```bash
git clone --recurse-submodules https://github.com/silkweave/box-apps.git
cd box-apps && pnpm install && pnpm build && pnpm verify
```

Read [AGENTS.md](AGENTS.md) before editing anything. The one thing to know up front: this root is
the git truth for the apps, `box/` is the only tree that builds, and the app directories are
mirrored into it read-only. Edit the truth, never the mirror.
