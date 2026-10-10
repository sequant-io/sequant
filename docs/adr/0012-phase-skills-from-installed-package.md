# ADR-0012: Phase agents load skills from the installed package; committed skills become an override

**Status:** Proposed
**Date:** 2026-10-10
**Issue:** #1388

## Context

The Claude Code driver starts phase agents with `settingSources: ["project"]` (`src/lib/workflow/drivers/claude-code.ts`), so a phase agent sees only the project's `.claude/skills/`. Phase worktrees are checked out from git, so those skills must be committed. A first `sequant init` asks a newcomer to commit about 23,000 lines, 20,686 of them skill text (#1387's smoke test). Every adopting project carries its own copy, which drifts until the next `sequant sync`, and removing untracked files deletes skills that were never committed.

The npm package already ships `plugin/` (`package.json` `files`). The Agent SDK's `query()` takes `plugins: [{ type: "local", path }]`. #1388's spike measured what happens when a phase agent gets the package's `plugin/` through that option. The evidence is in the #1388 issue comments. The setup was SDK 0.3.289 and Claude Code 2.1.289, running a spec phase in a repo with no `.claude/skills/`:

1. **Skills load.** `settingSources: ["project"]` does not filter a plugin passed programmatically. The agent called `Skill("sequant:spec")` from the plugin path, posted a spec comment with `SEQUANT_PHASE` and `SEQUANT_SPEC` markers, and the orchestrator's #1193 marker check passed.
2. **The plugin's hooks come too, and they stack.** Plugin `SessionStart` and `PreToolUse` hooks fired. In a repo whose `.claude/settings.json` also registers a `PreToolUse` hook, both fired on every tool call. Every project that has run `sequant init` registers sequant's own hooks, so passing the whole plugin would run `pre-tool.sh` and `post-tool.sh` twice per call.
3. **The plugin's MCP server starts.** `plugin:sequant:sequant` connected, launched from `plugin/.mcp.json`. That server is outside `getPhaseMcpServersConfig`, so the #936 phase-MCP allowlist never sees it.
4. **Skills are namespaced.** Only `sequant:spec` and the other `sequant:*` names exist. The phase prompts (`phase-registry.ts`), `assess-comment-parser.ts` (which matches the substring `"/spec"`), and the skill text (7 bare `Skill()` calls in `fullsolve`, 514 bare `/<skill>` mentions) all use bare names. The plugin-only agent also lists Claude Code built-ins named `verify` and `loop`, so a bare `/verify` or `/loop` would go to the built-in (the #562 class).

## Decision

The Claude Code driver loads phase skills from the installed package by default. It passes a **skills-only** plugin view (a `.claude-plugin/plugin.json` named `sequant` plus the package's `plugin/skills/`, with no hooks and no `.mcp.json`) and invokes skills as `sequant:<name>`. A project that tracks `.claude/skills/<skill>/SKILL.md` keeps today's behaviour for that skill: bare name, committed copy. This is #1388's option (a), using a skills-only plugin view rather than the whole `plugin/`.

## Options

### Option (a): Package by default, committed skills as an opt-in override (chosen)

Skills come from the package unless the project commits its own copy of that skill. **Pros:** a new project commits only the manifest. Existing projects keep working unchanged. A fork of one skill stays possible, alongside `.claude/.local/skills/<name>/overrides.md` for small tailoring. **Cons:** two sources to explain. `doctor` has to report which one each phase uses.

### Option (a′): The same, but pass the whole `plugin/` directory (rejected)

Pass `node_modules/sequant/plugin` as is. **Pros:** smallest code change, and the spike proved it works. **Cons:** hooks double-fire in every initialized project (finding 2), and the MCP server bypasses #936 (finding 3).

### Option (b): Keep the commit model (rejected)

**Pros:** no change. **Cons:** the 23,000-line first commit, per-project drift, and the uncommitted-skills failure class (#933, #1193, #1201) all stay. The override file already covers the main reason to commit skills.

### Option (c): Hybrid (folded into (a))

#1388 listed a hybrid as a separate option. Here, the per-skill override already is the hybrid: a project can commit some skills and take the rest from the package. A separate mode adds nothing.

## Trade-offs

Option (a) keeps (a′)'s one real gain, no committed skill text, and drops the hooks and MCP server that make (a′) unsafe in projects initialized today. The cost is a resolution rule, "committed copy wins, per skill", and namespaced invocations in the paths that don't use a committed copy.

## Guards this retires or narrows

Since #813, every guard against missing or stale committed skills has patched a symptom of `settingSources: ["project"]`. Under option (a), each one changes like this:

| Guard | Added by | Under option (a) |
|---|---|---|
| Skills pre-flight (`runSkillsPreflight`), including its worktree and main-checkout coverage | #813, #933, #1193 | **Narrow:** for the Claude Code driver, fail only when a phase skill is neither committed nor present in the package's `plugin/skills/`. Keep it unchanged for drivers that still need committed skills (Codex, opencode). |
| Missing-skills remedy text | #1201 | **Rewrite:** the remedy becomes "update the sequant package", not "commit or sync `.claude/skills/`". |
| Spec-marker check (a spec without `SEQUANT_SPEC` fails) | #1193 | **Keep.** It checks that the skill ran, whatever its source, and it is what confirmed this spike. |
| Uncommitted-skill-changes warning (`src/lib/skills-commit-state.ts`) in run, doctor, sync, update | #1354 | **Narrow** to skills the project commits. Dead for package-sourced skills. |
| `doctor` "Skills Committed" check (warns on untracked skills) | #1257 | **Replace** with "skill source per phase" (package or committed), plus the identical-copy notice under Consequences. |
| Minimal-install path | #1209 | **Becomes the default.** `init` stops writing `.claude/skills/` once the skill text is namespaced (after the freeze). |

The follow-ups that land option (a) remove or narrow these guards in the same PRs. Nothing should be left checking for a commit that is no longer required.

## Consequences

- **Easier:** a newcomer's first commit is the manifest and config. A skill fix reaches every project with the package version, without `sequant sync`.
- **Harder:** two invocation forms (`sequant:spec` from the package, `/spec` from a committed copy). Prompts, the assess parser and doctor must handle both.
- **Migration for existing projects:** nothing changes until a project deletes its committed `.claude/skills/<skill>/`. From then on, that skill comes from the package. `sequant doctor` reports the source of each phase skill and flags a committed copy that matches the package byte for byte, since that copy can be deleted.
- **Not yet verified:** that a skills-only view works. It would be a generated directory whose `skills/` points at the package's `plugin/skills/` (a symlink or a copy). The spike passed the whole `plugin/` folder. The first follow-up must re-run the spike with the skills-only view and confirm that no plugin hooks or MCP server appear in the phase agent's init message.
- **Waits for the plugin freeze:** namespacing the skill text (`fullsolve`'s `Skill()` calls and the bare `/<skill>` chains) edits `plugin/`, `.claude/skills/` and `templates/skills/`. The `src/` changes (driver option, prompts, assess parser, doctor) can land first behind the per-skill rule, because a project with committed skills sees no change.
- **Other drivers:** Codex and opencode resolve skills differently and are out of scope here. Each needs its own check before it can drop committed skills.
- **Revisit** if the SDK starts filtering programmatic plugins by `settingSources`, or adds a way to load a plugin's skills without its hooks.
