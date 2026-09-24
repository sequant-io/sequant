#!/usr/bin/env bash
#
# Print the GitHub ruleset payload that guards `main` (#1093).
#
# The `main` ruleset (name `CC`, id 12393605) shipped enforcing only `deletion`
# and `non_fast_forward`, with `conditions.ref_name.include: []` — it targeted
# no ref at all. There were no required status checks and no up-to-date
# requirement, so a PR could merge with stale or red CI. That is what happened
# on 2026-09-10/11: #1036, #1042 and #1048 each shipped with "3 pre-existing
# failures, unrelated to this diff" in the body; the failures were #1086 and
# they stopped a gate run a week later.
#
# This script ONLY prints the payload. `--print` is its only mode: it never
# calls `gh api -X PUT`, never touches the network, and never mutates the
# repository. The owner applies the payload by hand in #1109 (G-1). Keeping
# application out of an agent's reach is deliberate — a wrong ruleset blocks
# every merge to `main` and can only be undone by a human with admin rights.
#
# Field-by-field rationale: docs/internal/graph-2026-09-guard/ruleset.md
#
# Usage:
#   scripts/ruleset-main.sh --print          # emit the PUT body on stdout
#   scripts/ruleset-main.sh --help
#
# Applying the payload is the owner's manual step, documented in
# docs/internal/graph-2026-09-guard/ruleset.md. The apply command is kept out of
# this file on purpose so that nothing here can be copy-pasted into a mutation.
#
# Exit codes:
#   0 - payload printed
#   2 - usage error

set -euo pipefail

# The check-run context the ruleset requires. `ci.yml`'s `test` job is the one
# that runs `npm test`; it deliberately carries NO matrix, because a
# single-entry matrix would name the context `test (22.x)` and bumping
# `node-version` would silently stop matching a required context — which, under
# `strict_required_status_checks_policy`, blocks every merge to `main` until a
# human edits the ruleset back.
REQUIRED_CHECK_CONTEXT="test"

usage() {
  cat <<'USAGE'
Usage: scripts/ruleset-main.sh --print

Prints the GitHub ruleset PUT body for the `main` branch ruleset (`CC`,
id 12393605) on stdout. This script never applies the ruleset — the owner
applies it by hand (#1109).

Options:
  --print   Emit the payload as JSON on stdout.
  --help    Show this message.
USAGE
}

print_payload() {
  cat <<PAYLOAD
{
  "name": "CC",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    {
      "type": "deletion"
    },
    {
      "type": "non_fast_forward"
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": true,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          {
            "context": "${REQUIRED_CHECK_CONTEXT}"
          }
        ]
      }
    }
  ]
}
PAYLOAD
}

main() {
  if [ "$#" -ne 1 ]; then
    usage >&2
    exit 2
  fi

  case "$1" in
    --print)
      print_payload
      ;;
    --help | -h)
      usage
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
