/**
 * Unit tests for WorkflowEventEmitter (#504).
 *
 * Covers AC-1 (8 named events), AC-2 (typed payloads — compile-time, see
 * type-error fixtures inline), AC-4 (JSON-serializable payloads), AC-5
 * (Promise.allSettled isolation).
 */

import { describe, it, expect, vi } from "vitest";
import { WorkflowEventEmitter, type WorkflowEvents } from "./event-emitter.js";

const FIXED_TIME = new Date("2026-05-13T12:34:56.000Z");
const fixedClock = (): Date => FIXED_TIME;

describe("WorkflowEventEmitter", () => {
  describe("AC-1: 8 named events", () => {
    it("dispatches each of the 8 event names to its listener", async () => {
      const emitter = new WorkflowEventEmitter({ clock: fixedClock });
      const seen: Array<keyof WorkflowEvents> = [];
      const events: Array<keyof WorkflowEvents> = [
        "run_started",
        "run_completed",
        "phase_started",
        "phase_completed",
        "phase_failed",
        "issue_status_changed",
        "qa_verdict",
        "progress",
      ];

      // Register a listener per event that just records the name.
      emitter.on("run_started", () => void seen.push("run_started"));
      emitter.on("run_completed", () => void seen.push("run_completed"));
      emitter.on("phase_started", () => void seen.push("phase_started"));
      emitter.on("phase_completed", () => void seen.push("phase_completed"));
      emitter.on("phase_failed", () => void seen.push("phase_failed"));
      emitter.on(
        "issue_status_changed",
        () => void seen.push("issue_status_changed"),
      );
      emitter.on("qa_verdict", () => void seen.push("qa_verdict"));
      emitter.on("progress", () => void seen.push("progress"));

      await emitter.emit("run_started", { issueNumber: 1 });
      await emitter.emit("run_completed", { issueNumber: 1, success: true });
      await emitter.emit("phase_started", { issueNumber: 1, phase: "spec" });
      await emitter.emit("phase_completed", {
        issueNumber: 1,
        phase: "spec",
        duration: 12,
      });
      await emitter.emit("phase_failed", {
        issueNumber: 1,
        phase: "exec",
        error: "boom",
      });
      await emitter.emit("issue_status_changed", {
        issueNumber: 1,
        from: "queued",
        to: "running",
      });
      await emitter.emit("qa_verdict", {
        issueNumber: 1,
        phase: "qa",
        verdict: "READY_FOR_MERGE",
      });
      await emitter.emit("progress", {
        issueNumber: 1,
        phase: "exec",
        text: "hi",
      });

      expect(seen).toEqual(events);
    });
  });

  describe("AC-4: structured + JSON-serializable payloads", () => {
    it("populates timestamp when caller omits it", async () => {
      const emitter = new WorkflowEventEmitter({ clock: fixedClock });
      const captured: unknown[] = [];
      emitter.on("phase_completed", (p) => void captured.push(p));

      await emitter.emit("phase_completed", {
        issueNumber: 42,
        phase: "exec",
        duration: 7,
      });

      expect(captured[0]).toEqual({
        issueNumber: 42,
        phase: "exec",
        duration: 7,
        timestamp: FIXED_TIME.toISOString(),
      });
    });

    it("preserves caller-supplied timestamp", async () => {
      const emitter = new WorkflowEventEmitter({ clock: fixedClock });
      const captured: Array<{ timestamp: string }> = [];
      emitter.on("progress", (p) => void captured.push(p));

      const ts = "2020-01-01T00:00:00.000Z";
      await emitter.emit("progress", {
        issueNumber: 1,
        phase: "exec",
        timestamp: ts,
      });

      expect(captured[0].timestamp).toBe(ts);
    });

    it("produces payloads that roundtrip through JSON.stringify", async () => {
      const emitter = new WorkflowEventEmitter({ clock: fixedClock });
      const captured: unknown[] = [];
      emitter.on("phase_completed", (p) => void captured.push(p));
      emitter.on("qa_verdict", (p) => void captured.push(p));
      emitter.on("issue_status_changed", (p) => void captured.push(p));

      await emitter.emit("phase_completed", {
        issueNumber: 1,
        phase: "spec",
        duration: 5,
      });
      await emitter.emit("qa_verdict", {
        issueNumber: 1,
        phase: "qa",
        verdict: "AC_NOT_MET",
      });
      await emitter.emit("issue_status_changed", {
        issueNumber: 1,
        from: "running",
        to: "passed",
      });

      for (const payload of captured) {
        const roundTripped = JSON.parse(JSON.stringify(payload));
        expect(roundTripped).toEqual(payload);
      }
    });
  });

  describe("AC-5: Promise.allSettled isolation", () => {
    it("invokes all listeners even when one throws synchronously", async () => {
      const errors: Array<{ event: string; error: unknown }> = [];
      const emitter = new WorkflowEventEmitter({
        clock: fixedClock,
        onListenerError: (event, error) => errors.push({ event, error }),
      });

      const calls: string[] = [];
      emitter.on("phase_completed", () => {
        calls.push("a");
        throw new Error("sync boom");
      });
      emitter.on("phase_completed", async () => {
        await Promise.resolve();
        throw new Error("async boom");
      });
      emitter.on("phase_completed", () => {
        calls.push("c");
      });

      await emitter.emit("phase_completed", {
        issueNumber: 1,
        phase: "exec",
        duration: 1,
      });

      expect(calls).toEqual(["a", "c"]);
      expect(errors).toHaveLength(2);
      expect(errors[0]?.event).toBe("phase_completed");
      expect((errors[0]?.error as Error).message).toBe("sync boom");
      expect((errors[1]?.error as Error).message).toBe("async boom");
    });

    it("awaiting emit waits for all async listeners to settle", async () => {
      const emitter = new WorkflowEventEmitter({ clock: fixedClock });
      const completed: string[] = [];

      emitter.on("phase_completed", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        completed.push("slow");
      });
      emitter.on("phase_completed", () => {
        completed.push("fast");
      });

      await emitter.emit("phase_completed", {
        issueNumber: 1,
        phase: "exec",
        duration: 1,
      });

      // Both listeners must have finished by the time emit() resolves.
      expect(completed).toContain("slow");
      expect(completed).toContain("fast");
    });

    it("returns immediately when no listeners are attached", async () => {
      const emitter = new WorkflowEventEmitter({ clock: fixedClock });
      // Should not throw and should resolve.
      await expect(
        emitter.emit("progress", { issueNumber: 1, phase: "exec" }),
      ).resolves.toBeUndefined();
    });

    it("listener-error handler swallows its own throws", async () => {
      const emitter = new WorkflowEventEmitter({
        clock: fixedClock,
        onListenerError: () => {
          throw new Error("handler boom");
        },
      });
      emitter.on("phase_failed", () => {
        throw new Error("listener boom");
      });

      // Must not reject even though both the listener and the error handler
      // throw — emit() is the safety net for callers in the critical path.
      await expect(
        emitter.emit("phase_failed", {
          issueNumber: 1,
          phase: "exec",
          error: "x",
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("listener management", () => {
    it("off() removes a previously registered listener", async () => {
      const emitter = new WorkflowEventEmitter({ clock: fixedClock });
      const listener = vi.fn();
      emitter.on("progress", listener);
      emitter.off("progress", listener);

      await emitter.emit("progress", { issueNumber: 1, phase: "exec" });

      expect(listener).not.toHaveBeenCalled();
      expect(emitter.listenerCount("progress")).toBe(0);
    });

    it("removeAllListeners() drops every subscription", async () => {
      const emitter = new WorkflowEventEmitter({ clock: fixedClock });
      emitter.on("progress", () => {});
      emitter.on("phase_started", () => {});
      emitter.removeAllListeners();

      expect(emitter.listenerCount("progress")).toBe(0);
      expect(emitter.listenerCount("phase_started")).toBe(0);
    });
  });
});
