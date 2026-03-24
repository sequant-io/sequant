# MCP Server

Use Sequant from Claude Desktop, Cursor, VS Code, or any MCP-compatible AI tool. Instead of switching to a terminal, tell your AI assistant to run workflows and Sequant handles the orchestration.

## Get Started

### What you need

1. **Node.js 18+** — `node --version`
2. **GitHub CLI installed and authenticated** — `gh auth status` (install: [cli.github.com](https://cli.github.com))
3. **Claude Code authenticated** — either:
   - **Max plan:** run `claude login` (no API key needed)
   - **API access:** set `ANTHROPIC_API_KEY` in your shell environment
4. **A GitHub repo with issues** — Sequant operates on GitHub issue numbers
5. **Sequant initialized** — run `npx sequant init` in your project root
6. **`@modelcontextprotocol/sdk`** — install if not already present: `npm install @modelcontextprotocol/sdk`

> **Note:** The MCP SDK is an optional dependency. All other Sequant commands (`run`, `doctor`, `init`, etc.) work without it. Only `sequant serve` requires the SDK.

### Add the MCP config

Pick your client and add the config. Each client is slightly different.

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

Claude Desktop doesn't run from your project directory, so you must set `cwd`:

```json
{
  "mcpServers": {
    "sequant": {
      "command": "npx",
      "args": ["sequant@latest", "serve"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

Replace `/absolute/path/to/your/project` with your actual project path (e.g., `/Users/you/Projects/my-app`).

If you're using an API key instead of Max plan, add the `env` field:

```json
{
  "mcpServers": {
    "sequant": {
      "command": "npx",
      "args": ["sequant@latest", "serve"],
      "cwd": "/absolute/path/to/your/project",
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

**Cursor** — `.cursor/mcp.json` in your project root:

Cursor runs from the workspace root, so no `cwd` needed:

```json
{
  "mcpServers": {
    "sequant": {
      "command": "npx",
      "args": ["sequant@latest", "serve"]
    }
  }
}
```

**VS Code + Continue** — `~/.continue/config.json`:

```json
{
  "mcpServers": {
    "sequant": {
      "command": "npx",
      "args": ["sequant@latest", "serve"],
      "cwd": "/absolute/path/to/your/project"
    }
  }
}
```

**Restart your client after adding the config.**

### Verify it works

Run `sequant doctor` — look for the MCP Server check:

```
✓ MCP Server        Sequant MCP server can be started (sequant serve)
```

Or test interactively with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector npx sequant serve
```

### Automatic setup

If you'd rather not edit config files, `sequant init` detects installed clients and offers to configure them:

```
$ npx sequant init
...
Detected 2 MCP-compatible client(s):
   • Claude Desktop
   • Cursor
Add Sequant MCP server to detected clients? (Y/n)
```

Note: this currently doesn't set `cwd` for Claude Desktop — you may need to add it manually.

## What You Can Ask

Once set up, talk to your AI assistant naturally:

**Run a full workflow:**
> "Use sequant to spec, implement, and QA issue #42"

**Run a single phase:**
> "Run the sequant spec phase for issue #42"

**Check on progress:**
> "What's the sequant status for issue #42?"

**Review recent runs:**
> "Show me the last 3 sequant run logs"

## What to Expect

### During a run

- **It looks idle.** Your editor won't show progress while the workflow runs. This is normal — phases are executing in the background.
- **It takes time.** A full spec+exec+qa cycle typically takes 10–20 minutes per issue. Don't assume it's stuck.
- **Check progress** by asking for `sequant_status` on the issue. The server stays responsive while a run is in progress — status checks and log queries return immediately.
- **Cancel if needed.** Your MCP client can abort a running `sequant_run` call. The subprocess and its children are cleaned up automatically (SIGTERM, then SIGKILL after 5 seconds if needed).

### After a run

- **Code is in a worktree**, not your working directory. Find it at `../worktrees/feature/<issue-number>-<slug>/`. Your current branch is untouched.
- **A PR is created automatically** after the exec phase completes. Check your GitHub repo.
- **Run QA separately if needed:** "Use sequant to QA issue #42"
- **Merge when ready** through your normal review process.

## MCP vs CLI

| | CLI (`sequant run 42`) | MCP (from your editor) |
|---|---|---|
| **Context** | Separate terminal window | Your AI already has file context |
| **Invocation** | Exact commands and flags | Natural language |
| **Progress** | Real-time phase output | Silent until done (check with `sequant_status` any time) |
| **Best for** | Batch runs, CI, scripting | Single issues while working in the editor |

They use the same engine. MCP is a different door into the same workflow.

## Tools Reference

### `sequant_run`

Execute workflow phases for GitHub issues.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `issues` | `number[]` | Yes | — | GitHub issue numbers |
| `phases` | `string` | No | `spec,exec,qa` | Comma-separated phases |
| `qualityLoop` | `boolean` | No | `false` | Auto-retry on QA failure |
| `agent` | `string` | No | configured default | Agent backend to use |

**Response** (structured JSON):

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"success" \| "failure"` | Overall run result |
| `exitCode` | `number` | Process exit code (omitted on success) |
| `issues` | `RunToolIssueSummary[]` | Per-issue summaries (see below) |
| `summary` | `object` | `{ total, passed, failed, durationSeconds }` |
| `phases` | `string` | Comma-separated phases that ran |
| `rawOutput` | `string` | Tail of stdout (max 2000 chars, truncated to fit 64 KB limit) |
| `error` | `string` | Tail of stderr on failure |

Each item in `issues`:

| Field | Type | Description |
|-------|------|-------------|
| `issueNumber` | `number` | GitHub issue number |
| `status` | `"success" \| "failure" \| "partial"` | Issue result |
| `phases` | `Array<{ phase, status, durationSeconds }>` | Phase-level detail |
| `verdict` | `string` | QA verdict (only present when QA ran) |
| `durationSeconds` | `number` | Total time for this issue |

When the structured run log is unavailable (e.g., process crashed before writing it), a fallback response is returned with an empty `issues` array and the raw output preserved.

### `sequant_status`

Get current workflow state for a tracked issue.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `issue` | `number` | Yes | GitHub issue number |

Returns: status, current phase, phase progress, worktree path, PR number.

### `sequant_logs`

Get structured run logs for recent executions.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `runId` | `string` | No | latest | Specific run ID |
| `limit` | `number` | No | `5` | Number of runs to return |

### Resources

| Resource | URI | Description |
|----------|-----|-------------|
| State | `sequant://state` | All tracked issues, phase progress, AC status |
| Config | `sequant://config` | Project settings and configuration |

## SSE Transport

By default, the MCP server uses stdio (standard for local editors). For HTTP access, use SSE:

```bash
sequant serve --transport sse --port 3100
```

Binds to `127.0.0.1` (localhost only). No authentication — local use only.

| Endpoint | Description |
|----------|-------------|
| `GET /sse` | MCP protocol connection |
| `POST /messages` | Client-to-server messages |
| `GET /health` | Health check (`{"status":"ok"}`) |

## Troubleshooting

### "MCP server requires @modelcontextprotocol/sdk"

The MCP SDK is an optional peer dependency. Install it:

```bash
npm install @modelcontextprotocol/sdk
```

This only affects `sequant serve`. All other commands (`run`, `doctor`, `init`, etc.) work without the SDK.

### Tools don't appear in my editor

1. Run `npx sequant serve` from the command line — if it errors, fix that first
2. Check MCP config JSON is valid (trailing commas break it)
3. Restart the editor completely
4. Run `sequant doctor` to check MCP server health

### "EXECUTION_ERROR" when running a workflow

The underlying `sequant run` command failed. Check:
- Is the project initialized? Run `npx sequant init`
- Is `gh` authenticated? Run `gh auth status`
- Is Claude Code authenticated? Run `claude login` or check `ANTHROPIC_API_KEY`
- Does the issue number exist in this repo?

### Nothing happens for a long time

Expected. Workflows take 5–30 minutes. Unlike earlier versions, the server stays responsive during runs — ask "What's the sequant status for issue #42?" at any time to check progress. If you need to stop a run, cancel the tool call from your editor and the subprocess will be terminated cleanly.

### Workflow uses a different sequant version than expected

If `sequant_run` behaves differently than your local `sequant run`, you may have multiple cached versions. The MCP server automatically reuses its own binary for child processes (since v1.21), so this should not happen with current versions. If it does:

1. Clear the npx cache: `npx clear-npx-cache` or `rm -rf ~/.npm/_npx`
2. Pin a version in your MCP config: `"args": ["sequant@1.21.0", "serve"]`
3. Or use a local install instead of npx: `"command": "node", "args": ["dist/bin/cli.js", "serve"]`

### Client reports a timeout

Some clients have tool call time limits (the server's own timeout is 30 minutes). Run phases individually instead of a full workflow:

> "Use sequant to run only the spec phase for issue #42"

### Sequant can't find the project (Claude Desktop)

If `sequant_run` returns errors about missing config or git repo, the server is running from the wrong directory. Add `cwd` to your Claude Desktop MCP config:

```json
"cwd": "/absolute/path/to/your/project"
```

---

*Generated for Issue #372 / PR #387 on 2026-03-23. Updated for #396 (optional SDK), #388 (async execution, cancellation), #389 (version consistency) on 2026-03-23.*
