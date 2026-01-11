import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock system functions
vi.mock("./system.js", () => ({
  commandExists: vi.fn(),
  isGhAuthenticated: vi.fn(),
  getInstallHint: vi.fn((pkg: string) => {
    if (pkg === "gh") return "brew install gh";
    if (pkg === "claude") return "npm install -g @anthropic-ai/claude-code";
    if (pkg === "jq") return "brew install jq";
    return `Install ${pkg}`;
  }),
}));

// Mock tty functions
vi.mock("./tty.js", () => ({
  isCI: vi.fn(),
}));

// Mock inquirer
vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn(),
  },
}));

import {
  checkAllDependencies,
  displayDependencyStatus,
  getInstallInstructions,
  runSetupWizard,
  shouldRunSetupWizard,
} from "./wizard.js";
import { commandExists, isGhAuthenticated } from "./system.js";
import { isCI } from "./tty.js";
import inquirer from "inquirer";

const mockCommandExists = vi.mocked(commandExists);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);
const mockIsCI = vi.mocked(isCI);
const mockInquirerPrompt = vi.mocked(inquirer.prompt);

describe("wizard", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockIsCI.mockReturnValue(false);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe("checkAllDependencies", () => {
    it("detects all dependencies installed and authenticated", () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(true);

      const result = checkAllDependencies();

      expect(result.allRequiredMet).toBe(true);
      expect(result.hasMissing).toBe(false);
      expect(result.dependencies).toHaveLength(3);

      const ghDep = result.dependencies.find((d) => d.name === "gh");
      expect(ghDep?.installed).toBe(true);
      expect(ghDep?.authenticated).toBe(true);

      const claudeDep = result.dependencies.find((d) => d.name === "claude");
      expect(claudeDep?.installed).toBe(true);
    });

    it("detects missing gh CLI", () => {
      mockCommandExists.mockImplementation((cmd) => cmd !== "gh");
      mockIsGhAuthenticated.mockReturnValue(false);

      const result = checkAllDependencies();

      expect(result.allRequiredMet).toBe(false);
      expect(result.hasMissing).toBe(true);

      const ghDep = result.dependencies.find((d) => d.name === "gh");
      expect(ghDep?.installed).toBe(false);
    });

    it("detects gh installed but not authenticated", () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(false);

      const result = checkAllDependencies();

      expect(result.allRequiredMet).toBe(false);
      expect(result.hasMissing).toBe(true);

      const ghDep = result.dependencies.find((d) => d.name === "gh");
      expect(ghDep?.installed).toBe(true);
      expect(ghDep?.authenticated).toBe(false);
    });

    it("detects missing claude CLI", () => {
      mockCommandExists.mockImplementation((cmd) => cmd !== "claude");
      mockIsGhAuthenticated.mockReturnValue(true);

      const result = checkAllDependencies();

      expect(result.allRequiredMet).toBe(false);
      expect(result.hasMissing).toBe(true);

      const claudeDep = result.dependencies.find((d) => d.name === "claude");
      expect(claudeDep?.installed).toBe(false);
    });

    it("jq missing does not fail allRequiredMet (optional)", () => {
      mockCommandExists.mockImplementation((cmd) => cmd !== "jq");
      mockIsGhAuthenticated.mockReturnValue(true);

      const result = checkAllDependencies();

      // jq is optional, so all required should still be met
      expect(result.allRequiredMet).toBe(true);
      // But hasMissing only tracks required deps
      expect(result.hasMissing).toBe(false);

      const jqDep = result.dependencies.find((d) => d.name === "jq");
      expect(jqDep?.installed).toBe(false);
      expect(jqDep?.required).toBe(false);
    });
  });

  describe("displayDependencyStatus", () => {
    it("displays installed dependencies with checkmarks", () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(true);

      const result = checkAllDependencies();
      displayDependencyStatus(result);

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Checking dependencies");
      expect(output).toContain("GitHub CLI (gh)");
      expect(output).toContain("installed");
    });

    it("displays missing required dependencies with X mark", () => {
      mockCommandExists.mockReturnValue(false);
      mockIsGhAuthenticated.mockReturnValue(false);

      const result = checkAllDependencies();
      displayDependencyStatus(result);

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("not installed (required)");
    });

    it("displays unauthenticated gh with warning", () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(false);

      const result = checkAllDependencies();
      displayDependencyStatus(result);

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("installed but not authenticated");
    });
  });

  describe("getInstallInstructions", () => {
    it("returns install instructions for gh", () => {
      const instructions = getInstallInstructions("gh");

      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions.some((i) => i.includes("brew install gh"))).toBe(
        true,
      );
      expect(instructions.some((i) => i.includes("gh auth login"))).toBe(true);
    });

    it("returns install instructions for claude", () => {
      const instructions = getInstallInstructions("claude");

      expect(instructions.length).toBeGreaterThan(0);
      expect(
        instructions.some((i) => i.includes("@anthropic-ai/claude-code")),
      ).toBe(true);
    });

    it("returns install instructions for jq", () => {
      const instructions = getInstallInstructions("jq");

      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions.some((i) => i.includes("brew install jq"))).toBe(
        true,
      );
    });

    it("returns generic instruction for unknown package", () => {
      const instructions = getInstallInstructions("unknown-pkg");

      expect(instructions.length).toBe(1);
      expect(instructions[0]).toContain("Install unknown-pkg");
    });
  });

  describe("runSetupWizard", () => {
    it("returns completed when all dependencies are met", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(true);

      const depResult = checkAllDependencies();
      const wizardResult = await runSetupWizard(depResult);

      expect(wizardResult.skipped).toBe(false);
      expect(wizardResult.completed).toBe(true);
      expect(wizardResult.remainingIssues).toHaveLength(0);
    });

    it("returns skipped with issues when skipPrompts is true", async () => {
      mockCommandExists.mockImplementation((cmd) => cmd !== "claude");
      mockIsGhAuthenticated.mockReturnValue(true);

      const depResult = checkAllDependencies();
      const wizardResult = await runSetupWizard(depResult, {
        skipPrompts: true,
      });

      expect(wizardResult.skipped).toBe(true);
      expect(wizardResult.completed).toBe(false);
      expect(wizardResult.remainingIssues).toContain(
        "Claude Code CLI not installed",
      );
    });

    it("returns skipped when user declines setup", async () => {
      mockCommandExists.mockImplementation((cmd) => cmd !== "claude");
      mockIsGhAuthenticated.mockReturnValue(true);
      mockInquirerPrompt.mockResolvedValueOnce({ setupDeps: false });

      const depResult = checkAllDependencies();
      const wizardResult = await runSetupWizard(depResult);

      expect(wizardResult.skipped).toBe(true);
      expect(wizardResult.completed).toBe(false);
      expect(wizardResult.remainingIssues.length).toBeGreaterThan(0);
    });

    it("verifies installation when user confirms", async () => {
      // First check: claude is missing
      mockCommandExists.mockImplementation((cmd) => cmd !== "claude");
      mockIsGhAuthenticated.mockReturnValue(true);

      const depResult = checkAllDependencies();

      // User accepts wizard and verifies installation
      mockInquirerPrompt
        .mockResolvedValueOnce({ setupDeps: true })
        .mockResolvedValueOnce({ action: "verify" });

      // After verification, claude is now installed
      mockCommandExists.mockReturnValue(true);

      const wizardResult = await runSetupWizard(depResult);

      expect(wizardResult.completed).toBe(true);
      expect(wizardResult.remainingIssues).toHaveLength(0);
    });

    it("records remaining issues when user skips individual deps", async () => {
      mockCommandExists.mockImplementation((cmd) => cmd !== "claude");
      mockIsGhAuthenticated.mockReturnValue(true);

      const depResult = checkAllDependencies();

      // User accepts wizard but skips claude
      mockInquirerPrompt
        .mockResolvedValueOnce({ setupDeps: true })
        .mockResolvedValueOnce({ action: "skip" });

      const wizardResult = await runSetupWizard(depResult);

      expect(wizardResult.completed).toBe(false);
      expect(wizardResult.remainingIssues).toContain(
        "Claude Code CLI not installed",
      );
    });

    it("handles gh authentication issue specifically", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(false);

      const depResult = checkAllDependencies();
      const wizardResult = await runSetupWizard(depResult, {
        skipPrompts: true,
      });

      expect(wizardResult.remainingIssues).toContain(
        "GitHub CLI (gh) not authenticated",
      );
    });

    it("handles multiple missing dependencies in sequence", async () => {
      // Both gh and claude are missing
      mockCommandExists.mockReturnValue(false);
      mockIsGhAuthenticated.mockReturnValue(false);

      const depResult = checkAllDependencies();

      // User accepts wizard, verifies gh (success), skips claude
      mockInquirerPrompt
        .mockResolvedValueOnce({ setupDeps: true })
        .mockResolvedValueOnce({ action: "verify" }) // gh
        .mockResolvedValueOnce({ action: "skip" }); // claude

      // After first verify, gh is now installed and authenticated
      mockCommandExists.mockImplementation((cmd) => cmd === "gh");
      mockIsGhAuthenticated.mockReturnValue(true);

      const wizardResult = await runSetupWizard(depResult);

      expect(wizardResult.completed).toBe(false);
      expect(wizardResult.remainingIssues).toContain(
        "Claude Code CLI not installed",
      );
      expect(wizardResult.remainingIssues).not.toContain("GitHub CLI");
    });

    it("records issue when verification fails after user claims installation", async () => {
      mockCommandExists.mockImplementation((cmd) => cmd !== "claude");
      mockIsGhAuthenticated.mockReturnValue(true);

      const depResult = checkAllDependencies();

      // User accepts and tries to verify, but it's still not installed
      mockInquirerPrompt
        .mockResolvedValueOnce({ setupDeps: true })
        .mockResolvedValueOnce({ action: "verify" });

      // claude still not installed after "verification"
      // (mockCommandExists already returns false for claude)

      const wizardResult = await runSetupWizard(depResult);

      expect(wizardResult.completed).toBe(false);
      expect(wizardResult.remainingIssues).toContain(
        "Claude Code CLI not installed",
      );
    });
  });

  describe("shouldRunSetupWizard", () => {
    it("returns false when skipSetup is true", () => {
      expect(shouldRunSetupWizard({ skipSetup: true })).toBe(false);
    });

    it("returns false in CI environment", () => {
      mockIsCI.mockReturnValue(true);

      expect(shouldRunSetupWizard({})).toBe(false);
    });

    it("returns true in normal terminal environment", () => {
      mockIsCI.mockReturnValue(false);

      expect(shouldRunSetupWizard({})).toBe(true);
    });

    it("returns true even with yes flag (wizard still runs)", () => {
      mockIsCI.mockReturnValue(false);

      expect(shouldRunSetupWizard({ yes: true })).toBe(true);
    });
  });
});
