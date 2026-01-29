# Semgrep Integration Guide

This guide explains how to configure and use Semgrep static analysis in the `/qa` workflow.

## Overview

Semgrep is a fast, open-source static analysis tool that finds bugs and enforces code standards. The `/qa` skill integrates Semgrep to automatically scan code changes for security vulnerabilities and anti-patterns.

## Installation

Semgrep is **optional**. If not installed, the `/qa` skill will gracefully skip Semgrep analysis.

### Install Semgrep

```bash
# Using pip (recommended)
pip install semgrep

# Using Homebrew (macOS)
brew install semgrep

# Using npm (via npx - no install required)
npx semgrep --version
```

### Verify Installation

```bash
semgrep --version
# Or
npx semgrep --version
```

## How It Works

1. During `/qa`, the quality checks script detects if Semgrep is installed
2. If installed, it runs Semgrep with stack-appropriate rulesets
3. Findings are categorized by severity (critical, warning, info)
4. Critical findings block the merge verdict (`AC_NOT_MET`)
5. Warnings are noted but don't block merges

## Default Rulesets

Semgrep uses stack-specific rulesets for targeted analysis:

| Stack | Rulesets Applied |
|-------|------------------|
| **Next.js** | p/typescript, p/javascript, p/react, p/security-audit, p/secrets |
| **Astro** | p/typescript, p/javascript, p/security-audit, p/secrets |
| **SvelteKit** | p/typescript, p/javascript, p/security-audit, p/secrets |
| **Remix** | p/typescript, p/javascript, p/react, p/security-audit, p/secrets |
| **Nuxt** | p/typescript, p/javascript, p/security-audit, p/secrets |
| **Python** | p/python, p/django, p/flask, p/security-audit, p/secrets |
| **Go** | p/golang, p/security-audit, p/secrets |
| **Rust** | p/rust, p/security-audit, p/secrets |
| **Generic** | p/security-audit, p/secrets |

## Custom Rules

You can add project-specific rules by creating `.sequant/semgrep-rules.yaml` in your project root.

### Getting Started

Copy the example template to your project:

```bash
# Copy the example template
cp docs/examples/semgrep-rules.example.yaml .sequant/semgrep-rules.yaml
```

### Custom Rules File Location

```
your-project/
├── .sequant/
│   └── semgrep-rules.yaml    # Your custom rules
├── src/
└── package.json
```

### Example Custom Rules

```yaml
rules:
  # Prevent console.log in production code
  - id: no-console-log
    pattern: console.log(...)
    message: "Remove console.log before merging"
    severity: WARNING
    languages: [typescript, javascript]
    paths:
      exclude:
        - "**/*.test.*"
        - "**/__tests__/**"

  # Require explicit return types on exported functions
  - id: explicit-return-type
    pattern: |
      export function $FUNC(...): $RET { ... }
    pattern-not: |
      export function $FUNC(...): void { ... }
    message: "Exported functions should have explicit return types"
    severity: INFO
    languages: [typescript]

  # Detect potential SQL injection
  - id: sql-injection-risk
    patterns:
      - pattern: $DB.query($SQL + ...)
      - pattern: $DB.query(`...${...}...`)
    message: "Potential SQL injection - use parameterized queries"
    severity: ERROR
    languages: [typescript, javascript]

  # Prevent hardcoded API keys
  - id: no-hardcoded-api-key
    pattern-regex: "(api[_-]?key|apikey|secret[_-]?key)\\s*[:=]\\s*['\"][^'\"]{8,}['\"]"
    message: "Don't hardcode API keys - use environment variables"
    severity: ERROR
    languages: [typescript, javascript, python]
```

### Rule Severity Levels

| Severity | Verdict Impact | Description |
|----------|----------------|-------------|
| `ERROR` | **Blocking** | Critical issues that must be fixed |
| `WARNING` | Non-blocking | Issues that should be reviewed |
| `INFO` | Non-blocking | Style suggestions |

## Running Semgrep Manually

You can run Semgrep manually using the provided script:

```bash
# Scan entire project with auto-detected stack
npx tsx scripts/semgrep-scan.ts

# Scan only changed files (faster, recommended)
npx tsx scripts/semgrep-scan.ts --changed-only

# Scan specific directories
npx tsx scripts/semgrep-scan.ts src/api/ src/lib/

# Override detected stack
npx tsx scripts/semgrep-scan.ts --stack python

# Get JSON output
npx tsx scripts/semgrep-scan.ts --json > semgrep-results.json
```

## Interpreting Results

### Clean Output

```
## Static Analysis (Semgrep)

✅ No security issues found
```

### Issues Found

```
## Static Analysis (Semgrep)

❌ 1 critical finding(s)
⚠️  2 warning(s)

### ❌ Critical Issues

- `src/api/users.ts:47` - Potential SQL injection (user input in query) (security.sql-injection)

### ⚠️ Warnings

- `src/utils/exec.ts:12` - Command injection risk (unsanitized shell arg) (security.command-injection)
- `src/lib/logger.ts:8` - Remove console.log before merging (custom.no-console-log)
```

## Troubleshooting

### Semgrep Not Running

1. Check if Semgrep is installed: `semgrep --version`
2. If not installed, install it or use `npx semgrep`
3. Check for error messages in the quality checks output

### False Positives

If a rule produces false positives:

1. Add a `# nosemgrep: rule-id` comment to ignore specific lines
2. Create custom rules that exclude specific patterns
3. Use path exclusions in your custom rules

### Performance

- Semgrep only scans changed files by default (via `--changed-only`)
- Large codebases may take longer on first scan
- Results are not cached between runs

## Resources

- [Semgrep Documentation](https://semgrep.dev/docs/)
- [Semgrep Rule Registry](https://semgrep.dev/r)
- [Writing Custom Rules](https://semgrep.dev/docs/writing-rules/overview/)
- [Rule Syntax Reference](https://semgrep.dev/docs/writing-rules/rule-syntax/)
