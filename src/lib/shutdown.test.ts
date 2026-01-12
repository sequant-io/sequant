/**
 * Tests for ShutdownManager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ShutdownManager } from "./shutdown.js";

describe("ShutdownManager", () => {
  let mockOutput: ReturnType<typeof vi.fn>;
  let mockErrorOutput: ReturnType<typeof vi.fn>;
  let mockExit: ReturnType<typeof vi.fn>;
  let manager: ShutdownManager;

  beforeEach(() => {
    mockOutput = vi.fn();
    mockErrorOutput = vi.fn();
    mockExit = vi.fn();
  });

  afterEach(() => {
    // Always dispose to remove signal handlers
    manager?.dispose();
  });

  function createManager(options?: { forceExitTimeout?: number }) {
    manager = new ShutdownManager({
      output: mockOutput,
      errorOutput: mockErrorOutput,
      exit: mockExit,
      forceExitTimeout: options?.forceExitTimeout ?? 10000,
    });
    return manager;
  }

  describe("initialization", () => {
    it("should start with isShuttingDown = false", () => {
      const mgr = createManager();
      expect(mgr.isShuttingDown).toBe(false);
      expect(mgr.shuttingDown).toBe(false);
    });

    it("should start with no cleanup tasks", () => {
      const mgr = createManager();
      expect(mgr.getCleanupTaskCount()).toBe(0);
    });
  });

  describe("cleanup task registration", () => {
    it("should register cleanup tasks", () => {
      const mgr = createManager();

      mgr.registerCleanup("Task 1", async () => {});
      expect(mgr.getCleanupTaskCount()).toBe(1);

      mgr.registerCleanup("Task 2", async () => {});
      expect(mgr.getCleanupTaskCount()).toBe(2);
    });

    it("should unregister cleanup tasks by name", () => {
      const mgr = createManager();

      mgr.registerCleanup("Task 1", async () => {});
      mgr.registerCleanup("Task 2", async () => {});
      expect(mgr.getCleanupTaskCount()).toBe(2);

      mgr.unregisterCleanup("Task 1");
      expect(mgr.getCleanupTaskCount()).toBe(1);
    });

    it("should not error when unregistering non-existent task", () => {
      const mgr = createManager();
      mgr.registerCleanup("Task 1", async () => {});

      // Should not throw
      mgr.unregisterCleanup("Non-existent");
      expect(mgr.getCleanupTaskCount()).toBe(1);
    });
  });

  describe("graceful shutdown", () => {
    it("should set isShuttingDown to true", async () => {
      const mgr = createManager();

      await mgr.gracefulShutdown("SIGINT");

      expect(mgr.isShuttingDown).toBe(true);
      expect(mockExit).toHaveBeenCalledWith(0);
    });

    it("should abort the active controller", async () => {
      const mgr = createManager();
      const abortController = new AbortController();

      mgr.setAbortController(abortController);
      expect(abortController.signal.aborted).toBe(false);

      await mgr.gracefulShutdown("SIGINT");

      expect(abortController.signal.aborted).toBe(true);
      expect(mockOutput).toHaveBeenCalledWith(
        expect.stringContaining("Aborted active phase"),
      );
    });

    it("should execute cleanup tasks in LIFO order", async () => {
      const mgr = createManager();
      const executionOrder: string[] = [];

      mgr.registerCleanup("First", async () => {
        executionOrder.push("First");
      });
      mgr.registerCleanup("Second", async () => {
        executionOrder.push("Second");
      });
      mgr.registerCleanup("Third", async () => {
        executionOrder.push("Third");
      });

      await mgr.gracefulShutdown("SIGINT");

      // LIFO: Third, Second, First
      expect(executionOrder).toEqual(["Third", "Second", "First"]);
    });

    it("should continue cleanup even if a task fails", async () => {
      const mgr = createManager();
      const executionOrder: string[] = [];

      mgr.registerCleanup("First", async () => {
        executionOrder.push("First");
      });
      mgr.registerCleanup("Failing", async () => {
        throw new Error("Cleanup failed");
      });
      mgr.registerCleanup("Third", async () => {
        executionOrder.push("Third");
      });

      await mgr.gracefulShutdown("SIGINT");

      // Should execute Third, fail on Failing, then execute First
      expect(executionOrder).toEqual(["Third", "First"]);
      expect(mockErrorOutput).toHaveBeenCalledWith(
        expect.stringContaining("Failing: Cleanup failed"),
      );
    });

    it("should print success message for completed cleanup tasks", async () => {
      const mgr = createManager();

      mgr.registerCleanup("Save logs", async () => {});

      await mgr.gracefulShutdown("SIGINT");

      expect(mockOutput).toHaveBeenCalledWith(
        expect.stringContaining("✓ Save logs"),
      );
    });

    it("should exit with code 0 on successful shutdown", async () => {
      const mgr = createManager();

      await mgr.gracefulShutdown("SIGINT");

      expect(mockExit).toHaveBeenCalledWith(0);
    });
  });

  describe("double signal (force exit)", () => {
    it("should force exit on second signal", async () => {
      vi.useFakeTimers();

      const mgr = createManager({ forceExitTimeout: 10000 });

      // Register a slow task that we'll never complete
      let taskStarted = false;
      mgr.registerCleanup("Slow task", async () => {
        taskStarted = true;
        // This task hangs indefinitely
        await new Promise(() => {});
      });

      // First signal - starts shutdown (don't await)
      const shutdownPromise = mgr.gracefulShutdown("SIGINT");

      // Wait a tick for the task to start
      await vi.advanceTimersByTimeAsync(10);
      expect(taskStarted).toBe(true);
      expect(mgr.isShuttingDown).toBe(true);

      // Second signal while shutting down - should force exit immediately
      await mgr.gracefulShutdown("SIGINT");

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockErrorOutput).toHaveBeenCalledWith(
        expect.stringContaining("Force exiting"),
      );

      vi.useRealTimers();

      // Don't await the hanging promise
      shutdownPromise.catch(() => {});
    });
  });

  describe("timeout", () => {
    it("should force exit if cleanup takes too long", async () => {
      vi.useFakeTimers();

      const mgr = createManager({ forceExitTimeout: 100 });

      mgr.registerCleanup("Hanging task", async () => {
        // This task never completes
        await new Promise(() => {});
      });

      // Start shutdown (don't await - it will hang)
      const shutdownPromise = mgr.gracefulShutdown("SIGINT");

      // Advance timer past timeout
      await vi.advanceTimersByTimeAsync(150);

      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockErrorOutput).toHaveBeenCalledWith(
        expect.stringContaining("Cleanup timeout"),
      );

      vi.useRealTimers();

      // Don't await the hanging promise
      shutdownPromise.catch(() => {});
    });
  });

  describe("abort controller management", () => {
    it("should set and clear abort controller", () => {
      const mgr = createManager();
      const controller = new AbortController();

      mgr.setAbortController(controller);
      // Can't directly test the internal state, but we can test behavior

      mgr.clearAbortController();
      // After clear, graceful shutdown should not abort anything
    });

    it("should not error when aborting with no controller set", async () => {
      const mgr = createManager();

      // Should not throw
      await mgr.gracefulShutdown("SIGINT");

      expect(mockExit).toHaveBeenCalledWith(0);
    });
  });

  describe("dispose", () => {
    it("should clear cleanup tasks", () => {
      const mgr = createManager();

      mgr.registerCleanup("Task 1", async () => {});
      mgr.registerCleanup("Task 2", async () => {});
      expect(mgr.getCleanupTaskCount()).toBe(2);

      mgr.dispose();
      expect(mgr.getCleanupTaskCount()).toBe(0);
    });

    it("should allow multiple managers in sequence", () => {
      // Create and dispose first manager
      const mgr1 = createManager();
      mgr1.registerCleanup("Task", async () => {});
      mgr1.dispose();

      // Create second manager - should work without issues
      const mgr2 = createManager();
      mgr2.registerCleanup("Task", async () => {});
      expect(mgr2.getCleanupTaskCount()).toBe(1);
      mgr2.dispose();
    });
  });

  describe("signal handling", () => {
    it("should handle SIGTERM same as SIGINT", async () => {
      const mgr = createManager();

      await mgr.gracefulShutdown("SIGTERM");

      expect(mockOutput).toHaveBeenCalledWith(
        expect.stringContaining("SIGTERM"),
      );
      expect(mockExit).toHaveBeenCalledWith(0);
    });
  });
});
