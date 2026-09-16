/**
 * CodexDriver — AgentDriver implementation wrapping the `codex exec` CLI (#497).
 *
 * Phases dispatch as a subprocess, deliberately **not** through the Codex
 * TypeScript SDK's `Codex`/`Thread` classes:
 * `--dangerously-bypass-hook-trust` is CLI-only and the SDK has no option that
 * passes it, `Thread._exec` is private (so there is no `stderrTail`/`exitCode`
 * to surface), and the SDK pins the binary version exactly — the
 * protocol-skew class sequant has already hit twice. The SDK is a
 * **devDependency used for its types only** (#497 AC-8); every import from it
 * below is an `import type`, and no exported signature in this file names one,
 * so nothing reaches the emitted `.d.ts`.
 *
 * AC-8's guard greps `dist/` for the SDK's package name and expects zero
 * hits, and tsc copies comments into `dist/` verbatim. That is why the
 * package is named in the import statement (erased at emit) and in
 * package.json, but nowhere in this file's prose — spelling it out in a
 * comment turns the guard permanently red and stops it from meaning "no
 * runtime import survived".
 *
 *   codex exec --json -C <cwd> -s workspace-write \
 *     --dangerously-bypass-hook-trust [-m <model>] <prompt>
 *
 * Everything this driver believes about codex's output was measured against
 * `__fixtures__/codex-exec-skill-hook.jsonl` — a real run recorded by the #497
 * probe (`docs/investigations/codex-driver-probe-2026-09.md`) — not against the
 * docs. The four findings that shape the code below:
 *
 * 1. `item.completed` items of type `error` are **warnings**, not failures. The
 *    recorded run emitted three (two hook-trust banners, one model-metadata
 *    notice) and still succeeded. Only `turn.failed` and the top-level `error`
 *    event are fatal — three-level classification, not one.
 * 2. `codex exec` blocks reading stdin when stdin is a non-TTY pipe, which
 *    presents as a full phase timeout with zero events. Spawn uses
 *    `stdio: ["ignore", ...]` for exactly this.
 * 3. `usage` is one object per turn with no per-model map, so `modelUsage` is
 *    synthesized under the resolved model as its single key.
 * 4. `command_execution` arrives twice — `item.started` then `item.completed`
 *    under the same `item.id` — so it is deduped on that id.
 *
 * ## Divergences from OpencodeDriver, called out deliberately
 *
 * - **No shim preflight.** opencode fails closed when its hook plugin is
 *   absent; codex has no equivalent signal, because
 *   `--dangerously-bypass-hook-trust` *is* the enablement mechanism and emits
 *   no "the hooks loaded" marker to check.
 * - **`config.env` is forwarded unmodified.** opencode redirects
 *   `XDG_CONFIG_HOME` for hermeticity; codex needs no such redirect, and
 *   inventing one would break `codex login`'s stored credentials.
 * - **Exit 0 with no `turn.completed` is not fatal here.** opencode treats the
 *   analogous "no terminal step" as a failure (#992). #497 AC-3 scopes the
 *   equivalent fatal case to *exit≠0* with no `turn.completed`; failing the
 *   exit-0 case too would reject runs no evidence says are broken.
 * - **`isAvailable()` enforces the version floor.** opencode and aider leave
 *   floor-checking to `doctor`. #497 AC-10 asks for it here explicitly.
 *   Nothing on the execution path calls `isAvailable()` today, so this is
 *   inert until a caller opts in — a deliberate deviation, not an oversight.
 */

import { spawn, execFileSync } from "child_process";
import { isAbsolute, resolve as resolvePath } from "path";
import { RingBuffer } from "../ring-buffer.js";
import { SequantError, SubprocessError } from "../../errors.js";
import { compareVersions } from "../../version-check.js";
import type {
  AgentDriver,
  AgentExecutionConfig,
  AgentPhaseResult,
  ModelUsageEntry,
  ResumeHandle,
} from "./agent-driver.js";
import type { CodexSettings } from "../../settings.js";
// Types only — see the note about AC-8 in this file's header comment.
import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";

/**
 * Minimum codex version this driver was verified against (the #497 probe ran
 * 0.154.0). The CLI moved 0.149 → 0.154 in 20 days, so expect this to need
 * bumping often.
 */
export const CODEX_MIN_VERSION = "0.154.0";

/** Sandbox policy used when `settings.sandboxMode` is unset. */
const DEFAULT_SANDBOX_MODE = "workspace-write";

