/**
 * Driver conformance suite (#1096) — the contract every agent driver must
 * satisfy before it can run a phase.
 *
 * The Codex driver shipped 2026-09-15/16 and its first real run found three
 * gaps in a row: the sandbox excluded `.git` so no phase could commit (#1076),
 * network was off so no phase could reach `gh` (#1079), and a usage-limit
 * failure was typed `unknown` so `--auto-wait` and the billing skip never
 * engaged (#1087). None was a Codex-specific surprise — each is a contract the
 * Claude driver already satisfies implicitly, and nothing stated that contract
 * as tests a new driver has to pass.
 *
 * Six items, one `describe.each` over the registry:
 *
 *   1. commit     — `git add` + `git commit` succeed inside the driver's own
 *                   default sandbox, in a git worktree.
 *   2. network    — `gh api rate_limit` succeeds from inside that sandbox.
 *   3. errors     — quota exhaustion maps to `BillingError` (reset time in
 *                   metadata), a transient throttle to a retryable
 *                   `RateLimitError`, anything else to a `SequantError`
 *                   carrying the driver's own code.
 *   4. env        — the phase sees `SEQUANT_ORCHESTRATOR`, `SEQUANT_WORKTREE`,
 *                   `SEQUANT_PHASE`, `SEQUANT_ISSUE`.
 *   5. outcome    — the driver returns the structured outcome shape, with a
 *                   non-zero derived token total on a completed turn.
 *   6. skill load — the driver resolves the project-scope skill tree (#992,
 *                   generalized).
 *
 * The enumeration comes from `listDriverNames()`, never a hand-written list:
 * adding a driver to the registry without adding a conformance adapter fails
 * this suite (AC-1).
 *
 * **No mocks for the thing under test.** The codex sandbox probes run the real
 * `codex sandbox` with the writable roots the *driver itself* computed; the
 * subprocess env probes run the real `spawn` against a stub binary on PATH, so
 * what is asserted is the env a child process actually received. Only the
 * Claude Agent SDK is mocked, at the module edge, exactly as
 * `claude-code.test.ts` does — the driver loop itself stays real.
 *
 * Every item that cannot run records a **typed skip reason**, in one of three
 * forms (`assertSkipForm`), so "skipped" is never mistaken for "passed":
 *
 *   `structural: <why>`   the driver has no such concept (aider has no sandbox)
 *   `gap: #NNNN <what>`   the driver should support it and does not
 *   `unavailable: <what>` the environment cannot run the probe (no binary/key)
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Mock } from "vitest";
import { spawnSync, execFileSync } from "child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "fs";
import { tmpdir, homedir } from "os";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { getDriver, listDriverNames } from "../index.js";
import type {
  AgentExecutionConfig,
  AgentPhaseResult,
} from "../agent-driver.js";
import {
  SequantError,
  ApiError,
  RateLimitError,
  BillingError,
} from "../../../errors.js";
import {
  CodexStreamParser,
  evaluateCodexRun,
  buildCodexArgs,
  CODEX_ERROR_CODES,
} from "../codex.js";
import {
  OpencodeStreamParser,
  evaluateOpencodeRun,
  OPENCODE_ERROR_CODES,
} from "../opencode.js";

// The Claude driver reaches its agent through the SDK rather than a
// subprocess, so its seam is `query()`'s options. Mocked at the module edge
// only — the driver's own message loop runs for real. Same pattern as
// claude-code.test.ts.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const queryMock = query as unknown as Mock;

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
);

/** Seconds a probe that shells out is allowed. See the per-test third arg. */
const SUBPROCESS_TIMEOUT_MS = 60_000;

/**
 * The env every phase must see, for every driver (contract item 4).
 *
 * `SEQUANT_WORKTREE` carries a path shape rather than a token so a driver that
 * mangles paths on the way to the child is visible.
 */
const PHASE_ENV = {
  SEQUANT_ORCHESTRATOR: "sequant-run",
  SEQUANT_WORKTREE: "/tmp/sequant-conformance-worktree",
  SEQUANT_PHASE: "exec",
  SEQUANT_ISSUE: "1096",
} as const;

/** The gap issue backing every `gap:` skip this suite records (#1115). */
const GAP_ISSUE = 1115;

