#!/usr/bin/env bash
#
# Settle a red test against the base commit, in this worktree (#1093).
#
# An agent's "pre-existing failure, unrelated to this diff" claim is
# unverifiable unless the same test's result at the base commit is attached
# alongside it. Three PRs on 2026-09-10/11 (#1036, #1042, #1048) each carried
# that sentence for the same three tests; nobody filed an issue, and the
# failures (#1086) stopped a gate run a week later. This script turns the claim
# into a mechanical artifact: it runs the named test at HEAD and at the base
# commit and prints both results as a block for the PR body.
#
# It commits nothing. It restores HEAD and any uncommitted work on every exit
# path, including SIGINT and SIGTERM.
#
# Usage:
#   scripts/settle-against-base.sh <test-file> [-t <test-name>]
#   scripts/settle-against-base.sh --help
#
# Environment:
#   SETTLE_BASE_REF   Base ref to settle against. Default: origin/main.
#   SETTLE_TEST_CMD   Test runner. Default: "npx vitest run". The runner is
#                     invoked as: $SETTLE_TEST_CMD <test-file> [-t <name>]
#
# Exit codes:
#   0 - both runs completed and the block was printed (whatever the results)
#   2 - usage error
#   3 - preflight refused (not a git repo / detached HEAD / merge or rebase in
#       progress / base ref unknown)
#   4 - the worktree could not be restored; work is preserved in a named stash

set -uo pipefail

BASE_REF="${SETTLE_BASE_REF:-origin/main}"
TEST_CMD="${SETTLE_TEST_CMD:-npx vitest run}"

TEST_FILE=""
TEST_NAME=""

usage() {
  cat <<'USAGE'
Usage: scripts/settle-against-base.sh <test-file> [-t <test-name>]

Runs <test-file> at HEAD and again at the base commit (default origin/main),
then prints a "### Settled against base" block for the PR body.

Commits nothing. Restores HEAD and any uncommitted work on every exit path.

Options:
  -t <test-name>   Pass through to the runner to select a single test.
  --help           Show this message.

Environment:
  SETTLE_BASE_REF  Base ref to settle against (default: origin/main).
  SETTLE_TEST_CMD  Test runner (default: "npx vitest run").
USAGE
}

die() {
  echo "settle-against-base: $1" >&2
  exit "${2:-1}"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help | -h)
        usage
        exit 0
        ;;
      -t)
        [ "$#" -ge 2 ] || {
          usage >&2
          die "-t requires a test name" 2
        }
        TEST_NAME="$2"
        shift 2
        ;;
      -*)
        usage >&2
        die "unknown option '$1'" 2
        ;;
      *)
        [ -z "$TEST_FILE" ] || {
          usage >&2
          die "only one test file may be given" 2
        }
        TEST_FILE="$1"
        shift
        ;;
    esac
  done

  [ -n "$TEST_FILE" ] || {
    usage >&2
    die "a test file is required" 2
  }
}

# Refuse rather than guess. Detaching from an already-detached HEAD, or in the
# middle of a rebase, is how a restore step loses the commit it was standing on.
preflight() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    die "not inside a git worktree" 3

  local git_dir
  git_dir="$(git rev-parse --git-dir)"

  if ! ORIGINAL_BRANCH="$(git symbolic-ref --quiet --short HEAD)"; then
    die "HEAD is detached; refusing to run (check out a branch first)" 3
  fi

  if [ -d "$git_dir/rebase-merge" ] || [ -d "$git_dir/rebase-apply" ]; then
    die "a rebase is in progress; refusing to run" 3
  fi
  if [ -f "$git_dir/MERGE_HEAD" ]; then
    die "a merge is in progress; refusing to run" 3
  fi

  BASE_SHA="$(git rev-parse --verify --quiet "${BASE_REF}^{commit}")" ||
    die "base ref '${BASE_REF}' does not resolve to a commit" 3
}

# Run the test with every SEQUANT_* variable unset.
#
# The suite is not hermetic against the orchestrator's environment (#1086), and
# a base-vs-head comparison run under two different environments proves nothing
# about the diff. Both runs go through here, so both see the same environment.
run_test() {
  local -a unset_flags=()
  local var
  while IFS= read -r var; do
    [ -n "$var" ] && unset_flags+=("-u" "$var")
  done < <(printenv | grep -o '^SEQUANT_[A-Z_]*' || true)

  local -a cmd=()
  # shellcheck disable=SC2206 # deliberate word-split: SETTLE_TEST_CMD is a command line
  cmd=($TEST_CMD "$TEST_FILE")
  [ -n "$TEST_NAME" ] && cmd+=("-t" "$TEST_NAME")

  # `${arr[@]+"${arr[@]}"}` not `"${arr[@]}"`: under `set -u`, bash 3.2 — which
  # is what stock macOS ships — treats an empty array expansion as an unbound
  # variable. `unset_flags` is empty whenever no SEQUANT_* vars are set, which
  # is the normal case outside an orchestrated run.
  env ${unset_flags[@]+"${unset_flags[@]}"} "${cmd[@]}" 2>&1
}

