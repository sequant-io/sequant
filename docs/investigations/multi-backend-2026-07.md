# Multi-backend feasibility: opencode, Codex, and the agent-CLI landscape

**Issues:** [#862](https://github.com/sequant-io/sequant/issues/862) (opencode driver) · [#497](https://github.com/sequant-io/sequant/issues/497) (Codex driver) · [#863](https://github.com/sequant-io/sequant/issues/863) (ready-gate driver plumbing)
**Date:** 2026-07-28/29
**Method:** Three parallel deep-dives — (1) map of sequant's driver/execution layer, (2) inventory of every Claude-Code-specific runtime surface, (3) opencode capabilities verified against source (`anomalyco/opencode@dev`), plus a landscape survey of agentic coding CLIs with adoption signals checked against live repos.

## TL;DR

Supporting a second agent backend needs **no restructure**: the `AgentDriver` seam already ships two drivers (claude-code via the Agent SDK in-process, aider via subprocess), with per-phase `driverOverrides` prompts, `resolvesSkills` gating the skills preflight, and driver-tagged resume handles (#674). **opencode is the recommended second backend** — the only surveyed tool that reads `.claude/skills/` natively, has Task-spawnable markdown subagents, blocking pre-tool hooks, and headless JSON output. Estimated 1–2 weeks of plumbing plus a quality-tuning tail (#862). Bringing **aider to parity was evaluated and rejected**: aider has no skill/command/subagent/hook surfaces to adapt to, so parity means sequant building its own agent runtime — months, with true pre-execution blocking impossible without a fork.

## What the driver layer already provides

- `AgentDriver` interface (`src/lib/workflow/drivers/agent-driver.ts`): `executePhase`, `isAvailable`, `canResume`, `resolvesSkills`. Registry in `drivers/index.ts`; selection via `--agent` / `settings.run.agent`.
- The claude-code driver is **not** a CLI subprocess — it calls the Agent SDK's `query()` in-process (`drivers/claude-code.ts`) with `settingSources: ["project"]`, `bypassPermissions`, Claude-Desktop-derived `mcpServers`. Skills/subagents/hooks are loaded by the SDK from `.claude/`.
- The aider driver proves the subprocess pattern end to end (all 9 phases have hand-written override prompts) but is a working *driver*, not a working *product*: ~5-line prompts replace the ~18k-line skill tree; no hooks, subagents, resume, or structured errors.
- QA verdict extraction is regex over concatenated assistant text (`parseQaVerdict`, `parseQaSummary` in `phase-executor.ts`) — any backend that runs the QA skill (or pins the output format) feeds it unchanged.
- 28 `SEQUANT_*` env vars form a driver-agnostic contract between orchestrator and skills; they pass through any spawn env.
- Found during the investigation: `ready-gate.ts:buildPhaseConfig` never plumbs `agent`/driver settings, so ready-gate phases silently run claude-code regardless of config → #863.

## Why opencode fits

Verified against source, not just docs:

| Requirement | opencode |
|---|---|
| `.claude/skills/` interop | Native external skill dir (`packages/opencode/src/skill/index.ts`); discovery walks up from cwd to the git worktree root — matches sequant's worktree phases |
| Headless | `opencode run --command <name> <args> --format json --auto`; NDJSON events (`text`, `tool_use`, `step_start/finish`, `error`); meaningful exit codes (non-attached) |
| Subagents | `.opencode/agents/*.md`, `mode: subagent`, Task-tool spawnable, per-agent `permission` |
| Pre-tool blocking | Plugin `tool.execute.before` — block by throwing, args mutable; `permission.ask` for programmatic allow/deny |
| Providers | 75+ (can keep driving Claude models) |

Porting costs and risks (full critique in #862): opencode skills are **model-invoked tools, not slash commands** (phase entrypoints need generated `.opencode/commands/*.md` wrappers, plus a skill-marker check so a skipped skill fails loudly instead of laundering an unskilled run); hooks are in-process TS plugins (ship a shim piping the existing bash hooks' stdin-JSON contract through Bun `$`, exit 2 → throw, fail closed); unknown skill frontmatter (`allowed-tools`) is silently dropped; no terminal result event with cost/usage; platform churn (`sst` → `anomalyco`, docs lag source) argues for a pinned minimum version + CI smoke test.

## Why not aider parity

Aider is an edit-loop tool, not an extensible harness: no skill/command system (nowhere to put the methodology except giant prompts it won't work through agentically), no subagents (fan-out would have to be built in sequant), no tool-interception (security guards could only inspect diffs after the fact — detect, not prevent), no plugin/MCP seam. Parity ≈ reimplementing the agent runtime or maintaining a fork. Keep aider exactly as it is: a thin fallback proving the seam.

## Landscape (July 2026)

Adoption leaders: opencode (~190k stars, accelerating), Gemini CLI (~106k), Codex CLI (~102k), Cline (65k stars / ~204k npm downloads/wk). Since H1 2026, **Claude-compatible PreToolUse blocking hooks are table stakes** (Codex default-on, Gemini, Copilot CLI, Qwen Code, Factory, Kiro all shipped exit-2/`permissionDecision` contracts); the differentiators are skills interop and user-definable subagents.

Ranked fit for sequant: **1) opencode** (all four requirements, only tool with zero skill porting); **2) Codex CLI** (clean `codex exec --json` + resume, hooks default-on, GA subagents — but OpenAI-locked and reads `.codex/skills/`/`.agents/skills/`, not `.claude/skills/`; see #497 update comment); **3) Copilot CLI** (reads `.claude/skills/`, fail-closed hooks — but no confirmed structured JSON output and open bugs where plugin preToolUse hooks don't fire, github/copilot-cli#2540); **4) Qwen Code** (self-hostable dark horse, richest hook system, but reads no interop path). Dead/skip: Roo Code (archived 2026-05), Amazon Q CLI (→ closed-source Kiro; headless paywalled), aider (stagnant), Kilo (opencode fork — use upstream), Amp (no BYOK, no user-defined subagents), Cursor CLI (hook scope is shell-only), Goose/Crush (unverified or immature on the axes that matter).

**Strategic note:** the ecosystem is converging on **`.agents/skills/`** as the neutral skills path — read by Codex, Gemini, Copilot CLI, Amp, Factory, Kilo, *and* opencode. One mirror of sequant's skill tree there makes the methodology consumable by nearly every backend surveyed; it is the highest-leverage single move if multi-backend support proceeds beyond #862.

## Decisions

1. opencode is the first non-Claude backend target → #862.
2. Codex CLI remains the hedge/second target; #497 updated with corrected research (hooks default-on, skills dirs shipped, subagents GA).
3. No further aider investment beyond keeping the existing driver working.
4. Fix #863 before or with #862 — otherwise `--ready-gate` silently switches backends mid-run.
5. `.agents/skills/` mirroring is deferred until #862 proves out, but should be re-evaluated then.
