---
name: security-review
description: "Deep security analysis for sensitive features (auth, payments, admin, API routes, file operations)."
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Read
  - Glob
  - Grep
  - Task
  - Bash(git diff:*)
  - Bash(git status:*)
  - Bash(git log:*)
  - Bash(npm test:*)
  - Bash(gh issue view:*)
  - Bash(gh issue comment:*)
---

# Security Review Command

You are the Security Review Agent for the current repository.

## Purpose

When invoked as `/security-review`, perform a comprehensive security analysis focused on the specific security domain of the feature being implemented.

## When to Use

| Feature Type | Use /security-review? | Focus Areas |
|-------------|----------------------|-------------|
| Auth flows | Yes | Session handling, token security, password hashing |
| Payment | Yes | PCI compliance, data handling, error messages |
| Admin features | Yes | Privilege escalation, IDOR, access control |
| API routes (user data) | Yes | Input validation, auth checks, rate limiting |
| File operations | Yes | Path traversal, file type validation, size limits |
| UI-only changes | No | Use /qa security checks |
| Content updates | No | No security surface |

**For lightweight security checks on every issue, use `/qa` instead.**

## Behavior

Invocation:

- `/security-review 123`:
  - Treat `123` as the GitHub issue number.
  - Analyze the feature being implemented for that issue.
- `/security-review --domain auth`:
  - Perform review focused on authentication domain.
- `/security-review --domain api`:
  - Perform review focused on API security domain.
- `/security-review --domain admin`:
  - Perform review focused on admin/authorization domain.

## Process

### 1. Identify Security Domain

Analyze the feature being implemented to determine which security domain(s) apply:

**Auto-detection signals:**
- **Authentication:** Issue mentions "login", "password", "session", "token", "auth", "logout"
- **Authorization:** Files in `app/admin/`, mentions "role", "permission", "access control"
- **API Security:** Files in `app/api/`, mentions "endpoint", "request", "validation"
- **Data Protection:** Mentions "PII", "sensitive", "encrypt", "GDPR", "privacy"
- **Infrastructure:** Mentions "env", "secret", "config", "headers", "CSP"
- **File Operations:** Mentions "upload", "download", "file", "path"

### 2. Gather Context

- Read the GitHub issue for feature details
- Identify files changed (worktree or PR diff)
- Determine which security checklists apply

### 3. Apply Domain-Specific Checklists

Run through the relevant security checklists, marking each item as:
- Passed (verified secure)
- Failed (security issue found)
- Needs Manual Review (cannot verify automatically)
- N/A (not applicable to this feature)

See [references/security-checklists.md](references/security-checklists.md) for detailed checklist by domain.

## Security Checklists by Domain

### Authentication (8 items)

| # | Check | How to Verify |
|---|-------|---------------|
| AUTH-1 | Password hashing uses bcrypt/argon2 with appropriate cost | Look for password handling in auth code |
| AUTH-2 | Session tokens are cryptographically random | Check token generation method |
| AUTH-3 | Sessions expire appropriately | Check session TTL configuration |
| AUTH-4 | Logout invalidates session server-side | Verify session deletion on logout |
| AUTH-5 | Password reset tokens are single-use and expire | Check reset token handling |
| AUTH-6 | Rate limiting on login attempts | Look for rate limiter on auth endpoints |
| AUTH-7 | No timing attacks in password comparison | Check for constant-time comparison |
| AUTH-8 | MFA implementation (if applicable) | Review MFA flow if present |

### Authorization (6 items)

| # | Check | How to Verify |
|---|-------|---------------|
| AUTHZ-1 | Every endpoint checks authentication | Review middleware/guards on routes |
| AUTHZ-2 | Role-based access control properly enforced | Check RBAC implementation |
| AUTHZ-3 | No IDOR vulnerabilities (direct object references) | Review ID handling in queries |
| AUTHZ-4 | Horizontal privilege escalation prevented | Check user scoping in queries |
| AUTHZ-5 | Vertical privilege escalation prevented | Check role checks before actions |
| AUTHZ-6 | Admin actions logged for audit | Verify audit logging exists |

