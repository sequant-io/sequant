# Codex Agent Backend

> **Experimental.** The Codex driver ships in 2.16 but is not a supported backend yet. It runs the same skills and guard hooks Claude Code does, but its promotion gate ([#1060](https://github.com/sequant-io/sequant/issues/1060)) is still open. Claude Code remains the supported default.

Run Sequant workflows through [OpenAI Codex](https://github.com/openai/codex) instead of Claude Code. Every phase (`spec`, `exec`, `qa`, `loop`) is dispatched as a headless `codex exec` run that reads the project's `.claude/skills/` tree and is guarded by the same `pre-tool.sh` / `post-tool.sh` hooks.

## Prerequisites

1. **Codex CLI** `>= 0.154.0` — `npm i -g @openai/codex` (verify: `codex --version`). Sequant checks the floor at run time and in `sequant doctor`; the CLI moves fast, so expect the floor to rise.
2. **Authentication** — either export `CODEX_API_KEY`, or run `codex login` once interactively. `sequant doctor` reports which path is active and never logs the key's value.
3. **Sequant initialised for Codex** — `sequant init --agent codex` (next section).

## Setup

### 1. Provision the project

```bash
sequant init --agent codex
```

On an already-initialised project this only adds what Codex needs; your tuned `.sequant/settings.json` is preserved, comments included (#1071, #1100). It writes:

- **`.agents/skills`** — a **relative** symlink to `../.claude/skills`. Codex discovers skills there. It must be a real symlink, not a copy: a copied tree goes stale the moment `.claude/skills` changes, and an absolute symlink into another checkout makes Codex namespace every skill as `<repo-dir>:<name>`, which breaks `$<phase>` invocation.
- **`.codex/config.toml`** — a hook wrapper that points Codex's `PreToolUse` / `PostToolUse` at the existing `.claude/hooks/pre-tool.sh` and `post-tool.sh`, unmodified. Codex's hook payload is a superset of Claude Code's, and a gate test feeds Codex's recorded payload to the real hook to keep that true.
- **`run.agent: "codex"`** in `.sequant/settings.json`.

Commit `.codex/` and `.agents/` so worktree phases inherit the same guards (#1072).

### 2. Trust the project in your user config

Codex loads project-layer hooks only after the project is marked trusted in your **user** config, `~/.codex/config.toml` (not the project file init writes). Without this entry Codex skips the hooks silently — no error, no warning:

```toml
[projects."/absolute/path/to/your/project"]
trust_level = "trusted"
```

`sequant init --agent codex` prints the exact block for your path.

### 3. Run

Per run:

```bash
sequant run 123 --agent codex
```

Or permanently, in `.sequant/settings.json`:

```json
{
  "run": {
    "agent": "codex"
  }
}
```

## Settings

All keys live under `run.codex`:

| Key             | Default             | Meaning                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`         | Codex's own default | Passed as `codex exec -m <model>`                                                                                                                                                                                                                                                                                                     |
| `sandboxMode`   | `"workspace-write"` | `codex exec -s <mode>`: `read-only`, `workspace-write` or `danger-full-access`. `exec` itself defaults to read-only, which cannot write the worktree, so sequant defaults to `workspace-write`.                                                                                                                                       |
| `networkAccess` | `true`              | Under `workspace-write`, whether the phase may reach the network. Codex disables it by default, which leaves a phase unable to read its own issue, post a comment or push (#1079). Set `false` to keep phases sealed off, accepting that they cannot take part in the GitHub side of the workflow. Ignored under the other two modes. |
| `extraArgs`     | `[]`                | Appended verbatim to the `codex exec` command line                                                                                                                                                                                                                                                                                    |

## What the driver runs

For each phase, `CodexDriver` spawns:

```
codex exec --json -C <worktree> -s <sandboxMode> --dangerously-bypass-hook-trust [-m <model>] <prompt>
```

and, when the resolved sandbox mode is `workspace-write`:

- `-c sandbox_workspace_write.writable_roots=[<git dir>]` — Codex's sandbox makes the workspace writable but excludes `.git/`, so without this every `git commit` a phase ran was denied with `Unable to create '…/index.lock'`. The git dir is resolved with `git rev-parse --git-common-dir`, which from inside a worktree is the main checkout's `.git`, where the index lives (#1076).
- `-c sandbox_workspace_write.network_access=true` unless `networkAccess: false` (#1079).

Neither override touches `read-only` or `danger-full-access`. The point is to keep the sandbox intact rather than retreat to `danger-full-access`: sequant's guard hooks are designed to run inside a sandbox, not instead of one.

`--dangerously-bypass-hook-trust` is what lets a headless `codex exec` apply hooks at all; Codex's normal trust flow needs an interactive `/hooks` review, which a headless run never gets. Sequant passes it because sequant itself generates and vets `.codex/config.toml` and the hook scripts it points to. Stdin is spawned as `"ignore"`, because `codex exec` treats a non-TTY pipe as the prompt.

The JSONL stream is parsed against the Codex TypeScript SDK's exported event types (a devDependency; nothing from it reaches `dist/`). `item.completed` items of type `error` are forwarded to stderr as warnings — the hook-trust banner and the model-metadata notice arrive that way — and only `turn.failed` or a top-level `error` event fails the phase.

A `turn.failed` is classified before it is reported (#1087). Codex's usage-limit message becomes a `RateLimitError` carrying the parsed reset time when that reset is within seven days, so `--auto-wait` can hold the run until the window reopens; a reset further out, in the past, or unparseable becomes a `BillingError`, which stops the quality loop instead of re-running into the same quota. Throttle wording (`rate limit exceeded`, `429`, `too many requests`) is a retryable `RateLimitError`. Any other failure stays a generic error with code `turn-failed`. The [driver conformance suite](../guides/writing-an-agent-driver.md#3-typed-error-mapping) pins this mapping.

## What `sequant doctor` checks

When `run.agent` is `"codex"`, `doctor` adds:

- `codex` is on `PATH` and `codex --version` meets the floor, each probe bounded by a timeout so a stalled CLI reports as unavailable instead of hanging (#1075).
- Authentication: `CODEX_API_KEY` set, or `codex login status` reports logged in. The key's value is never logged.

It does not inspect `.agents/skills` or `.codex/config.toml`; check those with `ls -l .agents/skills` (expect `-> ../.claude/skills`) if skills are not discovered.

## Limitations

- **Experimental.** No support commitment until the promotion gate closes. Expect rough edges in spec-recommendation parsing and comment posting; report them on [#1060](https://github.com/sequant-io/sequant/issues/1060).
- **Windows** — creating the `.agents/skills` symlink needs elevated privileges or Developer Mode. Without them `init` warns and Codex will not discover sequant's skills until the link exists; there is no copy fallback.
- **The network is open by default** under `workspace-write`, exactly as it is for a Claude Code phase. `networkAccess: false` closes it at the cost of the GitHub side of the workflow.

## See also

- [Aider Agent Backend](aider-agent-backend.md) — the other alternative driver, and how backends are implemented
- [Troubleshooting → Codex Issues](../troubleshooting.md#codex-issues)
- [Writing an agent driver](../guides/writing-an-agent-driver.md) — the driver interface and the conformance contract every backend passes
- [Run Orchestrator](run-orchestrator.md)
