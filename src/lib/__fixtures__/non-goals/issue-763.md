> ### ⚠️ STATUS: unblocked — AC-5 is ANSWERED. Read [the AC-5 comment](https://github.com/sequant-io/sequant/issues/763#issuecomment-4982136950) before implementing
>
> **The blocker is resolved. Nothing here is parked.** Superseding the previous banner:
>
> - **`bypassPermissions` does NOT skip Claude Code's native `rm` analyzer — it still fires.** [VERIFIED] against the v2.1.210 bundle (the exemption is deliberately coded: the dangerous-rm ask returns *before* the bypass allow) and confirmed by [the official docs](https://code.claude.com/docs/en/permission-modes.md). The `"cannot be auto-allowed by permission rules"` string that framed this question was a **red herring** — it describes *rules*; the bypass exemption is separate.
> - **Therefore the `rm` guard is deleted, not narrowed.** Native coverage (root, top-level dirs, home, workspace-ancestors, `$UNSET/*`) is *exactly* what `:108` blocks — pure redundancy, carrying the file's worst FP tax (`rm -rf /` substring-matches **every absolute path**, blocking worktree teardown). Deleting loses nothing that exists today.
> - **This unblocks the rest rather than blocking it.** The old AC-2/AC-3 `rm` rows pulled in opposite directions (one wanted `gh issue list && rm -rf /` blocked, the other wanted `--body "...rm -rf /..."` allowed). With the `rm` half gone, the first row drops and the second is satisfied trivially. **No `rm` anchoring needed.**
> - **The "Proposed fix (directional)" section below — argv-level parsing in bash — still should NOT be built.** The native analyzer does this properly, with a real AST and workspace context a hook cannot see.
> - **Still valid and shipping:** carve-out removal (all 10 sites — **five were never probed**, four of which gate `git commit`), command-logging, and an anchored `sudo` guard (`sudo` is *not* natively covered).
>
> Everything below this banner remains an accurate description of the *bug*; only the prescription changed. **See the Revised Acceptance Criteria (v2) at the bottom** — they replace all earlier lists.

## Summary

