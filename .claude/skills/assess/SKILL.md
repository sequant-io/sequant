---
name: assess
description: "Issue triage and status assessment - analyze current state, detect health signals, and recommend next action with full workflow plan."
license: MIT
metadata:
  author: sequant
  version: "2.0"
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
3. Recommend exactly ONE action from a fixed vocabulary
4. If the action is PROCEED, output the full workflow plan with CLI command
5. Show reasoning for the recommendation

**This command is read-only** — it analyzes and recommends but never takes action.

## Invocation

- `/assess 123` — Assess a single issue
- `/assess 152 153` — Assess multiple issues (each independently)
- `/solve 123` — Alias for `/assess` (deprecated, will show notice)

## Fixed Action Vocabulary

Every `/assess` output recommends exactly ONE of these actions:

| Action | Meaning | When |
|--------|---------|------|
| **PROCEED** | Ready for work — here's the workflow | Issue is clear, codebase matches, no blockers |
| **CLOSE** | Issue is outdated, resolved, or duplicate | Resolved by another PR, references don't exist, duplicates closed issue |
| **MERGE** | Overlaps with another open issue | Two issues cover 70%+ same scope, or one is a subset of the other |
| **REWRITE** | Existing PR/branch needs a fresh start | PR too far behind main, touched files diverged, stale abandoned PR |
| **CLARIFY** | Issue needs more information before work | No ACs, ambiguous requirements, missing repro steps, multiple valid interpretations |
| **PARK** | Valid but not actionable right now | Blocked on external dep, blocked on another issue, explicitly deferred |

## Assessment Process

### Step 1: Context Gathering

**From GitHub:**

```bash
gh issue view <issue-number> --json title,body,labels,state,comments,assignees
```

- Issue title, body, labels, status
- Acceptance Criteria (explicit or inferred)
- **All comments** — read every comment for plan drafts, progress updates, QA reviews, clarifications, additional AC
- Last activity timestamp
- Assigned developer(s)

**From Git:**

```bash
git branch -a | grep <issue-number> || true
git worktree list | grep <issue-number> || true
gh pr list --search "in:title <issue-number>" || true
```

- If branch exists: `git log --oneline feature/<issue-number>*`
- If PR exists: `gh pr view <pr-number> --json state,mergeable,commits`

**From Codebase:**

- Look for TODOs mentioning the issue using the Grep tool: `Grep(pattern="TODO.*#<issue-number>")`
- Check for test files related to the feature
- Identify modified files (if branch exists)

### Step 2: Health Checks

Surface red flags that inform the action recommendation:

#### Codebase Match
| Signal | Detection | Implication |
|--------|-----------|-------------|
| Referenced files/APIs don't exist | Glob/Grep for paths mentioned in issue body | Issue may be outdated |
| Referenced files changed recently | `git log` on mentioned paths | May have been addressed |
| Described behavior now works differently | Codebase analysis | Verify still relevant |

#### PR / Branch Health
| Signal | Detection | Implication |
|--------|-----------|-------------|
| PR has merge conflicts | `gh pr view` status | Needs rebase or rewrite |
| PR is far behind main (100+ commits) | `git rev-list --count main..pr-branch` | Likely needs rewrite |
| PR touched files that diverged on main | `git diff --name-only` cross-reference | Rebase will be painful |
| PR/branch stale (30+ days no activity) | Timestamps | Consider fresh start |
| Draft PR with partial work | PR status | Assess whether to continue |
| Worktree with uncommitted work | `git worktree list` + status check | Abandoned work, clean up |

#### Overlap / Redundancy
| Signal | Detection | Implication |
|--------|-----------|-------------|
| Another open issue covers similar scope | Compare titles/bodies of open issues | Consider merging |
| Duplicates a closed issue | Compare against recently closed | Close as duplicate |
| Solved as side effect of another PR | Cross-reference changed files | Verify and close |

#### Staleness / Blockers
| Signal | Detection | Implication |
|--------|-----------|-------------|
| No activity in 14+ days | Timestamps | Flag as stale |
| Blocked on another issue | Issue body/comments mention dependencies | Park until unblocked |
| Blocked on external dependency | Comments indicate external blocker | Park with reason |
| Open questions unanswered | Comment thread analysis | Clarify before proceeding |

### Step 3: Action Selection

Based on health checks and context, select the most appropriate action:

**Priority order when multiple signals conflict:**
1. Most actionable action wins
2. Note secondary signals in the Health section

**Decision tree:**
- No ACs, vague requirements → **CLARIFY**
- Blocked on dependency → **PARK**
- Resolved by another PR → **CLOSE**
- Duplicates or 70%+ overlaps → **MERGE**
- PR 100+ commits behind or files diverged → **REWRITE**
- Clear requirements, codebase matches → **PROCEED**

### Step 4: Phase Detection (for PROCEED only)

Determine the current phase and recommended workflow:

