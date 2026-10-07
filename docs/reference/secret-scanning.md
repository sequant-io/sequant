# Secret scanning

This repository is public. Three layers stop private material before it lands:

1. GitHub secret scanning, push protection and Dependabot security updates (repo settings).
2. `.github/workflows/gitleaks.yml` runs gitleaks with `.gitleaks.toml` on every pull request and merge group. It also fails if an `entire/*` ref exists on `origin`.
3. Optional local gate: `ln -sf ../../scripts/gitleaks-precommit.sh .git/hooks/pre-commit`.

## Project rules

| Rule id | Catches |
|---------|---------|
| `home-path` | `/Users/<name>/` and `/home/<name>/` |
| `claude-session-url` | `claude.ai/code/session_…` links |
| `claude-cse-id` | `cse_…` cloud session ids |

Placeholder names (`user`, `you`, `dev`, `test`, `YourName`, …) are allowlisted by name in `.gitleaks.toml`. Test input that needs a session id uses a `FAKE` prefix. Add a new placeholder name there with a reason; never allowlist a file.

## Sensitive literals

Never write a project name or gated flag into `.gitleaks.toml`. Put such literals in `.gitleaks.local.toml` (gitignored); the local gate loads it when present.

## Note

`evals/results/*.json` come from `claude plugin eval`, which records absolute paths. Redact them before committing; the `home-path` rule fails the PR otherwise.
