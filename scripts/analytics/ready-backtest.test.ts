/**
 * Unit tests for the ready-gate backtest driver's pure logic (#689).
 * No live git or `ready` calls — the impure I/O (git, worktree, ready) is not
 * exercised here; only the SHA-confidence classifier and the HIT/MISS scorer.
 */

import { describe, it, expect } from "vitest";
import {
  classifyShaConfidence,
  score,
  type CommitMatch,
} from "./ready-backtest.js";

describe("classifyShaConfidence", () => {
  it("high confidence: sole scoped conventional fix commit", () => {
    const matches: CommitMatch[] = [
      { sha: "abc1234", subject: "feat(#467): prevent skill/CLI drift (#468)" },
    ];
    const r = classifyShaConfidence(467, matches);
    expect(r.confidence).toBe("high");
    expect(r.fixSha).toBe("abc1234");
  });

  it("accepts fix/refactor prefixes too", () => {
    expect(
      classifyShaConfidence(318, [
        { sha: "a617eb8", subject: "refactor(#318): split run.ts (#347)" },
      ]).confidence,
    ).toBe("high");
    expect(
      classifyShaConfidence(570, [
        { sha: "c19eb2a", subject: "fix(#570): pre-tool.sh regexes (#578)" },
      ]).confidence,
    ).toBe("high");
  });

  it("low confidence: subject mentions (#N) but is not scoped to it (#625-class false positive)", () => {
    // The real #625 repro: `git log --grep "(#625)"` matched a docs commit.
    const r = classifyShaConfidence(625, [
      { sha: "a892b68", subject: 'docs: refresh README "What\'s new" for 2.x' },
    ]);
    expect(r.confidence).toBe("low");
    expect(r.reason).toMatch(/not scoped to #625/);
    expect(r.reason).toMatch(/verify\/override/);
  });

  it("low confidence: scoped but multiple matches (ambiguous)", () => {
    const matches: CommitMatch[] = [
      { sha: "aaa", subject: "feat(#503): the fix (#510)" },
      { sha: "bbb", subject: "docs(#503): follow-up note (#511)" },
    ];
    const r = classifyShaConfidence(503, matches);
    expect(r.confidence).toBe("low");
    expect(r.reason).toMatch(/2 matches/);
    expect(r.fixSha).toBe("aaa"); // still surfaces the top match for review
  });

  it("low confidence + null fixSha when no commit matches", () => {
    const r = classifyShaConfidence(999, []);
    expect(r.confidence).toBe("low");
    expect(r.fixSha).toBeNull();
    expect(r.reason).toMatch(/no \(#N\) commit found/);
  });

  it("override short-circuits derivation", () => {
    const r = classifyShaConfidence(503, [], "deadbeef");
    expect(r.confidence).toBe("override");
    expect(r.fixSha).toBeNull();
    expect(r.reason).toBe("manual override");
  });

  it("does not match a different issue's scoped commit", () => {
    // subject is scoped to #468, not the #467 we're classifying
    const r = classifyShaConfidence(467, [
      { sha: "xyz", subject: "feat(#468): unrelated (#469)" },
    ]);
    expect(r.confidence).toBe("low");
  });
});

describe("score", () => {
  it("HIT when reason matches expected (e.g. NO_IMPLEMENTATION for empty branch)", () => {
    expect(score("NO_IMPLEMENTATION", { reason: "NO_IMPLEMENTATION" })).toBe(
      "HIT",
    );
  });

  it("HIT when finalVerdict matches expected", () => {
    expect(score("AC_NOT_MET", { finalVerdict: "AC_NOT_MET" })).toBe("HIT");
  });

  it("MISS when neither reason nor finalVerdict matches", () => {
    expect(
      score("AC_NOT_MET", {
        reason: "READY_FOR_MERGE",
        finalVerdict: "READY_FOR_MERGE",
      }),
    ).toBe("MISS");
  });

  it("? when there is no result", () => {
    expect(score("AC_NOT_MET", null)).toBe("?");
  });
});
