---
name: spec
description: "Plan review vs Acceptance Criteria for a single GitHub issue, plus issue comment draft."
license: MIT
metadata:
  author: sequant
  version: "2.1"
allowed-tools:
  - Bash(npm test:*)
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
  - Bash(gh issue edit:*)
  - Bash(gh label:*)
  - Bash(git worktree:*)
  - Bash(git -C:*)
  - Agent(sequant-explorer)
  - AgentOutputTool
---

# Planning Agent

Phase 1 "Planning Agent." Understands the issue and AC, reviews or synthesizes a plan, identifies gaps and risks, and drafts a GitHub issue comment.

## Platform Detection — Run First

```bash
gh --version >/dev/null 2>&1 && GITHUB_AVAILABLE=true || GITHUB_AVAILABLE=false
SETTINGS_AVAILABLE=false; [ -f ".sequant/settings.json" ] && SETTINGS_AVAILABLE=true
```

- **GitHub unavailable:** Skip phase detection, label review, auto-comment. Prompt user for AC from description text.
- **Settings unavailable:** Use defaults silently (sequential agents, no custom scope config).

## Phase Detection

If GitHub is available, check for prior phase completion:

```bash
phase_data=$(gh issue view <issue-number> --json comments --jq '[.comments[].body]' | \
  grep -o '{[^}]*}' | grep '"phase"' | tail -1 || true)
```

- `spec:completed` or later phase detected → Skip with message
- `spec:failed` → Re-run
- No markers / API error → Normal execution

Append to every phase-completion comment:
```
<!-- SEQUANT_PHASE: {"phase":"spec","status":"completed","timestamp":"<ISO-8601>"} -->
```

## Behavior

**`/spec 123`** — GitHub issue number. Read all comments for full context. Extract AC.
**`/spec <text>`** — Freeform problem/AC source. Ask clarifying questions if ambiguous.

**Flags:** `--skip-ac-lint` (skip AC quality check), `--skip-scope-check` (skip scope assessment).

## Complexity Tier Determination

Determine the output tier **before** generating any output. Announce it as the first line.

| Tier | Criteria | Output Scope | Target |
|------|----------|--------------|--------|
| **Simple** | `simple-fix`/`typo`/`docs-only` label, or `bug` with ≤2 AC | AC list + plan + Design Review Q1/Q3 only | <4,000 chars |
| **Standard** | 3–8 AC, no complexity labels | Full output minus Polish, minus trivially-passing quality checks | <8,000 chars |
| **Complex** | `complex`/`refactor`/`breaking` label, or 9+ AC | Full output including all quality dimensions | <15,000 chars |

First line of output: `**Complexity: [Tier]** ([N] ACs, [N] directories)`

Mark tier in HTML comment for downstream parsing: `<!-- SEQUANT_SPEC_TIER: [tier] -->`

## Programmatic Checks (Conditional)

**Guard:** Only run `npx tsx` blocks if `./src/lib/ac-parser.ts` exists (sequant repo). Otherwise, perform all analysis inline by reading the issue text directly.

### If guard passes:

1. **AC Extraction & Storage:** Use `extractAcceptanceCriteria` from `./src/lib/ac-parser.ts` and `StateManager` from `./src/lib/workflow/state-manager.ts` to parse and store AC in `.sequant/state.json`. Supports formats: `- [ ] **AC-1:** Desc`, `- [ ] AC-1: Desc`, `- [ ] **B2:** Desc`.

2. **AC Quality Check** (unless `--skip-ac-lint`): Use `lintAcceptanceCriteria` from `./src/lib/ac-linter.ts`. Warning-only — does not block planning. Flag these patterns:

   | Pattern | Examples | Issue |
   |---------|----------|-------|
   | Vague | "should work", "properly" | No measurable outcome |
   | Unmeasurable | "fast", "performant" | No threshold defined |
   | Incomplete | "handle errors", "edge cases" | Scenarios not enumerated |
   | Open-ended | "etc.", "and more" | Scope undefined |

3. **Scope Assessment** (unless `--skip-scope-check`): Use `performScopeAssessment` from `./src/lib/scope/index.ts` with settings from `getSettings()`. Verdicts: SCOPE_OK (green), SCOPE_WARNING (yellow, auto-enables quality loop), SCOPE_SPLIT_RECOMMENDED (red). Store results in state.

