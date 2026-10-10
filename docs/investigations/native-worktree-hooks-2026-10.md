# Native worktree hooks — can `WorktreeCreate` / `WorktreeRemove` replace `worktree-isolation.ts`?

**Issue:** [#1192](https://github.com/sequant-io/sequant/issues/1192) · **Date:** 2026-10-10 · **Claude Code:** `2.1.296 (Claude Code)` · **Status:** concluded — **partial**
**Prior evaluations:** #485 (closed — built `worktree-isolation.ts` before these hook events existed), #632 (closed — deferred native isolation, citing upstream anthropics/claude-code#47548)

## Summary

Three headless probe runs against a throwaway repo, each spawning `isolation: "worktree"` subagents.

| # | Question | Result |
|---|----------|--------|
| P1 | What does the `WorktreeCreate` payload carry? | `session_id`, `transcript_path`, `cwd`, `prompt_id`, `hook_event_name`, `name`. `name` is `agent-<agentId>`. No issue number, no agent index, no base ref. |
| P2 | Does the hook replace creation or run alongside it? | **Replaces.** Claude ran the subagent in the exact path the hook printed on stdout. No second worktree was created. |
| P3 | Does the parent's branch move (the #47548 regression)? Which ref is the worktree based on? | **Parent did not move** (stayed on `feature/42-probe` in all three runs). Both native and hook-created worktrees were based on the parent's **current branch HEAD**, not `main`. |
| P4 | Native location and branch name with no hook? | `<repo>/.claude/worktrees/agent-<agentId>`, branch `worktree-agent-<agentId>`. |
| P5 | When does `WorktreeRemove` fire? | **It never fired** in any of the three `-p` runs — not for a changed worktree, not for an unchanged one, with or without a `WorktreeCreate` hook. |
| P6 | What does the subagent result return for merge-back? | A `worktreePath: <path>` line in the Agent tool result. The branch is not in the result; it is only visible via `git`. Nothing is merged. |
| P7 | Is `.worktreeinclude` honoured natively? | **Yes** — `.env` and `.extra-local` (both gitignored, both listed) were present in the native worktree. `node_modules` was **not** present. |
| — | Native cleanup of an unchanged worktree | **Yes without a hook** (worktree and branch deleted). **No with a hook** (the hook-created worktree and branch were left behind). |

---

## Probe method

Environment: `claude --version` → `2.1.296 (Claude Code)`. Parent model `haiku` (`--model haiku`), `--dangerously-skip-permissions`, `--output-format json`, wrapped in `perl -e 'alarm shift; exec @ARGV' 300` (foreground, 300 s cap). Every `SEQUANT_*`, `CLAUDECODE` and `CLAUDE_PROJECT_DIR` variable was unset for the nested run. Total spend across the three runs: ≈ $0.04.

Fixture (in a `mktemp -d` directory, deleted afterwards):

- `main` with one commit; branch `feature/42-probe` checked out with two more commits, so the base ref differs from the default branch.
- `node_modules/fake/index.js` (gitignored), untracked `.env` and `.extra-local` (gitignored), and a committed `.worktreeinclude` listing `.env` and `.extra-local`.
- `.claude/settings.json` registering:
  - `WorktreeCreate` → a script that appends its stdin to a log, then does what `createSubWorktree` does: `git worktree add <cwd>/.exec-agents/<name> -b exec-agent-42-<name>`, symlinks `node_modules`, copies every `.worktreeinclude` entry, and prints the path.
  - `WorktreeRemove` → a script that appends its stdin to the same log.

| Run | Hooks registered | Subagents | Purpose |
|-----|------------------|-----------|---------|
| 1 | `WorktreeCreate` + `WorktreeRemove` | 1, commits a file | P1, P2, P3, P6 |
| 2 | `WorktreeRemove` only | 2: one commits, one changes nothing | P3, P4, P5, P7, native cleanup |
| 3 | `WorktreeCreate` + `WorktreeRemove` | 1, changes nothing | P5 with a hook; cleanup with a hook |

### Logged `WorktreeCreate` payload (run 1, redacted)

Placeholders: `<tmp>` for the temp directory, `<home>` for the user's home, `<session>` / `<prompt>` for ids.

```text
=== WorktreeCreate 14:22:39
{"session_id":"<session>","transcript_path":"<home>/.claude/projects/-private-tmp-<tmp>-repo/<session>.jsonl","cwd":"/private/tmp/<tmp>/repo","prompt_id":"<prompt>","hook_event_name":"WorktreeCreate","name":"agent-ac037031b655ecdeb"}
cwd=/tmp/<tmp>/repo
Preparing worktree (new branch 'exec-agent-42-agent-ac037031b655ecdeb')
HEAD is now at dba1a61 chore: ignore and include
created=/private/tmp/<tmp>/repo/.exec-agents/agent-ac037031b655ecdeb
```

Run 3 logged the same shape (`"name":"agent-a4860f714b02afc82"`). The `WorktreeRemove` log section stayed empty in all three runs.

### Run 1 — what Claude did with the hook's path

The subagent reported `pwd` = `<tmp>/repo/.exec-agents/agent-ac037031b655ecdeb`, branch `exec-agent-42-agent-ac037031b655ecdeb`, a symlinked `node_modules`, and both include files. The Agent tool result ended with:

```text
agentId: ac037031b655ecdeb (use SendMessage ...)
worktreePath: /private/tmp/<tmp>/repo/.exec-agents/agent-ac037031b655ecdeb
subagent_tokens: 33871, tool_uses: 2, duration_ms: 10757
```

`git` state afterwards:

```text
$ git branch --show-current
feature/42-probe
$ git log --oneline --all --graph
* 805cd4c chore: probe          <- subagent commit, on exec-agent-42-agent-ac037031b655ecdeb
* dba1a61 chore: ignore and include   <- feature/42-probe HEAD
* d277860 feat: feature commit
* fc5b9f8 chore: init
```

### Run 2 — native default, no `WorktreeCreate` hook

```text
$ git worktree list
<tmp>/repo                                            dba1a61 [feature/42-probe]
<tmp>/repo/.claude/worktrees/agent-a23e41d1dcb2255cb  3877912 [worktree-agent-a23e41d1dcb2255cb]
<tmp>/repo/.exec-agents/agent-ac037031b655ecdeb       805cd4c [exec-agent-42-agent-ac037031b655ecdeb]
```

- The committing subagent's worktree (`agent-a23e…`) was kept, with its branch, based on `dba1a61` (the feature HEAD).
- The no-change subagent ran in `.claude/worktrees/agent-a26d4cd28d493a74f` on `worktree-agent-a26d4cd28d493a74f`. Its `ls -la` showed `.env`, `.extra-local`, `.worktreeinclude` and **no** `node_modules`. After it returned, both its worktree and its branch were gone. `WorktreeRemove` did not log.

### Run 3 — hook-created worktree, no change

The subagent ran in `<tmp>/repo/.exec-agents/agent-a4860f714b02afc82`. After the run that worktree and branch `exec-agent-42-agent-a4860f714b02afc82` were **still present**, and `WorktreeRemove` did not log. With a `WorktreeCreate` hook registered, Claude does not clean up unchanged worktrees in headless mode.

**Not exercised:** interactive sessions. `WorktreeRemove` may fire at interactive session exit; every sequant phase is headless, so the headless result is the one that applies.

---

## Responsibility mapping

Source: `src/lib/worktree-isolation.ts`.

| # | Responsibility | Source | Native capability | Verdict |
|---|----------------|--------|-------------------|---------|
| R1 | Location `.exec-agents/agent-N/` inside the issue worktree | `createSubWorktree`, `SUB_WORKTREE_DIR` | Default: `.claude/worktrees/agent-<agentId>` inside the session's repo (run 2). A `WorktreeCreate` hook can put it anywhere (run 1). | **Covered** (different path; any path is fine for sequant) |
| R2 | Branch `exec-agent-<issue>-<N>` | `agentBranchName` | Default: `worktree-agent-<agentId>`. A hook can choose any name, but the payload has no issue number or index — the hook must derive the issue from `git -C <cwd> branch`. | **Partly covered** — name is opaque; no per-group index |
| R3 | Base ref is the issue branch HEAD, not the default branch | `createSubWorktree` (`worktree add -b` from the issue worktree) | Both default and hook-created worktrees were based on the parent's current HEAD (`dba1a61`), and the parent's branch did not move. Under `sequant run` the phase's cwd is the issue worktree, so this is the issue branch HEAD. | **Covered** — #47548 fix holds on 2.1.296 |
| R4 | `node_modules` symlinked from the issue worktree | `createSubWorktree` | Not done natively (run 2: no `node_modules`). Only a `WorktreeCreate` hook can add it — and a hook costs native cleanup (run 3). | **Not covered** natively |
| R5 | Env/settings files copied via `.worktreeinclude`, or the defaults | `getIncludeFiles` | `.worktreeinclude` honoured natively (run 2). The no-file fallback list (`.env`, `.env.local`, `.env.development`, `.claude/settings.local.json`) was **not probed** — every run had a `.worktreeinclude`. | **Covered** for `.worktreeinclude`; fallback list **untested** (treat as not covered) |
| R6 | Merge-back with `--no-ff`, conflict detection, `merge --abort` | `mergeBackSubWorktree`, `mergeAllSubWorktrees` | None. The Agent tool returns `worktreePath` and leaves the commits on the branch (runs 1, 2). | **Not covered** |
| R7 | Remove the worktree and delete its branch | `cleanupSubWorktree` | Only for **unchanged** worktrees and only **without** a `WorktreeCreate` hook (run 2 vs run 3). Changed worktrees — the ones a parallel group produces — are always kept. `WorktreeRemove` never fired headless. | **Not covered** for the case sequant needs |
| R8 | Orphan sweep after interrupted sessions (`worktree prune`, `exec-agent-*`) | `cleanupOrphanedSubWorktrees` | None. Kept worktrees from runs 1–3 survived session end. | **Not covered** |
| R9 | Merge result reporting | `formatMergeResult` | None (no merge happens). | **Not covered** |

**Net:** native isolation covers creation (R1, R3, R5 when a `.worktreeinclude` exists) and gives something sequant cannot get today — the harness, not the prompt, sets the subagent's working directory. It covers none of the back half (R6–R9), and R4 is only reachable through a hook that breaks native cleanup.

### Consumers (named, not edited)

- `scripts/worktree-isolation.ts` — the CLI wrapper exec calls. `merge-all` discovers work by `git branch --list exec-agent-*` and assumes `.exec-agents/agent-<i>` paths; native branches (`worktree-agent-*`) would not be found.
- `/exec` SKILL step **1b** (create sub-worktrees) and step **5b** (merge-all, then cleanup).
- `docs/reference/worktree-isolation.md` (plus `docs/concepts/` and `docs/features/` pages of the same name).
- `src/lib/worktree-isolation.test.ts`.
- Setting `agents.isolateParallel` (default `false`, `src/lib/settings.ts`) and the `--isolate-parallel` flag.

### Upstream #43869 (subagent model routing)

`gh issue view 43869 --repo anthropics/claude-code` on 2026-10-10: `OPEN`, updated 2026-09-15. It is **not** an isolation blocker. It affects every `sequant-implementer` spawn — isolated or not — because the `model` parameter resolves to the parent model either way. Adopting native isolation neither fixes nor worsens it.

---

## P5 re-probe (runner, 2026-10-10)

The original P5 logs were in the deleted `mktemp` fixture, so the runner re-ran the probe to leave a record. Claude Code `2.1.296`, parent `--model haiku`, headless `-p`, 280 s cap, about $0.015. The fixture had one committed file and a `.claude/settings.json` registering `WorktreeRemove`, `SubagentStop` and `SessionEnd` hooks, each appending its stdin to its own log. There was no `WorktreeCreate` hook. The prompt spawned two `isolation: "worktree"` subagents, one that changed `a.txt` and one that only ran `ls`.

| Hook | Firings |
|---|---|
| `WorktreeRemove` | **0** |
| `SubagentStop` | 2 |
| `SessionEnd` | 1 |

After the run, `git worktree list` showed only the changed agent's worktree (`.claude/worktrees/agent-<id>`, branch `worktree-agent-<id>`, `M a.txt`). The unchanged one had been removed natively, without `WorktreeRemove` firing. That matches P5 and the native-cleanup row above.

## Decision

**Partial.** On Claude Code 2.1.296, native `isolation: "worktree"` is safe to use for *creation* of parallel-group sub-worktrees, and `worktree-isolation.ts` stays as the owner of *merge-back, cleanup and reporting*:

- Use native creation **with no `WorktreeCreate` hook** (R1, R3, R5 via `.worktreeinclude`, plus harness-enforced cwd).
- Keep R6–R9 in `worktree-isolation.ts`, retargeted from `exec-agent-*` discovery to the `worktreePath` values the Agent tool returns (and `worktree-agent-*` branches).
- R4 (`node_modules`) needs a non-hook answer, e.g. the merge-back caller symlinks it into each returned path before tests run, or agents in a parallel group don't run the suite.

**Upstream #47548 on the day** — `gh issue view 47548 --repo anthropics/claude-code --json state,closedAt,updatedAt`, run 2026-10-10T14:19:45Z:

```json
{"closedAt":"2026-06-12T11:24:48Z","state":"CLOSED","updatedAt":"2026-08-14T14:24:28Z"}
```

Closed, and the probe confirms the fix holds: the parent's branch never moved in three runs (P3).

### Rejected alternatives

| Alternative | Why rejected |
|-------------|--------------|
| **Adopt** — replace `worktree-isolation.ts` with native isolation plus hooks | Merge-back, conflict handling, orphan sweep and reporting (R6–R9) have no native counterpart, and `WorktreeRemove` never fired headless, so there is nothing to hang cleanup on. |
| **Ship a `WorktreeCreate` hook** to recover R1/R2/R4 exactly | The hook *replaces* creation for every `isolation: "worktree"` spawn in the project, not just sequant's (P2), so it would change behaviour for users' own subagents. Run 3 also shows it disables native cleanup of unchanged worktrees, so it trades one gap (R4) for a leak. And it would land in `plugin/` hooks, which the plugin freeze forbids today. |
| **Keep** — no change at all | The #47548 blocker that #632 cited is closed and the fix holds; base-ref and `.worktreeinclude` behaviour match sequant's needs. Keeping prompt-only cwd enforcement leaves a gain on the table that the probe shows is now available. |
| **Answer from upstream docs, no probe** | #485 already evaluated on paper; the replace-vs-alongside question (P2) and the cleanup behaviour (P5, run 3) were only settled by running it. |

### Follow-up issue (filed as #1407)

> **feat(exec): create parallel-group sub-worktrees with native `isolation: "worktree"`; keep merge-back in `worktree-isolation.ts`**
>
> Per `docs/investigations/native-worktree-hooks-2026-10.md` (#1192): on Claude Code ≥ 2.1.296, spawn `isolateParallel` agents with the Agent tool's `isolation: "worktree"` and no `WorktreeCreate` hook. Retarget `scripts/worktree-isolation.ts merge-all` / `cleanup` from `exec-agent-*` discovery to the returned `worktreePath` values and `worktree-agent-*` branches; add a `node_modules` symlink step for each returned path. Touches `/exec` SKILL steps 1b/5b, so it waits for the plugin freeze to lift.
