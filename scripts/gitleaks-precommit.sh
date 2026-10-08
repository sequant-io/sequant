#!/usr/bin/env bash
# Optional local gate (#1352): scan staged changes with gitleaks before commit.
# Install: ln -sf ../../scripts/gitleaks-precommit.sh .git/hooks/pre-commit
# Skips silently when gitleaks is not installed. Loads .gitleaks.local.toml
# (untracked, for literals that must stay out of the public config) if present.
set -euo pipefail

command -v gitleaks >/dev/null 2>&1 || exit 0

root="$(git rev-parse --show-toplevel)"
gitleaks protect --staged --redact --config "$root/.gitleaks.toml"

if [ -f "$root/.gitleaks.local.toml" ]; then
  gitleaks protect --staged --redact --config "$root/.gitleaks.local.toml"
fi
