# ADR-0006: Ship a slim `plugin/` folder as the marketplace source

**Status:** Accepted
**Date:** 2026-10-01
**Issue:** #1265

## Context

`.claude-plugin/marketplace.json` declared the plugin's `source` as `"./"` — the
whole dev repository — since the first plugin commit (#185), confirmed on
layout grounds by #476, and kept by #988 without weighing install size.
Claude Code runs a dependency install whenever the plugin root has both a
`package.json` and a supported lockfile, as `npm ci --ignore-scripts`
including dev dependencies, and there is no setting or environment variable
to disable it. A fresh 2.18.0 install measured 703 MB of `node_modules`; a
long-time user's cache held 638 MB plus 688 MB across two versions. Nothing
the plugin runs reads any of it: the hooks are shell, the MCP server arrives
through a pinned `npx sequant@<version>` (#1084), and no file under
`skills/`, `hooks/` or `.mcp.json` references `node_modules`, `dist/`,
`scripts/`, `bin/` or `package.json`.

The repo-root layout also fails the directory review's pre-submission
checklist: 1,079 files against a 512 limit, 6 non-image files over 256 KiB,
a lockfile-triggered dependency install, and 4 tracked symlinks.

Upstream offers no escape hatch: no exclude/ignore field in the marketplace
schema, `git-subdir` is for a different repository, `sparsePaths` only trims
the user's marketplace clone, and moving `package.json` out of the root would
break the CLI (`npm install -g sequant` / `npx sequant` need it there).

Shipped content had also drifted from its sources: root `hooks/` is a
hand-maintained copy `scripts/sync-hooks.sh` never covered, already missing
`templates/hooks/post-tool.sh`'s relay-check and coverage blocks, and root
`memory/constitution.md` — this repo's own constitution, copied into user
projects by `/sequant:setup` — differed from `templates/memory/constitution.md`
by the #1250 producer-parity row.

## Decision

`marketplace.json`'s `source` becomes `"./plugin"`: a committed folder holding
`.claude-plugin/plugin.json`, `skills/`, `hooks/` (with `hooks.json`),
`.mcp.json`, `memory/constitution.md`, `README.md` and `LICENSE` — and no
`package.json`, so Claude Code's install-detection never triggers. The
install id (`sequant@sequant`) is unchanged, so existing users upgrade in
place. `plugin/hooks/` and `plugin/skills/` are generated, not hand-copied:
`scripts/sync-hooks.sh` and `scripts/check-skill-sync.ts --fix` write them
from `templates/hooks/` and `templates/skills/` (root `skills/` already
matched `templates/skills/` exactly), and a drift test in
`src/lib/relay/__tests__/hook-sync.test.ts` fails CI if `plugin/hooks/`
diverges. `plugin/memory/constitution.md` is a copy of
`templates/memory/constitution.md`, which first gained the missing
producer-parity row so the shipped copy and this repo's own
`memory/constitution.md` agree. `plugin/.mcp.json` and
`plugin/.claude-plugin/plugin.json` are copies of the root files; root
`.mcp.json` stays as this repo's own project MCP config, and release tooling
(`scripts/release.sh`, `scripts/prepare-marketplace.ts`'s already-dynamic
`shippedMcpJsonPath()`) now stamps both the root and `plugin/` copies.

Root `hooks/`, `skills/`, `.claude-plugin/plugin.json` and `.mcp.json` are
left in place and retired in a follow-up PR, so this change's revert path
stays a one-line edit to `marketplace.json`.

## Options

### Option A: Point `source` at a committed `plugin/` subfolder (chosen)

**Pros:** no `package.json` in the installed tree, so the automatic
dependency install never fires; passes the file-count and file-size limits;
a relative same-repo path, which the marketplace schema already supports;
install id unchanged. **Cons:** a second generated copy of `hooks/`,
`skills/` and `memory/constitution.md` to keep in sync — mitigated by making
`templates/` the one producer and gating both mirrors with drift tests, per
the constitution's one-producer-per-artifact rule (#1250).

### Option B: Point `source` at `scripts/prepare-marketplace.ts`'s existing
`dist/marketplace/external_plugins/sequant/` output

**Pros:** reuses an existing build step. **Cons:** that output has no
`hooks.json` (no hooks would register when loaded as a plugin), no
`memory/` folder, and a flat `.mcp.json` shape — it was built for the
official Anthropic marketplace submission format, not as an installable
plugin tree. Using it as `source` would need a rebuild of the script in
addition to the layout change, with no size or review-limit benefit over
Option A.

### Option C: Split the plugin into a separate repository

**Pros:** truly minimal content, no retired-but-present root copies.
**Cons:** two repositories to keep in sync for every skill/hook change,
a second CI surface, and a second release process; the `source` field
already supports a same-repo relative path, so the split buys nothing this
issue needs. Rejected as disproportionate — revisit only if `plugin/`
itself grows past the review limits.

### Option D: Keep `source: "./"` and ask Anthropic for an exclude field

**Pros:** no local change. **Cons:** no such field exists today (verified
against the marketplace reference and loading docs), and shipping the
700 MB install in the meantime fails every install and the directory
review. Rejected: waits on an upstream feature with no committed timeline.

## Trade-offs

Option A accepts a second producer for `hooks/`, `skills/` and
`memory/constitution.md` content (three now: `.claude/skills` canonical,
`templates/` and `skills/` mirrors, now joined by `plugin/`). Every mirror
is regenerated by the same scripts that already existed
(`sync-hooks.sh`, `check-skill-sync.ts`) and is drift-tested, so the
constitution's "second producer needs a parity test" bar is met rather than
waived. Root `hooks/`/`skills/`/`.claude-plugin/plugin.json`/`.mcp.json`
stay un-retired for one more PR, trading a short-lived fourth copy of some
content for a one-line revert if `plugin/` turns up a problem the directory
review catches that this PR did not.

## Consequences

- Every plugin install and update drops from ~700 MB of `node_modules` to
  whatever `plugin/` itself weighs (tens of KB of skills and hook scripts);
  measured locally, a full install's `CLAUDE_CONFIG_DIR` came to about 1 MB.
- `plugin/` passes the pre-submission checklist's file-count and file-size
  limits, clearing the way for directory resubmission (tracked separately as
  an owner checklist item, not part of this PR).
- A future edit to a hook, skill, or the constitution must land in
  `templates/` and run the sync scripts (or CI's drift tests fail); editing
  `plugin/hooks/*.sh` or `plugin/skills/**` directly is not supported.
- The directory validator's expected "Scripts the validator couldn't follow"
  and "MCP server command wasn't read" policy holds (from the `${CLAUDE_PLUGIN_ROOT}`
  subfolder shape and the inline `node -e` MCP launcher) are unchanged by
  this move — they are reviewer-read holds, not rejections, and out of this
  issue's scope to redesign away.
