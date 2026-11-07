# ADR-0022: The hook channel is a manifest field, `"hooks": "plugin"`, not an install group

**Status:** Proposed
**Date:** 2026-10-26
**Issue:** #1603

## Context

Sequant's guard hooks reach a checkout two ways. `sequant init` writes `.claude/hooks/*.sh` and registers them in `.claude/settings.json`. The plugin ships the same scripts in `hooks/hooks.json`. Claude Code runs both, so with both present every tool call runs `pre-tool.sh` twice, which costs 70–120 ms before the call and about 40 ms after it (graph-2026-10-ergonomics §3). Nothing arbitrated. `doctor` looked only for `.claude/hooks`, and `init` never read `enabledPlugins`.

`init` now leaves the repo channel out when an enabled plugin ships the hooks. `update` and `sync` must then keep it out, and `doctor` must treat the absent files as expected. That needs a record of the choice that all three can read.

## Decision

`.sequant-manifest.json` gains an optional `"hooks": "plugin"`. `init` writes it when `detectHookChannels` (`src/lib/hook-channels.ts`) finds an enabled plugin whose resolved install path has a `hooks/hooks.json` that registers `pre-tool.sh`. Without the field, the install has the repo channel, as every earlier manifest does.

Every consumer filters with one predicate, `isHookChannelPath` (`.claude/hooks/**` and `.claude/settings.json`), through `withoutHookChannel`. `update` filters its apply set. `sync` filters its drift scan, its dry-run, its version-current report and its apply preview, and it passes `skipHooks` to `copyTemplates`. `doctor` reports `Hooks` and `Settings` as `pass` when the field is set and both are absent. The new `Hook channels` check fails when both channels are active, whatever the manifest says.

`init --agent opencode` and `init --agent codex` always get the repo channel, because their wrappers run `.claude/hooks/pre-tool.sh`.

## Options

### Option A: A manifest field next to `groups` (chosen)

**Pros:** a full install stays a full install, so `update` still runs on it. The field says why the files are absent, and `doctor` can say so. **Cons:** a second install-scope concept beside `groups`.

### Option B: A `"hooks"` install group in `groups`

**Cons:** any `groups` array marks the install partial, and `update` refuses every partial scope (#1482, ADR-0015). Users with the plugin would lose `update`. The `sync --only` vocabulary would also need a group it cannot install alone.

### Option C: No record; re-detect the plugin on every `update` and `sync`

**Cons:** the result changes with the machine and with `enabledPlugins`. A teammate without the plugin would get hooks added to a checkout that deliberately left them out, and drift would flip between runs.

## Trade-offs

The field records a choice made at `init` time. A user who later disables the plugin keeps a checkout with no hooks until they run `sequant init --force`. `doctor` then reports `Hook channels` as `No sequant hooks registered`, so the state is visible. We accept that, because a field that tracked the plugin live is Option C.

## Consequences

- Easier: `update` and `sync` keep a plugin-channel install as `init` wrote it, and the drift scan no longer reports the absent hook files.
- Easier: `doctor` names both sources and both fixes when the channels overlap.
- Harder: a hand-edited manifest can say `"plugin"` while the repo still has hooks. The `Hook channels` check reads the files, not the field, so it still fails in that state.