/**
 * `modelUsage` key when no model was pinned.
 *
 * codex reports usage per *turn*, never naming the model that produced it, so
 * an unpinned run genuinely cannot know which model answered. A placeholder
 * key keeps the counters attributable to this driver rather than silently
 * merging into another backend's totals in `sequant stats`.
 */
const DEFAULT_MODEL_KEY = "codex-default";

/** Lines retained in each RingBuffer tail. */
const TAIL_LINES = 50;

/** Per-line cap before a line reaches a RingBuffer tail. */
const TAIL_LINE_CHARS = 2000;

/** Distinct failure codes this driver can report (#497 AC-3). */
export const CODEX_ERROR_CODES = {
  /** A `turn.failed` event — the model's turn itself errored. */
  turnFailed: "turn-failed",
  /** A top-level `{"type":"error"}` event on the stream. */
  streamError: "stream-error",
  /** Non-zero exit with no `turn.completed` — the turn never finished. */
  noTerminalTurn: "no-terminal-turn",
} as const;

/** Everything the parser extracts from a run's JSONL stream. */
export interface CodexParsedStream {
  /** Concatenated `agent_message.text` items, in stream order. */
  output: string;
  /** `thread.started.thread_id` — the resume token. */
  threadId?: string;
  /**
   * `item.completed` items of type `error`. Non-fatal by the SDK's own doc
   * comment; surfaced so the hook-trust banner is visible rather than eaten.
   */
  warnings: string[];
  /** Messages from top-level `error` events (fatal). */
  errors: string[];
  /** `turn.failed`'s error message, when the turn failed (fatal). */
  turnFailure?: string;
  /** True once a `turn.completed` event arrived. */
  sawTurnCompleted: boolean;
  /** Synthesized from `turn.completed.usage`; single-keyed (see above). */
  modelUsage?: Record<string, ModelUsageEntry>;
  /** `command_execution` item ids seen, deduped across started/completed. */
  commandExecutions: string[];
  /** Lines that were not valid JSON. */
  parseFailures: number;
}

/**
 * Chunk-safe JSONL reader.
 *
 * `feed` may be called with arbitrary byte-boundary chunks; a line is only
 * parsed once its terminating newline arrives. `end` flushes a trailing
 * unterminated line.
 */
export class CodexStreamParser {
  private buffer = "";
  private readonly texts: string[] = [];
  private readonly commandIds = new Set<string>();

  private readonly state: CodexParsedStream = {
    output: "",
    warnings: [],
    errors: [],
    sawTurnCompleted: false,
    commandExecutions: [],
    parseFailures: 0,
  };

  /**
   * @param model - Resolved model, used as the single `modelUsage` key.
   * @param onWarning - Called as each non-fatal `error` item is parsed, so a
   *   verbose run surfaces the hook-trust banner live rather than at the end.
   */
  constructor(
    private readonly model?: string,
    private readonly onWarning?: (message: string) => void,
  ) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      this.consumeLine(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
    }
  }

  end(): CodexParsedStream {
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer);
      this.buffer = "";
    }
    this.state.output = this.texts.join("");
    this.state.commandExecutions = [...this.commandIds];
    return this.state;
  }

  private consumeLine(raw: string): void {
    const line = raw.trim();
    if (line.length === 0) return;

    let event: ThreadEvent;
    try {
      event = JSON.parse(line) as ThreadEvent;
    } catch {
      this.state.parseFailures++;
      return;
    }

    switch (event.type) {
      case "thread.started":
        this.state.threadId = event.thread_id;
        break;

      case "turn.completed":
        this.state.sawTurnCompleted = true;
        this.state.modelUsage = {
          [this.model ?? DEFAULT_MODEL_KEY]: toModelUsage(event.usage),
        };
        break;

      case "turn.failed":
        this.state.turnFailure = event.error?.message ?? "unknown codex error";
        break;

      case "error":
        this.state.errors.push(event.message ?? "unknown codex error");
        break;

      case "item.started":
      case "item.updated":
      case "item.completed":
        this.consumeItem(event.item, event.type);
        break;

      default:
        break;
    }
  }

  private consumeItem(item: ThreadItem, eventType: string): void {
    if (item.type === "command_execution") {
      // Arrives as item.started (no exit_code) then item.completed under the
      // same id; counting both would double every shell call.
      this.commandIds.add(item.id);
      return;
    }
    // Only terminal items contribute text or warnings — an item.started
    // agent_message would otherwise be concatenated twice.
    if (eventType !== "item.completed") return;

    if (item.type === "agent_message") {
      this.texts.push(item.text);
      return;
    }
    if (item.type === "error") {
      this.state.warnings.push(item.message);
      this.onWarning?.(item.message);
    }
  }
}

