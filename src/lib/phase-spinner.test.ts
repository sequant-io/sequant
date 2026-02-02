import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PhaseSpinner,
  phaseSpinner,
  formatElapsedTime,
  type PhaseSpinnerOptions,
} from "./phase-spinner.js";
import type { ShutdownManager } from "./shutdown.js";

// Mock the cli-ui module
vi.mock("./cli-ui.js", () => {
  const createMockSpinner = () => ({
    text: "",
    isSpinning: false,
    start: vi.fn(function (
      this: { text: string; isSpinning: boolean },
      text?: string,
    ) {
      if (text) this.text = text;
      this.isSpinning = true;
      return this;
    }),
    succeed: vi.fn(function (
      this: { text: string; isSpinning: boolean },
      text?: string,
    ) {
      if (text) this.text = text;
      this.isSpinning = false;
      return this;
    }),
    fail: vi.fn(function (
      this: { text: string; isSpinning: boolean },
      text?: string,
    ) {
      if (text) this.text = text;
      this.isSpinning = false;
      return this;
    }),
    warn: vi.fn(function (
      this: { text: string; isSpinning: boolean },
      text?: string,
    ) {
      if (text) this.text = text;
      this.isSpinning = false;
      return this;
    }),
    stop: vi.fn(function (this: { isSpinning: boolean }) {
      this.isSpinning = false;
      return this;
    }),
  });

  return {
    spinner: vi.fn(() => createMockSpinner()),
  };
});

// Get the mocked spinner function for assertions
import { spinner as mockSpinnerFactory } from "./cli-ui.js";

describe("formatElapsedTime", () => {
  it("should format seconds under 60 as Ns", () => {
    expect(formatElapsedTime(0)).toBe("0s");
    expect(formatElapsedTime(1)).toBe("1s");
    expect(formatElapsedTime(45)).toBe("45s");
    expect(formatElapsedTime(59)).toBe("59s");
  });

  it("should format seconds 60-3599 as Nm Ns", () => {
    expect(formatElapsedTime(60)).toBe("1m");
    expect(formatElapsedTime(61)).toBe("1m 1s");
    expect(formatElapsedTime(135)).toBe("2m 15s");
    expect(formatElapsedTime(3599)).toBe("59m 59s");
  });

  it("should format seconds 3600+ as Nh Nm", () => {
    expect(formatElapsedTime(3600)).toBe("1h");
    expect(formatElapsedTime(3660)).toBe("1h 1m");
    expect(formatElapsedTime(3900)).toBe("1h 5m");
    expect(formatElapsedTime(7200)).toBe("2h");
  });

  it("should handle fractional seconds", () => {
    expect(formatElapsedTime(45.7)).toBe("45s");
    expect(formatElapsedTime(135.9)).toBe("2m 15s");
  });
});

