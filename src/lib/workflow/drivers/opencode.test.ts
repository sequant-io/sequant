/**
 * OpencodeDriver tests (#862).
 *
 * Everything asserted here is measured against the recorded fixture from the
 * #992 spike — a real `opencode run --command qa <issue> --format json --auto`
 * stream, 93 events, paths scrubbed. Where the fixture cannot supply a case
 * (no `error` event was ever recorded), the synthetic line is labelled as such.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as childProcess from "child_process";
import {
  OpencodeDriver,
  OpencodeStreamParser,
  OPENCODE_ERROR_CODES,
  OPENCODE_MIN_VERSION,
  buildOpencodeArgs,
  buildOpencodeConfigContent,
  evaluateOpencodeRun,
  findShimIn,
  SHIM_LOADED_SENTINEL,
  type OpencodeParsedStream,
} from "./opencode.js";
import { RateLimitError, SequantError } from "../../errors.js";
import type { AgentExecutionConfig } from "./agent-driver.js";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);

// Every spawn assertion reads `mock.calls[0]`, so the recorded calls must not
// carry over between tests.
beforeEach(() => {
  mockSpawn.mockClear();
});

const FIXTURE_PATH = join(__dirname, "__fixtures__", "opencode-run-qa.ndjson");

function readFixture(): string {
  return readFileSync(FIXTURE_PATH, "utf-8");
}

/** Fixture lines with the `skill` tool_use event removed (AC-4 negative). */
function fixtureWithoutSkillEvent(): string {
  return readFixture()
    .split("\n")
    .filter((line) => {
      if (line.trim().length === 0) return false;
      try {
        const event = JSON.parse(line) as { part?: { tool?: string } };
        return event.part?.tool !== "skill";
      } catch {
        return true;
      }
    })
    .join("\n");
}

/** Fixture lines with the follow-up `read` calls on the skill removed. */
function fixtureWithoutFollowUpReads(): string {
  return readFixture()
    .split("\n")
    .filter((line) => {
      if (line.trim().length === 0) return false;
      try {
        const event = JSON.parse(line) as {
          part?: { tool?: string; state?: { input?: { filePath?: string } } };
        };
        if (event.part?.tool !== "read") return true;
        return !event.part.state?.input?.filePath?.includes(
          "/.claude/skills/qa",
        );
      } catch {
        return true;
      }
    })
    .join("\n");
}

function parse(stream: string, phase?: string): OpencodeParsedStream {
  const parser = new OpencodeStreamParser(phase);
  parser.feed(stream);
  return parser.end();
}

function outcome(
  over: Partial<Parameters<typeof evaluateOpencodeRun>[1]> = {},
) {
  return {
    exitCode: 0,
    signal: null,
    phase: "qa",
    phaseTimeout: 1800,
    stderrTail: [],
    stdoutTail: [],
    ...over,
  };
}

// ── Mock child process ──────────────────────────────────────────────────────

interface MockProcOptions {
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string[];
  stderr?: string[];
  error?: NodeJS.ErrnoException;
  /** Withhold `close` so the test can drive abort/timeout itself. */
  hang?: boolean;
  /**
   * Emit the shim's load sentinel on stderr (#996 AC-7). Defaults to true —
   * a real run with the guards live always emits it.
   */
  shimActive?: boolean;
}

function createMockProcess(options: MockProcOptions = {}) {
  const stdoutListeners: Array<(data: Buffer) => void> = [];
  const stderrListeners: Array<(data: Buffer) => void> = [];
  const processListeners: Record<
    string,
    Array<(...args: unknown[]) => void>
  > = {};

  const proc = {
    pid: 4242,
    stdout: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === "data") stdoutListeners.push(cb);
      }),
    },
    stderr: {
      on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === "data") stderrListeners.push(cb);
      }),
    },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (!processListeners[event]) processListeners[event] = [];
      processListeners[event].push(cb);
    }),
    kill: vi.fn(),
    close: () =>
      processListeners["close"]?.forEach((cb) =>
        cb(options.exitCode ?? 0, options.signal ?? null),
      ),
  };

  setTimeout(() => {
    for (const chunk of options.stdout ?? []) {
      stdoutListeners.forEach((cb) => cb(Buffer.from(chunk)));
    }
    // A real opencode run with the shim installed always announces it on
    // stderr (#996 AC-7). Default it on so every fixture models a *guarded*
    // run; `shimActive: false` opts into the unguarded case.
    if (options.shimActive !== false) {
      stderrListeners.forEach((cb) =>
        cb(Buffer.from(`${SHIM_LOADED_SENTINEL}\n`)),
      );
    }
    for (const chunk of options.stderr ?? []) {
      stderrListeners.forEach((cb) => cb(Buffer.from(chunk)));
    }
    if (options.error) {
      processListeners["error"]?.forEach((cb) => cb(options.error));
    } else if (!options.hang) {
      proc.close();
    }
  }, 0);

  return proc;
}