/**
 * Map codex's per-turn `usage` onto the shared `ModelUsageEntry` (#986).
 *
 * `reasoning_output_tokens` is a **breakdown of** `output_tokens`, not an
 * addition to it — the same shape as the Responses API's
 * `output_tokens_details.reasoning_tokens`. Every run the #497 probe recorded
 * shows it: `output_tokens - reasoning_output_tokens` equals the visible
 * agent text (fixture: 3306 - 3200 = 106 tokens for ~165 chars; a `PONG`
 * reply reports 6 output / 0 reasoning). So `outputTokens` takes
 * `output_tokens` as-is; summing the two would double-count reasoning and
 * roughly double the output figure `sequant stats` reports for codex.
 * `costUSD` is left undefined — codex reports no cost figure.
 */
function toModelUsage(usage: Usage): ModelUsageEntry {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cached_input_tokens,
    cacheCreationInputTokens: usage.cache_write_input_tokens,
  };
}

/** Process outcome the evaluator needs alongside the parsed stream. */
export interface CodexRunOutcome {
  exitCode: number | null;
  signal: string | null;
  /** Seconds allowed, for the timeout message. */
  phaseTimeout: number;
  stderrTail: string[];
  stdoutTail: string[];
}

/**
 * Map a completed run to an `AgentPhaseResult` (#497 AC-3).
 *
 * Three fatal levels, each with its own code so a caller can tell a failed
 * turn from a dead stream from a process that never finished one:
 * `turn.failed`, a top-level `error` event, and a non-zero exit with no
 * `turn.completed`. A non-fatal `error` *item* is none of these.
 *
 * @internal Exported for testing.
 */
export function evaluateCodexRun(
  parsed: CodexParsedStream,
  outcome: CodexRunOutcome,
): AgentPhaseResult {
  const base = {
    output: parsed.output,
    stderrTail: outcome.stderrTail,
    stdoutTail: outcome.stdoutTail,
    exitCode: outcome.exitCode ?? undefined,
    ...(parsed.modelUsage ? { modelUsage: parsed.modelUsage } : {}),
  };

  const fail = (error: string, structuredError?: SequantError) => ({
    ...base,
    success: false,
    error,
    ...(structuredError ? { structuredError } : {}),
  });

  if (outcome.signal) {
    const isTimeout = outcome.signal === "SIGTERM";
    return fail(
      isTimeout
        ? `Timeout after ${outcome.phaseTimeout}s`
        : `Process killed by signal: ${outcome.signal}`,
    );
  }

  if (parsed.turnFailure !== undefined) {
    return fail(
      `codex turn failed: ${parsed.turnFailure}`,
      new SequantError(parsed.turnFailure, {
        metadata: { code: CODEX_ERROR_CODES.turnFailed },
      }),
    );
  }

  if (parsed.errors.length > 0) {
    return fail(
      `codex reported an error: ${parsed.errors.join("; ")}`,
      new SequantError(parsed.errors.join("; "), {
        metadata: { code: CODEX_ERROR_CODES.streamError },
      }),
    );
  }

  if (outcome.exitCode !== 0) {
    // A non-zero exit that never completed a turn is the distinct case: the
    // run died mid-turn, so the transcript is partial by construction.
    if (!parsed.sawTurnCompleted) {
      return fail(
        `codex exited with code ${outcome.exitCode} without completing a turn ` +
          `(${CODEX_ERROR_CODES.noTerminalTurn}).`,
        new SequantError(CODEX_ERROR_CODES.noTerminalTurn, {
          isRetryable: true,
          metadata: { code: CODEX_ERROR_CODES.noTerminalTurn },
        }),
      );
    }
    return fail(
      `codex exited with code ${outcome.exitCode}`,
      new SubprocessError(`codex exited with code ${outcome.exitCode}`, {
        command: "codex exec",
        exitCode: outcome.exitCode ?? undefined,
        stderr: outcome.stderrTail.join("\n"),
      }),
    );
  }

  return { ...base, success: true };
}

/**
 * Build the codex argument list.
 *
 * The prompt is positional and must stay last. `-s` is passed explicitly
 * because `codex exec` defaults to a **read-only** sandbox, which cannot write
 * the worktree a phase exists to modify.
 *
 * A resume drops `-C` and `-s`: `exec resume` accepts neither, and Codex
 * silently adopts the caller's cwd (openai/codex#4791), which is what makes
 * `canResume`'s `originCwd` check the only real guard.
 *
 * @internal Exported for testing.
 */
