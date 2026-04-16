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
| complex, refactor, breaking, major | Modifier | `spec → exec → qa` + `-q` |
| (ui/frontend) + (enhancement/feature), or testable-AC signals | Modifier | inserts `testgen` before `exec` (see Testgen detection below) |
| enhancement, feature (default) | Generic | `spec → exec → qa` |
| bug, fix, hotfix, patch | Generic | `exec → qa` |
| docs, documentation, readme | Generic | `exec → qa` |

**Label priority:** Domain labels take precedence over generic labels. When an issue has both a domain label and a generic label (e.g., `bug` + `auth`), use the domain-specific workflow. Example: an issue labeled `bug` + `auth` gets `spec → security-review → exec → qa`, not `exec → qa`. Similarly, `bug` + `ui` gets `spec → exec → test → qa`.

**Valid phases (from `PhaseSchema` in `src/lib/workflow/types.ts`):** `spec`, `security-review`, `exec`, `testgen`, `test`, `verify`, `qa`, `loop`, `merger`

**Skip spec when:** (bug/docs label AND no domain labels like security/auth/ui/frontend), OR spec comment already exists on issue.

**Resume detection:** Branch exists with commits ahead of main → mark as resume (`◂`).

**PR review detection:** Open PR with implementation complete → mark as review-needed (`◂ qa`).

**Quality loop (`-q`):** Recommend for everything except simple bug fixes and docs-only.

**Testgen detection:** Add `testgen` to the workflow when any apply:
- Labels include (`ui` or `frontend`) AND (`enhancement` or `feature`)
- ACs reference "unit test", "integration test", or list "Automated Test" as a verification method

Skip when: only `bug`/`fix` labels present, only `docs` label present, or a prior `testgen` phase marker exists in issue comments.

**Chain detection (suggest-only, never auto-apply):** When 2+ assessed issues have a detected dependency, emit a `Chain:` line alongside (not replacing) the default per-issue commands. False dependency inference produces silently-wrong branch topology, so the user decides.

Triggers (any one):
- Issue body or comments mention `"depends on #N"`, `"blocked by #N"`, or `"after #N"`
- One issue's described output is another issue's input (e.g., A changes a function signature that B consumes)

Format: `Chain: npx sequant run <N1> <N2> --chain --qa-gate -q <phases>   # alternative — <one-line reason>`

Flag references:
- `--chain` chains issues (each branches from previous; implies `--sequential`)
- `--qa-gate` pauses chain on QA failure (requires `--chain`)
- `--base <branch>` — issue references a feature branch

### Step 5: Conflict Detection

```bash
git worktree list --porcelain 2>/dev/null | grep "^worktree" | cut -d' ' -f2 || true
```

For each active worktree, check `git diff --name-only main...HEAD` for file overlap with assessed issues.

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
  npx sequant run <N1> <N2> <flags>
  npx sequant run <N3> <flags>              # resume
────────────────────────────────────────────────────────────────
Order: <N> → <N> (<dependency reason>)

⚠ #<N>  <warning>
⚠ #<N>  <warning>

Chain: npx sequant run <N1> <N2> --chain --qa-gate -q <phases>   # alternative — <reason>

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
| `exec → qa` | Skip spec | Bug, docs, or spec exists |
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

#### Annotation Rules

Emit annotations in this order between the separators that follow `Commands:`:
`Order:` → `⚠` warnings → `Chain:` → `Flags:`. `Cleanup:` goes in its own block after. Omit any section (and its surrounding blank line) when it has no content.

- **`Order:`** — Only when sequencing matters. Include the **reason** for the ordering, not just `(<filename>)`. Prefer dependency reasoning over filename.
  - Good: `Order: 185 → 186 (185 changes fetchApi error format that 186 consumes)`
  - Good: `Order: 460 → 461 (460 adds batch-executor tests that 461's label matching depends on)`
  - Avoid bare filenames when a reason is clearer.

- **`⚠` warnings** — Only non-obvious signals (complexity, staleness, dual concerns, partial-AC satisfaction). One line each, prefixed with issue number. Warnings can note when part of an AC is already satisfied in the codebase:
  - `⚠ #185  Domain errors already exist in repository layer — scope may be smaller than expected`
  - `⚠ #412  bug + auth labels — domain label (auth) takes priority over bug`

- **`Chain:`** — Only when 2+ PROCEED issues have a detected dependency (see "Chain detection" in Step 4). Suggests an alternative execution topology. Does not replace the default per-issue commands. Format:
  `Chain: npx sequant run <N1> <N2> --chain --qa-gate -q <phases>   # alternative — <one-line reason>`

