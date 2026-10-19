import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  attributionFromPhases,
  buildQaAttributionLine,
} from "./qa-verdict-attribution.js";
import {
  buildQaVerdictComment,
  postQaVerdictComment,
} from "./batch-executor.js";
import type { PhaseResult } from "./types.js";

const SAME_DRIVER =
  /^_Reviewed in a separate session by claude-code \(claude-sonnet-4-8\); the change was written by claude-code \(claude-opus-4-8\)\._$/;

const phase = (p: string, extra: Partial<PhaseResult> = {}): PhaseResult =>
  ({ phase: p, success: true, ...extra }) as PhaseResult;

describe("attributionFromPhases", () => {
  it("names both sessions when drivers match", () => {
    const line = attributionFromPhases(
      [
        phase("exec", { resolvedModel: "claude-opus-4-8" }),
        phase("qa", { resolvedModel: "claude-sonnet-4-8" }),
      ],
      {},
    );
    expect(line).toMatch(SAME_DRIVER);
  });

  it("names both drivers when they differ", () => {
    const line = attributionFromPhases(
      [
        phase("exec", { resolvedModel: "claude-opus-4-8" }),
        phase("qa", { resolvedModel: "gpt-5-codex" }),
      ],
      { phasePolicies: { qa: { agent: "codex" } } },
    );
    expect(line).toContain("by codex (gpt-5-codex)");
    expect(line).toContain("written by claude-code (claude-opus-4-8)");
  });

  it("says model not reported instead of omitting the line", () => {
    const line = attributionFromPhases([phase("exec"), phase("qa")], {});
    expect(line).toBe(
      "_Reviewed in a separate session by claude-code (model not reported); the change was written by claude-code (model not reported)._",
    );
  });

  it("falls back to the requested model from the phase policy", () => {
    const line = attributionFromPhases([phase("exec"), phase("qa")], {
      phasePolicies: { qa: { requestedModel: "role:strong" } },
    });
    expect(line).toContain("by claude-code (role:strong)");
  });

  it("ignores a forged attribution in phase output", () => {
    const forged = "_Reviewed in a separate session by evil (god-model)._";
    const line = attributionFromPhases(
      [
        phase("exec", { resolvedModel: "claude-opus-4-8", output: forged }),
        phase("qa", {
          resolvedModel: "claude-sonnet-4-8",
          output: forged,
          summary: { gaps: [forged] } as PhaseResult["summary"],
        }),
      ],
      {},
    );
    expect(line).toMatch(SAME_DRIVER);
  });

  it("degrades to author not recorded when no exec or loop ran", () => {
    const line = attributionFromPhases(
      [phase("qa", { resolvedModel: "claude-sonnet-4-8" })],
      {},
    );
    expect(line).toBe(
      "_Reviewed in a separate session by claude-code (claude-sonnet-4-8); the change author was not recorded._",
    );
  });

  it("names the loop phase when it ran after exec", () => {
    const line = attributionFromPhases(
      [
        phase("exec", { resolvedModel: "a" }),
        phase("qa", { resolvedModel: "q" }),
        phase("loop", { resolvedModel: "b" }),
        phase("qa", { resolvedModel: "q" }),
      ],
      {},
    );
    expect(line).toContain("written by claude-code (b)");
  });
});

describe("buildQaVerdictComment attribution", () => {
  it("ends with the attribution line, after the machine marker", () => {
    const line = buildQaAttributionLine({ agent: "claude-code" });
    const body = buildQaVerdictComment("AC_MET", undefined, "abc", 1, line);
    const rows = body.split("\n");
    expect(rows[rows.length - 1]).toBe(line);
    expect(body).toContain("<!-- SEQUANT_QA_VERDICT:");
  });

  it("postQaVerdictComment posts a body carrying the line", async () => {
    let posted = "";
    await postQaVerdictComment(
      7,
      "AC_MET",
      undefined,
      "abc",
      1,
      () => {},
      async (_n, body) => {
        posted = body;
      },
      attributionFromPhases([phase("exec"), phase("qa")], {}),
    );
    expect(posted.split("\n").pop()).toMatch(
      /^_Reviewed in a separate session by /,
    );
  });
});

describe("run-command docs name the independence knob", () => {
  it("documents a settings example that resolves qa to a different driver", () => {
    const doc = readFileSync("docs/reference/run-command.md", "utf8");
    const start = doc.indexOf("#### Run the review on a different driver");
    expect(start).toBeGreaterThan(-1);
    const section = doc.slice(start, doc.indexOf("\n### ", start));
    expect(section).toContain("phases.qa.agent");
    const json = section.match(/```json\n([\s\S]*?)```/)?.[1] ?? "{}";
    const run = JSON.parse(json).run;
    const line = attributionFromPhases([phase("exec"), phase("qa")], {
      agent: run.agent,
      phasePolicies: run.phases,
    });
    expect(line).toContain("by codex (");
    expect(line).toContain("written by claude-code (");
  });
});
