# Force-push handoff pattern

When you encounter `HOOK_BLOCKED: Force push` from `.claude/hooks/pre-tool.sh:106-111`, **do not attempt to bypass the hook**. The block is intentional — force-pushing rewrites history and can destroy work for others sharing the branch.

## The pattern: hand the command to the user

When a force push is genuinely required (e.g., cleaning contamination off a feature branch after a clean rebase), present the exact command to the user prefixed with `!` so they execute it in-session:

```
! git push --force-with-lease origin feature/<branch>
```

The user pastes that into the prompt; the `!` runs it in their shell, output streams back into the conversation, and you continue from there.

**Always prefer `--force-with-lease` over raw `--force`.** `--force-with-lease` refuses to overwrite the remote ref if someone else pushed in the meantime, turning a silent stomp into a clean error.

## Why bypass attempts fail

`CLAUDE_HOOKS_DISABLED=true git push --force ...` does **not** work. The hook reads `CLAUDE_HOOKS_DISABLED` at the harness level *before* Bash executes the command, so prefixing the env var inside the command line has no effect. Setting it via `export` in a prior tool call doesn't help either — each Bash tool call is a fresh subprocess.

## When force push is legitimate vs. not

| Legitimate | Not legitimate |
|------------|----------------|
| Cleaning rebase contamination off your own feature branch before PR | Rewriting history on `main`/`master` |
| Removing accidentally-committed secrets after rotation | "Squashing for cleanliness" on a shared branch |
| Recovering from a mistakenly-pushed merge commit | Force-pushing over someone else's work |

For shared branches, prefer `git revert` over force push.

## Reference

- Block definition: `.claude/hooks/pre-tool.sh:106-111`
- Regex: `git push.*(--force| -f($| ))` — note this can also match the literal strings inside quoted `gh issue/pr` bodies (workaround: write the body to a file first)
