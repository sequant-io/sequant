/**
 * OpencodeDriver — AgentDriver implementation wrapping the opencode CLI (#862).
 *
 * opencode is the first backend that reads `.claude/skills/` natively, so
 * phases dispatch through a thin `.opencode/commands/<phase>.md` wrapper that
 * tells the model to load the sequant skill of the same name:
 *
 *   opencode run --command <phase> <prompt> --format json --auto --dir <cwd>
 *
 * Everything this driver believes about opencode's output was measured against
 * the recorded fixture in `__fixtures__/opencode-run-qa.ndjson` (#992), not
 * against the docs. The three findings that shape the code below:
 *
 * 1. Single NDJSON lines reach 100 KB, so the reader must accumulate chunks and
 *    split on newlines — a line-at-a-time or fixed-buffer reader corrupts them.
 * 2. The tool name is `part.tool`, not `part.name`, and the skill tool's own
 *    metadata is at `part.state.metadata` — `part.metadata` is *provider*
 *    metadata and resolves to `undefined`, so a truncation guard written there
 *    silently never fires.
 * 3. `step_finish.part.cost` is per step, and a hung run emits no `step_finish`
 *    at all — so a run that exits 0 without a terminal `reason: "stop"` is a
 *    failure, not a success.
 */

import { spawn } from "child_process";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RingBuffer } from "../ring-buffer.js";
import { SequantError, SubprocessError } from "../../errors.js";
import type {
  AgentDriver,
  AgentExecutionConfig,
  AgentPhaseResult,
  ResumeHandle,
} from "./agent-driver.js";
import type { OpencodeSettings } from "../../settings.js";

/**
 * Minimum opencode version this driver was verified against (#992 spike ran
 * 1.18.27). Doctor pins the same floor.
 */
export const OPENCODE_MIN_VERSION = "1.18.27";

/** Lines retained in each RingBuffer tail. */
const TAIL_LINES = 50;

/**
 * Per-line cap before a line reaches a RingBuffer tail. The fixture's longest
 * line is 100 KB; 50 of those would pin 5 MB in memory for a diagnostic tail.
 */
const TAIL_LINE_CHARS = 2000;

/** Distinct failure codes this driver can report (#862 AC-4). */
export const OPENCODE_ERROR_CODES = {
  /** No `skill` tool call for this phase — the wrapper failed to load it. */
  skillNotLoaded: "skill-not-loaded",
  /**
   * The skill tool truncated the SKILL.md body and the model never paged
   * through the rest, so it acted on a fraction of the methodology.
   */
  skillTruncated: "skill-truncated",
  /** Exit 0 with no terminal step — a hung or clamped run (#992). */
  noTerminalStep: "no-terminal-step",
  /** opencode emitted an `error` event on the stream. */
  streamError: "stream-error",
  /**
   * The hook shim is not installed in the phase's working directory, so the
   * phase would run with none of sequant's guards (#996 AC-7).
   */
  hooksNotInstalled: "hooks-not-installed",
} as const;

/** One NDJSON envelope. Only the fields this driver reads are typed. */
interface OpencodeEvent {
  type?: string;
  sessionID?: string;
  part?: {
    type?: string;
    text?: string;
    tool?: string;
    cost?: number;
    reason?: string;
    state?: {
      input?: { filePath?: string };
      metadata?: {
        name?: string;
        dir?: string;
        truncated?: boolean;
        outputPath?: string;
      };
    };
    error?: unknown;
    message?: string;
  };
  error?: unknown;
  message?: string;
}

