# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Lightweight content pre-flight for `sequant run --chain` (#762)** — chain validation previously checked only flag *combinations*; nothing inspected the *content* of the issues being chained, so a mis-ordered or unready chain (the #133 downstream-staleness class) sailed through to worktree provisioning. A new warn-by-default pre-flight now runs once at chain start, **before the first worktree is provisioned**, and surfaces four cheap problems: an issue with a missing/empty Acceptance Criteria section; a declared dependency marker (`Blocked by #N` / `depends on #N`, matched only at line start so prose that merely mentions the marker mid-sentence is not mistaken for a declaration) whose target runs *after* it in the CLI order; a predicted file-overlap (via the existing `assess-collision-detect` machinery — no new heuristics) whose CLI order contradicts the ascending land order; and an issue that is CLOSED on GitHub (consistent with the #305 state guard; the #592 in_progress-but-merged gap is noted, not fixed). Following the #604 philosophy — *suggest, never auto-decide* — warnings never block by default; the new `--strict-preflight` flag turns any warning into a hard stop before provisioning. Critically, the checks compare against the **raw CLI order** (not the dep-sorted order), so `sequant run 39 38 --chain` where #39 declares `Blocked by #38` still warns rather than being silently pre-fixed by the sorter. A `gh` fetch failure warn-degrades (that issue's checks are skipped) so the pre-flight can never be the thing that breaks a run. (#762)

