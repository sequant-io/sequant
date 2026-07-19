---
name: assess
description: "Issue triage and status assessment - analyze current state, detect health signals, and recommend next action with full workflow plan."
license: MIT
metadata:
  author: sequant
  version: "3.0"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash(git *)
  - Bash(gh *)
---

<!-- sequant:local-override -->
> **Local overrides (read this first).** Before following any instruction below, check whether `.claude/.local/skills/assess/overrides.md` exists. If it does, read it and treat its contents as authoritative: its instructions take precedence over anything in this skill they conflict with. This is the supported way to tailor `/assess` without forking it — `overrides.md` lives under `.claude/.local/`, which `sequant update` and `sync` never overwrite.

# Unified Issue Assessment & Triage

You are the "Assessment Agent" for the current repository.

## Purpose

When invoked as `/assess <issue-numbers>`, your job is to:

1. Gather issue context (GitHub, git, codebase)
2. Run health checks to surface red flags
3. Recommend exactly ONE action per issue from a fixed vocabulary
4. Output a scannable dashboard (batch) or focused summary (single)
5. Provide copy-pasteable CLI commands for actionable issues

**This command is read-only** — it analyzes and recommends but never takes action.

## Invocation

- `/assess 123` — Assess a single issue (detailed mode)
- `/assess 152 153 154` — Assess multiple issues (dashboard mode)
- `/solve 123` — Alias for `/assess` (deprecated, will show notice)

## Fixed Action Vocabulary

Every issue gets exactly ONE action:

| Action | When |
|--------|------|
| **PROCEED** | Clear requirements, codebase matches, no blockers |
| **CLOSE** | Resolved by another PR, duplicate, outdated |
| **MERGE** | Two issues cover 70%+ same scope |
| **REWRITE** | Existing PR/branch too stale, needs fresh start |
| **CLARIFY** | No ACs, ambiguous requirements, unresolved questions |
| **PARK** | Blocked on dependency, deferred, not automatable |

## Assessment Process

### Step 1: Context Gathering

