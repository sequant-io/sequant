# Triaging an /upstream sweep

How to turn a `/upstream` run into decisions. The keyword classifier in
`src/lib/upstream/relevance.ts` gets relevance wrong in both directions
(#1345, #1442), so the filed issues are a starting point, not the verdict.
Two sweeps (2026-10-06, 2026-10-13) followed this procedure; #1442 proposes
building it into the run itself. Until then, do it by hand.

## Before you start

1. **Check the bundled CLI version.** Phase agents run the Claude Code bundled
   in the agent SDK, not the user's installed `claude`:

   ```bash
   npm ls @anthropic-ai/claude-agent-sdk   # SDK 0.3.N bundles Claude Code 2.1.N
   ```

   A changelog fix reaches phase runs only after that lockfile moves. If a
   finding affects phase agents, the action is an SDK bump, not a README
   version floor.

2. **Find out why the issue count is what it is.** Compare the open
   `upstream` issues against the closed ones (`gh issue list --label upstream
   --state closed`). If the same releases appear twice, a report PR did not
   merge and the baseline never advanced. Merge the newest report PR first.

3. **Check the plugin freeze** before planning any fix that touches
   `plugin/`, `.claude/skills/` or `templates/skills/`.

## Fan-out

One agent per two or three releases. Each gets this prompt, with the release
range, the assessment issue numbers and the filed finding issues filled in:

> You are triaging Claude Code upstream changelog entries for Sequant
> (CLI + Claude Code plugin; spawns `claude -p`-style phase agents through
> the agent SDK with `bypassPermissions`; ships skills into `.claude/skills/`,
> `templates/skills/`, `plugin/skills/`; ships hooks `templates/hooks/pre-tool.sh`,
> `post-tool.sh`, `plugin/hooks/hooks.json`; an MCP server; worktree
> isolation). READ-ONLY: do not edit files or touch issues.
>
> Scope: releases vA–vB. Sources: assessment issues #… and filed findings #….
> Also fetch the authoritative changelog
> (`gh release view vX -R anthropics/claude-code`) so you see EVERY line.
>
> The classifier is wrong in both directions, so triage every line yourself.
> Grep candidates for: hooks (PreToolUse/PostToolUse/SessionStart/Stop,
> permission decisions, `onFailure`, exit codes), `-p`/headless, bypassPermissions
> / auto mode / permission rules, subagents / Agent tool / model routing and
> aliases, skills (loading; names Sequant ships: verify, qa, exec, spec…),
> plugins / marketplace / MCP, mods, worktrees, background Bash / timeouts,
> env vars, settings precedence, TodoWrite, stream-json output. For each hit,
> check the Sequant code (`src/`, `templates/`, `plugin/`, `.claude/skills/`,
> `README.md`, `docs/`) to see whether Sequant relies on the behaviour.
>
> Report under 500 words: a table of items WORTH PURSUING (line; why it
> matters with `file:line` evidence; action: new issue / fold into #N /
> docs-only / SDK bump), a one-line verdict per filed issue (pursue or close,
> with reason), and the near-misses you checked and rejected. Most lines are
> noise; claim impact only with code evidence.

The three 2026-10-13 agents used about 230k tokens for ~380 lines and
returned reports that reconciled with no overlap.

## After the reports

- Verify anything you will change before changing it. A reported delta can be
  incomplete: the 10-13 report said only `haiku` had moved; the probe in
  `docs/reference/run-command.md` showed `sonnet` had too.
- Close each noise issue with the code reason (which file does not use the
  feature). Close assessment issues as completed with a summary of what was
  filed.
- File real items as ordinary issues with ACs. The upstream finding issue is a
  template stub; do not try to fill it in.
- Merge the report PR. Record anything the classifier missed in the memory
  note `upstream-classifier-inverted`, so the next triage prompt covers it.