### API Security (7 items)

| # | Check | How to Verify |
|---|-------|---------------|
| API-1 | Input validation on all parameters | Check validation schemas (Zod, etc.) |
| API-2 | Output encoding to prevent XSS | Review response sanitization |
| API-3 | SQL injection prevention (parameterized queries) | Check for raw SQL, string concat |
| API-4 | Rate limiting configured | Look for rate limiter middleware |
| API-5 | CORS properly configured | Check CORS headers/config |
| API-6 | Error messages don't leak sensitive info | Review error responses |
| API-7 | File uploads validated (type, size, name) | Check upload handling |

### Data Protection (5 items)

| # | Check | How to Verify |
|---|-------|---------------|
| DATA-1 | Sensitive data encrypted at rest | Check database encryption settings |
| DATA-2 | Sensitive data encrypted in transit | Verify HTTPS enforcement |
| DATA-3 | PII handling compliant with privacy policy | Review data collection/storage |
| DATA-4 | Logs don't contain sensitive data | Check logging statements |
| DATA-5 | Database queries don't expose unauthorized data | Review RLS policies, query filters |

### Infrastructure (5 items)

| # | Check | How to Verify |
|---|-------|---------------|
| INFRA-1 | Environment variables properly protected | No hardcoded secrets in code |
| INFRA-2 | No hardcoded secrets | grep for API keys, passwords |
| INFRA-3 | Dependencies up to date | Check for known vulnerabilities |
| INFRA-4 | CSP headers configured | Review security headers |
| INFRA-5 | Security headers set (HSTS, X-Frame-Options, etc.) | Check Next.js config/middleware |

## Threat Modeling

For each security review, perform basic threat modeling:

### 1. Identify Threat Actors

| Actor Type | Description | Relevance |
|------------|-------------|-----------|
| Anonymous User | Unauthenticated visitor | Can they access protected resources? |
| Authenticated User | Logged in with basic role | Can they escalate privileges? |
| Admin User | Elevated privileges | Can they abuse their access? |
| Malicious Insider | Has valid credentials | Can they exfiltrate data? |
| External Attacker | No credentials, probing system | What attack surface is exposed? |

### 2. Map Attack Surface

For the feature being reviewed, identify:
- **Inputs:** What data does the feature accept? (form fields, URL params, headers)
- **Outputs:** What data does the feature expose? (API responses, page content, logs)
- **State Changes:** What does the feature modify? (database, files, sessions)
- **External Dependencies:** What external systems does it interact with? (APIs, databases)

### 3. Document Attack Vectors

For each identified risk, document:
- **Attack Vector:** How could this be exploited?
- **Impact:** What's the worst case scenario?
- **Likelihood:** How likely is this attack?
- **Mitigation:** What controls are in place?

## Report Format

Generate a security review report in this format:

```markdown
## Security Review: [Feature Name]

**Issue:** #[number]
**Domain(s):** [Authentication | Authorization | API | Data | Infrastructure]
**Risk Level:** [Critical | High | Medium | Low]
**Files Reviewed:** [count]

---

### Threat Model Summary

**Attack Surface:**
- [List of inputs, outputs, state changes]

**Key Threat Actors:**
- [Relevant actors for this feature]

**Primary Attack Vectors:**
- [Top 3 attack vectors identified]

---

### Findings

#### Critical
_Issues requiring immediate attention before merge._

1. **[Finding Title]** (`file:line`)
   - **Issue:** [Description]
   - **Impact:** [Potential damage]
   - **Remediation:** [How to fix]

#### High
_Significant security concerns._

1. **[Finding Title]** (`file:line`)
   - **Issue:** [Description]
   - **Remediation:** [How to fix]

#### Medium
_Issues that should be addressed._

1. **[Finding Title]** (`file:line`)
   - **Issue:** [Description]
   - **Remediation:** [How to fix]

#### Low / Informational
_Best practice recommendations._

1. **[Finding Title]**
   - **Recommendation:** [Suggested improvement]

---

### Checklist Status

| Domain | Passed | Failed | Manual | Total |
|--------|--------|--------|--------|-------|
| Authentication | X | X | X | 8 |
| Authorization | X | X | X | 6 |
| API Security | X | X | X | 7 |
| Data Protection | X | X | X | 5 |
| Infrastructure | X | X | X | 5 |

---

### Verdict

**[SECURE | WARNINGS | ISSUES_FOUND]**

[Summary of overall security posture and recommended actions]
```

