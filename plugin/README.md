# sequant (plugin)

Sequant is an AI coding agent orchestrator for Claude Code. It turns a
GitHub issue into a reviewed, merge-ready pull request by running isolated
`spec` → `exec` → `qa` phases, each as a Claude Code skill, with pre/post-tool
hooks that enforce guardrails and an MCP server that exposes workflow state
to the agent.

This folder is the slim plugin bundle installed from the `sequant@sequant`
marketplace entry (`.claude-plugin/marketplace.json` at the repo root, which
points its `source` at this directory). It ships only what Claude Code loads
at runtime — skills, hooks, the MCP config, this repo's own constitution, and
this disclosure file — not the dev-only `node_modules`, `src/`, or test
suites that live at the repo root.

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
- **Opt-in webhook.** `hooks/post-tool.sh` sends a `curl -s -X POST` to
  `$CLAUDE_HOOKS_WEBHOOK_URL` only when that environment variable is set.
  Unset (the default), no webhook call is made.
- **Local files it writes.** `pre-tool.sh` and `post-tool.sh` write session
  logs (quality, timing, coverage, and test-run logs) to
  `${CLAUDE_PLUGIN_DATA}/logs/` when Claude Code sets that variable,
  otherwise to `~/.sequant/logs/`, falling back to a temp directory if
  neither is writable. `capture-tokens.sh` (a `SessionEnd` hook) writes
  `.sequant/.token-usage-<session-id>.json` in the current project. The
  `sequant` CLI/MCP server the launcher starts maintains further `.sequant/`
  state in the current project when running workflow commands. Nothing
  outside those paths and the project's own git working tree is modified.

## Contents

- `skills/` — the `spec`, `exec`, `qa`, and other workflow skills.
- `hooks/` (`hooks.json` + scripts) — pre/post-tool guardrails and logging.
- `.mcp.json` — the MCP server launch config described above.
- `memory/constitution.md` — this repository's own project constitution,
  used by the skills that read repo-level policy.

See the main repository README at
<https://github.com/sequant-io/sequant> for full documentation, including
install instructions and the `/sequant:setup` command that configures a
target project.

## License

MIT — see `LICENSE`.