describe("PhaseSpinner", () => {
  let mockShutdownManager: {
    registerCleanup: ReturnType<typeof vi.fn>;
    unregisterCleanup: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    mockShutdownManager = {
      registerCleanup: vi.fn(),
      unregisterCleanup: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const defaultOptions: PhaseSpinnerOptions = {
    phase: "exec",
    phaseIndex: 2,
    totalPhases: 3,
  };

  describe("constructor", () => {
    it("should create spinner with correct initial text", () => {
      new PhaseSpinner(defaultOptions);

      expect(mockSpinnerFactory).toHaveBeenCalledWith("    exec (2/3)...");
    });

    it("should use custom prefix", () => {
      new PhaseSpinner({ ...defaultOptions, prefix: "  " });

      expect(mockSpinnerFactory).toHaveBeenCalledWith("  exec (2/3)...");
    });

    it("should include iteration suffix when iteration > 1", () => {
      new PhaseSpinner({ ...defaultOptions, iteration: 2 });

      expect(mockSpinnerFactory).toHaveBeenCalledWith(
        "    exec (2/3)... [iteration 2]",
      );
    });

    it("should not include iteration suffix when iteration is 1", () => {
      new PhaseSpinner({ ...defaultOptions, iteration: 1 });

      expect(mockSpinnerFactory).toHaveBeenCalledWith("    exec (2/3)...");
    });
  });

  describe("start", () => {
    it("should start the underlying spinner", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();

      // Get the mock spinner instance
      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(mockSpinner.start).toHaveBeenCalled();
    });

    it("should register cleanup with ShutdownManager", () => {
      const spinner = new PhaseSpinner({
        ...defaultOptions,
        shutdownManager: mockShutdownManager as unknown as ShutdownManager,
      });

      spinner.start();

      expect(mockShutdownManager.registerCleanup).toHaveBeenCalledWith(
        "phase-spinner-exec",
        expect.any(Function),
      );
    });

    it("should start elapsed time interval", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();

      // Get the mock spinner instance
      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;

      // Fast forward 5 seconds
      vi.advanceTimersByTime(5000);

      // The spinner text should be updated with elapsed time
      expect(mockSpinner.text).toContain("5s");
    });

    it("should return this for chaining", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      const result = spinner.start();

      expect(result).toBe(spinner);
    });
  });

  describe("succeed", () => {
    it("should call spinner.succeed with duration", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();

      // Fast forward 45 seconds
      vi.advanceTimersByTime(45000);

      spinner.succeed();

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(mockSpinner.succeed).toHaveBeenCalledWith("    exec (2/3) (45s)");
    });

    it("should accept custom text", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();
      spinner.succeed("Custom success message");

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(mockSpinner.succeed).toHaveBeenCalledWith(
        "Custom success message",
      );
    });

    it("should clear the interval", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();
      spinner.succeed();

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;

      // Fast forward more time - should not update anymore
      vi.advanceTimersByTime(10000);

      // Only 2 calls: start and succeed
      expect(mockSpinner.start).toHaveBeenCalledTimes(1);
      expect(mockSpinner.succeed).toHaveBeenCalledTimes(1);
    });

    it("should unregister from ShutdownManager", () => {
      const spinner = new PhaseSpinner({
        ...defaultOptions,
        shutdownManager: mockShutdownManager as unknown as ShutdownManager,
      });

      spinner.start();
      spinner.succeed();

      expect(mockShutdownManager.unregisterCleanup).toHaveBeenCalledWith(
        "phase-spinner-exec",
      );
    });
  });

  describe("fail", () => {
    it("should call spinner.fail with duration", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();

      vi.advanceTimersByTime(30000);

      spinner.fail();

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(mockSpinner.fail).toHaveBeenCalledWith("    exec (2/3) (30s)");
    });

    it("should include error message if provided", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();
      spinner.fail("Timeout exceeded");

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(mockSpinner.fail).toHaveBeenCalledWith(
        expect.stringContaining("Timeout exceeded"),
      );
    });

    it("should clear interval and unregister cleanup", () => {
      const spinner = new PhaseSpinner({
        ...defaultOptions,
        shutdownManager: mockShutdownManager as unknown as ShutdownManager,
      });

      spinner.start();
      spinner.fail();

      expect(mockShutdownManager.unregisterCleanup).toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("should stop the spinner", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();
      spinner.stop();

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(mockSpinner.stop).toHaveBeenCalled();
    });

    it("should clear interval and unregister cleanup", () => {
      const spinner = new PhaseSpinner({
        ...defaultOptions,
        shutdownManager: mockShutdownManager as unknown as ShutdownManager,
      });

      spinner.start();
      spinner.stop();

      expect(mockShutdownManager.unregisterCleanup).toHaveBeenCalled();
    });
  });

  describe("pause and resume", () => {
    it("should stop spinner on pause", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();
      spinner.pause();

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(mockSpinner.stop).toHaveBeenCalled();
    });

    it("should restart spinner on resume with updated elapsed time", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();

      vi.advanceTimersByTime(10000);

      spinner.pause();
      spinner.resume();

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      // Should have called start again with elapsed time
      expect(mockSpinner.start).toHaveBeenCalledTimes(2);
      expect(mockSpinner.start).toHaveBeenLastCalledWith(
        expect.stringContaining("10s"),
      );
    });

    it("should not update elapsed time while paused", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();

      vi.advanceTimersByTime(5000);
      spinner.pause();

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      const textBeforePause = mockSpinner.text;

      // Advance time while paused
      vi.advanceTimersByTime(10000);

      // Text should not have been updated
      expect(mockSpinner.text).toBe(textBeforePause);
    });

    it("should handle multiple pause/resume cycles", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();
      spinner.pause();
      spinner.resume();
      spinner.pause();
      spinner.resume();
      spinner.succeed();

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(mockSpinner.start).toHaveBeenCalledTimes(3); // initial + 2 resumes
      expect(mockSpinner.stop).toHaveBeenCalledTimes(2); // 2 pauses
      expect(mockSpinner.succeed).toHaveBeenCalledTimes(1);
    });
  });

  describe("isSpinning", () => {
    it("should return true when started", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();

      expect(spinner.isSpinning).toBe(true);
    });

    it("should return false after succeed", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();
      spinner.succeed();

      expect(spinner.isSpinning).toBe(false);
    });

    it("should return false when paused", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();
      spinner.pause();

      expect(spinner.isSpinning).toBe(false);
    });
  });

  describe("elapsedSeconds", () => {
    it("should return 0 before start", () => {
      const spinner = new PhaseSpinner(defaultOptions);

      expect(spinner.elapsedSeconds).toBe(0);
    });

    it("should return elapsed time after start", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();

      vi.advanceTimersByTime(30000);

      expect(spinner.elapsedSeconds).toBe(30);
    });
  });

  describe("dispose", () => {
    it("should clean up resources", () => {
      const spinner = new PhaseSpinner({
        ...defaultOptions,
        shutdownManager: mockShutdownManager as unknown as ShutdownManager,
      });

      spinner.start();
      spinner.dispose();

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(mockSpinner.stop).toHaveBeenCalled();
      expect(mockShutdownManager.unregisterCleanup).toHaveBeenCalled();
    });

    it("should be safe to call multiple times", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();
      spinner.dispose();
      spinner.dispose();
      spinner.dispose();

      // Should not throw
      expect(true).toBe(true);
    });

    it("should prevent further operations", () => {
      const spinner = new PhaseSpinner(defaultOptions);
      spinner.start();
      spinner.dispose();

      // These should be no-ops after dispose
      spinner.start();
      spinner.succeed();
      spinner.fail();

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      // Only the initial start and dispose stop should have been called
      expect(mockSpinner.start).toHaveBeenCalledTimes(1);
      expect(mockSpinner.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe("ShutdownManager cleanup task", () => {
    it("should stop spinner when cleanup is triggered", async () => {
      let cleanupFn: (() => Promise<void>) | undefined;

      mockShutdownManager.registerCleanup.mockImplementation(
        (_name: string, fn: () => Promise<void>) => {
          cleanupFn = fn;
        },
      );

      const spinner = new PhaseSpinner({
        ...defaultOptions,
        shutdownManager: mockShutdownManager as unknown as ShutdownManager,
      });

      spinner.start();

      // Simulate shutdown by calling the cleanup function
      expect(cleanupFn).toBeDefined();
      await cleanupFn!();

      const mockSpinner = (mockSpinnerFactory as ReturnType<typeof vi.fn>).mock
        .results[0].value;
      expect(mockSpinner.stop).toHaveBeenCalled();
    });
  });
});

describe("phaseSpinner factory function", () => {
  it("should create a PhaseSpinner instance", () => {
    const spinner = phaseSpinner({
      phase: "qa",
      phaseIndex: 3,
      totalPhases: 3,
    });

    expect(spinner).toBeInstanceOf(PhaseSpinner);
  });
});
