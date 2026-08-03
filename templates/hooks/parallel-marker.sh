#!/bin/bash
# Shared naming contract for /exec parallel-group marker files (#881).
#
# One writer (the /exec skill) and two readers (pre-tool.sh, post-tool.sh) must
# agree on (a) the marker filename and (b) how the owning project is identified.
# Before #881 the filename was a global constant, so a parallel group in ONE
# project silently redirected worktree enforcement for EVERY concurrent Claude
# session on the machine — the first matching marker in the shared temp dir won,
# regardless of which project wrote it. Keeping the scheme in this single sourced
# file is what stops the writer and the readers from drifting apart (AC-4).
#
# Marker filename: ${TMPDIR}/claude-parallel-<project-hash>-<group-id>.marker
# Marker contents: line 1 = worktree path, line 2 = owning project root.

# parallel_marker_project_root — the canonical identity of the current project,
# derived identically in skill-context and hook-context. CLAUDE_PROJECT_DIR is
# set by Claude Code for both the skill's shell and the hook's shell within the
# same session; the git-toplevel fallback resolves to the same worktree when it
# is unset. A mismatch here would silently re-introduce the cross-project
# collision this fix exists to close, so the two contexts MUST agree.
parallel_marker_project_root() {
    if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
        printf '%s' "$CLAUDE_PROJECT_DIR"
    else
        git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD"
    fi
}

# parallel_marker_hash — a stable per-project hash used in the marker filename so
# two projects running parallel groups at once cannot collide (AC-1). Reuses the
# md5-with-md5sum-fallback idiom already used for the per-file lock in
# pre-tool.sh. printf (no trailing newline) keeps writer and reader identical.
parallel_marker_hash() {
    local root
    root="$(parallel_marker_project_root)"
    printf '%s' "$root" | md5 -q 2>/dev/null || printf '%s' "$root" | md5sum | cut -d' ' -f1
}

# parallel_marker_prefix — the ${TMPDIR}-anchored, project-scoped filename prefix
# that both the writer and the readers glob on (AC-2). Honors $TMPDIR (macOS's
# per-user temp) with a /tmp fallback, matching the hooks' own _TMPDIR.
parallel_marker_prefix() {
    local tmp="${TMPDIR:-/tmp}"
    printf '%s/claude-parallel-%s-' "$tmp" "$(parallel_marker_hash)"
}

# parallel_marker_path <group-id> — the full marker path for one group.
parallel_marker_path() {
    printf '%s%s.marker' "$(parallel_marker_prefix)" "$1"
}