// ---------------------------------------------------------------------------
// Skip grammar
// ---------------------------------------------------------------------------

const SKIP_FORMS = [
  /^structural: \S/,
  /^gap: #\d+ \S/,
  /^unavailable: \S/,
] as const;

/**
 * Reject a skip reason that names nothing.
 *
 * This is what makes "or each skipped item names the tracking issue" (AC-5)
 * enforceable rather than a convention nobody checks. Called by every skip
 * path in this file, so a malformed reason fails the case that produced it —
 * not just the static audit below.
 */
function assertSkipForm(reason: string): void {
  const ok = SKIP_FORMS.some((form) => form.test(reason));
  expect(
    ok,
    `skip reason must match "structural: …", "gap: #NNNN …" or "unavailable: …", got: ${JSON.stringify(reason)}`,
  ).toBe(true);
}

/** Record a typed skip: validate its form, then surface it as a pass-with-note. */
function skipped(reason: string): void {
  assertSkipForm(reason);
  // Vitest has no "pass with a note" state, so the reason is printed. A typed
  // skip is the suite's declared outcome for an item that cannot apply — it is
  // not a silent pass, because the reason had to name a cause or an issue.
  console.log(`  ↳ skipped — ${reason}`);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Absolute paths of temp dirs this file created, for cleanup. */
const TEMP_DIRS: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  TEMP_DIRS.push(dir);
  return dir;
}

/** A real git repo with one commit, plus a real worktree of it. */
function gitFixture(): { repo: string; worktree: string } {
  const repo = tempDir("sequant-conf-repo-");
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "conformance@sequant.test");
  git("config", "user.name", "conformance");
  // Signing turns every commit in the suite into a keychain prompt (see the
  // repo's own hermetic-git note).
  git("config", "commit.gpgsign", "false");
  git("commit", "-q", "--allow-empty", "-m", "root");

  const worktree = join(repo, "..", `${basename(repo)}-wt`);
  TEMP_DIRS.push(worktree);
  git("worktree", "add", "-q", "--detach", worktree);
  return { repo, worktree };
}

function whichOk(binary: string): boolean {
  return (
    spawnSync("which", [binary], { stdio: "ignore", timeout: 10_000 })
      .status === 0
  );
}

/** Token total the driver boundary can actually derive, per token-utils. */
function tokensUsedOf(result: AgentPhaseResult): number {
  const usage = result.modelUsage;
  if (!usage) return 0;
  return Object.values(usage).reduce(
    (sum, e) => sum + (e.inputTokens ?? 0) + (e.outputTokens ?? 0),
    0,
  );
}

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

/** Drive a codex JSONL fixture through the real parser + outcome evaluator. */
function codexOutcome(fixture: string, exitCode = 1): AgentPhaseResult {
  const parser = new CodexStreamParser();
  parser.feed(loadFixture(fixture));
  return evaluateCodexRun(parser.end(), {
    exitCode,
    signal: null,
    phaseTimeout: 600,
    stderrTail: [],
    stdoutTail: [],
  });
}

/**
 * Capture the env a driver's child process actually received.
 *
 * A stub binary of the driver's own name is placed on a PATH handed to the
 * driver through `config.env`, and dumps its environment to a file. The real
 * `spawn` runs, so what comes back is the env that crossed the process
 * boundary — not the object the test passed in. If a driver dropped
 * `config.env`, the stub would not be found and no dump would exist.
 */