### If guard fails (consumer projects):

Perform the same analysis inline:
- Extract AC by pattern-matching the issue body
- Flag vague/unmeasurable AC in the AC Quality Check section
- Assess scope using the same green/yellow/red heuristics on feature count, AC count, directory spread

## Context Gathering

### Discover Project Structure — REQUIRED

**Do NOT use hardcoded paths.** Discover what actually exists:

```bash
ls -d src/ app/ lib/ components/ pages/ routes/ docs/ 2>/dev/null || true
```

Use discovered paths in all agent prompts and search commands.

### Agent Spawn Rules

Determine agent count from issue content — do NOT always spawn 3:

| Issue Content | Agents | What to Spawn |
|---------------|--------|---------------|
| Database/SQL/migration keywords in AC or labels | 3 | Similar features + Codebase area + Database schema |
| UI/frontend (`.tsx`/`.jsx`/`components/` references) | 2 | Similar features + Codebase area |
| CLI/script changes | 2 | Similar features + Codebase area |
| Docs/config/`simple-fix` label | 1 | General context only |

**Execution mode:** Read `.sequant/settings.json` → `agents.parallel` (default: false).
- **Parallel:** Spawn all agents in a SINGLE message
- **Sequential:** Spawn one at a time, waiting for each to complete

Agent prompts MUST reference discovered paths from the step above, not hardcoded ones like `components/admin/` or `lib/queries/`.

### In-Flight Work Analysis

Scan for potential conflicts before planning:

```bash
git worktree list --porcelain
# For each worktree: git -C <path> diff --name-only origin/main...HEAD
```

If overlap detected → include **Conflict Risk Analysis** section with options (alternative approach / wait for merge / coordinate via /merger).

Check for explicit dependencies: `gh issue view <issue> --json body,labels`. If "Depends on" found → include **Dependencies** section with status.

### Feature Branch Context

Check issue body/labels for feature branch references (`feature/`, `based on`, epic labels). If found, recommend `--base feature/<branch>` in the plan.

## Verification Method Decision Framework

Use this table when assigning verification methods to each AC:

| AC Type | Method | When to Use |
|---------|--------|-------------|
| Pure logic/calculation | Unit Test | Clear input/output, no side effects |
| API endpoint | Integration Test | HTTP handlers, DB queries, external calls |
| User workflow | Browser Test | Multi-step UI interactions, forms |
| Visual appearance | Manual Test | Styling, layout, animations |
| CLI command | Integration Test | Script execution, stdout verification |
| Error handling | Unit + Integration | Both isolated and realistic scenarios |

See [verification-criteria.md](references/verification-criteria.md) for detailed examples.

## Output Template

**Single authoritative template.** Include ALL sections in this order. Scale detail by complexity tier.

