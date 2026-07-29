/**
 * Renderer tests for #823.
 *
 * The alignment tests here are the point of the whole change: they assert the
 * invariant *directly* (measure the `Run` column offset on every line) rather
 * than only snapshotting, because a snapshot happily locks in a misaligned
 * table. #823's evidence was that every hand-authored example in `SKILL.md` had
 * its header offset from its own data rows, and no check noticed.
 */

import { describe, expect, it } from "vitest";
import stringWidth from "string-width";

import { parseAssessMarkers } from "../assess-comment-parser.js";
import { GEOMETRY, render, renderBatch, renderSingle } from "./renderer.js";
import type { AssessIssue, AssessResult } from "./types.js";

const ESC = String.fromCharCode(27);

/**
 * Display column at which `Run` starts on a table line.
 *
 * Walks code points accumulating `string-width` so a CJK reason is measured in
 * the columns it actually occupies. Returns the offset of the first non-space
 * character at or after the reason field ends.
 */
function runOffset(line: string, withAcs: boolean): number {
  const expected =
    GEOMETRY.reasonCol(withAcs) + GEOMETRY.reasonWidth(withAcs) + 1;
  let width = 0;
  for (const ch of Array.from(line)) {
    if (width >= expected) break;
    width += stringWidth(ch);
  }
  return width;
}

/** Table lines: the header plus one row per issue. */
function tableLines(output: string, issueCount: number): string[] {
  return output.split("\n").slice(0, issueCount + 1);
}

function batch(overrides: Partial<AssessResult> = {}): AssessResult {
  return {
    mode: "batch",
    commandPrefix: "npx sequant",
    issues: [
      {
        number: 461,
        action: "PROCEED",
        reason: "Exact label matching",
        run: "spec → exec → qa",
        phases: ["spec", "exec", "qa"],
        qualityLoop: true,
      },
      {
        number: 462,
        action: "PARK",
        reason: "Manual measurement task",
        run: "‖",
      },
    ],
    commands: [{ args: "run 461 -Q" }],
    ...overrides,
  } as AssessResult;
}

function single(issue: Partial<AssessIssue>): AssessResult {
  return {
    mode: "single",
    commandPrefix: "npx sequant",
    issues: [
      {
        number: 458,
        action: "PROCEED",
        reason: "Both root causes confirmed in codebase",
        title: "Parallel run UX freeze + reconcileState race condition",
        state: "Open",
        labels: ["bug", "enhancement", "cli"],
        ...issue,
      } as AssessIssue,
    ],
  } as AssessResult;
}

describe("renderBatch — alignment invariant (AC-31)", () => {
  it("starts Run at the same offset on the header and every data row", () => {
    const output = renderBatch(batch());
    const lines = tableLines(output, 2);

    const offsets = lines.map((line) => runOffset(line, false));
    expect(new Set(offsets).size).toBe(1);
    expect(offsets[0]).toBe(GEOMETRY.RUN_COL);
  });

  it("keeps Run at the same offset with and without the ACs column (AC-12)", () => {
    const withoutAcs = renderBatch(batch());
    const withAcs = renderBatch(
      batch({
        issues: batch().issues.map((issue, i) => ({
          ...issue,
          acCount: i === 0 ? 6 : 12,
        })),
      }),
    );

    const a = tableLines(withoutAcs, 2).map((l) => runOffset(l, false));
    const b = tableLines(withAcs, 2).map((l) => runOffset(l, true));

    expect(new Set([...a, ...b])).toEqual(new Set([GEOMETRY.RUN_COL]));
    expect(withAcs.split("\n")[0]).toContain("ACs");
    expect(withoutAcs.split("\n")[0]).not.toContain("ACs");
  });

  it("omits the ACs column when only some issues have AC counts", () => {
    const mixed = batch({
      issues: batch().issues.map((issue, i) =>
        i === 0 ? { ...issue, acCount: 6 } : issue,
      ),
    });
    expect(renderBatch(mixed).split("\n")[0]).not.toContain("ACs");
  });
});

