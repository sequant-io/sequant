## Summary

When running multiple issues via `sequant run`, subsequent issues can see previous issues' uncommitted work because isolation isn't enforced at the orchestrator level. Additionally, issues developed in parallel can create incompatible implementations of the same files, which only surfaces at merge time.

This issue proposes a comprehensive solution: **automatic worktree isolation** + **spec-time conflict detection** + **a `/merger` skill for post-QA integration**.

---

## Problem Statement

### Problem 1: No Automatic Worktree Isolation

Currently, `sequant run 1 2 3` executes all issues in the main repository context:

```
sequant run 1 2
│
├─ /spec #1 → runs in main repo
├─ /exec #1 → SHOULD create worktree, but relies on agent compliance
│             └─ If agent fails, work happens in main repo
├─ /qa #1   → assumes worktree exists
│
├─ /spec #2 → runs in main repo (may see #1's uncommitted changes!)
├─ /exec #2 → same problem
└─ /qa #2   → reviews mixed state
```

**Result**: Context bleed, file conflicts, and unpredictable git state.

### Problem 2: Parallel Issues Create Incompatible Implementations

Real-world example from another project:

| Aspect | Issue #10 | Issue #12 |
|--------|-----------|-----------|
| File | `src/app/api/exercises/route.ts` | `src/app/api/exercises/route.ts` |
| Data source | Supabase database | ExerciseDB external API |
| POST support | Yes | No |
| Pagination | No | Yes |

Both issues:
- ✅ Passed spec review in isolation
- ✅ Passed implementation in isolation  
- ✅ Passed QA in isolation
- ❌ **Cannot both exist on main** - mutually exclusive implementations

The conflict was only discovered at merge time, requiring manual integration work.

### Problem 3: No Coordinated Merge Strategy

After QA passes, there's no automated way to:
- Detect conflicts between completed worktrees
- Generate unified implementations
- Enforce merge ordering for dependent issues
- Clean up worktrees after successful merge

---

## Proposed Solution

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    sequant run 10 12 13                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 0: Pre-flight (NEW)                                      │
│  ├─ Auto-create worktrees for all issues                        │
│  ├─ Set SEQUANT_WORKTREE env var per issue                      │
│  └─ Enforce isolation via hooks                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: /spec with conflict detection (ENHANCED)              │
│  ├─ Scan open worktrees for file overlap                        │
│  ├─ If conflict detected:                                       │
│  │   ├─ Option A: Plan alternative approach (different files)   │
│  │   ├─ Option B: Mark as DEPENDS_ON another issue              │
│  │   └─ Option C: Plan unified implementation from start        │
│  └─ Output plan that accounts for in-flight work                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 2-3: /exec and /qa (in isolated worktrees)               │
│  ├─ Each issue runs in its own worktree                         │
│  ├─ SEQUANT_WORKTREE enforced by hooks                          │
│  └─ No cross-contamination possible                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 4: /merger (NEW SKILL)                                   │
│  ├─ Verify QA passed for all issues                             │
│  ├─ Detect file conflicts between worktrees                     │
│  ├─ If conflicts:                                               │
│  │   ├─ Analyze semantic compatibility                          │
│  │   ├─ Generate unified implementation                         │
│  │   └─ Create integration PR                                   │
│  ├─ Enforce merge order (dependencies first)                    │
│  └─ Clean up worktrees after successful merge                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Details

### 1. Auto-Worktree Creation in `run.ts`

**Location**: `src/commands/run.ts`

Before executing any phases, automatically create isolated worktrees:

```typescript
interface WorktreeInfo {
  issue: number;
  path: string;
  branch: string;
}

async function ensureWorktrees(issues: number[]): Promise<Map<number, WorktreeInfo>> {
  const worktrees = new Map<number, WorktreeInfo>();
  
  for (const issue of issues) {
    const issueData = await fetchIssue(issue);
    const slug = slugify(issueData.title);
    const branch = `feature/${issue}-${slug}`;
    const path = `../worktrees/feature/${issue}-${slug}`;
    
    // Check if worktree already exists (resume scenario)
    if (!await worktreeExists(path)) {
      await createWorktree(path, branch);
    }
    
    worktrees.set(issue, { issue, path, branch });
  }
  
  return worktrees;
}
```

Pass worktree path to exec/qa phases via environment:

