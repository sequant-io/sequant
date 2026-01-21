# Anti-Pattern Detection

## Purpose

Lightweight pattern-matching sanity checks to catch issues that experts would flag immediately. These checks complement code review by automating detection of common mistakes.

## Part 1: New Dependency Audit

### When to Run

Run dependency audit when `package.json` is modified:

```bash
# Check if package.json was modified
pkg_modified=$(git diff main...HEAD --name-only | grep -E "^package\.json$" | head -1)
if [[ -n "$pkg_modified" ]]; then
  echo "package.json modified - running dependency audit"
fi
```

### Detecting New Dependencies

```bash
# Get new dependencies (added in this branch)
git diff main...HEAD -- package.json | grep '^\+.*":' | grep -v '^\+\+\+' | sed 's/.*"\([^"]*\)".*/\1/' | grep -v -E '^(@types/|version|name|description|scripts|devDependencies|dependencies|peerDependencies)$'
```

### Audit Criteria

| Flag | Threshold | Detection Method | Risk Level |
|------|-----------|------------------|------------|
| Low downloads | <1,000/week | `npm view <pkg> --json \| jq '.downloads'` | ⚠️ Medium |
| Stale | No updates 12+ months | `npm view <pkg> time.modified` | ⚠️ Medium |
| License risk | UNLICENSED, GPL in MIT project | `npm view <pkg> license` | ❌ High |
| Size concern | >100kb for utility | `npm view <pkg> dist.unpackedSize` | ⚠️ Low |
| Security advisory | Known vulnerabilities | `npm audit --json` | ❌ High |

### Audit Commands

```bash
# Get package metadata (run for each new dependency)
pkg="<package-name>"

# Weekly downloads (requires npm API)
downloads=$(curl -s "https://api.npmjs.org/downloads/point/last-week/$pkg" | jq '.downloads // 0')

# Last update date
last_update=$(npm view "$pkg" time.modified 2>/dev/null)

# License
license=$(npm view "$pkg" license 2>/dev/null)

# Unpacked size (in bytes)
size=$(npm view "$pkg" dist.unpackedSize 2>/dev/null)

# Security check (all dependencies)
npm audit --json 2>/dev/null | jq '.vulnerabilities | length'
```

### Output Format

```markdown
### Dependency Audit

| Package | Downloads/wk | Last Update | License | Size | Flags |
|---------|--------------|-------------|---------|------|-------|
| foo-pkg | 500 | 2023-01-15 | MIT | 45kb | ⚠️ Low downloads, ⚠️ Stale |
| bar-lib | 50,000 | 2024-12-01 | Apache-2.0 | 120kb | ⚠️ Size |

**Security Audit:** 0 vulnerabilities found

**Flagged Dependencies:**
1. `foo-pkg` - Low downloads (<1,000/week) and stale (12+ months)
   - **Risk:** Unmaintained packages may have unpatched vulnerabilities
   - **Suggestion:** Consider alternative with active maintenance or vendor the code
```

### Verdict Impact

| Finding | Verdict Impact |
|---------|----------------|
| Low downloads only | Note in QA, no verdict change |
| Stale only | Note in QA, no verdict change |
| Security vulnerability (moderate+) | `AC_NOT_MET` (blocker) |
| License incompatibility | `AC_NOT_MET` (blocker) |
| Multiple flags on same package | `AC_MET_BUT_NOT_A_PLUS` |

---

## Part 2: Code Pattern Checks

### Anti-Pattern Detection Matrix

| Category | Pattern | Detection | Suggestion | Risk |
|----------|---------|-----------|------------|------|
| **Performance** | N+1 query (`await` in loop) | `for.*await\|\.forEach.*await` | Use batch query or `Promise.all` | ⚠️ Medium |
| **Performance** | Unbounded loop | `while.*true\|for.*;;` without break limit | Add iteration limit | ⚠️ Medium |
| **Performance** | Sync file ops in async context | `fs\.readFileSync\|fs\.writeFileSync` | Use async fs methods | ⚠️ Low |
| **Error Handling** | Empty catch block | `catch.*\{\s*\}` | Log or rethrow | ⚠️ Medium |
| **Error Handling** | Swallowed error | `catch.*\{\s*//` | Handle or rethrow | ⚠️ Medium |
| **Error Handling** | Unhandled promise | `\.then\(.*\)[^.]` without `.catch` | Add `.catch()` or use try/catch | ⚠️ Medium |
| **Security** | Hardcoded secret | `(api[_-]?key\|secret\|password)\s*[:=]\s*['"][^'"]+['"]` | Use env variable | ❌ High |
| **Security** | SQL concatenation | `\+.*SELECT\|SELECT.*\+\|'.*\$\{.*\}.*SELECT` | Use parameterized query | ❌ High |
| **Security** | eval usage | `eval\(` | Remove eval, use safe alternative | ❌ High |
| **Memory** | Uncleared interval | `setInterval\(` without corresponding `clearInterval` | Clear in cleanup | ⚠️ Medium |
| **Memory** | Uncleared timeout | `setTimeout\(` in component without cleanup | Clear in useEffect cleanup | ⚠️ Low |
| **A11y** | Image without alt | `<img[^>]*(?!alt=)[^>]*>` | Add descriptive alt | ⚠️ Low |
| **A11y** | Click handler without keyboard | `onClick=\{` without `onKeyDown` | Add keyboard handler | ⚠️ Low |

### Detection Commands