describe("renderBatch — truncation (AC-10, AC-32)", () => {
  const longReason =
    "CI billing-lockout misclassified as a transient GitHub flake by the retry policy";

  it("truncates only the Reason column and leaves Run un-shifted", () => {
    const output = renderBatch(
      batch({
        issues: [
          {
            number: 820,
            action: "PROCEED",
            reason: longReason,
            run: "spec → security-review → exec → qa",
          },
        ],
      }),
    );
    const lines = tableLines(output, 1);

    expect(lines[1]).toContain("…");
    expect(new Set(lines.map((l) => runOffset(l, false)))).toEqual(
      new Set([GEOMETRY.RUN_COL]),
    );
  });

  it("never truncates the Run value, even past the separator width (AC-9)", () => {
    const longRun = "spec → security-review → testgen → exec → test → qa";
    const output = renderBatch(
      batch({
        issues: [
          {
            number: 819,
            action: "PROCEED",
            reason: longReason,
            run: longRun,
          },
        ],
      }),
    );
    const row = output.split("\n")[1];

    expect(row).toContain(longRun);
    expect(stringWidth(row)).toBeGreaterThan(GEOMETRY.SEPARATOR_WIDTH);
  });

  it("cuts at a word boundary when that retains most of the column", () => {
    const output = renderBatch(
      batch({
        issues: [
          {
            number: 818,
            action: "PROCEED",
            reason: "merge --watch, kills polling loop",
            run: "spec → exec → qa",
          },
        ],
      }),
    );
    // Boundary cut keeps the whole word rather than slicing "polling" in half.
    expect(output.split("\n")[1]).toContain("kills polling…");
  });

  it("cuts mid-word when a boundary cut would waste the column", () => {
    const output = renderBatch(
      batch({
        issues: [
          {
            number: 817,
            action: "PROCEED",
            reason: "ab supercalifragilisticexpialidociousandthensome",
            run: "spec → exec → qa",
          },
        ],
      }),
    );
    const row = output.split("\n")[1];
    expect(row).not.toContain("ab…");
    expect(row).toContain("…");
  });
});

describe("renderBatch — east-asian width (AC-8, AC-33)", () => {
  it("holds alignment when reasons contain wide characters", () => {
    const output = renderBatch(
      batch({
        issues: [
          {
            number: 700,
            action: "PROCEED",
            reason: "日本語のテキストが列を崩さないこと",
            run: "spec → exec → qa",
          },
          {
            number: 701,
            action: "PROCEED",
            reason: "混在 ascii と全角の組み合わせでも崩れない長い理由テキスト",
            run: "spec → exec → qa",
          },
          {
            number: 702,
            action: "PROCEED",
            reason: "plain ascii control row",
            run: "spec → exec → qa",
          },
        ],
      }),
    );
    const offsets = tableLines(output, 3).map((l) => runOffset(l, false));
    expect(new Set(offsets)).toEqual(new Set([GEOMETRY.RUN_COL]));
  });

  it("does not let a wide-glyph truncation overflow the Reason column", () => {
    const output = renderBatch(
      batch({
        issues: [
          {
            number: 703,
            action: "PROCEED",
            reason: "あ".repeat(60),
            run: "spec → exec → qa",
          },
        ],
      }),
    );
    expect(runOffset(output.split("\n")[1], false)).toBe(GEOMETRY.RUN_COL);
  });
});

