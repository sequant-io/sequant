# CLI Output Formatting

Sequant uses a consistent set of typographic symbols and formatting conventions across all CLI commands. This document covers the design principles, symbol reference, and how output adapts to different environments.

## Prerequisites

1. **Sequant installed** -- `npx sequant --version`
2. **Terminal with Unicode support** -- most modern terminals (iTerm2, Windows Terminal, VS Code)

## Design Principles

1. **No emoji in structured output** -- typographic symbols (`✔`, `✖`, `▸`, `·`, `!`) align properly in monospace
2. **Ora is the source of truth** -- success/fail symbols match what ora spinners produce
3. **Columnar alignment** -- config key-value pairs are padded for readability
4. **Minimal chrome** -- no boxes, light dividers, bold titles instead of bordered headers
5. **Quiet by default** -- heartbeats only when genuinely idle; phase events are the primary progress signal
6. **Graceful degradation** -- noColor, non-TTY, CI, and verbose modes all work

## Symbol Reference

### Status Icons

Used by `statusIcon()` in `src/lib/cli-ui.ts` and throughout all commands:

| Status | TTY Symbol | No-Color Fallback | Usage |
|--------|-----------|-------------------|-------|
| Success | `✔` (green) | `[OK]` | Completed phases, passed checks |
| Error | `✖` (red) | `[FAIL]` | Failed phases, errors |
| Warning | `!` (yellow) | `[WARN]` | Non-fatal warnings, degraded state |
| Pending | `·` (gray) | `[ ]` | Not yet started |
| Running | `▸` (cyan) | `[..]` | In progress |

### Phase Progress

Used in `sequant run` parallel mode and phase tracking:

| State | Symbol | Example |
|-------|--------|---------|
| Running | `▸` | `▸ #151  exec` |
| Complete | `✔` | `✔ #151  exec  46s` |
| Failed | `✖` | `✖ #151  exec` |
| Waiting | `·` | `#153 ·` |

### Dividers

- **Standard:** light `─` (U+2500) repeated to width
- **Legacy Windows:** `-` (ASCII hyphen)
- **JSON/minimal mode:** empty string (suppressed)

### Headers

- **`headerBox(title)`** returns bold text only (no boxen borders)
- **`sectionHeader(title)`** returns bold title + light divider underneath

## Environment Modes

| Mode | Behavior |
|------|----------|
| **TTY** (default) | Animated ora spinners, colored symbols, light dividers |
| **Non-TTY** | Text spinners (`▸`/`✔`/`✖`/`!`), no ANSI overwrite |
| **No-color** (`NO_COLOR=1`) | ASCII fallbacks: `[OK]`, `[FAIL]`, `[WARN]`, `[ ]`, `[..]` |
| **CI** (`CI=true`) | Minimal output, no animations, no decorative elements |
| **JSON** (`--json`) | All decorative output suppressed |
| **Verbose** (`--verbose`) | Text spinners (no animation) to avoid overwriting log lines |

## Parallel Mode Output

When running `sequant run` with multiple issues in parallel mode:

```
  Stack          node
  Phases         auto-detect from labels
  Mode           parallel (concurrency: 3)
  Issues         #151, #152, #153

  ▸ #151  exec
  ▸ #152  spec
  ✔ #151  exec  46s
  ✖ #153  spec
  ✔ #152  spec  12s

  ✔ #151 completed (2m 2s)
  ✖ #153 failed: spec error

  3 passed · 0 failed

  ✔ #151: spec → exec → qa → PR #160 (13m 38s)
  Log: .sequant/runs/2026-04-08T12-00-00.json
```

### Heartbeat

In parallel mode, a heartbeat message appears every 5 minutes (only when no phase events occurred in the last 60 seconds):

```
  Still running... (5m 0s elapsed)
```

## Config Display

The `sequant run` command displays configuration in columnar format:

```
  Stack          node
  Phases         auto-detect from labels
  Mode           sequential (stop-on-failure)
  Quality loop   enabled (max 3 iterations)
  Logging        JSON (run a1b2c3d4...)
  State          enabled
  Issues         #218, #219
```

## Extending

When adding new CLI output, follow these conventions:

- Use `statusIcon()` from `src/lib/cli-ui.ts` for status indicators
- Use `divider()` for horizontal rules
- Use `headerBox()` for section titles
- Use `colors.muted()` for secondary information
- Never use decorative emoji in terminal output
- Always provide no-color fallbacks via `config.noColor` checks

## Troubleshooting

### Symbols display as boxes or question marks

**Symptoms:** `✔` shows as `□` or `?`

**Solution:** Your terminal doesn't support Unicode. Set `NO_COLOR=1` to use ASCII fallbacks, or switch to a modern terminal (iTerm2, Windows Terminal, VS Code integrated terminal).

### Output is too verbose in CI

**Symptoms:** Animated spinners produce noisy logs

**Solution:** Set `CI=true` environment variable (most CI systems do this automatically). Sequant detects CI and switches to minimal output.

---

*Generated for Issue #495 on 2026-04-08*
