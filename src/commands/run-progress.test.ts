import { describe, it, expect, vi, beforeEach } from "vitest";

// Both modules are mocked before importing the SUT so buildProgressWiring's
// `new LivenessHeartbeat(...)` / `createRunRenderer(...)` calls resolve to the
// mocks below — letting us inspect what the resulting onProgress callback
// does with an "activity" event (#543).
vi.mock("../lib/cli-ui/run-renderer.js", () => ({
  createRunRenderer: vi.fn(),
}));
vi.mock("../lib/workflow/heartbeat.js", () => ({
  LivenessHeartbeat: vi.fn(),
}));

import { createRunRenderer } from "../lib/cli-ui/run-renderer.js";
import { LivenessHeartbeat } from "../lib/workflow/heartbeat.js";
import { buildProgressWiring } from "./run-progress.js";

const mockCreateRunRenderer = vi.mocked(createRunRenderer);
const MockLivenessHeartbeat = vi.mocked(LivenessHeartbeat);

describe("buildProgressWiring — activity event filter (#543)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("renderer branch (default mode)", () => {
    it("skips renderer.onEvent for activity events", () => {
      const onEvent = vi.fn();
      const registerIssue = vi.fn();
      mockCreateRunRenderer.mockReturnValue({
        onEvent,
        registerIssue,
        // The rest of the RunRenderer surface is unused by buildProgressWiring;
        // cast through unknown so we don't have to stub every method.
        setPullRequest: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        renderSummary: vi.fn(),
        dispose: vi.fn(),
      } as unknown as ReturnType<typeof createRunRenderer>);

      const { onProgress } = buildProgressWiring({
        tuiEnabled: false,
        quiet: false,
        issueNumbers: [42],
        phaseTimeoutSeconds: 60,
      });

      onProgress!(42, "exec", "activity", { text: "writing src/foo.ts" });
      expect(onEvent).not.toHaveBeenCalled();

      // Sanity: non-activity events still flow through.
      onProgress!(42, "exec", "start");
      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ issue: 42, phase: "exec", event: "start" }),
      );
    });
  });

  // #672 AC-2: in explicit-phase mode the pipeline is known upfront, so every
  // registered issue (including queued ones) should be seeded with
  // `plannedPhases` at registration. In auto-detect mode the plan isn't known
  // yet, so registration must NOT seed a plan (setPhasePlan fills it in later).
  describe("phase-plan seeding at registration (#672 AC-2)", () => {
    function captureRegisterIssue(): ReturnType<typeof vi.fn> {
      const registerIssue = vi.fn();
      mockCreateRunRenderer.mockReturnValue({
        onEvent: vi.fn(),
        registerIssue,
        setPhasePlan: vi.fn(),
        setPullRequest: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        renderSummary: vi.fn(),
        dispose: vi.fn(),
      } as unknown as ReturnType<typeof createRunRenderer>);
      return registerIssue;
    }

    it("seeds plannedPhases for every issue in explicit-phase mode", () => {
      const registerIssue = captureRegisterIssue();

      buildProgressWiring({
        tuiEnabled: false,
        quiet: false,
        issueNumbers: [101, 102],
        phaseTimeoutSeconds: 60,
        autoDetectPhases: false,
        basePhases: ["spec", "exec", "qa"],
      });

      // Both issues — including the queued #102 — get the roadmap upfront.
      expect(registerIssue).toHaveBeenCalledTimes(2);
      expect(registerIssue).toHaveBeenNthCalledWith(1, {
        issueNumber: 101,
        autoDetect: false,
        plannedPhases: ["spec", "exec", "qa"],
      });
      expect(registerIssue).toHaveBeenNthCalledWith(2, {
        issueNumber: 102,
        autoDetect: false,
        plannedPhases: ["spec", "exec", "qa"],
      });
    });

    it("does NOT seed plannedPhases in auto-detect mode", () => {
      const registerIssue = captureRegisterIssue();

      buildProgressWiring({
        tuiEnabled: false,
        quiet: false,
        issueNumbers: [201],
        phaseTimeoutSeconds: 60,
        autoDetectPhases: true,
        basePhases: ["spec", "exec", "qa"],
      });

      expect(registerIssue).toHaveBeenCalledWith({
        issueNumber: 201,
        autoDetect: true,
        plannedPhases: undefined,
      });
    });

    it("leaves plannedPhases undefined when basePhases is empty", () => {
      const registerIssue = captureRegisterIssue();

      buildProgressWiring({
        tuiEnabled: false,
        quiet: false,
        issueNumbers: [301],
        phaseTimeoutSeconds: 60,
        autoDetectPhases: false,
        basePhases: [],
      });

      expect(registerIssue).toHaveBeenCalledWith({
        issueNumber: 301,
        autoDetect: false,
        plannedPhases: undefined,
      });
    });
  });

  describe("heartbeat branch (-s / quiet mode)", () => {
    it("skips heartbeat.start / .stop for activity events", () => {
      const start = vi.fn();
      const stop = vi.fn();
      // `LivenessHeartbeat` is invoked with `new`, so the mock implementation
      // must be `new`-callable. Arrow functions are not — use a `function`
      // expression that assigns to `this`.
      MockLivenessHeartbeat.mockImplementation(function (this: {
        start: typeof start;
        stop: typeof stop;
      }) {
        this.start = start;
        this.stop = stop;
      } as unknown as new () => InstanceType<typeof LivenessHeartbeat>);

      const { onProgress } = buildProgressWiring({
        tuiEnabled: false,
        quiet: true,
        issueNumbers: [7],
        phaseTimeoutSeconds: 60,
      });

      onProgress!(7, "spec", "activity", { text: "noisy ping" });
      expect(start).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();

      // Sanity: non-activity events still flow through.
      onProgress!(7, "spec", "start");
      expect(start).toHaveBeenCalledTimes(1);
      onProgress!(7, "spec", "complete");
      expect(stop).toHaveBeenCalledTimes(1);
    });
  });
});