**Phase Detection:**
- **Planning** — No plan comment, AC unclear → recommend `/spec` first
- **Implementation** — Plan exists, branch with commits → resume `/exec`
- **QA** — Implementation complete, no QA review → run `/qa`
- **Blocked** — No activity 7+ days, open questions, dependency
- **Complete** — PR merged, AC all met, issue closed

**Workflow Selection (from labels):**

| Issue Type | Labels | Workflow |
|------------|--------|----------|
| UI Feature | ui, frontend, admin | spec → exec → test → qa |
| UI Feature (testable) | ui + enhancement | spec → testgen → exec → test → qa |
| Backend Feature | backend, api | spec → exec → qa |
| New Feature (testable) | enhancement, feature | spec → testgen → exec → qa |
| Bug Fix | bug, fix | exec → qa (or full if complex) |
| Complex Feature | complex, refactor | `--quality-loop` or fullsolve |
| Documentation | docs | exec → qa |

**Quality Loop Detection:**
- **Recommend `-q`** for most issues (enhancement, feature, refactor, complex, multi-file changes)
- **Skip `-q`** only for simple bug fixes (`bug`/`fix` label only) or docs-only changes

**Flag Detection:**
- `--chain` — When multiple issues have explicit dependencies
- `--qa-gate` — When chain has 3+ issues with tight dependencies
- `--base <branch>` — When issue references a feature branch
- `--testgen` — When ACs need automated tests (enhancement/feature labels)

### Step 5: Conflict Detection

```bash
# List open worktrees
git worktree list --porcelain 2>/dev/null | grep "^worktree" | cut -d' ' -f2 || true

# For each worktree, get changed files
git -C <worktree-path> diff --name-only main...HEAD 2>/dev/null || true
```

If overlap detected with files this issue likely touches, include in output.

## Output Format

**Design Principle:** The action is the headline. Supporting context follows in priority order. Scannable in under 5 seconds.

### When action is PROCEED

```
#<N> — <Title>
Status: <Open|Closed> | Labels: <labels> | Last activity: <X days ago>

→ PROCEED — <one-line reason>

Health:
  ✓ References match codebase
  ✓ No conflicting PRs or worktrees
  ✓ No overlapping issues detected

AC Coverage: <N> criteria identified
  - <AC description>     <MET|IN_PROGRESS|NOT_STARTED|UNCLEAR>
  - <AC description>     <MET|IN_PROGRESS|NOT_STARTED|UNCLEAR>

╭──────────────────────────────────────────────────────────────╮
│  npx sequant run <ISSUES> <FLAGS>                            │
╰──────────────────────────────────────────────────────────────╯

#<N>  <Title truncated> ·········· <labels> → <workflow>

┌─ Flags ──────────────────────────────────────────────────────┐
│  -q  quality-loop   ✓/✗  <one-line reasoning>                │
│  --chain            ✓/✗  <one-line reasoning>                │
│  --qa-gate          ✓/✗  <one-line reasoning>                │
│  --base             ✓/✗  <one-line reasoning>                │
│  --testgen          ✓/✗  <one-line reasoning>                │
└──────────────────────────────────────────────────────────────┘

Why this workflow:
  • <reason 1>
  • <reason 2>
  • <reason 3>

<!-- CONDITIONAL: Only if alternatives worth showing -->
Also consider:
  <flag>     <one-line explanation>

<!-- CONDITIONAL: Only if conflict detected -->
⚠ Conflict risk: #<N> (open) modifies <path> — coordinate or wait

Label Review:
  Current: <labels>
  Suggested: <labels if changes needed>
  Reason: <why, if applicable>

Confidence: <High|Medium|Low>
  <information gaps if any>

<!-- assess:phases=<comma-separated> -->
<!-- assess:action=PROCEED -->
<!-- assess:skip-spec=<true/false> -->
<!-- assess:browser-test=<true/false> -->
<!-- assess:quality-loop=<true/false> -->

*Generated by `/assess`*
```

### When action is CLOSE

```
#<N> — <Title>
Status: <Open|Closed> | Labels: <labels> | Last activity: <X days ago>

→ CLOSE — <reason with evidence>

Health:
  ⚠ <signal that triggered CLOSE>
  ℹ Verify with issue author before closing

Confidence: <High|Medium|Low>

<!-- assess:action=CLOSE -->

*Generated by `/assess`*
```

### When action is MERGE

```
#<N> — <Title>
Status: <Open|Closed> | Labels: <labels> | Last activity: <X days ago>

→ MERGE — Significant overlap with #<other>.
  <description of overlap>

Health:
  ⚠ <overlap signals>

Confidence: <High|Medium|Low>

<!-- assess:action=MERGE -->

*Generated by `/assess`*
```

### When action is REWRITE

```
#<N> — <Title>
Status: <Open|Closed> | Labels: <labels> | Last activity: <X days ago>

→ REWRITE — <reason>
  <details about PR/branch state>

Health:
  ⚠ <PR/branch health signals>

AC Coverage: <N> criteria (from prior work)
  - <AC>  <status>

If restarting:
  npx sequant run <N> <flags>

Confidence: <High|Medium|Low>

<!-- assess:action=REWRITE -->

*Generated by `/assess`*
```