- **`Flags:`** — Only when non-default flags appear in the commands and the reason isn't obvious. One line per **distinct** flag used across all commands. Omit entire section when `-q` is the only non-default flag AND its reason is obvious (e.g., all issues are enhancements). Format:
  ```
  Flags:
    -q                   9+ ACs or multi-file scope
    --testgen            testable ACs detected (UI hooks + API integration)
    --phases ...,test    ui label → browser verification
  ```

- **`Cleanup:`** — Only when actionable (stale branches, merged-but-open issues, label changes). Show as executable commands with `# reason` comments.

- **"All clear" is silence** — no annotation means no issues.

#### Batch Example (mixed states, with label priority)

Not all issues have explicit `- [ ]` checkboxes, so the `ACs` column is omitted.

```
 #    Action     Reason                              Run
 462  PARK       Manual measurement task              ‖
 461  PROCEED    Exact label matching                  exec → qa
 460  PROCEED    batch-executor tests                  exec → qa
 458  PROCEED    Parallel UX + race condition          spec → exec → qa
 447  CLOSE      PR #457 merged                        —
 443  PROCEED    Consolidate gh calls                  spec → exec → qa
 412  PROCEED    Auth bug (domain: auth overrides bug) spec → security-review → exec → qa
 411  PROCEED    Config path normalization              ◂ exec → qa
 405  REWRITE    PR #380 200+ commits behind           ⟳ spec → exec → qa
────────────────────────────────────────────────────────────────
Commands:
  npx sequant run 461 460 -q --phases exec,qa
  npx sequant run 458 443 -q
  npx sequant run 412 -q --phases spec,security-review,exec,qa
  npx sequant run 411 -q --phases exec,qa     # resume
  npx sequant run 405 -q                      # restart
────────────────────────────────────────────────────────────────
Order: 460 → 461 (460 adds batch-executor tests that 461's label matching depends on)

⚠ #458  Dual concern (UX + race) across 4 files
⚠ #405  Stale 30+ days, ACs still valid
⚠ #412  bug + auth labels — domain label (auth) takes priority over bug

Flags:
  -q                   multi-file scope across most PROCEED issues
  --phases spec,...    spec phase added for 458/443/412/405 (standard features)
────────────────────────────────────────────────────────────────
Cleanup:
  git worktree remove .../447-...      # merged, stale worktree
  gh issue close 447                   # PR #457 merged
  gh issue edit 461 --add-label cli    # missing label
────────────────────────────────────────────────────────────────

<!-- #462 assess:action=PARK -->
<!-- #461 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
<!-- #460 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
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
  npx sequant run 185 -q
  npx sequant run 186 -q --phases spec,testgen,exec,test,qa
────────────────────────────────────────────────────────────────
Order: 185 → 186 (185 changes fetchApi error format that 186 consumes)

⚠ #185  Domain errors already exist in repository layer — scope may be smaller than expected
⚠ #186  @tanstack/react-query not installed; large scope (9 hooks + optimistic updates)

Chain: npx sequant run 185 186 --chain --qa-gate -q --phases spec,testgen,exec,test,qa
       # alternative — use if 186 should branch from 185's work

Flags:
  --testgen             #186 has testable ACs (UI hooks + API integration)
  --phases ...,test     #186 ui label → browser verification
────────────────────────────────────────────────────────────────

<!-- #185 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #186 assess:action=PROCEED assess:phases=spec,testgen,exec,test,qa assess:quality-loop=true -->
```

#### Batch Example (all clean)

When every issue is PROCEED with no warnings, no dependencies, and no non-default flags beyond an obvious `-q`, the output is minimal. The `Flags:` section is omitted because `-q` is obvious here (all PROCEED enhancements).

```
 #    Action     Reason                              Run
 461  PROCEED    Exact label matching                  exec → qa
 460  PROCEED    batch-executor tests                  exec → qa
 443  PROCEED    Consolidate gh calls                  spec → exec → qa
────────────────────────────────────────────────────────────────
Commands:
  npx sequant run 461 460 -q --phases exec,qa
  npx sequant run 443 -q
────────────────────────────────────────────────────────────────

<!-- #461 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
<!-- #460 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
<!-- #443 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
```

Silence means clean — no `Order:`, no `⚠`, no `Chain:`, no `Flags:`, no `Cleanup:`.

#### Batch Example (large batch, 13 issues with Rule 7 split)

When assessing 9+ issues, commands are split per Rule 7 (max 6 issue numbers per line), and the table adapts to content width. Mixed AC styles across issues → `ACs` column omitted.