describe("renderer purity (AC-4, AC-7, AC-16)", () => {
  const full = batch({
    orders: ["461 → 462 (461 changes the label matcher 462 consumes)"],
    warnings: [{ issue: 462, text: "Manual measurement, not automatable" }],
    chain: { args: "run 461 462 --chain -Q", reason: "462 branches from 461" },
    flags: [{ flag: "-Q", reason: "multi-file scope" }],
    cleanup: [{ command: "gh issue close 447", reason: "PR #457 merged" }],
  });

  it("emits no ANSI escape sequences", () => {
    const output = renderBatch(full);
    expect(output.includes(ESC)).toBe(false);
    // Belt and braces: a plain-text-only pattern over the whole output.
    const PLAIN_TEXT_ONLY = new RegExp(
      "^[^\\u0000-\\u0009\\u000B-\\u001F\\u007F]*$",
    );
    expect(PLAIN_TEXT_ONLY.test(output)).toBe(true);
  });

  it("is byte-identical whether stdout is a TTY or a pipe", () => {
    const original = process.stdout.isTTY;
    try {
      process.stdout.isTTY = true;
      const asTty = renderBatch(full);
      process.stdout.isTTY = false;
      const asPipe = renderBatch(full);
      expect(asTty).toBe(asPipe);
    } finally {
      process.stdout.isTTY = original;
    }
  });

  it("emits separators of exactly 64 characters and no box-drawing borders", () => {
    const output = renderBatch(full);
    const separators = [...output.matchAll(/^─+$/gm)].map((m) => m[0].length);
    expect(separators.length).toBeGreaterThan(0);
    expect(new Set(separators)).toEqual(new Set([GEOMETRY.SEPARATOR_WIDTH]));
    expect(output).not.toMatch(/[╭╮╰╯│┌┐└┘├┤┬┴┼]/);
  });

  it("emits no trailing whitespace on any line", () => {
    const output = renderBatch(full);
    expect(output.split("\n").filter((l) => /\s$/.test(l))).toEqual([]);
  });
});

describe("renderBatch — section visibility (AC-13, AC-34)", () => {
  it("renders table → separator → commands → separator → markers when all clear", () => {
    const output = renderBatch(batch());
    const separators = [...output.matchAll(/^─+$/gm)];

    expect(separators).toHaveLength(2);
    expect(output).not.toContain("Order:");
    expect(output).not.toContain("⚠");
    expect(output).not.toContain("Chain:");
    expect(output).not.toContain("Flags:");
    expect(output).not.toContain("Cleanup:");
  });

  it("produces no orphaned separators when every optional section is absent", () => {
    const output = renderBatch(batch({ commands: undefined }));
    // Nothing follows the table but the markers, so no separator at all.
    expect([...output.matchAll(/^─+$/gm)]).toHaveLength(0);
    expect(output).not.toMatch(/─\n─/);
  });

  it("does not emit consecutive separators for any combination of sections", () => {
    const sections: Array<Partial<AssessResult>> = [
      {},
      { orders: ["1 → 2 (reason)"] },
      { warnings: [{ issue: 1, text: "w" }] },
      { flags: [{ flag: "-Q", reason: "r" }] },
      { cleanup: [{ command: "gh issue close 1" }] },
      { chain: { args: "run 1 2 --chain", reason: "r" } },
    ];
    for (const section of sections) {
      const output = renderBatch(batch(section));
      expect(output).not.toMatch(/^─+\n─+$/m);
    }
  });

  it("emits a marker for every assessed issue (AC-14)", () => {
    const output = renderBatch(batch());
    expect(output).toContain("<!-- #461 assess:action=PROCEED");
    expect(output).toContain("<!-- #462 assess:action=PARK -->");
  });
});

