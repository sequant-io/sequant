# Workflow Phases

Sequant processes GitHub issues through sequential phases, each with a specific purpose.

## Phase Overview

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  /spec  │───▶│/testgen │───▶│  /exec  │───▶│  /test  │───▶│   /qa   │───▶ Merge
└─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘
     │              │              │              │              │
     ▼              ▼              ▼              ▼              ▼
   Plan        Test Stubs       Build       Verify (UI)      Review
```

> **Note:** `/testgen` and `/test` are optional phases:
> - `/testgen` is auto-included when ACs have Unit/Integration Test verification methods
> - `/test` is used for UI features when Chrome DevTools MCP is available

## Phase 1: Spec

**Command:** `/spec 123`

**Purpose:** Plan implementation before writing code.

**What it does:**
1. Reads the GitHub issue and all comments
2. Analyzes title/body for phase-relevant keywords (UI, security, complexity)
3. Analyzes the codebase for relevant patterns
4. Drafts acceptance criteria (AC) if not present
5. Lints AC for vague or unmeasurable terms
6. Creates an implementation plan with quality dimensions
7. Posts the plan as a GitHub issue comment

**Outputs:**
- Acceptance criteria checklist (with lint warnings if vague)
- Content analysis signals (title/body patterns detected)
- Implementation plan with file changes
- Recommended workflow (which phases to run)

**When to use:**
- Before implementing any non-trivial feature
- When acceptance criteria are unclear
- When you want to review the approach before coding

## Phase 1.5: Testgen (Optional)

**Command:** `/testgen 123`

**Purpose:** Generate test stubs from verification criteria before implementation.

**What it does:**
1. Reads verification criteria from the `/spec` comment
2. Parses each AC's verification method (Unit Test, Integration Test, etc.)
3. Generates test stubs with TODO markers
4. Uses haiku sub-agents for cost-efficient stub generation
5. Posts a summary to the GitHub issue

**Outputs:**
- Test stub files in `__tests__/` directory
- Browser test scenarios (for UI verification)
- Manual test checklists (for non-automated tests)
- Summary comment on GitHub issue

**When to use:**
- New features with testable acceptance criteria
- ACs that specify Unit Test or Integration Test verification
- Features where test structure should be defined before implementation

**Auto-detection:**
`/spec` automatically recommends `/testgen` when:
- ACs have "Unit Test" or "Integration Test" verification methods
- Issue is a new feature (not a bug fix)
- Project has test infrastructure (Jest, Vitest, etc.)

## Phase 2: Exec

**Command:** `/exec 123`

**Purpose:** Implement the feature in an isolated environment.

**What it does:**
1. Creates a git worktree for the issue
2. Implements changes according to the plan
3. Runs tests after each change
4. Creates commits with progress updates
5. Pushes the branch and creates a PR

**Outputs:**
- Feature branch with implementation
- Test results
- Progress update on GitHub issue

**When to use:**
- After `/spec` has been reviewed and approved
- For any implementation work

## Phase 2.5: Test (Optional)

**Command:** `/test 123`

**Purpose:** Browser-based UI verification.

**What it does:**
1. Starts the development server
2. Navigates to affected pages
3. Takes screenshots
4. Verifies UI elements work correctly

**Outputs:**
- Screenshot evidence
- Pass/fail status for UI tests

**When to use:**
- For UI changes (components, pages, styling)
- When Chrome DevTools MCP is available

## Phase 2.5: Verify (Optional)

**Command:** `/verify 123`

**Purpose:** CLI/script execution verification.

**What it does:**
1. Runs affected CLI commands or scripts
2. Captures output
3. Verifies expected behavior

**Outputs:**
- Command output logs
- Pass/fail status

**When to use:**
- For CLI tools or scripts
- When changes affect command-line behavior

## Phase 3: QA

**Command:** `/qa 123`

**Purpose:** Code review and quality gate.

**What it does:**
1. Reviews code against acceptance criteria
2. Checks type safety (no `any`, proper types)
3. Scans for security vulnerabilities
4. Detects scope creep (unrelated changes)
5. Suggests fixes for issues found

**Outputs:**
- AC compliance report
- List of issues found
- Suggested fixes
- PR review comment draft

**When to use:**
- Before merging any feature branch
- After `/exec` completes

## Phase 4: Docs (Optional)

**Command:** `/docs 123`

**Purpose:** Generate documentation for the feature.

**What it does:**
1. Analyzes the implemented feature
2. Generates user-facing documentation
3. Updates relevant docs files

**Outputs:**
- Documentation updates

**When to use:**
- For user-facing features
- When documentation is required before merge

## Phase Selection

### Automatic Detection

When using `sequant run`, phases are detected automatically:

1. **Explicit:** `--phases spec,exec,qa` uses those phases
2. **Spec-driven:** `/spec` outputs recommended phases
3. **Label-based:** Issue labels determine phases

### Label-Based Detection

| Labels | Phases | Why |
|--------|--------|-----|
| `bug`, `fix`, `hotfix` | exec → qa | Simple fixes skip spec and testgen |
| `docs`, `documentation` | exec → qa | Docs changes skip spec and testgen |
| `enhancement`, `feature` | spec → testgen → exec → qa | New features need test stubs |
| `ui`, `frontend`, `admin` | spec → testgen → exec → test → qa | UI with testable ACs |
| `complex`, `refactor` | spec → testgen → exec → qa + quality loop | Complex changes need tests and iteration |

### Testgen Auto-Detection

`/spec` recommends `/testgen` when:
- ACs have "Unit Test" or "Integration Test" verification methods
- Issue has `enhancement` or `feature` label
- Project has test framework detected

`/spec` skips `/testgen` when:
- Issue is bug-only (`bug`, `fix`, `hotfix` labels only)
- Issue is docs-only (`docs` label)
- All ACs use "Manual Test" or "Browser Test" verification

## Skipping Phases

You can skip phases when appropriate:

```bash
# Skip spec for simple bug fixes
/exec 123

# Skip test for backend-only changes
/qa 123

# Run specific phases only
npx sequant run 123 --phases exec,qa
```

## Phase Dependencies

- **Exec** can run without spec (but planning is recommended)
- **Test** requires exec (code must exist to test)
- **QA** can run independently (reviews existing code)
- **Docs** should run after QA passes