```typescript
env: {
  ...process.env,
  SEQUANT_WORKTREE: worktreeInfo.path,
  SEQUANT_ISSUE: String(issueNumber),
  SEQUANT_BRANCH: worktreeInfo.branch,
}
```

### 2. Enhance `/spec` with Conflict Detection

**Location**: `.claude/skills/spec/SKILL.md`

Add new section to spec workflow:

```markdown
## Pre-Planning: In-Flight Work Analysis

Before creating the implementation plan, scan for potential conflicts:

1. **List open worktrees**:
   ```bash
   git worktree list --porcelain
   ```

2. **For each worktree, get changed files**:
   ```bash
   git -C <worktree-path> diff --name-only main...HEAD
   ```

3. **Analyze this issue's likely file touches** based on:
   - Issue description and AC
   - Similar past issues
   - Codebase structure

4. **If overlap detected**, include in plan output:
   ```markdown
   ## ⚠️ Conflict Risk Detected
   
   **In-flight work**: Issue #10 (feature/10-exercise-api)
   **Overlapping files**: 
   - `src/app/api/exercises/route.ts`
   
   **Recommended approach**:
   - [ ] Option A: Use `/api/exercises/library` instead (no conflict)
   - [ ] Option B: Wait for #10 to merge, then rebase
   - [ ] Option C: Coordinate unified implementation
   
   **Selected**: [To be decided during spec review]
   ```
```

### 3. New `/merger` Skill

**Location**: `.claude/skills/merger/SKILL.md`

```markdown
# /merger - Multi-Issue Integration & Merge

Handles post-QA integration of completed worktrees.

## Usage

```bash
# Merge single issue
/merger 10

# Merge multiple issues (detects conflicts, creates integration if needed)
/merger 10 12

# Merge with dependency ordering
/merger 10 12 --order=dependency
```

## Workflow

### Step 1: Pre-Merge Validation

For each issue:
- [ ] Verify QA status is PASSED
- [ ] Verify worktree exists and has commits
- [ ] Verify PR exists (or create one)

### Step 2: Conflict Detection

```bash
# Get files changed in each worktree
for worktree in $WORKTREES; do
  git -C $worktree diff --name-only main...HEAD
done

# Find overlapping files
comm -12 <(sort files_10.txt) <(sort files_12.txt)
```

### Step 3: Conflict Analysis

If overlapping files found:

1. **Semantic analysis**: Are the changes compatible?
   - Additive changes (new functions) → likely compatible
   - Same function modified → likely incompatible
   - Same file, different sections → may be compatible

2. **Generate diff3 merge preview**:
   ```bash
   git merge-tree $(git merge-base main branch1) branch1 branch2
   ```

### Step 4: Resolution Strategy

| Scenario | Action |
|----------|--------|
| No conflicts | Merge sequentially |
| Compatible changes | Auto-merge with verification |
| Incompatible changes | Generate unified implementation |
| True dependency | Enforce merge order |

### Step 5: Integration Branch (if needed)

When incompatible changes detected:

1. Create integration branch from main
2. Cherry-pick or merge each worktree's changes
3. Resolve conflicts with unified implementation
4. Run tests on integration branch
5. Create integration PR

### Step 6: Cleanup

After successful merge:
```bash
git worktree remove <path>
git branch -D <branch>
git push origin --delete <branch>  # if remote exists
```

## Output Format

```markdown
## Merger Report: Issues #10, #12

### Conflict Analysis
| File | #10 | #12 | Status |
|------|-----|-----|--------|
| `src/app/api/exercises/route.ts` | Creates (Supabase) | Creates (ExerciseDB) | ⚠️ INCOMPATIBLE |
| `src/components/exercise-list.tsx` | - | Creates | ✅ No conflict |

### Resolution
Created integration branch: `integrate/10-12-exercises`

Unified implementation:
- GET supports both sources via `?source=` param
- POST preserved from #10
- Pagination preserved from #12

### Merge Order
1. ✅ Merged: integrate/10-12-exercises → main
2. 🧹 Cleaned: worktrees/feature/10-*, worktrees/feature/12-*

### PRs
- Integration PR: #15 (merged)
- Closed: #10, #12 (superseded by integration)
```
```

### 4. Hook Enforcement

**Location**: `.claude/hooks/pre-tool.sh`

Enhance existing hook to enforce worktree boundaries:

