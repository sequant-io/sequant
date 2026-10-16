# graph-2026-10-consolidation — founding document

Planned 2026-10-16 from the accretion audit, amended the same day after four research passes (kill helper, worktree status, non-goals parser, remaining audit findings) whose load-bearing claims the runner re-verified against the code (`~/Projects/accretion-audit`, README P0.1; live ledger `~/.accretion/sequant/ledger.jsonl`). Observed state: `main` at `ad71b341`. Filed 2026-10-16: tracker #1470, nodes #1471 (C-1), #1472 (C-2), #1473 (C-3), #1474 (C-4), #1475 (C-5); the race bug R-1 is #1469, outside the graph.

## §1 Vision

Twenty definitions are duplicated across two or more non-test `src/` files at HEAD (16 real, 4 noise by the Phase 0 hand labels). Each pair was written by an agent that did not search before writing, and in five cases the copies have since diverged: a bug fix landed in one copy and not the other. This graph removes the 16 real groups so that every helper has one definition, and leaves the four noise names to the detector's allowlist.

## §2 MVP (one sentence)

Five PRs that reduce every real duplicate group in the Phase 0 list to a single exported definition, with the behaviour differences between copies decided once and tested, and `accretion dups` on sequant HEAD reporting none of the 16 names afterwards.

Includes: the 16 names below, one shared home per cluster, tests for each shared helper, the divergence decisions (D-1, D-1b, D-2, D-3, D-7), and the detector allowlist for the four noise names (cross-repo, A-1).

## §3 Non-goals

| Not now | Why not |
|---|---|
| The AsyncSubprocess abstraction from `docs/internal/architecture-target.md` | #506 owns async I/O; this graph consolidates the kill helper, which is the clause's measurable part. D-4 records that the trigger's `fired` state ends with C-2, not with the abstraction. |
| The in-process MCP engine | #508, deferred by the owner. |
| The two execution layers (`run-orchestrator.ts`, `batch-executor.ts`) and `phase-executor.ts` responsibilities | Architecture work, not duplicate removal; no deferral clause names it; raise as its own investigation if the owner wants it. |
| The skill mirrors | Frozen; owned by ADR-0012 and #1397–#1400. |
| `formatElapsedTime` vs `formatDuration` | Different output contracts (`1m 5s` floors; `65.0s` keeps a decimal); not a duplicate. |
| Any edit under `plugin/`, `.claude/skills/`, `templates/skills/` | Plugin freeze (I-1). |
| New behaviour in any helper beyond the divergence decisions (D-1, D-1b, D-2, D-3, D-7) | Each node is a move-and-delete; a behaviour change needs its own issue. |

## §4 Architecture as observed (2026-10-16)

