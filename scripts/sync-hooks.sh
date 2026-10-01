#!/usr/bin/env bash
# Sync .claude/hooks/ and plugin/hooks/ from templates/hooks/ (#645, #1265).
#
# The drift test in src/lib/relay/__tests__/hook-sync.test.ts fails when any
# of these directories diverge for a file that exists in templates/. Run this
# script after editing a template hook to regenerate the installed copies.
#
# Every hook now lives in templates/hooks/ and is regenerated here; there are
# no local-only hooks left. capture-tokens.sh was the last one — #986 promoted
# it into templates/ (and into hooks/ + hooks.json for plugin users) because
# the token-usage fallback it feeds is worthless if it only exists in this
# repo.
#
# plugin/hooks/hooks.json has no templates/ source (hooks.json is the
# registration manifest, not a hook script) — it is copied from the
# hand-maintained root hooks/hooks.json, which #1265 keeps around until root
# hooks/ is retired in a follow-up PR.

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

HOOKS_JSON_SRC="${REPO_ROOT}/hooks/hooks.json"
HOOKS_JSON_DEST="${PLUGIN_DIR}/hooks.json"
if [[ -f "$HOOKS_JSON_SRC" ]]; then
  if [[ ! -f "$HOOKS_JSON_DEST" ]] || ! cmp -s "$HOOKS_JSON_SRC" "$HOOKS_JSON_DEST"; then
    cp -p "$HOOKS_JSON_SRC" "$HOOKS_JSON_DEST"
    echo "synced: hooks.json -> plugin/hooks/hooks.json"
    changed=$((changed + 1))
  fi
fi

if [[ $changed -eq 0 ]]; then
  echo "hooks already in sync."
fi