/**
 * Absolute path to the git directory that owns `cwd`'s index, or null when
 * `cwd` is not a git repository (or git is unavailable).
 *
 * `--git-common-dir` rather than `--git-dir`: in a worktree the index lives
 * under the *main* repo's `.git/worktrees/<name>/`, and that whole tree is
 * what the sandbox must be able to write. It resolves to the ordinary `.git`
 * for a normal checkout, so one command covers both.
 *
 * Never throws — a driver that cannot answer this still runs the phase, it
 * just leaves the sandbox as codex configured it.
 *
 * @internal Exported for testing.
 */
export function resolveGitCommonDir(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return null;
    // `--git-common-dir` answers relatively (".git") from the repo root, so
    // it is resolved against cwd before it reaches a sandbox policy that has
    // no notion of the phase's working directory.
    return isAbsolute(out) ? out : resolvePath(cwd, out);
  } catch {
    return null;
  }
}

export function buildCodexArgs(
  prompt: string,
  config: Pick<AgentExecutionConfig, "cwd" | "phase">,
  settings?: CodexSettings,
  resumeToken?: string,
): string[] {
  const sandboxMode = settings?.sandboxMode ?? DEFAULT_SANDBOX_MODE;
  const args = resumeToken
    ? ["exec", "resume", resumeToken, "--json"]
    : ["exec", "--json", "-C", config.cwd, "-s", sandboxMode];

  // #1076: `workspace-write` makes the workspace writable but excludes
  // `.git/`, so every `git add`/`git commit` a phase runs is denied with
  // `Unable to create '…/index.lock': Operation not permitted` — measured on
  // the #1060 gate run, where exec produced correct edits it could not commit.
  // The exclusion is not worktree-specific: a plain clone whose `.git` sits
  // inside the workspace fails identically. Naming the git dir as a writable
  // root keeps the sandbox otherwise intact, which `danger-full-access` would
  // not — sequant's guard hooks are meant to run inside a sandbox, not instead
  // of one. `read-only` has nothing to write and `danger-full-access` is
  // already unrestricted, so neither needs it.
  if (sandboxMode === "workspace-write") {
    const gitDir = resolveGitCommonDir(config.cwd);
    if (gitDir) {
      args.push(
        "-c",
        `sandbox_workspace_write.writable_roots=${JSON.stringify([gitDir])}`,
      );
    }
  }

  args.push("--dangerously-bypass-hook-trust");
  if (settings?.model) args.push("-m", settings.model);
  if (settings?.extraArgs) args.push(...settings.extraArgs);
  args.push(prompt);

  return args;
}

/**
 * Message naming the version floor when `codex --version` is below it, or
 * null when it satisfies the floor.
 *
 * Mirrors `getNodeVersionError`'s shape in `version-check.ts` (whose
 * `compareVersions` it reuses) rather than `doctor.ts`'s `isVersionBelow`:
 * importing from `commands/` into `lib/` would invert the layer boundary.
 * An unparseable or missing version is reported as an error too — a codex that
 * cannot state its version cannot be verified against the floor.
 *
 * @internal Exported for testing.
 */
export function getCodexVersionError(
  versionOutput: string | null,
): string | null {
  const match = versionOutput?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return (
      `codex CLI not found, or its version could not be parsed. ` +
      `sequant requires codex >= ${CODEX_MIN_VERSION}.`
    );
  }
  const current = match[0];
  if (compareVersions(current, CODEX_MIN_VERSION) >= 0) return null;
  return (
    `codex ${current} is below the minimum supported version ` +
    `${CODEX_MIN_VERSION}. Upgrade with: npm i -g @openai/codex`
  );
}

export class CodexDriver implements AgentDriver {
  name = "codex";

  /**
   * codex resolves skills from `.agents/skills` (a symlink to
   * `.claude/skills`), so the #813 skills preflight stays active. Until
   * `sequant init --agent codex` lands, that symlink has to be created by
   * hand — the preflight fails loudly when it is missing, which is the
   * intended behaviour rather than a silent unguarded run.
   */
  resolvesSkills = true;
  usesSdkMcp = false;

  private settings?: CodexSettings;

  constructor(settings?: CodexSettings) {
    this.settings = settings;
  }

  /**
   * codex invokes a skill by name: `$spec 1`, not `Run the /spec 1 workflow.`
   *
   * The #497 probe verified explicit `$skill` resolution in headless
   * `codex exec` (probe §AC-1) and recorded the prompt shape as
   * `$<phase> <issue>` — "the skill name, not a rewritten prompt". The
   * argument is passed positionally exactly as the Claude Code skills expect
   * it, so the same SKILL.md serves both drivers unchanged.
   */
  buildSkillPrompt(skill: string, issue: number): string {
    return `$${skill} ${issue}`;
  }

