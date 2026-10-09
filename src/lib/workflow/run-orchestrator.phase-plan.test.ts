/**
 * #1356 — the TUI's phase row follows the resolved phase plan.
 *
 * The TUI draws from `RunOrchestrator.getSnapshot()`. Before #1356 the
 * orchestrator seeded each issue with `config.phases` and never applied the
 * per-issue plan `batch-executor` reports through `onPhasePlan`, so a phase
 * inserted by label detection (`exec,qa` + `test`) was appended when it
 * started and showed after `qa`, though it ran before it.
 */

import { describe, it, expect, vi } from "vitest";
import { RunOrchestrator } from "./run-orchestrator.js";
import type { OrchestratorConfig } from "./run-orchestrator.js";
import { DEFAULT_CONFIG } from "./types.js";

function makeOrchestrator(
  phases: string[],
  onPhasePlan?: OrchestratorConfig["onPhasePlan"],
) {
  return new RunOrchestrator({
    config: { ...DEFAULT_CONFIG, phases },
    options: {},
    issueInfoMap: new Map([[255, { title: "phase plan", labels: [] }]]),
    worktreeMap: new Map(),
    services: {},
    onPhasePlan,
  } as unknown as OrchestratorConfig);
}

function phaseNames(orch: RunOrchestrator): string[] {
  const issue = orch.getSnapshot().issues.find((i) => i.number === 255)!;
  return issue.phases.map((p) => p.name);
}

describe("RunOrchestrator applies the phase plan (#1356)", () => {
  it("AC-1: shows a label-inserted phase in plan order before any phase starts", () => {
    const orch = makeOrchestrator(["exec", "qa"]);
    orch.getPhasePlanCallback()(255, ["exec", "test", "qa"]);
    expect(phaseNames(orch)).toEqual(["exec", "test", "qa"]);
  });

  it("AC-1: keeps plan order once the inserted phase runs", () => {
    const orch = makeOrchestrator(["exec", "qa"]);
    orch.getPhasePlanCallback()(255, ["exec", "test", "qa"]);
    const progress = orch.getProgressCallback();
    progress(255, "exec", "start");
    progress(255, "exec", "complete", { durationSeconds: 1 });
    progress(255, "test", "start");
    progress(255, "test", "complete", { durationSeconds: 1 });
    progress(255, "qa", "start");
    expect(phaseNames(orch)).toEqual(["exec", "test", "qa"]);
  });

  it("keeps the state of a phase that ran before the plan resolved", () => {
    const orch = makeOrchestrator(["spec", "exec", "qa"]);
    const progress = orch.getProgressCallback();
    progress(255, "spec", "start");
    progress(255, "spec", "complete", { durationSeconds: 1 });
    orch.getPhasePlanCallback()(255, ["spec", "exec", "test", "qa"]);
    const issue = orch.getSnapshot().issues.find((i) => i.number === 255)!;
    expect(issue.phases.map((p) => [p.name, p.status])).toEqual([
      ["spec", "done"],
      ["exec", "pending"],
      ["test", "pending"],
      ["qa", "pending"],
    ]);
  });

  it("drops a configured phase the plan removed while it is still pending", () => {
    const orch = makeOrchestrator(["spec", "exec", "qa"]);
    orch.getPhasePlanCallback()(255, ["exec", "qa"]);
    expect(phaseNames(orch)).toEqual(["exec", "qa"]);
  });

  it("AC-2: appends a phase outside the plan (loop) and keeps the planned order", () => {
    const orch = makeOrchestrator(["exec", "qa"]);
    orch.getPhasePlanCallback()(255, ["exec", "test", "qa"]);
    const progress = orch.getProgressCallback();
    progress(255, "qa", "start");
    progress(255, "qa", "complete", { durationSeconds: 1 });
    progress(255, "loop", "start");
    expect(phaseNames(orch)).toEqual(["exec", "test", "qa", "loop"]);
  });

  it("still forwards the plan to the external callback", () => {
    const external = vi.fn();
    const orch = makeOrchestrator(["exec", "qa"], external);
    orch.getPhasePlanCallback()(255, ["exec", "test", "qa"]);
    expect(external).toHaveBeenCalledWith(255, ["exec", "test", "qa"]);
  });
});
