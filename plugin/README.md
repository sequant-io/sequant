# sequant (plugin)

Sequant is an AI coding agent orchestrator for Claude Code. It turns a
GitHub issue into a reviewed, merge-ready pull request by running isolated
`spec` → `exec` → `qa` phases, each as a Claude Code skill, with pre/post-tool
hooks that enforce guardrails and an MCP server that exposes workflow state
to the agent.

This folder is the slim plugin bundle installed from the `sequant@sequant`
marketplace entry (`.claude-plugin/marketplace.json` at the repo root, which
points its `source` at this directory). It ships only what Claude Code loads
at runtime — skills, hooks, the MCP config, the project-constitution
template, and this disclosure file — not the dev-only `node_modules`, `src/`,
or test suites that live at the repo root.

## What it runs, sends, or fetches

- **MCP server.** `.mcp.json` launches `node -e <inline launcher>
  sequant@<version>`, which runs `npx -y sequant@<version> serve` to start
  the workflow MCP server locally. This is the one network fetch the plugin
  makes on its own: pulling the pinned `sequant` package from the npm
  registry. No other host is contacted by the launcher.
- **git and gh.** The hooks (`hooks/pre-tool.sh`, `hooks/post-tool.sh`) and
  the skills under `skills/` run `git` and `gh` (GitHub CLI) commands —
  branch/worktree management, commits, pushes, PR and issue reads/writes —
  using whatever credentials are already configured in your shell. These
  calls reach your configured `origin` remote and the GitHub API via `gh`'s
  own authentication; the plugin does not store or transmit credentials
  itself.
- **Local prettier (on by default, writes to your files).** After an `Edit`
  or `Write` to a `.ts`/`.tsx`/`.js`/`.jsx`/`.json` file, `hooks/post-tool.sh`
  runs that file's own project's `node_modules/.bin/prettier --write` on it,
  if and only if that local binary exists — it never fetches or runs prettier
  via `npx`. A project with no local prettier installed is simply left
  unformatted.
- **Opt-in smart test runs.** When `CLAUDE_HOOKS_SMART_TESTS=true` is set
  (unset by default), `hooks/post-tool.sh` runs `npm test` asynchronously,
  scoped to the test file it matches to the edited source file, after an
  `Edit`/`Write` to a `.ts`/`.tsx` file with a corresponding file under
  `__tests__/`.
- **Opt-in webhook.** `hooks/post-tool.sh` sends a `curl -s -X POST` to
  `$CLAUDE_HOOKS_WEBHOOK_URL` only when that environment variable is set.
  Unset (the default), no webhook call is made.
- **Post-merge worktree cleanup (destructive, automatic).** After a `gh pr
  merge` command succeeds, `hooks/post-tool.sh` looks up the merged branch's
  worktree via `git worktree list` and runs `git worktree remove --force` on
  it, then `git branch -D` on the local branch — deleting that worktree
  directory and local branch ref outright, with no prompt. This can remove a
  directory outside the project you're currently in, if the merged PR's
  worktree lives elsewhere (e.g. `../worktrees/feature/...`).
- **File-locking during parallel edits.** `pre-tool.sh` creates a per-file
  lock file under the OS temp directory (`${TMPDIR:-/tmp}/claude-lock-*.lock`)
  while an `Edit`/`Write` is in flight, to serialize concurrent agents
  touching the same file. Disable with `CLAUDE_HOOKS_FILE_LOCKING=false`.
- **Local files it writes.** `pre-tool.sh` and `post-tool.sh` write session
  logs (quality, timing, coverage, and test-run logs) to
  `${CLAUDE_PLUGIN_DATA}/logs/` when Claude Code sets that variable,
  otherwise to `~/.sequant/logs/`, falling back to a temp directory if
  neither is writable. `capture-tokens.sh` (a `SessionEnd` hook) writes
  `.sequant/.token-usage-<session-id>.json` in the current project. The
  `sequant` CLI/MCP server the launcher starts maintains further `.sequant/`
  state in the current project when running workflow commands. Beyond those
  paths, the project's own git working tree, and the post-merge worktree
  cleanup and temp lock files described above, nothing else is modified.

## Contents

- `skills/` — the `spec`, `exec`, `qa`, and other workflow skills.
- `hooks/` (`hooks.json` + scripts) — pre/post-tool guardrails and logging.
- `.mcp.json` — the MCP server launch config described above.
- `memory/constitution.md` — the project-constitution **template**.
  `/sequant:setup` reads it via `${CLAUDE_PLUGIN_ROOT}/memory/constitution.md`
  (which for a plugin install resolves here) and copies it into a target
  project's `.claude/memory/constitution.md`, substituting the
  `{{PROJECT_NAME}}` placeholder for the detected project name
  (`skills/setup/SKILL.md`, "Copy Constitution Template"). It is a copy of
  `templates/memory/constitution.md`, and — because this repository has never
  filled in its own `{{PROJECT_NAME}}` placeholder either — is currently
  identical to this repository's own `memory/constitution.md`, though the two
  are not the same artifact and can diverge.

See the main repository README at
<https://github.com/sequant-io/sequant> for full documentation, including
install instructions and the `/sequant:setup` command that configures a
target project.

## License

MIT — see `LICENSE`.
