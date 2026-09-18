/**
 * CodexDriver tests (#497).
 *
 * Everything asserted here is measured against the recorded fixture from the
 * #497 probe — a real `codex exec --json ... --dangerously-bypass-hook-trust`
 * stream (10 events, paths scrubbed), documented in
 * `docs/investigations/codex-driver-probe-2026-09.md`. The fixture contains no
 * `turn.failed` and no top-level `error` event, so the AC-3 mutations that need
 * them are synthesized from the SDK's own exported event types and labelled as
 * such — same convention as opencode.test.ts's synthetic error-event case.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import * as childProcess from "child_process";
import {
  CodexDriver,
  CodexStreamParser,
  CODEX_ERROR_CODES,
  CODEX_MIN_VERSION,
  buildCodexArgs,
  evaluateCodexRun,
  getCodexVersionError,
  type CodexParsedStream,
} from "./codex.js";
import type { SandboxMode } from "@openai/codex-sdk";
import type { CodexSettings } from "../../settings.js";
import type { AgentExecutionConfig } from "./agent-driver.js";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const mockExecFileSync = vi.mocked(childProcess.execFileSync);

// Every spawn assertion reads `mock.calls[0]`, so recorded calls must not
// carry over between tests.
beforeEach(() => {
  mockSpawn.mockClear();
  mockExecFileSync.mockClear();
});

const FIXTURE_PATH = join(
  __dirname,
  "__fixtures__",
  "codex-exec-skill-hook.jsonl",
);

function readFixture(): string {
  return readFileSync(FIXTURE_PATH, "utf-8");
}

function fixtureEvents(): Array<Record<string, unknown>> {
  return readFixture()
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Rebuild the fixture with the AC-3 mutations applied. */
function mutate(opts: {
  dropTurnCompleted?: boolean;
  append?: Record<string, unknown>;
}): string {
  let events = fixtureEvents();
  if (opts.dropTurnCompleted) {
    events = events.filter((e) => e.type !== "turn.completed");
  }
  if (opts.append) events.push(opts.append);
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function parse(stream: string, model?: string): CodexParsedStream {
  const parser = new CodexStreamParser(model);
  parser.feed(stream);
  return parser.end();
}

function outcome(over: Partial<Parameters<typeof evaluateCodexRun>[1]> = {}) {
  return {
    exitCode: 0,
    signal: null,
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
}

function createMockProcess(options: MockProcOptions = {}) {
  const stdoutListeners: Array<(data: Buffer) => void> = [];
  const stderrListeners: Array<(data: Buffer) => void> = [];
  const processListeners: Record<
    string,
    Array<(...args: unknown[]) => void>
  > = {};

  const proc = {
    pid: 5150,
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

function baseConfig(over: Partial<AgentExecutionConfig> = {}) {
  return {
    cwd: "/wt/codex",
    phase: "qa",
    env: {},
    phaseTimeout: 1800,
    verbose: false,
    mcp: false,
    ...over,
  } as AgentExecutionConfig;
}

// ── AC-1: parses the recorded fixture ───────────────────────────────────────

describe("497 AC-1: CodexStreamParser against the recorded fixture", () => {
  it("497 AC-1 concatenates agent_message.text items into output", () => {
    const parsed = parse(readFixture());

    expect(parsed.output).toContain("I'll run the probe skill");
    expect(parsed.output).toContain("SKILL_OK");
    expect(parsed.parseFailures).toBe(0);
  });

  it("497 AC-1 reads thread.started.thread_id as the resume token", () => {
    const parsed = parse(readFixture());
    expect(parsed.threadId).toBe("01a09759-a395-71f1-8082-2877a06a36fc");
  });

  it("497 AC-1 maps turn.completed.usage's five counters into modelUsage", () => {
    const parsed = parse(readFixture(), "gpt-5-codex");

    // `usage` is one object per turn with no model field, so the map is
    // synthesized under the resolved model as its single key.
    expect(Object.keys(parsed.modelUsage ?? {})).toEqual(["gpt-5-codex"]);
    const entry = parsed.modelUsage!["gpt-5-codex"];

    expect(entry.inputTokens).toBe(28271);
    expect(entry.cacheReadInputTokens).toBe(18816);
    expect(entry.cacheCreationInputTokens).toBe(0);
    // The fifth counter, `reasoning_output_tokens` (3200), is a breakdown of
    // `output_tokens` (3306), not an addition to it: 3306 - 3200 = 106 is the
    // visible agent text (#1058 AC-11). outputTokens must be output_tokens
    // as-is — summing the two would double-count reasoning.
    expect(entry.outputTokens).toBe(3306);
    // codex reports no cost figure — fabricating a zero would read as "free".
    expect(entry.costUSD).toBeUndefined();
  });

  it("497 AC-1 keys modelUsage under a codex placeholder when no model is pinned", () => {
    const parsed = parse(readFixture());
    expect(Object.keys(parsed.modelUsage ?? {})).toEqual(["codex-default"]);
  });

  it("497 AC-1 the three item.completed/error items do not set success false", () => {
    const parsed = parse(readFixture());

    expect(parsed.warnings).toHaveLength(3);
    expect(evaluateCodexRun(parsed, outcome()).success).toBe(true);
  });

  it("497 AC-1 dedupes command_execution on item.id across started and completed", () => {
    // The fixture emits item_4 twice — item.started (no exit_code) then
    // item.completed. Counting both would double every shell call.
    const parsed = parse(readFixture());
    expect(parsed.commandExecutions).toEqual(["item_4"]);
  });

  it("497 AC-1b is chunk-safe: a 64-byte-chunked feed matches a single-shot feed", () => {
    const stream = readFixture();
    const single = parse(stream);

    const chunked = new CodexStreamParser();
    for (let i = 0; i < stream.length; i += 64) {
      chunked.feed(stream.slice(i, i + 64));
    }
    const result = chunked.end();

    expect(result.output).toBe(single.output);
    expect(result.threadId).toBe(single.threadId);
    expect(result.parseFailures).toBe(0);
  });

  it("497 AC-1 surfaces the fixture's thread id as a cwd-bound resumeHandle", async () => {
    mockSpawn.mockReturnValue(
      createMockProcess({ stdout: [readFixture()] }) as never,
    );

    const result = await new CodexDriver().executePhase(
      "$qa 497",
      baseConfig(),
    );

    expect(result.success).toBe(true);
    expect(result.resumeHandle).toEqual({
      driver: "codex",
      token: "01a09759-a395-71f1-8082-2877a06a36fc",
      originCwd: "/wt/codex",
    });
  });
});

// ── AC-3: three-level outcome classification ────────────────────────────────

describe("497 AC-3: three-level outcome classification", () => {
  it("497 AC-3(a) turn.failed is fatal even on a clean exit", () => {
    // Synthetic: the recorded run succeeded, so no turn.failed exists in it.
    // Shape taken from the SDK's TurnFailedEvent ({ error: ThreadError }).
    const stream = mutate({
      dropTurnCompleted: true,
      append: {
        type: "turn.failed",
        error: { message: "model stream aborted" },
      },
    });
    const result = evaluateCodexRun(parse(stream), outcome({ exitCode: 0 }));

    expect(result.success).toBe(false);
    expect(result.error).toContain("model stream aborted");
    expect(result.structuredError?.metadata.code).toBe(
      CODEX_ERROR_CODES.turnFailed,
    );
  });

  it("497 AC-3(b) a top-level error event is fatal", () => {
    // Synthetic; shape taken from the SDK's ThreadErrorEvent.
    const stream = mutate({
      append: { type: "error", message: "upstream exploded" },
    });
    const result = evaluateCodexRun(parse(stream), outcome());

    expect(result.success).toBe(false);
    expect(result.error).toContain("upstream exploded");
    expect(result.structuredError?.metadata.code).toBe(
      CODEX_ERROR_CODES.streamError,
    );
  });

  it("497 AC-3(c) exit != 0 with no turn.completed fails with a distinct code", () => {
    const parsed = parse(mutate({ dropTurnCompleted: true }));
    expect(parsed.sawTurnCompleted).toBe(false);

    const result = evaluateCodexRun(parsed, outcome({ exitCode: 1 }));

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.structuredError?.metadata.code).toBe(
      CODEX_ERROR_CODES.noTerminalTurn,
    );
  });

  it("497 AC-3(d) an added item.completed/error alone is still a success", () => {
    const stream = mutate({
      append: {
        type: "item.completed",
        item: {
          id: "item_extra",
          type: "error",
          message: "a fourth, unrelated warning",
        },
      },
    });
    const parsed = parse(stream);

    expect(parsed.warnings).toHaveLength(4);
    expect(evaluateCodexRun(parsed, outcome()).success).toBe(true);
  });

  it("497 AC-3 the three fatal levels carry three DIFFERENT codes", () => {
    // "Distinct codes" is the AC's own wording: three equal codes would let a
    // caller conflate a failed turn with a dead stream.
    const codes = [
      CODEX_ERROR_CODES.turnFailed,
      CODEX_ERROR_CODES.streamError,
      CODEX_ERROR_CODES.noTerminalTurn,
    ];
    expect(new Set(codes).size).toBe(3);
  });

  it("497 AC-3 a non-zero exit AFTER a completed turn is a SubprocessError", () => {
    const result = evaluateCodexRun(
      parse(readFixture()),
      outcome({ exitCode: 3, stderrTail: ["boom"] }),
    );

    expect(result.success).toBe(false);
    expect(result.structuredError?.name).toBe("SubprocessError");
  });

  it("497 AC-3 a SIGTERM close is reported as a timeout", () => {
    const result = evaluateCodexRun(
      parse(readFixture()),
      outcome({ exitCode: null, signal: "SIGTERM", phaseTimeout: 42 }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("Timeout after 42s");
  });
});

// ── AC-2: spawn contract ────────────────────────────────────────────────────

describe("497 AC-2: buildCodexArgs and the spawn contract", () => {
  it("497 AC-2 builds exec --json -C <cwd> -s workspace-write --dangerously-bypass-hook-trust <prompt>", () => {
    const args = buildCodexArgs("$qa 497", { cwd: "/wt", phase: "qa" });

    expect(args).toEqual([
      "exec",
      "--json",
      "-C",
      "/wt",
      "-s",
      "workspace-write",
      // #1079: network access is on by default under workspace-write. `/wt`
      // is not a git repo, so no writable_roots override appears here.
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--dangerously-bypass-hook-trust",
      "$qa 497",
    ]);
  });

  it("497 AC-2 inserts -m <model> before the positional prompt", () => {
    const args = buildCodexArgs(
      "$qa 497",
      { cwd: "/wt", phase: "qa" },
      { model: "gpt-5-codex" },
    );

    expect(args).toEqual([
      "exec",
      "--json",
      "-C",
      "/wt",
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "--dangerously-bypass-hook-trust",
      "-m",
      "gpt-5-codex",
      "$qa 497",
    ]);
  });

  it("497 AC-2 wires settings.sandboxMode rather than hardcoding workspace-write", () => {
    const args = buildCodexArgs(
      "$qa 497",
      { cwd: "/wt", phase: "qa" },
      { sandboxMode: "read-only" },
    );
    expect(args).toContain("read-only");
    expect(args).not.toContain("workspace-write");
  });

  it("497 AC-2 keeps the prompt last when extraArgs are configured", () => {
    // The prompt is positional; an extraArg appended after it would be parsed
    // as a second positional and silently change the command.
    const args = buildCodexArgs(
      "$qa 497",
      { cwd: "/wt", phase: "qa" },
      { extraArgs: ["--config", "model_reasoning_effort=high"] },
    );
    expect(args[args.length - 1]).toBe("$qa 497");
    expect(args).toContain("--config");
  });

  it("497 AC-2 spawns with stdio ignore/pipe/pipe, detached, cwd and unmodified env", async () => {
    mockSpawn.mockReturnValue(
      createMockProcess({ stdout: [readFixture()] }) as never,
    );

    await new CodexDriver().executePhase(
      "$qa 497",
      baseConfig({ env: { SEQUANT_ISSUE: "497" } }),
    );

    const [bin, , opts] = mockSpawn.mock.calls[0] as unknown as [
      string,
      string[],
      {
        stdio: string[];
        detached?: boolean;
        env: Record<string, string>;
        cwd: string;
      },
    ];
    expect(bin).toBe("codex");
    // stdin must be "ignore": `codex exec` reads a non-TTY pipe as prompt
    // input and blocks until EOF (probe AC-7 — two paid runs lost to it).
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(opts.detached).toBe(true);
    expect(opts.cwd).toBe("/wt/codex");
    expect(opts.env.SEQUANT_ISSUE).toBe("497");
    // Unlike OpencodeDriver, codex gets no XDG redirect or injected config.
    expect(opts.env.XDG_CONFIG_HOME).toBe(process.env.XDG_CONFIG_HOME);
  });

  it("497 AC-2 fills both RingBuffer tails and sets exitCode", async () => {
    mockSpawn.mockReturnValue(
      createMockProcess({
        stdout: [readFixture()],
        stderr: ["a codex stderr line\n"],
        exitCode: 0,
      }) as never,
    );

    const result = await new CodexDriver().executePhase(
      "$qa 497",
      baseConfig(),
    );

    expect(result.stdoutTail?.length).toBeGreaterThan(0);
    expect(result.stderrTail).toContain("a codex stderr line");
    expect(result.exitCode).toBe(0);
    for (const line of result.stdoutTail ?? []) {
      expect(line.length).toBeLessThan(2100);
    }
  });

  it("497 AC-2 abort SIGTERMs the whole process group, not just the child", async () => {
    const realKill = process.kill;
    const signalled: Array<[number, string | number | undefined]> = [];
    process.kill = ((pid: number, signal?: string | number) => {
      signalled.push([pid, signal]);
      return true;
    }) as typeof process.kill;

    try {
      const proc = createMockProcess({ hang: true });
      mockSpawn.mockReturnValue(proc as never);

      const controller = new AbortController();
      const pending = new CodexDriver().executePhase(
        "$qa 497",
        baseConfig({ abortSignal: controller.signal }),
      );

      await new Promise((r) => setTimeout(r, 5));
      controller.abort();
      proc.close();
      await pending;

      // Negative pid addresses the group; a plain `proc.kill()` would orphan
      // codex's children (#856/#934).
      expect(signalled).toContainEqual([-5150, "SIGTERM"]);
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      process.kill = realKill;
    }
  });

  it("497 AC-2 reports an install hint when codex is not on PATH", async () => {
    const enoent: NodeJS.ErrnoException = new Error("spawn codex ENOENT");
    enoent.code = "ENOENT";
    mockSpawn.mockReturnValue(createMockProcess({ error: enoent }) as never);

    const result = await new CodexDriver().executePhase(
      "$qa 497",
      baseConfig(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("codex CLI not found");
  });
});

// ── AC-6: warnings surfaced, not swallowed ──────────────────────────────────

describe("497 AC-6: warnings surfaced, not swallowed", () => {
  it("497 AC-6 parses the hook-trust banner and model-metadata notice", () => {
    const parsed = parse(readFixture());

    expect(parsed.warnings).toHaveLength(3);
    expect(parsed.warnings.join(" ")).toContain(
      "dangerously-bypass-hook-trust",
    );
    expect(parsed.warnings.join(" ")).toContain("Model metadata");
  });

  it("497 AC-6 forwards each warning to config.onStderr without failing the run", async () => {
    mockSpawn.mockReturnValue(
      createMockProcess({ stdout: [readFixture()] }) as never,
    );

    const onStderr = vi.fn();
    const result = await new CodexDriver().executePhase(
      "$qa 497",
      baseConfig({ onStderr }),
    );

    const forwarded = onStderr.mock.calls.map((c) => String(c[0])).join("\n");
    expect(forwarded).toContain("Model metadata");
    expect(forwarded).toContain("dangerously-bypass-hook-trust");
    expect(result.success).toBe(true);
  });
});

// ── AC-8: SDK is types-only ─────────────────────────────────────────────────

describe("497 AC-8: @openai/codex-sdk is types-only", () => {
  it("497 AC-8 the SDK is a devDependency, never a runtime dependency", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "../../../../package.json"), "utf-8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.devDependencies?.["@openai/codex-sdk"]).toBeDefined();
    expect(pkg.dependencies?.["@openai/codex-sdk"]).toBeUndefined();
  });

  it("497 AC-8 codex.ts imports the SDK only with `import type`", () => {
    // A value import would survive into dist/ and break the AC's grep, even
    // though the symbols themselves are types.
    const src = readFileSync(join(__dirname, "codex.ts"), "utf-8");
    // Scoped to import statements: the file's header comment names the SDK in
    // prose, and matching the whole file would judge that prose instead.
    const sdkImports = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) && l.includes("@openai/codex-sdk"));

    expect(sdkImports.length).toBeGreaterThan(0);
    for (const line of sdkImports) {
      expect(line.trimStart().startsWith("import type")).toBe(true);
    }
  });

  it("497 AC-8 CodexSettings.sandboxMode stays structurally identical to the SDK's SandboxMode", () => {
    // settings.ts deliberately re-declares this union instead of importing
    // SandboxMode, so nothing references the devDependency in the emitted
    // .d.ts. That duplication is only safe while the two cannot drift.
    const fromSdk: SandboxMode[] = [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ];
    const asSettings: NonNullable<CodexSettings["sandboxMode"]>[] = fromSdk;
    const backToSdk: SandboxMode[] = asSettings;
    expect(backToSdk).toEqual(fromSdk);
  });
});

// ── AC-10: version floor ────────────────────────────────────────────────────

describe("497 AC-10: version floor", () => {
  it("497 AC-10 CODEX_MIN_VERSION is pinned to the probed version", () => {
    expect(CODEX_MIN_VERSION).toBe("0.154.0");
  });

  it("497 AC-10 a below-floor version yields a message naming the floor", () => {
    const message = getCodexVersionError("codex-cli 0.153.0");
    expect(message).not.toBeNull();
    expect(message).toContain("0.153.0");
    expect(message).toContain(CODEX_MIN_VERSION);
  });

  it("497 AC-10 an at-or-above-floor version yields no message", () => {
    expect(getCodexVersionError("codex-cli 0.154.0")).toBeNull();
    expect(getCodexVersionError("codex-cli 0.160.2")).toBeNull();
    expect(getCodexVersionError("codex-cli 1.0.0")).toBeNull();
  });

  it("497 AC-10 an unparseable version names the floor rather than passing", () => {
    const message = getCodexVersionError("codex: command not found");
    expect(message).toContain(CODEX_MIN_VERSION);
  });

  it("497 AC-10 isAvailable() is false below the floor and true at it", async () => {
    mockExecFileSync.mockReturnValue(Buffer.from("codex-cli 0.153.0\n"));
    expect(await new CodexDriver().isAvailable()).toBe(false);

    mockExecFileSync.mockReturnValue(Buffer.from("codex-cli 0.154.0\n"));
    expect(await new CodexDriver().isAvailable()).toBe(true);
  });

  it("497 AC-10 isAvailable() is false when the codex binary is absent", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(await new CodexDriver().isAvailable()).toBe(false);
  });

  it("497 AC-10 isAvailable() asks codex for its version", async () => {
    mockExecFileSync.mockReturnValue(Buffer.from("codex-cli 0.154.0\n"));
    await new CodexDriver().isAvailable();

    expect(mockExecFileSync).toHaveBeenCalledWith(
      "codex",
      ["--version"],
      expect.objectContaining({ stdio: "pipe" }),
    );
  });
});

// ── Driver declarations ─────────────────────────────────────────────────────

describe("497 CodexDriver declarations", () => {
  it("497 declares resolvesSkills and opts out of the SDK's MCP plumbing", () => {
    const driver = new CodexDriver();
    expect(driver.name).toBe("codex");
    // codex reads .agents/skills, the same tree the #813 preflight validates.
    expect(driver.resolvesSkills).toBe(true);
    // Gates the "retrying without MCP" fallback — codex shells out to its own
    // CLI and never reads config.mcp, so the retry would re-run an identical
    // command (#592).
    expect(driver.usesSdkMcp).toBe(false);
  });
});
