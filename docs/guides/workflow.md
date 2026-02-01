# Complete Workflow Guide

This guide covers the full Sequant workflow, including post-QA patterns used by experienced users.

## Workflow Overview

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  /spec  │───▶│  /exec  │───▶│  /test  │───▶│   /qa   │───▶│  /docs  │───▶│  Merge  │
└─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘
     │              │              │              │              │              │
     ▼              ▼              ▼              ▼              ▼              ▼
   Plan          Build       Verify (UI)     Review      Document      Ship
                                                │
                                                ▼
                                         Gap Analysis
                                         (see below)
```

## Phase 1: Spec

```
/spec 123
```

**What happens:**
- Reads issue description and comments
- Analyzes codebase for patterns
- Drafts acceptance criteria (ACs)
- Creates implementation plan
- Posts plan as issue comment

**Output:** GitHub issue comment with AC checklist and implementation plan.

**When to skip:** Simple bug fixes, typos, documentation-only changes.

## Phase 2: Exec

```
/exec 123
```

**What happens:**
- Creates isolated git worktree (`feature/123-issue-title`)
- Implements changes per the spec
- Runs tests after changes
- Creates commits with progress
- Creates PR

**Output:** Feature branch with implementation, open PR.

## Phase 3: Test/Verify (Optional)

```
/test 123    # Browser-based UI testing (requires Chrome DevTools MCP)
/verify 123  # CLI/script execution verification
```

**When to use:**
- `/test` for UI changes
- `/verify` for CLI tools, scripts, commands

## Phase 4: QA

```
/qa 123
```

**What happens:**
- Reviews code against all ACs (including derived ACs from spec)
- Checks type safety, security, scope
- Verifies CI status
- Generates detailed report

**Verdicts:**
| Verdict | Meaning | Action |
|---------|---------|--------|
| `READY_FOR_MERGE` | All ACs met, high quality | Merge |
| `AC_MET_BUT_NOT_A_PLUS` | ACs met, minor improvements suggested | Can merge |
| `NEEDS_VERIFICATION` | Waiting on CI or external check | Wait, re-run |
| `AC_NOT_MET` | ACs not fully met | Fix issues |

If QA finds issues, run `/loop 123` to auto-fix (up to 3 iterations).

## Phase 5: Gap Analysis

**This is the key step most users miss.**

After QA passes, ask: **"Any other gaps?"**

This catches:
- Cross-platform compatibility issues
- Design concerns for future maintainability
- Edge cases not covered by ACs
- Documentation completeness

### Gap Handling

| Gap Type | Action |
|----------|--------|
| Quick fix (< 5 min) | Fix inline, commit, push |
| Design consideration | Create follow-up issue |
| Out of scope | Create separate issue |
| Acceptable debt | Document and proceed |

### Example Gap Analysis

```
User: any other gaps?

Claude: Looking critically...

1. **Cross-platform sed compatibility** (minor)
   - The extraction pattern works on GNU sed but not macOS BSD sed
   - Resolution: Fixed - replaced with portable `grep -oE`

2. **Hardcoded dimension names** (medium)
   - Maintenance burden if new dimensions are added
   - Resolution: Created issue #227 for future improvement
```

## Phase 6: Docs

```
/docs 123
```

**What happens:**
- Checks if CHANGELOG needs updating
- Updates relevant documentation files
- Ensures user-facing changes are documented

**Files typically updated:**
- `CHANGELOG.md` - For user-visible changes
- `docs/internal/what-weve-built.md` - For feature tracking
- `README.md` - If public API changes
- Feature-specific docs in `docs/`

**When to skip:** Internal refactors, test-only changes.

## Phase 7: Merge

```
gh pr merge --squash
```

Or use `/merger` for multi-issue integration:

```
/merger 123 124 125
```

## Phase 8: Smoke Test

After merge, verify the feature works on main:

```bash
git checkout main && git pull
npm run build        # Verify build
npm test             # Verify tests
# Manual verification of the specific feature
```

### Smoke Test Checklist

- [ ] Build passes on main
- [ ] Tests pass on main
- [ ] Feature works as expected
- [ ] No regressions in related areas

## Complete Example Session

```
/fullsolve 223                    # Run complete pipeline

# After fullsolve completes...
/qa 223                           # Second QA pass

User: any other gaps?
Claude: [identifies 2 gaps]

User: fill all gaps or create new issues if too complex
Claude: [fixes minor gap, creates issue for complex one]

User: do you need to update docs?
/docs 223                         # Update CHANGELOG, what-weve-built

User: merge then smoketest
Claude: [merges PR, runs smoke tests]
```

## Choosing Your Workflow

### Use `/fullsolve` when:
- Standard features or bug fixes
- ACs are clear from the issue
- You want minimal intervention

### Use step-by-step when:
- Complex features needing human review at each phase
- Unclear requirements needing iteration
- Learning the workflow

### Use `sequant run` when:
- Batch processing multiple issues
- Headless/CI execution
- Parallel processing

```bash
npx sequant run 1 2 3            # Multiple issues in parallel
npx sequant run 123 --quality-loop   # Auto-fix until QA passes
```

## Common Patterns

### Pattern: Simple Bug Fix

```
/exec 123    # Skip spec for simple fixes
/qa 123
gh pr merge --squash
```

### Pattern: UI Feature

```
/spec 123
/exec 123
/test 123    # Browser-based verification
/qa 123
/docs 123
gh pr merge --squash
```

### Pattern: Multi-Issue Integration

```
/fullsolve 123
/fullsolve 124
/fullsolve 125
/merger 123 124 125   # Integrate and merge all
```

### Pattern: Quality Iteration

```
/spec 123
/exec 123
/qa 123              # Returns AC_NOT_MET
/loop 123            # Auto-fix
/qa 123              # Re-verify
```

## Tips

### Be Thorough with Gap Analysis

The "any other gaps?" step catches issues that automated QA misses:
- Platform-specific behavior
- Maintainability concerns
- Documentation completeness

### Create Issues for Complex Gaps

Don't try to fix everything inline. If a gap needs design consideration:

```
User: fill gaps or create new issues if too complex
Claude: Created issue #227 for [complex gap description]
```

### Always Smoke Test

Even with passing CI, verify the feature works on main after merge. This catches integration issues.

### Track Derived ACs

Spec generates "derived ACs" from quality planning. These flow through exec and qa:

```
Original ACs: AC-1 through AC-5 (from issue)
Derived ACs: AC-6, AC-7 (from spec quality planning)
```

Both are tracked equally in QA verdicts.

## Troubleshooting

### QA keeps finding issues

Run `/loop 123` for automatic fixes, or manually address based on QA feedback.

### CI is pending

Wait for CI, then re-run `/qa 123`. The verdict will update based on CI status.

### Build fails but it's not my fault

QA verifies if build failure is a regression or pre-existing on main. Pre-existing failures don't block merge.

### Worktree is in bad state

```bash
# Remove and recreate
git worktree remove ../worktrees/feature/123-*
/exec 123  # Creates fresh worktree
```

## Next Steps

- [Quality Gates](../concepts/quality-gates.md) - What QA checks for
- [Git Workflows](./git-workflows.md) - Worktree management
- [Customization](./customization.md) - Configure Sequant behavior
