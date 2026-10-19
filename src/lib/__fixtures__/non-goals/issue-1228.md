**Tier:** judgment   **Graph:** tracker #1236 (label graph-2026-09-prerelease)

_Moved from admarble/varius#65 — `pre-tool.sh` is sequant-managed, so the fix has to land here. Still present at `a12c441d` (`hooks/pre-tool.sh:834`, same line in `templates/hooks/` and `.claude/hooks/`)._

## What

`.claude/hooks/pre-tool.sh`'s `git reset --hard` guard (~line 525) blocked this command:

```bash
cd "$WT" && git reset --hard origin/feature/42-... && git merge origin/master
```

with:

```
HOOK_BLOCKED: git reset --hard would lose local work:
  - 16 uncommitted file(s)
```

The target worktree was **completely clean** — `git status --short` in it printed nothing.

## Root cause

The guard runs `git status --porcelain` with no `-C`, so it evaluates **the hook's own cwd** (the main checkout), not the directory the command targets. `PreToolUse` runs *outside and before* the command's shell, so the `cd "$WT"` prefix has not happened yet — a fact `fullsolve/SKILL.md` already documents in its Phase 0.3 note ("PreToolUse runs *outside and before* your command's shell, so nothing a skill bash block exports is visible to it"). The guard just doesn't account for it.

Proof: the main checkout has exactly 16 dirty files, matching the block message digit for digit:

```
$ git status --porcelain | wc -l
16
```

## Why it matters here specifically

Those 16 files are `sequant`'s own drift artifacts — modified `.claude/skills/*/SKILL.md`, `.sequant-manifest.json`, untracked `.sequant/` and `.claude/.local/`. They are **permanently** present in this checkout. So the guard currently blocks *every* `cd <worktree> && git reset --hard` in this repo, unconditionally, regardless of the worktree's real state. The safety check is inverted from its intent: it fires hardest in exactly the isolated worktrees that are safest to reset.

Compounding cost (hit live during #42): with `reset --hard` blocked *and* force-push blocked, a routine post-rebase push had no in-session path at all — it had to be handed to the human to run manually.

## Fix sketch

Resolve the target directory from the command's own `cd`/`git -C` prefix and run the status check there:

```bash
TARGET_DIR=$(extract_cd_or_dashC_target "$COMMAND")   # fallback: $PWD
UNCOMMITTED=$(git -C "${TARGET_DIR:-.}" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
```

Check 1 (unpushed commits) and Check 3 (`MERGE_HEAD`) have the same defect — both resolve against the hook's cwd — so all three want the same treatment.

## Non-goals

- Relaxing the guard. Blocking a genuinely destructive `reset --hard` is correct; this is about evaluating the *right* repository.

Found during admarble/varius#42 (PR admarble/varius#63).




- **Fix pattern already in the file.** `resolve_cd_target` (used by the commit guard since 2026-09-20, `pre-tool.sh:575`) resolves `cd`/segment-start `cd` targets. Reuse it, plus a `git -C <dir>` extraction, for all three reset-hard checks, with fallback to the hook cwd.


## Probe (2026-09-30, `main` @ `9da8aeb8`, `hooks/pre-tool.sh` driven with a real payload)

| Command | Hook cwd | Today | Correct |
|---|---|---|---|
| `git reset --hard` | dirty repo | BLOCKED | BLOCKED |
| `git -C <dirty> reset --hard` | clean repo | **allowed** | BLOCKED |
| `cd <clean> && git reset --hard` | dirty repo | **BLOCKED** (this report) | allowed |
| `cd <dirty> && git reset --hard` | clean repo | **allowed** | BLOCKED |

The false allows are the more serious half. `git -C <dir> reset --hard` never matches the trigger (`seg_match 'git reset.*(--hard|origin)'` requires `git reset` to be adjacent), and a `cd <dirty>` prefix is evaluated against the clean hook cwd. So the fix must **widen the trigger** to accept `git -C <dir> reset`, as well as resolve the target directory. That's why the tier is judgment.

## Acceptance Criteria

- [ ] AC-1: `cd <clean-worktree> && git reset --hard origin/x` is allowed while the hook cwd (the main checkout) is dirty. Evidence: `npx vitest run __tests__/pre-tool-hook.integration.test.ts`, using a sandbox main checkout plus a linked worktree; mutation-verified by reverting Check 2 to a cwd-relative `git status`
- [ ] AC-2: `cd <dirty-worktree> && git reset --hard` and `git -C <dirty-worktree> reset --hard` are both blocked, including when the hook cwd is clean. Evidence: `npx vitest run __tests__/pre-tool-hook.integration.test.ts`
- [ ] AC-3: A bare `git reset --hard` in a dirty cwd is still blocked, and every existing golden-corpus verdict is unchanged. Evidence: `npx vitest run __tests__/hook-corpus.integration.test.ts`
- [ ] AC-4: Check 1 (unpushed commits), Check 3 (`MERGE_HEAD`) and the remediation text's branch name all evaluate the same resolved target directory. Evidence: `npx vitest run __tests__/pre-tool-hook.integration.test.ts`, covering a worktree mid-merge reached with a `cd <wt>` prefix (BLOCKED) and a main checkout mid-merge with a `cd <clean-wt>` prefix (allowed)

## Non-Goals

- Relaxing the guard. Blocking a genuinely destructive reset is correct; this is about evaluating the right repository.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_FAKE1228

## May touch

- `hooks/pre-tool.sh`, `.claude/hooks/pre-tool.sh`, `templates/hooks/pre-tool.sh` (keep all three byte-identical)
- `__tests__/pre-tool-hook.integration.test.ts`
- `__tests__/fixtures/hook-corpus.jsonl` (add entries only; don't change existing verdicts)

**File overlap:** none with the other #1236 nodes.