function captureChildEnv(
  binary: string,
  run: (config: AgentExecutionConfig) => Promise<unknown>,
  prepareCwd?: (cwd: string) => void,
): Promise<Record<string, string>> {
  const binDir = tempDir("sequant-conf-bin-");
  const cwd = tempDir("sequant-conf-cwd-");
  prepareCwd?.(cwd);
  const dump = join(binDir, "env.dump");

  writeFileSync(
    join(binDir, binary),
    `#!/bin/sh\nenv > "$SEQUANT_CONFORMANCE_ENV_DUMP"\nexit 0\n`,
    { mode: 0o755 },
  );

  const config: AgentExecutionConfig = {
    cwd,
    env: {
      ...PHASE_ENV,
      SEQUANT_CONFORMANCE_ENV_DUMP: dump,
      // Node resolves a spawned binary from the *child's* PATH, so this is
      // what routes the driver's own `spawn("codex", …)` to the stub.
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    phaseTimeout: 30,
    verbose: false,
    mcp: false,
  };

  return run(config).then(() => {
    if (!existsSync(dump)) {
      throw new Error(
        `${binary} stub never ran, or the driver dropped config.env — no env dump at ${dump}`,
      );
    }
    const env: Record<string, string> = {};
    for (const line of readFileSync(dump, "utf-8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return env;
  });
}

// ---------------------------------------------------------------------------
// Sandbox policies (contract items 1 and 2)
// ---------------------------------------------------------------------------

interface SandboxRunner {
  /** Label naming the policy actually applied, for the test output. */
  label: string;
  /** Run a command in `cwd` under the policy; returns its exit status. */
  run(cmd: string[], cwd: string): number | null;
  cleanup(): void;
}

type SandboxPolicy =
  | { kind: "none"; reason: string }
  | {
      kind: "policy";
      /** Build a runner for commands in `cwd`, or a typed skip. */
      prepare(cwd: string): SandboxRunner | { skip: string };
    };

/** Run commands with no wrapper — for drivers that impose no sandbox. */
function unsandboxedRunner(reason: string): SandboxRunner {
  return {
    label: `unsandboxed (${reason})`,
    run: (cmd, cwd) =>
      spawnSync(cmd[0], cmd.slice(1), {
        cwd,
        stdio: "ignore",
        timeout: SUBPROCESS_TIMEOUT_MS,
      }).status,
    cleanup: () => {},
  };
}

/**
 * The real `codex sandbox`, configured from the *driver's own* decisions.
 *
 * The writable roots are read back out of `buildCodexArgs`, not hand-written:
 * dropping the `.git` root from the driver (the #1076 fix) makes the commit
 * probe below fail, which is the whole point. codex-cli 0.154.0 expresses a
 * sandbox for the `sandbox` subcommand as a named `[permissions]` profile
 * rather than the `sandbox_mode` / `sandbox_workspace_write.*` keys the driver
 * passes to `codex exec`, so the driver's roots are translated into that
 * profile shape; the *set of roots* still comes from the driver.
 *
 * Measured on codex-cli 0.154.0 while writing this: with only the workspace
 * root writable, `git add` fails with the verbatim #1076 message
 * (`Unable to create '…/.git/index.lock': Operation not permitted`); with the
 * driver's `.git` root added, `git add` and `git commit` both succeed. The
 * probe discriminates — it is not a tautology.
 */
function codexSandbox(cwd: string): SandboxRunner | { skip: string } {
  if (!whichOk("codex")) {
    return { skip: "unavailable: codex CLI is not on PATH" };
  }

  const args = buildCodexArgs("$exec 1096", { cwd, phase: "exec" });
  const sandboxMode = args[args.indexOf("-s") + 1];
  if (sandboxMode !== "workspace-write") {
    return {
      skip: `structural: the driver selected sandbox mode "${sandboxMode}", which applies no writable-root policy`,
    };
  }

  const prefix = "sandbox_workspace_write.writable_roots=";
  const rootsArg = args.find((a) => a.startsWith(prefix));
  const writableRoots: string[] = rootsArg
    ? (JSON.parse(rootsArg.slice(prefix.length)) as string[])
    : [];
  const network = args.includes("sandbox_workspace_write.network_access=true");

  // codex asserts that a permissions profile denies its own credential file,
  // and aborts (SIGABRT) rather than erroring when one does not.
  const authDeny = join(homedir(), ".codex", "auth.json");
  const codexHome = tempDir("sequant-conf-codexhome-");
  const fsEntries = [
    `"/" = "read"`,
    `${JSON.stringify(cwd)} = "write"`,
    ...writableRoots.map((r) => `${JSON.stringify(r)} = "write"`),
    `${JSON.stringify(authDeny)} = "deny"`,
  ].join("\n");
  writeFileSync(
    join(codexHome, "config.toml"),
    `[permissions.sequant_conformance.filesystem]\n${fsEntries}\n\n[permissions.sequant_conformance.network]\nenabled = ${network}\n`,
    "utf-8",
  );

  const runner: SandboxRunner = {
    label: `codex sandbox, workspace-write, writable roots from the driver: ${writableRoots.join(", ") || "(none)"}`,
    run: (cmd, runCwd) =>
      spawnSync(
        "codex",
        [
          "sandbox",
          "--permission-profile",
          "sequant_conformance",
          "-C",
          runCwd,
          "--",
          ...cmd,
        ],
        {
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: "ignore",
          timeout: SUBPROCESS_TIMEOUT_MS,
        },
      ).status,
    cleanup: () => {},
  };

  // A profile codex refuses to load aborts on the first command. Detect that
  // once, with a command that cannot fail for any other reason, so a codex
  // release that changes the permissions schema reports itself rather than
  // presenting as a phantom sandbox denial.
  const smoke = runner.run(["/bin/echo", "conformance"], cwd);
  if (smoke !== 0) {
    return {
      skip: `unavailable: codex sandbox rejected the permissions profile (status ${smoke}); the 0.154.0 schema this suite writes may have changed`,
    };
  }
  return runner;
}

// ---------------------------------------------------------------------------
// Error mapping (contract item 3)
// ---------------------------------------------------------------------------

type ExpectedError = "BillingError" | "RateLimitError" | "SequantError";

interface ErrorCase {
  /** Names the failure class, and starts the test name after "errors ". */
  label: string;
  expected: ExpectedError;
  /** Produce the driver's own `structuredError` for this failure. */
  classify(): AgentPhaseResult | Promise<AgentPhaseResult>;
  /** Extra assertion once the class matched (reset time, driver code, …). */
  also?(error: SequantError): void;
  /** The driver cannot express this class yet: typed skip. */
  skip?: string;
  /** The mapping is expected to land in another issue: runs as `it.fails`. */
  pending?: string;
}

type ErrorContract = { skip: string } | { cases: ErrorCase[] };

function assertErrorClass(
  error: SequantError | undefined,
  expected: ExpectedError,
): SequantError {
  expect(error, "driver returned no structuredError").toBeInstanceOf(
    SequantError,
  );
  const err = error as SequantError;
  if (expected === "BillingError") {
    expect(err).toBeInstanceOf(BillingError);
    expect(err.isRetryable, "a billing failure must not be retryable").toBe(
      false,
    );
  } else if (expected === "RateLimitError") {
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.isRetryable, "a transient throttle must be retryable").toBe(
      true,
    );
  } else {
    // "anything else" must be neither — a generic error that happens to be a
    // BillingError would pass a bare `instanceof SequantError`.
    expect(err).not.toBeInstanceOf(BillingError);
    expect(err).not.toBeInstanceOf(RateLimitError);
  }
  return err;
}

// ---------------------------------------------------------------------------
// The adapters
// ---------------------------------------------------------------------------

interface ConformanceAdapter {
  /** Items 1 + 2. */
  sandbox: SandboxPolicy;
  /** Item 3. */
  errors: ErrorContract;
  /** Item 4: capture the env the phase's agent actually saw. */
  env: { skip: string } | { capture(): Promise<Record<string, string>> };
  /** Item 5: the driver's own outcome for a completed turn. */
  outcome: { skip: string } | { complete(): Promise<AgentPhaseResult> };
  /** Item 6: evidence the project-scope skill tree resolved. */
  skillLoad: { skip: string } | { assert(): void | Promise<void> };
}

/** Build an SDK message stream, as the driver consumes it. */
function sdkStream(messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
    },
  };
}