/** Everything the parser extracts from a run's NDJSON stream. */
export interface OpencodeParsedStream {
  /** Concatenated `text` parts, in stream order. */
  output: string;
  /** Session id from the event envelope — present even on a failed run. */
  sessionId?: string;
  /** True when a `skill` tool call named the phase's skill. */
  skillLoaded: boolean;
  /** `part.state.metadata.truncated` on that skill call. */
  skillTruncated: boolean;
  /**
   * Count of `read` tool calls, after the skill call, targeting the skill's
   * own directory or its truncation `outputPath`. This — not the truncation
   * flag alone — is what distinguishes a model that noticed the truncation and
   * paged through the rest from one that silently reviewed on 29% of the skill.
   */
  skillFollowUpReads: number;
  /** Summed `step_finish.part.cost` (per step, so it must be summed). */
  costUsd: number;
  /** True once a `step_finish` reported `reason: "stop"`. */
  sawTerminalStop: boolean;
  /** Messages from `error` events. */
  errors: string[];
  /** Lines that were not valid JSON. */
  parseFailures: number;
}

/**
 * Chunk-safe NDJSON reader.
 *
 * `feed` may be called with arbitrary byte-boundary chunks; a line is only
 * parsed once its terminating newline arrives. `end` flushes a trailing
 * unterminated line.
 */
export class OpencodeStreamParser {
  private buffer = "";
  private readonly texts: string[] = [];
  private skillDir?: string;
  private skillOutputPath?: string;

  private readonly state: OpencodeParsedStream = {
    output: "",
    skillLoaded: false,
    skillTruncated: false,
    skillFollowUpReads: 0,
    costUsd: 0,
    sawTerminalStop: false,
    errors: [],
    parseFailures: 0,
  };

  /**
   * @param phase - Phase whose skill must appear for the marker check. When
   *   undefined (ad-hoc prompt with no `--command`), any `skill` tool call
   *   counts as loaded.
   */
  constructor(private readonly phase?: string) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      this.consumeLine(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
    }
  }

  end(): OpencodeParsedStream {
    if (this.buffer.length > 0) {
      this.consumeLine(this.buffer);
      this.buffer = "";
    }
    this.state.output = this.texts.join("");
    return this.state;
  }

  private consumeLine(raw: string): void {
    const line = raw.trim();
    if (line.length === 0) return;

    let event: OpencodeEvent;
    try {
      event = JSON.parse(line) as OpencodeEvent;
    } catch {
      this.state.parseFailures++;
      return;
    }

    if (event.sessionID) {
      this.state.sessionId = event.sessionID;
    }

    const part = event.part;
    switch (event.type) {
      case "text":
        if (typeof part?.text === "string") this.texts.push(part.text);
        break;

      case "step_finish":
        if (typeof part?.cost === "number") this.state.costUsd += part.cost;
        if (part?.reason === "stop") this.state.sawTerminalStop = true;
        break;

      case "tool_use":
        this.consumeToolUse(part);
        break;

      case "error":
        this.state.errors.push(describeError(event));
        break;

      default:
        break;
    }
  }

  private consumeToolUse(part: OpencodeEvent["part"]): void {
    // Tool name lives at `part.tool` — `part.name` does not exist (#992).
    if (part?.tool === "skill") {
      const meta = part.state?.metadata;
      if (!this.phase || meta?.name === this.phase) {
        this.state.skillLoaded = true;
        this.state.skillTruncated = meta?.truncated === true;
        this.skillDir = meta?.dir;
        this.skillOutputPath = meta?.outputPath;
      }
      return;
    }

    if (part?.tool === "read" && this.state.skillLoaded) {
      const filePath = part.state?.input?.filePath;
      if (!filePath) return;
      const targetsSkill =
        (this.skillDir !== undefined && filePath.startsWith(this.skillDir)) ||
        (this.skillOutputPath !== undefined &&
          filePath === this.skillOutputPath);
      if (targetsSkill) this.state.skillFollowUpReads++;
    }
  }
}

/** Process outcome the evaluator needs alongside the parsed stream. */
export interface OpencodeRunOutcome {
  exitCode: number | null;
  signal: string | null;
  /** Phase the run was dispatched for; undefined disables the marker check. */
  phase?: string;
  /** Seconds allowed, for the timeout message. */
  phaseTimeout: number;
  stderrTail: string[];
  stdoutTail: string[];
}

