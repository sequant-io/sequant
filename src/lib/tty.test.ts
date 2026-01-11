import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isStdinTTY,
  isStdoutTTY,
  isCI,
  shouldUseInteractiveMode,
  getNonInteractiveReason,
} from "./tty.js";

describe("tty utilities", () => {
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset environment
    process.env = { ...originalEnv };
    // Clear CI-related env vars
    const ciVars = [
      "CI",
      "CONTINUOUS_INTEGRATION",
      "GITHUB_ACTIONS",
      "GITLAB_CI",
      "CIRCLECI",
      "TRAVIS",
      "JENKINS_URL",
      "BUILDKITE",
      "DRONE",
      "TEAMCITY_VERSION",
      "TF_BUILD",
      "CODEBUILD_BUILD_ID",
    ];
    for (const v of ciVars) {
      delete process.env[v];
    }
  });

  afterEach(() => {
    // Restore original values
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      writable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      writable: true,
    });
    process.env = originalEnv;
  });

  describe("isStdinTTY", () => {
    it("returns true when stdin.isTTY is true", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      expect(isStdinTTY()).toBe(true);
    });

    it("returns false when stdin.isTTY is false", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
      });
      expect(isStdinTTY()).toBe(false);
    });

    it("returns false when stdin.isTTY is undefined", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        writable: true,
      });
      expect(isStdinTTY()).toBe(false);
    });
  });

  describe("isStdoutTTY", () => {
    it("returns true when stdout.isTTY is true", () => {
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
      });
      expect(isStdoutTTY()).toBe(true);
    });

    it("returns false when stdout.isTTY is false", () => {
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        writable: true,
      });
      expect(isStdoutTTY()).toBe(false);
    });
  });

  describe("isCI", () => {
    it("returns false when no CI env vars are set", () => {
      expect(isCI()).toBe(false);
    });

    it("returns true when CI=true", () => {
      process.env.CI = "true";
      expect(isCI()).toBe(true);
    });

    it("returns true when GITHUB_ACTIONS is set", () => {
      process.env.GITHUB_ACTIONS = "true";
      expect(isCI()).toBe(true);
    });

    it("returns true when GITLAB_CI is set", () => {
      process.env.GITLAB_CI = "true";
      expect(isCI()).toBe(true);
    });

    it("returns true when CIRCLECI is set", () => {
      process.env.CIRCLECI = "true";
      expect(isCI()).toBe(true);
    });

    it("returns true when JENKINS_URL is set", () => {
      process.env.JENKINS_URL = "http://jenkins.local";
      expect(isCI()).toBe(true);
    });
  });

  describe("shouldUseInteractiveMode", () => {
    it("returns true when forceInteractive is true", () => {
      // Even in non-TTY environment, forceInteractive should win
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
      });
      expect(shouldUseInteractiveMode(true)).toBe(true);
    });

    it("returns true when stdin and stdout are TTY and not in CI", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
      });
      expect(shouldUseInteractiveMode()).toBe(true);
    });

    it("returns false when stdin is not TTY", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
      });
      expect(shouldUseInteractiveMode()).toBe(false);
    });

    it("returns false when stdout is not TTY", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        writable: true,
      });
      expect(shouldUseInteractiveMode()).toBe(false);
    });

    it("returns false when in CI environment", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
      });
      process.env.CI = "true";
      expect(shouldUseInteractiveMode()).toBe(false);
    });

    it("returns false when forceInteractive is explicitly false and in non-TTY", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
      });
      expect(shouldUseInteractiveMode(false)).toBe(false);
    });
  });

  describe("getNonInteractiveReason", () => {
    it("returns null when in interactive mode", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
      });
      expect(getNonInteractiveReason()).toBeNull();
    });

    it("returns stdin reason when stdin is not TTY and not in CI", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
      });
      // No CI env vars set (cleared in beforeEach)
      expect(getNonInteractiveReason()).toBe(
        "stdin is not a terminal (piped input detected)",
      );
    });

    it("returns stdout reason when stdout is not TTY and not in CI", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        writable: true,
      });
      // No CI env vars set (cleared in beforeEach)
      expect(getNonInteractiveReason()).toBe("stdout is not a terminal");
    });

    it("returns CI reason with env var name when in GitHub Actions", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
      });
      process.env.GITHUB_ACTIONS = "true";
      expect(getNonInteractiveReason()).toBe(
        "running in CI environment (github actions)",
      );
    });

    it("returns CI reason with env var name when in GitLab CI", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
      });
      process.env.GITLAB_CI = "true";
      expect(getNonInteractiveReason()).toBe(
        "running in CI environment (gitlab ci)",
      );
    });

    // Tests for CI priority over TTY checks (issue #50)
    it("returns CI reason when in GitHub Actions even if stdin is non-TTY", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: true,
        writable: true,
      });
      process.env.GITHUB_ACTIONS = "true";
      // CI reason should take priority over stdin reason
      expect(getNonInteractiveReason()).toBe(
        "running in CI environment (github actions)",
      );
    });

    it("returns CI reason when in GitLab CI even if stdout is non-TTY", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: true,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        writable: true,
      });
      process.env.GITLAB_CI = "true";
      // CI reason should take priority over stdout reason
      expect(getNonInteractiveReason()).toBe(
        "running in CI environment (gitlab ci)",
      );
    });

    it("returns CI reason when in CI even if both stdin and stdout are non-TTY", () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: false,
        writable: true,
      });
      process.env.CIRCLECI = "true";
      // CI reason should take priority over both TTY reasons
      expect(getNonInteractiveReason()).toBe(
        "running in CI environment (circleci)",
      );
    });
  });
});