describe("renderSingle — verdict templates (AC-15)", () => {
  it("renders PROCEED", () => {
    expect(
      renderSingle(
        single({
          acCount: 8,
          phases: ["spec", "exec", "qa"],
          qualityLoop: true,
          command: { args: "run 458 -Q" },
          flags: [{ flag: "-Q", reason: "dual concern across 4 files" }],
          warnings: ["Dual concern (UX + race) across 4 files"],
        }),
      ),
    ).toMatchSnapshot();
  });

  it("renders CLOSE", () => {
    expect(
      renderSingle(
        single({
          action: "CLOSE",
          reason: "Resolved by PR #457",
          cleanup: [
            { command: "gh issue close 447", reason: "PR #457 merged" },
            { command: "git worktree remove ../worktrees/feature/447-x" },
          ],
        }),
      ),
    ).toMatchSnapshot();
  });

  it("renders CLARIFY", () => {
    expect(
      renderSingle(
        single({
          action: "CLARIFY",
          reason: "No acceptance criteria",
          need: "Explicit AC checkboxes with verification methods",
          needDetail:
            "Without ACs, /qa has nothing to measure the diff against",
        }),
      ),
    ).toMatchSnapshot();
  });

  it("renders PARK", () => {
    expect(
      renderSingle(
        single({
          action: "PARK",
          reason: "Blocked on manual measurement not yet scheduled",
          resumeAfter: "latency sampling run completes",
          warnings: [
            "Re-assessed 3 times since 2026-06-30 without execution — possible blocker or low priority",
          ],
        }),
      ),
    ).toMatchSnapshot();
  });

  it("renders MERGE", () => {
    expect(
      renderSingle(
        single({
          action: "MERGE",
          reason: "85% scope overlap on the renderer",
          mergeTarget: 823,
          scopeSelf: "Fix the misaligned columns",
          scopeTarget: "Move all rendering into a CLI subcommand",
        }),
      ),
    ).toMatchSnapshot();
  });

  it("renders REWRITE", () => {
    expect(
      renderSingle(
        single({
          action: "REWRITE",
          reason: "PR #380 is 200+ commits behind",
          acCount: 5,
          phases: ["spec", "exec", "qa"],
          qualityLoop: true,
          command: { args: "run 405 -Q", comment: "fresh start" },
          warnings: ["Branch diverged 30+ days ago; ACs still valid"],
        }),
      ),
    ).toMatchSnapshot();
  });

  it("prepends the supersession header above the verdict line", () => {
    const output = renderSingle(
      single({
        supersession: "Supersedes 2 prior assessments (2026-06-01, 2026-07-01)",
        phases: ["spec", "exec", "qa"],
        qualityLoop: true,
      }),
    );
    const lines = output.split("\n");
    const header = lines.findIndex((l) => l.startsWith("Supersedes"));
    const verdict = lines.findIndex((l) => l.startsWith("→ PROCEED"));
    expect(header).toBeGreaterThan(-1);
    expect(header).toBeLessThan(verdict);
  });

  it("gives a slot-less verdict its own separator-delimited warning block", () => {
    const output = renderSingle(
      single({
        action: "PARK",
        reason: "Blocked",
        resumeAfter: "dependency lands",
        warnings: ["Re-assessed 3 times without execution"],
      }),
    );
    // ... → separator → ⚠ → separator → blank → markers
    const lines = output.split("\n").filter((l) => l !== "");
    const warnIdx = lines.findIndex((l) => l.startsWith("⚠"));
    expect(lines[warnIdx - 1]).toMatch(/^─+$/);
    expect(lines[warnIdx + 1]).toMatch(/^─+$/);
    expect(lines[warnIdx + 2]).toBe("<!-- assess:action=PARK -->");
  });

  it("emits the three-line marker block, not the compact batch form", () => {
    const output = renderSingle(
      single({ phases: ["spec", "exec", "qa"], qualityLoop: true }),
    );
    expect(output).toContain("<!-- assess:action=PROCEED -->");
    expect(output).toContain("<!-- assess:phases=spec,exec,qa -->");
    expect(output).toContain("<!-- assess:quality-loop=true -->");
    expect(output).not.toContain("<!-- #458");
  });
});

