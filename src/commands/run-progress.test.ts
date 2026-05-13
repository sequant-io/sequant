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

  describe("heartbeat branch (-q mode)", () => {
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
