# Aider Agent Backend

Run Sequant workflows using [Aider](https://aider.chat) instead of Claude Code. Aider is model-agnostic — use Claude, GPT-4o, Gemini, DeepSeek, or local models for phase execution.

## Prerequisites

1. **Aider CLI** — `pip install aider-chat` (verify: `aider --version`)
2. **Model API key** — Set the appropriate env var for your model (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
3. **Sequant** — `npx sequant doctor` should pass

## Setup

### Option 1: CLI flag (per-run)

```bash
npx sequant run 123 --agent aider
```

### Option 2: Default in settings (permanent)

Add to `.sequant/settings.json`:

```json
{
  "run": {
    "agent": "aider"
  }
}
```

All subsequent `sequant run` commands will use Aider unless overridden with `--agent claude-code`.

### Option 3: With model and format config

```json
{
  "run": {
    "agent": "aider",
    "aider": {
      "model": "claude-3-sonnet",
      "editFormat": "diff",
      "extraArgs": ["--map-tokens", "2048"]
    }
  }
}
```

## What You Can Do

```bash
# Run a full workflow with Aider
npx sequant run 123 --agent aider

# Run specific phases
npx sequant run 123 --agent aider --phases spec,exec,qa

# Dry-run to preview prompts (no execution)
npx sequant run 123 --agent aider --dry-run --verbose

# Check Aider availability
npx sequant doctor
```

## What to Expect

- Aider receives **self-contained prompts** per phase (not Claude Code skill invocations). These include full instructions for what to do.
- For exec/qa phases, Sequant automatically passes **changed files** via `--file` flags so Aider has file context.
- Aider runs in **non-interactive mode** (`--yes --no-auto-commits --no-pretty`). Sequant manages git, not Aider.
- Phase execution takes roughly the same time as Claude Code — the bottleneck is the LLM, not the driver.
- Verbose mode (`--verbose`) streams Aider's stdout in real-time.

## Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `run.agent` | `string` | `"claude-code"` | Agent driver to use for phase execution |
| `run.aider.model` | `string` | Aider's default | Model to use (e.g., `"claude-3-sonnet"`, `"gpt-4o"`) |
| `run.aider.editFormat` | `string` | Aider's default | Edit format: `"diff"`, `"whole"`, or `"udiff"` |
| `run.aider.extraArgs` | `string[]` | `[]` | Extra CLI arguments passed to aider |

### CLI Flags

| Flag | Description |
|------|-------------|
| `--agent <name>` | Override the default agent driver (`"claude-code"` or `"aider"`) |

## How Phases Work with Aider

| Phase | Prompt Style | File Context |
|-------|-------------|--------------|
| `spec` | Read issue via `gh`, post spec comment | None (reads issue via shell) |
| `exec` | Full implementation instructions | Changed files from `git diff` |
| `qa` | Review instructions with verdict format | Changed files from `git diff` |
| `testgen` | Generate test stubs from spec | Changed files from `git diff` |

Aider receives self-contained instructions for each phase instead of `/skill` invocations. Project context from `AGENTS.md` is automatically included in the prompt.

## Doctor Integration

When `run.agent` is set to `"aider"` in settings, `sequant doctor` includes an Aider availability check:

```
✓ Aider CLI: aider CLI is installed (configured as default agent)
```

If Aider isn't installed:

```
✗ Aider CLI: aider CLI not installed but configured as default agent
  Fix: pip install aider-chat
```

## Troubleshooting

### "Aider CLI not found. Install it with: pip install aider-chat"

Aider isn't on your PATH. Install it and verify:

```bash
pip install aider-chat
aider --version
```

If installed but not found, check your Python environment (virtualenv, conda, system Python).

### Aider exits with non-zero code

Check the error output — common causes:
- Missing API key for the configured model
- Rate limiting from the model provider
- Invalid `extraArgs` in settings

Run with `--verbose` to see Aider's full output:

```bash
npx sequant run 123 --agent aider --verbose
```

### Phase timeout

Default timeout is 1800 seconds (30 minutes). Increase it for large features:

```bash
npx sequant run 123 --agent aider --timeout 3600
```

---

*Generated for Issue #369 on 2026-03-23*