const SDK_INIT = {
  type: "system",
  subtype: "init",
  session_id: "conformance-session",
};

/** A completed Claude turn that spent tokens. */
const SDK_SUCCESS = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  modelUsage: {
    "claude-sonnet-5": { inputTokens: 1200, outputTokens: 340, costUSD: 0.02 },
  },
};

/** A future reset, so the waitable-window classification is deterministic. */
const FUTURE_RESET = Math.floor(Date.now() / 1000) + 3600;

async function claudeResult(
  messages: unknown[],
  config?: Partial<AgentExecutionConfig>,
): Promise<AgentPhaseResult> {
  queryMock.mockReturnValue(sdkStream(messages));
  return getDriver("claude-code").executePhase("$exec 1096", {
    cwd: "/tmp/sequant-conformance-worktree",
    env: { ...PHASE_ENV },
    phaseTimeout: 60,
    verbose: false,
    mcp: false,
    ...config,
  });
}

const ADAPTERS: Record<string, ConformanceAdapter> = {
  // -------------------------------------------------------------------------
  "claude-code": {
    sandbox: {
      kind: "none",
      reason:
        "structural: the Claude Agent SDK runs a phase with no sandbox policy, so nothing can deny .git or the network",
    },

    errors: {
      cases: [
        {
          label: "map an exhausted-credits rate_limit_event to BillingError",
          expected: "BillingError",
          classify: () =>
            claudeResult([
              SDK_INIT,
              {
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "rejected",
                  errorCode: "credits_required",
                  resetsAt: FUTURE_RESET,
                  overageDisabledReason: "out_of_credits",
                },
              },
              { type: "result", subtype: "error_during_execution", errors: [] },
            ]),
          also: (err) =>
            expect(
              err.metadata.resetsAt,
              "a billing failure must carry its reset time",
            ).toBe(FUTURE_RESET),
        },
        {
          label:
            "map a reopening five-hour window to a retryable RateLimitError",
          expected: "RateLimitError",
          classify: () =>
            claudeResult([
              SDK_INIT,
              {
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "rejected",
                  rateLimitType: "five_hour",
                  resetsAt: FUTURE_RESET,
                },
              },
              { type: "result", subtype: "error_during_execution", errors: [] },
            ]),
          also: (err) => expect(err.metadata.resetsAt).toBe(FUTURE_RESET),
        },
        {
          label:
            "map any other API failure to a SequantError carrying the driver's code",
          expected: "SequantError",
          classify: () =>
            claudeResult([
              SDK_INIT,
              {
                type: "result",
                subtype: "success",
                is_error: true,
                result: "API Error: 404 model not found",
                api_error_status: 404,
                modelUsage: {},
              },
            ]),
          also: (err) => {
            expect(err).toBeInstanceOf(ApiError);
            expect(err.metadata.statusCode).toBe(404);
          },
        },
      ],
    },

    env: {
      // The SDK is the driver's child here, so `query()`'s options are the
      // boundary the driver actually owns.
      capture: async () => {
        await claudeResult([SDK_INIT, SDK_SUCCESS]);
        const options = queryMock.mock.calls.at(-1)?.[0]?.options ?? {};
        return (options.env ?? {}) as Record<string, string>;
      },
    },

    outcome: { complete: () => claudeResult([SDK_INIT, SDK_SUCCESS]) },

    skillLoad: {
      assert: async () => {
        const driver = getDriver("claude-code");
        expect(driver.resolvesSkills).toBe(true);
        await claudeResult([SDK_INIT, SDK_SUCCESS]);
        const options = queryMock.mock.calls.at(-1)?.[0]?.options ?? {};
        // `settingSources: ["project"]` is what makes the project's own
        // `.claude/skills/` tree resolvable at all — without it the phase's
        // `$exec`/`/exec` invocation finds nothing and the agent improvises
        // (#813 / #992).
        expect(options.settingSources).toContain("project");
      },
    },
  },

  // -------------------------------------------------------------------------
  codex: {
    sandbox: { kind: "policy", prepare: codexSandbox },

    errors: {
      cases: [
        {
          label:
            "map the verbatim #1087 usage-limit turn failure to BillingError",
          expected: "BillingError",
          classify: () => codexOutcome("codex-turn-failed-usage-limit.jsonl"),
          also: (err) =>
            expect(
              err.metadata.resetsAt ?? err.metadata.resetsAtText,
            ).toBeDefined(),
        },
        {
          label:
            "map a transient throttle turn failure to a retryable RateLimitError",
          expected: "RateLimitError",
          classify: () => codexOutcome("codex-turn-failed-rate-limit.jsonl"),
        },
        {
          label:
            "map any other turn failure to a SequantError carrying the driver's code",
          expected: "SequantError",
          classify: () => codexOutcome("codex-turn-failed-unrecognized.jsonl"),
          also: (err) =>
            expect(err.metadata.code).toBe(CODEX_ERROR_CODES.turnFailed),
        },
      ],
    },

    env: {
      capture: () =>
        captureChildEnv("codex", (config) =>
          getDriver("codex").executePhase("$exec 1096", config),
        ),
    },

    outcome: {
      // The #497 probe's own transcript: a real `turn.completed` carrying real
      // usage counters.
      complete: async () => codexOutcome("codex-exec-skill-hook.jsonl", 0),
    },

    skillLoad: {
      assert: () => {
        const driver = getDriver("codex");
        expect(driver.resolvesSkills).toBe(true);
        // codex resolves a skill by name through `$<name>`, not the Claude
        // slash form — the prose template would leave the phase improvising
        // (#1059).
        expect(driver.buildSkillPrompt?.("exec", 1096)).toBe("$exec 1096");
        // And it did resolve, live: the probe transcript carries the skill's
        // own completion marker.
        expect(loadFixture("codex-exec-skill-hook.jsonl")).toContain(
          "SKILL_OK",
        );
      },
    },
  },

  // -------------------------------------------------------------------------
  opencode: {
    sandbox: {
      kind: "none",
      reason:
        "structural: the opencode CLI runs a phase with no sandbox policy — only the hook shim constrains it",
    },

    errors: {
      cases: [
        {
          label: "map a usage-limit failure to BillingError",
          expected: "BillingError",
          classify: () => {
            throw new Error("unreachable — skipped");
          },
          skip: `gap: #${GAP_ISSUE} evaluateOpencodeRun maps every failure to SequantError/SubprocessError, so quota exhaustion is untyped`,
        },
        {
          label: "map a transient throttle to a retryable RateLimitError",
          expected: "RateLimitError",
          classify: () => {
            throw new Error("unreachable — skipped");
          },
          skip: `gap: #${GAP_ISSUE} opencode has no throttle classification, so --auto-wait cannot engage`,
        },
        {
          label:
            "map any other failure to a SequantError carrying the driver's code",
          expected: "SequantError",
          classify: () => {
            const parser = new OpencodeStreamParser("qa");
            parser.feed(
              '{"type":"error","message":"provider stream aborted"}\n',
            );
            return evaluateOpencodeRun(parser.end(), {
              exitCode: 1,
              signal: null,
              phase: "qa",
              phaseTimeout: 600,
              stderrTail: [],
              stdoutTail: [],
            });
          },
          also: (err) =>
            expect(err.metadata.code).toBe(OPENCODE_ERROR_CODES.streamError),
        },
      ],
    },

    env: {
      capture: () =>
        captureChildEnv(
          "opencode",
          (config) => getDriver("opencode").executePhase("/qa 1096", config),
          // The driver fails closed before spawning when the hook shim is
          // absent from the phase cwd (#996 AC-7), so the probe installs one.
          (cwd) => {
            mkdirSync(join(cwd, ".opencode", "plugin"), { recursive: true });
            writeFileSync(
              join(cwd, ".opencode", "plugin", "sequant-hooks.ts"),
              "export const noop = true;\n",
            );
          },
        ),
    },

    outcome: {
      skip: `gap: #${GAP_ISSUE} opencode accumulates costUsd only and never sets modelUsage, so no token total can be derived`,
    },

    skillLoad: {
      assert: () => {
        const driver = getDriver("opencode");
        expect(driver.resolvesSkills).toBe(true);
        // Real recorded run: the `skill` tool call that loaded the project's
        // own qa SKILL.md.
        const parser = new OpencodeStreamParser("qa");
        parser.feed(loadFixture("opencode-run-qa.ndjson"));
        expect(parser.end().skillLoaded).toBe(true);
      },
    },
  },

  // -------------------------------------------------------------------------
  aider: {
    sandbox: {
      kind: "none",
      reason:
        "structural: aider is invoked as a plain subprocess with no sandbox policy",
    },

    errors: {
      skip: `gap: #${GAP_ISSUE} AiderDriver never sets structuredError, so every aider failure falls back to stderr-regex classification`,
    },

    env: {
      capture: () =>
        captureChildEnv("aider", (config) =>
          getDriver("aider").executePhase("Implement the plan.", config),
        ),
    },

    outcome: {
      skip: `gap: #${GAP_ISSUE} AiderDriver reports neither modelUsage nor a cost, so no token total can be derived`,
    },

    skillLoad: {
      skip: "structural: aider phases use inline driverOverrides prompts and resolve no skills (resolvesSkills is false)",
    },
  },
};