```
 #    Action     Reason                                   Run
 503  PROCEED    Fix typo in error output                   exec → qa
 502  PROCEED    Update deprecated API call                 exec → qa
 501  PROCEED    Add retry logic to API client              exec → qa
 500  PROCEED    Fix token refresh race condition           spec → security-review → exec → qa
 499  PROCEED    Dashboard chart rendering bug              spec → exec → test → qa
 498  PROCEED    Update error messages                      exec → qa
 497  PROCEED    Refactor batch executor                    spec → exec → qa
 496  PARK       Blocked on #490 schema migration           ‖
 495  PROCEED    CLI help text improvements                 exec → qa
 494  PROCEED    Assess batch formatting fix                exec → qa
 493  CLOSE      Duplicate of #491                          —
 492  PROCEED    Add export command                         spec → exec → qa
 491  PROCEED    Normalize config paths                     exec → qa
────────────────────────────────────────────────────────────────
Commands:
  npx sequant run 503 502 501 498 495 494 -q --phases exec,qa
  npx sequant run 491 -q --phases exec,qa
  npx sequant run 499 -q --phases spec,exec,test,qa
  npx sequant run 500 -q --phases spec,security-review,exec,qa
  npx sequant run 497 492 -q
────────────────────────────────────────────────────────────────
Order: 497 → 492 (497 refactors batch-executor internals that 492's export command uses)

⚠ #500  bug + auth labels — domain label takes priority
⚠ #499  bug + ui labels — domain label triggers test phase

Flags:
  --phases ...,security-review   #500 auth label → security review required
  --phases ...,test              #499 ui label → browser verification
────────────────────────────────────────────────────────────────
Cleanup:
  gh issue close 493                   # duplicate of #491
────────────────────────────────────────────────────────────────

<!-- #503 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
<!-- #502 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
<!-- #501 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
<!-- #500 assess:action=PROCEED assess:phases=spec,security-review,exec,qa assess:quality-loop=true -->
<!-- #499 assess:action=PROCEED assess:phases=spec,exec,test,qa assess:quality-loop=true -->
<!-- #498 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
<!-- #497 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #496 assess:action=PARK -->
<!-- #495 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
<!-- #494 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
<!-- #493 assess:action=CLOSE -->
<!-- #492 assess:action=PROCEED assess:phases=spec,exec,qa assess:quality-loop=true -->
<!-- #491 assess:action=PROCEED assess:phases=exec,qa assess:quality-loop=true -->
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
  npx sequant run <N> <flags>

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

**`Flags:` (single mode):** Indented list of each enabled non-default flag with a one-line reason. Omit the entire `Flags:` section when `-q` is the only non-default flag AND the reason is obvious (e.g., a straightforward enhancement). Do not repeat obvious flags.

Example with `Flags:` (non-obvious `-q` + `--testgen`):

```
#458 — Parallel run UX freeze + reconcileState race condition
Open · bug, enhancement, cli
────────────────────────────────────────────────────────────────

→ PROCEED — Both root causes confirmed in codebase

Commands:
  npx sequant run 458 -q

spec → exec → qa · 8 ACs

Flags:
  -q     dual concern across 4 files
────────────────────────────────────────────────────────────────

<!-- assess:action=PROCEED -->
<!-- assess:phases=spec,exec,qa -->
<!-- assess:quality-loop=true -->
```

Example omitting `Flags:` (obvious `-q` for a standard enhancement):

```
#443 — Consolidate gh CLI calls
Open · enhancement
────────────────────────────────────────────────────────────────

→ PROCEED — Codebase matches spec, 5 ACs

Commands:
  npx sequant run 443 -q

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
  npx sequant run <N> <flags>                 # fresh start

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
| `Flags:` | Non-default flags appear AND `-q` is not the sole flag with an obvious reason |
| `Cleanup:` | Stale branches, merged-but-open issues, or label changes |
| Separators | Between sections that are both shown; omit if adjacent section is omitted |

Every separator and section is conditional. If there are no warnings, no chain, no flags, and no cleanup, the output is just: table → separator → `Commands:` block → separator → markers.

---

## Persist Analysis

After displaying output, prompt the user to save using `AskUserQuestion` with options "Yes (Recommended)" and "No".

If confirmed, post a structured comment to each issue via `gh issue comment`. Each posted comment should include:
- The action headline (`→ ACTION — reason`)
- The workflow (for PROCEED/REWRITE)
- Standard HTML markers on separate lines:
  ```
  <!-- assess:action=PROCEED -->
  <!-- assess:phases=spec,exec,qa -->
  <!-- assess:quality-loop=true -->
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
- [ ] `Flags:` section present when non-default flags appear (unless only obvious `-q`)
- [ ] `Order:` annotations carry dependency **reasoning**, not bare filenames
- [ ] `⚠` warnings include partial-AC satisfaction where applicable
- [ ] Separators appear between every shown section; omitted when adjacent section is omitted
- [ ] Annotations/sections omitted when not applicable (silence = healthy)
- [ ] HTML markers present for every assessed issue
- [ ] Batch mode: table is the primary output, no per-issue detail sections
- [ ] Single mode: focused summary with separators between sections