## Verdicts

| Verdict | Meaning | Action |
|---------|---------|--------|
| `SECURE` | No security issues found | Safe to proceed |
| `WARNINGS` | Minor issues or items needing manual review | Review warnings, may proceed |
| `ISSUES_FOUND` | Security issues requiring remediation | Fix before merge |

## Integration with Workflow

### Standalone Usage (Manual)

```bash
/security-review 493
/security-review --domain auth
```

### As Part of Workflow

When working on security-sensitive issues:

```
/spec 493    # Plan implementation
/exec 493    # Implement feature
/security-review 493  # Deep security analysis
/qa 493      # Final code review
```

### Logging to workflow_runs

After completing review, log results:
- **Phase:** `security`
- **Verdict:** Maps to existing verdict types:
  - `SECURE` → `pass`
  - `WARNINGS` → `pass_with_notes`
  - `ISSUES_FOUND` → `fail`
- **Output Summary:** Findings count by severity

## Post Review: GitHub Issue Update

After completing the security review, post results to the GitHub issue:

```bash
gh issue comment <issue-number> --body "$(cat <<'EOF'
## Security Review Complete

[Include full report from above]

---
Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## Examples

### Example 1: Admin Feature Review

```bash
/security-review 180
```

**Detection:** Files in `app/admin/`, labels include "admin"
**Domains:** Authorization, API Security
**Focus:**
- AUTHZ-1: Check admin middleware enforces authentication
- AUTHZ-3: Check for IDOR in city configuration
- API-6: Verify error messages don't leak city data

### Example 2: API Route Review

```bash
/security-review --domain api
```

**Focus:** API Security checklist (all 7 items)
**Additional:**
- Review request validation schemas
- Check response sanitization
- Verify rate limiting configuration

### Example 3: Auth Flow Review

```bash
/security-review --domain auth
```

**Focus:** Authentication checklist (all 8 items)
**Additional:**
- Trace session lifecycle
- Review token handling
- Check for timing vulnerabilities

---

## State Tracking

**IMPORTANT:** Update workflow state when running standalone (not orchestrated).

### State Updates (Standalone Only)

When NOT orchestrated (`SEQUANT_ORCHESTRATOR` is not set):

**At skill start:**
```bash
npx tsx scripts/state/update.ts start <issue-number> security-review
```

**On successful completion (SECURE or WARNINGS):**
```bash
npx tsx scripts/state/update.ts complete <issue-number> security-review
```

**On failure (ISSUES_FOUND):**
```bash
npx tsx scripts/state/update.ts fail <issue-number> security-review "Security issues found"
```

**Why this matters:** State tracking enables dashboard visibility, resume capability, and workflow orchestration. Skills update state when standalone; orchestrators handle state when running workflows.

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Security Domain** - Identified domains (Auth, API, Admin, Data, Infra)
- [ ] **Threat Model Summary** - Attack surface, threat actors, attack vectors
- [ ] **Findings by Severity** - Critical, High, Medium, Low/Informational
- [ ] **Checklist Status Table** - Passed/Failed/Manual counts per domain
- [ ] **Verdict** - SECURE, WARNINGS, or ISSUES_FOUND
- [ ] **GitHub Comment** - Security review posted to issue

**DO NOT respond until all items are verified.**
