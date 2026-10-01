# Persona audit: experienced Sequant user vs. the docs

**Persona:** has used `/spec`, `/exec`, `/qa`, `/fullsolve`, `/assess` and `sequant run` on 2–3 projects for about two months. Has never read the source or the maintainers' notes.
**Sources used:** `README.md`, `docs/**` (excluding `internal/`, `marketing/`, `investigations/`, `incidents/`), `skills/*/SKILL.md`, and `npx sequant@latest <cmd> --help` (installed version **2.18.0**).
**Date:** 2026-09-30

How each scenario was navigated: start at `docs/README.md`, follow links, and fall back to grep (the "site search") only when navigation ran out. Hop count = pages opened, starting at `docs/README.md`.

## Structural finding (it drives most results below)

`docs/README.md` has **no Features section**, so the 50+ pages under `docs/features/` cannot be reached from the index. Some of them link to each other, but no indexed page links into the ones a power user needs:
`features/parallel-execution.md` (the only parallel-vs-chain WHEN guide), `features/qa-verdict-workflow-states.md`, `features/spec-by-default.md`, `features/github-actions-integration.md`, `features/mcp-server.md`, `features/error-capture.md`, `features/stacked-prs.md`, `features/python-stack-support.md`. The same applies to `docs/adr/`. Grep was the only way to find these pages. The README "Documentation" list does not cover them either; it links `concepts/what-is-sequant.md` and a handful of reference pages.

The index also says *"Command documentation is in `.claude/skills/<command>/SKILL.md`. Individual reference pages coming soon."* That path holds in this repo, but a docs-site reader has no per-command page, so the slash commands have no reference.

---

## Scenarios

### 1. `/qa` returned AC_NOT_MET. Should I rerun exec, edit the issue, or override?

- **Path:** docs/README → guides/workflow.md (Phase 4 verdict table: "Fix issues", "run `/loop 123`", Pattern: Quality Iteration) → concepts/quality-gates.md (verdict determination, Quality Loop "What Requires Manual Intervention") → reference/cheat-sheet.md ("Fix and re-run `/qa`"). Grep for `AC_NOT_MET` then found features/qa-verdict-workflow-states.md (status `in_progress`, "continue the fix loop with `sequant run <N>`") and adr/0005 ("The owner resumes by editing the AC lines and re-running; a decision comment alone does not re-open the work").
- **Hops:** 4 via navigation plus 2 found by grep.
- **Grep needed:** yes, for the state-machine and edit-the-AC guidance.
- **Answer found:** **Partial.** Covered: "run `/loop`, then `/qa` again" and "`sequant run <N> -Q`". Not covered:
  - How to triage *why* it failed: a real implementation gap, a wrong or contradictory AC, or a gate floor such as a missing mutation marker, `Injection Acted On`, a Semgrep ERROR, or a build regression. quality-gates.md lists the floors but never presents them as a diagnosis list.
  - When to stop looping and edit the issue instead. model-ladder.md's capability-bound vs spec-bound table is the best mental model in the docs, but it is framed around the opt-in ladder, not around "what do I do now."
  - That a comment does not re-open the work; only editing the AC lines does. This appears only in an unindexed ADR, scoped to SPEC_DIVERGENCE.
  - Override: the docs have none. The honest answer is "you hold the merge button; the verdict is advisory to you". That is implied by the human-merge-gate framing but never stated for AC_NOT_MET.
  - Whether `/qa` re-runs incrementally (features/qa-incremental-rerun.md exists but is orphaned).
