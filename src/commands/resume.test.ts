/**
 * sequant resume (#892) — re-entry planning for durable window halts.
 *
 * `planResume` is pure with an injected clock, so the AC-2 (no-op before
 * `resumeAt`) and AC-3 (re-entry bound) edges are pinned here without any
 * process spawning. The scheduler recipe gate (AC-5) is at the bottom,
 * scoped to the delimited recipe region of the doc it asserts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { IssueState } from "../lib/workflow/state-schema.js";
import { MAX_RESUME_REENTRIES } from "../lib/workflow/state-schema.js";
import { StateManager } from "../lib/workflow/state-manager.js";
import type { LockFile } from "../lib/locks/index.js";
import {
  buildReentryRunOptions,
  planResume,
  reentryBoundMessage,
  resumeCommand,
} from "./resume.js";

const NOW = Date.parse("2026-08-04T12:00:00Z");
const BEFORE = new Date(NOW + 3_600_000).toISOString(); // reopens in 1h
const PAST = new Date(NOW - 60_000).toISOString(); // reopened 1min ago

function makeIssueState(
  issueNumber: number,
  overrides: Partial<IssueState> = {},
): IssueState {
  return {
    number: issueNumber,
    title: `Issue ${issueNumber}`,
    status: "in_progress",
    phases: {},
    lastActivity: new Date(NOW).toISOString(),
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  } as IssueState;
}

function halted(
  issueNumber: number,
  resumeAt: string,
  reentries = 0,
  overrides: Partial<IssueState> = {},
): IssueState {
  return makeIssueState(issueNumber, {
    windowHalt: { resumeAt, phase: "qa", reentries },
    ...overrides,
  });
}

describe("planResume (#892)", () => {
  it("AC-2: an issue before resumeAt is notYet, after resumeAt is due", () => {
    const plan = planResume(
      { 1: halted(1, BEFORE), 2: halted(2, PAST) },
      [],
      NOW,
    );
    expect(plan.notYet.map((c) => c.issueNumber)).toEqual([1]);
    expect(plan.due.map((c) => c.issueNumber)).toEqual([2]);
    expect(plan.exhausted).toEqual([]);
  });

  it("AC-2 boundary: exactly at resumeAt counts as due, not notYet", () => {
    const atNow = new Date(NOW).toISOString();
    const plan = planResume({ 1: halted(1, atNow) }, [], NOW);
    expect(plan.due).toHaveLength(1);
    expect(plan.notYet).toHaveLength(0);
  });

  it("AC-3: an issue at the re-entry bound is exhausted even when past resumeAt", () => {
    const plan = planResume(
      { 1: halted(1, PAST, MAX_RESUME_REENTRIES) },
      [],
      NOW,
    );
    expect(plan.exhausted.map((c) => c.issueNumber)).toEqual([1]);
    expect(plan.due).toEqual([]);
  });

  it("one re-entry below the bound is still due", () => {
    const plan = planResume(
      { 1: halted(1, PAST, MAX_RESUME_REENTRIES - 1) },
      [],
      NOW,
    );
    expect(plan.due).toHaveLength(1);
    expect(plan.exhausted).toHaveLength(0);
  });

  it("skips issues without a windowHalt record", () => {
    const plan = planResume({ 1: makeIssueState(1) }, [], NOW);
    expect(plan).toEqual({ due: [], notYet: [], exhausted: [] });
  });

  it("skips completed issues even with a stale windowHalt (#837 vocabulary)", () => {
    const plan = planResume(
      {
        1: halted(1, PAST, 0, { status: "merged" }),
        2: halted(2, PAST, 0, { status: "ready_for_merge" }),
        3: halted(3, PAST, 0, { status: "waiting_for_human_merge" }),
        4: halted(4, PAST),
      },
      [],
      NOW,
    );
    expect(plan.due.map((c) => c.issueNumber)).toEqual([4]);
  });

  it("restricts to requested issues when arguments are given", () => {
    const plan = planResume(
      { 1: halted(1, PAST), 2: halted(2, PAST) },
      [2],
      NOW,
    );
    expect(plan.due.map((c) => c.issueNumber)).toEqual([2]);
  });

  it("orders each bucket by issue number regardless of state-file key order", () => {
    const plan = planResume(
      { 30: halted(30, PAST), 4: halted(4, PAST), 17: halted(17, PAST) },
      [],
      NOW,
    );
    expect(plan.due.map((c) => c.issueNumber)).toEqual([4, 17, 30]);
  });

  it("carries phase and reentries through to the candidate", () => {
    const plan = planResume({ 1: halted(1, PAST, 1) }, [], NOW);
    expect(plan.due[0]).toEqual({
      issueNumber: 1,
      resumeAt: PAST,
      phase: "qa",
      reentries: 1,
    });
  });
});

describe("reentryBoundMessage (#892 AC-3)", () => {
  it("keeps today's labeled halt vocabulary and names the manual way out", () => {
    const message = reentryBoundMessage({
      issueNumber: 42,
      resumeAt: PAST,
      phase: "qa",
      reentries: MAX_RESUME_REENTRIES,
    });
    // Same label family as the #799/#804 halts ("Rate limited — …").
    expect(message).toMatch(/^Rate limited — re-entry bound reached/);
    expect(message).toContain(
      `(${MAX_RESUME_REENTRIES}/${MAX_RESUME_REENTRIES})`,
    );
    expect(message).toContain("npx sequant run 42 --resume");
  });
});

describe("buildReentryRunOptions (#892 AC-2)", () => {
  it("sets resume and nothing else, so settings/defaults resolve as in an attended run", () => {
    // RunOptions treats an absent field as "resolve from settings/defaults"
    // (config-resolver only reacts to explicit false / no* fields). Any extra
    // key here would make a scheduled re-entry behave differently from the
    // attended `sequant run <issue> --resume` it stands in for.
    expect(buildReentryRunOptions()).toEqual({ resume: true });
  });
});

// #892 QA follow-up: the command shell itself — arg validation, exit codes,
// re-entry consumption, the lock-skip guard, and the delegation call — all via
// injected deps against a REAL StateManager on a temp state file, so the
// persistence side effects (counter increments) are asserted on disk, not on
// mocks.
describe("resumeCommand (#892)", () => {
  let tempDir: string;
  let stateManager: StateManager;
  let runFn: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let savedExitCode: typeof process.exitCode;

  const NOT_LOCKED = (): LockFile | null => null;
  const LOCKED = (): LockFile | null =>
    ({
      pid: 4242,
      hostname: os.hostname(),
      startedAt: new Date(NOW).toISOString(),
      command: "npx sequant run 7",
    }) as LockFile;

  function loggedOutput(): string {
    return logSpy.mock.calls.map((c) => String(c[0])).join("\n");
  }

  async function seedHalt(
    issueNumber: number,
    resumeAt: string,
    reentries = 0,
  ): Promise<void> {
    await stateManager.initializeIssue(issueNumber, `Issue ${issueNumber}`);
    await stateManager.updateWindowHalt(
      issueNumber,
      "qa",
      new Date(resumeAt).getTime(),
    );
    for (let i = 0; i < reentries; i++) {
      await stateManager.incrementWindowHaltReentries(issueNumber);
    }
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-cmd-test-"));
    stateManager = new StateManager({
      statePath: path.join(tempDir, ".sequant", "state.json"),
    });
    runFn = vi.fn().mockResolvedValue(undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    logSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function deps(overrides: Record<string, unknown> = {}) {
    return {
      stateManager,
      runFn,
      checkLock: NOT_LOCKED,
      now: () => NOW,
      ...overrides,
    };
  }

  it("rejects a non-numeric issue argument with exit 1 and no run", async () => {
    await resumeCommand(["abc"], {}, deps());
    expect(process.exitCode).toBe(1);
    expect(runFn).not.toHaveBeenCalled();
  });

  it("is a quiet no-op (exit 0) when nothing is halted", async () => {
    await resumeCommand([], {}, deps());
    expect(process.exitCode).toBeUndefined();
    expect(runFn).not.toHaveBeenCalled();
    expect(loggedOutput()).toContain("No halted issues to resume");
  });

  it("AC-2: before resumeAt it reports the reopen time and exits 0 without running", async () => {
    await seedHalt(101, BEFORE);
    await resumeCommand([], {}, deps());
    expect(process.exitCode).toBeUndefined();
    expect(runFn).not.toHaveBeenCalled();
    expect(loggedOutput()).toContain("#101 not yet resumable");
    // No re-entry consumed by a no-op tick.
    const state = await stateManager.getIssueState(101);
    expect(state?.windowHalt?.reentries).toBe(0);
  });

  it("AC-3: exhausted-only exits 1 with the labeled terminal message, no run", async () => {
    await seedHalt(102, PAST, MAX_RESUME_REENTRIES);
    await resumeCommand([], {}, deps());
    expect(process.exitCode).toBe(1);
    expect(runFn).not.toHaveBeenCalled();
    expect(loggedOutput()).toContain("Rate limited — re-entry bound reached");
  });

  it("mixed exhausted + notYet exits 0 — something is still worth waiting for", async () => {
    await seedHalt(101, BEFORE);
    await seedHalt(102, PAST, MAX_RESUME_REENTRIES);
    await resumeCommand([], {}, deps());
    expect(process.exitCode).toBeUndefined();
    expect(runFn).not.toHaveBeenCalled();
  });

  it("a due issue consumes one re-entry (persisted) and delegates with resume semantics", async () => {
    await seedHalt(103, PAST);
    await resumeCommand([], {}, deps());
    expect(runFn).toHaveBeenCalledWith(["103"], { resume: true });
    const state = await stateManager.getIssueState(103);
    expect(state?.windowHalt?.reentries).toBe(1);
  });

  it("--dry-run neither consumes a re-entry nor runs", async () => {
    await seedHalt(103, PAST);
    await resumeCommand([], { dryRun: true }, deps());
    expect(runFn).not.toHaveBeenCalled();
    const state = await stateManager.getIssueState(103);
    expect(state?.windowHalt?.reentries).toBe(0);
    expect(loggedOutput()).toContain("dry run, not started");
  });

  it("a lock-held due issue is skipped WITHOUT consuming a re-entry (exit 0)", async () => {
    await seedHalt(103, PAST);
    await resumeCommand([], {}, deps({ checkLock: LOCKED }));
    expect(runFn).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(loggedOutput()).toContain("#103 skipped — re-entry not consumed");
    const state = await stateManager.getIssueState(103);
    expect(state?.windowHalt?.reentries).toBe(0);
  });

  it("runs only the unlocked issues when locks cover a subset", async () => {
    await seedHalt(103, PAST);
    await seedHalt(104, PAST);
    const lockOnly103 = (issue: number): LockFile | null =>
      issue === 103 ? LOCKED() : null;
    await resumeCommand([], {}, deps({ checkLock: lockOnly103 }));
    expect(runFn).toHaveBeenCalledWith(["104"], { resume: true });
    expect((await stateManager.getIssueState(103))?.windowHalt?.reentries).toBe(
      0,
    );
    expect((await stateManager.getIssueState(104))?.windowHalt?.reentries).toBe(
      1,
    );
  });

  it("restricts to requested issue numbers", async () => {
    await seedHalt(103, PAST);
    await seedHalt(104, PAST);
    await resumeCommand(["104"], {}, deps());
    expect(runFn).toHaveBeenCalledWith(["104"], { resume: true });
    expect((await stateManager.getIssueState(103))?.windowHalt?.reentries).toBe(
      0,
    );
  });
});

// AC-5 gate: the scheduler recipe must stay copy-pasteable. Scoped to the
// delimited recipe region (not the whole file) so a mention elsewhere in the
// doc cannot satisfy the assertion (see CLAUDE.md gate-test rule).
describe("halt-and-resume docs recipe (#892 AC-5)", () => {
  const doc = readFileSync(
    new URL("../../docs/reference/halt-and-resume.md", import.meta.url),
    "utf8",
  );

  it("ships cron and launchd recipes invoking `sequant resume` in the delimited region", () => {
    const match = doc.match(
      /<!-- recipe:start -->([\s\S]*?)<!-- recipe:end -->/,
    );
    expect(
      match,
      "recipe markers must delimit the scheduler recipe",
    ).not.toBeNull();
    const recipe = match![1];

    // cron: a five-field schedule line invoking the re-entry command.
    expect(recipe).toMatch(/\*\/15 \* \* \* \*.*npx sequant resume/);
    // launchd: a loadable plist with a repeat interval and the same command.
    expect(recipe).toContain("<key>StartInterval</key>");
    expect(recipe).toMatch(/<string>npx sequant resume[^<]*<\/string>/);
    expect(recipe).toContain("Library/LaunchAgents");
  });
});