describe("batch dashboard snapshots (AC-30)", () => {
  it("renders the full dashboard without the ACs column", () => {
    expect(
      renderBatch(
        batch({
          issues: [
            {
              number: 462,
              action: "PARK",
              reason: "Manual measurement task",
              run: "‖",
            },
            {
              number: 461,
              action: "PROCEED",
              reason: "Exact label matching",
              run: "spec → exec → qa",
              phases: ["spec", "exec", "qa"],
              qualityLoop: true,
            },
            {
              number: 412,
              action: "PROCEED",
              reason: "Auth bug (domain: auth adds security review phase)",
              run: "spec → security-review → exec → qa",
              phases: ["spec", "security-review", "exec", "qa"],
              qualityLoop: true,
            },
            {
              number: 411,
              action: "PROCEED",
              reason: "Config path normalization",
              run: "◂ exec → qa",
              phases: ["exec", "qa"],
              qualityLoop: true,
            },
            {
              number: 405,
              action: "REWRITE",
              reason: "PR #380 200+ commits behind",
              run: "⟳ spec → exec → qa",
              phases: ["spec", "exec", "qa"],
              qualityLoop: true,
            },
            {
              number: 447,
              action: "CLOSE",
              reason: "PR #457 merged",
              run: "—",
            },
          ],
          commands: [
            { args: "run 461 -Q" },
            { args: "run 412 -Q --security-review" },
            { args: "run 411 -Q --phases exec,qa", comment: "resume" },
            { args: "run 405 -Q", comment: "restart" },
          ],
          orders: [
            "460 → 461 (460 adds batch-executor tests that 461's label matching depends on)",
          ],
          warnings: [
            { issue: 405, text: "Stale 30+ days, ACs still valid" },
            {
              issue: 412,
              text: "bug + auth labels — auth (domain) adds security-review phase",
            },
          ],
          flags: [
            {
              flag: "-Q",
              reason: "multi-file scope across most PROCEED issues",
            },
            {
              flag: "--security-review",
              reason: "#412 auth label requires a security review",
            },
            {
              flag: "--phases exec,qa",
              reason: "#411 resume — prior spec marker already exists",
            },
          ],
          cleanup: [
            { command: "gh issue close 447", reason: "PR #457 merged" },
            {
              command: "gh issue edit 461 --add-label cli",
              reason: "missing label",
            },
          ],
        }),
      ),
    ).toMatchSnapshot();
  });

  it("renders the full dashboard with the ACs column and a chain suggestion", () => {
    expect(
      renderBatch(
        batch({
          issues: [
            {
              number: 185,
              action: "PROCEED",
              reason: "Domain error standardization",
              run: "spec → exec → qa",
              acCount: 6,
              phases: ["spec", "exec", "qa"],
              qualityLoop: true,
            },
            {
              number: 186,
              action: "PROCEED",
              reason: "React Query hooks migration",
              run: "spec → testgen → exec → test → qa",
              acCount: 9,
              phases: ["spec", "testgen", "exec", "test", "qa"],
              qualityLoop: true,
            },
          ],
          commands: [{ args: "run 185 -Q" }, { args: "run 186 -Q --testgen" }],
          orders: [
            "185 → 186 (185 changes fetchApi error format that 186 consumes)",
          ],
          chain: {
            args: "run 185 186 --chain -Q --testgen",
            reason: "use if 186 should branch from 185's work",
          },
          flags: [
            {
              flag: "--testgen",
              reason: "#186 testable ACs (UI hooks + API integration)",
            },
          ],
        }),
      ),
    ).toMatchSnapshot();
  });
});

describe("render dispatch", () => {
  it("routes by mode", () => {
    expect(render(batch())).toBe(renderBatch(batch()));
    const s = single({ phases: ["spec", "exec", "qa"], qualityLoop: true });
    expect(render(s)).toBe(renderSingle(s));
  });
});

describe("empty-section robustness", () => {
  // The section builders own visibility: callers ask "did that produce
  // anything?" rather than re-deriving emptiness, so there is no second
  // `.length` check to drift out of step. Deleting a builder's guard fails
  // these tests — verified by mutation, not assumed.
  it("renders empty commands/flags/considered/cleanup as nothing at all", () => {
    const output = renderBatch(
      batch({
        commands: [],
        flags: [],
        considered: [],
        cleanup: [],
        orders: [],
        warnings: [],
      }),
    );

    expect(output).not.toContain("Commands:");
    expect(output).not.toContain("Flags:");
    expect(output).not.toContain("Considered:");
    expect(output).not.toContain("Cleanup:");
    expect([...output.matchAll(/^\u2500+$/gm)]).toHaveLength(0);
  });

  it("does not throw on empty section arrays", () => {
    expect(() =>
      renderBatch(batch({ commands: [], flags: [], cleanup: [] })),
    ).not.toThrow();
  });

  it("renders a single-mode issue with empty per-issue arrays", () => {
    const output = renderSingle(
      single({ warnings: [], flags: [], cleanup: [], phases: ["spec", "qa"] }),
    );

    expect(output).not.toContain("Flags:");
    expect(output).not.toContain("Cleanup:");
    expect(output).not.toContain("\u26a0");
    expect(output).toContain("<!-- assess:action=PROCEED -->");
  });
});