/**
 * Map a completed run to an `AgentPhaseResult`.
 *
 * Ordering is deliberate: process-level failures are reported before the
 * skill checks, because "opencode exited 3" is more actionable than "the skill
 * never loaded" when both are true. `success` still requires the marker, so
 * the AC-4 guarantee holds either way.
 *
 * @internal Exported for testing.
 */
export function evaluateOpencodeRun(
  parsed: OpencodeParsedStream,
  outcome: OpencodeRunOutcome,
): AgentPhaseResult {
  const base = {
    output: parsed.output,
    stderrTail: outcome.stderrTail,
    stdoutTail: outcome.stdoutTail,
    exitCode: outcome.exitCode ?? undefined,
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
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

  if (parsed.errors.length > 0) {
    return fail(
      `opencode reported an error: ${parsed.errors.join("; ")}`,
      new SequantError(parsed.errors.join("; "), {
        metadata: { code: OPENCODE_ERROR_CODES.streamError },
      }),
    );
  }

  if (outcome.exitCode !== 0) {
    return fail(
      `opencode exited with code ${outcome.exitCode}`,
      new SubprocessError(`opencode exited with code ${outcome.exitCode}`, {
        command: "opencode run",
        exitCode: outcome.exitCode ?? undefined,
        stderr: outcome.stderrTail.join("\n"),
      }),
    );
  }

  // #992: a run whose step never closed exits 0 with an empty workspace and
  // sums to $0.00 under the per-step cost method. Exit code alone cannot tell
  // it apart from a clean run — the absent terminal step can.
  if (!parsed.sawTerminalStop) {
    return fail(
      `opencode exited 0 without completing a step (${OPENCODE_ERROR_CODES.noTerminalStep}). ` +
        `The run produced no terminal 'step_finish reason: "stop"', which is how a ` +
        `clamped or hung step presents.`,
      new SequantError(OPENCODE_ERROR_CODES.noTerminalStep, {
        isRetryable: true,
        metadata: { code: OPENCODE_ERROR_CODES.noTerminalStep },
      }),
    );
  }

  if (outcome.phase && !parsed.skillLoaded) {
    return fail(
      `opencode never loaded the '${outcome.phase}' skill (${OPENCODE_ERROR_CODES.skillNotLoaded}). ` +
        `The phase ran without sequant's methodology, so its output is not a ` +
        `'${outcome.phase}' result. Check .opencode/commands/${outcome.phase}.md exists ` +
        `(sequant init --agent opencode) and that .claude/skills/${outcome.phase}/SKILL.md is present.`,
      new SequantError(OPENCODE_ERROR_CODES.skillNotLoaded, {
        metadata: {
          code: OPENCODE_ERROR_CODES.skillNotLoaded,
          phase: outcome.phase,
        },
      }),
    );
  }

  // Truncation on its own is not fatal: opencode's skill tool caps the in-band
  // body at ~51 KB and every sequant SKILL.md exceeds that, so failing on the
  // flag alone would brick the backend on day one. The discriminator is
  // whether the model then paged through the rest — the GO run issued five
  // follow-up reads (#992 OQ-1).
  if (parsed.skillTruncated && parsed.skillFollowUpReads === 0) {
    return fail(
      `opencode's skill tool truncated '${outcome.phase}' and the model never read the ` +
        `remainder (${OPENCODE_ERROR_CODES.skillTruncated}). It acted on a fraction of the ` +
        `skill, so the output cannot be trusted as a '${outcome.phase}' result.`,
      new SequantError(OPENCODE_ERROR_CODES.skillTruncated, {
        isRetryable: true,
        metadata: {
          code: OPENCODE_ERROR_CODES.skillTruncated,
          phase: outcome.phase,
        },
      }),
    );
  }

  return { ...base, success: true };
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` payload (#862 AC-8).
 *
 * The 32K per-step completion clamp is mitigated per model, via
 * `provider.<p>.models.<m>.options.reasoning.max_tokens` — so the payload can
 * only be emitted when the model is known. Returns undefined otherwise.
 *
 * No `/tmp` permission rule is injected: #992's controls could not reproduce
 * the `/tmp` kill on 1.18.27 and it is not opencode's permission system
 * (OQ-19). See `docs/investigations/opencode-driver-spike.md`.
 *
 * @internal Exported for testing.
 */
export function buildOpencodeConfigContent(
  settings?: OpencodeSettings,
): string | undefined {
  const { model, reasoningMaxTokens } = settings ?? {};
  if (!model || !reasoningMaxTokens) return undefined;

  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1) return undefined;
  const providerId = model.slice(0, separator);
  const modelId = model.slice(separator + 1);

  return JSON.stringify({
    provider: {
      [providerId]: {
        models: {
          [modelId]: {
            options: { reasoning: { max_tokens: reasoningMaxTokens } },
          },
        },
      },
    },
  });
}

/**
 * Build the opencode argument list.
 *
 * @internal Exported for testing.
 */
export function buildOpencodeArgs(
  prompt: string,
  config: Pick<AgentExecutionConfig, "cwd" | "phase" | "resumeHandle">,
  settings?: OpencodeSettings,
  resumeToken?: string,
): string[] {
  const args = ["run"];
  if (config.phase) args.push("--command", config.phase);
  args.push(prompt, "--format", "json", "--auto", "--dir", config.cwd);

  if (settings?.model) args.push("--model", settings.model);
  if (settings?.variant) args.push("--variant", settings.variant);
  if (resumeToken) args.push("--session", resumeToken);
  if (settings?.extraArgs) args.push(...settings.extraArgs);

  return args;
}

export class OpencodeDriver implements AgentDriver {
  name = "opencode";

  /**
   * opencode reads `.claude/skills/` natively — the same tree the #813 skills
   * preflight validates — so the preflight stays active for this driver.
   */
  resolvesSkills = true;
  usesSdkMcp = false;

  private settings?: OpencodeSettings;

  constructor(settings?: OpencodeSettings) {
    this.settings = settings;
  }

  /**
   * opencode sessions are stored per config dir and replayed against a working
   * directory, so resuming one from a different cwd would run a session whose
   * recorded file state does not match the tree. Enforce the #674 contract:
   * driver-tag equality plus a byte-equal originCwd.
   */
  canResume(handle: ResumeHandle, targetCwd: string): boolean {
    return handle.driver === this.name && handle.originCwd === targetCwd;
  }

  async executePhase(
    prompt: string,
    config: AgentExecutionConfig,
  ): Promise<AgentPhaseResult> {
    // #996 AC-7: fail closed before spending a phase. The shim must be in the
    // *worktree*, not just the main checkout — see findShimIn.
    if (!findShimIn(config.cwd)) {
      return {
        success: false,
        output: "",
        error:
          `The sequant hook shim is not installed in ${config.cwd}. An opencode phase ` +
          `there would run with no force-push, commit, or worktree guards. ` +
          `Run \`sequant init --agent opencode\` and commit .opencode/ so worktrees inherit it.`,
        structuredError: new SequantError(
          "opencode hook shim missing from the phase working directory",
          { metadata: { code: OPENCODE_ERROR_CODES.hooksNotInstalled } },
        ),
      };
    }

    const resumeToken =
      config.resumeHandle && this.canResume(config.resumeHandle, config.cwd)
        ? config.resumeHandle.token
        : undefined;
    const args = buildOpencodeArgs(prompt, config, this.settings, resumeToken);
    const configHome = createRunConfigHome(this.settings);

    return new Promise<AgentPhaseResult>((resolve) => {
      const parser = new OpencodeStreamParser(config.phase);
      const stderrBuffer = new RingBuffer(TAIL_LINES);
      const stdoutBuffer = new RingBuffer(TAIL_LINES);

      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...config.env,
        // Only an XDG_CONFIG_HOME redirect is hermetic — OPENCODE_CONFIG and
        // OPENCODE_CONFIG_CONTENT both *merge* with the user's global
        // opencode.jsonc, and `--pure` disables plugins, not config (#992
        // Finding 1). XDG_DATA_HOME is deliberately left alone: auth lives
        // there, and redirecting it would log the user out of their provider.
        XDG_CONFIG_HOME: configHome.path,
      };
      if (configHome.content) {
        env.OPENCODE_CONFIG_CONTENT = configHome.content;
      }

      const proc = spawn("opencode", args, {
        cwd: config.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group so a timeout or Ctrl+C in the orchestrating
        // session reaps the whole opencode tree rather than orphaning it or
        // taking the harness down with it (#856/#934, reproduced in #992).
        detached: true,
      });

      let settled = false;
      const finish = (result: AgentPhaseResult) => {
        if (settled) return;
        settled = true;
        configHome.cleanup();
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
              ? "opencode CLI not found. Install it with: npm i -g opencode-ai"
              : `Failed to start opencode: ${err.message}`,
          stderrTail: stderrBuffer.getLines(),
          stdoutTail: stdoutBuffer.getLines(),
        });
      });

      proc.on("close", (code: number | null, signal: string | null) => {
        clearTimeout(timeoutId);
        const parsed = parser.end();
        const result = evaluateOpencodeRun(parsed, {
          exitCode: code,
          signal,
          phase: config.phase,
          phaseTimeout: config.phaseTimeout,
          stderrTail: stderrBuffer.getLines(),
          stdoutTail: stdoutBuffer.getLines(),
        });
        finish(
          parsed.sessionId
            ? {
                ...result,
                resumeHandle: {
                  driver: this.name,
                  token: parsed.sessionId,
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
      execFileSync("which", ["opencode"], { stdio: "pipe" });
      return true;
    } catch {
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

/** Best-effort description of an `error` event's payload. */
function describeError(event: OpencodeEvent): string {
  const candidate =
    event.part?.error ?? event.error ?? event.part?.message ?? event.message;
  if (typeof candidate === "string") return candidate;
  if (candidate == null) return "unknown opencode error";
  if (typeof candidate === "object") {
    const obj = candidate as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.name === "string") return obj.name;
  }
  return JSON.stringify(candidate);
}

/**
 * Shim locations checked before a phase runs (#996 AC-7). Mirrors
 * `OPENCODE_SHIM_PATHS` in doctor; both load on 1.18.27.
 */
const SHIM_RELATIVE_PATHS = [
  ".opencode/plugin/sequant-hooks.ts",
  ".opencode/plugins/sequant-hooks.ts",
] as const;

/**
 * Fail closed when the hook shim is absent from the phase's working directory.
 *
 * This is not redundant with doctor's AC-2 check. Doctor runs in the **main
 * checkout**; a phase runs in a **git worktree**, which carries tracked files
 * only. `.opencode/` is untracked by default, so an uncommitted shim is
 * present for doctor and absent for every phase — unguarded, and invisible to
 * the check that was supposed to catch exactly this.
 *
 * @internal Exported for testing.
 */
export function findShimIn(cwd: string): string | undefined {
  return SHIM_RELATIVE_PATHS.find((rel) => existsSync(join(cwd, rel)));
}

/**
 * Create the per-run `XDG_CONFIG_HOME` and write sequant's opencode config
 * into it.
 *
 * The redirect isolates the run from the user's global `opencode.jsonc`, which
 * is the only mechanism that actually isolates (#992 Finding 1). The trade-off
 * is that the user's own opencode config no longer applies under sequant —
 * `run.opencode.extraArgs` is the documented escape hatch.
 */
function createRunConfigHome(settings?: OpencodeSettings): {
  path: string;
  content?: string;
  cleanup: () => void;
} {
  const content = buildOpencodeConfigContent(settings);
  const path = mkdtempSync(join(tmpdir(), "sequant-opencode-"));
  try {
    const configDir = join(path, "opencode");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "opencode.json"), content ?? "{}", "utf-8");
  } catch {
    // A config we could not write is a degraded run, not a failed one — the
    // redirect itself (an empty dir) still delivers the hermeticity.
  }
  return {
    path,
    content,
    cleanup: () => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Leaving a temp dir behind is not worth failing a completed phase.
      }
    },
  };
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