/** Every skip reason declared statically on an adapter. */
function declaredSkips(): string[] {
  const out: string[] = [];
  for (const adapter of Object.values(ADAPTERS)) {
    if (adapter.sandbox.kind === "none") out.push(adapter.sandbox.reason);
    if ("skip" in adapter.errors) out.push(adapter.errors.skip);
    else for (const c of adapter.errors.cases) if (c.skip) out.push(c.skip);
    if ("skip" in adapter.env) out.push(adapter.env.skip);
    if ("skip" in adapter.outcome) out.push(adapter.outcome.skip);
    if ("skip" in adapter.skillLoad) out.push(adapter.skillLoad.skip);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe("driver conformance", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  // AC-1 — the pair of guards a new driver cannot dodge.
  describe("registry", () => {
    it("every registered driver has a conformance adapter", () => {
      const missing = listDriverNames().filter((n) => !(n in ADAPTERS));
      expect(
        missing,
        `these drivers are in the registry with no conformance adapter: ${missing.join(", ")}. ` +
          `Add one in driver-conformance.test.ts — a driver that skips this contract is how #1076, #1079 and #1087 shipped.`,
      ).toEqual([]);
    });

    it("every conformance adapter names a registered driver", () => {
      const registered = new Set(listDriverNames());
      const orphans = Object.keys(ADAPTERS).filter((n) => !registered.has(n));
      expect(
        orphans,
        `these conformance adapters name no registered driver: ${orphans.join(", ")}`,
      ).toEqual([]);
    });

    it("enumerates from the registry rather than a hand-written list", () => {
      // Guards against someone "fixing" a failing guard above by inlining the
      // names: the suite's enumeration must be the registry's own.
      expect(listDriverNames().length).toBeGreaterThan(1);
      // Set equality, not array equality: the registry's insertion order is
      // not part of the contract, its membership is.
      expect([...listDriverNames()].sort()).toEqual(
        Object.keys(ADAPTERS).sort(),
      );
    });
  });

  // Derived AC — skip discipline, machine-checked.
  it("every declared skip reason is typed (structural / gap: #N / unavailable)", () => {
    const reasons = declaredSkips();
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) assertSkipForm(reason);
  });

  describe.each(listDriverNames())("%s", (name) => {
    const adapter = ADAPTERS[name];

    // -- item 1 ------------------------------------------------------------
    it(
      "commit: git add and git commit succeed inside the driver's default sandbox",
      () => {
        if (!adapter) return; // the registry guard above owns this failure.
        const { worktree } = gitFixture();
        writeFileSync(join(worktree, "conformance.txt"), "one\n");

        if (adapter.sandbox.kind === "none") {
          skipped(adapter.sandbox.reason);
          // Still run it unwrapped: the item asserts a phase *can* commit, and
          // for an unsandboxed driver that is the whole of the claim.
        }
        const prepared =
          adapter.sandbox.kind === "policy"
            ? adapter.sandbox.prepare(worktree)
            : unsandboxedRunner(adapter.sandbox.reason);

        if ("skip" in prepared) {
          skipped(prepared.skip);
          return;
        }

        try {
          // Assert on repo state, never on an exit code read through a pipe.
          expect(
            prepared.run(["git", "add", "conformance.txt"], worktree),
          ).toBe(0);
          expect(
            prepared.run(
              ["git", "commit", "-q", "-m", "conformance commit"],
              worktree,
            ),
          ).toBe(0);
          const log = execFileSync("git", ["log", "--oneline", "-1"], {
            cwd: worktree,
            encoding: "utf-8",
          });
          expect(log).toContain("conformance commit");
        } finally {
          prepared.cleanup();
        }
      },
      SUBPROCESS_TIMEOUT_MS,
    );

    // -- item 2 ------------------------------------------------------------
    it(
      "network: gh api rate_limit succeeds inside the driver's default sandbox",
      () => {
        if (!adapter) return;
        if (!whichOk("gh")) {
          skipped("unavailable: gh CLI is not on PATH");
          return;
        }
        const { worktree } = gitFixture();

        // Establish that gh works here at all, unsandboxed. Without this the
        // sandboxed failure below could equally mean "gh is unauthenticated",
        // and the probe would report a driver defect that is not one.
        const baseline = spawnSync("gh", ["api", "rate_limit"], {
          cwd: worktree,
          stdio: "ignore",
          timeout: SUBPROCESS_TIMEOUT_MS,
        }).status;
        if (baseline !== 0) {
          skipped(
            "unavailable: gh cannot reach the GitHub API outside any sandbox (unauthenticated or offline)",
          );
          return;
        }

        if (adapter.sandbox.kind === "none") skipped(adapter.sandbox.reason);
        const prepared =
          adapter.sandbox.kind === "policy"
            ? adapter.sandbox.prepare(worktree)
            : unsandboxedRunner(adapter.sandbox.reason);

        if ("skip" in prepared) {
          skipped(prepared.skip);
          return;
        }

        try {
          expect(prepared.run(["gh", "api", "rate_limit"], worktree)).toBe(0);
        } finally {
          prepared.cleanup();
        }
      },
      SUBPROCESS_TIMEOUT_MS,
    );

    // -- item 3 ------------------------------------------------------------
    describe("errors", () => {
      const contract = adapter?.errors;

      if (!contract || "skip" in contract) {
        it("map failures to typed errors", () => {
          skipped(
            contract && "skip" in contract
              ? contract.skip
              : "unavailable: no adapter",
          );
        });
      } else {
        for (const c of contract.cases) {
          if (c.skip) {
            it(c.label, () => skipped(c.skip!));
            continue;
          }
          const runCase = async () => {
            const result = await c.classify();
            const err = assertErrorClass(result.structuredError, c.expected);
            c.also?.(err);
          };
          if (c.pending) {
            // Passes by failing, until the named issue lands the mapping. A
            // reader of the output sees the issue number in the test name —
            // without it, a green run hides that the mapping does not exist.
            it.fails(
              `${c.label} (expected to fail until ${c.pending} lands)`,
              runCase,
            );
          } else {
            it(c.label, runCase);
          }
        }
      }
    });

    // -- item 4 ------------------------------------------------------------
    it(
      "env: the phase sees SEQUANT_ORCHESTRATOR, SEQUANT_WORKTREE, SEQUANT_PHASE and SEQUANT_ISSUE",
      async () => {
        if (!adapter) return;
        if ("skip" in adapter.env) {
          skipped(adapter.env.skip);
          return;
        }
        const childEnv = await adapter.env.capture();
        // A superset, not byte equality: opencode additively redirects
        // XDG_CONFIG_HOME, and every subprocess driver inherits process.env.
        for (const [key, value] of Object.entries(PHASE_ENV)) {
          expect(childEnv[key], `${key} did not reach the phase`).toBe(value);
        }
      },
      SUBPROCESS_TIMEOUT_MS,
    );

    // -- item 5 ------------------------------------------------------------
    it("outcome: a completed turn returns the structured shape with a non-zero token total", async () => {
      if (!adapter) return;
      if ("skip" in adapter.outcome) {
        skipped(adapter.outcome.skip);
        return;
      }
      const result = await adapter.outcome.complete();

      // The shape the driver boundary actually owns. `verdict` is parsed later
      // in phase-executor and `tokensUsed` is derived from modelUsage — see
      // token-utils — so neither is asserted as a field here.
      expect(result.success).toBe(true);
      expect(typeof result.output).toBe("string");
      expect(result.structuredError).toBeUndefined();
      expect(
        result.modelUsage,
        "a completed turn must report its usage",
      ).toBeDefined();
      expect(tokensUsedOf(result)).toBeGreaterThan(0);
    });

    // -- item 6 ------------------------------------------------------------
    it("skill load: the driver resolves the project-scope skill tree", async () => {
      if (!adapter) return;
      if ("skip" in adapter.skillLoad) {
        skipped(adapter.skillLoad.skip);
        return;
      }
      await adapter.skillLoad.assert();
    });
  });
});

// Temp dirs are created lazily per case; one sweep at file teardown keeps the
// worktrees registered with their throwaway parent repos from leaking.
afterAll(() => {
  for (const dir of TEMP_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A temp dir we cannot remove is noise, not a test failure.
    }
  }
});