/**
 * A real directory containing the hook shim.
 *
 * #996 AC-7 makes `executePhase` fail closed when the shim is absent from the
 * phase cwd, so a fixture pointing at a non-existent path would now exercise
 * the preflight instead of the behaviour under test.
 */
const SHIM_CWD = mkdtempSync(join(tmpdir(), "sequant-opencode-cwd-"));
mkdirSync(join(SHIM_CWD, ".opencode/plugin"), { recursive: true });
writeFileSync(join(SHIM_CWD, ".opencode/plugin/sequant-hooks.ts"), "// shim\n");

function baseConfig(over: Partial<AgentExecutionConfig> = {}) {
  return {
    cwd: SHIM_CWD,
    phase: "qa",
    env: {},
    phaseTimeout: 1800,
    verbose: false,
    mcp: false,
    ...over,
  } as AgentExecutionConfig;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("862 OpencodeDriver — parser against the recorded fixture (AC-1)", () => {
  it("862 AC-1 concatenates text parts into output including the QA verdict", () => {
    const parsed = parse(readFixture(), "qa");

    expect(parsed.output).toContain("### Verdict: READY_FOR_MERGE");
    expect(parsed.output.length).toBeGreaterThan(8000);
    expect(parsed.parseFailures).toBe(0);
  });

  it("862 AC-1 reads the session id off the event envelope", () => {
    const parsed = parse(readFixture(), "qa");
    expect(parsed.sessionId).toBe("ses_f85b1aea3ffenqNLD1eXrjMF34");
  });

  it("862 AC-1 sums per-step cost and records the terminal stop", () => {
    const parsed = parse(readFixture(), "qa");

    // step_finish.cost is per step, not cumulative — a parser that took the
    // last value instead of the sum would report ~$0.0096 for a $1.12 run.
    expect(parsed.costUsd).toBeGreaterThan(1);
    expect(parsed.sawTerminalStop).toBe(true);
  });

  it("862 AC-1b is chunk-safe: an 8 KB-chunked feed matches a single-shot feed", () => {
    const stream = readFixture();
    const single = parse(stream, "qa");

    // The fixture's longest single line is 100 KB, so any reader that assumes
    // a chunk boundary is a line boundary corrupts it.
    const chunked = new OpencodeStreamParser("qa");
    for (let i = 0; i < stream.length; i += 8192) {
      chunked.feed(stream.slice(i, i + 8192));
    }
    const result = chunked.end();

    expect(result.output).toBe(single.output);
    expect(result.parseFailures).toBe(0);
    expect(result.sessionId).toBe(single.sessionId);
    expect(result.costUsd).toBeCloseTo(single.costUsd, 10);
  });

  it("862 AC-1 maps a synthetic error event to a structured failure", () => {
    // No `error` event exists in the recorded stream (spec AC-1 assumption),
    // so this line is synthetic and its shape is unverified against a real run.
    const synthetic = JSON.stringify({
      type: "error",
      sessionID: "ses_synthetic",
      part: { error: { message: "provider returned 500" } },
    });
    const parsed = parse(`${readFixture()}\n${synthetic}`, "qa");

    expect(parsed.errors).toEqual(["provider returned 500"]);

    const result = evaluateOpencodeRun(parsed, outcome());
    expect(result.success).toBe(false);
    expect(result.error).toContain("provider returned 500");
    expect(result.structuredError?.metadata.code).toBe(
      OPENCODE_ERROR_CODES.streamError,
    );
  });

  it("862 AC-1 forwards config.env and cwd to the spawn", async () => {
    const proc = createMockProcess({ stdout: [readFixture()] });
    mockSpawn.mockReturnValue(proc as never);

    const driver = new OpencodeDriver();
    await driver.executePhase(
      "/qa 862",
      baseConfig({ env: { SEQUANT_ISSUE: "862" } }),
    );

    const [, , opts] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(opts.cwd).toBe(SHIM_CWD);
    expect(opts.env.SEQUANT_ISSUE).toBe("862");
  });

  it("862 AC-1 populates both RingBuffer tails", async () => {
    const proc = createMockProcess({
      stdout: [readFixture()],
      stderr: ["a warning line\n"],
    });
    mockSpawn.mockReturnValue(proc as never);

    const driver = new OpencodeDriver();
    const result = await driver.executePhase("/qa 862", baseConfig());

    expect(result.stdoutTail?.length).toBeGreaterThan(0);
    expect(result.stderrTail).toContain("a warning line");
    // 100 KB fixture lines must not land in the tail verbatim.
    for (const line of result.stdoutTail ?? []) {
      expect(line.length).toBeLessThan(2100);
    }
  });

  it("862 AC-1 succeeds on the recorded fixture", async () => {
    const proc = createMockProcess({ stdout: [readFixture()] });
    mockSpawn.mockReturnValue(proc as never);

    const driver = new OpencodeDriver();
    const result = await driver.executePhase("/qa 862", baseConfig());

    expect(result.success).toBe(true);
    expect(result.output).toContain("### Verdict: READY_FOR_MERGE");
    expect(result.resumeHandle).toEqual({
      driver: "opencode",
      token: "ses_f85b1aea3ffenqNLD1eXrjMF34",
      originCwd: SHIM_CWD,
    });
  });
});

describe("862 OpencodeDriver — abort and timeout (AC-1)", () => {
  const realKill = process.kill;

  afterEach(() => {
    process.kill = realKill;
  });

  it("862 AC-1 abort SIGTERMs the whole process group, not just the child", async () => {
    const signalled: Array<[number, string | number | undefined]> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      signalled.push([pid, signal]);
      return true;
    }) as typeof process.kill;

    const proc = createMockProcess({ hang: true });
    mockSpawn.mockReturnValue(proc as never);

    const controller = new AbortController();
    const driver = new OpencodeDriver();
    const pending = driver.executePhase(
      "/qa 862",
      baseConfig({ abortSignal: controller.signal }),
    );

    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    proc.close();
    await pending;

    // Negative pid addresses the group; a plain `proc.kill()` would orphan
    // opencode's children (#856/#934).
    expect(signalled).toContainEqual([-4242, "SIGTERM"]);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("862 AC-1 spawns detached so the group exists to be killed", async () => {
    const proc = createMockProcess({ stdout: [readFixture()] });
    mockSpawn.mockReturnValue(proc as never);

    await new OpencodeDriver().executePhase("/qa 862", baseConfig());

    const [, , opts] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { detached?: boolean },
    ];
    expect(opts.detached).toBe(true);
  });

  it("862 AC-1 reports a SIGTERM close as a timeout", () => {
    const result = evaluateOpencodeRun(
      parse(readFixture(), "qa"),
      outcome({ exitCode: null, signal: "SIGTERM", phaseTimeout: 42 }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("Timeout after 42s");
  });
});

describe("862 AC-4 — skill-marker verification", () => {
  it("862 AC-4 fails with skill-not-loaded when no skill tool call is present", () => {
    const parsed = parse(fixtureWithoutSkillEvent(), "qa");
    expect(parsed.skillLoaded).toBe(false);

    const result = evaluateOpencodeRun(parsed, outcome());

    expect(result.success).toBe(false);
    expect(result.error).toContain(OPENCODE_ERROR_CODES.skillNotLoaded);
    expect(result.structuredError?.metadata.code).toBe(
      OPENCODE_ERROR_CODES.skillNotLoaded,
    );
    // The verdict text is still in the output, which is exactly the trap: a
    // caller must not treat it as a parsed QA result.
    expect(parsed.output).toContain("### Verdict: READY_FOR_MERGE");
  });

  it("862 AC-4 fails when the skill call names a different phase", () => {
    const parsed = parse(readFixture(), "exec");
    expect(parsed.skillLoaded).toBe(false);
    expect(
      evaluateOpencodeRun(parsed, outcome({ phase: "exec" })).error,
    ).toContain(OPENCODE_ERROR_CODES.skillNotLoaded);
  });

  it("862 AC-4 reads truncation from part.state.metadata, not part.metadata", () => {
    const parsed = parse(readFixture(), "qa");

    // part.metadata is *provider* metadata; a guard written there reads
    // undefined and never fires (#992 correction 1).
    expect(parsed.skillLoaded).toBe(true);
    expect(parsed.skillTruncated).toBe(true);
  });

  it("862 AC-4 truncation alone is not fatal when the model paged through the rest", () => {
    const parsed = parse(readFixture(), "qa");

    // Every sequant SKILL.md exceeds opencode's ~51 KB in-band cap, so failing
    // on the flag alone would brick the backend. The GO run's five follow-up
    // reads are the discriminator (#992 OQ-1).
    expect(parsed.skillFollowUpReads).toBe(5);
    expect(evaluateOpencodeRun(parsed, outcome()).success).toBe(true);
  });

  it("862 AC-4 truncation with no follow-up reads fails as skill-truncated", () => {
    const parsed = parse(fixtureWithoutFollowUpReads(), "qa");
    expect(parsed.skillTruncated).toBe(true);
    expect(parsed.skillFollowUpReads).toBe(0);

    const result = evaluateOpencodeRun(parsed, outcome());
    expect(result.success).toBe(false);
    expect(result.structuredError?.metadata.code).toBe(
      OPENCODE_ERROR_CODES.skillTruncated,
    );
  });

  it("862 AC-4 skips the marker check for a phaseless ad-hoc prompt", () => {
    const parsed = parse(fixtureWithoutSkillEvent());
    expect(
      evaluateOpencodeRun(parsed, outcome({ phase: undefined })).success,
    ).toBe(true);
  });
});

describe("862 AC-1a — exit 0 without a terminal step is a failure", () => {
  it("862 AC-1a fails when no step_finish reported reason 'stop'", () => {
    const noStop = readFixture()
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          const event = JSON.parse(line) as {
            type?: string;
            part?: { reason?: string };
          };
          return !(
            event.type === "step_finish" && event.part?.reason === "stop"
          );
        } catch {
          return true;
        }
      })
      .join("\n");

    const parsed = parse(noStop, "qa");
    expect(parsed.sawTerminalStop).toBe(false);

    const result = evaluateOpencodeRun(parsed, outcome({ exitCode: 0 }));
    expect(result.success).toBe(false);
    expect(result.structuredError?.metadata.code).toBe(
      OPENCODE_ERROR_CODES.noTerminalStep,
    );
  });

  it("862 AC-1a maps a non-zero exit to a SubprocessError", () => {
    const result = evaluateOpencodeRun(
      parse(readFixture(), "qa"),
      outcome({ exitCode: 3, stderrTail: ["boom"] }),
    );
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.structuredError?.name).toBe("SubprocessError");
  });
});