**Concurrency check (#625, read-only):**

Probe the per-issue concurrency lock so the dashboard can flag issues another session is actively working on. `/assess` never acquires the lock — it only reports.

```bash
# Single batch call. Empty output = no issues are locked. Held issues print one
# pre-formatted `⚠ #<N> held by ...` line each, ready to paste above the dashboard.
npx sequant locks check-batch <N1> <N2> ... 2>/dev/null || true
```

If the output is non-empty, paste every line verbatim above the dashboard table (or, in single-issue detail mode, immediately above the action verdict). Do not gate the recommendation — `/assess` is read-only and must still produce its action verdict even when an issue is locked.

The orchestrator/MCP mode (`SEQUANT_ORCHESTRATOR` set) returns no output, so the call is safe to make unconditionally.

**Command prefix (#740, read-only):**

Probe once here for a global/PATH `sequant`, and reuse the result for every emitted run command below. `npx sequant` is the invocation most prone to version skew (a dual node prefix plus npx cache reuse can silently run a *stale* binary while a directly-installed `sequant` on PATH is current), so prefer a resolvable global install when one exists.

```bash
# Resolve CMD_PREFIX once here; reuse it for every emitted run command below.
command -v sequant >/dev/null 2>&1 && CMD_PREFIX="sequant" || CMD_PREFIX="npx sequant"
```

- Global install on PATH → `CMD_PREFIX="sequant"` → emit `sequant run …`
- No global install (npx-only) → `CMD_PREFIX="npx sequant"` → emit `npx sequant run …` (unchanged default — zero behavior change for npx-only users)

The probe is read-only and side-effect-free, so it runs unconditionally, including in orchestrator/MCP mode (`SEQUANT_ORCHESTRATOR` set).

**From GitHub (parallel for all issues):**

```bash
gh issue view <N> --json title,body,labels,state,comments,assignees
```

- Title, body, labels, status, all comments
- Acceptance Criteria (explicit or inferred)
- Last activity timestamp

**From Git (parallel):**

```bash
git branch -a | grep <N> || true
git worktree list | grep <N> || true
gh pr list --search "<N> in:title" --json number,title,state,headRefName,mergeable || true
```

- If branch exists: `git log --oneline main..<branch>`
- If PR exists: `gh pr view <pr> --json state,mergedAt,mergeable,commits`

**From Codebase:**

- Grep for TODOs: `Grep(pattern="TODO.*#<N>")`
- Check files referenced in issue body exist
- Identify modified files if branch exists
- For predicted-collision detection (see Step 5), pass each PROCEED candidate's body through `extractPathsFromIssueBody` from `src/lib/assess-collision-detect.ts` to build the issue → paths map used in Step 5

#### Prior Assessment Detection

Before generating output, scan the issue's existing comments for prior `<!-- assess:action=... -->` markers. The parser exposes four pure functions in `src/lib/assess-comment-parser.ts`:

| Function | Purpose |
|----------|---------|
| `findAllAssessComments(comments)` | Returns prior assess comments in chronological order (oldest first). |
| `buildSupersessionHeader(priors)` | Returns `Supersedes prior assess from <date> (<action>)` for 1 prior, `Supersedes N prior assessments (most recent: <date>)` for ≥2, or `null` for 0. |
| `detectChurn(priors, allComments)` | Returns `{ isChurn, count, firstDate }`. Fires (`isChurn=true`) only when ≥3 priors exist AND no exec phase marker (`<!-- SEQUANT_PHASE: {"phase":"exec",...} -->`) appears in any comment dated after the first prior. |
| `shouldPromptOnConflict(prior, new)` | Returns `true` only when prior action ∈ {`PROCEED`, `REWRITE`} AND differs from the new action. |

**Supersession protocol:**

1. **No priors** → omit the supersession header entirely.
2. **1+ priors** → prepend the header line returned by `buildSupersessionHeader` to the new comment body, immediately above the `→ ACTION — reason` line.
3. **Churn detected** (`detectChurn(...).isChurn === true`) → emit a dashboard warning: `⚠ #<N>  Re-assessed N times since <firstDate> without execution — possible blocker or low priority`.
4. **Conflict detected** (`shouldPromptOnConflict(prior, new) === true`) → confirm with the user via `AskUserQuestion` before posting. Skip the prompt when actions match or when the prior was `CLOSE`/`PARK`/`CLARIFY`/`MERGE`.

**This pass is read-only — never edit or delete prior assess comments.** The append-only history is the audit trail; new comments add context, they do not rewrite it.

### Step 2: Health Checks

Surface red flags. Only track signals that change the recommendation.

| Signal | Detection | Implication |
|--------|-----------|-------------|
| Referenced files don't exist | Glob/Grep | Issue may be outdated → CLOSE |
| PR has merge conflicts | `gh pr view` | Needs rebase → REWRITE |
| PR 100+ commits behind | `git rev-list --count` | Likely needs fresh start → REWRITE |
| Another issue covers same scope | Compare open issues | Consider → MERGE |
| Duplicate of closed issue | Compare recently closed | → CLOSE |
| No ACs, vague requirements | Issue body analysis | → CLARIFY |
| Open questions unanswered | Comment thread | → CLARIFY |
| Blocked on another issue | Body/comments mention deps | → PARK |
| No activity 14+ days | Timestamps | Flag as stale (warning only) |
| Stale worktree/branch from merged PR | Worktree list + PR state | → Cleanup annotation |

### Step 3: Action Selection

**Decision tree (priority order):**
1. No ACs, vague requirements → **CLARIFY**
2. Blocked on dependency → **PARK**
3. Resolved by another PR → **CLOSE**
4. 70%+ overlap with open issue → **MERGE**
5. PR 100+ commits behind or files diverged → **REWRITE**
6. Clear requirements, codebase matches → **PROCEED**

### Step 4: Workflow Detection (PROCEED/REWRITE only)

**Phase selection from labels:**

| Labels | Category | Workflow |
|--------|----------|----------|
| security, auth, authentication, permissions | Domain | `spec → security-review → exec → qa` |
| ui, frontend, admin, web, browser | Domain | `spec → exec → test → qa` |
| complex, refactor, breaking, major | Modifier | `spec → exec → qa` + `-Q` |
| (ui/frontend) + (enhancement/feature), or testable-AC signals | Modifier | inserts `testgen` before `exec` (see Testgen detection below) |
| enhancement, feature (default) | Generic | `spec → exec → qa` |
| bug, fix, hotfix, patch | Generic | `spec → exec → qa` |
| docs, documentation, readme | Generic | `spec → exec → qa` |

**Label priority:** Domain labels take precedence over generic labels. When an issue has both a domain label and a generic label (e.g., `bug` + `auth`), the domain label adds its extra phase. Example: an issue labeled `bug` + `auth` gets `spec → security-review → exec → qa` (adds `security-review` from `auth`); `bug` + `ui` gets `spec → exec → test → qa` (adds `test` from `ui`).

**Valid phases (from `PhaseSchema` in `src/lib/workflow/types.ts`):** `spec`, `security-review`, `exec`, `testgen`, `test`, `verify`, `qa`, `loop`, `merger`

**Skip spec when:** a prior `spec` phase marker already exists on the issue. Otherwise, always include spec — bug and docs issues often contain design decisions (scope boundaries, edge cases, test-strategy shifts) that benefit from a spec pass.

**Resume detection:** Branch exists with commits ahead of main → mark as resume (`◂`).

**PR review detection:** Open PR with implementation complete → mark as review-needed (`◂ qa`).

**Quality loop (`-Q`):** Recommend for everything except simple bug fixes and docs-only.

**Testgen detection:** Add `testgen` to the workflow when any apply:
- Labels include (`ui` or `frontend`) AND (`enhancement` or `feature`)
- ACs reference "unit test", "integration test", or list "Automated Test" as a verification method

Skip when: only `bug`/`fix` labels present, only `docs` label present, or a prior `testgen` phase marker exists in issue comments.

**Chain detection (suggest-only, never auto-apply):** When 2+ assessed issues have a detected dependency, emit a `Chain:` line alongside (not replacing) the default per-issue commands. False dependency inference produces silently-wrong branch topology, so the user decides.

Triggers (any one):
- Issue body or comments mention `"depends on #N"`, `"blocked by #N"`, or `"after #N"`
- One issue's described output is another issue's input (e.g., A changes a function signature that B consumes)

Format: `Chain: <CMD_PREFIX> run <N1> <N2> --chain -Q <phases>   # alternative — <one-line reason>` (`<CMD_PREFIX>` resolved in Step 1)

Flag references:
- `--chain` chains issues (each branches from previous; implies `--sequential`)
- `--base <branch>` — issue references a feature branch

### Step 5: Conflict Detection

**Active-worktree overlap.** For each in-flight worktree, check whether its diff overlaps with files the assessed issues are likely to touch.

```bash
git worktree list --porcelain 2>/dev/null | grep "^worktree" | cut -d' ' -f2 || true
```

For each active worktree, check `git diff --name-only main...HEAD` for file overlap with assessed issues.

**Predicted file-collision (PROCEED issues).** Step 5 also runs a heuristic across the bodies of unstarted PROCEED issues to predict pairs that will modify the same file once executed in parallel. The detector lives in `src/lib/assess-collision-detect.ts` and exposes three pure functions:

| Function | Purpose |
|----------|---------|
| `extractPathsFromIssueBody(body)` | Strips fenced code blocks and HTML comments, then returns the set of canonical paths the body names. Backtick-quoted paths under `.claude/`, `templates/`, `skills/`, `src/`, `bin/`, `docs/` matching `*.md`, `*.ts`, `*.tsx`, `*.json`, `*.sh` are extracted; skill-mirror prefixes (`.claude/skills/`, `templates/skills/`, `skills/`) are normalized away so `qa/SKILL.md` is the canonical form. When the body also mentions "3-dir sync" (or "across all three skill directories"), bare `<name>/SKILL.md` references and `/<skill>` slash-command mentions are also added. Globally excluded paths (`CHANGELOG.md`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) are stripped. |
| `detectFileCollisions(issuePaths)` | Computes pairwise file-path intersections across the PROCEED issues. Returns one `CollisionResult` per shared file: `{ issues: number[], file: string }`. When N issues share a file, that's a single result with `issues.length === N`. Because paths are canonical, mirrored skill files emit one collision, not three. |
| `formatCollisionAnnotations(results)` | Returns `{ orderLines, warnings, chainSuggestion? }`. Each pair (or group) emits an `Order: A → B (path)` line and one `⚠ #N  Modifies <path> (overlaps #M); land sequentially` per affected issue. When ≥3 issues collide on the same file, a `Chain:` suggestion is also returned (suggest-only — never auto-applied). |

**Output integration:**

1. Step 1 (Context Gathering) already calls `extractPathsFromIssueBody` per PROCEED candidate to build the issue → paths map.
2. After Step 4 produces the PROCEED set, pass the map to `detectFileCollisions`.
3. Render the formatted annotations in the dashboard alongside the active-worktree overlap warnings — same `Order:` / `⚠` / `Chain:` blocks defined in "Annotation Rules" below.
4. The bare-filename `Order:` exception (e.g. `Order: 551 → 552 (qa/SKILL.md)`) applies here — predicted collisions are file-collision reasons by definition.

False-positive guards and tunables (excluded paths, the path regex, the slash-command-skill derivation rule) are documented in [`references/predicted-collision-detection.md`](references/predicted-collision-detection.md) so they can change without editing this skill.

---

## Output Format

### Batch Mode (2+ issues)

**Design principle:** Dashboard first. Copy-pasteable commands. Silence means healthy.

**Table column rules:** The "Reason" column must not be truncated mid-word. If a row's reason text would exceed the column width, prefer abbreviating the reason to a shorter synonym rather than cutting a word in half. Column widths should adapt to content — do not force a fixed table width.

```
 #    Action     [ACs]  Reason                              Run
<N>   <ACTION>   [N]    <short reason>                       <workflow or symbol>
<N>   <ACTION>   [N]    <short reason>                       <workflow or symbol>
...
────────────────────────────────────────────────────────────────
Commands:
  <CMD_PREFIX> run <N1> <N2> <flags>
  <CMD_PREFIX> run <N3> <flags>              # resume
────────────────────────────────────────────────────────────────
Order: <N> → <N> (<dependency reason>)

⚠ #<N>  <warning>
⚠ #<N>  <warning>

Chain: <CMD_PREFIX> run <N1> <N2> --chain -Q <phases>   # alternative — <reason>

Flags:
  <flag>                <one-line reason>
  <flag>                <one-line reason>
────────────────────────────────────────────────────────────────
Cleanup:
  <executable command>                 # reason
  <executable command>                 # reason
────────────────────────────────────────────────────────────────

<!-- For posting to individual issues, use standard marker format: -->
<!-- assess:action=<ACTION> -->
<!-- assess:phases=<csv> -->
<!-- assess:quality-loop=<bool> -->
```

**`ACs` column (conditional):** Include the `ACs` column only when every assessed issue has at least one explicit `- [ ]` checkbox AC in its body. Otherwise omit the column entirely — do not show partial values. The counter prevents eroding table trust when some issues use implicit/narrative ACs.

#### Run Column Symbols

| Symbol | Meaning | Example |
|--------|---------|---------|
| `spec → exec → qa` | Full workflow | Standard feature |
| `exec → qa` | Skip spec | Prior spec marker exists |
| `◂ exec → qa` | Resume existing work | Branch has commits |
| `◂ qa` | PR needs review/QA | Open PR, impl done |
| `⟳ spec → exec → qa` | Restart (fresh) | Stale PR abandoned |
| `→ #N` | Merge into target | Overlapping issue |
| `?` | Needs info first | Missing ACs |
| `‖` | Blocked/deferred | Dependency or manual |
| `—` | No action needed | Already closed/merged |

#### Commands Block Rules

The commands block is headed by `Commands:` — no box-drawing, no character counting. The header label is the visual anchor.

1. Only PROCEED and REWRITE issues get commands
2. Group by identical phases + flags → same line
3. Resume issues get `# resume` comment
4. Rewrite issues get `# restart` comment
5. Chain mode issues use `--chain` flag (see `Chain:` annotation rules below)
6. If ALL issues share the same workflow, emit a single command
7. **Line splitting:** When a single command would contain more than 6 issue numbers, split into multiple commands of at most 6 issues each, grouped by compatible workflow. Example: 11 issues → two commands (6 + 5)
8. **Minimal flags:** Omit `--phases` when the resulting workflow equals the CLI default (registered at `bin/cli.ts:186`, defined as `DEFAULT_PHASES` in `src/lib/workflow/types.ts`). Prefer additive flags over restating phases — additive flags: `--testgen` and `--security-review` (`bin/cli.ts:208-209`). Use `--testgen` instead of `--phases spec,testgen,exec,qa` (or `…,testgen,…,test,qa` for ui-labelled issues, since `phase-mapper.determinePhasesForIssue` auto-adds `test` from the ui label). Use `--security-review` instead of `--phases spec,security-review,exec,qa`. The posted marker (`<!-- assess:phases=… -->`) records the full resolved workflow regardless — markers are machine-readable, displayed commands are human shorthand. This intentional divergence is fine: parsers consume markers, humans copy commands.
9. **Command prefix:** Substitute the Step-1 `CMD_PREFIX` for **every** emitted `sequant run` command — the Commands block, the `Chain:` line, and both single-issue detail-mode commands (PROCEED and the REWRITE "fresh start"). `Cleanup:` commands are `git`/`gh`, not `sequant`, so they are unaffected. A resolvable global `sequant` on PATH yields `sequant run …`; npx-only yields `npx sequant run …` (the default). Never mix prefixes within a single assessment.

#### Annotation Rules

Emit annotations in this order between the separators that follow `Commands:`:
`Order:` → `⚠` warnings → `Chain:` → `Flags:`. `Cleanup:` goes in its own block after. Omit any section (and its surrounding blank line) when it has no content.

- **`Order:`** — Only when sequencing matters. Include the **reason** for the ordering, not just `(<filename>)`. Prefer dependency reasoning over filename.
  - Good: `Order: 185 → 186 (185 changes fetchApi error format that 186 consumes)`
  - Good: `Order: 460 → 461 (460 adds batch-executor tests that 461's label matching depends on)`
  - Avoid bare filenames when a reason is clearer.
  - **Exception:** When the sequencing reason **is** a file collision (two issues both modify the same file), the filename **is** the reason and is acceptable verbatim. Example: `Order: 460 → 461 (qa/SKILL.md)` — the bare filename communicates the conflict directly.

- **`⚠` warnings** — Only non-obvious signals (complexity, staleness, dual concerns, partial-AC satisfaction). One line each, prefixed with issue number. Warnings can note when part of an AC is already satisfied in the codebase:
  - `⚠ #185  Domain errors already exist in repository layer — scope may be smaller than expected`
  - `⚠ #412  bug + auth labels — domain label (auth) takes priority over bug`

- **`Chain:`** — Only when 2+ PROCEED issues have a detected dependency (see "Chain detection" in Step 4). Suggests an alternative execution topology. Does not replace the default per-issue commands. Format:
  `Chain: <CMD_PREFIX> run <N1> <N2> --chain -Q <phases>   # alternative — <one-line reason>` (`<CMD_PREFIX>` resolved in Step 1)

- **`Flags:`** — Only when non-default flags appear in the commands and the reason isn't obvious. One line per **distinct** flag used across all commands. Omit entire section when `-Q` is the only non-default flag AND its reason is obvious (e.g., all issues are enhancements). Format:
  ```
  Flags:
    -Q                   9+ ACs or multi-file scope
    --testgen            testable ACs detected (UI hooks + API integration)
    --phases ...,test    ui label → browser verification
  ```

- **`Cleanup:`** — Only when actionable (stale branches, merged-but-open issues, label changes). Show as executable commands with `# reason` comments.

- **"All clear" is silence** — no annotation means no issues.

#### Batch Example (mixed states, with label priority)

Not all issues have explicit `- [ ]` checkboxes, so the `ACs` column is omitted.

> **Prefix in examples:** The worked examples in this doc show the `npx sequant` default (the zero-install path). When the Step-1 probe resolves a global `sequant` on PATH, `CMD_PREFIX="sequant"` and every emitted command uses `sequant run …` instead — consistently within one assessment (see Commands Block Rule #9).

```
 #    Action     Reason                              Run
 462  PARK       Manual measurement task              ‖
 461  PROCEED    Exact label matching                  spec → exec → qa
 460  PROCEED    batch-executor tests                  spec → exec → qa
 458  PROCEED    Parallel UX + race condition          spec → exec → qa
 447  CLOSE      PR #457 merged                        —
 443  PROCEED    Consolidate gh calls                  spec → exec → qa
 412  PROCEED    Auth bug (domain: auth adds review)   spec → security-review → exec → qa
 411  PROCEED    Config path normalization              ◂ exec → qa
 405  REWRITE    PR #380 200+ commits behind           ⟳ spec → exec → qa
────────────────────────────────────────────────────────────────
Commands:
  npx sequant run 461 460 458 443 -Q
  npx sequant run 412 -Q --security-review
  npx sequant run 411 -Q --phases exec,qa     # resume
  npx sequant run 405 -Q                      # restart
────────────────────────────────────────────────────────────────
Order: 460 → 461 (460 adds batch-executor tests that 461's label matching depends on)

⚠ #458  Dual concern (UX + race) across 4 files
⚠ #405  Stale 30+ days, ACs still valid
⚠ #412  bug + auth labels — auth (domain) adds security-review phase

Flags:
  -Q                              multi-file scope across most PROCEED issues
  --security-review               #412 auth label → security review required
  --phases exec,qa                #411 resume — prior spec marker already exists
────────────────────────────────────────────────────────────────
Cleanup:
  git worktree remove .../447-...      # merged, stale worktree
  gh issue close 447                   # PR #457 merged
  gh issue edit 461 --add-label cli    # missing label
────────────────────────────────────────────────────────────────

<!-- #462 assess:action=PARK -->
<!-- #461 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #460 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #458 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #447 assess:action=CLOSE -->
<!-- #443 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #412 assess:action=PROCEED assess:phases=spec,security-review,exec,qa assess:quality-loop=true -->
<!-- #411 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
<!-- #405 assess:action=REWRITE assess:phases=spec,exec,qa assess:quality-loop=true -->
```

#### Batch Example (dependent issues with testgen, chain suggestion)

All issues have explicit checkbox ACs, so the `ACs` column is shown. A dependency is detected (185 → 186), so a `Chain:` suggestion appears alongside the default commands.

```
 #    Action    ACs  Reason                           Run
 185  PROCEED    6   Domain error standardization      spec → exec → qa
 186  PROCEED    9   React Query hooks migration       spec → testgen → exec → test → qa
────────────────────────────────────────────────────────────────
Commands:
  npx sequant run 185 -Q
  npx sequant run 186 -Q --testgen
────────────────────────────────────────────────────────────────
Order: 185 → 186 (185 changes fetchApi error format that 186 consumes)

⚠ #185  Domain errors already exist in repository layer — scope may be smaller than expected
⚠ #186  @tanstack/react-query not installed; large scope (9 hooks + optimistic updates)

Chain: npx sequant run 185 186 --chain -Q --testgen
       # alternative — use if 186 should branch from 185's work

Flags:
  --testgen             #186 testable ACs (UI hooks + API integration); ui label auto-adds test phase
────────────────────────────────────────────────────────────────

<!-- #185 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #186 assess:action=PROCEED assess:phases=spec,testgen,exec,test,qa assess:quality-loop=true -->
```

#### Batch Example (all clean)

When every issue is PROCEED with no warnings, no dependencies, and no non-default flags beyond an obvious `-Q`, the output is minimal. The `Flags:` section is omitted because `-Q` is obvious here (all PROCEED enhancements).

```
 #    Action     Reason                              Run
 461  PROCEED    Exact label matching                  spec → exec → qa
 460  PROCEED    batch-executor tests                  spec → exec → qa
 443  PROCEED    Consolidate gh calls                  spec → exec → qa
────────────────────────────────────────────────────────────────
Commands:
  npx sequant run 461 460 443 -Q
────────────────────────────────────────────────────────────────

<!-- #461 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #460 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #443 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
```

Silence means clean — no `Order:`, no `⚠`, no `Chain:`, no `Flags:`, no `Cleanup:`.

#### Batch Example (large batch, 13 issues with Rule 7 split)

When assessing 9+ issues, commands are split per Rule 7 (max 6 issue numbers per line), and the table adapts to content width. Mixed AC styles across issues → `ACs` column omitted.

```
 #    Action     Reason                                   Run
 503  PROCEED    Fix typo in error output                   spec → exec → qa
 502  PROCEED    Update deprecated API call                 spec → exec → qa
 501  PROCEED    Add retry logic to API client              spec → exec → qa
 500  PROCEED    Fix token refresh race condition           spec → security-review → exec → qa
 499  PROCEED    Dashboard chart rendering bug              spec → exec → test → qa
 498  PROCEED    Update error messages                      spec → exec → qa
 497  PROCEED    Refactor batch executor                    spec → exec → qa
 496  PARK       Blocked on #490 schema migration           ‖
 495  PROCEED    CLI help text improvements                 spec → exec → qa
 494  PROCEED    Assess batch formatting fix                spec → exec → qa
 493  CLOSE      Duplicate of #491                          —
 492  PROCEED    Add export command                         spec → exec → qa
 491  PROCEED    Normalize config paths                     spec → exec → qa
────────────────────────────────────────────────────────────────
Commands:
  npx sequant run 503 502 501 499 498 497 -Q
  npx sequant run 495 494 492 491 -Q
  npx sequant run 500 -Q --security-review
────────────────────────────────────────────────────────────────
Order: 497 → 492 (497 refactors batch-executor internals that 492's export command uses)

⚠ #500  bug + auth labels — auth (domain) adds security-review phase
⚠ #499  bug + ui labels — ui (domain) adds test phase

Flags:
  --security-review     #500 auth label → security review required
────────────────────────────────────────────────────────────────
Cleanup:
  gh issue close 493                   # duplicate of #491
────────────────────────────────────────────────────────────────

<!-- #503 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #502 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #501 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #500 assess:action=PROCEED assess:phases=spec,security-review,exec,qa assess:quality-loop=true -->
<!-- #499 assess:action=PROCEED assess:phases=spec,exec,test,qa assess:quality-loop=true -->
<!-- #498 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #497 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #496 assess:action=PARK -->
<!-- #495 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #494 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #493 assess:action=CLOSE -->
<!-- #492 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #491 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
```

---

### Single Mode (1 issue)

More context since you're focused on one issue. Separators between every section.

#### PROCEED

```
#<N> — <Title>
<State> · <labels>
────────────────────────────────────────────────────────────────

→ PROCEED — <one-line reason>

Commands:
  <CMD_PREFIX> run <N> <flags>

<phases> · <N> ACs

Flags:
  <flag>        <one-line reason>
────────────────────────────────────────────────────────────────
⚠ <warning if any>
⚠ Conflict: #<N> also modifies <path>
────────────────────────────────────────────────────────────────

<!-- assess:action=PROCEED -->
<!-- assess:phases=<csv> -->
<!-- assess:quality-loop=<bool> -->
```

**`Flags:` (single mode):** Indented list of each enabled non-default flag with a one-line reason. Omit the entire `Flags:` section when `-Q` is the only non-default flag AND the reason is obvious (e.g., a straightforward enhancement). Do not repeat obvious flags.

Example with `Flags:` (non-obvious `-Q` + `--testgen`):

```
#458 — Parallel run UX freeze + reconcileState race condition
Open · bug, enhancement, cli
────────────────────────────────────────────────────────────────

→ PROCEED — Both root causes confirmed in codebase

Commands:
  npx sequant run 458 -Q

spec → exec → qa · 8 ACs

Flags:
  -Q     dual concern across 4 files
────────────────────────────────────────────────────────────────

<!-- assess:action=PROCEED -->
<!-- assess:phases=spec,exec,qa -->
<!-- assess:quality-loop=true -->
```

Example omitting `Flags:` (obvious `-Q` for a standard enhancement):

```
#443 — Consolidate gh CLI calls
Open · enhancement
────────────────────────────────────────────────────────────────

→ PROCEED — Codebase matches spec, 5 ACs

Commands:
  npx sequant run 443 -Q

spec → exec → qa · 5 ACs
────────────────────────────────────────────────────────────────

<!-- assess:action=PROCEED -->
<!-- assess:phases=spec,exec,qa -->
<!-- assess:quality-loop=true -->
```

#### CLOSE

```
#<N> — <Title>
<State> · <labels>
────────────────────────────────────────────────────────────────

→ CLOSE — <reason with evidence>
────────────────────────────────────────────────────────────────
Cleanup:
  <executable commands>                # reason
────────────────────────────────────────────────────────────────

<!-- assess:action=CLOSE -->
```

#### CLARIFY

```
#<N> — <Title>
<State> · <labels>
────────────────────────────────────────────────────────────────

→ CLARIFY — <what's missing>

Need: <specific information required>
  <details about why this blocks work>
────────────────────────────────────────────────────────────────

<!-- assess:action=CLARIFY -->
```

#### PARK

```
#<N> — <Title>
<State> · <labels>
────────────────────────────────────────────────────────────────

→ PARK — <reason>
  Resume after: <condition>
────────────────────────────────────────────────────────────────

<!-- assess:action=PARK -->
```

#### MERGE

```
#<N> — <Title>
<State> · <labels>
────────────────────────────────────────────────────────────────

→ MERGE → #<target> — <overlap description>
  This issue: <scope summary>
  Target:     <scope summary>
────────────────────────────────────────────────────────────────

<!-- assess:action=MERGE -->
```

#### REWRITE

```
#<N> — <Title>
<State> · <labels>
────────────────────────────────────────────────────────────────

→ REWRITE — <reason>

Commands:
  <CMD_PREFIX> run <N> <flags>                 # fresh start

<phases> · <N> ACs
────────────────────────────────────────────────────────────────
⚠ <stale/diverged details>
────────────────────────────────────────────────────────────────

<!-- assess:action=REWRITE -->
<!-- assess:phases=<csv> -->
<!-- assess:quality-loop=<bool> -->
```

---

## Section Visibility Rules

| Section | Show when |
|---------|-----------|
| `ACs` column (batch) | Every assessed issue has ≥1 explicit `- [ ]` checkbox AC |
| `Commands:` block | At least one PROCEED or REWRITE issue |
| `Order:` | File conflicts or dependencies require sequencing |
| `⚠` warnings | Non-obvious signals exist (complexity, staleness, dual concerns, partial-AC satisfaction) |
| `Chain:` | 2+ PROCEED issues with detected dependency (suggest-only) |
| `Flags:` | Non-default flags appear AND `-Q` is not the sole flag with an obvious reason |
| `Cleanup:` | Stale branches, merged-but-open issues, or label changes |
| Separators | Between sections that are both shown; omit if adjacent section is omitted |

Every separator and section is conditional. If there are no warnings, no chain, no flags, and no cleanup, the output is just: table → separator → `Commands:` block → separator → markers.

---

## Persist Analysis

After displaying output, prompt the user to save using `AskUserQuestion` with options "Yes (Recommended)" and "No".

If confirmed, post a structured comment to each issue via `gh issue comment`. **Each posted comment is rendered with the single-mode template that matches that issue's verdict** — the same `#### PROCEED / CLOSE / CLARIFY / PARK / MERGE / REWRITE` templates defined under [Single Mode (1 issue)](#single-mode-1-issue) above. There is no separate, thinner shape for posted comments: the batch **dashboard** in chat and the **posted comment** on each issue are the only two formats, and the posted comment always reuses the single-mode template for its verdict. (Note: this is *not* a reversal of #453 — the single-mode templates are themselves the streamlined, scan-friendly format.)

Render each comment as follows:

1. **Pick the template by verdict.** For issue `#N`'s action, use the matching single-mode template (`#### PROCEED`, `#### REWRITE`, etc.) and fill it exactly as single mode would, including — where that template defines them:
   - the `#<N> — <Title>` / `<State> · <labels>` header,
   - the section separators the template defines,
   - the `Commands:` block with the **resolved `CMD_PREFIX`** (Step-1 probe — `sequant` when a global is on PATH, else `npx sequant`) and the **real current flags** for that issue. When the dashboard batched several issues onto one `run` line (e.g. `run 461 460 458 443 -Q`), restate just `#N`'s own single-issue invocation (`run 458 -Q`): the shared flags that applied to `#N`, plus any per-issue flags the dashboard listed separately for it (e.g. `#412`'s `--security-review`, `#411`'s `--phases exec,qa`),
   - the `<phases> · <N> ACs` line,
   - for **CLOSE**, the `Cleanup:` block populated with just `#N`'s cleanup commands, de-aggregated from the dashboard's combined `Cleanup:` block.

   Reference these templates rather than re-copying their bodies here — they are the single source of truth (avoids drift). Verdicts whose template omits a field (CLOSE / CLARIFY / PARK / MERGE have no `Commands:` or `<phases> · <N> ACs` line) simply omit it, exactly as the template shows.

2. **Carry per-issue warnings.** Any `⚠` line from the batch dashboard that concerns `#N` (collision/conflict, churn, staleness, dual-concern, partial-AC) is carried into that issue's comment, with the leading `#N` dropped (the comment is already scoped to that issue). Placement depends on whether the verdict's template defines a warning slot:
   - **PROCEED / REWRITE** — the template already defines a `⚠ ...` region between its two trailing separators; place the warning there.
   - **CLOSE / CLARIFY / PARK / MERGE** — these templates have no `⚠` region (just a single trailing separator before the markers). Add the warning as its own separator-delimited block immediately above the marker block, so the tail reads: `<trailing separator>` → `⚠ ...` → `<separator>` → `<!-- assess:action=... -->`. This is the sole case where a posted comment extends a slot-less template; every other field still follows Step 1's "omit what the template omits." When an issue has no `⚠`, the template is emitted unchanged.

3. **Supersession header** (when priors exist): If `findAllAssessComments` returned ≥1 prior, prepend `buildSupersessionHeader(priors)` immediately above the `→ ACTION — reason` line. When `detectChurn(...).isChurn === true`, also emit the `⚠ Re-assessed N times since <firstDate> without execution — possible blocker or low priority` warning in the warning slot (per step 2). When `shouldPromptOnConflict(prior, new) === true`, confirm with the user via `AskUserQuestion` before posting. See "Prior Assessment Detection" in Step 1 for full protocol.

4. **Machine markers.** The posted comment keeps the single-mode **3-line** marker block — one directive per line, and only those directives the verdict defines:
   ```
   <!-- assess:action=PROCEED -->
   <!-- assess:phases=spec,exec,qa -->
   <!-- assess:quality-loop=true -->
   ```
   Do **not** use the batch dashboard's compact one-line marker (`<!-- #N assess:action=… assess:phases=… -->`) in a posted comment — that form is for the chat dashboard only.

The chat batch dashboard is unchanged — this step governs only what lands on each issue.

### Batch: dashboard vs posted comment

A batch run shows one scannable dashboard in chat, then posts one single-mode comment per issue. The two are distinct by design: the dashboard is a triage table across all issues; each comment is the full single-mode assessment for that one issue.

Dashboard (chat) — excerpt for #458:

```
 #    Action     Reason                              Run
 458  PROCEED    Parallel UX + race condition          spec → exec → qa
────────────────────────────────────────────────────────────────
Commands:
  npx sequant run 458 -Q
────────────────────────────────────────────────────────────────
⚠ #458  Dual concern (UX + race) across 4 files

Flags:
  -Q     dual concern across 4 files
────────────────────────────────────────────────────────────────

<!-- #458 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
```

Posted comment on issue #458 (single-mode PROCEED template — `#N` dropped from the warning, 3-line markers):

```
#458 — Parallel run UX freeze + reconcileState race condition
Open · bug, enhancement, cli
────────────────────────────────────────────────────────────────

→ PROCEED — Both root causes confirmed in codebase

Commands:
  npx sequant run 458 -Q

spec → exec → qa · 8 ACs

Flags:
  -Q     dual concern across 4 files
────────────────────────────────────────────────────────────────
⚠ Dual concern (UX + race) across 4 files
────────────────────────────────────────────────────────────────

<!-- assess:action=PROCEED -->
<!-- assess:phases=spec,exec,qa -->
<!-- assess:quality-loop=true -->
```

For a verdict whose template has no `⚠` slot, the carried warning becomes its own separator-delimited block above the markers (Step 2). Posted comment on a **PARK** issue the churn detector flagged:

```
#530 — Measure real-world assess latency across 20 repos
Open · task, needs-data
────────────────────────────────────────────────────────────────

→ PARK — Blocked on manual measurement not yet scheduled
  Resume after: latency sampling run completes
────────────────────────────────────────────────────────────────
⚠ Re-assessed 3 times since 2026-06-30 without execution — possible blocker or low priority
────────────────────────────────────────────────────────────────

<!-- assess:action=PARK -->
```

## Notes

- This command is **read-only** — analyzes but doesn't make changes
- Batch mode should be scannable in under 5 seconds
- Downstream tools own detail — spec owns AC breakdown, qa owns health
- When in doubt, acknowledge uncertainty in the reason column

---

## Output Verification

**Before responding, verify:**

- [ ] Every issue has exactly one action in the table
- [ ] Run column uses correct symbol for the action/state
- [ ] `ACs` column included only when every issue has explicit `- [ ]` checkboxes
- [ ] Commands appear under a `Commands:` header (no bare indented block, no box-drawing)
- [ ] Commands block only contains PROCEED and REWRITE issues, grouped by compatible workflow
- [ ] `testgen` included when ui/frontend + enhancement/feature labels OR testable-AC signals
- [ ] `Chain:` suggested (not auto-applied) when 2+ PROCEED issues have a detected dependency
- [ ] `Flags:` section present when non-default flags appear (unless only obvious `-Q`)
- [ ] `Order:` annotations carry dependency **reasoning**, not bare filenames
- [ ] `⚠` warnings include partial-AC satisfaction where applicable
- [ ] Separators appear between every shown section; omitted when adjacent section is omitted
- [ ] Annotations/sections omitted when not applicable (silence = healthy)
- [ ] HTML markers present for every assessed issue
- [ ] Supersession header prepended when prior assess comments exist (`buildSupersessionHeader`)
- [ ] Churn warning included in dashboard when `detectChurn(...).isChurn === true`
- [ ] Batch mode: table is the primary output, no per-issue detail sections
- [ ] Persist step: each posted comment uses the single-mode verdict template (not the dashboard shape or a thinner form), with per-issue `⚠` carried into the warning slot and the 3-line marker block
- [ ] Single mode: focused summary with separators between sections
