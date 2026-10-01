import { describe, it, expect } from "vitest";
import { RunOrchestrator } from "./run-orchestrator.js";
import type { OrchestratorConfig } from "./run-orchestrator.js";
import { DEFAULT_CONFIG } from "./types.js";

// #1257: the Ink TUI's teardown line reads `snapshot.config.dryRun` to print
// `○ #N … (planned)` instead of `✔`. The orchestrator is the only producer of
// that snapshot, so it must carry the flag through.

function snapshotConfig(dryRun: boolean) {
  return new RunOrchestrator({
    config: { ...DEFAULT_CONFIG, phases: ["spec", "exec", "qa"], dryRun },
    options: {},
    issueInfoMap: new Map([[1, { title: "planned", labels: [] }]]),
    worktreeMap: new Map(),
    services: {},
  } as unknown as OrchestratorConfig).getSnapshot().config;
}

describe("RunOrchestrator snapshot carries dryRun (#1257)", () => {
  it("sets config.dryRun on a dry run", () => {
    expect(snapshotConfig(true).dryRun).toBe(true);
  });

  it("leaves config.dryRun unset on a real run", () => {
    expect(snapshotConfig(false)).not.toHaveProperty("dryRun");
  });
});
