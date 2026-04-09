/**
 * Tests for structured error types (Issue #507)
 *
 * Covers AC-6 (error classes), AC-7 (classifyError), AC-9 (isRetryable),
 * AC-10 (exports), AC-12 (.name serialization).
 */

import { describe, it, expect } from "vitest";
import {
  SequantError,
  ContextOverflowError,
  ApiError,
  HookFailureError,
  BuildError,
  TimeoutError,
  SubprocessError,
} from "../src/lib/errors.js";
import {
  classifyError,
  errorTypeToCategory,
} from "../src/lib/workflow/error-classifier.js";

// === AC-6: SequantError base + 6 typed subclasses ===

describe("AC-6: SequantError base class and subclasses", () => {
  it("should create ContextOverflowError with correct properties", () => {
    const err = new ContextOverflowError("context window exceeded", {
      maxTokens: 128000,
      usedTokens: 130000,
    });
    expect(err).toBeInstanceOf(SequantError);
    expect(err).toBeInstanceOf(ContextOverflowError);
    expect(err.name).toBe("ContextOverflowError");
    expect(err.isRetryable).toBe(true);
    expect(err.metadata.maxTokens).toBe(128000);
    expect(err.metadata.usedTokens).toBe(130000);
    expect(err.message).toBe("context window exceeded");
  });

  it("should create ApiError with 429 as retryable", () => {
    const err = new ApiError("rate limited", { statusCode: 429 });
    expect(err).toBeInstanceOf(SequantError);
    expect(err.name).toBe("ApiError");
    expect(err.isRetryable).toBe(true);
    expect(err.metadata.statusCode).toBe(429);
  });

  it("should create ApiError with 401 as not retryable", () => {
    const err = new ApiError("unauthorized", { statusCode: 401 });
    expect(err.isRetryable).toBe(false);
  });

  it("should create ApiError with 503 as retryable", () => {
    const err = new ApiError("service unavailable", { statusCode: 503 });
    expect(err.isRetryable).toBe(true);
  });

  it("should create HookFailureError as not retryable", () => {
    const err = new HookFailureError("pre-commit failed", {
      hook: "pre-commit",
      reason: "lint failed",
    });
    expect(err).toBeInstanceOf(SequantError);
    expect(err.name).toBe("HookFailureError");
    expect(err.isRetryable).toBe(false);
    expect(err.metadata.hook).toBe("pre-commit");
  });

  it("should create BuildError as not retryable", () => {
    const err = new BuildError("TS2304: Cannot find name", {
      toolchain: "tsc",
      errorCode: "TS2304",
    });
    expect(err).toBeInstanceOf(SequantError);
    expect(err.name).toBe("BuildError");
    expect(err.isRetryable).toBe(false);
    expect(err.metadata.toolchain).toBe("tsc");
  });

  it("should create TimeoutError as not retryable", () => {
    const err = new TimeoutError("phase timed out", {
      timeoutMs: 1800000,
      phase: "exec",
    });
    expect(err).toBeInstanceOf(SequantError);
    expect(err.name).toBe("TimeoutError");
    expect(err.isRetryable).toBe(false);
    expect(err.metadata.timeoutMs).toBe(1800000);
  });

  it("should create SubprocessError with signal exit as retryable", () => {
    const err = new SubprocessError("killed", {
      command: "npm test",
      exitCode: 143,
    });
    expect(err).toBeInstanceOf(SequantError);
    expect(err.name).toBe("SubprocessError");
    expect(err.isRetryable).toBe(true); // 143 = SIGTERM
  });

  it("should create SubprocessError with exit code 1 as not retryable", () => {
    const err = new SubprocessError("failed", {
      command: "git push",
      exitCode: 1,
    });
    expect(err.isRetryable).toBe(false);
  });

  it("should support error chaining via cause", () => {
    const cause = new Error("original");
    const err = new ApiError("wrapped", { statusCode: 503 }, cause);
    expect(err.cause).toBe(cause);
  });

  it("should default metadata to empty object", () => {
    const err = new SequantError("bare error");
    expect(err.metadata).toEqual({});
    expect(err.isRetryable).toBe(false);
  });
});

// === AC-7: classifyError returns typed instances ===

