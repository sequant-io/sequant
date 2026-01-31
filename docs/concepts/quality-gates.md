# Quality Gates

Sequant enforces quality checks at every phase. Understanding these gates helps you write code that passes on the first try.

## Overview

Quality gates are automated checks that run during the `/qa` phase. They verify:

1. **AC Adherence** — Does the code satisfy acceptance criteria?
2. **Type Safety** — Are types properly defined?
3. **Security** — Are there vulnerabilities?
4. **Scope** — Are changes within the issue scope?
5. **CI Status** — Are GitHub CI checks passing?
6. **Build Verification** — Is build failure a regression or pre-existing?

## AC Adherence

The most important gate: does the code do what the issue asked for?

### How It Works

1. Reads acceptance criteria from the issue
2. Maps each AC item to code changes
3. Verifies each criterion is satisfied

### Example

**Issue AC:**
```markdown
- [ ] AC-1: Add login button to header
- [ ] AC-2: Button redirects to /login on click
- [ ] AC-3: Button shows "Sign In" text
```

**QA Check:**
```
✅ AC-1: LoginButton component added to Header.tsx
✅ AC-2: onClick handler calls router.push('/login')
✅ AC-3: Button text is "Sign In"
```

### Tips

- Write clear, testable acceptance criteria
- Each AC should map to a specific code change
- Use verifiable language ("Button shows X" not "Button looks good")

## Type Safety

Catches type-related issues that can cause runtime errors.

### What Gets Flagged

| Issue | Example | Why It's Bad |
|-------|---------|--------------|
| `any` type | `const data: any = ...` | Defeats TypeScript's purpose |
| `as any` cast | `(data as any).field` | Bypasses type checking |
| Missing types | `function foo(x) {...}` | Implicit `any` |
| Non-null assertions | `data!.field` | Assumes value exists |

### Example

```typescript
// ❌ Flagged
const response: any = await fetch('/api/data');
const name = (response as any).user.name;

// ✅ Good
interface ApiResponse {
  user: { name: string };
}
const response: ApiResponse = await fetch('/api/data').then(r => r.json());
const name = response.user.name;
```

### Tips

- Define interfaces for API responses
- Use generics instead of `any`
- Enable `strict` mode in tsconfig.json

## Security Scans

Identifies common security vulnerabilities.

### What Gets Checked

| Vulnerability | Example |
|---------------|---------|
| SQL Injection | Raw SQL with user input |
| XSS | Unescaped HTML output |
| Command Injection | `exec()` with user input |
| Path Traversal | File paths from user input |
| Hardcoded Secrets | API keys in code |

### Example

```typescript
// ❌ Flagged: Command injection
const output = exec(`git log --author="${userInput}"`);

// ✅ Good: Sanitized input
const sanitized = userInput.replace(/[^a-zA-Z0-9]/g, '');
const output = exec(`git log --author="${sanitized}"`);
```

### Tips

- Never trust user input
- Use parameterized queries
- Escape output before rendering
- Store secrets in environment variables

## Semgrep Static Analysis

Semgrep provides AST-aware static analysis that catches issues regex patterns miss.

### How It Works

1. Detects your project stack (Next.js, Python, Go, etc.)
2. Applies stack-specific rulesets (e.g., `p/typescript`, `p/react`, `p/security-audit`)
3. Loads custom rules from `.sequant/semgrep-rules.yaml` if present
4. Reports findings by severity (critical, warning, info)

### What Gets Checked

| Category | Examples |
|----------|----------|
| Security | SQL injection, XSS, command injection, hardcoded secrets |
| Code Quality | Unused variables, unreachable code, deprecated APIs |
| Best Practices | Missing error handling, unsafe type assertions |

### Severity Impact

| Severity | Verdict Impact |
|----------|----------------|
| `ERROR` / Critical | **Blocks merge** — `AC_NOT_MET` |
| `WARNING` | Non-blocking — noted for review |
| `INFO` | Non-blocking — suggestions only |

### Custom Rules

Add project-specific rules in `.sequant/semgrep-rules.yaml`:

```yaml
rules:
  - id: no-console-log
    pattern: console.log(...)
    message: "Remove console.log before merging"
    severity: WARNING
    languages: [typescript, javascript]
    paths:
      exclude:
        - "**/*.test.*"
```

See `docs/examples/semgrep-rules.example.yaml` for more examples.

### Graceful Degradation

If Semgrep is not installed, `/qa` skips the scan with a message:

```
⚠️ Semgrep not installed (optional)
   Install with: pip install semgrep
```

This ensures Semgrep is opt-in and doesn't block workflows.

## CI Status Awareness

QA checks GitHub CI status before finalizing verdicts. This prevents premature `READY_FOR_MERGE` when CI is still running.

### How It Works

1. Detects if a PR exists for the current branch
2. Runs `gh pr checks` to get CI status
3. Maps CI status to AC status for CI-related criteria
4. Factors CI status into the final verdict

### CI Status Mapping

| CI State | CI Conclusion | AC Status | Verdict Impact |
|----------|---------------|-----------|----------------|
| `completed` | `success` | `MET` | No impact |
| `completed` | `failure` | `NOT_MET` | Blocks merge |
| `in_progress` | - | `PENDING` | → `NEEDS_VERIFICATION` |
| `queued` | - | `PENDING` | → `NEEDS_VERIFICATION` |
| (no checks) | - | `N/A` | No CI configured |