```bash
# Run on changed files only
changed_files=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$')

# N+1 query pattern (await in loop)
grep -n -E 'for\s*\([^)]*\)\s*\{[^}]*await|\.forEach\([^)]*async' $changed_files 2>/dev/null

# Empty catch block
grep -n -E 'catch\s*\([^)]*\)\s*\{\s*\}' $changed_files 2>/dev/null

# Hardcoded secrets (case insensitive)
grep -ni -E '(api[_-]?key|secret|password|token)\s*[:=]\s*['"'"'"][^'"'"'"]+['"'"'"]' $changed_files 2>/dev/null | grep -v -E '(\.env|example|test|mock|placeholder)'

# SQL concatenation
grep -n -E "(\+\s*['\"].*SELECT|SELECT.*['\"].*\+|\`.*\$\{.*\}.*SELECT)" $changed_files 2>/dev/null

# Uncleared intervals (check for setInterval without corresponding clear)
for f in $changed_files; do
  intervals=$(grep -c 'setInterval(' "$f" 2>/dev/null || echo 0)
  clears=$(grep -c 'clearInterval(' "$f" 2>/dev/null || echo 0)
  if [[ $intervals -gt $clears ]]; then
    echo "$f: $intervals setInterval calls, only $clears clearInterval calls"
  fi
done
```

### Output Format

```markdown
### Code Pattern Analysis

| File:Line | Category | Pattern | Suggestion |
|-----------|----------|---------|------------|
| `src/api/users.ts:45` | Performance | N+1 query | Use `Promise.all` for batch fetching |
| `src/utils/config.ts:12` | Error Handling | Empty catch | Log error or rethrow |
| `src/components/List.tsx:89` | Memory | Uncleared interval | Add `clearInterval` in cleanup |

**Critical Issues:** 0
**Warnings:** 3

**Details:**

1. **N+1 Query** at `src/api/users.ts:45`
   ```typescript
   // Current (N+1)
   for (const id of userIds) {
     await fetchUser(id);  // Makes N requests
   }

   // Suggested
   await Promise.all(userIds.map(id => fetchUser(id)));
   // Or use batch endpoint
   await fetchUsers(userIds);
   ```

2. **Empty Catch** at `src/utils/config.ts:12`
   ```typescript
   // Current
   try { ... } catch (e) { }

   // Suggested
   try { ... } catch (e) {
     console.error('Config load failed:', e);
     // or rethrow: throw e;
   }
   ```
```

### Verdict Impact

| Finding | Verdict Impact |
|---------|----------------|
| Performance warnings | Note in QA, no verdict change |
| Empty catch blocks | `AC_MET_BUT_NOT_A_PLUS` |
| Security issues (secrets, SQL injection) | `AC_NOT_MET` (blocker) |
| Uncleared intervals/timeouts | `AC_MET_BUT_NOT_A_PLUS` |
| A11y issues | Note in QA, no verdict change |

---

## Part 3: Integration with QA Workflow

### When to Run

1. **Dependency Audit:** Only when `package.json` is modified
2. **Code Pattern Checks:** Always run on changed `.ts/.tsx/.js/.jsx` files

### Execution Order

```
1. Standard quality checks (type safety, deleted tests, scope)
2. Dependency audit (if package.json modified)
3. Code pattern checks
4. Test quality review (if test files modified)
5. Execution evidence (if scripts/CLI modified)
```

### Combined Output Section

```markdown
### Anti-Pattern Detection

#### Dependency Audit
[Include if package.json modified, otherwise: "N/A - No dependency changes"]

#### Code Patterns
[Always include for code changes]

**Summary:**
- Dependencies flagged: X
- Code patterns flagged: Y
- Critical issues: Z (blockers)
```

---

## Appendix: Full Detection Script

For automation, this script can be run to check all patterns:

```bash
#!/bin/bash
# anti-pattern-check.sh

set -e

echo "=== Anti-Pattern Detection ==="

# Get changed files
CHANGED_TS=$(git diff main...HEAD --name-only | grep -E '\.(ts|tsx|js|jsx)$' || true)
PKG_CHANGED=$(git diff main...HEAD --name-only | grep -E '^package\.json$' || true)

# 1. Dependency Audit
if [[ -n "$PKG_CHANGED" ]]; then
  echo ""
  echo "## Dependency Audit"
  # Get new deps
  NEW_DEPS=$(git diff main...HEAD -- package.json | grep '^\+.*":' | grep -v '^\+\+\+' | sed 's/.*"\([^"]*\)".*/\1/' | grep -v -E '^(@types/|version|name|description|scripts|devDependencies|dependencies|peerDependencies|engines|repository|author|license|bugs|homepage|main|module|types)$' || true)

  if [[ -n "$NEW_DEPS" ]]; then
    echo "New dependencies detected:"
    for dep in $NEW_DEPS; do
      echo "  - $dep"
    done
  else
    echo "No new dependencies added"
  fi
fi

# 2. Code Pattern Checks
if [[ -n "$CHANGED_TS" ]]; then
  echo ""
  echo "## Code Pattern Checks"

  echo ""
  echo "### N+1 Queries (await in loop):"
  grep -n -E 'for\s*\([^)]*\)\s*\{[^}]*await|\.forEach\([^)]*async' $CHANGED_TS 2>/dev/null || echo "  None found"

  echo ""
  echo "### Empty Catch Blocks:"
  grep -n -E 'catch\s*\([^)]*\)\s*\{\s*\}' $CHANGED_TS 2>/dev/null || echo "  None found"

  echo ""
  echo "### Potential Hardcoded Secrets:"
  grep -ni -E '(api[_-]?key|secret|password|token)\s*[:=]\s*['"'"'"][^'"'"'"]+['"'"'"]' $CHANGED_TS 2>/dev/null | grep -v -E '(\.env|example|test|mock|placeholder|process\.env)' || echo "  None found"
fi

echo ""
echo "=== End Anti-Pattern Detection ==="
```