describe("AC-7: classifyError returns typed error instances", () => {
  it("should return ApiError for stderr with 429", () => {
    const err = classifyError(["Error 429: rate limit exceeded"], 1);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.name).toBe("ApiError");
  });

  it("should return ApiError for stderr with 503", () => {
    const err = classifyError(["Error 503: service unavailable"], 1);
    expect(err).toBeInstanceOf(ApiError);
  });

  it("should return ContextOverflowError for context window pattern", () => {
    const err = classifyError(["Error: context window exceeded"]);
    expect(err).toBeInstanceOf(ContextOverflowError);
  });

  it("should return HookFailureError for HOOK_BLOCKED", () => {
    const err = classifyError(["HOOK_BLOCKED: pre-commit failed"], 1);
    expect(err).toBeInstanceOf(HookFailureError);
  });

  it("should return BuildError for TypeScript errors", () => {
    const err = classifyError(["error TS2304: Cannot find name 'foo'"]);
    expect(err).toBeInstanceOf(BuildError);
    expect(err.metadata.toolchain).toBe("tsc");
  });

  it("should return TimeoutError for timeout pattern", () => {
    const err = classifyError(["Process timed out after 1800s"]);
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it("should return TimeoutError for exit code 143 (SIGTERM)", () => {
    const err = classifyError(["some unrelated output"], 143);
    expect(err).toBeInstanceOf(TimeoutError);
  });

  it("should return SubprocessError for unknown patterns with exit code", () => {
    const err = classifyError(["some unknown error"], 127);
    expect(err).toBeInstanceOf(SubprocessError);
    expect(err.metadata.exitCode).toBe(127);
  });

  it("should handle empty stderr array", () => {
    const err = classifyError([]);
    expect(err).toBeInstanceOf(SubprocessError);
  });

  it("should prioritize context_overflow over api_error", () => {
    const err = classifyError(["context window exceeded, Error 429"]);
    expect(err).toBeInstanceOf(ContextOverflowError);
  });

  it("should map error types to legacy categories", () => {
    const err = new ApiError("test", { statusCode: 429 });
    expect(errorTypeToCategory(err)).toBe("api_error");

    const err2 = new BuildError("test", { toolchain: "tsc" });
    expect(errorTypeToCategory(err2)).toBe("build_error");

    const err3 = new TimeoutError("test", {});
    expect(errorTypeToCategory(err3)).toBe("timeout");

    const err4 = new SubprocessError("test", {});
    expect(errorTypeToCategory(err4)).toBe("unknown");
  });
});

// === AC-9: isRetryable property drives retry decisions ===

describe("AC-9: isRetryable property", () => {
  it("should be true for ApiError with 429", () => {
    expect(new ApiError("", { statusCode: 429 }).isRetryable).toBe(true);
  });

  it("should be true for ApiError with 503", () => {
    expect(new ApiError("", { statusCode: 503 }).isRetryable).toBe(true);
  });

  it("should be false for ApiError with 401", () => {
    expect(new ApiError("", { statusCode: 401 }).isRetryable).toBe(false);
  });

  it("should be false for BuildError", () => {
    expect(new BuildError("", {}).isRetryable).toBe(false);
  });

  it("should be false for TimeoutError", () => {
    expect(new TimeoutError("", {}).isRetryable).toBe(false);
  });

  it("should be false for HookFailureError", () => {
    expect(new HookFailureError("", {}).isRetryable).toBe(false);
  });

  it("should be true for ContextOverflowError", () => {
    expect(new ContextOverflowError("", {}).isRetryable).toBe(true);
  });

  it("should be true for SubprocessError with signal exit (143)", () => {
    expect(new SubprocessError("", { exitCode: 143 }).isRetryable).toBe(true);
  });

  it("should be false for SubprocessError with exit code 1", () => {
    expect(new SubprocessError("", { exitCode: 1 }).isRetryable).toBe(false);
  });
});

// === AC-10: All error types exported ===

describe("AC-10: Error types exported", () => {
  it("should export SequantError", () => {
    expect(SequantError).toBeDefined();
    expect(typeof SequantError).toBe("function");
  });

  it("should export all 6 subclasses", () => {
    expect(ContextOverflowError).toBeDefined();
    expect(ApiError).toBeDefined();
    expect(HookFailureError).toBeDefined();
    expect(BuildError).toBeDefined();
    expect(TimeoutError).toBeDefined();
    expect(SubprocessError).toBeDefined();
  });

  it("should export classifyError", () => {
    expect(classifyError).toBeDefined();
    expect(typeof classifyError).toBe("function");
  });
});

// === AC-12: .name matches class name for serialization ===

describe("AC-12: .name property matches class constructor name", () => {
  const errorInstances = [
    { cls: SequantError, name: "SequantError", args: ["test"] },
    {
      cls: ContextOverflowError,
      name: "ContextOverflowError",
      args: ["test", {}],
    },
    { cls: ApiError, name: "ApiError", args: ["test", {}] },
    { cls: HookFailureError, name: "HookFailureError", args: ["test", {}] },
    { cls: BuildError, name: "BuildError", args: ["test", {}] },
    { cls: TimeoutError, name: "TimeoutError", args: ["test", {}] },
    { cls: SubprocessError, name: "SubprocessError", args: ["test", {}] },
  ];

  for (const { cls, name, args } of errorInstances) {
    it(`should have .name === '${name}'`, () => {
      const err = new (cls as any)(...args);
      expect(err.name).toBe(name);
    });
  }

  it("should preserve .name through JSON serialization", () => {
    const err = new ApiError("test", { statusCode: 429 });
    const json = JSON.parse(JSON.stringify(err.toJSON()));
    expect(json.name).toBe("ApiError");
    expect(json.metadata.statusCode).toBe(429);
    expect(json.isRetryable).toBe(true);
  });

  it("should preserve metadata through JSON round-trip", () => {
    const err = new BuildError("compile failed", {
      toolchain: "tsc",
      errorCode: "TS2304",
      file: "src/index.ts",
      line: 42,
    });
    const json = JSON.parse(JSON.stringify(err.toJSON()));
    expect(json.metadata.toolchain).toBe("tsc");
    expect(json.metadata.errorCode).toBe("TS2304");
    expect(json.metadata.file).toBe("src/index.ts");
    expect(json.metadata.line).toBe(42);
  });

  it("should include stack trace in serialization", () => {
    const err = new SequantError("test");
    const json = err.toJSON();
    expect(json.stack).toBeDefined();
    expect(typeof json.stack).toBe("string");
  });
});
