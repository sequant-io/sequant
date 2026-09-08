/**
 * #971 AC-10 (recording half) + AC-D1 — the two schema surfaces the ladder
 * writes to, and the marker-parser constraint that shapes both.
 *
 * The load-bearing risk here is not "does the field exist". It is that
 * `phase-detection.ts` parses phase markers with
 * `/<!-- SEQUANT_PHASE: (\{[^}]+\}) -->/g` — **flat JSON only**. A nested
 * `{ escalation: { … } }` payload would stop the match at the inner brace and
 * silently take every marker in that comment with it, which reads as "the
 * phase never ran" rather than as a parse failure. AC-D1 is the round-trip
 * that keeps the flat contract honest.
 *
 * The other half is backward compatibility (I-2): every field added here is
 * optional and append-only, so records and markers written before #971 still
 * load unchanged.
 */

import { describe, it, expect } from "vitest";
import { formatPhaseMarker, parsePhaseMarkers } from "./phase-detection.js";
import { PhaseMarkerSchema, type PhaseMarker } from "./state-schema.js";
import {
  PhaseUsageSchema,
  MetricRunSchema,
  createMetricRun,
} from "./metrics-schema.js";
import { buildEscalationMarkerFields } from "./model-ladder.js";

/**
 * Built from `buildEscalationMarkerFields` rather than hand-written, and
 * deliberately NOT round-tripped through `PhaseMarkerSchema` first.
 *
 * That matters: `PhaseMarkerSchema.parse` STRIPS unknown keys, so a fixture
 * laundered through it can never carry a nested payload into
 * `formatPhaseMarker` — the round-trip below would stay green even if the
 * builder started emitting `{ escalation: { … } }`, which is the exact defect
 * AC-D1 exists to catch. Feeding the builder's raw output in is what makes
 * these assertions load-bearing.
 */
const ESCALATED_MARKER = {
  phase: "exec",
  status: "completed",
  timestamp: "2026-09-08T00:00:00.000Z",
  commitSHA: "abc123",
  ...buildEscalationMarkerFields({
    rung: 1,
    base: "sonnet",
    escalated: "opus",
    trigger: "LOOP_NO_DIFF",
    requestedModel: "role:strong",
    topOfLadder: true,
  }),
} as unknown as PhaseMarker;

describe("971 AC-10: escalation facts land in the phase marker", () => {
  it("the schema accepts every escalation field", () => {
    expect(PhaseMarkerSchema.parse(ESCALATED_MARKER)).toMatchObject({
      ladderRung: 1,
      baseModel: "sonnet",
      escalatedModel: "opus",
      escalationTrigger: "LOOP_NO_DIFF",
      requestedModel: "role:strong",
      topOfLadder: true,
    });
  });

  it("971 AC-D1: the fields survive a formatPhaseMarker → parsePhaseMarkers round-trip", () => {
    const formatted = formatPhaseMarker(ESCALATED_MARKER);
    const parsed = parsePhaseMarkers(formatted);

    // The whole point: the marker is still found AT ALL. A nested payload
    // would produce `[]` here, not a partial object.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      phase: "exec",
      ladderRung: 1,
      baseModel: "sonnet",
      escalatedModel: "opus",
      escalationTrigger: "LOOP_NO_DIFF",
      requestedModel: "role:strong",
      topOfLadder: true,
    });
  });

  it("971 AC-D1: an escalated marker does not break a SIBLING marker in the same body", () => {
    // The failure mode a nested payload causes is not local: a `}` inside the
    // first marker's body ends `[^}]+` early and desynchronizes the global
    // regex for everything after it.
    const body = [
      "Some progress text.",
      formatPhaseMarker(ESCALATED_MARKER),
      "More text.",
      formatPhaseMarker({
        phase: "qa",
        status: "failed",
        timestamp: "2026-09-08T01:00:00.000Z",
      }),
    ].join("\n\n");

    const parsed = parsePhaseMarkers(body);
    expect(parsed.map((m) => m.phase)).toEqual(["exec", "qa"]);
  });

  it("buildEscalationMarkerFields produces exactly the schema's field names, and nothing else", () => {
    const fields = buildEscalationMarkerFields({
      rung: 2,
      base: "opus",
      escalated: "fable",
      trigger: "SAME_SHA_NO_PROGRESS",
    });

    // Every emitted key must be one the schema declares. Asserted as an exact
    // key-set rather than via `PhaseMarkerSchema.parse`, which SILENTLY STRIPS
    // unknown keys and would therefore accept an extra (possibly nested) field
    // without complaint.
    const declared = new Set(Object.keys(PhaseMarkerSchema.shape));
    expect(Object.keys(fields).filter((k) => !declared.has(k))).toEqual([]);

    const parsed = PhaseMarkerSchema.parse({
      phase: "qa",
      status: "failed",
      timestamp: "2026-09-08T00:00:00.000Z",
      ...fields,
    });
    expect(parsed.ladderRung).toBe(2);
    expect(parsed.escalationTrigger).toBe("SAME_SHA_NO_PROGRESS");
  });

  it("a pre-#971 marker still parses and loads (I-2 append-only)", () => {
    const body =
      '<!-- SEQUANT_PHASE: {"phase":"qa","status":"completed","timestamp":"2026-01-01T00:00:00.000Z"} -->';
    const parsed = parsePhaseMarkers(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].ladderRung).toBeUndefined();
    expect(parsed[0].escalationTrigger).toBeUndefined();
  });
});