- **`sequant run --chain` resumes a partially-completed chain from its last good link (#760)** — chain mode already wrote a `checkpoint(#N): QA passed` commit after each successful link and described it as a "recovery point if later issues fail", but nothing consumed it: on any link failure the loop broke unconditionally and a re-run redid completed issues from scratch — the dominant "chain dead, 1–3 hours wasted" failure class from the #604 forensics. Re-running the same `--chain` invocation now skips the contiguous prefix of links that are already `ready_for_merge`/`merged` and resumes at the first incomplete link, rebased onto the last completed link's committed tip (reusing the #748 `rebaseOntoLocalBranch` path). The existing pre-flight state guard was chain-*unaware* — it dropped completed links before worktree provisioning, leaving the first incomplete link at index 0 where the #748 successor-rebase never fires, so it silently rebuilt on `main` (the #748 wrong-base bug). A new pure `computeChainResumePlan` (`chain-resume.ts`) makes the skip chain-correct: it peels the completed prefix, provisions the incomplete tail from the resume base, and `executeSequential` explicitly rebases the first active link onto that tip with fail-fast (a provisioning-time rebase failure only warns, so this is the authoritative correctness gate). Skipped links are reported explicitly (issue number, reason, resume commit). Destroyed completed links are handled (AC-3): a `merged` prefix resumes from the base branch (its work is in `origin/main`; never rebase onto a squash-orphaned local tip), while a `ready_for_merge` link whose branch/checkpoint is gone **fails fast** with a clear message rather than executing the successor on the wrong base. `--force` still bypasses resume entirely (redo the whole chain). Only a **contiguous** completed prefix is skipped: a `ready_for_merge` link sitting *after* an incomplete one is re-executed rather than silently dropped (chain mode breaks on first failure, so completed links normally form a prefix; a hole means the state doesn't match a plain resume, and re-running is the conservative read). `createCheckpointCommit` failure is no longer verbose-gated: since resume depends on the checkpoint, a commit failure now warns prominently, is restated in the run summary, and is recorded on the issue result (`checkpointFailed`). Because the link's status is written `ready_for_merge` *before* the checkpoint is attempted, a failed checkpoint leaves a completed-looking link whose branch tip is missing its uncommitted work — so the planner also **fails fast when the resume base's worktree is dirty**, rather than rebasing the next link onto an incomplete tip. Covered by unit tests for the resume state machine (fresh/prefix/merged/destroyed/fail-fast) and a real-git integration test (3-link chain, force link 2 to fail, re-run, assert link 1 skipped and link 2 branches from link 1's tip via `merge-base --is-ancestor`, the #752 pattern). (#760)

### Fixed

- **`pre-tool.sh` guards no longer disarm on a `gh issue`/`gh pr` prefix, and no longer false-positive on body text or a `cd` prefix (#763)** — every catastrophic guard was wrapped with a `! grep -qE '^gh (issue|pr) '` carve-out (added by #564, extended to four more sites by #570) that tested the command's *prefix*, not its *content*: any compound command starting with a real `gh issue`/`gh pr` invocation (`gh issue list && git push --force`) walked straight through the guard — including the load-bearing force-push protection — while the same `^`-anchor re-broke the false-positive fix on any `cd <dir> && gh issue …` prefix. All 10 carve-outs are removed and the guards now match against the **command words of each shell segment** (split on `; && || |` and newline, quotes stripped): a token that appears only inside a quoted `--body`/`--title` argument is never a command word (so `gh issue create --body "…git push --force…"`, with or without a `cd` prefix, is allowed), while a real command chained after an allowed one is its own segment and still blocks. The `rm -rf /|~|$HOME` substring alternation is deleted entirely — it was redundant with Claude Code's native dangerous-`rm` analyzer (which fires even under `bypassPermissions`) and its `rm -rf /` fragment substring-matched every absolute path, blocking ordinary worktree/scratch deletes; `:108` is now a dedicated command-word `sudo` guard (`sudo` is not natively covered). Every `HOOK_BLOCKED` now logs the offending command text and the specific rule that fired to a single rotated, secret-redacted sink for building a real regression corpus. The pre-#763 regression tests that used `echo gh issue && …` (which never matched the anchor, so they passed for the wrong reason) are corrected to the anchored `gh issue list && …` shape and the full evidence table is encoded across all three hook copies. Command-word matching covers every position the shell would actually execute — chained, `( … )`, `$( … )`, and `$( … )` inside double quotes — while heredoc bodies are treated as the stdin *data* they are, so the standard `git commit -m "$(cat <<'EOF' … EOF)"` idiom can still mention a guarded command in its message; argument positions (`xargs sudo …`, `bash -c "sudo …"`) are a documented, tested gap. Hook logs resolve to `${CLAUDE_PLUGIN_DATA}/logs/`, else `${HOME}/.sequant/logs/`, else `$TMPDIR` — always an absolute path outside the repo, and resolved identically by `pre-tool.sh` and `post-tool.sh`, which share `claude-timing.log` (START from pre, END from post). An earlier cwd-relative `.sequant/logs` fallback scattered stray directories into whatever directory the hook ran in, split every START/END pair across two files, and — because the hook created the directory *before* the no-changes guard read `git status --porcelain` — made the repo look dirty and silently allowed the empty commits that guard exists to block. (#763)
- **`sequant run` no longer misroutes an `AC_MET_BUT_NOT_A_PLUS` QA verdict into the quality loop (#749)** — `mapAgentSuccessToPhaseResult` classified a qa phase as a hard failure for *any* verdict outside the `{READY_FOR_MERGE, NEEDS_VERIFICATION}` allowlist, so `AC_MET_BUT_NOT_A_PLUS` — a stopping/ready state per the project's documented policy and `ready-gate.ts`'s `ac` policy — fell through to `success: false`. With `-Q`, the resulting non-success qa fed the quality loop, re-ran the pipeline from phase 0 (starting with `testgen` under `--testgen`), never reached zero failures, and exited `status=failure` with **no PR** — even though acceptance criteria were met. The failing branch is now narrowed to an explicit `verdict === "AC_NOT_MET"` check (the null/unparseable branch from #534 is unchanged), so `AC_MET_BUT_NOT_A_PLUS` returns `success: true` with the verdict retained on the result — the run breaks to PR and the "not A+" note surfaces in the PR body / run log. Because every downstream router (the batch-executor loop trigger, `shouldCreatePR`, and the `--qa-gate --chain` break at `run-orchestrator.ts:1076-1080`) keys off `result.success` only, flipping this single mapping also keeps a `--qa-gate --chain` from breaking on an `AC_MET_BUT_NOT_A_PLUS` predecessor. `AC_NOT_MET` and null/unparseable verdicts still hard-fail with their existing error strings. The locking test that asserted the buggy `success: false` is flipped to assert success + verdict retention, with added assertions that the result drives PR creation and does not trip the chain-break predicate. (#749)
- **`--chain` successors now branch from the predecessor's committed work, not `main` (#748)** — `ensureWorktreesChain` provisions every chain worktree up-front, branching each successor from its predecessor's branch name; but at provisioning time the predecessor branch still points at the base (it hasn't executed yet), so on a *fresh* run each successor effectively branched from `main` and missed all of its predecessor's work — directly contradicting the `--chain` help text and the code's own AC comment. No execution-time rebase ever corrected this: the existing chain-rebase only fired on the re-run (pre-existing-worktree) path, and `rebaseBeforePR` targets `origin/main`, not the predecessor. `executeSequential` now re-rebases each successor's worktree onto its predecessor's **local** committed tip just before the successor runs (independent of `--stacked`), via an extracted `rebaseOntoLocalBranch` helper reused by the re-run path. When a successor cannot be chained — a rebase conflict/failure, or a missing worktree-map entry — it aborts the rebase (restoring the branch), warns loudly, and **breaks the chain**: the unrunnable successor is recorded with an abort reason and the chain stops before it (and any later issues) run, rather than silently producing a successor built on the wrong base whose break would propagate downstream. Guarded by a real-git integration test asserting `git merge-base --is-ancestor <predecessor-exec-commit> <successor-HEAD>` on a fresh chain run (no mock of the rebase step), plus orchestrator wiring tests covering the conflict-break and missing-predecessor paths. The behavior is documented in `docs/reference/run-command.md` (Chain Mode → "Broken chain links stop the chain"). The `--chain` help text now describes the actual behavior. (#748)
- **`cleanup-worktree.sh` no longer deletes the remote branch before a PR is merged (#750)** — the merged-PR check only gated a non-blocking prompt, while `git push origin --delete` fired unconditionally, so running the script (or piping `echo y |`) against a branch whose PR was still **OPEN** deleted the PR's head branch and made GitHub close the PR **unmerged**, stranding the work. Remote-branch deletion is now hard-gated: it happens only when the PR is `MERGED` or an explicit `--delete-remote`/`--force` flag is passed; otherwise the remote branch (and any open PR) is left intact. Local teardown (worktree + local branch) still runs unconditionally so the branch lock is freed for a subsequent `gh pr merge --delete-branch`. The script also gained non-interactive support: `--yes`/`-y` (and `--force`) skip the confirmation prompt, and in a non-interactive context without a confirm flag the script now exits safely instead of stalling on `read -p`. It now also recognizes `-h`/`--help` (prints usage and exits 0) and documents all flags in its `--help` output; the new flags are covered in the worktree-isolation and troubleshooting docs. The canonical source is `templates/scripts/cleanup-worktree.sh` (with `scripts/cleanup-worktree.sh` symlinked to it), so the fix propagates automatically. A stale, divergent copy at the gitignored, untracked `.claude/scripts/cleanup-worktree.sh` path — legacy local cruft not generated by any current tooling — carried the same unconditional-delete bug and was deleted locally; delete it on any machine where it still exists. (#750)

## [2.8.0] - 2026-06-23

### Added

- **`/assess` emits `sequant run` when a global install is present, not always `npx sequant run` (#740)** — `npx sequant` is the invocation most prone to *version skew*: with a dual node prefix (npx resolving from one prefix, the global binary from another) plus npx cache reuse, `npx sequant` can silently run a *stale* version while a directly-installed `sequant` on PATH is current — so a user copy-pasting an assess-generated command could execute an outdated binary. `/assess` now probes once in Step 1 (`command -v sequant`) and selects the command prefix to match the environment: a resolvable global `sequant` on PATH → `sequant run …`; otherwise the unchanged `npx sequant run …` default (zero behavior change for npx-only users). The Commands block, the `Chain:` line, and the single-issue detail-mode command are tokenized with `CMD_PREFIX` and governed by a new Commands Block Rule #9 (use the chosen prefix consistently, never mix prefixes within one assessment); worked examples continue to illustrate the npx-only default. Skill-prose only — no runtime behavior change — mirrored across all three skill roots. (#740)
- **Runtime Node-version preflight guard (#734)** — `engines.node` (`>=22.12.0`, raised in #677/#679 to drop EOL Node 20) is advisory: npm/npx only emits an easily-missed `EBADENGINE` *warning* and runs anyway, so a user on Node 20/21 could blow past it and later hit an opaque stack trace when Sequant or a dependency tripped a Node-22-only API. The CLI now checks the running Node against the floor at startup, before any command logic (including `sequant serve`): if it's below the floor it prints a clear message naming current vs required version plus upgrade paths (fnm / nvm / nodejs.org) and exits non-zero — turning an ignorable warning + later crash into one friendly, immediate message. The floor is derived from `package.json` `engines.node` (single source of truth, no hardcoded literal) and the comparison reuses the existing `compareVersions` helper — zero new dependencies. At/above the floor there is no behavior change. (#734)
- **Surface structured rate-limit / credits errors from the SDK message stream (#732)** — the Claude Agent SDK already emits structured `rate_limit_event` (`SDKRateLimitInfo`) and assistant `error` signals, but sequant dropped them on the floor and guessed rate limits via regex-on-stderr. The `ClaudeCodeDriver` stream loop now reads these signals and constructs a typed `RateLimitError` (retryable) or `BillingError` (non-retryable) — both new subclasses of `SequantError` carrying `resetsAt`, `overageDisabledReason`, and (on SDK ≥0.3.181) `canUserPurchaseCredits` / `hasChargeableSavedPaymentMethod`. The typed cause propagates through `AgentPhaseResult` → `PhaseResult` so a failed phase now names the real cause ("Out of credits — purchasable", "Rate limited — resets at HH:MM") instead of the generic, misleading `Phase failed with MCP enabled, retrying without MCP...` fallback noise (#592). A billing/credits failure also **skips** the pointless no-MCP retry — a retry cannot refill credits. The existing stderr-regex classifier is retained as the fallback for the subprocess path (`run.ts`), so non-SDK error classification is unchanged. (#732)

### Changed

- **Preserve partial output for turn-capped phases at the orchestrator level (#739)** — completes the follow-up carved out of #733, which confined turn-cap handling to the driver + `/qa`/`/exec` skills. At the orchestrator level the driver's `capped` flag was dead data: `phase-executor`'s failure return dropped **both** the flag **and** the partial `output`, so a *top-level phase query* (not a spawned sub-agent) that hit its `maxTurns` ceiling discarded its work exactly as before #733. `PhaseResult` now carries an additive `capped?: boolean` (same shape as `structuredError?` from #732). The failure return propagates `capped`, and propagates the partial `output` **only when capped** — a genuine (non-capped) failure keeps the historical behaviour of dropping `output`, so the `/loop` fix-context (`formatFailureContext`) is unchanged for those; this gating lives in an extracted, unit-tested `mapAgentFailureToPhaseResult` helper symmetric to `mapAgentSuccessToPhaseResult`. A capped phase is treated as **incomplete-but-not-hard-failed**: `executePhaseWithRetry` short-circuits before the cold-start retry, the MCP fallback, **and** the spec-extra retry (a retry cannot un-cap a turn limit — same rationale as the #732 billing skip, but capped must skip *all* retries, so it uses an explicit early return rather than a guard at the MCP gate alone). The run loop surfaces a distinct `turn cap reached — partial output preserved (resume to continue)` signal instead of a generic failure, persists the partial output (in `phaseResults`), a new additive `capped` marker on the phase log (status stays `"failure"` — no new `PhaseStatus` enum value), and an additive `capped` field on the persisted phase **state** (so the recoverable halt is distinguishable from a genuine failure on resume, not just in the run-log), and halts cleanly for the user to resume. Covered by capped-path unit tests in `phase-executor.test.ts` (flag + partial output preserved, non-capped failure drops output, single invocation / no MCP-fallback, no spec-extra retry), `state-manager.test.ts` (capped marker persisted / unset for genuine failures), and a `batch-executor.test.ts` integration test (distinct signal, capped log marker, clean halt). (#739)
- **Graceful `error_max_turns` handling for subagents (#733)** — when a subagent hits its `maxTurns` cap, `ClaudeCodeDriver` previously treated `error_max_turns` as a hard failure (`error: "Max turns reached"`), discarding the partial work the agent had already produced. With turn caps live on every agent (#484) this is a real, reachable failure mode. The driver now logs a **warning** (via the `onStderr` channel) instead of an error and returns the partial output flagged with a new additive `capped: true` field on `AgentPhaseResult`, so the work is preserved rather than thrown away. The `/qa` skill treats a turn-capped check as **inconclusive** (flagged in the QA summary, never failing the whole phase on the cap alone), and `/exec` treats a turn-capped implementer as **incomplete** (reporting which tasks finished vs. which were capped for the next iteration to resume). Orchestrator-level partial-preservation in `phase-executor` is intentionally out of scope (sub-agent caps only). (#733)

### Fixed

- **Reconciled skill-mirror divergences across the three roots + CI gate (#738)** — skill files live in three mirrored roots (`.claude/skills/` canonical, `templates/skills/` consumed by `sequant init`/`sync`, `skills/` published as the plugin), and they had drifted to **8 diverged, 10 missing**, so downstream installs received stale or missing skill content. Reconciled all 18 in the canonical direction (`.claude/skills/` → mirrors) after per-file review for intentional drift: notably `qa/scripts/quality-checks.sh` required a **merge**, not a blind copy — `.claude` had test-tautology detection (#310) while the mirrors had the structured cache-metrics JSON writer (#278/#303) that `worktree-manager.ts` reads to populate `PhaseLog.cacheMetrics` (surfaced via `sequant logs`); both features are now in all three roots, restoring cache-metrics observability that had silently broken in this repo. Hardened `scripts/check-skill-sync.ts` to skip dotfiles/dot-directories (killing the `.sequant/.token-usage-*.json` false-positive "missing") and added a documented `EXCLUDE` allowlist escape hatch. A new `npm run lint:skill-sync` step in CI (alongside `lint:skill-calls`) now fails the build on any future drift. Also repointed `npm run sync:skills` at the canonical fixer (`check-skill-sync.ts --fix`) — it previously ran `cp -r templates/skills/* .claude/skills/`, the **reverse** of the documented canonical direction, so running it would have silently clobbered canonical edits with stale mirror content. (#738)

## [2.7.0] - 2026-06-10

### Added

- **`sequant sync --dry-run` / `-d` — a trustworthy preview for the sync surface (#722)** — `sync` previously had no preview: on a `.sequant-version` marker mismatch (e.g. an install that predates the 2.6.2 `<!-- sequant:local-override -->` overlay header from #711) it ran `copyTemplates(force:true)` and silently rewrote the whole tree (every `SKILL.md` + `AGENTS.md`) with no per-file output, so an operator or CI job had no way to see pending work before applying. The reported dry-run-vs-apply divergence traced to this gap (and/or `npx` version skew) — **not** to `update`, which already derives its summary and write-set from one `computeTemplateChanges()` call and already classifies a header-missing `SKILL.md` as `modified` (verified: `update --dry-run` reports the drift, never a false "0 modified"). `sync --dry-run` reuses that same source of truth to report the exact set the apply would write — `new` + `modified` + `local-override` (the force copy overwrites in-place customizations, so they are counted, never under-reported) — mutates nothing, and exits non-zero when work is pending so the preview can gate automation. The override classifier remains keyed on a real `.claude/.local/` twin, not the in-band marker. (#722)

### Changed

- **`sequant update --dry-run` now exits non-zero when work is pending — parity with `sync --dry-run` (#724)** — `update --dry-run` previously always exited `0` regardless of pending changes, so a CI/automation job scripting it had to parse stdout to detect drift, while `sync --dry-run` (#722) already gated on its exit code. `update --dry-run` now sets `process.exitCode = 1` when the apply set is non-empty (`new` + `modified`, plus `local-override` under `--force`), mirroring `sync --dry-run`; the no-op case still exits `0` (it short-circuits at the "Everything is up to date!" return before the dry-run tail). The signal reuses the `applySet` already derived from the single `computeTemplateChanges()` call — no new comparison logic. **Potentially breaking for scripts:** any automation that runs `update --dry-run` and treats exit `0` as "command ran" (rather than "nothing to do") will now see a non-zero exit when updates are pending. Low risk — `update` is the interactive command and `sync` is the documented non-interactive/CI surface. (#724)

## [2.6.2] - 2026-06-04

### Added

- **Run dashboard active phase + success states now brand-colored (#712)** — applies Sequant brand accents (sourced from the sequant-landing `tokens.css`) to the two highest-signal colors in the boxed run TUI: active/live phase spinners use brand orange (`#FF8012`, `--color-primary`) instead of the issue's rotation color so the running phase pops on-brand across every box, and success states (done glyphs, passed borders, the "N done" rollup) use brand green (`#10b981`, `--color-accent`) instead of generic ANSI green. Issue-distinction (border rotation), failure (red), and dividers (gray) stay on named ANSI colors. Ink/chalk auto-downsamples the hex on non-truecolor terminals and `NO_COLOR` still strips it, so no capability check is needed. Renames the misleading `PhaseProgression` `borderColor` prop to `activeColor`. (#712)
- **`/release` warns when the README "What's new" heading lags the release (#707)** — adds a warn-only **Step 4.66** to the release skill that, after the version bump, compares the README's latest `### What's new in <major>.<minor>` heading against the **minor** line being released. Keys on the minor (not full semver), so a patch release (2.6.0 → 2.6.1) stays silent against a matching heading, while a stale minor/major heading fires a warning. Mirrors the warn-only behavior of the sibling what-weve-built (Step 4.63) and CHANGELOG (Step 4.65) gates and never auto-edits the README. Closes the gap that shipped a stale "What's new in 2.5" heading in the v2.6.0 tarball (fixed manually in 18c2d42). (#707)
- **`sequant update --yes` / `-y` for non-interactive updates (#709)** — `update` was interactive-only: piping or running without a controlling TTY produced an unhandled `ExitPromptError` stack trace instead of a clean exit, and there was no flag to auto-apply. Added `-y, --yes` to apply updates without prompting, and a non-interactive guard on **both** prompt sites (first-run dev-URL setup and the apply-confirm) so that when a prompt is needed but `--yes` was not passed, `update` prints an actionable message naming the reason and exits non-zero — no more raw stack trace. The guard fires when stdin is not a terminal **or** a CI environment is detected, so a runner that allocates a pseudo-TTY refuses cleanly instead of hanging on an unanswerable prompt. `update --dry-run` previews changes in any shell (including CI and first-run projects) without prompting and without persisting config. `--yes` (auto-answer) stays distinct from `--force` (overwrite in-place customizations). Documented the automation path in the cheat-sheet and troubleshooting guide. (#709)

### Fixed

- **Corrupt `package-lock.json` on `main` — 9 unresolved git-stash conflict blocks (#720)** — PR #716 committed `package-lock.json` with 9 unresolved `git stash` conflict blocks (27 marker lines), leaving the lockfile as invalid JSON so `npm ci` from a fresh clone failed. It went unnoticed because the lockfile isn't published to the npm tarball and `npm install`/`tsc`/`vitest` tolerate the existing `node_modules` — only a strict `npm ci` parses it. Regenerated via `npm install --package-lock-only`, which recomputes the dependency tree and drops the spurious `"dev": true` flags on production-reachable transitive deps (`cross-spawn`, `debug`, `fast-deep-equal`, `isexe`, `ms`, `path-key`, `shebang-command`, +2). (#720)
- **Run dashboard perf-buffer leak + width corruption on resize (#718)** — two fixes for the boxed run TUI. (1) `perf_hooks` leak: `ink` pulls in `react-reconciler`, which loads its dev bundle when `NODE_ENV != "production"`, emitting an uncleared `performance.measure()` per render; at the TUI's 10 Hz poll it overflowed Node's ~1M-entry perf buffer and wrote a raw `MaxPerformanceEntryBufferExceededWarning` to stderr (which also corrupted the in-place redraw). A new `loadTui()` brackets the TUI's dynamic import with `NODE_ENV=production` (only when unset), then restores it so spawned phase children don't inherit it (verified: 206 → 0 measure entries for the same workload). (2) Width corruption on resize: `ink`'s resize handler re-renders the existing tree but doesn't re-run `App`, which read `stdout.columns` imperatively — so after a resize it repainted boxes at the stale, too-wide width until the next poll. `App` now tracks columns from the stdout `resize` event (plus a 1 Hz fallback) and clamps `boxWidth` to the live width. (#718)
- **`.claude/.local/skills` override layer was non-functional — documented but never loaded (#711)** — `docs/guides/customization.md` told users to copy a skill into `.claude/.local/skills/<name>/SKILL.md` and promised "the local version takes precedence," but Claude Code's skill discovery only scans user (`~/.claude/skills/`), project (`.claude/skills/`), and plugin scopes — never `.local/skills/` — so the copy silently did nothing (likewise for `.local/hooks/`). Fixed by shipping a **runtime overlay**: every managed `SKILL.md` (all three mirror dirs) now **opens** (before its first heading, so it fires reliably even in 3000-line skills like `/qa`) with a directive to honor `.claude/.local/skills/<name>/overrides.md` if present, treating it as authoritative. Users write small instruction *deltas* that survive `update`/`sync` (which never write into `.local/`) instead of forking the whole skill. Net-new skills are documented to live in project/user `.claude/skills/` (the scopes discovery actually scans); `update`/`sync` only touch package-managed paths and never delete unmanaged dirs, so a custom `.claude/skills/<name>/` is never clobbered (regression-tested). Hook customization is corrected to the real mechanism — register the script in `.claude/settings.local.json` (no `.local/hooks/` auto-discovery exists). `customization.md` and `troubleshooting.md` rewritten so no documented override path is non-functional. (#711)
- **Pre-flight skill check missed in-place content drift (sibling of #708) (#713)** — `areSkillsOutdated`/`checkAndWarnSkillsOutdated`, used by the `preAction` hook in `bin/cli.ts` before most commands, compared only the `.sequant-version` marker. A tree at the matching version but with drifted bundled content (exactly the #708 scenario) reported `outdated: false`, so no warning surfaced and the drift `sequant sync` now flags stayed invisible to every *other* command. `areSkillsOutdated` is now content-aware: on a version match it runs the same `computeTemplateChanges` diff `sync` uses (the single source of truth from #708/#710), counting `new`+`modified` files and **excluding** `local-override`/`unchanged` so customized files (e.g. an in-place-customized `constitution.md`, #711) don't warn on every command. The pre-flight now warns on content drift at a matching version — **warn-only**: it never copies files and never sets `process.exitCode`, so the actual command still runs and exits normally. **Auto-sync (copy) stays gated on version bumps only** so in-place customizations aren't clobbered; content-only drift is surfaced as a non-destructive warning, leaving the fix to `sequant sync`/`update`. The content diff is gated behind a version match (a mismatch already means stale → copy path) and, on the hot pre-flight path, behind an opt-in stat-only fingerprint cache (a SHA-1 over the package version plus the mtime/absence of each bundled template, its installed counterpart, any `.claude/.local/` override, and the config/manifest) — the full ~15ms scan runs only when something that affects drift actually changed (measured ~5× faster on a cache hit; the cache is `doctor`/`sync`-exempt for fresh truth and degrades gracefully to a fresh scan on any error). The `update` command (alongside `init`/`sync`) is now excluded from the pre-flight entirely, since it is itself the command that resolves drift — avoiding a circular "run update" nag right before it runs. (#713)
- **`update`/`sync` content-truth bugs — false "up to date" and silent loss of in-place customizations (#708)** — both commands decided status from incomplete/divergent template comparison logic. `sync` declared `✔ Skills are already up to date!` purely from the version marker, so real content drift on the automation-recommended path went unreported. `update` compared installed files against the **raw** template (tokens unsubstituted), so an unmodified `constitution.md` always read as `modified`, and an in-place-customized constitution was overwritten on the default `Apply updates? (Y)` prompt — silent data loss. Fixed by extracting a single source of truth in `src/lib/templates.ts` (`buildTemplateVariables` + `computeTemplateChanges`, also used by `copyTemplates`): templates are now rendered with the project's variables **before** diffing, and customizable files (constitution) that diverge in place are classified `local-override` (skip-by-default, only `--force` overwrites). `sync` now verifies actual content on a version match and reports drift (`version current, but N file(s) differ — run \`update\` or \`sync --force\``) instead of a false no-op. On drift at a matching version, `sync` also exits non-zero — even under `--quiet` — so CI/automation (the recommended path) can't treat a drifted tree as success. The customizable-file allow-list is matched on separator-normalized paths so the protection holds on Windows. (#708)

## [2.6.1] - 2026-06-03

### Documentation

- **README "What's new" section refreshed for 2.6** — added a `### What's new in 2.6` block (boxed Ink TUI default for `run`; `--quiet` moved from `-q` to `-s`, `-q` now aliases the quality loop) above the 2.5 highlights. The v2.6.0 npm tarball shipped with a stale "What's new in 2.5" heading; this patch republishes so the npm package page matches. (#707)

## [2.6.0] - 2026-06-03

### Changed

- **CLI UX: `-q`/`-Q` flag collision fixed; boxed Ink TUI is now the default for `run` (#705)** — Commander short flags are case-sensitive, so `sequant run … -q` (meaning to enable the quality loop) silently enabled **quiet mode** instead, suppressing the live renderer. Now: **`--quiet` moves to `-s`** (mnemonic: silent) and `-q` becomes a hidden alias for `-Q, --quality-loop` (both enable the quality loop; neither enables quiet). The **boxed Ink TUI is the default** on a TTY for `sequant run` — `tuiEnabled = options.tui !== false && isTTY && !quiet` — matching `sequant ready`. Opt out with **`--no-tui`** (falls back to the line-based phase-matrix renderer); non-TTY / piped output auto-degrades safely. **`--experimental-tui`** is kept as a hidden no-op alias so existing scripts keep parsing. `--quiet`/`-s` continues to suppress the renderer entirely (heartbeat-only). Flag normalization (`run-flags.ts`) is unit-tested and the CLI help surface is integration-tested. Docs updated: README TUI-default framing and `docs/features/quiet-mode-heartbeat.md` (`-q`→`-s` throughout). (#705)

## [2.5.0] - 2026-06-02

### Fixed

- **Marketplace plugin README shipped wrong information before 2.5** — the generated marketplace/plugin README (source: the `README_CONTENT` literal in `scripts/prepare-marketplace.ts`) omitted the headline `sequant ready` command and its skill table listed `/release` (a dev-side skill **not** bundled into `templates/skills/`) while omitting the bundled `/solve`. Added `sequant ready` to Quick Start with a link to `docs/reference/ready-command.md`, and swapped the `/release` row for `/solve` so the table matches the 17 skills actually shipped. The `#684`↔`#694` What's-new gate conflict is fixed in the `/release` entry above. (#701)

- **`parseQaVerdict` choked on emoji-prefixed verdicts — genuine QA passes recorded as failures** — the QA verdict regex (`src/lib/workflow/phase-executor.ts`) only tolerated `**`/whitespace between `Verdict:` and the token, so a QA agent writing `Verdict: ✅ READY_FOR_MERGE` (the common form) parsed as `null` and the run was reported as *"QA completed without a parseable verdict"* despite a real pass (live repro: `sequant run 687 --phases exec,qa`, 2026-06-01 — QA had posted READY_FOR_MERGE, applied `ready-for-review`, and opened PR #688). The gap between `Verdict:` and the token now tolerates any run of non-alphanumeric characters (emoji `✅`/`❌`/`⚠️`, asterisks, whitespace) via a negated ASCII class — ReDoS-safe and `no-misleading-character-class`-clean, matching `parseQaSummary`'s approach. This also hardens `sequant ready` (#683), whose #534 guard would otherwise misclassify an emoji-verdict QA pass as `NO_IMPLEMENTATION`. Regression tests added in `phase-executor.test.ts`. (#683)

### Added

- **`sequant ready` upgraded to the boxed Ink TUI; the experimental TUI hardened for large batches (#699)** — on a TTY (non-`--json`), `sequant ready <issue>` now renders the experimental boxed Ink dashboard (single per-issue box with the 10 Hz spinner + phase row) instead of #697's plain renderer; `--json` and non-TTY still fall back to the static report exactly as #697 established. Because the TUI is pull-based (`App` polls `getSnapshot()` at 10 Hz) while `ready` has no `RunOrchestrator`, a lightweight single-issue snapshot adapter (`src/commands/ready-tui-adapter.ts`) — fed by the gate's existing `onProgress` events, modelling the `qa → loop → qa` passes as the phase row with a coarse `nowLine` — drives the TUI; `renderTui` was relaxed to accept any `{ getSnapshot(): RunSnapshot }`. The TUI is torn down (unmount) before the final report prints so it lands in clean scrollback, and on every exit path (success, gate error, SIGINT). Hardening that the plain renderer already had and the TUI lacked: a **row cap + frame-height clamp** (`selectVisibleIssues`, parity with the plain renderer's #624 behavior — keep active rows, fill with most-recent done, roll older done into `✔ N done`) so a large batch on a short terminal can't overflow ink, and a **durable teardown summary** (per-issue `✔/✘`) emitted on unmount so a completed run leaves a transcript in scrollback. Divider polish: in-box dividers drop the `├`/`┤` end-caps for a plain full-width gray rule. (#699)
- **`sequant ready` now shows a live phase-matrix while the gate runs (#697)** — `sequant ready <issue>` previously went silent between its static header and the final report for the full duration of the `qa → loop → qa` pipeline (minutes), indistinguishable from a hang. It now reuses the same renderer infrastructure as `sequant run` (`buildProgressWiring` / RunRenderer #618 + the phase-matrix) for visual parity: the current phase and quality-loop iteration render in place (pending → running → ✔/✘) with a liveness tick. The gate engine (`runReadyGate`) emits `start`/`complete`/`failed` progress events around each phase, carrying the QA-pass iteration so the matrix shows `loop N/M`. Rendering is gated on the non-`--json` path (piped/`--json` output is unchanged), `--verbose` streaming pauses/resumes the live zone instead of double-rendering, and the live zone is disposed before the final report prints (clean scrollback). The renderer is torn down on every exit path — success, gate error, and SIGINT. (#697)
- **`sequant ready <issue>` — post-resolve A+ QA gate (#683)** — a new standalone command that reproduces the maintainer's manual fresh-session A+ pass deterministically. Drives an already-resolved issue's existing worktree through a **full-weight** `qa → loop → qa` pipeline and **stops at the human merge gate — it never merges.** Full-weight QA is forced via a new `ExecutionConfig.fullQa` flag that sets `SEQUANT_FULL_QA=1` for the `qa` phase; the QA skill (mirrored across `skills/`, `.claude/skills/`, `templates/skills/`) honors it by running the standalone branch-freshness / process-state pre-flight checks **even under an orchestrator** — the checks the in-run QA skips, which catch the no-implementation / divergent-branch class (#318/#529/#570). Loop-exit threshold is a configurable **gate policy** (`ready.policy` in `.sequant/settings.json`, default `"ac"`, overridable with `--policy ac|a-plus`): `ac` stops once no `AC_NOT_MET` remains and **reports** (does not auto-fix) quality/polish gaps — Non-Goal-touching findings are explicitly report-only — while `a-plus` loops toward `READY_FOR_MERGE`, auto-fixing quality gaps. Both policies are bounded by `--max-iterations`, an optional `--budget` token cap, and the `LOOP_NO_DIFF` stagnation guard. A **#534 regression guard** ensures a zero-diff worktree (empty branch) or a null/unparseable QA verdict is never reported ready (`reason: NO_IMPLEMENTATION`, exit 2). Terminates in a new `waiting_for_human_merge` issue status with a structured markdown/JSON gap report (auto-fixed items + remaining/accepted gaps + final verdict). New `src/commands/ready.ts` (command shell) over a reusable `src/lib/workflow/ready-gate.ts` engine (`runReadyGate`, DI-injectable phase runner) — a future `sequant run --ready-gate` can reuse the engine. Tests: 29 deterministic cases across `ready-gate.test.ts` (phase sequence, policy thresholds, all guard exits, #534 guards, Non-Goal report-only, report shape) and `ready.test.ts` (policy resolution precedence, exit-code mapping). Backtest recall/noise methodology documented in `docs/investigations/ready-gate-backtest.md`; command reference in `docs/reference/ready-command.md`. (#683)
- **`/release` pre-flight hardens doc-freshness gates** — adds a marketplace-artifact regeneration step (`npm run prepare:marketplace` before pack/publish, with a warn-only Node-floor-vs-`engines` diff) and a `CHANGELOG.md` freshness check that warns when the version being released is absent. Closes the two doc surfaces that shipped stale in v2.4.0 (the bundled marketplace README and the changelog). (#684, #701)

### Changed

- **Top-funnel discovery + positioning pass for 2.5** — reframed the README H1 subhead from the generic "Workflow automation for AI coding agents" to the differentiated rigor/merge-gate lane ("Spec-driven AI coding agents — every acceptance criterion verified, stops at the human merge gate") and added a "who it's for" audience line. Added three social-proof badges (npm downloads, GitHub stars, CI status) alongside the existing version/license pair, a "What's new in 2.5" block (`sequant ready`, live phase-matrix TUI, per-issue concurrency locks), and cross-linked the pending demo GIF to #695. GitHub repo About/`homepageUrl`/topics applied via `gh repo edit` (topics: `claude-code`, `ai-coding-agent`, `agent-orchestrator`, `mcp-server`, `git-worktree`, `spec-driven-development`, `code-review`, `claude-code-plugin`, `autonomous-agent`). npm `keywords`: dropped the hopeless-broad `ai`/`agent`/`llm`, added winnable mid-tail `parallel`, `claude-code-plugin`, `spec-driven`, `code-review`, `human-in-the-loop`, `ci`, `pull-request`, `acceptance-criteria`, `headless`. Aligned the marketplace README subtitle (`scripts/prepare-marketplace.ts`) to the orchestrator voice used across `package.json`/`plugin.json`/`marketplace.json`. (#702)
- **README + npm metadata SEO & clarity overhaul** — front-loaded the `package.json` `description` with high-intent search terms ("AI coding agent orchestrator … isolated git worktrees, quality gates, and an MCP server"); pruned `copilot`/`anthropic` from `keywords` and added `mcp-server`, `agent-orchestrator`, `ai-coding-agent`, `autonomous-agent`, `agentic`, `git-worktree`, `issue-resolution`; reconciled the npm / plugin / marketplace taglines to one voice. README: moved the "What's new in 2.x" changelog wall here (replaced with a 2-line why), put Prerequisites above install with corrected "one of" logic (agent OR; `gh` AND Git), relabeled the install fork by run-location (Claude Code vs headless/CI), collapsed the Concurrency deep-dive into one sentence + a new [`docs/reference/concurrency.md`](docs/reference/concurrency.md), expanded "MCP" on first use, consolidated three overlapping command listings into one reference, and restructured "Using Sequant" around real usage (lead with `fullsolve`, the `assess → run -Q` batch ritual, the MCP front door, QA-on-the-issue). GitHub repo About/topics applied separately. (#694)

## [2.4.0] - 2026-05-30

### Changed

- **Resume semantics normalized to a driver-tagged, cwd-bound `ResumeHandle`** — replaces the opaque `sessionId` string and the global `sessionId && !worktreePath` guard at `phase-executor.ts:660`. `AgentDriver` gains a `canResume(handle, targetCwd)` method that each driver owns: `ClaudeCodeDriver` accepts only byte-equal cwd matches (storage is cwd-namespaced under `~/.claude/projects/<encoded-cwd>/`), and on mismatch transparently starts a fresh session rather than surfacing the SDK's recoverable `error_during_execution`; `AiderDriver` declines all resume. Unblocks same-worktree resume across phases (regression fix). State files gain a `resumeHandle` field on `IssueState`; the legacy `sessionId` is retained as a `@deprecated` mirror for one release so in-flight `.sequant/state.json` records load cleanly (legacy entries without `originCwd` are intentionally inert under the new fail-safe). Fixture tests cover cross-worktree rejection for both drivers, same-worktree resume threading through `executePhaseWithRetry`, and a `.skip` placeholder for the Codex case that lights up when #497 lands. (#674)

### Added

- **Typed workflow event system** — new `WorkflowEventEmitter` (`src/lib/workflow/event-emitter.ts`) wraps Node's built-in `EventEmitter` with a compile-time-typed event map. `RunOrchestrator` instantiates one per run, exposes it via `getEmitter()`, and emits 8 lifecycle events (`run_started`, `run_completed`, `phase_started`, `phase_completed`, `phase_failed`, `issue_status_changed`, `qa_verdict`, `progress`). Event payloads are JSON-serializable (`{ issueNumber, phase?, timestamp, duration?, verdict?, error?, ... }`) so MCP / webhook consumers can serialize them directly. `emit()` is wrapped in `Promise.allSettled` — a slow or throwing listener cannot crash the run. Existing consumers (LogWriter, MetricsWriter, CLI spinners) remain as direct calls per the descope decision; the emitter is opt-in for new subscribers (TUI, MCP server, future webhooks). `markDone()` drains all subscribers to prevent listener leaks across repeated `RunOrchestrator.run()` invocations (e.g. in the MCP server). Tests: 10 unit cases in `src/lib/workflow/event-emitter.test.ts` + 9 integration cases in `__tests__/run-orchestrator-events.test.ts`. (#504)

### Changed

- **BREAKING: Drop EOL Node 20 support, require Node 22.12+ (#677)** — `engines.node` raised from `>=20.19.0` to `>=22.12.0`. Node 20 ("Iron") reached end-of-life on 2026-04-30 and no longer receives security patches; Node 22 ("Jod") is the active maintenance LTS through ~April 2027. The 22.12 floor specifically matches `commander@15`'s requirement (uses `require(esm)`), unblocking the Dependabot commander 14→15 bump that was previously blocked. CI matrix collapsed from `[20.x, 22.x]` to `[22.x]`; all hardcoded `node-version: 20.x`/`'20'` setup-node steps in `.github/workflows/{ci,release,plugin-install-test,upstream-assessment}.yml` raised to `22.x`/`'22'`. `setup/SKILL.md` runtime prerequisite check raised from `-ge 20` to `-ge 22` (mirrored across `.claude/skills/`, `templates/skills/`, `skills/`). User-facing prose updated at all surfaces (`README.md`, `CONTRIBUTING.md`, `scripts/prepare-marketplace.ts` marketplace README source, `docs/getting-started/prerequisites.md`, five `docs/features/*.md` prerequisite blocks). Also corrected two prose surfaces that were still stale at "Node 18" from before the #363 floor bump. Version bumped 2.3.0 → 2.4.0 (minor — EOL-runtime drops follow the precedent set by #363's Node 18→20 drop). Mirrors the deliberate floor-bump pattern from #363. (#677)
- **BREAKING (CLI): `sequant run` rebinds short flags** — `-q` is now the short form for `--quiet` (matches UNIX convention and the existing `-q, --quiet` binding on `sync`/`doctor`); `--quality-loop` keeps a short form but is rebound to `-Q`. Previously `-q` silently bound to `--quality-loop` (because `bin/cli.ts` registered `-q, --quality-loop` before `--quiet`), so users typing `npx sequant run … -q` activated the quality loop instead of the heartbeat/quiet path while believing they had silenced the renderer. Anyone scripting `sequant run … -q` for quality-loop must now use `-Q` (or `--quality-loop`). Docs, assess SKILL.md examples (3-dir mirrors), and the assess collision-detect chain suggestion all updated; new regression test pins both bindings. (#658)
- Phase definitions consolidated into a single registry (`src/lib/workflow/phase-registry.ts`) — replaces the scattered `PHASE_PROMPTS`, `AIDER_PHASE_PROMPTS`, `ISOLATED_PHASES`, `UI_LABELS`, and `SECURITY_LABELS` constants. All 9 built-in phases (`spec`, `security-review`, `exec`, `testgen`, `test`, `verify`, `qa`, `loop`, `merger`) now register through the same mechanism with no special-casing. `--phases` now validates against the registry at runtime and reports unknown names with a clear error (`Unknown phase 'deploy'. Available: spec, security-review, exec, testgen, test, verify, qa, loop, merger`). `retryStrategy` metadata on `PhaseDefinition` is consumed at runtime (spec backoff/extra-retries + the `maxRetries: 0` skip-cold-start-retries rule) instead of being a parallel hardcoded set of constants. User-facing behavior is otherwise unchanged. (#505)
- **TTY runner replaces start/complete event journal with in-place phase-matrix (#672)** — `TTYRenderer.appendEventLine` no longer emits `▸ #N phase` start lines to scrollback; the live zone now seeds pending cells for the full pipeline via a new `RunRenderer.setPhasePlan` callback wired through `run.ts → OrchestratorConfig → batch-executor`. Per-issue cells transition pending → running → ✔/✘ in place. NonTTYRenderer (CI) journal is unchanged — `.sequant/logs/run-*.json` is the durable ordered-history record. `logUpdateClear` calls reduced ≥50% in the representative 2-issue × 2-phase scenario (target was ≥30%), incidentally locking in the #647 AC-2 scrollback-harness regression as a permanent green test.

### Fixed

- **Retry/fallback messages no longer leave duplicate `SEQUANT WORKFLOW · ` headers in scrollback (#647 AC-3)** — `phase-executor.ts` previously emitted retry-reporting messages (MCP fallback, spec retry, verbose-mode prompt/worktree lines) via raw `console.log` while the renderer's live zone was active. `log-update` tracks `previousLineCount` from its own writes only; the out-of-band `console.log` calls advanced the cursor without its knowledge, so the next `eraseLines(previousLineCount)` undershot by one and stranded the prior frame's top row in scrollback — one duplicate header per retry. A new `PhasePauseHandle.appendNotice(message)` method on the renderer mirrors `appendEventLine`'s `clear → write → redraw` flow so log-update's bookkeeping stays correct, and a `bracketedConsoleLog(spinner, message)` helper routes through it when a handle is present (falling back to `console.log` for quiet/non-TTY paths). All 10 unbracketed `console.log` sites in `executePhase` + `executePhaseWithRetry`, plus the two batch-boundary sites in `RunOrchestrator.run` that fire between batches with the renderer still alive, now use the helper. Locked in by an `it.fails` negative-control test that exercises the un-bracketed shape against the #504/#505 event timeline. (#647, #667)

- **`SEQUANT_DEBUG_RENDERER` routes to file sink, eliminating 2171× scrollback amplifier** — debug instrumentation in `TTYRenderer` now writes to `.sequant/debug-renderer.jsonl` (override via `SEQUANT_DEBUG_RENDERER_FILE=<path>`) instead of `process.stderr`. When stdout and stderr share a pty (the normal case), stderr writes scroll the terminal between log-update redraws — log-update has no record of them, so `eraseLines(previousLineCount)` misses rows and the prior frame's top survives in scrollback. The #647 AC-1 capture's "Mechanism #1 at 2181×" headline turned out to be 2171× of this amplifier (see `docs/incidents/647/captures/2026-05-17/analysis.md`); sinking debug output to a file removes the amplifier while preserving identical JSON schema + per-op cadence for diagnostic replay. If the file cannot be opened (e.g. unwritable path), the renderer emits a single startup notice to stderr and falls through to a no-op rather than crashing the run. (#664)

- **Renderer pause/resume wired to verbose phase execution** — `batch-executor.ts` now passes a `PhasePauseHandle` to `executePhaseWithRetry` at all three call sites (spec, phase loop, /loop), so the `RunRenderer.pause()` / `resume()` protocol is actually invoked. Previously the `spinner` parameter on `executePhaseWithRetry` was always `undefined`, making the renderer's `onPause` (`logUpdateClear`) and `onResume` (`redraw`) hooks dead code. Under `--verbose`, the live zone now quiesces while Claude SDK output streams to stdout, then redraws — eliminating the visual collision between the 1Hz live frame and verbose subprocess text. The `PhasePauseHandle` interface moved from `phase-executor.ts` to `workflow/types.ts` and is now implemented directly by `BaseRenderer`; the handle is threaded through `RunInit` → `OrchestratorConfig` → `BatchExecutionContext` → `IssueExecutionContext` mirroring the existing `onProgress` plumbing. (#656)

### Security

- **`@anthropic-ai/sdk` advisory waiver from #614 resolved — `@anthropic-ai/claude-agent-sdk` 0.3.x lifts the pin out of the vuln range** — recheck per #619 (target 2026-05-23) confirms upstream `@anthropic-ai/claude-agent-sdk` shipped a `0.3.x` major that no longer pins `@anthropic-ai/sdk ^0.81.0`; the production-deps Dependabot bump (#650) already moved this repo to `0.3.142`, and `npm update @anthropic-ai/claude-agent-sdk` now brings in `0.3.144`, which transitively resolves `@anthropic-ai/sdk@0.93.0` — outside the GHSA-p7fg-763f-g4gf vuln range (`>=0.79.0 <0.91.1`). Post-update `npm audit`: `@anthropic-ai/sdk` advisory is gone (`.vulnerabilities` no longer lists `@anthropic-ai/sdk`); the remaining unrelated moderates are cleared in the same lockfile pass (see next entry). Falsifiability check from #614 still holds (`grep -rE 'memoryTool|MemoryTool|memory_tool|memory-tool' src/ bin/ scripts/` → 0 hits; no direct `@anthropic-ai/sdk` imports outside the indirect `query()` pathway). Lockfile-only diff (no `package.json` change — `^0.3.142` already permits 0.3.144). (#619)

- **`npm audit` clean — remaining transitive moderates cleared** — `npm audit fix` (in-range, no `--force`, no `package.json` change) bumps three transitive deps to resolve their advisories: `brace-expansion` (GHSA-jxxr-4gwj-5jf2, large-numeric-range DoS), `ws` (GHSA-58qx-3vcg-4xpx, uninitialized-memory disclosure), and `qs` (GHSA-q8mj-m7cp-5q26, `qs.stringify` DoS on null/undefined comma-format entries). Post-fix `npm audit` reports `found 0 vulnerabilities`. Folded into this PR rather than a separate tracker since all three are in-range lockfile-only fixes of the same class as the #619 bump. (#619)

## [2.3.0] - 2026-05-13

### Added

- **Interactive relay — bidirectional communication with headless runs** — `sequant prompt <issue> "<message>"` sends queries or directives into a running detached/CI `sequant run`, and `sequant watch <issue>` tails the relay outbox for replies. Disable per-run with `--no-relay`. (#383)
- **`sequant stats --label` and `--since` filters for cohort measurement** — new `src/commands/stats.ts` helpers `filterLogs(logs, { label, since })` and `emitNoMatchingRuns(options)` filter `.sequant/logs/run-*.json` entries before `calculateStats` / `calculateDetailedAnalytics`. `--label <name>` keeps a run iff some issue in `log.issues[]` carries the label (mirroring the existing label-segment scan); `--since YYYY-MM-DD` keeps a run iff `log.startTime >= <since>T00:00:00Z`; both compose with AND. Filters force log-mode and bypass the metrics-first path — the metrics file at `.sequant/metrics.json` carries only issue numbers (per `metrics-schema.ts` `MetricRun.issues: number[]`), so per-label filtering against metrics is impossible. Applied uniformly to JSON, CSV, human-readable, and `--detailed` output paths. Zero-match emits a clear "No matching runs" message in the active output format (JSON `{error,runs:[]}`, header-only CSV, headerBox + warning text for human). Invalid `--since` exits with code 1 and a `console.error` matching the `locks.ts` pattern. `bin/cli.ts` registers both `.option()` calls. Documented in `README.md` §CLI Commands and `docs/reference/analytics.md` §"Filtering by Label or Date". 5 new tests in `src/commands/stats.test.ts` cover label match, label miss, `--since` cutoff, composed AND, and invalid-date rejection. Obsoletes the manual `jq` workflow from #462's closeout. (#640)
- **`--stacked` flag for `sequant run` — stacked-PR review surface on top of `--chain`** (#605). Implies `--chain` (and therefore `--sequential`); errors when combined with `--no-chain`. Behavior change is localized to PR creation: non-first PRs target their predecessor branch via `gh pr create --base <prev-branch>` instead of `main`, so reviewers see the incremental diff for each issue rather than the cumulative chain diff. The final PR still targets `main` so partial progress can land without merging the whole stack atomically. Each PR body includes a manifest line `Part of stack: #N1 → #N2 (this) → #N3` so reviewers see the chain at a glance. Plumbed through `RunOptions.stacked` → `IssueExecutionContext.chain.{predecessorBranch, stackManifest}` → `createPR` → `GitHubProvider.createPRCliSync(... base?)`. The orchestrator computes the predecessor branch from `worktreeMap.get(issueNumbers[i-1])?.branch` only for non-first, non-last positions in the chain. Existing chain-mode rebase logic (`!chainMode || isLastInChain`) is unchanged — intermediate branches still don't rebase onto `main`, preserving the stack structure. `/merger` skill gained a "Stacked PR Detection" section that warns on out-of-order merges (GitHub auto-updates dependent PR bases on predecessor merge, so order matters). Documented in `docs/reference/run-command.md` with the standard chain-mode reliability caveat (~29% whole-chain success rate). (#605)
- **Experimental TUI `nowLine` enrichment with sub-phase activity** — the multi-issue TUI dashboard's `now` line now surfaces a per-phase activity signal instead of the coarse `running <phase>` placeholder from #540. `ProgressCallback` gains an `"activity"` event variant whose `extra.text` carries a short snippet of agent output; `phase-executor` taps the existing agent-driver `onOutput` stream (already used for verbose passthrough) and re-emits each chunk through a new `ExecutionConfig.onActivity` hook, coalesced through a leading + trailing throttle (≤2 fires per ~100ms window via the new exported `createThrottledReporter(fn, intervalMs)` helper) to preserve the TUI's 10 Hz poll budget while still surfacing the latest chunk before the agent goes idle. `RunOrchestrator.applyProgressEvent` handles the new event by stripping ANSI CSI escapes (SGR colour codes plus cursor-movement, line-clear, and DEC private-mode toggles that can leak through chalk/ink), taking the last non-empty line (truncated at 200 chars), and updating both `currentPhase.nowLine` and `currentPhase.lastActivityAt` — so the "last activity Xs ago" stamp ticks. `getSnapshot()` substitutes the coarse `running <phase>` form whenever `lastActivityAt` is ≥5s stale, satisfying the AC-4 fallback without going blank. Activity events are filtered out by the non-TUI line renderer and the `-q` heartbeat in `run-progress.ts` (they only feed the TUI's `nowLine`). New `batch-executor` helper `withActivityHook(config, issue, phase, onProgress)` adapts `ProgressCallback` into `ExecutionConfig.onActivity` per-phase and is applied at all three `executePhaseWithRetry` call sites (spec, main loop, quality-loop). Tests: 7 cases in `run-state.test.ts` (activity-driven `nowLine` updates, multi-line-chunk last-non-empty-line extraction, SGR ANSI stripping, non-SGR CSI stripping incl. `\x1b[2K` / `\x1b[G` / `\x1b[?25l`, stale-phase ignore race, no-op on empty text, 5s coarse fallback); 3 cases in `batch-executor.test.ts` covering `withActivityHook` (undefined passthrough, event forwarding, error swallowing); 6 cases in `phase-executor.test.ts` covering `createThrottledReporter` (leading-edge, within-window drop with latest-stash, trailing fire of latest, no-trailing when idle, idle-window leading resume, `cancel()` drops pending); 2 cases in the new `src/commands/run-progress.test.ts` covering the activity-event filter for both the renderer and `-q` heartbeat branches. Follow-up to #540 / #542 (M1 TUI); option (b) "log-tail enrichment" from the issue body, implemented over the in-process agent stream instead of tailing a log file (the assumed `.sequant/logs/<issue>-<phase>.log` files do not exist in this codebase — `.sequant/logs/` holds aggregate JSON only). (#543)
- **Per-issue concurrency lock prevents concurrent sequant sessions** — new `src/lib/locks/` module (`LockManager`, `classifyStaleness`, `formatLockedMessage`) creates a file at `.sequant/locks/<issue>.lock` via `open(O_CREAT|O_EXCL)` when `sequant run` starts on each issue. A second session attempting the same issue is skipped with a clear error (`Issue #N is being worked on by PID P since T (cmd). Use --force to take over, or wait for the other session.`); the rest of the batch continues. Stale detection: same-host PID-dead → cleared immediately (covers SIGKILL); cross-host → cleared after 2h; same-host skill-shell (`skipPidCheck`) → cleared after a separate **6h** TTL (default `DEFAULT_SKILL_LOCK_TTL_MS`, override via `SEQUANT_SKILL_LOCK_TTL_MS=<ms>`). `--force` claims the lock unconditionally; `--force --signal-other` also SIGTERMs the prior PID (same-host alive only). Read-only commands (`sequant status <N>`, `sequant merge`, `/assess`) warn but proceed. New `sequant locks list`, `sequant locks clear <issue>`, `sequant locks acquire <issue>`, `sequant locks release <issue>`, `sequant locks check <issue>`, and `sequant locks check-batch <issue1> <issue2>…` subcommands. `check-batch` emits one canonical `⚠ #<N> held by …` line per held issue (text mode, ready to paste above a dashboard) or a structured `{ warnings, checked }` JSON object — used by `/assess` to consolidate per-issue probes into a single bash call. `/fullsolve` Phase 0.3 claims and Phase 5.5 releases the lock via the new `acquire`/`release` subcommands with `--skip-pid-check` (skill shells exit immediately, so stale detection falls back to age-only via a new optional `skipPidCheck: boolean` field in `LockFileSchema`); explicit release calls now run on every halt branch (spec failure, exec exhausted, generic abort) so aborted runs free the lock immediately rather than waiting for the 6h TTL. `/assess` Step 1 probes via `locks check-batch` and surfaces dashboard warnings when held but never blocks. Mirrored across `.claude/skills/`, `templates/skills/`, and `skills/` for all three skill directories. `SEQUANT_ORCHESTRATOR` env var disables all lock operations (no-op, matching `OrchestratorRenderer` pattern at `src/lib/cli-ui/run-renderer.ts:244`). `SEQUANT_LOCKS_DIR` overrides the lock directory for test isolation. Lock cleanup wired through `ShutdownManager.registerCleanup` plus `process.on('exit')` for uncaught-exception coverage; SIGKILL recovery happens on the next run via PID check. Tested with **42 unit cases** (stale detection matrix incl. `skipPidCheck` skill-shell path + separate `skillLockTtlMs` TTL boundary cases, atomic acquire, force semantics, orchestrator no-op, error format, list/clear, `releaseExternal` cross-PID release, orchestrator `lockedResults` batch flow — AC-18, `resolveSkillLockTtlMs` env parse) plus **integration tests** that spawn real child processes to verify `O_EXCL` atomicity, SIGKILL stale-recovery, and SIGINT → ShutdownManager → `releaseAll` cleanup (AC-16), AND **13 CLI-level integration tests** that exercise `dist/bin/cli.js` directly for the SKILL.md acquire→block→release→check contract, `check-batch` text/JSON/empty/orchestrator modes, and `--force --signal-other --skip-pid-check` skill-lock takeover. (#625)
- **Deterministic QA gap-check precheck script** — new `scripts/qa/precheck.ts` (~630 LOC + 30 passing tests in `scripts/qa/precheck.test.ts`) runs three deterministic gap-checks before the QA agent and writes structured findings to `.sequant/gap-precheck.json` (schemaVersion 1, exit code always 0): (1) **`fixtures`** — extracts verbatim motivating-example payloads from issue body (fenced code blocks + blockquotes + `Output:`/`Expected:`/`Actual:` prefix lines, excluding `Setup` / `Reproduction` / `Steps` headings), feeds §6d Q1 / §6c Step 4; (2) **`siblingGrep`** — pulls exported `function|const|class|interface|type` identifiers from the diff (`origin/main...HEAD` per `feedback_worktree_stale_main.md`) and greps for cross-file sibling sites in `src/`, `scripts/`, `bin/`, feeds §5; (3) **`acLiteralDiff`** — diffs AC checkbox IDs (`AC-1`, `AC-2`, …) from issue body vs PR body, feeds §1. `qa/SKILL.md` gains a new **Phase 0c: Precheck Findings** block (between Phase 0b and Phase 1 CI check) that runs the precheck inline and falls back to inline checks on missing/error/`not_applicable` output. §6c becomes a hard file-glob precondition (emit nothing when no `.claude/skills/**/SKILL.md` or `templates/skills/**/SKILL.md` files changed); §6c Step 4 now prefers precheck `fixtures.fixtures[]` over the inline `awk` extractor when present; §6d collapses from the 5-sub-prompt table to a single adversarial paragraph + `Findings:` slot. Mirrored across all three `qa/SKILL.md` copies (`.claude/skills/`, `templates/skills/`, `skills/`) — `npx tsx scripts/check-skill-sync.ts` reports `synced  qa/SKILL.md — 3/3 match`. Investigation written up at `docs/investigations/qa-precheck-extraction.md` with 22-row gate classification, per-PR run frequency table (citing #608's 50-PR window), section-size delta calibration (~−1,585 tok/invoke window-typical, ~−115 tok lower-bound), and **empirical 5-PR replay** (6 historical merged PRs via the new `--base-sha`/`--head-sha` flags: §6c gate skipped on 4/6 PRs, average ≈ −1,002 tok/PR, one real `acLiteralDiff` catch surfaced on #620). §6c precondition fix: greps **diff hunks** (added lines only) rather than current file content — content-grep originally triggered on 100% of skill-md PRs because every sequant SKILL.md mentions `grep|awk|jq|sed` in unrelated example code; diff-hunk grep triggers only when the change actually adds detection patterns. `extractIdentifiersFromDiff` skips indented (function-body local) declarations so cross-file sibling-grep surfaces real top-level decls only. Builds on #608's signal-to-noise data which classified §6c (0/11 actioned) and §6d (9/14 / 0 actioned) as remove-or-gate candidates rather than script candidates. (#609)
- **`sequant run` renderer follow-ups — frame stability, exec attempt counter, summary teardown, failure dedup** (#618 follow-up). Four post-launch fixes to the unified RunRenderer (#620) surfaced by a real `npx sequant run 608 604 -q` transcript:
  - **Item 1 — live-zone height cap**: `TTYRenderer` now bounds the live frame at `max(8, process.stdout.rows − 5)` (dropping to `rows − 7` when a banner is active). New `RenderOptions.rows`, `getRows()`/`getMaxLiveRows()` helpers, dynamic `effectiveRowCap()` derived from terminal height, and a belt-and-braces `clampFrameHeight()` truncation with overflow indicator. Excess issues spill to scrollback via the existing rollup row instead of overflowing log-update's cursor tracking and stacking duplicate frames. The dynamic cap only engages when `rows` is explicitly provided so existing tests / detached stdout retain pre-#624 behavior.
  - **Item 2 — summary teardown / width clamp**: `NonTTYRenderer.renderSummary` no longer hardcodes `columns: 80` — it shares the same column source as the TTY path and applies a new `SUMMARY_COLUMN_CAP = 110`. `TTYRenderer.renderSummary` and `renderRunSummary` apply the same cap. Eliminates the `├───────�ing:` corruption from the motivating transcript and prevents wide terminals from producing summary grids that overflow narrower readers (CI logs, VS Code panes).
  - **Item 3 — exec attempt counter**: events log on retried non-loop phases now shows `(attempt N/M)` (replacing the previous `(loop N/3)` literal); TTY status cell shows `loop N/M · last fail: <short reason>` while the loop phase is running. New shared `formatRetrySuffix(iteration, maxIterations, kind)` helper used by all three retry-suffix sites (NonTTY events log, TTY events log, TTY status header) — eliminates drift. `RenderOptions.maxLoopIterations` threaded from `settings.run.maxIterations` through `run-progress.ts` so the `M` denominator is data-driven instead of hardcoded `/3`. `ProgressEvent.iteration`, `emitProgressLine` `extra.iteration`, and `ProgressCallback`'s extra all extended; `batch-executor` populates `iteration` on every phase event (start/complete/failed) plus the surrounding loop phase events.
  - **Item 4 — failure dedup**: `IssueState.lastFailureSignature` + `firstAttemptForSignature` track the first occurrence of each normalized error. New exported `failureSignature(error)` helper strips ANSI escapes, lowercases, trims, and truncates to 80 chars. A three-state machine (`first-seen → abbreviated → final-full`) folds consecutive identical failures into `✘ #N <phase> (attempt K/M) (same failure as attempt J)`; the final allowed iteration re-emits the full text so divergent failures stay visible right up to max-iter. Applied uniformly in both `TTYRenderer.appendEventLine` and `NonTTYRenderer.emitEventLine`.
  - **Derived AC-D1**: test-mode `log-update` stub now tracks `replacementCount` and `lastFrame`; exposed via `TTYRenderer.getTestStub()` (`TTYTestStub` type) so frame-stability tests assert on replacement count instead of parsing buf.out.
  - **Tests**: 51 new cases in `src/lib/cli-ui/run-renderer-624.test.ts` covering all 15 ACs + 3 derived ACs, including a `replayTranscript()` helper that replays the verbatim #624 motivating transcript across both render paths at the AC-2.5 matrix of (columns × rows × issue count). All 3,059 existing tests still pass. (#624)
  - **Hardening pass (post-QA gap fixes)**: per-phase failure dedup — `lastFailureSignature` + `firstAttemptForSignature` moved from `IssueState` to `PhaseState` so cross-phase signature collisions (exec then qa with byte-identical normalized errors) no longer produce misleading `"same failure as attempt N"` text where N refers to a different phase. Removed `clampFrameHeight()` and `effectiveRowCap()` back-compat short-circuits; `DEFAULT_TERMINAL_ROWS` bumped from 24 to 100 so the cap engages unconditionally with a generous default in tests / detached stdout (AC-1.1 "regardless of issue count" now literally enforced). `TTYTestStub` gained `clearCalls` + `doneCalls` counters so AC-2.2 verifies the renderer actually invokes `logUpdate.clear()` + `logUpdate.done()`, not just that local stub state was reset. AC-2.3 strengthened to assert summary widths are identical at cols=110 and cols=200 (pins the 110-cap rather than relying on a 115-char slack). AC-2.4 and AC-2.1 both gained a box-char/alphanumeric-adjacency assertion (`/[─-╿][A-Za-z0-9]/u`) that catches the verbatim `├───────�ing:` corruption from the motivating transcript. AC-4.3 split into a literal `3-identical-with-maxIter=3` test and a renamed `(divergence)` test. New `emitProgressLine` iteration-propagation suite (5 cases) covers payload contents on start/complete/failed events and the SEQUANT_ORCHESTRATOR-unset no-op. New per-phase dedup positive test: exec-fail-then-qa-fail with same string emits full qa text, never abbreviates across phases. `@tautology-skip` pragma added to `run-renderer-624.test.ts` with a documented reason — the helper-wrapped construction (`makeTTY` / `makeNonTTY`) is a known false-positive class for the detector's imported-name body scan. AC-D3 retains the codepoint range `[─-╿]/u` (the canonical JS-regex equivalent of `\p{Block=Box_Drawing}` — V8 does not support the `Block` property name); the range is platform-agnostic, so the Windows-safety requirement is met without needing a Windows CI runner.
- **QA gap-check signal-to-noise investigation** — new `scripts/analytics/gap-signal.ts` mines QA / spec verdict comments from merged PRs, attributes each gap flag to its source SKILL.md section (§4 Q5, §5, §6c, §6d, spec sibling-site scan, spec AC linter), and classifies fate (`actioned_in_pr` / `filed_followup` / `dismissed` / `silent` / `not_triggered`). Outputs a JSONL row per flag plus a per-section action-rate + cost-proxy summary. Findings written to `docs/investigations/qa-gap-signal-to-noise.md`. Two clear remove/gate candidates surfaced over the 2026-04-01 → 2026-05-10 window (50 PRs, 134 flag rows): §6c (0/11 substantive findings, 156 SKILL.md lines) and §6d (9 findings, 0 actioned/filed). Recommendations feed #609. (#608)
- **Unified `sequant run` renderer — two-zone live grid + events log** — replaces the dual-output regression where the legacy `PhaseSpinner` (#244) and parallel-mode `▸/✔` lines (#458) both wrote stdout for single-issue runs and produced overwritten / missing-duration lines (`✔ #614 exec   #614 qa` collision repro). New `src/lib/cli-ui/run-renderer.ts` exposes a single `RunRenderer` interface with three strategy implementations: `TTYRenderer` (live grid redrawn ≤1Hz via `log-update` + append-only events log below; box-drawing collapses to indented key:value pairs at <80 cols; SIGWINCH triggers full redraw; `pause()`/`resume()` clears the live zone for verbose Claude streaming and re-renders on the next event), `NonTTYRenderer` (append-only `[HH:MM:SS]`-prefixed events with a 60s "still running" heartbeat when idle), and `OrchestratorRenderer` (no-op when `SEQUANT_ORCHESTRATOR` is set, so MCP `emitProgressLine` JSON is the only stdout). Auto-detected by `createRunRenderer()` from env + `process.stdout.isTTY`. Single-issue layout uses a key:value grid (Issue / Worktree / Branch / Status); multi-issue layout collapses done rows to `✔ done · {total} · {phases} · PR #N` and expands active rows with phase-by-phase progress; both modes append a `{N} done · {N} running · {N} queued · {N} failed` rollup. Final summary uses the same box-drawing with passed-row (single-line Detail) and failed-row (multi-line Detail with reason / verdict / log path) variants. `qa loop N/3` appears in the active status header per quality-loop iteration. Wiring extracted to `src/commands/run-progress.ts` (`buildProgressWiring()`) so `src/commands/run.ts` stays under the 200-LOC adapter cap (#503 AC-2). Legacy `src/lib/phase-spinner.ts` + test deleted (610 LOC); `formatElapsedTime` migrated to `src/lib/cli-ui/format.ts`. New `log-update@^7.0.1` dependency. Auto-detect runs render `Phase: detecting…` while spec is resolving the workflow plan (AC-23, opt-in via `IssueRegistration.autoDetect`). A stalled phase whose elapsed time exceeds half the configured `settings.run.timeout` flips its status header to `⚠ stalled · {phase} · {elapsed}` (AC-26; threshold defaults to disabled when no timeout is wired through). Multi-issue runs cap visible per-issue rows at `multiIssueRowCap` (default 10); excess oldest-done rows roll up into a single `✔ {N} done · rolled up` summary row at the top of the grid with an `(M of N shown)` indicator below (AC-28). Tests in `src/lib/cli-ui/run-renderer.test.ts` cover AC-1/2/3 (single owner, no duplicates, trailing `\n`), AC-4/8 (≤1Hz redraw + heartbeat tick), AC-5/6/7 (status cells + rollup), AC-9/16/17 (non-TTY append-only + 60s heartbeat), AC-11 (single-issue layout), AC-12-15 (summary grid), AC-18 (orchestrator no-op), AC-22 (loop iteration in header), AC-23 (detecting placeholder + non-auto-detect negative case), AC-25/32 (60/80/120-col width handling), AC-26 (stall flip + default-disabled negative case), AC-28 (row cap + at-cap negative case), AC-31 (lifecycle snapshots for passed + failed runs). (#618)
- **Behavior-rule cross-touchpoint detection in `/spec` and `/qa`** — new shared heuristic module `src/lib/heuristics/behavior-rule-detector.ts` exporting `detectBehaviorRule(ac)` (cheap keyword gate; ≥2 keywords from `default | always | never | rule | behavior | skip` OR explicit pattern like `always X unless Y`), `findTouchpoints(ac, repoRoot)` (proactive enumeration of likely implementation sites for `/spec`), and `findSurvivingInverseSymbols(ac, repoRoot, diffPaths)` (reactive scan for OLD-rule survivors inside the diff blast radius for `/qa`). `/spec` SKILL.md gains a `### Rule Touchpoints (Conditional)` subsection under `## Context Gathering` that emits a `## Rule Touchpoints` plan section when any AC triggers; `/qa` SKILL.md gains `### 6e. Behavior-Rule Survival Check` between §6d and §7, wired into the §7 verdict algorithm via the new `behavior_rule_survival_status` gate (`Survivors Found → AC_NOT_MET`). Shared reference doc at `_shared/references/behavior-rule-detection.md` documents trigger keywords, threshold, symbol categories, inverse-keyword map, false-positive guards, and the performance budget; both SKILL.md files link it via `../_shared/references/behavior-rule-detection.md`. Mirrored across `.claude/skills/`, `templates/skills/`, and `skills/`. Motivated by miss in #533 ("default /assess spec phase ON, remove bug/docs auto-skip"), where `/spec` scoped the work to a single SKILL.md, `/exec` implemented it, and `/qa` returned `READY_FOR_MERGE` while the runtime CLI's `BUG_LABELS`/`DOCS_LABELS` short-circuit in `phase-mapper.ts` and `batch-executor.ts` survived — caught only by manual user follow-up requiring two extra commits and four doc updates. Tests: 19 unit cases in `src/lib/heuristics/__tests__/behavior-rule-detector.test.ts` (verbatim #533 fixture, no synthetic markers, per `feedback_synthetic_test_fixture_trap.md`) + integration suites for `/spec` wiring, `/qa` wiring, and 3-dir sync. (#552, motivated by miss in #533)
- **`/qa` §7 verdict algorithm wires CHANGELOG gate** — `templates/skills/qa/SKILL.md` (mirrored to `.claude/skills/qa/` and `skills/qa/`) now includes a `changelog_required AND changelog_missing` branch in the §7 verdict-determination algorithm, sitting between `execution_evidence == "Incomplete"` and `quality_plan_status == "Not Addressed"`. Demotes `READY_FOR_MERGE` to `AC_MET_BUT_NOT_A_PLUS` when `CHANGELOG.md` exists, the feature branch contains user-facing conventional-commit prefixes (`feat:|fix:|perf:|refactor:|docs:`), and the `[Unreleased]` section lacks an entry — closes the orphan-rule gap where §10a's prose said *"Do NOT give READY_FOR_MERGE if CHANGELOG entry missing"* but §7's algorithm silently ignored it (surfaced during `/fullsolve 575` round-1). Reuses §10a's existing `CHANGELOG.md` file-presence and `[Unreleased]` checks rather than duplicating logic. No-op when `CHANGELOG.md` is absent (failsafe-off for projects without one) or when only non-user-facing prefixes (`chore:|test:|ci:`) are present. Caveat documented at §10a: conventional-commit dependency means non-conventional-commit projects silently skip the gate. (#585)
- **`-q` mode liveness heartbeat + stall warning** — `npx sequant run <issue> -q` no longer goes silent for the full phase duration. New `LivenessHeartbeat` (`src/lib/workflow/heartbeat.ts`) polls `.sequant/state.json` mtime every 30s and surfaces two signals: (1) a TTY-only `\r`-rewritten line `▸ #N <phase>  (Xm elapsed, last log update Ys ago)` so live terminals see continuous activity; (2) a one-shot stall warning `⚠ #N <phase>  no log activity for Xm Ys` (with optional `(phase timeout in N)` suffix from `settings.run.timeout`) that fires in both TTY and non-TTY modes when the mtime gap exceeds 5 minutes — informational signal that's valuable in CI logs too. Single shared `setInterval` across parallel phases (one `fs.statSync` per phase per tick), `unref()`-ed so it never keeps the event loop alive. Suppressed entirely in non-quiet and `--tui` modes. Liveness source uses existing infrastructure — `StateManager.saveState()` writes 3-10x per phase. Wired in `src/commands/run.ts` only when `options.quiet === true && !tuiEnabled`, with `try/finally` cleanup on completion. (#574)
- **Markdown-only CI relaxation in `/qa`** — when `git diff origin/main...HEAD --name-only` shows only `.md` files (with explicit denylist for `package.json`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `tsconfig*.json`, `*.config.{js,ts,mjs,cjs}`, and `.github/workflows/**`), pending CI checks matching `qa.markdownOnlySafeCiPatterns` (default `["build (*)", "Plugin Structure Validation"]`) are now reclassified as informational and do not force `NEEDS_VERIFICATION`. New `qa.markdownOnlyCiRelaxed` settings flag (default `true`) gates the behavior; setting it to `false` restores the prior strict behavior. Failed CI checks always gate regardless of diff type, and pending checks outside the configured allowlist (e.g. `validate-skills`, `Hooks Validation`) still gate. New `src/lib/qa/markdown-only-ci.ts` exports `detectMarkdownOnlyDiff()` and `filterRelaxablePending()` (single-`*`-wildcard glob matcher with anchored, regex-escaped patterns); `/qa` SKILL.md `### CI Status` section now invokes them via inline `npx tsx -e` and emits a `Markdown-only diff detected — pending build-matrix checks treated as informational. Relaxed: <names>` transparency note when relaxation triggers. Mirrored across all three `qa/SKILL.md` copies (`.claude/skills/`, `skills/`, `templates/skills/`). (#569)

### Security

- **Resolve npm audit findings — Cluster 1 fixed, Cluster 2 waived** — `npm audit fix` (no `--force`) bumps three transitive dependencies in `package-lock.json`: `fast-uri 3.1.0 → 3.1.2` (high — path traversal via percent-encoded dot segments + host confusion via percent-encoded authority delimiters; reachable via `@modelcontextprotocol/sdk → ajv`), `ip-address 10.1.0 → 10.2.0` (moderate — XSS in `Address6` HTML-emitting methods; reachable via `@modelcontextprotocol/sdk → express-rate-limit`), and `express-rate-limit 8.3.2 → 8.5.1` (moderate — transitive vehicle for `ip-address`). Lockfile-only diff (10 insertions / 10 deletions); no `package.json` change. Post-fix `npm audit`: 0 high, 2 moderate (was 1 high + 4 moderate). Remaining `@anthropic-ai/sdk@0.81.0` insecure-default-file-permissions advisory (GHSA-p7fg-763f-g4gf, range `>=0.79.0 <0.91.1`) waived for now: the local-filesystem memory tool is not used in this repo (`grep -r memoryTool src/` → 0 hits; only `query()` is consumed by `src/lib/workflow/drivers/claude-code.ts`), and the parent `@anthropic-ai/claude-agent-sdk@0.2.138` still pins the vulnerable range — Option B (wait for upstream agent-sdk release via Dependabot) chosen over `package.json` `overrides` to avoid debt that would be reversed when upstream lands. (#614)

### Fixed

- **MCP `sequant_run` log-file lookup races on concurrent runs and stale same-issue logs** — `readLatestRunLog` in `src/mcp/tools/run.ts` used a recency window (`fileTime >= runStartTime − 5m`) plus `.sort().reverse()` to pick the run-log to surface to MCP callers, so two overlapping `sequant_run` invocations could see each other's logs (filter passes for both filenames; lexicographic ordering wins) and a same-issue run within 5 minutes of a previous one could surface the stale log when the new file hadn't yet hit disk. Fix threads the `runId` through the CLI → MCP stderr channel: new `emitRunIdLine(runId)` in `src/lib/workflow/batch-executor.ts` writes `SEQUANT_RUN_ID:<uuid>\n` to stderr immediately after `LogWriter.initialize()` in `run-orchestrator.ts` (gated on `SEQUANT_ORCHESTRATOR`, mirroring `emitProgressLine`); the MCP tool handler captures the first such line via the existing line-buffer (now always-on, was previously gated on `progressToken`) and uses a new `readRunLogById(runId)` helper that does an exact `endsWith(-<runId>.json)` match against the log directory. Fallback to `readLatestRunLog(runStartTime)` when no `runId` was captured (older CLI, startup race) or the lookup returned null, so behavior degrades to today's path rather than worse. Carved out from #508 per the 2026-04-09 architecture review — the parent in-process MCP rewrite remains parked; this is the localized bug fix. (#631)
- **`isBranchMergedIntoMain` false-positive on empty orphan branches** — `src/lib/workflow/pr-status.ts`'s branch-merge check no longer relies on `git branch --merged main`, which lists *any* branch whose tip is reachable from the base — including empty branches whose tip equals an old `main` ancestor with zero commits added. After a SIGINT-interrupted `npx sequant run` left orphaned `feature/<N>-...` branches around (worktree removal does not delete the branch), the next run's `reconcileStateAtStartup` would advance those issues from `in_progress` to `merged` via `isIssueMergedIntoMain`'s `Method 1`, and the pre-flight guard in `run-orchestrator.ts:472-498` would skip them as "already merged — skipping (use --force to re-run)" — even though the issues were still `OPEN` on GitHub. The new check resolves the branch tip via `git rev-parse <branchName>` and only returns `true` if the tip is recorded as a non-first parent of a merge commit on the base branch (`git rev-list --merges --parents -200 <baseBranch>`). Empty branches whose tip is just an ancestor of `main` no longer satisfy this — they're never "merged" because no merge commit ever recorded them. Squash-merged branches were already correctly handled by `Method 2`'s `(#N)` / `Merge #N` commit-message grep, which is unchanged. Existing `#305` tests in `src/lib/workflow/state-utils.test.ts` migrated from `git branch --merged` mocking to `git rev-parse` + `git rev-list --merges --parents` mocking; new regression test `regression: empty feature branch from interrupted run is NOT detected as merged` mirrors the production repro on issue numbers 608/604. The inverse direction (state thinks open, GitHub says merged) was previously fixed in #592/#606. (#616)
- **`/spec` AC linter — title/body tension coverage tightening** — `detectTitleBodyTension` in `src/lib/ac-linter.ts` now splits the AC description on `.`/`\n`/`:`/`—` (was `.`/`\n` only), catching common AC styles that use colon or em-dash as the title/body separator (`Documentation note: trigger /fullsolve and capture output`, `Doc snippet — trigger workflow and capture output`). Single-word runtime imperatives (`execute`, `trigger`, `capture`, `reproduce`) now match common inflections via stem-aware regex construction: `\b<stem>(?:s|ed|ing)?\b` for non-`e`-ending verbs and `\b<stem>(?:e|es|ed|ing)\b` for `e`-ending verbs, so `triggered`/`triggering`/`captured`/`capturing` all warn. Multi-word phrases (`verify by running`, `confirm at runtime`) keep literal `\b<phrase>\b` matching. Replaced the paraphrased "motivating example from #562 AC-5" test fixture (`src/lib/ac-linter.test.ts`) with the verbatim issue-body string, plus three new fixtures covering the colon separator, em-dash separator, and inflected `captured`/`triggered`. SKILL.md `AC Quality Check` row mentions broadened separators and inflections; mirrored across `.claude/skills/spec/`, `skills/spec/`, and `templates/skills/spec/`. (#597)
- **`sequant run` re-executes `waiting_for_qa_gate` issues already merged on GitHub** — `reconcileStateAtStartup` (`src/lib/workflow/state-cleanup.ts`) now also escalates `waiting_for_qa_gate` entries to `merged` when `checkPRMergeStatus` reports the PR as `MERGED` or `isIssueMergedIntoMain` finds the branch in the base. Symmetric sibling fix to #592 (which covered `in_progress`): when a PR awaiting human QA-gate approval is merged externally (web UI, `gh pr merge`, separate process) before sequant's next QA-gate run, local `state.json` previously kept `status: "waiting_for_qa_gate"` and the pre-flight guard at `run-orchestrator.ts:472-498` (which only short-circuits `ready_for_merge`/`merged`) let the issue through, causing `sequant run <N>` to re-execute the QA phase against already-merged work. Loop-guard relaxation only — existing PR-status check, git fallback, state mutation, and `resolvedAt` stamp are unchanged. New `state-cleanup.test.ts` cases mirror the #592 mocked-`GitHubProvider` pattern: one for the `waiting_for_qa_gate` → `merged` escalation, one for the offline (PR status null) fallthrough that leaves status untouched. (#606)
- **`sequant run` re-executes `in_progress` issues already merged on GitHub** — `reconcileStateAtStartup` (`src/lib/workflow/state-cleanup.ts`) now also escalates `in_progress` entries to `merged` when `checkPRMergeStatus` reports the PR as `MERGED` or `isIssueMergedIntoMain` finds the branch in the base. Previously, only `ready_for_merge` was reconciled, so when a PR was merged outside the current sequant session (separate process, `gh pr merge`, web UI, force-push), local `state.json` could keep `status: "in_progress"` indefinitely — the pre-flight guard at `run-orchestrator.ts:472-498` then let the issue through, exec spawned for ~3 minutes producing no diff, and the generic MCP fallback retry burned another spawn (live repro: `npx sequant run 583 580 568` after `#568`/PR #590 merged outside the running sequant session). With the fix, `state.json` advances to `merged`, the existing pre-flight guard skips with its current voice (`already merged — skipping (use --force to re-run)`), and `--force` continues to bypass. New `src/lib/workflow/state-cleanup.test.ts` covers the in_progress→merged escalation with mocked `GitHubProvider`, plus the offline (PR status null) fallthrough and a regression for `ready_for_merge`. (#592)
- **`/exec`, `/testgen`, and docs reference wrong `new-feature.sh` and `list-worktrees.sh` paths** — followed the same root cause as #583 (canonical scripts live at `./scripts/<name>.sh`; `./scripts/dev/` is gitignored). Replaced 21 occurrences across all three mirrors of `exec/SKILL.md` and `testgen/SKILL.md`, plus 7 occurrences in `docs/concepts/worktree-isolation.md`, `docs/features/exec-qa-phase-guards.md`, `docs/guides/git-workflows.md`, and `docs/internal/testing.md`. Updated the `Bash(./scripts/dev/new-feature.sh:*)` allowlist in `exec/SKILL.md` to the canonical path, and added literal `Bash(./scripts/new-feature.sh:*)` and `Bash(./scripts/list-worktrees.sh:*)` entries alongside the existing `Bash(./scripts/dev/*:*)` wildcard in `fullsolve/SKILL.md`. (#596)
- **`/fullsolve` & `/exec` reference wrong cleanup-worktree.sh path** — Phase 5.3 of `/fullsolve` and the Worktree Cleanup section of `/exec` referenced `./scripts/dev/cleanup-worktree.sh` (gitignored — `scripts/dev/` only exists in private setups), causing `127: no such file or directory` when users ran the suggested next-step command. The `Bash(./scripts/dev/cleanup-worktree.sh:*)` allowlist pattern in `exec/SKILL.md` also missed the canonical `./scripts/cleanup-worktree.sh` path. Replaced 9 occurrences across all three mirrors of `exec/SKILL.md` and `fullsolve/SKILL.md`, plus 2 occurrences in `docs/concepts/worktree-isolation.md` and `docs/internal/testing.md`. (#583)
- **`/fullsolve` QA loop re-runs `/qa` indefinitely on same-SHA same-verdict cycles** — `/fullsolve` previously consumed `MAX_QA_ITERATIONS=2` even when `/loop` produced no commit and no working-tree change between cycles, wasting full QA invocations to redact identical `AC_NOT_MET` verdicts at the same HEAD SHA (concrete repro: 3 sequential identical QA failures on #570 at SHA `cb77c8e6`). Two new escalation gates short-circuit the cycle: (1) `/fullsolve` §4.3 QA Loop runs `npx tsx scripts/qa-stagnation.ts detect <issue>` before each `/qa` re-invocation after iteration 0 — when the prior `qa:failed` phase marker's `commitSHA` matches HEAD AND `git status --porcelain` is empty, it records a `SAME_SHA_NO_PROGRESS` telemetry entry and breaks the loop instead of re-QAing identical state; (2) `/loop` adds a new "Step 5.5: No-Diff Guard" that takes a before/after `snapshotLoopProgress()` snapshot pair and exits with `LOOP_NO_DIFF` when neither HEAD nor the working-tree (excluding `.sequant/` state writes per the issue's open question) changed. New `src/lib/workflow/qa-stagnation.ts` exports `detectStagnation()`, `recordStagnation()`, `snapshotLoopProgress()`, and `compareLoopProgress()`; new `scripts/qa-stagnation.ts` CLI shim (`detect`/`record`/`snapshot`/`compare-snapshot`) so SKILL.md and tests exercise the same code path. Additive `QAStagnationEntrySchema` on `IssueState` (`qaStagnation: [{sha, verdict, iteration, reason, detectedAt}]`) preserves stagnation history across `.sequant/state.json` runs without breaking older state files. Mirrored across all three SKILL.md copies for both `fullsolve/` and `loop/`. New `src/lib/workflow/qa-stagnation.test.ts` (24 tests) covers all `detectStagnation()` decision branches, `recordStagnation()` persistence + additive append, `compareLoopProgress()` diff classification, the `.sequant/` exclusion in the porcelain parser, and a 4-test integration suite that drives a stub QA loop against a real git worktree to prove halt at iteration 1 (NOT `MAX_QA_ITERATIONS=2`) when `/loop` returns no diff. (#581)
- **`cleanup-worktree.sh` aborts mid-cleanup when invoked from inside the worktree being deleted** — `templates/scripts/cleanup-worktree.sh` now resolves the main worktree once via `git worktree list --porcelain` and `cd`s there *before* the `.exec-agents/agent-*` cleanup loop and the main `git worktree remove --force`, instead of after only the latter. With cwd inside `$WORKTREE_PATH` (the documented repro) or inside one of its `.exec-agents/agent-*` sub-worktrees (a related case the prior pass left exposed), every subsequent `git`/`gh` call previously inherited a deleted cwd and either errored with `Unable to read current working directory` or silently no-op'd under the `2>/dev/null || true` guards — leaving the local branch, remote branch, and `main` update steps half-executed. The `MAIN_WORKTREE` and `WORKTREE_PATH` resolutions also switch from `awk '{print $1/$2}'` over the human-readable `git worktree list` output to a porcelain parse, so worktree paths containing whitespace are no longer truncated at the first space and branch lookup matches the actual ref instead of free-form-grepping the entire line. (#575)
- **`pre-tool.sh` regex follow-up to #564** — wrapped four additional regex sites (destructive system commands, deployment commands, `git reset --hard` outer guard, `gh workflow run`) with the `^gh (issue|pr) ` exclusion idiom across all three mirrored hook copies (`templates/hooks/`, `hooks/`, `.claude/hooks/`). Previously, `gh issue create` / `gh pr create` / `gh issue comment` / `gh pr comment` calls whose body text merely *referenced* tokens like `rm -rf /`, `vercel deploy`, `git reset --hard`, or `gh workflow run` (e.g. release notes, tutorials, doc explainers) were blocked at the tool-call level. Closes the gap surfaced during /fullsolve QA on 2026-05-03 where #564 deliberately scoped only the force-push and `git commit` regexes. (#570)
- **`/fullsolve` quality-loop misroute** — fixed unqualified `Skill("loop")` calls in fullsolve SKILL.md resolving to Anthropic's top-level recurring-prompt `loop` skill instead of sequant's quality-loop skill, causing the workflow to silently prompt the user to schedule a recurring task instead of running the test/QA fix iteration. All 6 occurrences across the 3 mirrored fullsolve SKILL.md files (`.claude/skills/`, `skills/`, `templates/skills/`) now use the qualified form `Skill("sequant:loop", ...)`. (#562)

### Added

- **`/spec` AC linter — title/body verification-method tension** — new `title-body-tension` rule in `src/lib/ac-linter.ts` warns when an AC's title implies a documentation bar (head text up to first `.`/`\n` contains `note`/`comment`/`documentation`/`description`/`snippet`/`entry`/`mention`) while its body specifies a runtime/execution bar (contains `execute`/`trigger`/`capture`/`verify by running`/`reproduce`/`confirm at runtime`, or a `run /<slash-command>` pattern). Warning-only — same convention as `vague`/`unmeasurable`/`incomplete`/`open_ended`. Suggestion offers two resolutions: `(a)` tighten the title to match the runtime body, or `(b)` split the runtime requirement into a separate AC. SKILL.md `AC Quality Check` table mirrored across `.claude/skills/spec/`, `skills/spec/`, and `templates/skills/spec/`. Closes the gap motivated by #562 AC-5, where the exec phase implemented to the title (wrote a doc note) and QA marked MET, while the runtime evidence requirement surfaced only on post-merge review. (#571)
- **`lint:skill-calls` CI guard for unqualified `Skill()` calls** — new `scripts/lint-skill-calls.ts` walks every `**/*.md` under `.claude/skills/`, `templates/skills/`, and `skills/` (not just `SKILL.md` — referenced markdown is loaded by the harness too), flagging any `Skill(skill: "<name>", ...)` invocation whose `<name>` matches an Anthropic top-level skill currently registered in the harness `available-skills` block (`loop`, `security-review`, `init`, `review`, `simplify`, `schedule`, `claude-api`, `update-config`, `keybindings-help`, `fewer-permission-prompts`) and is not qualified as `sequant:<name>`. Detects both single-line `Skill(skill: "loop", ...)` and the multi-line readable form `Skill(\n  skill: "loop",\n  ...\n)` by running the regex against full file content rather than per line. Exits 1 on violations and prints `file:line` plus the offending snippet. Wired into the existing `validate-skills` GitHub Actions job as a new `Lint skill calls` step and exposed locally via `npm run lint:skill-calls`. Pre-emptively guards the same silent-misroute pattern that #562 fixed for `loop`, before a future contributor or LLM agent reintroduces it under a different colliding name (notably `security-review`, where sequant ships `sequant:security-review` and Anthropic ships a top-level `security-review`). Per #562 AC-3, no existing non-colliding bare-name calls are touched. CLAUDE.md gains a one-paragraph `## Skills` note pointing at the lint script. (#568)
- **Predicted file-collision detection in `/assess`** — Step 5 now also scans the bodies of unstarted PROCEED issues and predicts which pairs will modify the same file once both run in parallel worktrees, complementing the existing active-worktree overlap pass. Predicted collisions emit an `Order: A → B (qa/SKILL.md)` line plus a `⚠ #N  Modifies qa/SKILL.md (overlaps #M); land sequentially` warning per affected issue, and a `Chain:` suggestion when ≥3 issues collide on the same file (suggest-only, never auto-applied). Heuristics: backtick-quoted source paths under `.claude/`/`templates/`/`skills/`/`src/`/`bin/`/`docs/`, plus bare `<name>/SKILL.md` and `/<skill>` slash-command mentions when the body signals "3-dir sync"/"across all three skill directories". Skill-mirror prefixes are normalized to the canonical bare form (`qa/SKILL.md`) so the three mirrors of one logical conflict deduplicate to a single `Order:` line instead of triple-emitting. False-positive guards strip fenced code blocks and HTML comments before extraction, and globally-shared paths (`CHANGELOG.md`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) are excluded so they never trigger collisions on every batch. New exports in `src/lib/assess-collision-detect.ts`: `extractPathsFromIssueBody()`, `detectFileCollisions()`, `formatCollisionAnnotations()`, `EXCLUDED_PATHS`. Tunables documented in the assess skill's new `references/predicted-collision-detection.md`. (#556)
- **Detection-pattern verification in `/qa`** — new Section 6c "Detection Pattern Verification" triggers when a PR adds or modifies `grep`/`awk`/`jq`/`sed` commands or regex literals inside `.claude/skills/**/*.md`, `templates/skills/**/*.md`, or `skills/**/*.md`. For each detected pattern, QA must (a) identify the intended corpus from the surrounding skill prose, (b) sample ≥5 real instances, (c) execute the pattern against each, and (d) record match counts in a Pattern / Corpus / Samples / Expected / Actual / Status output table. Snippets quoted in the issue body as motivating examples — blockquotes, fenced blocks under non-Setup headings, and `**Verify:**` / `**Verbatim:**` / `**Example:**` / `**AC verification:**`-prefixed lines — are treated as mandatory test fixtures. Verdict gate is stricter than Section 6a: `Failed → AC_NOT_MET` (silent detection failures are worse than wrong CLI flags). Adds `Adversarial re-read of core logic` checkbox to both Simple Fix Mode and Standard QA Output Verification checklists. Closes the gap exposed by PR #547, where 3 silent regex/awk/jq detection bugs shipped through `/qa` because Section 6a only verified command syntax, not whether patterns matched their intended corpus. (#551)
- **`--security-review` additive CLI flag** — symmetric counterpart to `--testgen`. `npx sequant run <issue> --security-review` inserts the `security-review` phase after `spec`, replacing the longer `--phases spec,security-review,exec,qa` form. Idempotent vs label-based auto-detection (`auth`/`security` labels): the flag does not duplicate the phase when both signals are present. Honours `SEQUANT_SECURITY_REVIEW=true` env override mirroring the testgen pattern, and applies during resume (when spec already ran) by inserting at the front of the remaining phase list. `/assess` SKILL.md Rule 8 now lists both `--testgen` and `--security-review` as additive flags; the prior asymmetry note is gone. (#559)
- **Prior assessment detection in `/assess`** — `/assess` now scans existing issue comments for prior `<!-- assess:action=... -->` markers before posting. New comments prepend a supersession header (`Supersedes prior assess from <date> (<action>)` for one prior, `Supersedes N prior assessments (most recent: <date>)` for multiple). When ≥3 priors exist with no intervening exec phase marker, the dashboard emits a re-assessment churn warning. When the new recommendation conflicts with a prior `PROCEED` or `REWRITE`, the user is prompted to confirm via `AskUserQuestion` before posting (skipped for prior `CLOSE`/`PARK`/`CLARIFY`/`MERGE`). New parser exports in `src/lib/assess-comment-parser.ts`: `findAllAssessComments()`, `buildSupersessionHeader()`, `detectChurn()`, `shouldPromptOnConflict()`. Detection matches the durable HTML action marker — works on production dashboard-format comments that lack the legacy `## Assess Analysis` prose header. (#555)
- **Stray `$HOME/node_modules/sequant` detection** — CLI startup now resolves its own install root and emits a distinct warning when sequant is running from `$HOME/node_modules/sequant` exactly. The warning names the resolved path and lists the cleanup commands (`remove $HOME/node_modules`, `remove $HOME/package.json` and `package-lock.json`) plus the legitimate alternatives (`npm install -g sequant`, Claude Code plugin). Project-local installs continue to receive the existing generic warning; global installs (POSIX `<prefix>/lib/node_modules/sequant` — e.g. `/usr/local/lib/node_modules`, `/opt/homebrew/lib/node_modules`, `~/.nvm/.../lib/node_modules` — and Windows `%AppData%\[Roaming\]npm\node_modules\sequant`) are now excluded from the project-local warning as well. New exports: `getInstallRoot()`, `isHomeStrayInstall()`, `isGlobalInstall()`, `buildHomeStrayWarning()` in `src/lib/version-check.ts`. (#539)

### Changed

- **Subagent model tiers realigned + `sequant doctor` upstream-bug warning** — `sequant-qa-checker` declared model bumped from `haiku` → `sonnet` to match the community baseline for code-review-adjacent agents (sampled across 144 agents in VoltAgent/awesome-claude-code-subagents); `sequant-explorer` and `sequant-testgen` keep `haiku`. Each agent file (`.claude/agents/` + `templates/agents/`) gains an inline `# Note: per anthropics/claude-code#43869 this is currently a no-op; agent runs on parent's model` comment because [anthropics/claude-code#43869](https://github.com/anthropics/claude-code/issues/43869) currently ignores every subagent `model:` declaration. `sequant doctor` now emits an unconditional one-line warning (suppressible via `--quiet`/`-q`) citing #43869 and linking the upstream issue, with a second-line `Note: agents.model is currently inert (see #43869).` when the user's `agents.model` differs from the shipped default. `AgentSettings.model` is marked `@deprecated` in `src/lib/settings.ts` but kept in the Zod schema so existing user `.sequant/settings.json` files with `"model": "haiku"` continue to parse. Docs audit: `docs/features/declarative-agents.md` gains a "Known Upstream Limitations" subsection and updated agent table; `docs/features/plugin-distribution.md`, `docs/concepts/workflow-phases.md`, and the three-way-mirrored `_shared/references/subagent-types.md`, `testgen/SKILL.md`, `exec/SKILL.md`, `setup/SKILL.md`, and `spec/references/parallel-groups.md` annotate or rewrite haiku claims so the audit-gate grep `grep -rn '\bhaiku\b' .claude/ templates/ docs/ src/lib/settings.ts` returns only updated tiers or explicit "inert per #43869" notes. The `[model: ...]` parser in `exec/SKILL.md` and inline `model="haiku"` examples are kept intact (with `# Note: model param inert per anthropics/claude-code#43869` comments) so they reactivate automatically when the upstream fix ships. (#632, refs anthropics/claude-code#43869)
- **`/qa` §10a `user_facing` detection broadened to scoped conventional commits** — regex updated from `^[a-f0-9]+ (feat|fix|perf|refactor|docs):` to `^[a-f0-9]+ (feat|fix|perf|refactor|docs)(\([^)]*\))?!?:` in all three `qa/SKILL.md` mirrors (`templates/skills/qa/`, `.claude/skills/qa/`, `skills/qa/`). The new pattern accepts unscoped (`feat:`), scoped (`feat(#NNN):`), breaking (`feat!:`), and scoped-breaking (`feat(scope)!:`) forms while still rejecting non-user-facing prefixes (`chore:`, `test:`, `ci:`, `build:`, `style:`). Closes the dogfood gap from PR #601 QA: the §7 wiring shipped in #585 was correct but the upstream §10a regex matched only unscoped form, so the gate silently no-op'd on sequant's own commits (26/26 audited recent commits use scoped form `feat(#NNN):`) — including the `/fullsolve 575` regression case the original issue cited. §10a's "Caveat — conventional-commit dependency" paragraph rewritten to enumerate the prefix list with optional scope and `!` markers, so readers can predict gate triggering without reading the regex. (#610)
- **`/assess` chain-mode suggestion now annotates length≥3 with historical success rate** — `formatCollisionAnnotations` in `src/lib/assess-collision-detect.ts` appends `(chain length≥3 historically 1/6 = 17%; see docs/reference/chain-mode-analysis-2026-05.md)` to the `Chain:` suggestion when ≥3 issues collide on the same file, so users see the historical-rate context inline next to the parallel-mode default. The length≥3 emit threshold itself is unchanged — annotation route was chosen over a hard threshold flip given the n=7 sample size; re-evaluate at n≥20. Three skill mirrors of `predicted-collision-detection.md` (`.claude/skills/`, `templates/skills/`, `skills/`) updated in lockstep, and `src/lib/__tests__/assess-collision-detect.test.ts` asserts both annotation substrings on every length≥3 collision. Also refreshes `docs/features/parallel-execution.md` (perf table: chain rate `50% n=4` → `29% n=7` with length-2/3/4 breakdown), `docs/reference/run-command.md` (perf warning), and adds the forensic write-up at `docs/reference/chain-mode-analysis-2026-05.md` (failure classification across all 7 chain runs in `.sequant/metrics.json`, top-3 failure modes, RESTRICT-to-length=2 verdict, per-issue counterfactual showing 61.5% success when chain mode actually reaches an issue). (#604)
- **`/qa` Adversarial Re-Read structured section** — promoted the existing single-line "Adversarial re-read of core logic" output-verification checkbox to a required structured Section 6d for non-Simple-Fix Standard QA before `READY_FOR_MERGE`. Adds 5 sub-prompts (verbatim fixtures, evidence framing, process state, sibling sites, out-of-scope/Non-Goals) with concrete pass criteria, a Status outcome (Clean/Gaps Found/Severe Gap), and verdict gating: `Severe Gap → AC_NOT_MET` (verbatim motivating-example fixture not run, evidence claim conflated as bug repro vs. validation, AC marked MET without runtime/corpus check the AC text required) and `Gaps Found → AC_MET_BUT_NOT_A_PLUS` (non-blocking gaps to address as follow-up). Mirrored in the Standard output template between Risk Assessment and Verdict; Simple Fix mode is exempt. Wires `adversarial_reread_status` into the Verdict Determination Algorithm's verification gates. Operationalizes `feedback_qa_second_look.md` and `feedback_motivating_example_regression.md` at the structural level — `/fullsolve 570`'s first-pass QA passed READY_FOR_MERGE while a manual "any gaps?" prompt surfaced 3 real gaps; this section forces that second look on every QA. Mirrored across all three `qa/SKILL.md` copies. (#582)
- **`/spec` Sibling-site Scan prompt** — adds a conditional planner prompt to `/spec` SKILL.md `## Context Gathering` that fires when a focused AC has ≥3 instances of the affected pattern in the same file (e.g. regex blocks in `pre-tool.sh`). Planner scans the same file/module and surfaces sibling sites as either an Open Question proposing scope expansion or a recommended follow-up issue — the user decides; never silently widen scope. Symmetric to #573's `/qa` mirror, moved earlier where catching siblings is strictly cheaper. Mirrored across all three `spec/SKILL.md` files. (#580)
- **`/qa` Sibling-site Scan prompt** — adds a conditional reviewer prompt to `/qa` SKILL.md §5 Risk Assessment that fires before the verdict on focused-AC PRs touching multi-pattern files (≥3 instances of the affected pattern). Reviewer scans the same file/module for sibling code matching the bug's root cause; findings surface in a new `Sibling sites considered:` template slot as expanded scope (only when trivial) or follow-up issue, never mid-PR scope creep. §5 is now `REQUIRED` (no SMALL_DIFF carve-out); the prompt is orchestrator/inline scope, not delegated to `sequant-qa-checker` sub-agents. Mirrored across all three `qa/SKILL.md` files. Closes the gap from `/fullsolve 564` (#570). (#573)
- **`/qa` Section 6c calibration refinements** — tightens the Step 1 detection regex from per-tool clauses (`grep -[A-Za-z]+`, `awk [\x27"]`, …) to a single unified `\b(grep|awk|jq|sed) [-\x27"]` rule that also catches `jq -r '.field'`, `sed -n '...'`, `awk -v VAR=val '...'` and other modifier-flag forms. Adds an `Insufficient Samples` status rung (corpus reachable but <5 representative instances) → maps to `AC_MET_BUT_NOT_A_PLUS`, so reviewers can no longer silently mark `Passed` with sparse corpora; the new rung is wired into the Step 5 status table, the Section 6c verdict gating table, the Section 7 algorithm, and the `detection_pattern_status` value list. Replaces `gh search issues "SEQUANT_PHASE spec"`-style sampling recipes with `gh api 'repos/{owner}/{repo}/issues/comments' --paginate -q '.[] | select(.body | contains("…"))'` because GitHub's full-text index does not reliably cover HTML-comment markers and `:`-bearing query strings (`assess:action`) parse as search qualifiers and return empty. (#551)
- **`/assess` emits minimal command flags** — generated `sequant run` examples now omit `--phases` when the resulting workflow equals the CLI default (`spec,exec,qa`) and prefer additive flags like `--testgen` over restating the full phase list. The posted `<!-- assess:phases=… -->` marker still records the full resolved workflow for parsers; only the displayed command is shortened. SKILL.md `Order:` annotation rule also gains a filename-as-reason exception for file-collision cases. (#554)
- **/docs skill classifier** routes infra/scaffold paths (`package.json`, `*.config.*`, `.env.example`, layout/page files, middleware) to the `developer-tool` template instead of falling through to `admin`. Default fallback is now `developer-tool`; `admin` template is opt-in via `/admin/` path only (#531)

### Added

- **Manual Test AC enforcement gate** — `/qa` now detects ACs with `**Verification:** Manual Test` (and freeform patterns like `try X, confirm Y`) from `/spec` comments and requires runtime execution or an approved override before marking them `MET`. Unexecuted manual-test ACs are marked `PENDING`, forcing `NEEDS_VERIFICATION` verdict. Override mechanism mirrors Section 11a with approved categories: `no runtime surface`, `equivalent unit test coverage`, `tested in sibling issue` (#529)
- **Experimental multi-issue TUI dashboard** — `sequant run --experimental-tui` renders a live, ink-based dashboard with one box per issue (header / context / activity cells), rotating border colors, per-phase progression row, and a 1 Hz elapsed timer. Auto-falls back to the existing linear output when stdout is not a TTY (#540)
  - New `RunOrchestrator.getSnapshot()` exposes a point-in-time view of the run for read-only consumers
  - `nowLine` in this milestone is phase-coarse (e.g. `running exec`); per-file activity is deferred to a follow-up
- **QA short-circuit on unchanged commit** — `/qa` now skips the full sub-agent pipeline when the latest `qa:completed` phase marker's `commitSHA` matches current `HEAD`. Bypass with `/qa <N> --force` or `/qa <N> --no-cache`. Failed prior runs (status=`failed`) never short-circuit. New `status:"completed"` markers include a `verdict` field so the short-circuit summary surfaces the prior verdict; legacy markers without the field fall back to `(see prior QA comment)`. Marker detection streams comment bodies via `.comments[].body` (raw) rather than `[.comments[].body]` (JSON-escaped) so the grep pattern actually matches. (#530)

### Changed

- **Default workflow: spec phase ON for bug/docs issues** — the "skip spec when (bug/docs label AND no domain labels)" shortcut has been removed at both the skill-recommendation layer (`/assess`) and the runtime auto-detection layer (`phase-mapper.detectPhasesFromLabels`, `batch-executor` auto-detect). Bug- and docs-labeled issues now run `spec → exec → qa` by default under `sequant run --auto-detect`. Spec is only skipped when a prior `spec` phase marker already exists on the issue. Real-world batches showed that bug and docs issues frequently contain design decisions (scope boundaries, edge cases, test-strategy shifts) that benefit from a spec pass, and post-#515 the per-phase cost is small enough to justify universal inclusion. Docs-labeled issues still propagate `issueType: "docs"` through post-spec phases for downstream skills (e.g. lighter `/qa` pipeline). Override with explicit `--phases exec,qa`. (#533)

### Fixed

- **Pre-tool hook regexes now skip `gh issue|pr` body content** — the force-push regex and all four `git commit` regex sites in `pre-tool.sh` (security-checks, no-changes guard, worktree warning, conventional-commits validator) are now gated behind the same `^gh (issue|pr) ` exclusion that already guarded the secrets/credentials checks. Previously, `gh issue create` / `gh pr create` / `gh issue comment` / `gh pr comment` calls whose body text merely *referenced* these tokens (e.g. a doc explaining the hook itself, or a release note) were blocked at the tool-call level. Mirrored across all three hook copies (`templates/hooks/pre-tool.sh`, `hooks/pre-tool.sh`, `.claude/hooks/pre-tool.sh`). Follow-up to #532. (#564)

## [2.2.0] - 2026-04-18

### Added

- **Three-directory skill sync verification** — new `scripts/check-skill-sync.ts` script detects drift across `.claude/skills/`, `templates/skills/`, and `skills/` (#498)
- **QA skill check for skill sync** — `/qa` now flags skill-directory drift as a quality gap (#499)
- **Multi-issue invocation guidance** in `/qa` skill for batch review flows (#509)
- **Compressed `/spec` skill prompt** — 75% smaller with tiered context loading on demand (#515)

### Fixed

- Orchestrator no longer reports empty-worktree runs as successful (#534)
  - QA phase with null/unparseable verdict now returns `success: false` with `"QA completed without a parseable verdict"` instead of silently passing
  - Exec phase now fails with `"exec produced no changes (no commits, no uncommitted work)"` when the agent session returns success but HEAD has no commits unique to it relative to `origin/main` and no uncommitted work (counted via `git rev-list --count origin/main..HEAD` so stale branches where main has advanced still report correctly)
  - Zero-diff guard now respects custom base branches (#537): `scripts/new-feature.sh --base feature/<branch>` records the base in `branch.<name>.sequantBase`, and the guard compares against `origin/<recorded-base>` instead of hardcoded `origin/main`. Worktrees without a recorded base fall back to `origin/main` (unchanged #534 behavior), so existing worktrees and non-sequant-managed ones are unaffected
- **Chain-mode checkpoint scoping** — `createCheckpointCommit` no longer runs `git add -A`; stages only files touched by the issue's commits relative to the chain base branch. Unrelated dirty files (e.g. `.claude/*`, `.sequant-manifest.json`) trigger a warning and skip the checkpoint instead of being swept in. Uses NUL-terminated git output (`-z`) for robust handling of paths with unicode or special characters (#528)
- Restore pre-run config display regressed by #503 refactor

### Changed

- Restore `/solve` feature parity in `/assess` output (#522)
  - `Commands:` labeled header replaces bare indented command block (no box-drawing)
  - `Chain:` suggestion annotation when 2+ assessed issues share a dependency (suggest-only, never auto-applied)
  - `Testgen` auto-detection for `ui`/`frontend` + `enhancement`/`feature` labels or testable-AC signals
  - `Flags:` section with one-line reasoning per non-default flag (batch + single modes)
  - Conditional `ACs` column in batch mode when every issue has explicit `- [ ]` checkboxes
  - Richer `Order:` / `⚠` annotations carrying dependency reasoning and partial-AC-satisfaction context

### Removed

- Dead `scripts/state/update.ts` references from skill templates (#502)

## [2.1.2] - 2026-04-11

### Added

- **Configuration schema validation** — Zod schema for `.sequant/settings.json` with clear warnings for misspelled keys and type mismatches (#507)
- **Structured error types** — `SequantError` base class with 6 typed subclasses (`ApiError`, `BuildError`, `TimeoutError`, etc.) replacing string-based error classification (#507)

### Changed

- Extract `RunOrchestrator` class to decouple execution engine from CLI wiring (#503)
  - New `RunOrchestrator.run()` static method for full lifecycle execution
  - `ConfigResolver` class for 4-layer config merge (defaults < settings < env < explicit)
  - `src/commands/run.ts` reduced from 1,171 to 184 lines as thin CLI adapter
  - Both classes exported from package entry point for programmatic use

### Fixed

- Simplify adversarial self-evaluation to 2-field risk assessment (#513)
- Fix `/assess` batch output corruption with 9+ issues: replace box-drawing with indented commands, add command splitting rule, add label-priority ordering so domain labels override generic labels (#494)
- Fix undefined spread in `resolveRunOptions` + add direct unit tests (#503)
- Use Grep tool instead of bash grep for QA inline checks
- Update assess-skill test regex for 3-column label→phase table

## [2.1.1] - 2026-04-07

### Fixed

- Add `-y` flag to npx in generated MCP server config to prevent silent hang in non-interactive contexts

## [2.1.0] - 2026-04-07

### Added

- **Worktree isolation for parallel agent groups** — each parallel `/exec` agent gets its own sub-worktree, eliminating file conflicts structurally (#485)
  - New `agents.isolateParallel` setting (default: `false`, opt-in for v1)
  - New `--isolate-parallel` CLI flag for `sequant run`
  - Sub-worktree creation with node_modules symlink (~550ms per agent)
  - Merge-back via `git merge --no-ff` with conflict detection and reporting
  - Automatic cleanup of sub-worktrees after merge-back or on failure
  - Orphaned sub-worktree cleanup in `scripts/cleanup-worktree.sh`
- Declarative agent definitions in `.claude/agents/` for sequant subagents (#484)
  - `sequant-explorer` — read-only codebase exploration for `/spec`
  - `sequant-qa-checker` — quality checks with bypassPermissions for `/qa`
  - `sequant-implementer` — implementation agent for `/exec` parallel groups
  - `sequant-testgen` — test stub generation for `/testgen`
- `templates/agents/` directory so `sequant init` copies agent definitions to new projects
- Custom agents section in `subagent-types.md` reference documentation
- Modernized CLI output formatting across all commands (#495)
  - Replaced decorative emoji with typographic symbols matching ora output
  - Light dividers instead of heavy rules; bold titles instead of boxen borders
  - Parallel mode: 5-minute heartbeat (was 60s), suppressed during active phases
  - Columnar config display alignment in `sequant run`

### Changed

- Migrate all `Task()` invocations to `Agent()` across skill files (#484)
- Skill spawn sites now reference custom agents by name instead of duplicating inline parameters

- Upgrade TypeScript from 5.x to 6.0, ESLint from 9.x to 10.x, and typescript-eslint to 8.58.0 (#490)
- Tighten Node.js engine requirement from `>=20.0.0` to `>=20.19.0` (per ESLint 10 requirements)
- Fix 10 lint errors caught by new ESLint 10 rules (`no-useless-assignment`, `preserve-caught-error`)

### Fixed

- Resolve afterEach race condition in MCP integration tests (#492, #493)
- Auto-sync marketplace.json version from package.json during releases
- Log stderr from `gh issue create` for better error diagnostics

## [2.0.1] - 2026-04-06

### Added

- **Branch verification gates** in `/fullsolve` and `/exec` skills — prevents commits from landing on main/master when sub-agents or shell context resets silently switch the working directory
  - `/fullsolve` Phase 0.1: Soft warning if on main during pre-flight
  - `/fullsolve` Phase 5.0: Hard gate (`exit 1`) before commit/PR if not on a feature branch
  - `/exec` Quality Standard #0: Hard gate before every commit if not on a feature branch

### Fixed

- Fix quality loop retry misclassification — loop phase failures no longer trigger cold-start retries or MCP fallback, reducing wasted Claude Code spawns from 9+ to 1 per iteration (#488)

## [2.0.0] - 2026-04-05

### Breaking Changes

- **`/solve` merged into `/assess`** — `/solve` still works as a deprecated alias but will be removed in v3.0 (#325)
- **GitHub Actions label** `sequant:solve` renamed to `sequant:assess` — both accepted during transition, `sequant:solve` removed in v3.0 (#438)
- **TypeScript API:** `findSolveComment` → `findAssessComment` (old name still exported as deprecated alias) (#325)
- **`SignalSource` type:** `"solve"` deprecated in favor of `"assess"` — both accepted, `"solve"` removed in v3.0 (#438)

### Migration from v1.x

**Commands:** `/solve` → Use `/assess` instead (`/solve` still works as alias)

**GitHub Actions:** Label `sequant:solve` → `sequant:assess` (both accepted; `sequant:solve` removed in v3.0)

**TypeScript API:**
```typescript
// Old
import { findSolveComment } from "sequant"
// New
import { findAssessComment } from "sequant"
```
Old names are still exported as deprecated aliases. `SignalSource` type `"solve"` → `"assess"` (both accepted; `"solve"` removed in v3.0).

### Added

#### MCP Server

- Expose Sequant workflow as MCP server (#372)
  - `sequant serve` starts MCP server (stdio transport by default)
  - `sequant serve --transport sse --port 3100` for HTTP/SSE transport
  - `sequant_run` tool: execute workflow phases for GitHub issues
  - `sequant_status` tool: get workflow state for tracked issues
  - `sequant_logs` tool: get structured run logs and metrics
  - `sequant://state` and `sequant://config` MCP resources
  - `sequant doctor` checks MCP server health
  - `sequant init` detects MCP clients and offers config setup
- Add server instructions and tool annotations for LLM discoverability (#420)
  - Server-level instructions explaining workflow, tool relationships, and usage patterns
  - Tool annotations (`readOnlyHint`, `idempotentHint`, `destructiveHint`, `openWorldHint`) for client approval decisions
  - `phases` parameter now enumerates valid values (`spec`, `exec`, `qa`)
- Create `.mcp.json` by default during `sequant init` for Claude Code MCP integration (#418)
  - Always creates `.mcp.json` in project root (no `--mcp` flag required)
  - Merges into existing `.mcp.json` preserving other server entries
- Add multi-client SSE connection handling — reject second client with 409 Conflict (#390)
- Structured JSON responses with per-issue summaries for `sequant_run` (#391)
  - Each issue includes status, phases completed, QA verdict, and duration
  - Response size enforced at 64 KB with progressive truncation
- Real-time progress reporting — `sequant_status` returns `isRunning: true` during execution (#394)
- MCP progress notifications with timeout reset during phase transitions (#421, #435)
  - Spawn timeout resets on each progress event (30min per-phase, 2hr absolute ceiling)
- Include QA verdict summary in `sequant_logs` response (#434)

#### /assess Unification

- Unify `/assess` and `/solve` into single triage command with 6-action vocabulary: PROCEED, CLOSE, MERGE, REWRITE, CLARIFY, PARK (#325)
  - Health checks: codebase mismatches, stale PRs, overlapping issues
  - Workflow recommendations absorbed from `/solve` (PROCEED path)
  - Multi-issue support
  - Full backward compatibility layer

#### Workflow Execution

- Parallel execution as default mode for multi-issue runs (#404)
  - Issues run concurrently using `Promise.allSettled` + `p-limit`
  - Configurable concurrency via `--concurrency <n>` flag (default: 3)
  - Real-time progress indicator showing per-issue status
- Per-phase progress lines during parallel `sequant run` (#458)
  - Terminal shows phase start/complete events instead of freezing
  - 60-second heartbeat timer so the terminal never appears frozen
- Lighter workflow pipeline for documentation issues (#451)
  - Docs-labeled issues skip spec phase, running exec → qa directly
  - QA skill uses lighter sub-agent pipeline for docs (1 agent instead of 3)
- Spec phase retry with 5s backoff for transient failures (#452)
- Capture structured error context for phase failures (#447)
  - `sequant logs --failed` shows error category and stderr tail
  - `sequant stats` groups failures by category (`context_overflow`, `api_error`, `hook_failure`, `build_error`, `timeout`, `unknown`)

#### Quality & QA

- Optimize QA skill re-runs by diffing against prior findings (#377)
  - Previously MET AC items are skipped when no files changed since last QA
  - `--no-cache` flag forces full re-run regardless of prior findings
- Small-diff fast path for `/qa` — diffs below threshold use inline checks instead of 3 sub-agents (#465)
  - Threshold configurable via `qa.smallDiffThreshold` in `.sequant/settings.json`
- Baseline comparison in `/merger` to detect regressions before merging (#397)

#### Multi-Agent & CI

- Extract AgentDriver and PlatformProvider interfaces from phase-executor (#368)
  - `--agent <name>` CLI flag for `sequant run`
  - Driver and platform registries for future backend extensibility
- Aider as second agent backend (#369)
  - `npx sequant run 123 --agent aider` executes workflows using Aider
  - `settings.json` supports `run.agent: "aider"` with Aider-specific config
- GitHub Actions integration for CI/CD-driven workflows (#370)
  - Composite action, label lifecycle, phase override labels, structured outputs
  - Concurrency control per issue via native Actions concurrency groups
- Generate and consume AGENTS.md for cross-tool agent compatibility (#371)

#### Analytics

- `sequant stats --detailed` for QA verdict distribution, temporal trends, and per-label segmentation (#437)
- `scripts/analytics/analyze-runs.ts` for bulk run log analysis with baselines and failure forensics (#437)
- Reconcile `sequant status` with GitHub on every read (#423)
  - Batch GraphQL query fetches live issue/PR state in a single API call
  - Auto-heals unambiguous drift: merged PRs, closed issues, missing worktrees
  - `--offline` flag preserves pure local-state behavior

### Changed

- Simplify run command execution path and parameter passing (#402)
  - Replace positional parameters with `IssueExecutionContext` and `BatchExecutionContext` objects
  - Centralize shared workflow types in `src/lib/workflow/types.ts`
- Improve first-pass QA rate with exec pre-PR self-verification and QA implementation detection fixes (#448)
- Replace `spawnSync` with async `spawn` in MCP `sequant_run` tool — server stays responsive during execution (#388)
- CLI messages now use the detected package manager instead of hardcoding `npm` (#487)
  - Version update suggestions, uninstall hints, and MCP SDK install errors adapt to the project's PM
  - Added `addPkg`, `removePkg`, `updatePkg` to `PackageManagerConfig` for npm, pnpm, yarn, and bun
  - Documentation updated to show all package managers for install commands

### Fixed

- Fix `reconcileState()` race condition that could revert phase status during parallel runs (#458)
- Fix label matching to use exact equality instead of substring `includes()` for phase detection (#461)
- Fix AC parser not recognizing bold-wrapped ID format `**AC-1: description**` (#422)
- Unify Phase type definitions into single source of truth (#401)
- Fix concurrent state writes silently discarding changes via file locking (#409)
- Surface non-fatal warning messages in all modes, not just verbose (#403)
- Fix MCP config generation producing identical configs for all clients (#395)
- Fix `sequant init --yes` silently adding MCP config to all detected clients (#392)
- Fix MCP server `sequant_run` using nested `npx` that could resolve to a different cached version (#389)
- Lazy-load MCP SDK to prevent build failures when SDK is not installed (#396)

## [1.20.3] - 2026-03-21

### Fixed

- `testgen` phase writes test stubs to main repo instead of worktree
- Runtime guard prevents session resume across different working directories (defense-in-depth against SDK exit code 1 crash)

## [1.20.2] - 2026-03-21

### Fixed

- `security-review` and `loop` phases crash with exit code 1 in worktree-isolated workflows due to SDK session resume from mismatched working directory

### Security

- Pin GitHub Actions to commit SHAs to prevent tag hijacking

## [1.20.1] - 2026-03-19

### Fixed

- `--chain` flag now implies `--sequential` instead of requiring it
- Align ASCII box-drawing diagrams in docs

### Documentation

- Remove unstable plugin install recommendation from installation page

## [1.20.0] - 2026-03-15

### Changed

- Drop Node 18 support, require Node 20+ (#363)
  - Update `engines.node` from `>=18.0.0` to `>=20.0.0`
  - Remove Node 18 from CI test matrix
  - Upgrade vitest 3 to 4, commander 12 to 14, inquirer 12 to 13, ora 8 to 9

## [1.19.0] - 2026-03-13

### Added

- Codebase conventions detection during `sequant init` (#233)
  - Detects 8+ conventions: test patterns, export style, async patterns, TypeScript strictness, indentation, semicolons, package manager, project structure
  - Stores results in `.sequant/conventions.json` with manual override support
  - New `sequant conventions` command to view, re-detect, or reset conventions
  - `/exec` skill template references conventions for style-aware code generation
- Python package manager support (#94)
  - Detects pip, pipenv, poetry, and conda environments
  - Dependency management integrated into project analysis
- Stale branch detection for pre-flight checks (#304)
  - `/qa` and `/test` skills block execution when feature branch is >5 commits behind main
  - `/exec` skill warns but doesn't block (allows implementation to start)
  - Configurable threshold via `staleBranchThreshold` in `.sequant/settings.json`
  - Prevents wasted QA cycles on code that won't cleanly merge
- CLI wiring completeness checks in `/exec` and `/qa` skills (#307)
- Dependabot configuration for automated dependency updates (#327)
  - Weekly npm dependency scanning with grouped PRs (production vs development)
  - Dev dependencies limited to minor+patch updates to reduce noise
  - PR limit of 10 to prevent overwhelming the repo
- QA smoke test template section for workflow changes (#348)

### Fixed

- Background QA sub-agents silently fail on Bash calls due to permission mode gap (#352)
  - Changed QA quality check agents to use `mode="bypassPermissions"` instead of `acceptEdits`
  - Added comprehensive Bash coverage table to `subagent-types.md` documentation
  - Agents running `git diff`, `npm test`, etc. now execute successfully in background mode

## [1.18.0] - 2026-03-11

### Added

- Marketplace submission tooling and plugin metadata enrichment (#248)
  - `scripts/prepare-marketplace.sh` builds `external_plugins/sequant/` for official marketplace
  - `npm run prepare:marketplace` and `npm run validate:marketplace` scripts
  - `plugin.json` enriched with homepage, repository, license, and keywords
  - `marketplace.json` included in version sync CI checks
  - Deprecation notices in `sequant sync` and `sequant update` recommending plugin installation
  - Installation docs updated with plugin-first approach
  - Marketplace submission guide at `docs/internal/marketplace-submission.md`
- Browser testing enforcement via issue labels (#173)
  - `ui`/`frontend`/`admin` labels automatically include `/test` phase in `/fullsolve`
  - `no-browser-test` label explicitly opts out of browser testing
  - `/spec` warns when `.tsx` files detected without `ui` label
  - `/qa` downgrades verdict for untested `.tsx` changes
- Persist solve workflow analysis to issue comments (#172)
- Plugin file sync for seamless updates (#248, #342)
- Unit tests for exported utility functions (#317, #346)
- Linux CI testing for plugin installation (#189, #339)
- Permission precedence documentation (#242)
- Privacy policy for marketplace submission

### Changed

- Split run.ts monolith into focused modules (#318, #347)
- Convert prepare-marketplace from bash to TypeScript

### Fixed

- Auto-detect default branch instead of hardcoding origin/main (#343, #345)
- Sync plugin.json and marketplace.json versions to 1.17.0

## [1.17.0] - 2026-03-04

### Added

- Project website at [sequant.io](https://sequant.io)
- `--reflect` flag for post-run workflow analysis (#179)
- Post-merge smoketest patterns for merger skill (#229)
- Consolidated documentation source-of-truth in workflow skills (#320)
  - `/exec`: New CHANGELOG update step requiring `[Unreleased]` entries for user-facing changes
  - `/qa`: New CHANGELOG quality gate blocks `READY_FOR_MERGE` without CHANGELOG entry
  - `/release`: Enhanced Step 4.6 auto-generates what-weve-built.md bullets from CHANGELOG
- Call-site review check for QA skill (#299)
  - Detects new exported functions (including arrow exports) in the diff
  - Inventories all call sites, audits conditions, flags loop iteration scope
  - Compares call-site conditions against AC constraints
- Exec skill guidance for testing non-exported functions (#300)
  - Decision tree: @internal export → dependency injection → integration test → document limitation
  - Anti-pattern warning against tautological tests (local-variable-only assertions)

### Changed

- Split state-utils.ts into focused modules (#319)
- Clarify sequential vs default execution model in docs (#174)

### Fixed

- Stop auto-creating individual opportunity issues in upstream assessments (#259)
- Add `|| true` exit-code protection to ~60 unprotected grep commands in skill templates

## [1.16.1] - 2026-02-22

### Fixed

- Upgrade diff to 8.0.3 for DoS fix (#328)
- Upgrade hono to 4.12.1 for security patches (#326)
- Use .ts extensions and async IIFEs in skill tsx -e templates
- Apply same tsx -e fixes to spec skill template

## [1.16.0] - 2026-02-22

### Added

- Batch-level integration QA command: `sequant merge --check` (#313, #324)
  - Phase 1 deterministic checks: combined branch test, template mirroring, file overlap detection
  - Phase 2 residual pattern detection with `--scan`
  - Per-issue and batch-level verdicts (READY / NEEDS_ATTENTION / BLOCKED)
  - `--post` flag to post merge readiness reports as PR comments
  - `--json` output for CI/scripting integration
  - Auto-detection of issues from most recent `sequant run` log
  - Overlap classification: additive vs conflicting based on git diff line-range analysis
  - Per-PR scoped reports: `--post` now posts issue-specific findings to each PR instead of the full batch report
  - GitHub API fallback for issue titles when no run log is available
  - 48 tests across 2 test files (18 core + 30 extended)
  - Internal benchmark documentation (`docs/internal/merge-check-benchmark.md`)

### Documentation

- Merge command reference documentation (`docs/reference/merge-command.md`) (#313)
- Feature documentation for `sequant run` PR creation (`docs/features/run-pr-creation.md`) (#322)
- Background agent permission guidance for subagent-types

## [1.15.4] - 2026-02-21

### Fixed

- PR creation restored in `sequant run` — v1.15.3 regression where PRs were no longer created after successful QA (#322)
  - Added `createPR()` function with existing-PR detection, push, and race condition handling
  - Added `--no-pr` flag to skip PR creation for manual workflows
  - PR info recorded in run logs (`prNumber`, `prUrl`) and workflow state
  - Added `Bash(git push:*)` to exec skill's allowed-tools
  - Bug-labeled issues now use `fix()` prefix in auto-generated PR titles
- Normalized Commander.js `--no-*` flags (`--no-pr`, `--no-rebase`, `--no-mcp`, `--no-retry`, `--no-log`, `--no-smart-tests`) which were silently ignored due to Commander's naming convention
- Release skill: Unreleased section restoration, dynamic package name, doc path corrections, OTP handling

## [1.15.3] - 2026-02-21

### Added

- Test tautology detector for QA quality gates (#298)
  - Flags test blocks (`it()`/`test()`) that pass without calling any production code
  - String-aware parser handles nested template literals, comments, aliased imports
  - JS-identifier-aware matching (`[\w$]` boundaries) prevents false positives
  - CLI wrapper (`scripts/qa/tautology-detector-cli.ts`) with `--json` and `--verbose` flags
  - Integrated into `quality-checks.sh` — >50% tautological blocks `READY_FOR_MERGE`
  - QA cache support via `test-quality` check type
  - 52 unit tests + 5 CLI integration tests
  - Documentation: `docs/features/test-tautology-detector.md`

### Changed

- Skill prompts prefer Claude Code dedicated tools over bash for file operations (#265)
  - `grep -r` → `Grep()`, `find` → `Glob()`, `sed -i` → `Edit()`, `cat` → `Read()`
  - 21 files updated across `.claude/skills/` and `templates/skills/`

### Fixed

- Completed issues re-executed indefinitely, wasting API budget (#305)
  - Pre-flight state guard skips `ready_for_merge`/`merged` issues at run start
  - `--force` / `-f` flag bypasses the guard for intentional re-runs
  - Stale worktree detection: recreates worktrees >5 commits behind `origin/main`
  - Worktrees with uncommitted changes or unpushed commits are preserved with warning
  - Auto-reconciliation at run start detects merged PRs/branches and advances state
  - Merger skill updated with state update (`merged`) and worktree cleanup steps
  - Graceful degradation: missing state, network failures, corrupted state all handled
  - `isIssueMergedIntoMain` uses merge-specific grep patterns to avoid false positives from non-merge commits
  - 685 lines of tests: reconciliation, merge detection, worktree freshness, stale removal, graceful degradation
- `ScopeAssessmentSettings` missing fields from `ScopeAssessmentConfig` (#249)
  - Added `trivialThresholds.maxACItems`, `trivialThresholds.maxDirectories`, `thresholds.directorySpread`
  - `convertSettingsToConfig()` merges user settings with defaults for partial overrides
  - `/spec` SKILL.md reads `.sequant/settings.json` before calling `performScopeAssessment`
  - 18 tests (9 unit + 9 integration covering settings → config pipeline)
  - Documentation: `docs/features/scope-assessment-settings.md`
- Phase marker regex matches inside markdown code blocks (#269)
  - Pre-strips fenced code blocks and inline code before regex matching
  - Handles 3+ backtick/tilde fences per CommonMark spec
- `sequant run` fails on first execution, succeeds on retry (#267)
  - Two-phase retry strategy: cold-start retries (up to 2x within 60s threshold) then MCP fallback
  - MCP fallback disables MCP servers on retry, addressing npx-based cold-cache failures
  - Original error preserved on double-failure for better diagnostics
  - `--no-retry` flag and `run.retry` setting to disable retry behavior
  - Non-fatal `logWriter.initialize()` — run continues without logging on failure
- Worktree branches carry stale lockfiles after merge (#295)
  - Pre-PR rebase onto `origin/main` ensures branches are up-to-date before merge
  - Lockfile change detection (`ORIG_HEAD..HEAD`) triggers automatic dependency reinstall
  - Chain mode: only the final branch rebases (intermediate branches stay based on predecessor)
  - Rebase conflicts handled gracefully (abort, warn, continue with original state)
  - `--no-rebase` flag to skip pre-PR rebase for manual workflows

### Added

- Unit tests for gh CLI wrapper error paths in phase-detection (#270)
  - Covers `getIssuePhase`, `getCompletedPhases`, `getResumablePhasesForIssue`
  - Tests both error (execSync throws) and success paths

### Changed

- Restrict sub-agent types per skill via `Task(agent_type)` frontmatter (#262)
  - `/spec` → `Task(Explore)` (read-only research)
  - `/qa`, `/exec`, `/testgen` → `Task(general-purpose)` (quality checks)
  - `/fullsolve` → `Skill` only (orchestrator, no direct sub-agents)
  - Skills without sub-agents (security-review, merger) have `Task` removed
  - Enforces principle of least privilege per workflow phase

## [1.14.0] - 2026-02-05

### Added

- Pre-PR lint validation in `/exec` skill (#250)
  - Adds `npm run lint` to pre-PR quality gates (build → lint → test order)
  - Catches ESLint errors locally before they fail CI
  - Graceful skip for projects without lint script
  - Prevents wasted quality loop iterations from lint failures
- AC status management commands for state CLI
  - `npx tsx scripts/state/update.ts init-ac <issue> <count>` - Initialize AC items
  - `npx tsx scripts/state/update.ts ac <issue> <ac-id> <status> <notes>` - Update AC status
  - Enables `/qa` to persist AC verification status to workflow state
- Scope assessment for `/spec` to catch overscoped issues early (#239)
  - Non-Goals section parsing with warnings if missing
  - Feature count detection via AC clustering, title verbs, directory spread
  - Scope metrics table (feature count, AC items, directory spread)
  - Three verdicts: `SCOPE_OK`, `SCOPE_WARNING`, `SCOPE_SPLIT_RECOMMENDED`
  - Quality loop auto-enabled for yellow/red verdicts
  - Configurable thresholds in `.sequant/settings.json`
  - `--skip-scope-check` flag to bypass assessment
  - State persistence via `StateManager.updateScopeAssessment()`
- Animated spinners with elapsed time for `sequant run` phase execution (#244)
- Integration tests for testgen auto-detection workflow (#252)

### Fixed

- `/loop` skill failing in `sequant run` due to missing log file (#240)
  - Added orchestrated mode support: reads QA findings from GitHub issue comments when `SEQUANT_ORCHESTRATOR` is set
  - Preserved standalone mode: continues reading from `/tmp/claude-issue-<N>.log` when run interactively
  - Improved jq query to use `startswith()` instead of `contains()` to avoid false positives
- Pre-PR lint validation catches CI failures early (#253)

### Improved

- Better error diagnostics when Claude Code CLI exits unexpectedly
  - Captures stderr output from SDK for debugging
  - Includes stderr in error messages (up to 500 chars)
  - Streams stderr in real-time with `--verbose` flag
  - Animated `ora` spinner cycles while phases run (⠋ ⠙ ⠹ ⠸)
  - Elapsed time updates every 5 seconds during execution
  - Phase progress indicators (e.g., "spec (1/3)")
  - Completion states show checkmark with total duration
  - Graceful fallback to static text in CI/non-TTY/verbose modes
  - New `PhaseSpinner` class in `src/lib/phase-spinner.ts`
  - 35 unit tests covering spinner lifecycle and edge cases

### Refactored

- Decoupled derived AC extraction from hardcoded dimensions (#251)

## [1.13.0] - 2026-02-01

### Added

- QA caching to skip unchanged checks on re-run (#228)
  - New `src/lib/workflow/qa-cache.ts` module with hash-based cache invalidation
  - Cache keyed by git diff hash + config hash + TTL (1 hour default)
  - `--no-cache` flag to force fresh run
  - Cache hit/miss reported in QA output via `quality-checks.sh`
  - Graceful degradation on corrupted cache (falls back to fresh run)
  - CLI helper `scripts/qa/qa-cache-cli.ts` for shell script integration
  - 36 unit tests covering cache operations, invalidation, TTL expiry
- Testgen auto-detection in `/spec` and `/solve` (#217)
  - Automatically recommends `--testgen` phase when issue has testable ACs
  - Pattern detection for UI components, API endpoints, validation logic
  - Reduces manual workflow configuration for common feature types
- Enhanced CLI UI with modern terminal patterns (#215)
  - New `src/lib/cli-ui.ts` module (736 lines) with centralized UI utilities
  - Animated spinners with `ora` (graceful fallback to text in CI/non-TTY/verbose modes)
  - Decorative boxes with `boxen` for success/error/warning/header messages
  - ASCII tables with `cli-table3` for `sequant status` issue list
  - Gradient ASCII branding (static logo, no figlet dependency)
  - Progress bars for `sequant stats` success rate visualization
  - Standardized color palette across all CLI commands
  - Graceful degradation: `--no-color`, `--json`, `--verbose`, non-TTY, CI auto-detection
  - Windows legacy terminal ASCII fallback
  - `SEQUANT_MINIMAL=1` environment variable support
  - 73 unit tests covering all UI functions and fallback scenarios
- `/upstream` skill for Claude Code release tracking (#222)
  - Monitors anthropics/claude-code releases via GitHub API
  - Detects breaking changes, deprecations, new tools, opportunities
  - Auto-creates GitHub issues for actionable findings (with deduplication)
  - Keyword matching + regex patterns against sequant capabilities baseline
  - `--since <version>` for batch assessment of multiple releases
  - `--dry-run` mode to preview without creating issues
  - GitHub Action for weekly automated assessment
  - Security: All shell commands use `spawn()` with argument arrays (no injection risk)
  - 90 unit tests covering relevance detection, report generation, issue management
- Feature Quality Planning in workflow skills (#219)
  - `/spec`: New "Feature Quality Planning" section with 6 quality dimensions
    - Completeness, Error Handling, Code Quality, Test Coverage, Best Practices, Polish
    - Generates Derived ACs from quality checklist items
    - Complexity scaling (simple/standard/complex issues)
    - Section Applicability table for issue types
  - `/exec`: Quality Plan Reference section to implement quality items during execution
  - `/qa`: Quality Plan Verification with threshold-based status (Complete ≥80%, Partial ≥50%, Not Addressed <50%)
  - Addresses gap where `/spec` planned "minimum to satisfy AC" instead of "complete professional implementation"
- Derived AC tracking through workflow phases (#223)
  - `/exec`: Extracts derived ACs from spec comments, includes in Pre-PR AC Verification table with "Source" column
  - `/qa`: Parses derived ACs, includes in AC Coverage table with source attribution (e.g., "Derived (Error Handling)")
  - Derived ACs treated identically to original ACs for verdict determination
  - Edge case handling: malformed rows skipped, 0/1/5+ derived ACs supported
- Skill command verification in `/qa` skill (#209)
  - Detects when `.claude/skills/**/*.md` files are modified
  - Extracts CLI commands from bash code blocks, subshells, inline backticks
  - Validates JSON field names against `--help` output (e.g., `gh pr checks --json name,state,bucket`)
  - Pre-requisite check for `gh` CLI availability
  - Verdict gating: `READY_FOR_MERGE` blocked if command verification fails
  - New "Skill Command Verification" and "Skill Change Review" sections in QA output
- Mandatory prompt template enforcement in `/exec` parallel execution (#212)
  - REQUIRED: Sub-agents MUST use templates from Section 4c for typed tasks
  - Warning: Skipping templates for typed tasks results in QA rejection
  - Synced Section 4c (Prompt Templates for Sub-Agents) to active skill file
  - Added `prompt-templates.md` reference to `.claude/skills/_shared/references/`
- Build verification against main branch in `/qa` skill (#177)
  - Distinguishes regressions from pre-existing build failures
  - New "Build Verification" table in QA output when build fails
  - Regressions block merge (`AC_NOT_MET`); pre-existing failures documented only
  - Script: `scripts/quality-checks.sh` includes `run_build_with_verification()`
- CI status awareness in `/qa` skill (#178)
  - Checks GitHub CI status via `gh pr checks` before finalizing verdict
  - CI pending → `NEEDS_VERIFICATION` verdict (prevents premature READY_FOR_MERGE)
  - CI failure → `NOT_MET` for CI-related acceptance criteria
  - No CI configured → AC marked N/A (no impact on verdict)
  - New "CI Status" table in QA output
- Shift-left gap detection across workflow phases (#196)
  - `/spec`: Verification method decision framework - every AC must have explicit test type
  - `/exec`: Pre-PR AC verification - checks each AC is addressed before creating PR
  - `/test`: Coverage analysis - warns when new/modified files lack test coverage
  - Principle: "QA should validate, not discover" - catch gaps at source
- Shell script quality checks in `/exec` skill (#210)
  - Syntax validation, shellcheck integration, unused function detection
  - Smoke test execution for scripts with --help support
- Interactive stack selection and multi-stack support in `/setup` (#197)
  - `--interactive` / `-i` flag for guided stack configuration
- Testgen phase auto-detection and haiku optimization (#217)
  - `/spec`: Auto-recommends `testgen` phase when ACs have Unit/Integration Test verification methods
  - `/solve`: Includes `--testgen` flag and testgen in workflow recommendations
  - `/testgen`: Uses haiku sub-agents for cost-efficient stub generation (~90% token savings)
  - Detection rules skip testgen for bug fixes and docs-only issues
  - Updated `docs/concepts/workflow-phases.md` with testgen auto-detection documentation
  - Multi-stack detection: identifies stacks in root and subdirectories
  - Checkbox UI for selecting multiple stacks in monorepos
  - Primary stack selection determines dev URL and commands
  - Combined constitution notes from all selected stacks
  - Stack config persistence in `.sequant/stack.json`
- Content analysis for phase detection in `/spec` skill (#175)
  - Analyzes issue title for phase-relevant keywords (UI, security, complexity patterns)
  - Analyzes issue body for file references and patterns (.tsx, scripts/, auth/)
  - Signal priority merging: Labels > Solve comment > Title > Body
  - Solve comment detection: uses existing `/solve` recommendations when available
  - New "Content Analysis" section in spec output with signal sources table
  - Library exports: `analyzeContentForPhases()`, `mergePhaseSignals()`, `findSolveComment()`
  - 92 unit tests covering all detection patterns and edge cases

### Fixed

- Quality loop never triggering despite `--quality-loop` flag (#218)
  - Root cause: QA phase success was determined by SDK query completion, not actual QA verdict
  - Added `parseQaVerdict()` to parse verdict from QA output (READY_FOR_MERGE, AC_NOT_MET, etc.)
  - Non-passing verdicts now correctly mark QA phase as failure, triggering `/loop`
  - Verdict logged to `.sequant/logs/*.json` for debugging
  - 15 unit tests for verdict parsing covering all markdown formats

## [1.12.0] - 2026-01-29

### Added

- AC linting in `/spec` skill (#201)
  - Flags vague patterns: "should work", "properly", "correctly", "as expected"
  - Flags unmeasurable terms: "fast", "performant", "responsive", "scalable"
  - Flags incomplete specs: "handle errors", "edge cases", "all scenarios"
  - Flags open-ended scope: "etc.", "and more", "such as", "including but not limited to"
  - 28 configurable patterns with suggestions for improvement
  - Warning-only (doesn't block planning)
  - Skip with `--skip-ac-lint` flag
  - New module: `src/lib/ac-linter.ts`
- Semgrep static analysis integration in `/qa` skill (#200)
  - Stack-aware rulesets: Next.js, Astro, SvelteKit, Remix, Nuxt, Python, Go, Rust
  - Graceful degradation when Semgrep not installed
  - Custom rules support via `.sequant/semgrep-rules.yaml`
  - Critical findings block merge verdict (`AC_NOT_MET`)
  - CLI runner: `npx tsx scripts/semgrep-scan.ts`
  - Documentation: `references/semgrep-rules.md`
- Stack-aware constitution templates in `/setup` skill (#188, #193)
  - Auto-detects project stack (Next.js, Astro, SvelteKit, Remix, Nuxt, Rust, Python, Go)
  - Injects stack-specific testing, linting, and build notes into constitution
  - Falls back to generic notes for unknown stacks
- Claude Code Plugin support (#185)
  - Sequant can now be installed as a Claude Code plugin: `/plugin install sequant`
  - Plugin marketplace configuration in `.claude-plugin/`
  - `/setup` skill for plugin initialization (creates worktrees directory, copies constitution)
  - Plugin-specific documentation: updates, versioning, feedback mechanisms
  - CI validation for plugin.json (#191): structure check, required fields, version sync with package.json
  - `/release` skill now auto-syncs plugin.json version during releases
  - Comprehensive upgrade documentation in `docs/plugin-updates.md`
- Auto-detect project name in `/setup` skill (#187)
  - Detects from package.json, Cargo.toml, pyproject.toml, go.mod, or git remote
  - Substitutes `{{PROJECT_NAME}}` in constitution template
  - Falls back to directory name if no project file found
- Comprehensive "What We've Built" project overview documentation
  - Covers all 16 skills, 9 CLI commands, hooks system, dashboard, VS Code extension
  - Added to README documentation section
- Sub-agent prompt templates for `/exec` skill (#181)
  - Task-specific templates: component, type, CLI, test, refactor
  - Automatic template selection via keyword detection
  - Manual override with `[template: X]` annotation
  - Error recovery template with diagnosis checklist
  - See `templates/skills/_shared/references/prompt-templates.md`

### Improved

- Hook error message for merge commits now suggests `chore: merge...` format (#198)

### Fixed

- CI workflow failures on main branch
  - ESLint error in `project-name.ts` (unnecessary regex escape)
  - `validate-skills` job now skips `_shared` directory (shared resources, not a skill)
- QA verdict logic now enforces strict `READY_FOR_MERGE` criteria (#171)
  - Added `NEEDS_VERIFICATION` verdict for ACs with `PENDING` status
  - `PARTIALLY_MET` ACs now correctly result in `AC_NOT_MET` verdict
  - Added explicit verdict determination algorithm to prevent false positives
- Sub-agent spawning in `/spec` and `/qa` skills (#170)
  - Replaced invalid subagent types (`quality-checker`, `pattern-scout`, `schema-inspector`) with valid Claude Code types
  - `/qa` now uses `general-purpose` for quality checks
  - `/spec` now uses `Explore` for pattern and schema inspection

## [1.11.0] - 2026-01-23

### Added

- Closed-issue verification in `sequant doctor` (#89)
  - Warns if issues closed in last 7 days have no commit in main
  - Helps detect work lost due to manual issue closure without merging
  - Skips issues with `wontfix`, `duplicate`, `invalid`, `question` labels
  - Use `--skip-issue-check` flag to disable
- PR info recorded in workflow state when `/exec` creates a PR (#145)
  - New CLI command: `npx tsx scripts/state/update.ts pr <issue> <pr-number> <url>`
  - Enables `--cleanup` to detect merged PRs for orphaned entries
  - `/exec` skill updated to record PR info after PR creation
- Comprehensive QA improvements (#147)
  - **Execution Evidence** — QA now executes smoke tests for scripts/CLI changes before READY_FOR_MERGE
  - **Test Quality Review** — Evaluates tests for behavior vs implementation, coverage depth, mock hygiene
  - **Anti-Pattern Detection** — Audits new dependencies and scans for N+1 queries, empty catch blocks, hardcoded secrets
  - Supersedes #91, #92, #143
- Local-first analytics for workflow insights (#132)
  - Metrics collected automatically during `sequant run`
  - Data stored in `.sequant/metrics.json` (privacy-focused, no PII)
  - `sequant stats` displays success rates, averages, and insights
  - `sequant stats --json` for programmatic access
  - No data ever sent remotely — all analytics are local-only
  - See `docs/analytics.md` for details
- Smart cleanup with PR merge detection (#137)
  - `sequant status --cleanup` now checks GitHub for merged PRs
  - Orphaned entries with merged PRs are auto-removed
  - Orphaned entries without merged PRs are marked `abandoned` (kept for review)
  - New `--all` flag removes both merged and abandoned entries in one step
  - Usage: `sequant status --cleanup --all`
- `--qa-gate` flag for chain mode to pause execution when QA fails (#133)
  - Prevents downstream issues from building on potentially broken code
  - Chain pauses with clear messaging and recovery guidance
  - New `waiting_for_qa_gate` status in state tracking
  - Usage: `sequant run 1 2 3 --sequential --chain --qa-gate`
- `sequant init` now creates symlinks for `scripts/dev/` pointing to `templates/scripts/` (#107)
  - Templates automatically update when Sequant is upgraded
  - Existing regular files preserved (use `--force` to replace)
  - Windows falls back to copies if symlinks unavailable
  - Use `--no-symlinks` flag to opt out of symlink behavior
- Dashboard UI enhancements for workflow visibility (#139)
  - Phase indicators with rich tooltips (status, duration, error messages)
  - Active phase highlighting with visual pulse animation
  - Loop iteration counter (e.g., "2/3")
  - Branch name display with copy-to-clipboard button
  - Issue tracking age ("Tracked for 3d")
- Acceptance criteria tracking integration (#158)
  - AC parser (`src/lib/ac-parser.ts`) extracts criteria from issue markdown
    - Supports formats: `**AC-1:**`, `**B2:**`, `AC-1:` (with/without bold)
    - Auto-infers verification method from description keywords
  - StateManager AC methods: `updateAcceptanceCriteria()`, `getAcceptanceCriteria()`, `updateACStatus()`
  - Dashboard displays expandable AC checklist per issue with status icons (✅❌⏳🚫)
- MCP server support for headless `sequant run` (#161)
  - Reads MCP servers from Claude Desktop config and passes to SDK
  - Enables Context7, Sequential Thinking, and Chrome DevTools in headless mode
  - New `--no-mcp` flag to disable MCPs for faster/cheaper runs
  - New `run.mcp` setting in `.sequant/settings.json` (default: `true`)
  - `sequant doctor` now shows "MCP Servers (headless)" availability check
  - See `docs/run-command.md` for configuration details
  - Summary badge shows "X/Y met" progress
  - `/spec` skill wired to extract and store AC from issue body
  - `/qa` skill wired to update AC status after review

### Fixed

- `sequant state` command now registered in CLI (#144)
  - Previously implemented in `src/commands/state.ts` but not accessible
  - Now available: `sequant state init`, `sequant state rebuild`, `sequant state clean`
  - See `docs/state-command.md` for usage
- `/qa` now detects `templates/scripts/` changes for execution verification (#109)
  - Previously only `scripts/` was checked, allowing template scripts to bypass `/verify`
- Dashboard now shows fresh state instead of stale cached data
  - Issue status updates (e.g., `in_progress` → `ready_for_merge`) now reflect immediately
- `--no-mcp` flag now registered in CLI (#161)
  - Flag was implemented in run command logic but not exposed in Commander.js options
  - Now available: `sequant run --no-mcp` to disable MCP server injection

## [1.10.1] - 2026-01-19

### Fixed

- Chain mode (`--chain`) now rebases existing branches onto previous chain link (#126)
  - Previously, existing branches were reused as-is, breaking the chain structure
  - Rebase conflicts are handled gracefully with abort and user warning

## [1.10.0] - 2026-01-19

### Added

- `--base <branch>` flag for `sequant run` to specify custom base branches (#122)
  - Branch from feature integration branches instead of main
  - `run.defaultBase` config option in `.sequant/settings.json`
  - Resolution priority: CLI flag → config → main
  - Full documentation in `docs/feature-branch-workflow.md`
- Persistent workflow state tracking for issue phases (#115)
  - State file at `.sequant/state.json` tracks issue progress across sessions
  - `sequant status --issues` shows all tracked issues and their phase progress
  - `sequant status --rebuild` rebuilds state from run logs
  - `sequant status --cleanup` removes stale/orphaned entries
  - `sequant status --cleanup --dry-run` previews cleanup without changes
  - `sequant status --cleanup --max-age 30` removes old entries
  - State hook utility for skills to update state when running standalone
- `/fullsolve` now invokes child skills (`/spec`, `/exec`, `/test`, `/qa`) via Skill tool instead of inline execution (#111)
- `/solve` recommends `--chain` flag for dependent/sequential issues (#111)
- `/solve` recommends `-q` (quality loop) for enhancement/feature issues
- Local node_modules warning when running stale local installs (#87)

### Changed

- `/fullsolve` auto-progresses between phases without waiting for user confirmation
- `sequant run` now writes state updates on phase transitions

## [1.5.2] - 2026-01-13

### Fixed

- Clean bin script path in package.json (removes npm publish warning)

## [1.5.1] - 2026-01-12

### Changed

- Reduced npm package size by excluding tests and source maps

## [1.5.0] - 2026-01-11

### Added

- Graceful shutdown for `sequant run` with proper signal handling (#74)
- Context7 and Sequential Thinking MCP integration into skill workflows (#75)
- Configurable parallel agent mode for cost-conscious users (#68)
- Integration test for `sequant doctor` command (#60)
- ESLint with rule to catch `require()` in ESM modules (#59)
- Skip `/docs` generation for documentation-only issues (#66)
- Standardized issue labeling with templates and AI suggestions (#51)

### Fixed

- Worktree lookup in pre-merge cleanup hook
- Auto-cleanup worktree before `gh pr merge`

## [1.4.0] - 2026-01-11

### Added

- Setup wizard for missing dependencies during `sequant init` (#9)
  - Interactive dependency checking for gh, claude, and jq
  - Platform-specific install instructions (brew/apt/choco)
  - `--skip-setup` flag for CI/advanced users
  - Auto-skips in CI environments
  - Input validation to prevent shell injection in command checks
- `/release` skill for automated version bumps, GitHub releases, and npm publishing
- CI environment name shown in non-interactive mode messages (#50)
- Platform requirements documentation with GitHub alternatives (#7)

### Fixed

- Merger skill pre-merge worktree cleanup to prevent branch deletion failures

### Removed

- Dead workflow code: `execute-issues.ts`, `cli-args.ts`, `logger.ts` (#12)
- Supabase remnants from reflect skill scripts (#12)

## [1.3.0] - 2026-01-10

### Added

- Orchestration context awareness for skills (#40)
  - Skills detect when running under `sequant run` via `SEQUANT_ORCHESTRATOR` env var
  - Orchestrated skills skip redundant pre-flight checks and reduce GitHub comment spam
  - `SEQUANT_PHASE`, `SEQUANT_ISSUE`, `SEQUANT_WORKTREE` env vars available to skills
- Smoke test step for UI issues in `/exec` skill (#37)
  - Quick runtime verification before implementation for `admin`, `ui`, `frontend` labeled issues
  - Catches module registration errors and framework incompatibilities that pass build
- Security label detection in phase detection (#30)
  - Issues with `security`, `auth`, `authentication`, `permissions`, `admin` labels trigger `security-review` phase
  - `security-review` phase added to workflow type system
- `npm run sync:skills` script to sync templates to `.claude/skills/` (#30)
- `parseRecommendedWorkflow()` unit test coverage (#30)
- `/spec` reference documentation for recommended workflow format (#30)
- Configurable `/test` skill with framework-agnostic defaults (#17)
  - `{{DEV_URL}}` token replaces hardcoded `localhost:3000`
  - `{{PM_RUN}}` token for package manager-aware commands
  - Graceful fallback to manual testing checklist when Chrome DevTools MCP unavailable
  - `docs/customization.md` documents testing configuration

## [1.2.7] - 2026-01-10

### Added

- Log rotation to prevent unbounded log growth (#28)
  - Automatic rotation when logs exceed 10MB or 100 files
  - `sequant logs --rotate` for manual rotation
  - `--dry-run` flag to preview rotation
  - Configurable via `rotation` settings in `.sequant/settings.json`
- `sequant stats` command for aggregate run analysis (#28)
  - Success/failure rates across all runs
  - Average phase durations by phase type
  - Common failure points identification
  - `--csv` and `--json` export options
- Comprehensive logging documentation in `docs/logging.md` (#28)
  - JSON schema reference for external tooling
  - 8 practical jq examples for log parsing
  - GitHub Actions and Slack integration examples
- Optional MCP server documentation and detection (#15)
  - `sequant doctor` now checks for optional MCP servers (Chrome DevTools, Context7, Sequential Thinking)
  - New "Optional MCP Integrations" section in README with install instructions
  - New `docs/mcp-integrations.md` guide with detailed setup and troubleshooting
  - `/test` skill gracefully falls back to manual testing when Chrome DevTools MCP unavailable

### Fixed

- `sequant doctor` MCP check now works correctly (fixed ESM import for fs module)
- `sequant run` correctly determines success after quality loop recovery

## [1.2.5] - 2026-01-10

### Added

- `sequant init` now updates `.gitignore` with `.sequant/` entry
- `/qa` skill includes "Documentation Check" in output verification
- `/exec` skill includes "Documentation Reminder" in output verification

### Fixed

- `sequant update` config setup message is now friendlier ("one-time setup" instead of "legacy install" warning)

## [1.2.4] - 2026-01-10

### Fixed

- Fix CLI crash when running via npx - version reading now works from compiled dist
- `sequant update` now shows correct version instead of hardcoded "0.1.0"
  - Version is read dynamically from package.json at runtime
  - Works from both source and compiled locations

## [1.2.2] - 2026-01-10

### Added

- **Quality loop documentation** - comprehensive docs for the `--quality-loop` feature
  - New "Quality Loop" section in README with usage examples
  - Added to `docs/run-command.md` options table and dedicated section
  - Environment variables: `SEQUANT_QUALITY_LOOP`, `SEQUANT_MAX_ITERATIONS`
  - Settings file documentation with full schema
- **Smart defaults for quality loop** - auto-enables for complex issues
  - Labels `complex`, `refactor`, `breaking`, `major` trigger quality loop
  - `/solve` skill now recommends quality loop for complex issues
  - Output shows when quality loop will auto-enable

## [1.2.1] - 2026-01-10

### Fixed

- CLI `--version` now reads from package.json dynamically instead of hardcoded value

## [1.2.0] - 2026-01-10

### Added

- **Non-interactive mode & TTY detection** (#8)
  - Graceful fallback to defaults when stdin/stdout is not a TTY
  - Detects 12 CI environments (GitHub Actions, GitLab CI, CircleCI, etc.)
  - `--interactive` flag to force prompts in non-TTY environments
  - Clear messaging about why non-interactive mode was detected
- **Bun package manager support** (#6)
  - Auto-detects `bun.lockb` during `sequant init`
  - Uses `bun test`, `bun run build`, etc. for Bun projects
- **New stack detection** (#11)
  - SvelteKit (detects `svelte.config.js` + `@sveltejs/kit`)
  - Remix (detects `remix.config.js` or `@remix-run/react`)
  - Nuxt (detects `nuxt.config.ts` or `nuxt` dependency)
- **Claude Code CLI check** in `sequant doctor` (#3)
  - Verifies `claude` command is available
  - Shows install instructions if missing
- **PR verification** in `/exec` skill (#26)
  - Checks for existing PRs before creating duplicates
  - Validates branch state before pushing
- **Worktree isolation** for multi-issue workflows (#31)
  - Each issue gets isolated git worktree
  - Prevents cross-contamination between parallel issues
  - `scripts/dev/new-feature.sh` helper for worktree creation
- **`--stash` flag** for `new-feature.sh` (#41)
  - Automatically stashes uncommitted changes before creating worktree
- **Reference documentation**
  - MCP browser testing patterns (#39)
  - Framework gotchas reference (#38)

### Changed

- Workflow skills updated for sequant automation patterns

### Fixed

- SDK session no longer incorrectly resumed when switching worktrees
- Issue info JSON parsing no longer requires jq

## [1.1.3] - 2025-01-09

### Added

- Settings file (`.sequant/settings.json`) for persistent run preferences
  - Created during `sequant init`
  - Preserved across `sequant update`
- Spec-driven phase detection for intelligent workflow selection
  - `/spec` now outputs `## Recommended Workflow` section
  - `sequant run` parses spec output to determine subsequent phases
  - Bug fixes (labels: `bug`, `fix`) skip spec and run `exec → qa` directly
- `--no-log` flag to disable JSON logging for a single run

### Changed

- JSON logging now enabled by default (`logJson: true` in settings)
- Replaced static `phases` setting with `autoDetectPhases: true`
- Updated `/solve` skill to use `npx sequant` as primary CLI command
- Added global install tip for frequent users
- Changed CLI run emoji to 🌐

### Fixed

- CLI now works correctly with local install via `npx sequant`

## [1.1.2] - 2025-01-08

### Added

- Structured JSON logging for `sequant run` with Zod schema validation
  - `--log-json` flag to enable JSON log output
  - `--log-path` option to specify custom log directory
  - Logs include run metadata, phase timing, issue status, and summary stats
- `sequant logs` command to view and analyze run history
  - List recent runs with `sequant logs`
  - View specific run with `sequant logs <run-id>`
  - Filter by issue with `--issue <number>`
- Pre-flight git state checks in `/fullsolve` and `/exec` skills
  - Prevents duplicate work after context restoration
  - Verifies recent commits, existing PRs/branches before starting
- Output verification checklists to all 14 skills
- Unit tests for run-log-schema (58 tests) and LogWriter (41 tests)

### Changed

- `sequant update` now auto-runs `npm install` when package.json changes

### Fixed

- Pre-tool hook now correctly detects git status in worktree directories
  - Fixes false "no changes to commit" errors when committing from worktrees

## [1.1.1] - 2025-01-08

### Changed

- Extracted `commandExists`, `isGhAuthenticated` to shared `src/lib/system.ts`
- Platform-specific install hints (macOS/Linux/Windows) for gh and jq
- Improved test mocking by using system.ts instead of child_process

### Added

- `getInstallHint(pkg)` function for platform-aware install commands
- npm 2FA publishing documentation in CONTRIBUTING.md

## [1.1.0] - 2025-01-08

### Added

- Prerequisite checks in `sequant doctor` for gh CLI, authentication, and jq
- Prerequisite warnings in `sequant init` for missing dependencies
- Optional jq suggestion in init success message
- Unit tests for doctor and init prerequisite checks

### Changed

- `release.sh` now dynamically detects GitHub repo from git remote
- README updated with prerequisite information and jq as optional dependency

### Fixed

- TypeScript errors in doctor.test.ts mock types

## [1.0.0] - 2025-01-07

### Changed

- **BREAKING:** Removed all project-specific content from skill templates
  - Replaced shop/supabase examples with generic item/database terminology
  - Skills now portable for any project type
- Made MCP tools optional across all skills
  - Context7 and Sequential Thinking documented as optional enhancements
  - Skills work without any MCP servers configured
- Rewrote `/solve` skill to be advisory-only (no script generation)
- Replaced hardcoded URLs with `{{DEV_URL}}` token placeholder

### Removed

- Supabase MCP tool requirements from all skills
- Dead code: `workflow-queries.ts` (Supabase-only)
- Project-specific examples (shops, pending_shops, content_ideas)

### Added

- `sequant run` command for batch issue execution (AC-10)
  - Sequential and parallel execution modes
  - Custom phase selection (`--phases`)
  - Dry-run mode (`--dry-run`)
  - Verbose output (`--verbose`)
- Cross-platform support documentation (AC-11)
  - Platform requirements in README
  - Path handling fixes for Windows compatibility
- Stack-specific documentation (AC-12)
  - `docs/stacks/nextjs.md` - Next.js guide
  - `docs/stacks/rust.md` - Rust guide
  - `docs/stacks/python.md` - Python guide
  - `docs/stacks/go.md` - Go guide
  - `docs/customization.md` - Customization guide
  - `docs/troubleshooting.md` - Troubleshooting guide
- Skills validation with `skills-ref` (AC-13)
  - All 14 skills pass validation
  - `npm run validate:skills` script
  - GitHub Actions CI workflow
- Cross-platform testing documentation (AC-14)
  - `docs/testing.md` - Testing matrix and checklist
- CONTRIBUTING.md with contribution guidelines
- This CHANGELOG.md

### Changed

- Updated README with platform support matrix
- Updated README with run command documentation

### Fixed

- Path handling in templates.ts for Windows compatibility

## [0.1.0] - 2025-01-03

### Added

- Initial release
- `sequant init` command with stack detection
- `sequant update` command for template updates
- `sequant doctor` command for health checks
- `sequant status` command for version info
- 14 workflow skills:
  - assess, clean, docs, exec, fullsolve, loop
  - qa, reflect, security-review, solve, spec
  - test, testgen, verify
- Stack support: Next.js, Rust, Python, Go
- Update-safe customization via `.claude/.local/`
- Git worktree helper scripts
- Pre/post tool hooks

[Unreleased]: https://github.com/sequant-io/sequant/compare/v1.18.0...HEAD
[1.18.0]: https://github.com/sequant-io/sequant/compare/v1.17.0...v1.18.0
[1.17.0]: https://github.com/sequant-io/sequant/compare/v1.16.1...v1.17.0
[1.16.1]: https://github.com/sequant-io/sequant/compare/v1.16.0...v1.16.1
[1.16.0]: https://github.com/sequant-io/sequant/compare/v1.15.4...v1.16.0
[1.15.4]: https://github.com/sequant-io/sequant/compare/v1.15.3...v1.15.4
[1.15.3]: https://github.com/sequant-io/sequant/compare/v1.14.0...v1.15.3
[1.14.0]: https://github.com/sequant-io/sequant/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/sequant-io/sequant/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/sequant-io/sequant/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/sequant-io/sequant/compare/v1.10.1...v1.11.0
[1.10.1]: https://github.com/sequant-io/sequant/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/sequant-io/sequant/compare/v1.5.2...v1.10.0
[1.5.2]: https://github.com/sequant-io/sequant/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/sequant-io/sequant/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/sequant-io/sequant/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/sequant-io/sequant/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/sequant-io/sequant/compare/v1.2.7...v1.3.0
[1.2.7]: https://github.com/sequant-io/sequant/compare/v1.2.5...v1.2.7
[1.2.5]: https://github.com/sequant-io/sequant/compare/v1.2.4...v1.2.5
[1.2.4]: https://github.com/sequant-io/sequant/compare/v1.2.2...v1.2.4
[1.2.2]: https://github.com/sequant-io/sequant/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/sequant-io/sequant/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/sequant-io/sequant/compare/v1.1.3...v1.2.0
[1.1.3]: https://github.com/sequant-io/sequant/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/sequant-io/sequant/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/sequant-io/sequant/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/sequant-io/sequant/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/sequant-io/sequant/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/sequant-io/sequant/releases/tag/v0.1.0
