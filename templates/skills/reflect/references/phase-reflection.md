# Phase-Specific Reflection

## Planning Phase (`/reflect planning`)

Focus on planning effectiveness after `/spec`:

**Key Questions:**
- Did context gathering find similar patterns efficiently?
- Were architectural decisions well-reasoned with clear options?
- Did Sequential Thinking help or add overhead?
- Were open questions actionable (question + recommendation + impact)?
- Was the plan specific enough to implement without re-planning?

**Common Friction Points:**
- Missing component patterns in docs
- Unclear which dependencies are already installed
- Database schema not matching assumptions
- Too many iterations on same decision

**Improvement Areas:**
- Add missing patterns to CLAUDE.md "Finding Similar Components"
- Update command with better decision frameworks
- Archive obsolete examples

## Implementation Phase (`/reflect implementation`)

Focus on implementation effectiveness after `/exec`:

**Key Questions:**
- Did implementation follow the agreed plan or deviate significantly?
- How many test failures before success? (Target: <3)
- Were there repeated context re-reads? (inefficient)
- Did type errors reveal missing/incorrect types in types/ folder?
- Were there missing patterns that could be documented?

**Common Friction Points:**
- Plan was too vague, required re-planning during implementation
- Missing utility functions (kept reimplementing same logic)
- Unclear testing patterns (what to test, how to structure tests)
- Type mismatches between database and TypeScript types

**Improvement Areas:**
- Update planning command to require more specificity
- Extract repeated logic into lib/utils/
- Document testing patterns in docs/TESTING_PATTERNS.md
- Run type generation more frequently

## QA Phase (`/reflect qa`)

Focus on QA/review effectiveness after `/qa`:

**Key Questions:**
- Did QA catch issues that should have been caught earlier?
- Were AC clear enough to validate objectively?
- Did the review identify missing edge cases?
- Were there repeated issues across similar features? (pattern opportunity)
- Was the A+ assessment criteria clear and consistent?

**Common Friction Points:**
- AC were too vague to validate objectively
- Missing test cases for edge cases
- Inconsistent code style across similar components
- Performance issues not caught until QA

**Improvement Areas:**
- Update AC templates with more specificity
- Add edge case checklist to `/qa` command
- Create style guide for recurring patterns
- Add performance check reminders

## Good Reflection Examples

Note what these have in common: each names a **specific file and a specific
wrong line**, and each was *verified* before being proposed. A reflection that
proposes fixing something you have not opened is a guess.

### Correcting a stale memory

> **Friction Point:** Followed a memory that prescribed `echo y | cleanup-worktree.sh`; the script had since grown a real `--yes` flag and a merge gate (#750).
>
> **Root Cause:** Memory entries citing script flags rot silently when the script ships a change. The entry read as authoritative and was 67 days old.
>
> **Proposal:**
> - **Type:** Update
> - **Target:** `feedback_cleanup_worktree_after_gh_merge`
> - **Content:** Replace the `echo y |` workaround with the shipped flags; add the `--delete-branch`-fails-when-a-worktree-holds-the-branch trap.
> - **Priority:** High (a wrong memory is worse than a missing one — it gets trusted)
> - **Risk:** Low (verified against the script's `--help` first)

### Retiring guidance that a skill already implements

> **Friction Point:** Was about to propose adding a diff-size threshold to `/qa` so small diffs skip sub-agents.
>
> **Root Cause:** The proposal was based on the skill text actually executed, which came from a **stale plugin cache** (1.20.3) rather than the repo (2.8.0). The repo's `/qa` already has the size gate. Invoking `sequant:qa` resolves to the installed plugin; bare `qa` resolves to `.claude/skills/`.
>
> **Proposal:**
> - **Type:** Withdraw + document the routing trap
> - **Target:** the proposal itself; memory entry for the skew
> - **Priority:** High (the finding was an artifact, and acting on it would have duplicated shipped work)
> - **Risk:** None — verification *removed* work rather than adding it

### Pruning content inherited from another project

> **Bloat:** `references/documentation-tiers.md` prescribed a 700–800 line CLAUDE.md target and named `ARCHITECTURE.md`, `DATA_PIPELINE.md`, `ADMIN_CMS_ARCHITECTURE.md` as "current docs". None exist here; CLAUDE.md is 13 lines by design. Its "**Expand:** <600 lines" rule would have demanded ~590 lines of invented content.
>
> **Proposal:**
> - **Type:** Restructure
> - **Target:** `references/documentation-tiers.md` (×3 skill dirs)
> - **Action:** Rewrite around this repo's real tiers (CLAUDE.md index → auto-memory → `docs/` → skills → code comments); drop all line targets.
> - **Priority:** Medium
> - **Risk:** Low (verified every named doc was absent before rewriting)