```bash
# If SEQUANT_WORKTREE is set, enforce all file operations stay within it
if [[ -n "$SEQUANT_WORKTREE" ]]; then
  if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
    EXPECTED_PATH=$(realpath "$SEQUANT_WORKTREE")
    FILE_PATH=$(realpath "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")
    
    if [[ "$FILE_PATH" != "$EXPECTED_PATH"* ]]; then
      echo "HOOK_BLOCKED: File operation must be within worktree: $SEQUANT_WORKTREE"
      echo "Attempted path: $FILE_PATH"
      exit 2
    fi
  fi
fi
```

### 5. Dependency Tracking

Support explicit dependencies via GitHub issue labels or comments:

```markdown
<!-- In issue #12 -->
**Depends on**: #10

<!-- Or via label -->
Labels: depends-on/10
```

`/spec` and `/merger` should parse these and enforce ordering.

---

## Edge Cases

| Scenario | Spec Behavior | Merger Behavior |
|----------|---------------|-----------------|
| **Same file, additive changes** | Warn, suggest coordination | Auto-merge if clean |
| **Same file, incompatible** | Suggest alternatives or dependency | Create integration branch |
| **Three-way conflict** | Flag all issues, suggest integration issue | Create unified integration |
| **Circular dependency** | Error: cannot proceed | Error: manual resolution required |
| **Worktree already exists** | Reuse (resume scenario) | Use existing |
| **Main branch advanced** | N/A | Rebase worktrees before merge |
| **QA failed** | N/A | Refuse to merge, keep worktree |
| **Partial merge (1 of 3 fails)** | N/A | Merge successful ones, report failure |

---

## CLI Interface Changes

### Enhanced `sequant run`

```bash
# Auto-creates worktrees, runs phases in isolation
npx sequant run 10 12 13

# Skip worktree creation (use existing)
npx sequant run 10 12 --reuse-worktrees

# Include merge phase
npx sequant run 10 12 --merge-on-success
```

### New `/merger` command

```bash
# Via skill
/merger 10 12

# Via CLI
npx sequant merger 10 12

# Options
npx sequant merger 10 12 --dry-run          # Show what would happen
npx sequant merger 10 12 --no-cleanup       # Keep worktrees after merge
npx sequant merger 10 12 --force            # Merge even with conflicts (manual resolution)
```

---

## Acceptance Criteria

### Worktree Isolation
- [ ] `sequant run` automatically creates worktrees before executing /exec phases
- [ ] Each issue executes in its own isolated worktree
- [ ] `SEQUANT_WORKTREE` environment variable is set for exec/qa phases
- [ ] Hooks block file operations outside the designated worktree
- [ ] Existing worktrees are reused (resume scenario)

### Spec Conflict Detection
- [ ] `/spec` scans for open worktrees before planning
- [ ] Detects file overlap between current issue and in-flight work
- [ ] Outputs conflict warning with resolution options
- [ ] Supports `DEPENDS_ON` declarations

### Merger Skill
- [ ] `/merger` skill exists and is documented
- [ ] Validates QA status before merge
- [ ] Detects file conflicts between worktrees
- [ ] Generates integration branch for incompatible changes
- [ ] Respects dependency ordering
- [ ] Cleans up worktrees after successful merge
- [ ] Provides detailed merge report

### Integration Tests
- [ ] Test: Two issues with no overlap merge successfully
- [ ] Test: Two issues with compatible changes auto-merge
- [ ] Test: Two issues with incompatible changes create integration branch
- [ ] Test: Dependency ordering is enforced
- [ ] Test: Failed QA blocks merge

---

## Related Files

- `src/commands/run.ts` - Main orchestration, needs worktree creation
- `scripts/dev/new-feature.sh` - Existing worktree creation script
- `scripts/dev/cleanup-worktree.sh` - Existing cleanup script
- `.claude/skills/spec/SKILL.md` - Needs conflict detection
- `.claude/skills/merger/SKILL.md` - New skill (to be created)
- `.claude/hooks/pre-tool.sh` - Needs SEQUANT_WORKTREE enforcement

---

## Implementation Order

1. **Phase 1**: Auto-worktree creation in `run.ts`
2. **Phase 2**: Hook enforcement for worktree boundaries
3. **Phase 3**: `/merger` skill (basic merge + cleanup)
4. **Phase 4**: Spec conflict detection
5. **Phase 5**: Integration branch generation in `/merger`
6. **Phase 6**: Dependency tracking and ordering