  /**
   * `codex exec resume` accepts no `-C` and silently adopts the caller's cwd
   * (openai/codex#4791), so resuming a thread from a different worktree would
   * replay it against the wrong tree with nothing upstream refusing. The #674
   * contract — driver-tag equality plus a byte-equal `originCwd` — is the only
   * guard that exists.
   */
  canResume(handle: ResumeHandle, targetCwd: string): boolean {
    return handle.driver === this.name && handle.originCwd === targetCwd;
  }

  async executePhase(
    prompt: string,
    config: AgentExecutionConfig,
  ): Promise<AgentPhaseResult> {
    const resumeToken =
      config.resumeHandle && this.canResume(config.resumeHandle, config.cwd)
        ? config.resumeHandle.token
        : undefined;
    const args = buildCodexArgs(prompt, config, this.settings, resumeToken);

    return new Promise<AgentPhaseResult>((resolve) => {
      // #497 AC-6: forward each non-fatal error item as it is parsed, so the
      // hook-trust banner and model-metadata notice reach verbose logs
      // instead of being swallowed by a run that ultimately succeeded.
      const parser = new CodexStreamParser(this.settings?.model, (message) =>
        config.onStderr?.(`codex warning: ${message}\n`),
      );
      const stderrBuffer = new RingBuffer(TAIL_LINES);
      const stdoutBuffer = new RingBuffer(TAIL_LINES);

      const proc = spawn("codex", args, {
        cwd: config.cwd,
        env: {
          ...(process.env as Record<string, string>),
          ...config.env,
        },
        // stdin MUST be "ignore": `codex exec` treats a non-TTY pipe as prompt
        // input and blocks until EOF, which presents as a phase timeout with
        // zero events (probe AC-7 — two paid runs lost to exactly this).
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group so a timeout or Ctrl+C reaps the whole codex tree
        // rather than orphaning it or taking the harness down with it
        // (#856/#934).
        detached: true,
      });

      let settled = false;
      const finish = (result: AgentPhaseResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const killGroup = () => killProcessGroup(proc.pid);
      const timeoutId = setTimeout(killGroup, config.phaseTimeout * 1000);

      if (config.abortSignal) {
        const onAbort = () => killGroup();
        config.abortSignal.addEventListener("abort", onAbort);
        proc.on("close", () => {
          config.abortSignal?.removeEventListener("abort", onAbort);
        });
      }

      proc.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        parser.feed(text);
        pushLines(stdoutBuffer, text);
        if (config.verbose) {
          config.onOutput?.(text);
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        pushLines(stderrBuffer, text);
        config.onStderr?.(text);
      });

      proc.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timeoutId);
        const parsed = parser.end();
        finish({
          success: false,
          output: parsed.output,
          error:
            err.code === "ENOENT"
              ? "codex CLI not found. Install it with: npm i -g @openai/codex"
              : `Failed to start codex: ${err.message}`,
          stderrTail: stderrBuffer.getLines(),
          stdoutTail: stdoutBuffer.getLines(),
        });
      });

      proc.on("close", (code: number | null, signal: string | null) => {
        clearTimeout(timeoutId);
        const parsed = parser.end();
        const result = evaluateCodexRun(parsed, {
          exitCode: code,
          signal,
          phaseTimeout: config.phaseTimeout,
          stderrTail: stderrBuffer.getLines(),
          stdoutTail: stdoutBuffer.getLines(),
        });
        finish(
          parsed.threadId
            ? {
                ...result,
                resumeHandle: {
                  driver: this.name,
                  token: parsed.threadId,
                  originCwd: config.cwd,
                },
              }
            : result,
        );
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const version = execFileSync("codex", ["--version"], {
        stdio: "pipe",
      }).toString();
      return getCodexVersionError(version) === null;
    } catch {
      // No binary on PATH, or it failed to report a version at all.
      return false;
    }
  }
}

/** Split a chunk into lines and push a capped form of each into `buffer`. */
function pushLines(buffer: RingBuffer, text: string): void {
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    buffer.push(
      line.length > TAIL_LINE_CHARS
        ? `${line.slice(0, TAIL_LINE_CHARS)}… [${line.length} chars]`
        : line,
    );
  }
}

/**
 * SIGTERM the whole process group, swallowing ESRCH.
 *
 * `detached: true` makes the child a group leader, so `-pid` addresses the
 * tree. ESRCH just means it already exited between the check and the signal.
 */
function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      // Fall back to signalling the child directly — better a killed leader
      // than a run that ignores its timeout.
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }
}
