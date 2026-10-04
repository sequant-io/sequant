#!/usr/bin/env bash
# Sync .claude/hooks/, plugin/hooks/, and plugin/memory/constitution.md from
# their templates/ sources (#645, #1265).
#
# The drift tests in src/lib/relay/__tests__/hook-sync.test.ts (hooks) and
# scripts/check-constitution-plugin-sync.test.ts (constitution) fail when
# these diverge from their templates/ source. Run this script after editing a
# template hook or templates/memory/constitution.md to regenerate the
# installed copies.
#
# Every hook now lives in templates/hooks/ and is regenerated here; there are
# no local-only hooks left. capture-tokens.sh was the last one — #986 promoted
# it into templates/ (and into plugin hooks.json for plugin users) because
# the token-usage fallback it feeds is worthless if it only exists in this
# repo.
#
# plugin/hooks/hooks.json is not a sync target. It is the hand-maintained
# registration manifest and is its own source (#1271 retired the root hooks/
# copy it used to be copied from). It has no templates/ source because
# templates/hooks/* is copied into every consumer's .claude/hooks/, and the
# manifest is for the plugin only.
#
# plugin/memory/constitution.md is a straight copy of
# templates/memory/constitution.md (#1265) — this repo's own
# memory/constitution.md is a separate, hand-maintained file (its own
# producer), not a sync target of this script.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
TEMPLATES_DIR="${REPO_ROOT}/templates/hooks"
ACTIVE_DIR="${REPO_ROOT}/.claude/hooks"
PLUGIN_DIR="${REPO_ROOT}/plugin/hooks"

if [[ ! -d "$TEMPLATES_DIR" ]]; then
  echo "templates/hooks/ not found at $TEMPLATES_DIR" >&2
  exit 1
fi
mkdir -p "$ACTIVE_DIR" "$PLUGIN_DIR"

changed=0
for src in "$TEMPLATES_DIR"/*; do
  [[ -f "$src" ]] || continue
  name=$(basename "$src")
  for dir in "$ACTIVE_DIR" "$PLUGIN_DIR"; do
    dest="$dir/$name"
    if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
      continue
    fi
    cp -p "$src" "$dest"
    chmod 0755 "$dest"
    echo "synced: $name -> ${dest#"$REPO_ROOT"/}"
    changed=$((changed + 1))
  done
done

CONSTITUTION_SRC="${REPO_ROOT}/templates/memory/constitution.md"
CONSTITUTION_DEST="${REPO_ROOT}/plugin/memory/constitution.md"
if [[ -f "$CONSTITUTION_SRC" ]]; then
  mkdir -p "$(dirname "$CONSTITUTION_DEST")"
  if [[ ! -f "$CONSTITUTION_DEST" ]] || ! cmp -s "$CONSTITUTION_SRC" "$CONSTITUTION_DEST"; then
    cp -p "$CONSTITUTION_SRC" "$CONSTITUTION_DEST"
    echo "synced: constitution.md -> plugin/memory/constitution.md"
    changed=$((changed + 1))
  fi
fi

if [[ $changed -eq 0 ]]; then
  echo "hooks already in sync."
fi