- Shared homes that already exist: `src/lib/fs.ts` (`ensureDir` and friends), `src/lib/cli-ui/format.ts` (`formatTimestamp(Date)`, `formatElapsedTime`), `src/ui/tui/truncate.ts` (`truncateToWidth`, exported), `src/lib/workflow/ring-buffer.ts` (`RingBuffer`), `src/lib/workflow/run-log-schema.ts` (`RunLog`, `LOG_PATHS`), `src/lib/locks/types.ts` (`SignalOtherResult`), `src/lib/markdown-fence.ts` (`stripFencedLines`, the #947 fix). No `src/lib/process*.ts` and no string-utility module exist.
- Byte-identical copies: `parseLogFile` ×3, `listLogFiles` ×2, `formatDuration` ×3 (`commands/logs.ts`, `commands/stats.ts`, `phase-executor.ts`), `escapeRegex` ×3, `killProcessGroup` in the two drivers, `pushLines` ×2.
- Same contract, different code: `resolveLogPath` ×3 and `resolveLogDir` ×2 (tilde-expand a custom path, else project log dir if it exists, else global; the MCP copies take no custom path), `formatTimestamp` (ISO string vs `Date`, same `hh:mm:ss`), `parseIssue` (identical except `exitCode` 1 vs 2), `formatSignalLine` (two-space indent and one shorter message in the orchestrator copy).
- Diverged copies (a fix reached one side only):
  - `parseNonGoals`: `scope/analyzer.ts` strips fenced code blocks (#947) and returns `NonGoals { items, found, warning }`; `ready-gate.ts` returns `string[]` and still parses fenced examples as real Non-Goals.
  - `isWorktreeDirty`: `worktree-manager.ts` returns `true` when `git status` fails (fail closed, preserves the worktree); `run-orchestrator.ts` returns `false` (fail open). #935 fixed the orchestrator path for signal shutdown.
  - `killProcessGroup`: the two drivers send SIGTERM to the group with a direct-signal fallback; `mcp/tools/run.ts` takes the child process, and escalates to SIGKILL after `SIGKILL_GRACE_MS` (#1222).
  - `ensureDir`: `lib/fs.ts` rethrows anything but EEXIST; `upstream/assessment.ts` swallows every error; `relay/writer.ts` is synchronous and takes a file path (it makes the parent).
  - `truncateToWidth`: TUI reserves one column for `…` and returns `…` at width 1; the assess renderer uses an `ELLIPSIS` constant and slices it at width ≤ 1.
- Prior fixes: `parseNonGoals` ×4 (#683, #817, #850, #947), `killProcessGroup` ×4 (#388, #435, #862, #497), `isWorktreeDirty` ×2 (#760, #935), `resolveLogDir` ×6. Every cluster is a class, so ACs state the outcome for every copy, not one call site.

## §5 Invariants

- I-1 Plugin freeze: `git diff --name-only origin/main...HEAD | grep -E '^(plugin|\.claude/skills|templates/skills)/'` prints nothing before any merge.
- I-2 Move and delete: a node ends with exactly one definition of each name in non-test `src/`; no copy is left behind as a wrapper unless an AC says so.
- I-3 Behaviour is decided, never averaged: where copies differ, the issue names the surviving behaviour (D-1, D-1b, D-2, D-3, D-7) and a test pins it; callers that relied on the other behaviour are listed in the PR.
- I-4 Evidence runs verbatim: every AC's `Evidence:` is a command the QA phase can run in the worktree; the accretion check runs against the real CLI on this machine.
- I-5 Nothing lands before PR #1370 and release 2.20.0 (owner's post-freeze queue); each PR's changelog entry follows whatever convention `main` has when it merges.

## §6 Per-node design

- **C-0 (#1470) (runner, docs):** this directory lands via a docs-only PR; the tracker issue carries the node table.
- **C-1 (#1471) log helpers (mechanical):** new `src/lib/run-logs.ts` exporting `resolveLogDir(customPath?)`, `listLogFiles(dir)`, `parseLogFile(path)`; `formatDuration` moves to `src/lib/cli-ui/format.ts` and `phase-executor.ts` imports it. Callers: `commands/logs.ts`, `commands/stats.ts`, `mcp/tools/logs.ts`, `mcp/tools/run.ts`, `merge-check/index.ts`, `phase-executor.ts`. Failure mode: the MCP copies never took a custom path, so passing `undefined` must keep their behaviour.
- **C-2 (#1472) process kill (judgment):** new `src/lib/process-group.ts` exporting one `killProcessGroup(child: ChildProcess, { graceMs }): { requested: boolean }`: group SIGTERM via `-child.pid` **first** (the driver mock tests at `codex.test.ts:474` and `opencode.test.ts:453` pin that order), ESRCH swallowed, direct `child.kill` on other errors, SIGKILL after `graceMs` unless `exitCode`/`signalCode` is already set, idempotent per child (the phase timeout at `phase-executor.ts:1672` and the driver timeout at `codex.ts:677` fire together), unref'd timer. Escalation history: added in #388 (5 s) and lengthened by #1222 to `DEFAULT_FORCE_EXIT_TIMEOUT_MS + 1000` because the MCP child is a `sequant run` with its own 10 s force-exit; the drivers' children (`codex`, `opencode`) have no such contract, so `graceMs` is required and per caller, `run.ts` keeps exporting `SIGKILL_GRACE_MS`, and the drivers get their own constant. Both evaluators infer "timeout" from `signal === "SIGTERM"` (`codex.ts:411`, `opencode.ts:452`); an escalated SIGKILL must still report as a timeout, so the helper's `requested` flag replaces the signal-string inference. `pushLines` becomes a `RingBuffer` method. `aider.ts` spawns without `detached` and must not adopt the helper (killing its group would kill the orchestrator's). The `architecture-target.md` row is **not** edited: the trigger's `source.quote` must stay byte-identical, and its `grep_count` matches definitions only, so one definition reads `not_fired`.
- **C-3 (#1473) small utilities (mechanical):** `ensureDir` → `lib/fs.ts` for both callers (`relay/writer.ts` calls it with `dirname(path)`; `upstream/assessment.ts` loses its swallowing copy, D-2; trap: `fs.ts` imports `fs/promises` while `assessment.test.ts:57` mocks `node:fs/promises`, which vitest treats as a different module, so the exec normalises one specifier or mocks both); `escapeRegex` → new `src/lib/regex.ts`; `formatTimestamp` → `cli-ui/format.ts` accepting `Date | string`; `parseIssue` → `src/lib/cli-flags.ts` as `parseIssueNumber(arg): number | null` (beside `parseWholeNumber`, which throws for commander and is a different contract) without setting `exitCode`; `truncateToWidth` → new `src/lib/cli-ui/truncate.ts`, imported by both the TUI and the assess renderer, so no `lib → ui` import (D-3).
- **C-4 (#1474) non-goals parser (judgment):** the **gate's** line scanner survives, not the analyzer's (D-7, reversed from the first draft after both parsers were run on 268 real issue bodies). One scanner in a neutral home (`src/lib/markdown-fence.ts` or a sibling `non-goals.ts`), fed the body through `stripFencedLines`; `ready-gate.ts` re-exports it as `parseNonGoals(body): string[]` so `ready.ts:273`, `batch-executor.ts:1041` and the mock at `ready-gate-run.test.ts:69` keep working; `scope/analyzer.ts` wraps it for `items`, computes `found` from a heading scan of the stripped body, keeps `NonGoals { items, found, warning }` for `verdict.ts` and `formatter.ts`, and drops its `!item.startsWith("#")` filter. Regression fixtures: #971 and #763 (heading with trailing text: analyzer finds nothing today), #1246 (an item beginning `#1297`: analyzer drops it today), #1228 (two Non-goals sections: analyzer reads the first only), plus the fenced example from `scope.test.ts:246` (gate returns it as a non-goal today).
- **C-5 (#1475) worktree status and signal lines (judgment):** `isWorktreeDirty` → one primitive `worktreeStatus(path): "clean" | "dirty" | "unknown"` in `worktree-manager.ts` (already imported by `run-orchestrator.ts:31-39`; no cycle), with the policy at each call site unchanged (D-1b): `worktreePreserveReason` (:469) maps `dirty` → "uncommitted changes" and `unknown` → a new reason such as "git status unreadable", still preserving, which also fixes the shutdown log at :502 claiming "uncommitted changes" for a path that may not exist; the chain-resume resolver (`run-orchestrator.ts:914`) becomes `(p) => worktreeStatus(p) === "dirty"` so the boolean `CompletedLinkResolver` contract (`chain-resume.ts:77-81`) and its seven unit stubs stay; `checkWorktreeFreshness` (:301) uses the primitive too. The hand-copied check in `chain-resume.integration.test.ts:105-112` is replaced by the primitive. The three porcelain **parsers** (`worktree-manager.ts:1403` `-z`, `phase-executor.ts:1021`, `qa-stagnation.ts`) are out of scope. `formatSignalLine` → one function beside `signalOther` with an `indent` parameter and one message text.
- **A-1 (runner, cross-repo, accretion-audit):** add `git`, `filterLogs`, `buildLoopContext`, `isTerminalStatus` to `dogfood/sequant.allowlist.json` in accretion-audit so the detector stops reporting the four noise groups.

## §7 Decisions

| # | Decision | Rejected |
|---|---|---|
| D-1 | One `killProcessGroup(child, { graceMs })` with SIGKILL escalation for every caller, including the drivers | Keeping two semantics: a hung driver child would still survive its timeout; #1222 chose escalation for the MCP path for that reason. A pid-only API: cannot observe exit without a PID-reuse race. |
| D-1b | `isWorktreeDirty` becomes one `worktreeStatus` primitive returning `unknown` on git failure; each caller keeps its documented default (cleanup guard: unknown → keep; chain resume: unknown → not dirty) | One shared boolean with a single default: the two callers fail in opposite directions on purpose (worktree-manager.ts:396 and chain-resume.ts:77 both say so), so either default would break the other caller. No behaviour change. |
| D-2 | `ensureDir` errors propagate everywhere | Keeping the swallowing copy in `upstream/assessment.ts`. The swallow is nearly harmless (the `writeFile` on the next line throws on the same condition) but it degrades the diagnostic from `EACCES mkdir <dir>` to `ENOENT open <file>`, and its "may already exist" rationale is dead: `mkdir` with `recursive: true` never throws EEXIST. |
| D-3 | `truncateToWidth` uses the TUI algorithm (one column reserved for the ellipsis, `…` at width 1) and lives in `src/lib/cli-ui/truncate.ts` | Two width algorithms for one visual contract; the TUI one is tested. Importing `ui/tui` from `lib/assess` would invert the layering. |
| D-4 | C-2 closes the measurable part of the AsyncSubprocess clause; the trigger `async_subprocess` is expected to read `not_fired` after C-2 and the owner acks fire `fcc45c51e344aabb` as acted (accretion #29 automates this later) | Waiting for #506 to deliver the abstraction before touching the duplicates. |
| D-5 | Five nodes by cluster (four at first; C-5 split from C-4 after the research pass), not sixteen by name and not one PR | One PR touches 20 files across five subsystems and would be hard to review and revert; sixteen PRs each cost a QA cycle for a three-line move. |
| D-6 | Serialize C-1 → C-3 → C-5 on shared files; C-2 waits for C-1; C-4 is independent | `mcp/tools/run.ts` is in C-1 and C-2; `cli-ui/format.ts` in C-1 and C-3; `commands/locks.ts` in C-3 and C-5. C-4 touches none of them. |
| D-7 | Non-goals heading rules of record are the gate's: any `#`-level heading whose text starts with `non-goals`/`out of scope` opens the section (trailing text allowed), any heading closes it, several sections are unioned, items may begin with `#` | The analyzer's rules (`##` only, heading must end after the keyword, first section only, `#`-items dropped) lose on four real bodies (#971, #763, #1246, #1228) and win on none; the one case they handle, a fenced example, is fixed by `stripFencedLines` in either scanner. |
| D-8 | The worktree-add race (see §8) is filed as its own bug outside this graph and lands first, or the runner launches this graph's parallel nodes in one `sequant run` invocation | Letting two CLIs race in this repo: the losing issue's phases run in the main checkout (verified: `ensureWorktree` returns null, `ensureWorktrees` drops it, `phase-executor.ts:1636` falls back to `process.cwd()`). |

## §8 Conventions

- One line per AC with a trailing `Evidence:` clause; gate ACs carry `mutation-verified`. Bodies parsed with `parseAcceptanceCriteria` and `isGateTestEvidence` before filing.
- Metadata line `**Epic:** graph-2026-10-consolidation **Tier:** … **Execution:** sequant_run`, then one `- **Blocked by**: #N` per edge. `## Non-Goals` and `## Prior fixes / producers` in every body.
- **Merge consent: stop at PR**, owner consent per merge. I-1 check before each merge. `main` requires `test` and `canary`, strict up-to-date.
- Launch after PR #1370 and release 2.20.0 have landed (I-5). Nodes touch no frozen path, so the freeze itself is not the blocker; the owner's queue is.
- Launch parallel nodes (C-2 and C-3) in **one** `sequant run` invocation so worktrees are created sequentially, until the race bug (D-8) has landed; two CLIs in one repo lose the `.git/config` lock about one time in four (40 concurrent `worktree add` lost 11).
- The issue body is canonical once filed; `issues/*.md` is the as-filed snapshot.

## §9 Open questions and owner gates

- **OQ-1 (owner, before C-2 exec):** accept D-1, SIGKILL escalation for the drivers? For: a `codex`/`opencode` child that ignores SIGTERM hangs the phase forever (nothing bounds the driver promise but `close`) and on Ctrl+C survives the 10 s force-exit as an orphaned detached tree; the MCP 30-minute watchdog covers MCP-launched runs only. Against: SIGKILL may corrupt the CLI's session store and break `resumeHandle` (`codex.ts:727`, `opencode.ts:758`); how either CLI reacts to SIGTERM is unmeasured. Default yes; a no makes `graceMs` optional with no escalation when absent.
- ~~OQ-2~~ Dissolved on 2026-10-16 by reading both call sites: D-1b keeps each caller's documented default, so there is no owner decision.
- ~~OQ-3~~ Resolved 2026-10-16 by research: no real body has a fenced Non-Goals example (268 bodies checked); the only effect of the fence bug is a spurious report-only classification. Nothing depends on it.
- **OQ-4 (resolved by C-3 spec):** do the assess renderer's snapshot tests pin the old ellipsis behaviour? If so the snapshots update in the same PR and the PR body says so.

## §10 After this graph

Re-run the accretion baseline comparison (`accretion dups --repo ~/Projects/sequant`): expected 4 groups, all allowlisted after A-1, so 0 reported. Then the sequant findings still parked in accretion-audit §10: the exec-skill knip check (frozen), the ADR index gap (docs), the concurrent worktree-add race (src, its own fix issue).
