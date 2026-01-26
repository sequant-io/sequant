---
name: clean
description: "Repository Cleanup Command"
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Bash(git branch:*)
  - Bash(git status:*)
  - Bash(git stash:*)
  - Bash(git checkout:*)
  - Bash(git clean:*)
  - Bash(git add:*)
  - Bash(git commit:*)
  - Bash(git push:*)
  - Bash(npm run build:*)
  - Bash(npm run lint:*)
  - Bash(ls:*)
  - Bash(mv:*)
  - Bash(mkdir:*)
  - Bash(rm:*)
  - Bash(find:*)
  - Read
  - Write
  - Glob
  - Grep
---

# Repository Cleanup Command

Comprehensive, safe repository cleanup that archives stale files, removes artifacts, and commits changes.

## Safety First

Before making ANY changes:
1. Verify we're on `main` branch with clean working tree
2. Run `npm run build` to ensure current state builds
3. Create a safety checkpoint (stash any uncommitted work)

## Cleanup Categories

### Category 1: Safe to Auto-Archive (No Review Needed)

These files are always safe to archive - they're historical artifacts:

**Root directory patterns:**
- `*.backup` files (e.g., `CLAUDE.md.backup`)
- `CODE_REVIEW_PR_*.md` - Old PR reviews
- `*_AUDIT.md` files older than 30 days
- One-off shell scripts with dates in names

**docs/ patterns:**
- `ISSUE_*_PHASE_*.md` - Issue implementation specs (work is done)
- `*_IMPLEMENTATION.md` older than 30 days
- `content-audit-*.md` - Point-in-time audits
- City-specific audit files (e.g., `NYC_*_AUDIT.md`, `LA_*_REPORT.md`)

### Category 2: Review Before Archiving

These need a quick check - might still be referenced:
- Files in `migrations/` (check if applied to database)
- `context/` directory contents
- Any `APPLY_*.md` or `apply-*.sh` files

### Category 3: Always Keep

Never archive these:
- `CLAUDE.md` - Active project instructions
- `README.md` - Project readme
- `docs/WORKFLOW_COMMANDS.md` - Active workflow docs
- `docs/patterns/*` - Active pattern catalog
- `docs/CONTENT_STANDARDS.md` - Active standards
- Any file modified in the last 7 days

## Archive Structure

```
scripts/archive/
├── one-off-migrations/    # Shell scripts for one-time tasks
├── adhoc-migrations/      # SQL files applied manually (not via migrations tool)
└── deprecated/            # Old/replaced scripts

docs/archive/
├── audits/                # Completed audits and reviews
├── issue-specs/           # GitHub issue implementation specs
├── implementation-reports/ # Feature implementation summaries
└── context/               # Old project context files
```

## Execution Steps

### Step 1: Pre-flight Checks
```bash
# Verify branch and status
git branch --show-current  # Must be 'main'
git status --porcelain     # Should be empty or only untracked

# Verify build works
npm run build
```

If build fails or we're not on main with clean tree, STOP and report.

### Step 2: Identify Cleanup Candidates

Scan for files matching Category 1 and 2 patterns. Create a manifest of what will be archived.

Report to user:
- Files to auto-archive (Category 1)
- Files needing review (Category 2)
- Total space to be reclaimed

### Step 3: Execute Cleanup

1. Create archive directories if needed
2. Move Category 1 files to appropriate archive locations
3. Move Category 2 files (after user confirmation via manifest)
4. Remove artifacts:
   - `.DS_Store` files (except in node_modules)
   - Empty directories (except .git, node_modules, .next)
5. Update `docs/archive/README.md` with current date

### Step 4: Verification

```bash
# Verify build still works
npm run build

# Verify no breaking imports
npm run lint
```

If either fails, ROLLBACK all changes immediately.

### Step 5: Commit and Push

```bash
# Stage all changes
git add -A

# Create descriptive commit
git commit -m "chore: repository cleanup $(date +%Y-%m-%d)

Archived:
- [X] old issue specs
- [X] completed audits
- [X] one-off migration scripts
- [X] stale documentation

Build verified: passing"

# Push to origin
git push origin main
```

## Rollback Procedure

If anything goes wrong:
```bash
git checkout -- .
git clean -fd
```

## Output Format

Report final summary:
```
Repository Cleanup Complete

Archived:
- X files from root directory
- X files from docs/
- X migration scripts

Removed:
- X .DS_Store files
- X empty directories

Commit: [hash] pushed to origin/main

Next cleanup recommended: [date + 30 days]
```

## Usage Notes

- Run monthly or when repo feels cluttered
- Safe to run multiple times (idempotent)
- Will not touch files modified in last 7 days
- Always verifies build before and after

---

## BEGIN EXECUTION

Execute the cleanup following the steps above. Be thorough but safe - when in doubt, skip a file rather than risk breaking something.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Pre-flight Results** - Branch check, build verification passed
- [ ] **Cleanup Manifest** - List of files to be archived/removed
- [ ] **Archive Summary** - Count of files archived by category
- [ ] **Build Verification** - Post-cleanup build/lint passed
- [ ] **Commit Details** - Commit hash and push confirmation
- [ ] **Next Cleanup Date** - Recommended date for next cleanup

**DO NOT respond until all items are verified.**