- **Confidence:** medium.
- **The docs should have:** a "QA said AC_NOT_MET — decision tree" page:
  1. Read the gap marker or findings.
  2. If the finding is `fix_now` → `/loop N` or `sequant run N --phases exec,qa -Q`.
  3. If the AC is wrong or contradictory → edit the AC lines in the issue body (comments don't count) and re-run with `--force` if the status is complete.
  4. If a gate floored the verdict (mutation marker, trust boundary, Semgrep, build regression) → the specific fix for that gate.
  5. If you disagree → merge anyway; sequant never blocks a human merge, but record why.

### 2. A rate limit or usage cap hit halfway through a 5-issue batch. How do I resume without redoing work?

- **Path:** docs/README → reference/halt-and-resume.md (indexed, clear) → reference/run-command.md §Auto-wait and the chain "Rate-limit halts" note → reference/cheat-sheet.md "Resume a failed run: `sequant run 123 --resume`".
- **Hops:** 3.
- **Grep needed:** no.
- **Answer found:** **Mostly.** halt-and-resume.md is one of the best pages: a comparison table against `--auto-wait`, the halt record, re-entry bounds, and cron/launchd recipes. Gaps:
  - **Two resume mechanisms are never disambiguated.** `sequant resume` (command, reads `windowHalt.resumeAt`) and `sequant run N --resume` (flag, "reads phase markers from GitHub") never reference each other. The flag is missing from run-command.md's options table.
  - "Re-run the identical command and completed links are skipped" is documented only for `--chain`. For the default parallel batch, the user has to infer from qa-verdict-workflow-states.md (orphaned) that `ready_for_merge` issues are skipped without `--force`.
  - The docs don't say what happens to batch issues that never started, or that failed for another reason, when the window closed. Do they get a halt record? Does `sequant resume` pick them up or only the "halted" ones? Since limits are account-wide, all concurrent issues probably hit it at once. The docs don't say.
  - "Out of credits" never waits and never resumes. The docs state this, but they don't say what the user should do once credits are topped up (presumably re-run).
- **Confidence:** medium-high for a single issue, medium for a batch.
- **The docs should have:** a "Recovering a batch after a rate limit" how-to: `sequant status --issues` to see which issues finished, halted, or never started → `sequant resume` (halted) and/or re-run the same `sequant run` list (completed issues auto-skip) → when to use `--resume` vs `--force`.

### 3. My worktree disappeared after the PR merged; I had uncommitted notes, or I want to continue with a follow-up.

- **Path:** docs/README → concepts/worktree-isolation.md (Cleanup: `cleanup-worktree.sh`, `/clean`) → guides/git-workflows.md "Merging PRs with Active Worktrees": *"The post-tool hook handles this automatically for merges run inside Claude Code. If the merge fails, the worktree is preserved."* → troubleshooting.md "Worktree not found" ("recreate it: `./scripts/new-feature.sh <issue-number>`").
- **Hops:** 4.
- **Grep needed:** no for the "why", yes to confirm the claim is also in run-command.md ("Worktrees and branches are cleaned up automatically by the post-tool hook").
- **Answer found:** **No.**
  - Why it vanished: explained, in one sentence buried in git-workflows.md.
  - Whether uncommitted changes survive the automatic removal: **unspecified.** The manual recipe the hook mirrors uses `git worktree remove --force`, which discards them. concepts/worktree-isolation.md lists "Uncommitted changes" under Context Preservation, which implies the opposite.
  - Recovery: nothing. No mention of `git stash` before merging, no "is there a backup", no opt-out of auto-cleanup.
  - Follow-up work: no guidance on whether to reopen the same issue, file a new issue, or use `--base` from the merged branch.
- **Confidence:** low.
- **The docs should have:** a warning box in the merge section ("the hook removes the worktree on a successful merge — commit or move anything you want to keep first"), whether uncommitted files are lost, and a "follow-up after merge" recipe (new issue → `sequant run N`, which branches from fresh `origin/main`).

### 4. Two issues touch the same files. How do I run them without conflicts?

- **Path:** docs/README → reference/run-command.md (Sequential, Chain, Chain Pre-flight "File-overlap order", Stacked) → guides/workflow.md "Multi-Issue Integration" (`sequant merge --check`, `/merger`) → reference/merge-command.md. Grep then found features/parallel-execution.md "Choosing Between Parallel and Chain Mode" (orphaned) and skills/assess/SKILL.md (`Order: A → B (path)`, "⚠ overlaps #M; land sequentially").
- **Hops:** 4 via navigation plus 2 by grep.
- **Grep needed:** yes. The actual WHEN guidance is orphaned.
- **Answer found:** **Partial, and contradictory.** The pieces exist (/assess overlap annotations → chain vs parallel → merge --check → land in order), but nowhere are they assembled into a decision. Problems:
  - run-command.md's Execution Model says issues are **"always processed one at a time"**, with a "Why not concurrent?" paragraph. parallel-execution.md, the README ("batches run in parallel"), and `--help` (`--concurrency <n>`, default 3) all say parallel. Whether two overlapping issues run at the same time is exactly the question here, and the reference page gives the wrong answer.
  - The same page says `--sequential` is for "when later issues depend on earlier ones". That describes `--chain`; `--sequential` only stops on failure.
  - README claims "dependency-ordered batch scheduling over `blocked by #N` relationships". No user-visible page says a parallel batch honors `Blocked by`. run-command.md documents it only as a `--chain` pre-flight *warning* against your typed order (and mentions "the sorter" in passing). That claim is not backed by any page.
  - Overlapping but *independent* issues (the common case) get no recipe. A plausible one is "run in parallel, merge the first, the second's pre-PR rebase picks it up". A pre-PR rebase onto `main` exists (`--no-rebase` in `--help`), but the docs mention it only in passing inside the `--stacked` caveats and never describe it for a plain batch.
  - The chain-mode success-rate numbers (29% vs 53%) are useful, but they appear without a recommendation for overlapping files specifically.
- **Confidence:** low-medium.
- **The docs should have:** a "Running related issues" decision page: independent → parallel batch; same files but no logical dependency → parallel, then land in `/assess`'s `Order:` order (with `merge --check` between); B needs A's code → `--chain` (keep to 2); want reviewable incremental diffs → `--stacked` (3+). It should also say plainly whether `Blocked by` reorders a non-chain batch.

### 5. Small typo fix: can I skip /spec? What's the cheapest correct path?

- **Path:** docs/README → guides/workflow.md ("When to skip [spec]: simple bug fixes, typos"; Pattern: Simple Bug Fix `/exec`, `/qa`) → concepts/workflow-phases.md "Skipping Phases" (`--phases exec,qa`). The README also says "There is no `--skip-spec` — use `--phases exec,qa`".
- **Hops:** 2–3.
- **Grep needed:** no (features/spec-by-default.md adds context but is orphaned).
- **Answer found:** **Yes:** `sequant run N --phases exec,qa`, or `/exec N` then `/qa N`.
- **Caveats:**
  - workflow.md says to skip spec for bug fixes. spec-by-default.md says spec now runs for `bug` labels on purpose, because "bug- and docs-labeled issues frequently contain meaningful design decisions". The two pages give opposite advice and don't reference each other.
  - "Cheapest" is never assembled. Combining `--phases exec,qa --no-mcp --models sonnet` (or a haiku-tier model) is left to the reader. No page says what each phase roughly costs.
  - It isn't clear whether exec needs ACs when spec is skipped. If the typo issue has no `- [ ]` AC, what does QA check against?
  - Docs issues get a lighter QA (features/docs-pipeline.md, orphaned). Useful, but not discoverable.
- **Confidence:** high for the command, low for "cheapest".
- **The docs should have:** a "Trivial issue fast path" box: `--phases exec,qa --no-mcp`, optionally `--models haiku`, write one checkbox AC, and when *not* to skip spec.

### 6. Using sequant on a Python, Go or Rust repo with a non-npm test command.

- **Path:** docs/README → Stack-Specific Guides → stacks/python.md ("Override commands in `.claude/.local/memory/constitution.md`") → troubleshooting.md "Using Sequant with non-Node.js projects" ("Customize test commands in your constitution"). Grep found features/python-stack-support.md (uv/poetry/pip detection, orphaned).
- **Hops:** 2–3.
- **Grep needed:** no for the basics.
- **Answer found:** **Partial.**
  - Stack guides exist and list default commands.
  - The override mechanism is prose in a constitution file, not a settings key. The docs never say whether it is enforced or just suggested to the agent.
  - **Two constitution locations** are never reconciled: README and customization.md use `.claude/memory/constitution.md` (user-owned), while python.md and customization.md also use `.claude/.local/memory/constitution.md` (layered). Which one should I put my test command in?
  - quality-gates.md "Build Verification" is written only in terms of `npm run build`. It doesn't say what a Python, Go or Rust repo gets (is `python -m build` run on both branches?).
  - python.md: "Ensure your venv is activated before running Sequant commands". Each issue runs in a fresh worktree; does the venv or `.venv` carry over? `.worktreeinclude` is documented only in reference/worktree-isolation.md, which is about sub-worktrees.
- **Confidence:** medium.
- **The docs should have:** one "Non-Node repos" page that gives the authoritative override location, how QA picks the build and test command, and how to make worktrees get a working env (venv, `.worktreeinclude`, setup hook).

### 7. A run timed out or was killed. How do I see what happened and clean up stale state and worktrees?

- **Path:** docs/README → troubleshooting.md "Timeout errors" (only "increase timeout") → reference/logging.md (JSON log, jq recipes) → reference/state-command.md (`state clean`, `status --cleanup`) → reference/concurrency.md (stale locks, `locks clear`) → reference/cheat-sheet.md Troubleshooting table (`sequant logs`, `/clean`, `state clean`).
- **Hops:** 5–6.
- **Grep needed:** partly (features/error-capture.md is orphaned).
- **Answer found:** **Partial and scattered across 5 pages.**
  - `sequant logs --failed -v` (the "show full error context" flag) is in `--help` but not in troubleshooting.
  - **`sequant abort`** appears in `--help` ("Out-of-band abort: signal a running sequant session") but **no doc mentions it.**
  - The exit codes 130/143 for killed runs are documented, but only inside run-command.md "CI/Scripting Mode".
  - What a timeout leaves behind is never stated. Worktree kept? Lock released? Can I continue with `--resume`? The timeout section's only advice is to make the timeout longer.
  - Cleanup has four overlapping tools (`/clean`, `cleanup-worktree.sh`, `state clean` / `status --cleanup`, `locks clear`). No page orders them.
- **Confidence:** medium.
- **The docs should have:** a "Post-mortem a failed or killed run" runbook:
  1. `sequant status N`
  2. `sequant logs -i N --failed -v`
  3. Check whether the worktree has commits
  4. Resume with `--resume`, or start over with `--force`
  5. Clean up stale state in order: `locks list/clear` → `status --cleanup --dry-run` → `cleanup-worktree.sh`.

### 8. Controlling cost: which model runs which phase, and how many tokens a run used.

- **Path:** README Configuration → reference/run-command.md §Per-Phase Model & Effort (good: settings, `--models`, `--efforts`, precedence, alias table, subagent inheritance) → §Effort Escalation → reference/model-ladder.md (has a "Cost" section) → reference/analytics.md §Token Usage Tracking.
- **Hops:** 4.
- **Grep needed:** no.
- **Answer found:** **Partial.** The *how* is thorough. Missing:
  - **No cost guide.** No recommended phase-to-model mix, no rough $ or token figures per phase, and no "which phase is most expensive" (QA vs exec).
  - Token tracking depends on a `SessionEnd` hook in `.claude/settings.json`. It is "per-run, not per-phase", there is no `$` figure, and you read it through `jq` on metrics.json or `sequant stats` averages. Is the hook installed by `init`? The docs don't say. The text "previously always 0" invites doubt about whether it works now.
  - Which model actually ran is recorded only as a per-run `model` field (analytics.md). No page documents a per-phase resolved model in logging.md or analytics.md.
  - The default is "inherits the CLI default model", so a user on an Opus default runs every phase on Opus without knowing it.
  - Cost-relevant knobs (`--no-mcp`, `--full-qa`, `--ready-gate`, `-Q --max-iterations`, `--escalate-effort`, `--model-ladder`) are spread over 3 pages and never presented together.
- **Confidence:** medium (config), low (measurement).
- **The docs should have:** a "Cost control" page listing every knob with its cost direction, a suggested starting mix, and how to read actual spend per run and per phase.

### 9. My issue has no ACs or is vague. What does sequant do, and how should I write issues?

- **Path:** docs/README → concepts/workflow-phases.md (spec "Drafts acceptance criteria (AC) if not present", "Lints AC for vague terms") → concepts/quality-gates.md "AC Adherence → Tips" and "Declaring Evidence" → guides/customization.md (mentions the constitution's "AC Authoring Standard"). skills/assess/SKILL.md: no ACs → CLARIFY / `?`. run-command.md: chain pre-flight warns "Missing AC".
- **Hops:** 3–4.
- **Grep needed:** to find the assess behavior and the authoring standard's location.
- **Answer found:** **Partial.**
  - It isn't clear what `sequant run` does with an AC-less issue. Spec drafts ACs in a *comment*. Does exec and QA use those? workflow.md's "derived ACs" hints yes. Does the run halt? Only `/assess` says CLARIFY.
  - **The AC authoring standard lives only in `.claude/memory/constitution.md` §2**, a file in the user's repo, not on the docs site. The format rules that decide whether an AC is parsed at all are never stated as rules in user docs: a `- [ ]` checkbox, one line, `Evidence:` (a `Verify:` clause is silently ignored, which only skills/spec/SKILL.md line 122 says). quality-gates.md only *shows* examples in that format.
  - There is no issue template and no "good vs bad issue" example. The docs don't explain Non-Goals (which `sequant ready` uses) or `Blocked by` (which must start the line).
- **Confidence:** low-medium.
- **The docs should have:** a "Writing issues Sequant can execute" guide with the exact AC grammar, `Evidence:`, Non-Goals, `Blocked by #N` placement, a copy-paste issue template, and what happens to issues with no ACs in `/assess`, `/spec` and `sequant run`.

### 10. Running sequant on a public repo: prompt injection from issue text.

- **Path:** docs/README → Reference → reference/security-trust-model.md (indexed, excellent) → THREAT-MODEL.md → reference/permissions.md.
- **Hops:** 2–3.
- **Grep needed:** no.
- **Answer found:** **Yes for understanding, partial for action.** The trust model, the `/qa` Trust-Boundary floor to AC_NOT_MET, and the residual-risk list are candid and clear. Gaps:
  - "Practical guidance" is three bullets. There's no concrete operator recipe: only run issues filed or labelled by collaborators, review the issue body before `run`, enable branch protection (THREAT-MODEL recommends this in prose only), run on a sandboxed runner with egress limits.
  - permissions.md, which the trust model points to for "tightening tool access", never mentions that phase agents run under `bypassPermissions`. It doesn't say which `deny` rules still bite there, so the pointer leads nowhere for `sequant run`.
  - **Footgun:** features/github-actions-integration.md "Option C: Comment trigger" gates only on `contains(github.event.comment.body, '@sequant run')`. There is no `author_association` check and no link to the trust model, so on a public repo any commenter can start a run with your API key against their own issue text. This is the exact attack security-trust-model.md describes.
  - The trust model links `.claude/skills/_shared/references/trust-model.md`, which a docs-site reader can't follow.
- **Confidence:** high (understanding), medium (hardening).
- **The docs should have:** a "Public-repo hardening checklist", and an author-association guard in every GH Action example that is triggered by an issue or comment.

---

## (a) Ranking: how badly the docs served each scenario (worst first)

| Rank | Scenario | Why |
|---|---|---|
| 1 | **3. Worktree gone after merge** | No answer. Whether uncommitted work is lost is unspecified, and the documented manual equivalent (`--force`) discards it. No follow-up recipe. |
| 2 | **4. Overlapping issues** | The WHEN guide is orphaned. The indexed reference contradicts itself on concurrency and mislabels `--sequential`. The README's dependency-ordering claim isn't backed by any page. |
| 3 | **9. No or vague ACs** | The rules that decide whether ACs parse at all live in a repo file, not the docs. No issue template. AC-less behavior under `run` isn't defined. |
| 4 | **1. AC_NOT_MET** | "Run /loop" is the only answer. The triage and "edit the AC, not a comment" guidance is in an unindexed ADR. No statement about overriding. |
| 5 | **7. Timed out or killed** | The answer is spread over 5 pages, `sequant abort` is undocumented, and the timeout section only says "raise it". |
| 6 | **8. Cost** | Config is thorough. Measurement (per-run tokens through a hook, no $) and guidance are missing. |
| 7 | **6. Python/Go/Rust** | Stack guides exist. The override location is ambiguous and the npm-only build-verification wording leaves doubt. |
| 8 | **2. Rate limit mid-batch** | halt-and-resume.md is strong. The batch semantics and `resume` vs `--resume` are the gaps. |
| 9 | **10. Prompt injection** | Best-documented topic. Only operator recipes and the GH Action example need fixing. |
| 10 | **5. Skip spec** | Answered in 2 hops. The only problem is mild contradicting advice. |

## (b) Power-user patterns: do the docs explain WHEN, not just HOW?

| Pattern | HOW documented? | WHEN documented? | Notes |
|---|---|---|---|
| Batching (parallel `run A B C`) | Yes (run-command, parallel-execution) | **Yes but orphaned.** parallel-execution.md has the only "Use parallel when… / Use chain when…" section, and the indexed run-command.md contradicts it (says serial). | `--concurrency` is absent from the reference table. |
| Dependency graphs (`--chain`, `--stacked`, `Blocked by`) | Yes (run-command, stacked-prs) | Partial: chain has a success-rate warning ("prefer 2-issue chains"); stacked says "3+". | Not covered: dependent issues that should *not* be chained (run A, merge, then run B). |
| Quality loops (`-Q`, `/loop`, `--ready-gate`, `sequant ready`, `--escalate-effort`, `--model-ladder`) | Yes, in depth | Partial. ready-command.md "Why it exists" and the policy table are good WHEN content. model-ladder.md's capability-vs-spec-bound table is excellent. | Missing: one page ranking them by cost and rigor, e.g. "-Q always? ready-gate for what kind of issue? full-qa when?" |
| MCP server | Yes (mcp-server.md, orphaned) | Minimal: a 4-row "MCP vs CLI" table ("Best for: single issues while working in the editor"). | The timeout ceilings (30 min per phase, 2 h absolute) appear only in Troubleshooting, without a "how many issues per call" recommendation. Not covered: when to prefer the plugin over `serve`. |
| CI / GitHub Action | Yes (github-actions-integration.md, orphaned) | **No.** It doesn't cover label vs dispatch vs comment, cost per run, or public-repo risk. | The comment-trigger example is unsafe on public repos (see scenario 10). |
| Halt/resume vs auto-wait | Yes | **Yes**, with a comparison table and "Best for" row. | This is the model the other pattern pages should follow. |
| Two modes (interactive vs `run`) | Yes | **Yes**: concepts/two-modes.md "Mode Selection Guide". | Good. |

## (c) Stale or contradictory docs

1. **Execution model:** run-command.md "Issues are always processed one at a time… Why not concurrent?" contradicts parallel-execution.md (concurrent, default 3), README ("parallel by default"), cheat-sheet ("off (parallel)") and `--help` (`--concurrency`). The cheat-sheet also calls `--sequential` "Run issues one at a time", which is wrong per parallel-execution.md.
2. **`--sequential` purpose:** run-command.md "Sequential Mode with Dependencies — use this when later issues depend on earlier ones" describes `--chain`, not `--sequential`.
3. **run-command.md options table is missing live flags** from 2.18.0 `--help`: `--concurrency`, `--resume`, `--base`, `-f/--force`, `--signal-other`, `--no-retry`, `--no-rebase`, `--isolate-parallel`, `--reflect`, `--security-review`, `--no-relay`, `--log-path`, `--log-json`/`--no-log`.
4. **Docs describe behavior the installed binary may not have:** run-command.md says `sequant run` opens the PR *right after exec* and updates it after QA. 2.18.0 `--help` still says `--no-pr  Skip PR creation after successful QA`. guides/git-workflows.md documents `run.worktreeRoot` / `SEQUANT_WORKTREE_ROOT`. Neither carries a "since vX.Y" marker, so a user on `latest` can't tell whether the docs apply to them.
5. **Who opens the PR:** workflow.md "Phase 2: Exec → Creates PR" vs run-command.md "sequant run itself, never the exec phase". Both may be right (standalone `/exec` vs orchestrated), but neither page says so.
6. **Label → phases:** workflow-phases.md maps `enhancement`/`feature` → `spec → testgen → exec → qa`. spec-by-default.md maps them → `spec → exec → qa` ("unchanged").
7. **Skip spec for bugs:** workflow.md "When to skip [spec]: simple bug fixes" vs spec-by-default.md, which deliberately runs spec for bugs.
8. **Constitution location:** `.claude/memory/constitution.md` (README, user-owned) vs `.claude/.local/memory/constitution.md` (python.md, customization.md layering). Never reconciled. troubleshooting.md just says "your constitution".
9. **Uncommitted changes in worktrees:** concepts/worktree-isolation.md "Context Preservation: uncommitted changes" vs git-workflows.md auto-removal on merge, plus the manual recipe `git worktree remove --force`.
10. **Internal and maintainer leakage on public pages:**
    - docs/README.md has an "Internal" section linking `internal/what-weve-built.md` and `internal/release-checklist.md`, so users *can* reach `internal/`. README "Documentation" also links `what-weve-built.md`.
    - workflow.md Phase 6 tells users to update `docs/internal/what-weve-built.md`, a file that exists only in sequant's own repo.
    - run-command.md "See Also: Testing Guide (`../internal/testing.md`)" and footer "*Generated for Issue #1 on 2026-01-06*".
    - halt-and-resume.md links `../investigations/…`.
    - ready-command.md cites "Empirical analysis of `.entire` logs".
    - cheat-sheet lists `/upstream` and `/release` (maintainer tools) as user commands.
11. **docs/README.md:** "Individual reference pages coming soon". The 21 slash commands still have no reference pages.
12. **Merger link:** run-command.md links `../../.claude/skills/merger/SKILL.md`. security-trust-model.md links `.claude/skills/_shared/references/trust-model.md`. These are repo paths, broken on a docs site.
13. **analytics.md token tracking:** "previously always 0", relies on a `SessionEnd` hook, per-run only. It doesn't say whether `init` installs the hook. This looks unmaintained; I can't verify it from the docs.
14. **mcp-server.md** examples pin `sequant@2.9.0`. They are flagged as "representative", but it's 9 minors old and readers copy-paste it.
15. **README "Deterministic control flow — dependency-ordered batch scheduling over `blocked by #N`"**: no user-visible page documents this for non-chain batches.
16. **THREAT-MODEL.md** makes claims about the sequant repo's own settings ("`main` has no branch protection", "Dependabot security alerts are not enabled"). These statements go stale without anyone noticing, and a user can't tell whether they are current. *(Not verified either way from user-visible sources.)*

## (d) Proposed how-to guides for experienced users

| Title | Job to be done |
|---|---|
| **Recovering from AC_NOT_MET** | Decide between loop, re-exec, editing the ACs, and merging over the verdict, based on which finding or gate failed. |
| **Running related issues: parallel, chain, stacked, or in sequence** | Choose a batch shape for issues that share files or depend on each other, and the merge order that follows. |
| **Writing issues Sequant can execute** | Get the AC grammar, `Evidence:`, Non-Goals and `Blocked by` placement right the first time, with a copy-paste template. |
| **After the merge: worktrees, leftovers, and follow-ups** | Know what auto-cleanup deletes, keep what you need, and start follow-up work on fresh main. |
| **Post-mortem a failed, timed-out or killed run** | Find the cause (`status`, `logs -v`), decide resume vs force, and clear locks, state and worktrees in the right order. |
| **Recovering a batch after a rate limit or credit stop** | Resume only the unfinished issues with `sequant resume`, `--resume` or a plain re-run, and know which one applies. |
| **Cost control and measuring spend** | Pick a per-phase model and effort mix, know which flags raise cost, and read tokens per run and per phase. |
| **The trivial-issue fast path** | Ship a typo or docs fix with the fewest phases and the cheapest settings without losing the QA gate. |
| **Sequant on Python, Go or Rust repos** | Make test, build and lint commands authoritative and give each worktree a working environment (venv, `.worktreeinclude`). |
| **Hardening Sequant for a public repo** | Restrict who can trigger runs, sandbox the runner, enable branch protection, and act on Trust-Boundary findings. |
| **Choosing a rigor level: -Q vs --ready-gate vs sequant ready vs --full-qa** | Match QA rigor and cost to the issue's risk. |
| **Driving Sequant from CI (GitHub Action)** | Choose a label, dispatch or comment trigger, budget the API key, and keep the action safe on public repos. |
| **Sequant from your editor (MCP) vs the terminal** | Know when the MCP door is better, its timeout ceilings (30 min per phase, 2 h absolute) and how they constrain batch size, and how to watch progress. |
| **Upgrading Sequant safely** | Use `sync --dry-run`, the plugin update, and the version pins, and tell whether a docs page applies to your installed version. |

Supporting fixes, apart from new guides: add a **Features** section (or fold the key feature pages into Guides) to docs/README.md. Regenerate run-command.md's options table from `--help`. Mark version-gated behavior with "since vX.Y". Move maintainer-only pages and links out of the user index.