Every guard in `pre-tool.sh` wrapped with the `! grep -qE '^gh (issue|pr) ' &&` idiom (added by #564, extended by #570) can be **disarmed by prefixing the command with any real `gh issue` / `gh pr` invocation**. The skip tests the command's *prefix*, not its *content*, so a compound command that merely starts with `gh issue ` bypasses the check entirely — including the force-push guard.

Verified against the real hook (`cat payload.json | bash hooks/pre-tool.sh`; exit 0 = allowed, exit 2 = blocked). **All five wrapped guards bypass:**

| Guard | Payload | Result |
|---|---|---|
| Destructive | `gh issue list && rm -rf /` | **allowed** |
| Force push | `gh issue list && git push --force` | **allowed** |
| Deployment | `gh issue list && vercel deploy --prod` | **allowed** |
| git reset | `gh issue list && git reset --hard origin/main` | **allowed** |
| gh workflow | `gh issue list && gh workflow run release.yml` | **allowed** |

Controls (identical payloads, no `gh` prefix) all block correctly, confirming the skip is the cause.

The force-push row is the one that matters most in practice: force-push protection is a documented, load-bearing guarantee of this repo (`CLAUDE.md` → `.claude/skills/_shared/references/force-push.md`), and `gh issue list && git push --force` walks straight through it.

## Root cause

`templates/hooks/pre-tool.sh:108` (and the four sibling sites):

```bash
if ! echo "$TOOL_INPUT" | grep -qE '^gh (issue|pr) ' && echo "$TOOL_INPUT" | grep -qE 'sudo|rm -rf /|rm -rf ~|rm -rf \$HOME'; then
```

`$TOOL_INPUT` is the **whole bash command string**. The guard layer string-matches that string instead of parsing it, so it cannot distinguish three different things that all "contain" the same bytes:

1. a real destructive invocation (`rm -rf /`) — should block
2. that text as an *argument* to another program (`gh issue create --body "never run rm -rf /"`) — should allow
3. a real destructive invocation *chained after* an allowed command (`gh issue list && rm -rf /`) — should block

#564/#570 fixed (2) by adding a prefix skip, which necessarily also allows (3). Both patches treated the symptom; the root cause — string-matching a shell command rather than parsing it — is unchanged, and each fix has enlarged the hole.

## Why the existing regression tests miss it

`__tests__/pre-tool-hook.integration.test.ts:276-300` has regression tests for exactly this concern, but they use a prefix that **cannot trigger the skip**:

```js
// "START-anchor regression: a non-anchored mention of 'gh issue' must not
//  bypass any of the four wrapped checks."
it("#570 regression destructive: `echo gh issue && sudo rm -rf /tmp/x` is still blocked", ...)
```

`echo gh issue && ...` does not match `^gh (issue|pr) `, so the skip never fires and the test passes for the wrong reason. Every regression test in that block covers the **safe** direction (non-anchored mention). The **anchored** case — a real `gh issue`/`gh pr` command chained with a destructive payload — is untested across all five guards.

## The `^` anchor also breaks the fix it was meant to be

The skip only fires when `gh issue`/`gh pr` is the **literal first token** of the tool input. Any prefix defeats it — and `cd <dir> && gh issue ...` / `cd <dir>\ngh issue ...` is an everyday shape.

Encountered live while filing this very issue: `cd /Users/user/Projects/sequant` followed by `gh issue create --title '...git push --force...'` was **blocked as a force push**. The command creates an issue; it pushes nothing. Filing it required dropping the `cd`.

So the same anchor produces both failure directions:

- **too permissive** when a real `gh` command comes first → bypass (all five guards, table above)
- **too strict** when the `gh` command isn't literally first → the #564/#570 false positive returns

Any fix that keeps prefix-matching will keep trading one of these for the other. This is the strongest argument for argv-level parsing over another regex patch.

## Secondary finding: the destructive regex also fails in both directions

Separable from the bypass, but in the same expression and fixed by the same rewrite:

**False positives** — `rm -rf /` substring-matches every absolute path, so ordinary deletes are blocked:

| Command | Result |
|---|---|
| `rm -rf /Users/user/Projects/worktrees/feature/38-cell-protocol` | blocked |
| `rm -rf /tmp/scratch/build` | blocked |
| `rm -rf ~/Library/Caches/my-app` | blocked |

This fires constantly in real work. It blocks any absolute-path cleanup, and it even blocks *shell scripts that merely contain the string* (a test script feeding these literals to `grep` was blocked, despite executing no `rm` at all). The practical harm is that it trains agents to route around the guard rather than respect it.

**False negatives** — the guard misses trivial variants of the catastrophe it exists to prevent:

| Command | Result |
|---|---|
| `rm -rf /` | blocked |
| `rm -fr /` | **allowed** |
| `rm  -rf  /` (double space) | **allowed** |
| `rm --recursive --force /` | **allowed** |
| `rm -rf "/"` | **allowed** |

A flag-order typo — precisely the accident class this guard exists for — sails through.

## Severity framing

This is an **accident-prevention guard, not a security boundary**: Claude Code's permission system is the real boundary, and an agent is not an adversary crafting bypasses. So the bypass is not "an attacker can delete your disk." It matters because:

- the guard is **advertised as reliable** and is relied on (force-push especially), and a guard trusted more than it deserves is worse than a guard known to be partial;
- the false negatives are **reachable by accident** (`rm -fr` is a common typo; agents chain commands with `&&` constantly, and `gh issue list && ...` is an utterly ordinary sequant idiom);
- the false positives **actively erode** the guard by teaching agents that blocks are noise to work around.

## Proposed fix (directional)

Replace substring matching with **segment-aware, argv-level checks**. Hooks stay bash (latency/portability — see `project_layer_boundaries`), so roughly:

1. Split `$TOOL_INPUT` into segments on shell operators (`;`, `&&`, `||`, `|`, newline), respecting quotes.
2. For each segment, extract `argv[0]` (skipping leading env assignments), and evaluate guards **only against segments whose `argv[0]` is the command in question**.
3. For `rm`: detect recursive **and** force flags in any form (`-rf`, `-fr`, `-r -f`, bundled `-rvf`, `--recursive --force`), then inspect the non-flag **operands**.

This dissolves the whole class:

- **(2) is fixed for free** — body text is an *argument to `gh`*, never `argv[0]` of a segment. **The `^gh (issue|pr) ` skip can then be deleted outright**, and with it the bypass in all five guards. #564 and #570 both become unnecessary rather than re-patched.
- **(3) is fixed** — the `rm` segment is evaluated on its own merits regardless of what preceded it.
- **False positives/negatives are fixed** — flags are parsed, not pattern-matched, and the decision keys off the *target operand* rather than the presence of a `/` byte.

Risk to weigh: quote-aware splitting in bash is non-trivial (~40 lines), and this is a guard — a subtle bug here fails open. Mitigation: the existing `__tests__/pre-tool-hook.integration.test.ts` harness already drives the real hook end-to-end, so every row in every table above is directly expressible as a test case. **Suggest writing the table rows as failing tests first** — they encode both directions, which is what the current suite lacks.

## ~~Open question~~ → ANSWERED (mostly moot); replaced by a different blocker

> **Resolved by research:** Claude Code v2.1.210 already answers this natively — it blocks critical system dirs, workspace dirs *and their ancestors*, and `rm -rf $UNSET/*`, using a real bash AST, failing closed. A hook block-list is a worse copy of a shipped feature, and cannot see the workspace context the native analyzer uses. **Do not build the parser; do not derive the block-list below.**
>
> **The blocker that replaces it:** does `bypassPermissions` — the mode sequant spawns its agents in — skip the native analyzer? If yes, a *narrow* hook guard has real value (it would be the only protection sequant's agents have). If no, the `rm` guard is redundant and should be deleted. Unresolved; see AC-5. Also relevant: hooks ship to users via the marketplace plugin on Claude Code versions we don't control.
>
> Original question retained below for history.

**What should the `rm` guard actually block?** The intent is catastrophic deletes, but the boundary is a judgment call:

- Definitely block: target resolves to `/`, `~`, `$HOME`, `/*`
- Definitely allow: deep paths under a project/scratch dir (`/tmp/x/build`, a worktree path)
- **Undecided**: first-level system dirs (`/usr`, `/etc`, `/var`, `/System`) — block? And is `rm -rf ~/Library/Caches/foo` allowed (it is a legitimate, common delete) while `rm -rf ~` is blocked?

My recommendation: block `/`, `/*`, `~`, `$HOME` **exactly**, plus first-level system dirs; allow anything deeper. That keeps the guard aimed at unrecoverable mistakes and stops it from moonlighting as a general delete-blocker. Flagging rather than assuming, since the last two patches here each guessed and each added a hole.

## Scope / mirrors

`pre-tool.sh` exists as **three real (non-symlinked), byte-identical copies** — all three need the fix, or `sequant init`/`update` regenerates the bug:

- `templates/hooks/pre-tool.sh` (canonical)
- `hooks/pre-tool.sh`
- `.claude/hooks/pre-tool.sh`

(`dist/marketplace/external_plugins/sequant/hooks/pre-tool.sh` is a build artifact — rebuilt, not edited.)

## Not a regression

The `rm` false positives/negatives are original latent defects — the pattern has been substring-based since introduction. The **anchored bypass is a regression introduced by #564 (`^gh (issue|pr) ` skip on force-push/git-commit) and widened by #570** (same idiom applied to four more guards). Neither issue's tests covered the anchored direction.

## Revised Acceptance Criteria (v2)

> **Supersedes all earlier lists.** Rationale + evidence in [the AC-5 comment](https://github.com/sequant-io/sequant/issues/763#issuecomment-4982136950). AC-5 is answered, so nothing is blocked; the former AC-6 is now AC-1 and is the *enabler*.

- [ ] **AC-1:** Delete the `rm` alternation (`rm -rf /|rm -rf ~|rm -rf \$HOME`) from `:108` entirely. Redundant with Claude Code's native analyzer, which **[VERIFIED]** still fires under `bypassPermissions` and already covers root / top-level dirs / home / workspace-ancestors / unresolvable targets. *Do this first — AC-3 and AC-4's `rm` rows resolve for free.*
- [ ] **AC-2:** `:108` becomes a standalone `sudo` guard with its own distinct `HOOK_BLOCKED` message, matching **only at a command-word position**. Test cases: `echo 'never use sudo here'`, `git commit -m "docs: sudo policy"`, and `grep -r sudoku src/` are **allowed**; `sudo rm -rf /var/lib` **blocks**. (A plausible-looking anchor was *run* during research and still blocked the `echo` case — this needs tests, not eyeballing.)
- [ ] **AC-3:** All 10 `^gh (issue|pr) ` carve-outs removed — **including the five the original table never probed** (`:87`, `:234`, `:267`, `:295`, `:307`). No guard bypassable by prefixing a real `gh issue`/`gh pr` command. One test per blocking guard: `gh issue list && <payload>` **blocks** (`git push --force`, `vercel deploy --prod`, `git reset --hard origin/main`, `gh workflow run`, `sudo …`). `:295` is warn-only — assert no exit 2 regression rather than a block.
- [ ] **AC-4:** The #564/#570 false positives stay fixed **without** the carve-out: `gh issue create --body "...git push --force..."` **and** `cd <dir> && gh issue create --title "...git push --force..."` are both **allowed**. (The second fails today — the `cd`-prefix bug that blocked the filing of this issue *and* its assessment.)
- [ ] **AC-5:** `pre-tool.sh` logs the **offending command text + the specific rule that fired** for every `HOOK_BLOCKED` category (16 `tee -a "$HOOK_LOG"` sites: `:90, :95, :102, :109, :116, :124, :168, :176, :243, :254, :284, :345, :380, :409, :440, :448`). Must include: **(a)** redaction via the existing `check_secrets` (`:188-205`) — `$TOOL_INPUT` carries tokens; **(b)** rotation on the `TIMING_LOG` pattern (`:73-78`) — entries now carry full commands and `HOOK_LOG` has none; **(c)** a single non-purged sink — `:38-47` today bifurcates between `$CLAUDE_PLUGIN_DATA/logs` and `$TMPDIR`, which macOS purges. Suggest `$CLAUDE_PLUGIN_DATA/logs/` with a repo-local `.sequant/logs/` fallback.
- [ ] **AC-6:** The miscalibrated tests at `__tests__/pre-tool-hook.integration.test.ts:276-300` are corrected to exercise the **anchored** prefix (`gh issue list && …`). Today they use `echo gh issue && …`, which **cannot** match `^gh (issue|pr) ` — the skip never fires and they pass for the wrong reason. Non-anchored cases retained. The `describe.each(HOOK_COPIES)` harness (`:65`, list `:22-32`) already parametrizes over all three copies, so each case is ~6 lines. **Budget for churn:** splitting `:108`'s shared message breaks the existing test at `:279`, which asserts `/HOOK_BLOCKED: Destructive system command/` for a `sudo rm` payload.
- [ ] **AC-7:** Regression corpus is **real blocked commands** from AC-5's log where available. Ordering reality: the log has no history yet, so the first PR necessarily ships table-derived cases — acceptable *because each was reproduced against the real hook*, unlike the synthetic fixtures that produced the 0-FP illusion. Backfill from real data once the log accumulates.
- [ ] **AC-8:** All three tracked `pre-tool.sh` copies updated and verified byte-identical — `templates/hooks/`, `hooks/`, `.claude/hooks/` (currently md5 `d0dcff9d8ba8056ef5ac8cd2bcf7858d`). `dist/marketplace/...` is a gitignored build artifact — regenerate via `npm run prepare:marketplace`, don't edit.
- [ ] **AC-9:** Hook latency does not regress materially (runs on every tool call). Deleting the `rm` alternation should *improve* it.
- [ ] **AC-10:** Document a Claude Code **>= 2.1.208** floor in the README. **[VERIFIED] no declarative mechanism exists** — no manifest field in `plugin.json`/`marketplace.json`, unrecognized fields are **silently ignored** (an invented `engines` field would be inert), no install-time gating, no version env var in hooks, and `claude --version` resolves off `PATH` rather than the running binary (a skew this repo has already hit). This is **documentation, not enforcement**: the <2.1.208 command-substitution gap (`echo "$(rm -rf ~)"` uncaught in bypass mode) is **accepted**. If enforcement is wanted, the credible route is a behavior probe, not a version check — file separately.

### Out of scope / follow-ups

- **In-workspace destruction** (`rm -rf` of the worktree, `.git`, project files) is **not** natively covered and is **not** covered today either. A genuine gap, but a new capability — separate issue if wanted.
- **The argv-level bash parser and the ~25-string block-list** stay dead — the native analyzer already does this with a real AST and workspace context.
- **`rm -fr /` false negatives** (the table under "Secondary finding") — **unverified**, and moot for `rm` under AC-1.

### Unresolved

- **Version-floor precision.** The carve-out is verified in 2.1.208/209/210; the *base* circuit breaker predates 2.1.208 and cannot be pinned without older binaries. **Settling probe:** `grep -a -c 'startsWith("Dangerous rm operation")'` across older releases.
- **Source conflict:** docs carry `min-version: 2.1.208` for command-substitution coverage; `CHANGELOG.md` lists the same entry under **2.1.210**. Binary evidence supports the docs — treat **2.1.208** as the floor, changelog as late-published.

