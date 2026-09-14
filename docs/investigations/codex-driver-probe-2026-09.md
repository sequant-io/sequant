# Codex driver probe — what Codex CLI 0.154 actually does under sequant's assumptions

**Issue:** [#497](https://github.com/sequant-io/sequant/issues/497) (Codex driver) · **Date:** 2026-09-12 · **Status:** concluded, build deferred to the #497 fullsolve
**Supersedes:** the July 2026 landscape comment on #497 and the Codex row of [`multi-backend-2026-07.md`](multi-backend-2026-07.md)

## Verdict: technically de-risked; shape is settled

Every known-unknown that could have changed #497's design was tested against the
real binary, and four of them **did** change it:

| # | Question | Result | Consequence for #497 |
|---|----------|--------|----------------------|
| 1 | Does explicit `$skill` work in headless `codex exec`? | **Yes** | Drop `CODEX_PHASE_PROMPTS`; symlink `.agents/skills → ../.claude/skills`; `resolvesSkills = true` |
| 2 | Are sequant's *real* 19 skills discovered intact? | **19/19**, bare names, no warnings | Same |
| 3 | Can the model `git commit` inside a linked worktree under `workspace-write`? | **Yes** | No `additionalDirectories` for the shared `.git` |
| 4 | Do hooks run in `exec`? | **Only with `--dangerously-bypass-hook-trust`**; otherwise **silently skipped** | Driver must pass the flag |
| 5 | Can the SDK pass that flag? | **No** — CLI-only, no config-key equivalent | **Subprocess `codex exec --json`, SDK for types only** |
| 6 | Does `exec resume` still adopt the caller's cwd (openai/codex#4791)? | **Yes** | #674's driver-side `canResume` gate stays mandatory |
| 7 | Does `exec` tolerate a non-TTY stdin? | **No** — blocks on stdin until timeout | Driver must `stdin: "ignore"` or feed the prompt via stdin |

Items 5 and 7 were not on the original list; both fell out of running the thing.

---

## AC-0 — environment

| Item | Value |
|------|-------|
| `@openai/codex` | `0.154.0` (published 2026-09-11; SDK pins this exact version) |
| `@openai/codex-sdk` | `0.154.0` — `dist/index.d.ts` read directly, 285 lines |
| Install | scratchpad `npm install`, never global; `codex` was not on the machine before |
| Hermeticity | `CODEX_HOME=<scratch>/codex-home` (own `config.toml`, sessions, sqlite) |
| Model | `openai/gpt-5-mini` via OpenRouter, `wire_api = "responses"` (no OpenAI key on the machine; harness behavior is provider-independent) |
| Spend | 5 model runs, ≈130K input / ≈10K output tokens, a few cents |
| Fixture | throwaway git repo + one linked worktree; `.agents/skills/probe-skill/SKILL.md` with sentinel body; `AGENTS.md` with sentinel |

`codex` was **not logged in** and no `CODEX_API_KEY` existed, so the ChatGPT-plan
auth path (lever (b) below) is inferred from SDK source, not exercised.

---

## The SDK, from its type definitions

`@openai/codex-sdk` wraps the CLI: it spawns `codex exec` and parses JSONL. It
depends on `@openai/codex` at an **exact** version, so installing the SDK
installs the platform binary — no separate global install.

`ThreadOptions` maps onto `AgentExecutionConfig` almost field-for-field:

| `AgentExecutionConfig` | `ThreadOptions` |
|---|---|
| `cwd` | `workingDirectory` |
| `model` | `model` |
| `effort` (`low…max`) | `modelReasoningEffort` (`minimal…persistent`, a superset) |
| `abortSignal` | `TurnOptions.signal` |
| — | `sandboxMode: "read-only" \| "workspace-write" \| "danger-full-access"` |
| — | `approvalPolicy: "never" \| …`, `networkAccessEnabled`, `additionalDirectories` |

`Usage { input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens }`
maps onto `ModelUsageEntry` without translation. `resumeThread(id, options)`
accepts `workingDirectory`. `CodexOptions.apiKey` sets `CODEX_API_KEY` **only
when given** (`env.CODEX_API_KEY = args.apiKey` in `dist/index.js`); otherwise
the CLI's own `codex login` state applies.

**But the SDK is not the integration surface** — see AC-4/5. What survives is the
type module: `ThreadEvent`, `ThreadItem`, `Usage` are the contract a subprocess
parser should be typed against.

The arg list the SDK builds (grep of `dist/index.js`):
`--add-dir --cd --config --experimental-json --image --model --output-schema --sandbox --skip-git-repo-check --thread-source`.
Note `--experimental-json`, not `--json` — the SDK tracks the CLI it pins.

---

## AC-1 — `$skill` in headless `exec` ($0 discovery, then one paid run)

### Discovery is visible without a model call

`codex debug prompt-input '<prompt>'` renders the model-visible input list as
JSON. With `.agents/skills/probe-skill/` in the fixture, the system text contained:

```
- probe-skill: Sequant harness probe. Use when asked to run the probe skill. (file: r1/probe-skill/SKILL.md)
</skills_instructions>
```

and a separate message carried AGENTS.md verbatim (`SEQUANT_PROBE_AGENTS_MD_9c1d`
found). The skill **body** is *not* inlined — metadata in the prompt, body read on
invocation, same design as Claude Code. The `$probe-skill` mention passes through
in the user message untouched.

### Invocation (run 1, paid)

```
codex exec --json -C <fixture> -s workspace-write --dangerously-bypass-hook-trust \
  '$probe-skill run the probe. Then run this exact shell command: echo HOOKPROBE_MARKER' </dev/null
```

```json
{"type":"thread.started","thread_id":"01a09759-a395-71f1-8082-2877a06a36fc"}
{"type":"item.completed","item":{"id":"item_4","type":"command_execution","command":"/bin/zsh -lc 'echo HOOKPROBE_MARKER'","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_5","type":"agent_message","text":"SKILL_OK\n\n- Command run: `echo HOOKPROBE_MARKER`\n- Output:\n  - `HOOKPROBE_MARKER`"}}
{"type":"turn.completed","usage":{"input_tokens":28271,"cached_input_tokens":18816,"cache_write_input_tokens":0,"output_tokens":3306,"reasoning_output_tokens":3200}}
```

`SKILL_OK` exists only in the skill body. The skill was loaded and followed.

---

## AC-2 — sequant's real skills, four layouts ($0)

Symlinking the real `.claude/skills` tree and re-running `debug prompt-input`:

| Layout | `.agents/skills` is… | Discovered | Names |
|--------|----------------------|-----------|-------|
| A | symlink → `<other repo>/.claude/skills` | 19/19 | **`sequant:assess`, `sequant:qa`, …** |
| B | dir of per-skill symlinks → other repo | 19/19 | `sequant:*` |
| C | plain copy | 19/19 | bare |
| **E** | **relative symlink → `../.claude/skills` (same repo)** | **19/19** | **bare** |

Codex namespaces a skill by `<repo-dir>:<name>` when its realpath resolves into
a *different* repository; in-repo symlinks are bare. Layout E is what
`sequant init --agent codex` would generate. No frontmatter warnings on any
sequant skill; the skills block is ≈5 KB for 19 skills (metadata only, so
skill *size* is not a prompt-budget concern — body clamping on read was not
measured, see Gaps).

The two dirs without a `SKILL.md` (`_shared`, `references`) are ignored silently.

---

## AC-3 — worktree commit under `workspace-write` (run 3, paid)

A linked worktree's `.git` is a *file* pointing at `<main>/.git/worktrees/<name>`;
commits write to the main repo's object store, outside the worktree cwd. The
concern was that Seatbelt would block that.

```
codex exec --json -C <worktree> -s workspace-write --dangerously-bypass-hook-trust \
  'Run exactly these two shell commands and report each exit code: (1) git add f.txt  (2) git commit -m "chore: sandbox probe".'
```

Both `command_execution` items completed `exit_code: 0`; `git log` in the
worktree afterwards shows `c7db2c0 chore: sandbox probe`. **Shared-`.git` writes
are permitted** — no `additionalDirectories` needed.

Two side observations from the same run:

- Codex runs tool commands via `/bin/zsh -lc`, so the user's login shell init
  runs *inside the sandbox*. Here that produced
  `error: Can't create the symlink for multishells at ~/.local/state/fnm_multishells/…`
  on every command — non-fatal, exit 0, but it lands in `aggregated_output`.
  A driver that greps command output for errors will see it.
- The `codex sandbox -P <profile>` debug subcommand SIGABRTs (exit 134, no
  output) on any command with a custom `[permissions.<name>]` profile in 0.154.
  It is **not** usable as a $0 sandbox probe; only the real exec path was.

---

## AC-4 — hooks in `exec` (runs 1, 2, 5)

Config (`$CODEX_HOME/config.toml`):

```toml
[[hooks.PreToolUse]]
matcher = ".*"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "<scratch>/hook.sh"   # cats stdin to hook-fired.json, exit 0
timeout = 10
```

| Run | Invocation | Hook fired? | stderr mention |
|-----|-----------|-------------|----------------|
| 1 | `--dangerously-bypass-hook-trust` | **yes** | banner: "`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation." (emitted as an `item.completed/error` item, twice) |
| 2 | no flag | **no** | **nothing** — no warning, no event, two `command_execution` items ran unguarded |
| 5 | no flag, `-c hooks.bypass_trust=true` | **no** | nothing |

Docs confirm the mechanism: non-managed hooks need trust recorded against the
hook definition's hash, and "a `codex exec` run has no review UI, so an untrusted
hook is skipped silently until you trust it in an interactive session first".
Trust lives in `hooks.state` (`HookStateToml { enabled, trusted_hash }`, from
binary strings) — written only by the TUI's `/hooks`; nothing in the sqlite
store. The hash algorithm is undocumented, so pre-seeding trust is not a safe
option.

Run 5 exists because `-c hooks.bypass_trust=true` *passed* `--strict-config`.
So did `-c hooks.totally_bogus=true`. The `[hooks]` table is lenient; the key is
not real. `bypass_hook_trust` and `features.bypass_hook_trust` are rejected by
strict config. **There is no config-key equivalent of the flag.**

### The hook payload is a superset of Claude Code's

```json
{
  "session_id": "01a09759-a395-71f1-8082-2877a06a36fc",
  "turn_id": "01a09759-a469-7f11-9b96-d8aa0e9aaa48",
  "transcript_path": "<CODEX_HOME>/sessions/2026/09/12/rollout-2026-09-12T15-40-29-….jsonl",
  "cwd": "<fixture>",
  "hook_event_name": "PreToolUse",
  "model": "openai/gpt-5-mini",
  "permission_mode": "bypassPermissions",
  "tool_name": "Bash",
  "tool_input": { "command": "echo HOOKPROBE_MARKER" },
  "tool_use_id": "call_2k3qbXWQAvAnZlBcexx1f778"
}
```

`.claude/hooks/pre-tool.sh` reads `tool_name`, `tool_input.command`,
`tool_input.run_in_background`, `cwd`, `session_id` — all present, and
`tool_name` is literally `"Bash"`. The existing hook scripts are candidates to
run **unmodified**; only the config wrapper is new. Deny is exit 2 or JSON
`permissionDecision: "deny"`, both already what sequant emits. (PreToolUse
honors deny only — it cannot pause for approval — which is the headless case
anyway.)

---

## AC-5 — why the driver is a subprocess, not the SDK class

Three independent reasons, any one sufficient:

1. **Hooks.** The flag is CLI-only (AC-4); the SDK's arg list has no slot for it
   and `configOverrides` can't express it. An SDK-driven phase runs with
   sequant's guard hooks silently absent — the #1032 stranding class, unguarded.
2. **Observability.** `Thread._exec` is private. `stderrTail` / `exitCode`
   (#447) and the stderr-regex path in `error-classifier.ts` have no source.
3. **Version coupling.** The SDK pins the binary exactly and uses
   `--experimental-json`; `codexPathOverride` to a user's global binary reopens
   the protocol-skew class sequant already hit twice.

Import `@openai/codex-sdk` as a **type-only** dependency (or vendor the 285-line
`.d.ts`) and spawn `codex exec --json` directly, mirroring `OpencodeDriver`'s
`buildOpencodeArgs` / `OpencodeStreamParser` / `evaluateOpencodeRun` split.

---

## AC-6 — `exec resume` and cwd (run 4, paid)

Resuming run 1's thread (created in `<fixture>`) with the shell in the
**worktree**:

```
cd <fixture-wt> && codex exec resume 01a09759-… --json --dangerously-bypass-hook-trust \
  'Run exactly this shell command and report its output: pwd'
```

Agent output: `` `<scratch>/fixture-wt` ``. The hook payload's `cwd` agreed.
**The resumed session adopted the caller's cwd** — openai/codex#4791 is live in
0.154, exactly as m13v warned on #497. `exec resume` accepts no `-C`.
The SDK's `resumeThread(id, { workingDirectory })` can *pin* a cwd, but
nothing refuses a mismatch: #674's `canResume(handle, targetCwd)` keyed on
`originCwd` equality is the only guard and stays mandatory.

---

## AC-7 — stdin (the two $0 failures)

The first two paid attempts produced **no** events and exit 124 after 240 s.
stderr: `Reading additional input from stdin...`. `codex exec` treats a
non-TTY stdin as prompt input ("If stdin is piped and a prompt is also
provided, stdin is appended as a `<stdin>` block") and waits for EOF. Every
subsequent run used `</dev/null`. A driver spawning with `stdio: ["pipe", …]`
and never closing stdin reproduces this as a full phase timeout.

---

## Parser gotchas for #497

- **`item.completed` / `error` items are warnings.** Run 1 emitted three: two
  copies of the hook-trust banner and one "Model metadata for `openai/gpt-5-mini`
  not found. Defaulting to fallback metadata". The turn succeeded. `ErrorItem`
  is non-fatal by the SDK's own doc comment; `turn.failed` and the top-level
  `error` event are the fatal ones. Three-level classification, not one.
- `command_execution` arrives as `item.started` (no `exit_code`) then
  `item.completed` (`exit_code`, `aggregated_output`); dedupe on `item.id`.
- `usage` is one object per turn — no per-model map. `modelUsage` must be
  synthesized with the resolved model as the single key.
- No `maxTurns` equivalent → `capped` stays undefined.
- Auth env var is **`CODEX_API_KEY`**, not `OPENAI_API_KEY` (#497's P1 `doctor`
  AC names the wrong one).
- `exec` defaults to a **read-only** sandbox; `-s workspace-write` is explicit.

The recorded run-1 stream is at
`src/lib/workflow/drivers/__fixtures__/codex-exec-skill-hook.jsonl` (10 events,
paths scrubbed). Write the parser against it.

---

## What changes in #497

**P0**
- `CodexDriver` = subprocess `codex exec --json -C <cwd> -s workspace-write --dangerously-bypass-hook-trust [-m …] <prompt>`, `stdin: "ignore"`, abort → SIGTERM; parse with SDK-typed events. Reuse the opencode three-function split.
- Drop `CODEX_PHASE_PROMPTS` / `driverOverrides.codex`. `resolvesSkills = true`, `usesSdkMcp = false`.
- `sequant init --agent codex`: create `.agents/skills → ../.claude/skills` (relative), write `.codex/config.toml` with the `[hooks]` wrapper pointing at the existing `.claude/hooks/*.sh`, and record that the repo must be trusted (`[projects."<path>"] trust_level = "trusted"` in the user config) or project-layer hooks won't load.
- Prompt is `$<phase> <issue>` — the skill name, not a rewritten prompt.

**P1**
- `doctor`: `CODEX_API_KEY` *or* `codex login status`; `CODEX_MIN_VERSION` floor (0.149 → 0.154 in 20 days; expect frequent bumps; extend `/upstream` to `openai/codex`).
- Token metrics from `turn.completed.usage` — free.
- Resume: implement against #674's `ResumeHandle`; never `exec resume` when `originCwd !== cwd`.

**Dropped / corrected**
- "Parses JSONL by hand", "RingBuffer for JSONL" → typed events; RingBuffer stays for stderr only.
- "`isAvailable` = `which codex`" → still needed (subprocess), but `codex --version` ≥ floor.
- Open Q #1 (`gh` under sandbox): sandbox runs the user's login shell, so PATH is theirs; network needs `network_access = true` under `[sandbox_workspace_write]`. Not exercised — see Gaps.

---

## Gaps — what this probe did not do

- **Full-phase quality.** A 6-line skill returning a sentinel is not `/qa` on a
  real diff. Skill *body* clamping on read (opencode truncates at 51K/175K) was
  not measured; sequant skills reference `Task(`, `Agent(subagent_type`,
  `AskUserQuestion`, nested `Skill(skill: "sequant:…")` — 7 of 21 do — and
  none of that has a Codex equivalent. This is the #497 fullsolve's first
  paid experiment, not this doc's.
- **`gh` under the sandbox** — untested. `network_access` is the lever.
- **ChatGPT-plan auth through `exec`** — inferred from SDK source, not run.
- **Hook *deny* path** — only the fire/skip axis was tested; exit-2 blocking
  was not exercised end-to-end.
- **Subagents** — `multi_agent` is `stable true` in `codex features list`;
  no mapping from `.claude/agents/*.md` was attempted.
- **`codex /import`** — v0.145+ imports Claude Code config (CLAUDE.md→AGENTS.md,
  skills, hooks, MCP, subagents), but it is TUI-only (`tui/src/external_agent_config_migration/`);
  no headless subcommand, so `sequant init` can't drive it.
- **Codex's own `--worktree` (0.154, experimental)** — deliberately not used;
  sequant owns worktree lifecycle and the two would collide.

---

## Reproduction

```bash
SP=$(mktemp -d); cd "$SP"
npm init -y >/dev/null && npm i @openai/codex@0.154.0 @openai/codex-sdk@0.154.0
export CODEX_HOME="$SP/codex-home"; mkdir -p "$CODEX_HOME"
# fixture: git repo + .agents/skills/<name>/SKILL.md + AGENTS.md + one linked worktree
# $0: discovery
./node_modules/.bin/codex debug prompt-input '$probe-skill run' | grep -c probe-skill
# paid: skill + hook (needs a Responses-API provider in $CODEX_HOME/config.toml, or codex login)
./node_modules/.bin/codex exec --json -C <fixture> -s workspace-write \
  --dangerously-bypass-hook-trust '$probe-skill run the probe' </dev/null
# strict-config as a $0 key oracle (unset auth first so it cannot spend)
./node_modules/.bin/codex exec --strict-config -c 'some.key=true' 'x' </dev/null
```

Raw outputs (`run1–5.jsonl`, `*-prompt.json`, `hook-fired.json`) lived in the
session scratchpad and are perishable; the scrubbed run-1 stream is the
committed artifact.
