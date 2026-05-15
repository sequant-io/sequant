#!/usr/bin/env bash
# Sync .claude/hooks/ from templates/hooks/ (#645).
#
# The drift test in src/lib/relay/__tests__/hook-sync.test.ts fails when these
# two directories diverge for any file that exists in templates/. Run this
# script after editing a template hook to regenerate the installed copy.
#
# Local-only files (e.g. capture-tokens.sh) are left untouched.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
TEMPLATES_DIR="${REPO_ROOT}/templates/hooks"
ACTIVE_DIR="${REPO_ROOT}/.claude/hooks"

if [[ ! -d "$TEMPLATES_DIR" ]]; then
  echo "templates/hooks/ not found at $TEMPLATES_DIR" >&2
  exit 1
fi
mkdir -p "$ACTIVE_DIR"

changed=0
for src in "$TEMPLATES_DIR"/*; do
  [[ -f "$src" ]] || continue
  name=$(basename "$src")
  dest="$ACTIVE_DIR/$name"
  if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
    continue
  fi
  cp -p "$src" "$dest"
  chmod 0755 "$dest"
  echo "synced: $name"
  changed=$((changed + 1))
done

if [[ $changed -eq 0 ]]; then
  echo "hooks already in sync."
fi
