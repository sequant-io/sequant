# Sequant how-to corpus: edge cases, user stories, strategic patterns

Compiled 2026-09-30 from the repo's public sources (read-only). Organized by three verbs:
**BUILDING** (setup, first run, stack config), **SOLVING** (one issue or a batch to a PR), **RESOLVING** (what went wrong, how to recover).

## 0. Evidence base and its limits (read first)

| Source | What it holds | Window |
|---|---|---|
| GitHub issues | 400 most recent (`gh issue list --limit 400`), 156 labelled `bug`; ~60 bodies read | #384 to #1254 |
| `.sequant/metrics.json` | 261 recorded runs (outcome, phases, flags, issue count) | 2026-01 to 2026-09 |
| `.sequant/logs/run-*.json` | 94 run logs, 58 distinct issues, per-phase verdicts | 2026-09-10 to 2026-09-30 only (logs rotate at 100) |
| `entire/checkpoints/v1` | 679 checkpoints; 1,038 distinct human prompts across 180 checkpoints (machine prompts filtered out) | session history |
| `CHANGELOG.md`, `docs/` | user-visible fixes; doc coverage | 1.x to Unreleased |
| `git log --oneline -400` | 141 `fix(` + 7 `fix:` of 400 commits | 2026-05-09 to 2026-09-30 |