```markdown
**Complexity: [Simple|Standard|Complex]** ([N] ACs, [N] directories)

## AC Quality Check

[Inline analysis results, or "Skipped (--skip-ac-lint)"]

---

## Scope Assessment

**Non-Goals:** [From issue body. If missing: "⚠️ Non-Goals section not found. Consider adding scope boundaries."]

| Metric | Value | Status |
|--------|-------|--------|
| Feature count | [N] | [✅/⚠️/❌] |
| AC items | [N] | [✅/⚠️/❌] |
| Directory spread | [N] | [✅/⚠️/❌] |

**Verdict:** [✅ SCOPE_OK | ⚠️ SCOPE_WARNING | ❌ SCOPE_SPLIT_RECOMMENDED]

[Or "Skipped (--skip-scope-check)"]

---

## Acceptance Criteria

### AC-1: [Description]

**Verification:** [Unit Test | Integration Test | Browser Test | Manual Test]
**Scenario:** Given [state] → When [action] → Then [outcome]
**Assumptions:** [List any that need pre-coding validation]

<!-- Repeat for all ACs. EVERY AC must have a Verification Method from the decision framework.
     If unclear, flag as "⚠️ UNCLEAR" with suggested refinement. -->

<!-- Example of a completed AC entry:

### AC-3: User can submit the registration form

**Verification:** Browser Test
**Scenario:** Given user on /register → When fill fields and click Submit → Then redirect to /dashboard with success toast
**Assumptions:** Auth API returns 201 on valid input; email uniqueness enforced by DB constraint
-->

---

## Implementation Plan

### Phase 1: [Name]
1. [Step referencing specific files/components from context gathering]
2. [Step]

### Phase 2: [Name]
<!-- 3-7 total steps. Group into phases. Note dependencies between steps.
     For major decisions: present 2-3 options, recommend default with rationale.
     See references/parallel-groups.md for parallel execution format (3+ independent tasks). -->

---

## Design Review

1. **Where does this logic belong?** [Module/layer that owns this change]
2. **What's the simplest correct approach?** [Minimum implementation, rejected alternatives]
3. **What existing pattern does this follow?** [Named pattern, confirm it fits]
4. **What would a senior reviewer challenge?** [Anticipated "why didn't you just...?" pushback]

<!-- Simple tier: Q1 and Q3 only. Standard/Complex: all four. -->

---

## Feature Quality Planning

<!-- Exception-based: report only gaps and concerns. Full checklist in references/quality-checklist.md -->

**All standard checks pass.** Notable items:
- [Gap or concern requiring attention]
- [Another gap if applicable]

### Derived ACs (if any)

| Source | Derived AC | Priority |
|--------|-----------|----------|
| [Quality dimension] | AC-N: [Description] | High/Medium/Low |

<!-- Complex tier: walk through full checklist from references/quality-checklist.md -->

---

## Open Questions

1. **[Question]** — Recommendation: [default]. Impact: [if wrong].

---

## Recommended Workflow

**Phases:** [spec →] exec → qa
**Quality Loop:** [enabled/disabled]
**Reasoning:** [Brief explanation]

<!-- Decision logic:
     - UI/frontend → add `test` phase
     - `no-browser-test` label → skip `test` (overrides UI labels)
     - Complex refactor → enable quality loop
     - Security-sensitive → add `security-review` phase
     - New features with Unit/Integration Test verification ACs → add `testgen` phase
     - Docs-only → skip spec, just exec → qa -->

---

## Label Review

**Current:** [labels]
**Recommended:** [labels]
**Reason:** [Why, based on plan analysis]
**Quality Loop:** [Will/Won't auto-enable and why]

→ `gh issue edit <N> --add-label [label]`

---

--- DRAFT GITHUB ISSUE COMMENT (PLAN) ---

[AC checklist with verification + implementation plan + key decisions + open questions]
```

### Testgen Phase Auto-Detection

#### When to recommend `testgen` phase:

| Condition | Recommend testgen? | Reasoning |
|-----------|-------------------|-----------|
| ACs have "Unit Test" verification method | Yes | Tests should be stubbed before implementation |
| ACs have "Integration Test" verification method | Yes | Complex integration tests benefit from early structure |
| New feature (`enhancement`/`feature` label) with >2 ACs | Yes | Features need test coverage |
| Simple bug fix (`bug` label only) | No | Skip testgen — targeted tests sufficient |
| Docs-only (`docs` label) | No | Skip testgen — no unit tests needed |
| All ACs have "Manual Test" or "Browser Test" | No | Skip testgen — no code stubs to generate |

**Detection logic:**
1. Count ACs with "Unit Test" → If >0, recommend testgen
2. Count ACs with "Integration Test" → If >0, recommend testgen
3. Check labels: `bug`/`fix` only → Skip testgen. `docs` → Skip testgen.

**Example when testgen recommended:**
```markdown
**Phases:** spec → testgen → exec → qa
**Reasoning:** ACs include Unit Test verification methods; testgen will create stubs before implementation
```

### Browser Testing Label Suggestion

When `.tsx`/`.jsx` references detected in issue body AND no `ui`/`frontend`/`admin` label present:
> **Component files detected** — add `ui` label for browser testing, or `no-browser-test` to explicitly skip.

### Assess Comment Integration

Before making phase recommendations, check for prior `/assess` analysis:

```bash
assess_comment=$(gh issue view <N> --json comments \
  --jq '[.comments[].body | select(test("## Assess Analysis|<!-- assess:phases="))] | last // empty')
```

If found, use assess recommendation as starting point. You may override, but MUST document why.

## Update GitHub Issue

Post the draft comment and add label:

```bash
gh issue comment <issue-number> --body "..."
gh issue edit <issue-number> --add-label "planned"
```

**Do NOT start implementation** — this is planning-only.