### When action is CLARIFY

```
#<N> — <Title>
Status: <Open|Closed> | Labels: <labels> | Last activity: <X days ago>

→ CLARIFY — <what's missing>
  Need: <specific information required>

Health:
  ⚠ <clarity signals>

Confidence: <High|Medium|Low>

<!-- assess:action=CLARIFY -->

*Generated by `/assess`*
```

### When action is PARK

```
#<N> — <Title>
Status: <Open|Closed> | Labels: <labels> | Last activity: <X days ago>

→ PARK — <reason>
  Resume after: <condition>

Health:
  ⚠ <blocker signals>

Confidence: <High|Medium|Low>

<!-- assess:action=PARK -->

*Generated by `/assess`*
```

## Multi-Issue Support

When given multiple issues (`/assess 152 153`), assess each independently with its own action recommendation:

```
─── Issue 1 of 2 ───────────────────────────────────────────

#152 — Add user dashboard
→ PROCEED — Issue is clear, codebase matches.
[... full PROCEED output ...]

─── Issue 2 of 2 ───────────────────────────────────────────

#153 — Update auth middleware
→ REWRITE — PR #91 is 200+ commits behind main.
[... full REWRITE output ...]
```

## Label Review

Analyze current labels vs issue content and suggest updates:

**Label Detection Hints:**
- `refactor` — Keywords: "refactor", "restructure", "reorganize", "cleanup", "migration"
- `complex` — Keywords: "complex", "major", "large-scale", "breaking"
- `ui`/`frontend` — Keywords: "component", "UI", "page", "form", "button", "modal"
- `backend` — Keywords: "API", "database", "query", "server", "endpoint"
- `cli` — Keywords: "command", "CLI", "script", "terminal"
- `docs` — Keywords: "documentation", "README", "guide", "tutorial"
- `security` — Keywords: "auth", "permission", "vulnerability", "secret", "token"
- `bug` — Keywords: "fix", "broken", "error", "crash", "doesn't work"

**When to Suggest Label Updates:**
- Issue body contains keywords not reflected in current labels
- Complexity doesn't match labels (complex/refactor/breaking)
- Quality loop would benefit from additional labels
- Area doesn't match current labels (ui/backend/cli/docs)

**Suggested Action (when applicable):**
```bash
gh issue edit <N> --add-label <label>
```

## Meta-Assessment

After providing the assessment, briefly note:

- **Confidence Level:** How certain are you about the recommendation? (High/Medium/Low)
- **Information Gaps:** What information would improve this assessment?
- **Alternative Interpretations:** Are there other ways to interpret the current state?

## Persist Analysis to Issue Comments

**After displaying output**, prompt the user to save:

```
Save this assessment to the issue? [Y/n]
```

Use the `AskUserQuestion` tool with options "Yes (Recommended)" and "No".

**If user confirms (Y):**

Post the structured comment with machine-readable HTML markers to each analyzed issue using `gh issue comment`.

**If user declines (N):** Skip posting.

### Machine-Readable Markers

| Marker | Values | Consumed By |
|--------|--------|-------------|
| `<!-- assess:phases=... -->` | Comma-separated phase names | `/spec` phase detection |
| `<!-- assess:action=... -->` | PROCEED/CLOSE/MERGE/REWRITE/CLARIFY/PARK | Action detection |
| `<!-- assess:skip-spec=... -->` | `true`/`false` | `/spec` skip logic |
| `<!-- assess:browser-test=... -->` | `true`/`false` | `/spec` test phase |
| `<!-- assess:quality-loop=... -->` | `true`/`false` | `/spec` quality loop |

## State Tracking

When analyzing issues, initialize state tracking:

```bash
TITLE=$(gh issue view <issue-number> --json title -q '.title')
npx tsx scripts/state/update.ts init <issue-number> "$TITLE"
```

Note: `/assess` only initializes issues — actual phase tracking happens during workflow execution.

## Notes

- This command is **read-only** — it analyzes but doesn't make changes
- It recommends but doesn't execute the next command
- Keep the assessment concise — aim for clarity, not exhaustiveness
- When in doubt about the action, say so — better to acknowledge uncertainty
- Use this to orient yourself, then proceed with the appropriate workflow command

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Action Headline** — `→ ACTION — reason` as the first prominent line after issue summary
- [ ] **Health Checks** — Signals that informed the action recommendation
- [ ] **AC Coverage** — Each AC marked MET/IN_PROGRESS/NOT_STARTED/UNCLEAR (for PROCEED/REWRITE)
- [ ] **Workflow Plan** — Full CLI command with flags table (for PROCEED only)
- [ ] **Label Review** — Current vs suggested labels based on issue content analysis
- [ ] **Confidence Level** — High/Medium/Low with information gaps noted
- [ ] **HTML Markers** — Machine-readable `<!-- assess:... -->` markers
- [ ] **Reasoning** — Why this action was recommended

**DO NOT respond until all items are verified.**