# Restore the branch and any stashed work. Idempotent: safe to call from the
# trap after it has already run on the happy path.
restore() {
  local status=$?
  trap - EXIT INT TERM

  if [ "${DETACHED:-0}" = "1" ]; then
    if git checkout --quiet "$ORIGINAL_BRANCH" 2>/dev/null; then
      DETACHED=0
    else
      echo "settle-against-base: FAILED to return to '$ORIGINAL_BRANCH'" >&2
      status=4
    fi
  fi

  if [ -n "${STASH_TAG:-}" ]; then
    # Re-find the entry by tag: the stash stack is shared with every other
    # worktree and session, so a positional stash@{0} may not be ours.
    local entry
    entry="$(git stash list --format='%gd %gs' | grep -F -- "$STASH_TAG" | head -1 | cut -d' ' -f1)"
    if [ -n "$entry" ]; then
      # apply + drop, never pop: a failed pop drops nothing, but a pop that
      # half-applies is indistinguishable from one that did not run.
      if git stash apply --quiet --index "$entry" 2>/dev/null ||
        git stash apply --quiet "$entry" 2>/dev/null; then
        entry="$(git stash list --format='%gd %gs' | grep -F -- "$STASH_TAG" | head -1 | cut -d' ' -f1)"
        [ -n "$entry" ] && git stash drop --quiet "$entry" >/dev/null 2>&1
        STASH_TAG=""
      else
        echo "settle-against-base: FAILED to restore uncommitted work." >&2
        echo "  It is preserved in the stash entry tagged: $STASH_TAG" >&2
        echo "  Recover with: git stash list | grep '$STASH_TAG'" >&2
        status=4
      fi
    else
      # Nothing was stashed (clean tree at start), or it was already applied.
      STASH_TAG=""
    fi
  fi

  exit "$status"
}

result_label() {
  case "$1" in
    0) echo "PASS" ;;
    *) echo "FAIL (exit $1)" ;;
  esac
}

main() {
  parse_args "$@"
  preflight

  STASH_TAG="settle-against-base-$$-$(date +%s)"
  DETACHED=0
  trap restore EXIT INT TERM

  local head_sha
  head_sha="$(git rev-parse --short HEAD)"

  # HEAD first, with the working tree exactly as the caller left it — that is
  # the state whose red test is being explained.
  local head_output head_status
  head_output="$(run_test)"
  head_status=$?

  # `--include-untracked` matters: a brand-new test file is untracked in the
  # common case, and checking out the base commit with it in place would either
  # leave it behind (contaminating the base run) or refuse the checkout.
  if [ -n "$(git status --porcelain)" ]; then
    git stash push --quiet --include-untracked -m "$STASH_TAG" ||
      die "could not stash uncommitted work; refusing to detach" 3
  else
    STASH_TAG=""
  fi

  git checkout --quiet --detach "$BASE_SHA" ||
    die "could not check out base '${BASE_REF}'" 3
  DETACHED=1

  # D1: a test file that does not exist at base is NOT evidence of a
  # pre-existing failure — it is a brand-new test. Reporting the runner's
  # "no test files found" error as a base failure would fake the exact claim
  # this script exists to make unfakeable.
  local base_output base_status base_label
  if [ ! -e "$TEST_FILE" ]; then
    base_output="(test file does not exist at ${BASE_REF})"
    base_status=-1
    base_label="ABSENT AT BASE"
  else
    base_output="$(run_test)"
    base_status=$?
    base_label="$(result_label "$base_status")"
  fi

  local head_label
  head_label="$(result_label "$head_status")"

  local verdict
  if [ "$base_status" = "-1" ]; then
    verdict="Not pre-existing — the test file does not exist at ${BASE_REF}. It is new in this diff, so its result at HEAD is this diff's responsibility."
  elif [ "$head_status" -ne 0 ] && [ "$base_status" -ne 0 ]; then
    verdict="Pre-existing — the test is red at ${BASE_REF} too. File or link an issue for it; do not describe it as \"unrelated\" without that issue number."
  elif [ "$head_status" -ne 0 ] && [ "$base_status" -eq 0 ]; then
    verdict="Introduced by this diff — green at ${BASE_REF}, red at HEAD. Not pre-existing. Fix it before opening the PR."
  elif [ "$head_status" -eq 0 ] && [ "$base_status" -ne 0 ]; then
    verdict="Fixed by this diff — red at ${BASE_REF}, green at HEAD."
  else
    verdict="Green at both ${BASE_REF} and HEAD. Nothing to settle."
  fi

  cat <<BLOCK

### Settled against base

| | Ref | Result |
|---|---|---|
| Head | \`${ORIGINAL_BRANCH}\` @ \`${head_sha}\` | ${head_label} |
| Base | \`${BASE_REF}\` @ \`$(git rev-parse --short "$BASE_SHA")\` | ${base_label} |

**Test:** \`${TEST_FILE}\`${TEST_NAME:+ \`-t ${TEST_NAME}\`}
**Verdict:** ${verdict}

<details><summary>Head output</summary>

\`\`\`
${head_output}
\`\`\`

</details>

<details><summary>Base output</summary>

\`\`\`
${base_output}
\`\`\`

</details>
BLOCK
}

main "$@"