describe("862 AC-8 — #992 mitigations applied to the spawn", () => {
  const settings = {
    model: "openrouter/anthropic/claude-sonnet-5",
    reasoningMaxTokens: 20000,
  };

  it("862 AC-8 OPENCODE_CONFIG_CONTENT carries the per-model reasoning budget", async () => {
    const proc = createMockProcess({ stdout: [readFixture()] });
    mockSpawn.mockReturnValue(proc as never);

    await new OpencodeDriver(settings).executePhase("/qa 862", baseConfig());

    const [, , opts] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    expect(JSON.parse(opts.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      provider: {
        openrouter: {
          models: {
            "anthropic/claude-sonnet-5": {
              options: { reasoning: { max_tokens: 20000 } },
            },
          },
        },
      },
    });
  });

  it("862 AC-8 the budget is conditional on a known model", () => {
    // The key is per-model, so it cannot be emitted without one.
    expect(
      buildOpencodeConfigContent({ reasoningMaxTokens: 20000 }),
    ).toBeUndefined();
    expect(
      buildOpencodeConfigContent({ model: "openrouter/x/y" }),
    ).toBeUndefined();
    expect(buildOpencodeConfigContent(undefined)).toBeUndefined();
    // A bare model with no provider prefix has no place to hang the option.
    expect(
      buildOpencodeConfigContent({ model: "sonnet", reasoningMaxTokens: 1 }),
    ).toBeUndefined();
  });

  it("862 AC-8 sets a per-run XDG_CONFIG_HOME and leaves XDG_DATA_HOME alone", async () => {
    const proc = createMockProcess({ stdout: [readFixture()] });
    mockSpawn.mockReturnValue(proc as never);

    const before = process.env.XDG_DATA_HOME;
    await new OpencodeDriver(settings).executePhase("/qa 862", baseConfig());

    const [, , opts] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    // Only an XDG_CONFIG_HOME redirect is hermetic — the CONFIG_CONTENT and
    // CONFIG env vars both merge with the user's global opencode.jsonc.
    expect(opts.env.XDG_CONFIG_HOME).toMatch(/sequant-opencode-/);
    // Auth lives under XDG_DATA_HOME; redirecting it would log the user out.
    expect(opts.env.XDG_DATA_HOME).toBe(before);
  });

  it("862 AC-8 spawns detached", async () => {
    const proc = createMockProcess({ stdout: [readFixture()] });
    mockSpawn.mockReturnValue(proc as never);

    await new OpencodeDriver(settings).executePhase("/qa 862", baseConfig());

    const [, , opts] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { detached?: boolean },
    ];
    expect(opts.detached).toBe(true);
  });

  it("862 AC-8 injects no /tmp or $TMPDIR permission rule", async () => {
    // OQ-19: the spike's controls could not reproduce the /tmp permission kill
    // on 1.18.27 and identified it as not opencode's permission system, so no
    // rule is injected for it. See docs/investigations/opencode-driver-spike.md.
    const proc = createMockProcess({ stdout: [readFixture()] });
    mockSpawn.mockReturnValue(proc as never);

    await new OpencodeDriver(settings).executePhase("/qa 862", baseConfig());

    const [, args, opts] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> },
    ];
    const payload = opts.env.OPENCODE_CONFIG_CONTENT ?? "";
    expect(payload).not.toContain("permission");
    expect(payload).not.toContain("/tmp");
    expect(payload).not.toContain("TMPDIR");
    expect(args.join(" ")).not.toContain("/tmp");
  });
});

