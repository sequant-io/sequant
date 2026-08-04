/**
 * sequant resume (#892) — re-entry planning for durable window halts.
 *
 * `planResume` is pure with an injected clock, so the AC-2 (no-op before
 * `resumeAt`) and AC-3 (re-entry bound) edges are pinned here without any
 * process spawning. The scheduler recipe gate (AC-5) is at the bottom,
 * scoped to the delimited recipe region of the doc it asserts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { IssueState } from "../lib/workflow/state-schema.js";
import { MAX_RESUME_REENTRIES } from "../lib/workflow/state-schema.js";
import {
  buildReentryRunOptions,
  planResume,
  reentryBoundMessage,
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