**Caveat for the guides team.** Nearly all of this evidence comes from one maintainer dogfooding sequant on its own repo, plus a handful of downstream projects that the same maintainer runs. "Frequency" in this document therefore means *maintainer frequency*, not external-user frequency (maintainer-reported: real external traffic is around zero, per an internal GTM baseline). The downstream non-Node adoption epic (tracker #1203, "field-2026-09-28") is the closest thing to an outside user's first run, so it is weighted up in the BUILDING section.

Data quirks:
- 3 metrics runs are dated 2026-10, and #1254 says "Found: 2026-10-01". These are UTC-vs-local timezone artifacts, not future data.
- Metrics `flags` under-record. Only `--quality-loop`, `--chain`, `--sequential`, `--testgen` and `--qa-gate` show up; `--phases` shows only through the `phases` field.
- Comment counts on #749 (284) and #972 (550) are bot noise. They are not a sign of discussion.

---

## 1. Top 25 edge cases

"Fixed in" is the oldest CHANGELOG section that cites the issue (approximate; "Unreleased" means after 2.18.0). Docs coverage counts only `docs/` outside internal/marketing/incidents/investigations, plus README:
- **yes**: troubleshooting, guides, getting-started, reference or README covers the *symptom* a user would search for.
- **partial**: only a `docs/features/*.md` page (a per-issue dev doc you can't find from the error text) mentions it, or the fix is mentioned without the symptom.
- **no**: nothing found.

### BUILDING

| # | Symptom (user's words) | Root cause (one line) | Recovery / answer | Refs | Fixed in | Public docs |
|---|---|---|---|---|---|---|
| B1 | "The run sat there retrying spec for 30 minutes" / "Skills pre-flight failed" | `.claude/skills/` was missing (plugin-only install, or a stale main checkout), so the agent hunted for `/spec`, and the failure looked like a GitHub flake retry | `sequant sync --only skills` (Unreleased) or `sequant doctor`; keep the main checkout current, because spec runs there, not in a worktree | #813, #933, #1193, #1201, ADR-0002 | 2.10.0; one-remedy message Unreleased | **yes** (troubleshooting.md "Run fails with Skills pre-flight failed"). Guide finding: before #1201 the remedy said plain `sequant sync`, which also rewrites hooks, settings and AGENTS.md. Check that the doc gives the narrow remedy. |
| B2 | "MCP server won't connect: `CONNECTION_CLOSED`" | the project's own `node_modules/sequant` (an old devDependency) shadows the `npx sequant@<pin>` the plugin launches | remove or upgrade the local `sequant` devDependency; newer releases use an inline `node -e` launcher | #1084, #1089, #389 | 2.16.0 / Unreleased | **yes** (troubleshooting.md "MCP server dies with CONNECTION_CLOSED") |
| B3 | "`sync`/`update` deleted my hook / rewrote AGENTS.md / reset my constitution / clobbered settings.json" | a family of file-by-file overwrite bugs: sync copied templates wholesale and ignored project ownership | upgrade to ≥2.17 (one ownership rule, #1090); AGENTS.md carries an ownership hash marker; run `sync --dry-run` first | #708, #814, #990, #1071, #1078, #1090, #1122, #1123 | 2.15–2.17 | **partial** (README "AGENTS.md ownership"; troubleshooting "Conflicts during update"; nothing on settings.json hook groups) |
| B4 | "My repo changed by itself while Claude was open" | the plugin's `sequant@latest serve` ran preAction auto-sync in every project it started in | upgrade to ≥2.13.1; pin the MCP version | #988 | 2.13.1 | **partial** (features/mcp-server.md "Version pinning"; no symptom-level entry) |
| B5 | "Python repo: worktrees have no deps", "`npm ci` runs in my uv/poetry repo", "`uv pip install` fails" | the package-manager detector was JS-only, and provisioning installed without checking for a manifest | upgrade (Unreleased): `uv sync --frozen` when `uv.lock` is present, and no install without a manifest; `init --manifest-only` for non-Node repos | #1196, #1217, #1231, #1209 | Unreleased | **partial** (stacks/python.md, features/python-stack-support.md; no troubleshooting entry) |
| B6 | "`npm ci` EUSAGE on every worktree, banner says `Stack unknown`" | the Node package lives in a subdirectory; provisioning runs `ciInstall` at the worktree root | **OPEN.** Workaround: install inside the worktree subdirectory by hand, or ignore it if phases don't need deps | #1243 | open | **no** |
| B7 | "pnpm/yarn project got `npm ci`", "Yarn 1 rejects `--immutable`" | bare `\|\| "npm"` fallbacks, and a Yarn-berry-only flag | upgrade ≥2.14; declare `packageManager` in package.json | #847, #870, #871, #932 | 2.10–2.14 | **partial** (features/package-manager-detection.md) |
| B8 | "My issue clearly has acceptance criteria but sequant says 0 ACs" | the parser accepted only ID-prefixed forms; bare checkboxes, bold IDs and fenced examples misparsed | write ACs as `- [ ] AC-1: …`, one line each, under `## Acceptance Criteria`; since 2.10 bare checkboxes under that heading parse too | #422, #808, #850, #946, #947 | 2.10.0 | **no** for issue authors (concepts/quality-gates.md shows the format; no "how to write an issue sequant can run" guide) |
| B9 | "Worktrees from two repos collided", "Glob for issue #9 picked another project's worktree" | `../worktrees/` is one namespace shared by sibling repos | ≥2.11 namespacing; `run.worktreeRoot` / `SEQUANT_WORKTREE_ROOT` (Unreleased) | #900, #1199 | 2.11.0 / Unreleased | **yes** (guides/git-workflows.md "Worktree Locations") |
| B10 | "`timeout: command not found` on Mac" | skills and hooks assumed the GNU coreutils `timeout` | upgrade ≥2.15.1 (perl fallback), or `brew install coreutils` | #1054 | 2.15.1 | **no** |
| B11 | "`sequant update` crashes in CI / a script" | there was no non-interactive path | `sequant update --yes` | #709, #724 | 2.6.2 | **yes** (troubleshooting.md "`update` crashes or exits in CI") |

### SOLVING

| # | Symptom | Root cause | Recovery / answer | Refs | Fixed in | Public docs |
|---|---|---|---|---|---|---|
| S1 | "I ran spec only; now `--phases exec` says `already ready_for_merge — skipping`" | terminal status was set from overall success even when no qa ran | upgrade (Unreleased), or re-run with `--force` | #1233 | Unreleased | **no** |
| S2 | "Spec-only batch: 0 passed · 4 failed — `No commits between main and feature/…`" | PR creation ran for phase sets that have no implementing phase | upgrade ≥2.11 | #920 | 2.11.0 | **partial** (features/exec-qa-phase-guards.md) |
| S3 | "Run says passed but there's no PR", "exec left work uncommitted" | zero-diff/uncommitted exec wasn't fatal; the agent backgrounded the test suite and ended its turn | upgrade ≥2.15 (guard, WIP-commit, background tasks blocked under the orchestrator); recover by committing in the worktree and re-running `--phases qa` | #534, #879, #1032, #1234 | 2.10–2.15 / Unreleased | **partial** (features/exec-qa-phase-guards.md; troubleshooting "Commits landed on main" is a different case) |
| S4 | "QA said AC_MET_BUT_NOT_A_PLUS and the run failed with no PR" | the verdict was treated as a failure and fed into `-Q` | upgrade ≥2.9; this verdict means "ship to PR, polish optional" | #749 | 2.9.0 | **yes** (concepts/quality-gates.md, guides/workflow.md) |
| S5 | "QA said NEEDS_VERIFICATION and now I can't re-run QA" / "MCP ignores force" | NEEDS_VERIFICATION mapped to `ready_for_merge`, and MCP dropped `force` | ≥2.13: state is `awaiting_verification`; `sequant run N --phases qa` re-runs with no `--force` | #972 | 2.13.0 | **partial** (features/qa-verdict-workflow-states.md only) |
| S6 | "`--chain` successors didn't build on the previous issue" / "chains fail a lot" | successors branched from main; and chains fail much more than single issues | ≥2.9 for ancestry; prefer single-issue or parallel batches; re-run the identical command to resume a chain | #748, #767, #837, chain-mode-analysis | 2.9.0 | **yes** (reference/run-command.md "Chain Mode", reference/chain-mode-analysis-2026-05.md) |
| S7 | "PR title reads `feat(#N): feat(x): …`, body is a placeholder, QA note missing" | two PR producers (the exec skill and createPR); no prefix stripping | upgrade (Unreleased): one producer, PR updated after QA | #1223, #1244, #1247, ADR-0004 | Unreleased | **partial** (features/run-pr-creation.md, ADR-0004) |
| S8 | "/fullsolve merged my PR without asking" | Phase 5.3 ran `gh pr merge` unconditionally | ≥2.12: merging is opt-in (`--auto-merge` / `run.autoMerge`) | #958, #961 | 2.12.0 | **yes** (guides/quickstart.md "It stops at PR creation") |
| S9 | "The QA comment on the issue says one thing, the run another" (failing verdict never posted; re-run verdict not posted; first `Verdict:` mention recorded; "0/1 met" on an 8-AC issue) | posting was gated on phase success; the verdict regex took the first match; the loop recorded the first verdict | ≥2.18 for #1070/#1119/#964/#1073. **Still open: #1245** (status uses the first of looped verdicts); read the run log, not the comment | #964, #1070, #1073, #1119, #1245 | 2.17–2.18; #1245 open | **no** |
| S10 | "Ran on an issue that's already merged and burned a phase" / "status says merged but my PR is open" | the pre-flight guard trusted local state; reconcile matched `(#N)` in any squash title | ≥2.15; `sequant status` reconciles with GitHub; for a false "merged", `--force` and do not run cleanup | #592, #606, #616, #1044 | 2.3–2.15 | **partial** (features/status-reconciliation.md; reference/state-command.md "Recover from Corrupted State") |

### RESOLVING

| # | Symptom | Root cause | Recovery / answer | Refs | Fixed in | Public docs |
|---|---|---|---|---|---|---|
| R1 | "Rate limited — resets at …", "the overnight run just stopped" | subscription five-hour/seven-day window; it used to be misclassified as terminal billing | `--auto-wait` for attended runs; `sequant resume` plus cron/launchd for unattended ones (lock released, survives reboot, 2 re-entries per issue) | #761, #799, #804, #860, #892 | 2.10–2.14 | **yes** (reference/halt-and-resume.md, run-command.md "Auto-wait") |
| R2 | "Codex: You've hit your usage limit" and the quality loop kept retrying | Codex `turn.failed` was untyped (`unknown`) | ≥2.17; `--auto-wait`, or wait for the printed reset | #1087 | 2.17.0 | **yes** (troubleshooting.md "Codex phase fails with …usage limit") |
| R3 | "Exec died at exactly 30 minutes" / "it said Out of credits but I had credits" / "worktree half-deleted, no run log" | per-phase timeout of 1800 s plus the MCP no-progress watchdog; signal cleanup outran the SIGKILL grace (#1222). Maintainer observations, no issue filed: the watchdog is one per MCP call, so multi-issue MCP batches die; a 1800 s timeout can be labelled "Out of credits" and skip retries | raise `--timeout` / `PHASE_TIMEOUT`; split batches; commit often; re-run with `--resume` or `--phases exec,qa`; ≥Unreleased for #1222 | #799, #833, #1100 (field case), #1222 | 2.10 / Unreleased | **partial** (troubleshooting.md "Timeout errors" covers PHASE_TIMEOUT; no mention of the MCP watchdog or the mislabeling) |
| R4 | "`sequant run` got killed by SIGTERM about 2 minutes in" | a nested phase `claude` that hangs after its turn is killed at ~106 s and takes the process group with it | **OPEN.** Don't background `sequant run` from an agent; run in the foreground or through MCP | #856, #934 | partial (exit code 2.10) | **no** (docs/incidents/856 only) |
| R5 | "QA rebased my pushed branch; now I have to force-push" | the qa phase rebased onto origin/main mid-review | ≥2.17 (qa no longer rebases); recover by merging main into the branch instead of force-pushing | #1069 | 2.17.0 | **no** |
| R6 | "`cleanup-worktree` closed my open PR" / "deleted the wrong branch" / "always says PR not merged" | unconditional remote delete; substring branch match; raw-argument merge check | ≥2.10; merge first, then clean up; reopen a closed PR by re-pushing the branch | #575, #750, #838, #844, #1145 | 2.9–2.18 | **partial** (troubleshooting.md "Orphaned worktrees"; guides/git-workflows.md "Merge first, clean up after") |
| R7 | "`sequant merge --check` says BLOCKED but each PR is fine" | combined-branch test ran without reinstalling deps after a lockfile change | ≥2.10 (reinstall step) | #803 | 2.10.0 | **yes** (reference/merge-command.md "Combined Branch Test") |
| R8 | "QA keeps failing AC_NOT_MET on an AC that can't be met as written" | the AC's lever is wrong; exec/loop re-runs cannot fix it | edit the AC **text** on the issue (a decision comment is not enough), then `sequant run N --phases qa`; ≥Unreleased spec can halt before exec (`SPEC_DIVERGENCE`) | #1094 (field case), #1250, #1015, model-ladder | Unreleased (#1250) | **partial** (reference/model-ladder.md covers the halts; nothing on editing ACs). **Open: #1254**, a ladder halt that is recorded as phase success |
| R9 | "`-q` didn't make it quiet" | `-q` is `--quality-loop`, not `--quiet` | use `--quiet` | #658 | 2.4.0 (doc fix) | **partial** (features/quiet-mode-heartbeat.md) |

That is 30 rows. If a hard cap of 25 is needed, drop B10, B11, R7, R9 and B4 first: they are fixed, low-recurrence, or already well documented.

**Still open on latest (guides must caveat these):** #1243 (subdir npm ci), #1245 (first looped verdict wins), #1254 (ladder halt unrecorded), #856 / #934 (106 s kill / containment), #919 (lock steal residual).

**Biggest doc gaps (no or partial with high recurrence):** S1, S9, B8, R3, R5, S3, S5 (the `--phases qa` re-run, see story 2), B6.

---

## 2. Happy-path user stories (6–10)

Personas with evidence: (a) **solo maintainer on a Node repo** (the sequant repo itself); (b) **downstream adopter on a non-Node stack** (epic #1203: #1193, #1196, #1201, #1209, #1217, #1231, #1243); (c) **plugin/MCP user driving sequant from inside Claude Code** (#972's 20-issue plugin run; 39 issue titles mention MCP). No other personas are supported by the data.

| # | Who | Wants | Commands actually used | Frequency evidence |
|---|---|---|---|---|
| 1 | Maintainer | one issue, plan → code → review → PR, unattended | `npx sequant run N` (default spec,exec,qa) | 80/261 runs are spec+exec+qa; 185/261 runs are single-issue; 44 distinct `sequant run` prompts in entire |
| 2 | Maintainer after AC_NOT_MET | fix the gap (by hand or with the agent), then get a fresh verdict and a PR | `sequant run N --phases qa` (sometimes `--phases exec,qa`) | **74/261 runs are qa-only**, the second most common shape. In the log window, 24 issues hit AC_NOT_MET and 20 of them reached a PR via a later qa-only run. Under-documented (S5) |
| 3 | Maintainer wanting auto-iteration | let sequant loop on QA findings | `sequant run N --quality-loop` / `-Q`; `/loop` | `--quality-loop` on 114/261 runs; 29 spec+exec+qa+loop runs |
| 4 | Interactive user in Claude Code | drive one issue conversationally, stop at PR | `/fullsolve N` (or `/spec`, `/exec`, `/qa` step by step); `/assess N` first | 42 fullsolve and 87 phase-skill prompts in entire; 24 assess prompts |
| 5 | Maintainer with a planned set of issues | run dependency-ordered waves | `/graph-plan` → `/graph-run` ("run wave 2"), which uses `sequant run A B C` (concurrency 3) | labels graph-2026-09 (16), -w2 (9), -field (12), -prerelease (5); 24 graph/wave prompts; 36+28+10+2 multi-issue runs |
| 6 | Plugin / MCP user | trigger runs from a chat session and poll | `sequant_run`, `sequant_status`, `sequant_logs` MCP tools | 39 MCP issue titles; #972 (20-issue overnight plugin run), #1069 (qa via `sequant_run`) |
| 7 | Adopter on a new stack | install, init, first run | `npx sequant init` (`--manifest-only` for non-Node), `sequant doctor`, `sequant sync --only skills` (Unreleased), then `sequant run N` | 47 init/sync/update issue titles; the field-2026-09-28 epic is a full first-run story with 7+ defects |
| 8 | Maintainer after a batch | check that the batch merges cleanly, then merge by hand | `sequant merge --check`, then `gh pr merge` (human) | 93 "merge" prompts in entire, the top workflow keyword; the human merge gate is the norm (#958) |
| 9 | Maintainer (internal only) | cut a release | `/release` | 77 release prompts. Maintainer-only; **not a user guide topic** |

Recurring meta-workflow seen in entire: after any "done", the user asks **"any gaps?" → "fix all gaps, plan first"** (58 distinct prompts). The second most common confusion theme is **"why did qa re-run / is it stuck / why is X parked"** (34 "why…" prompts, 21 resume/rerun/handoff prompts). Explicit rate-limit prompts were close to zero: the rate-limit pain shows up in issues, not in chat.

---

## 3. Strategic-use patterns: paid off vs. overkill

| Pattern | Verdict | Evidence |
|---|---|---|
| **Single issue, default phases** | Pays off; the baseline | 80% success for spec+exec+qa single-issue vs 28.6% for chains (reference/chain-mode-analysis-2026-05.md) |
| **`--chain`** | Mostly overkill; use only for genuinely stacked work | 2/7 chain runs succeeded; ancestry was broken until #748 (2.9); prose `Depends on` silently reordered runs (#767) |
| **Parallel batches (no chain)** | Pays off for independent issues, but 52.6% success; failures are per-issue | chain-mode-analysis; #867 (summary time was summed, not wall clock), #458 (state race) |
| **Quality loop `-Q`** | Pays off now; was harmful until fixed | 114 runs use it. Before 2.9/2.10 it misrouted AC_MET_BUT_NOT_A_PLUS into failure with no PR (#749) and retried into billing walls (#799), reporting them as "unparseable verdict". #581: same-SHA/same-verdict loops |
| **Dependency graphs (`/graph-plan` + `/graph-run`)** | Paid off as a **defect finder and release gate**; ceremony for simple issues | Waves shipped 2.15–2.18 (guard, w2, prerelease, field). Field waves *found* #1193, #1222, #1223, #1233, #1243. Maintainer feedback: for well-specified skill-only issues, run `/exec` + `/qa` directly; graph-plan is for file-overlap graphs |
| **Model tiering / ladder / advisor** | Ladder: shipped, value unmeasured. Advisor: **NO-GO** | docs/investigations/advisor-tool-phase0-2026-09.md: 18 runs, same verdict mix, exec cost ×2.1. Metrics recorded the wrong model until #1227. Ladder halts not persisted (#1254, open) |
| **Ready gate (`--ready-gate` / `sequant ready`)** | **Unproven** | The motivation is real: fresh-session QA caught would-ship defects in 12/27 passes (44%). But ready-gate-backtest.md says "empirical numbers pending". Driver settings didn't reach the gate (#863); chain resume re-gated links (#837) |
| **MCP server** | Useful for chat-driven runs; the highest-friction surface | 39 MCP issues: CONNECTION_CLOSED shadowing (#1084), serve auto-sync rewriting repos (#988), config over-grant with secrets in argv (#936), 30-min watchdog per call (R3), ignored `force` (#972) |
| **GitHub Action** | Shipped, **no evidence of use** | One issue (#370); zero run logs or prompts reference it; docs/features/github-actions-integration.md exists |
| **Alternate drivers (Codex/aider/opencode)** | Experimental; Codex needed 3 fixes to run at all | #1076 (no commits under workspace-write), #1079 (offline), #1087 (quota untyped) |
| **Halt-and-resume vs `--auto-wait`** | Both justified; pick by attendance | auto-wait-vs-halt-resume-860.md: auto-wait holds the lock and is lost on reboot; resume survives reboots and needs cron |

---

## 4. Quotable before/after examples

**Clean: #1199 "feat(worktree): configurable worktree root" → PR #1226**
- Run log: `spec:success > exec:success > qa:success(READY_FOR_MERGE)`, 1,481 s (~25 min).
- Issue trail: a runner-context comment (owner decision recorded) at 04:58 → spec "Complexity: Standard (2 ACs, 6 directories)" at 05:01 → "QA Verdict: READY_FOR_MERGE, AC coverage 4/4 met" at 05:24 → runner spot-check at 05:50 → squash-merged as `4797ac8c`.
- Teaching note: the issue still had to be **closed by hand**, because `closingIssuesReferences` didn't fire. Verify closure after merge.
- Other clean single passes: #1179 → PR #1180 (AC_MET_BUT_NOT_A_PLUS; two fix-now gaps fixed in one follow-up commit), #1160 → PR #1168, #1250 → PR #1253 (NEEDS_VERIFICATION → human verification).

**Failed and recovered: #1100 (init JSONC preservation) → PR #1102**
- First exec was **killed at the 30-minute wall** (runner note 04:23: "previous exec killed at the 30-minute wall; resuming").
- Then `exec > qa(AC_NOT_MET)` twice (1,970 s and 725 s), with the gap named in the verdict: "the documented fallback path still strips JSONC".
- After the fix: `qa:success(AC_MET_BUT_NOT_A_PLUS)` → PR #1102.
- Illustrates R3 (timeout), story 2 (`--phases qa` re-run), and S9 (posted coverage "0/2 met" under a passing verdict, a #1073-class miscount).

**Recovered by changing the AC, not the code: #1094 (golden-corpus hook snapshot) → PR #1128**
- `spec > exec > qa(AC_NOT_MET)` → `qa(AC_NOT_MET)` → two "Runner edit to AC-1" comments (QA measured the `hook-log ≥ 50` floor as unreachable) → `qa(AC_MET_BUT_NOT_A_PLUS)` → PR.
- The model for R8: when the AC is wrong, edit its text and re-run qa.

**Recovery from a misrecorded verdict: #1070**
- Passed qa three times, but was recorded as AC_NOT_MET each time because the parser took the first quoted `Verdict:` (#1119).
- The guide lesson: read the final `### Verdict` heading in the run log or comment.

**Quantified recovery rate (log window 09-10 → 09-30):** 58 issues, 53 reached a PR. 24 hit AC_NOT_MET at least once, and 20 of those still reached a PR, almost always through a qa-only re-run after a fix.

---

## 5. Redaction flags before publication

- **#1243** body names a downstream private repository (owner/repo slug). Strip it.
- **#850** and **#972** name downstream projects (a maps app; a video-generation project). Genericize them to "a downstream project".
- **#988, #1078, #1054** describe incidents in the maintainer's local downstream projects (counts, dates). Keep the mechanism, drop the project identities.
- **#900** body quotes a home-directory path layout. Rephrase it as `<parent>/worktrees/`.
- `docs/features/interactive-relay.md:146` links the repo under the old personal-account URL. This is not secret, but it's stale; fix it before linking.
- **#936** concerns secrets passed in argv. Describe the class only and quote no config content.
- **Entire transcript prompts** in this document are paraphrased with checkpoint ids omitted. Keep them paraphrased, and don't publish checkpoint contents.
- **Excluded on purpose:** #862 and any opencode field evidence (the #1115 title is fine; its body is not used); API keys; emails; absolute home paths.
- Internal-only artifacts cited for evidence (`.sequant/metrics.json`, run logs, memory-derived facts such as "real traffic ~0") should be summarized, not reproduced.

## 6. Method notes

- Issue bodies were fetched with `gh api repos/sequant-io/sequant/issues/N`.
- Doc coverage comes from `grep -rIi` over `docs/` + README, excluding internal/marketing/incidents/investigations, with each yes/partial cell checked against the file.
- Metrics and log aggregates come from `jq` over `.sequant/metrics.json` and `.sequant/logs/run-*.json`.
- Entire: `prompt.txt` files were split on turn separators; orchestrator/skill/system text was filtered; prompts were deduplicated on their first 200 characters; categories were assigned by keyword regex, so they overlap and counts are approximate. Around 22 checkpoints share one pasted `/graph-run` handoff, which inflates the graph counts.