describe("862 AC-3 — argument construction", () => {
  it("862 AC-3 dispatches the phase through --command", () => {
    const args = buildOpencodeArgs("/qa 862", {
      cwd: "/wt",
      phase: "qa",
    });
    expect(args.slice(0, 3)).toEqual(["run", "--command", "qa"]);
    expect(args).toContain("--format");
    expect(args).toContain("json");
    expect(args).toContain("--auto");
    expect(args.slice(-2)).toEqual(["--dir", "/wt"]);
  });

  it("862 AC-3 omits --command for a phaseless prompt", () => {
    const args = buildOpencodeArgs("hello", { cwd: "/wt" });
    expect(args).not.toContain("--command");
    expect(args[1]).toBe("hello");
  });

  it("862 AC-3 appends model, variant and extraArgs from settings", () => {
    const args = buildOpencodeArgs(
      "/qa 862",
      { cwd: "/wt", phase: "qa" },
      {
        model: "openrouter/anthropic/claude-sonnet-5",
        variant: "thorough",
        extraArgs: ["--log-level", "debug"],
      },
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--model",
        "openrouter/anthropic/claude-sonnet-5",
        "--variant",
        "thorough",
        "--log-level",
        "debug",
      ]),
    );
  });

  it("862 AC-3 pins the verified minimum version", () => {
    expect(OPENCODE_MIN_VERSION).toBe("1.18.27");
  });
});