describe("Considered: — why-not reasoning", () => {
  const CONSIDERED = [
    {
      flag: "--chain",
      reason: "no dependencies detected among PROCEED issues",
    },
    {
      flag: "--testgen",
      reason: "no ui/feature labels or testable-AC signals",
    },
  ];

  it("renders after Flags: in the batch annotation group, blank-line separated", () => {
    const output = renderBatch(
      batch({
        flags: [{ flag: "-Q", reason: "multi-file bug fixes" }],
        considered: CONSIDERED,
      }),
    );

    const lines = output.split("\n");
    const flagsAt = lines.indexOf("Flags:");
    const consideredAt = lines.indexOf("Considered:");
    expect(flagsAt).toBeGreaterThan(-1);
    expect(consideredAt).toBeGreaterThan(flagsAt);
    expect(lines[consideredAt - 1]).toBe("");
    expect(lines[consideredAt + 1]).toBe(
      "  --chain    no dependencies detected among PROCEED issues",
    );
    expect(lines[consideredAt + 2]).toBe(
      "  --testgen  no ui/feature labels or testable-AC signals",
    );
  });

  it("renders alone in the annotation section when no flags are applied", () => {
    const output = renderBatch(batch({ considered: [CONSIDERED[0]] }));

    expect(output).not.toContain("Flags:");
    expect(output).toContain("Considered:");
    // Inside a separator pair, like every other annotation.
    const lines = output.split("\n");
    const consideredAt = lines.indexOf("Considered:");
    expect(lines[consideredAt - 1]).toMatch(/^─+$/);
  });

  it("renders in single mode after the flags block", () => {
    const output = renderSingle(
      single({
        phases: ["spec", "exec", "qa"],
        qualityLoop: true,
        command: { args: "run 458 -Q" },
        flags: [{ flag: "-Q", reason: "dual concern across 4 files" }],
        considered: [CONSIDERED[0]],
      }),
    );

    const lines = output.split("\n");
    const flagsAt = lines.indexOf("Flags:");
    const consideredAt = lines.indexOf("Considered:");
    expect(consideredAt).toBeGreaterThan(flagsAt);
    expect(output).toContain(
      "  --chain  no dependencies detected among PROCEED issues",
    );
  });
});

describe("marker form boundary (AC-14, AC-39)", () => {
  // The compact batch marker is chat-only by design and `assess-comment-parser`
  // does not recognise it — its pattern requires `assess:` immediately after
  // `<!--`. The skill forbids posting a dashboard for exactly this reason.
  // Locking the asymmetry in as intent rather than accident.
  it("batch emits the compact form, which the comment parser does not read", () => {
    const output = renderBatch(batch());

    expect(output).toContain("<!-- #461 assess:action=PROCEED");
    expect(parseAssessMarkers(output).action).toBeUndefined();
  });

  it("single emits the 3-line form, which the comment parser does read", () => {
    const output = renderSingle(
      single({ phases: ["spec", "exec", "qa"], qualityLoop: true }),
    );

    expect(output).toContain("<!-- assess:action=PROCEED -->");
    expect(parseAssessMarkers(output).action).toBe("PROCEED");
  });
});

describe("marker round-trip (AC-39)", () => {
  it("feeds single-mode output back through parseAssessMarkers", () => {
    const output = renderSingle(
      single({
        phases: ["spec", "security-review", "exec", "qa"],
        qualityLoop: true,
      }),
    );
    const markers = parseAssessMarkers(output);
    expect(markers.action).toBe("PROCEED");
    expect(markers.phases).toEqual(["spec", "security-review", "exec", "qa"]);
    expect(markers.qualityLoop).toBe(true);
  });
});