### CI-Related AC Detection

QA identifies AC items that depend on CI by matching patterns:
- "Tests pass in CI"
- "CI passes"
- "Build succeeds in CI"
- "GitHub Actions pass"
- "Pipeline passes"

### Example

```text
AC-1: Add login button         → MET
AC-2: Tests pass in CI         → PENDING (CI still running)

Verdict: NEEDS_VERIFICATION
Reason: CI checks not yet complete
```

### No CI Configured

If the repository has no CI checks, CI-related AC items are marked `N/A` with no impact on verdict.

## Build Verification

When `npm run build` fails, QA verifies whether the failure is a regression (new) or pre-existing (already on main).

### Why This Matters

Without verification, QA might dismiss build failures as "unrelated to our changes" when they're actually regressions introduced by the PR.

### How It Works

1. Run `npm run build` on feature branch
2. If build fails, run build on main branch (via main repo directory)
3. Compare exit codes and error messages
4. Classify as regression, pre-existing, or unknown

### Verification Logic

| Feature Build | Main Build | Error Match | Classification |
|---------------|------------|-------------|----------------|
| ❌ Fail | ✅ Pass | N/A | **Regression** — failure introduced by PR |
| ❌ Fail | ❌ Fail | Same error | **Pre-existing** — not blocking |
| ❌ Fail | ❌ Fail | Different | **Unknown** — manual review needed |
| ✅ Pass | * | N/A | N/A — no verification needed |

### Verdict Impact

| Classification | Verdict Impact |
|----------------|----------------|
| **Regression detected** | **Blocks merge** — `AC_NOT_MET` |
| **Pre-existing failure** | Non-blocking — documented only |
| **Unknown** | `AC_MET_BUT_NOT_A_PLUS` — manual review |
| **Build passes** | No impact |

### Example Output

```markdown
### Build Verification

| Check | Status |
|-------|--------|
| Feature branch build | ❌ Failed |
| Main branch build | ❌ Failed |
| Error match | ✅ Same error |
| Regression | **No** (pre-existing) |

**Note:** Build failure is pre-existing on main branch. Not blocking this PR.
```

## QA Verdicts

After running all checks, QA issues one of four verdicts:

| Verdict | Meaning | Action |
|---------|---------|--------|
| `READY_FOR_MERGE` | All AC met, high code quality | Merge the PR |
| `AC_MET_BUT_NOT_A_PLUS` | All AC met, minor improvements suggested | Can merge, consider suggestions |
| `NEEDS_VERIFICATION` | All AC met or pending, awaiting external verification | Complete verification, re-run QA |
| `AC_NOT_MET` | One or more AC not fully met | Fix issues before merge |

### Verdict Determination

Verdicts are determined by AC status counts:

1. **If any AC is `NOT_MET` or `PARTIALLY_MET`:** → `AC_NOT_MET`
2. **If any AC is `PENDING`:** → `NEEDS_VERIFICATION`
3. **If improvements are suggested:** → `AC_MET_BUT_NOT_A_PLUS`
4. **Otherwise:** → `READY_FOR_MERGE`

> **Important:** `PARTIALLY_MET` is treated as `NOT_MET` for verdict purposes. Partial implementations block merge.

### Example

```text
AC-1: Add login button         → MET
AC-2: Button redirects         → MET
AC-3: CI passes                 → PENDING (awaiting CI)

Verdict: NEEDS_VERIFICATION
Reason: AC-3 requires external verification
```

## Scope Analysis

Detects changes unrelated to the issue being worked on.

### What Gets Flagged

- Files changed that aren't mentioned in the plan
- Refactors unrelated to the AC
- "While I was here" improvements
- Formatting changes to untouched code

### Example

**Issue:** "Add logout button"

```diff
// ❌ Flagged: Unrelated change
- import { Button } from './Button';
+ import { Button } from '@/components/Button';  // Unrelated path change

// ❌ Flagged: Scope creep
+ // Also refactored the login button while here
+ const LoginButton = () => ...

// ✅ Good: Only the requested change
+ const LogoutButton = () => <Button onClick={logout}>Sign Out</Button>;
```

### Tips

- Keep changes focused on the issue
- Save "while I was here" improvements for separate issues
- If you find a bug, create a new issue instead of fixing inline

## Quality Loop

When gates fail, the quality loop automatically fixes issues.

### How It Works

```
┌──────┐    ┌───────────┐    ┌──────────┐
│  QA  │───▶│  Analyze  │───▶│   Fix    │──┐
└──────┘    │  Failures │    └──────────┘  │
    ▲       └───────────┘                   │
    │                                       │
    └───────────────────────────────────────┘
              (up to 3 iterations)
```

### Triggering Quality Loop

```bash
# Automatic with run command
npx sequant run 123 --quality-loop

# Manual after QA
/loop 123
```

### What Gets Fixed

- Type errors (adds proper types)
- Missing AC items (implements missing features)
- Security issues (applies safe patterns)
- Test failures (fixes failing tests)

### What Requires Manual Intervention

- Architectural decisions
- Ambiguous requirements
- Breaking changes to public APIs
- Security issues requiring design changes

## Custom Gates

Projects can add custom quality gates via constitution:

```markdown
# .claude/memory/constitution.md

## Quality Requirements

1. Test coverage must exceed 80%
2. All public functions need JSDoc comments
3. No console.log in production code
```

These get checked during `/qa` along with standard gates.