describe("862 OpencodeDriver — missing binary", () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it("862 reports an install hint when opencode is not on PATH", async () => {
    const enoent: NodeJS.ErrnoException = new Error("spawn opencode ENOENT");
    enoent.code = "ENOENT";
    mockSpawn.mockReturnValue(createMockProcess({ error: enoent }) as never);

    const result = await new OpencodeDriver().executePhase(
      "/qa 862",
      baseConfig(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("opencode CLI not found");
  });
});

describe("862 P1 errors", () => {
  it("maps an NDJSON error event to the stream-error class", () => {
    const parsed = parse(
      JSON.stringify({ type: "error", error: { message: "upstream exploded" } }) +
        "\n",
      "qa",
    );
    const result = evaluateOpencodeRun(parsed, {
      exitCode: 0,
      stderrTail: [],
      stdoutTail: [],
    });

    expect(result.success).toBe(false);
    expect(
      (result.structuredError as SequantError | undefined)?.metadata?.code,
    ).toBe(OPENCODE_ERROR_CODES.streamError);
  });

  it("never produces a RateLimitError for the opencode driver", () => {
    const parsed = parse(
      JSON.stringify({
        type: "error",
        error: { message: "429 rate limit exceeded, retry after 60s" },
      }) + "\n",
      "qa",
    );
    const result = evaluateOpencodeRun(parsed, {
      exitCode: 0,
      stderrTail: [],
      stdoutTail: [],
    });

    // The Claude-specific SDK retry paths key off RateLimitError; producing one
    // here would route an opencode failure into machinery it never uses.
    expect(result.structuredError).not.toBeInstanceOf(RateLimitError);
    expect(
      (result.structuredError as SequantError | undefined)?.metadata?.code,
    ).toBe(OPENCODE_ERROR_CODES.streamError);
  });

  it("declares that it does not use the SDK's MCP plumbing", () => {
    // This flag is what gates the "retrying without MCP" fallback in
    // executePhaseWithRetry. opencode shells out to its own CLI and never
    // reads config.mcp, so the retry would re-run an identical command.
    expect(new OpencodeDriver().usesSdkMcp).toBe(false);
  });
});

describe("862 P1 hooks preflight", () => {
  it("fails closed with hooks-not-installed when the shim is absent", async () => {
    const bare = mkdtempSync(join(tmpdir(), "sequant-opencode-noshim-"));
    try {
      const result = await new OpencodeDriver().executePhase(
        "hello",
        baseConfig({ cwd: bare }),
      );

      expect(result.success).toBe(false);
      expect(
        (result.structuredError as SequantError | undefined)?.metadata?.code,
      ).toBe(OPENCODE_ERROR_CODES.hooksNotInstalled);
      expect(result.error).toContain("hook shim is not installed");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("does not spawn opencode at all when the shim is missing", async () => {
    const bare = mkdtempSync(join(tmpdir(), "sequant-opencode-noshim2-"));
    const spawnSpy = vi.spyOn(childProcess, "spawn");
    try {
      await new OpencodeDriver().executePhase("hello", baseConfig({ cwd: bare }));
      // Fail closed means fail *before* spending the phase.
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it.each([
    ".opencode/plugin/sequant-hooks.ts",
    ".opencode/plugins/sequant-hooks.ts",
  ])("accepts the shim at %s", (rel) => {
    const dir = mkdtempSync(join(tmpdir(), "sequant-opencode-shimdir-"));
    try {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), "// shim\n");
      expect(findShimIn(dir)).toBe(rel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds no shim in an empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "sequant-opencode-empty-"));
    try {
      expect(findShimIn(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("862 P1 hooks preflight — load handshake", () => {
  it("fails a run whose shim never announced itself, even on a clean exit", async () => {
    // The dangerous case: opencode exits 0 with a full transcript, but the
    // plugin silently failed to load, so nothing was guarded. Verified real
    // on 1.18.27 — a scanned plugin exporting a constant is rejected with
    // "Plugin export is not a function", logged at ERROR and swallowed.
    const proc = createMockProcess({
      stdout: [readFixture()],
      shimActive: false,
    });
    mockSpawn.mockReturnValue(proc as never);

    const result = await new OpencodeDriver().executePhase(
      "/qa 862",
      baseConfig(),
    );

    expect(result.success).toBe(false);
    expect(
      (result.structuredError as SequantError | undefined)?.metadata?.code,
    ).toBe(OPENCODE_ERROR_CODES.hooksNotActive);
    expect(result.error).toContain("never loaded");
  });

  it("succeeds when the shim announced itself", async () => {
    const proc = createMockProcess({ stdout: [readFixture()] });
    mockSpawn.mockReturnValue(proc as never);

    const result = await new OpencodeDriver().executePhase(
      "/qa 862",
      baseConfig(),
    );

    expect(result.success).toBe(true);
  });

  it("keeps the sentinel byte-identical to the shipped shim template", () => {
    // A drifting sentinel would silently disable the handshake: every run
    // would look unguarded, or (worse, if the driver's copy were the loose
    // one) every run would look guarded.
    const shim = readFileSync(
      join(__dirname, "../../../../templates/opencode/plugins/lib/sequant-hooks-core.ts"),
      "utf-8",
    );
    expect(shim).toContain(`"${SHIM_LOADED_SENTINEL}"`);
  });
});
