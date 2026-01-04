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

### Documentation Improvement

> **Friction Point:** Spent 10 minutes searching for how neighborhood extraction works across multiple files.
>
> **Root Cause:** Process is documented in docs/AUTO_NEIGHBORHOOD_ENRICHMENT.md (tier 2) but not referenced in CLAUDE.md's discovery pipeline section (tier 1).
>
> **Proposal:**
> - **Type:** Add
> - **Target:** CLAUDE.md, line 230 (Discovery Methods section)
> - **Content:** Add one-line reference: "Neighborhoods auto-extracted via ZIP mapping (see docs/AUTO_NEIGHBORHOOD_ENRICHMENT.md)"
> - **Priority:** Medium
> - **Risk:** Low (just adding a signpost)

### Documentation Pruning

> **Bloat:** CLAUDE.md has 150 lines on Mapbox troubleshooting that solved a one-time issue 6 months ago.
>
> **Proposal:**
> - **Type:** Remove + Archive
> - **Target:** CLAUDE.md lines 450-600
> - **Action:** Move to docs/archive/mapbox-troubleshooting-2024.md with note "Archived: Issue resolved in react-map-gl v7.1.0"
> - **Priority:** High (saves 150 lines in hot path)
> - **Risk:** Low (still searchable if issue recurs)