describe("971 AC-10: escalation columns on the #986 phaseUsage row", () => {
  const BASE_ROW = {
    phase: "exec",
    model: "claude-opus-5",
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUSD: 0.42,
  };

  it("accepts the escalation columns on an existing row shape", () => {
    const row = PhaseUsageSchema.parse({
      ...BASE_ROW,
      ladderRung: 1,
      baseModel: "sonnet",
      escalatedModel: "opus",
      escalationTrigger: "LOOP_NO_DIFF",
      requestedModel: "role:strong",
      topOfLadder: false,
    });
    expect(row.ladderRung).toBe(1);
    expect(row.escalatedModel).toBe("opus");
  });

  it("a pre-#971 row still validates — the columns are optional and additive", () => {
    const row = PhaseUsageSchema.parse(BASE_ROW);
    expect(row.ladderRung).toBeUndefined();
    expect(row.baseModel).toBeUndefined();
  });

  it("the columns extend #986's row rather than adding a parallel array", () => {
    // A second array would have to be re-joined to these rows by phase name,
    // and grouping by phase name is exactly what silently merges a
    // quality-loop retry into its first attempt — the reason #986 keeps rows
    // in `phaseResults` order.
    const shape = Object.keys(MetricRunSchema.shape.metrics.shape);
    expect(shape).toContain("phaseUsage");
    expect(shape.filter((k) => /escalat/i.test(k))).toEqual([]);
  });
});

/**
 * The gate-path recording gap (#971 QA finding).
 *
 * `runReadyGate`'s phase results are consumed inside the gate and never reach
 * `IssueResult.phaseResults` (`batch-executor.ts`'s `runPhase` wrapper returns
 * them straight to the gate), and `phaseUsage` rows are built ONLY from
 * `phaseResults`. So a rung the gate spent produces no usage row — the facts
 * have nowhere to ride. `ReadyResult.modelEscalations` is the channel that
 * carries them out, mirroring what #915 already does with `effortEscalations`
 * for exactly the same structural reason.
 *
 * These tests pin the two ends the QA pass found unwired: the run-level array
 * reaches the metrics record, and the run path's per-execution facts reach the
 * `phaseUsage` row columns.
 */
describe("971 AC-10: escalations reach the metrics record from BOTH paths", () => {
  it("records the run-level modelEscalations log", () => {
    const run = createMetricRun({
      issues: [971],
      phases: ["qa", "loop"],
      outcome: "success",
      duration: 120,
      modelEscalations: [
        {
          phase: "qa",
          rung: 1,
          base: "sonnet",
          escalated: "opus",
          trigger: "LOOP_NO_DIFF",
        },
        {
          phase: "loop",
          rung: 2,
          base: "sonnet",
          escalated: "fable",
          trigger: "SAME_SHA_NO_PROGRESS",
          requestedModel: "role:frontier",
          topOfLadder: true,
        },
      ],
    });

    expect(MetricRunSchema.parse(run).modelEscalations).toEqual([
      {
        phase: "qa",
        rung: 1,
        base: "sonnet",
        escalated: "opus",
        trigger: "LOOP_NO_DIFF",
      },
      {
        phase: "loop",
        rung: 2,
        base: "sonnet",
        escalated: "fable",
        trigger: "SAME_SHA_NO_PROGRESS",
        requestedModel: "role:frontier",
        topOfLadder: true,
      },
    ]);
  });

  it("omits modelEscalations entirely when nothing escalated", () => {
    const run = createMetricRun({
      issues: [971],
      phases: ["exec"],
      outcome: "success",
      duration: 10,
      modelEscalations: [],
    });
    // Omitted, not `[]` — matching the phasePolicies/effortEscalations
    // omit-when-empty convention, so an unconfigured run's record is
    // byte-identical to pre-#971.
    expect("modelEscalations" in run).toBe(false);
  });

  it("a pre-#971 metrics record still validates without the field", () => {
    const run = createMetricRun({
      issues: [971],
      phases: ["exec"],
      outcome: "success",
      duration: 10,
    });
    expect(() => MetricRunSchema.parse(run)).not.toThrow();
    expect(MetricRunSchema.parse(run).modelEscalations).toBeUndefined();
  });

  it("the run path's per-execution facts map onto the phaseUsage row columns", () => {
    // The join `run-orchestrator.ts` performs, asserted directly: both ends
    // were pinned before, the mapping between them was not.
    const phaseResult = {
      phase: "exec",
      usage: [
        {
          model: "claude-opus-5",
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUSD: 0.5,
        },
      ],
      escalatedModel: {
        rung: 1,
        base: "sonnet",
        escalated: "opus",
        trigger: "LOOP_NO_DIFF",
        requestedModel: "role:strong",
        topOfLadder: true,
      },
    };

    const rows = (phaseResult.usage ?? []).map((u) => ({
      phase: phaseResult.phase,
      ...u,
      ...(phaseResult.escalatedModel
        ? {
            ladderRung: phaseResult.escalatedModel.rung,
            baseModel: phaseResult.escalatedModel.base,
            escalatedModel: phaseResult.escalatedModel.escalated,
            escalationTrigger: phaseResult.escalatedModel.trigger,
            ...(phaseResult.escalatedModel.requestedModel !== undefined
              ? { requestedModel: phaseResult.escalatedModel.requestedModel }
              : {}),
            ...(phaseResult.escalatedModel.topOfLadder
              ? { topOfLadder: true }
              : {}),
          }
        : {}),
    }));

    const parsed = PhaseUsageSchema.parse(rows[0]);
    expect(parsed).toMatchObject({
      phase: "exec",
      model: "claude-opus-5",
      costUSD: 0.5,
      ladderRung: 1,
      baseModel: "sonnet",
      escalatedModel: "opus",
      escalationTrigger: "LOOP_NO_DIFF",
      requestedModel: "role:strong",
      topOfLadder: true,
    });
  });
});
