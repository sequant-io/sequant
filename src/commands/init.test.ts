import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fs functions
vi.mock("../lib/fs.js", () => ({
  fileExists: vi.fn(),
  ensureDir: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
}));

// Mock settings
vi.mock("../lib/settings.js", () => ({
  createDefaultSettings: vi.fn(),
  SETTINGS_PATH: ".sequant/settings.json",
}));

// Mock stacks
vi.mock("../lib/stacks.js", () => ({
  detectStack: vi.fn(),
  getStackConfig: vi.fn(() => ({
    name: "generic",
    displayName: "Generic",
    devUrl: "http://localhost:3000",
    variables: {
      TEST_COMMAND: "npm test",
      BUILD_COMMAND: "npm run build",
      LINT_COMMAND: "npm run lint",
    },
  })),
}));

// Mock config
vi.mock("../lib/config.js", () => ({
  saveConfig: vi.fn(),
}));

// Mock templates
vi.mock("../lib/templates.js", () => ({
  copyTemplates: vi.fn(),
}));

// Mock manifest
vi.mock("../lib/manifest.js", () => ({
  createManifest: vi.fn(),
}));

// Mock system functions
vi.mock("../lib/system.js", () => ({
  commandExists: vi.fn(),
  isGhAuthenticated: vi.fn(),
  getInstallHint: vi.fn((pkg: string) => {
    if (pkg === "gh") return "brew install gh";
    if (pkg === "jq") return "brew install jq";
    return `Install ${pkg}`;
  }),
}));

// Mock TTY functions
vi.mock("../lib/tty.js", () => ({
  shouldUseInteractiveMode: vi.fn(),
  getNonInteractiveReason: vi.fn(),
}));

// Mock inquirer
vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn(),
  },
}));

import { initCommand } from "./init.js";
import { fileExists, ensureDir } from "../lib/fs.js";
import { detectStack } from "../lib/stacks.js";
import { copyTemplates } from "../lib/templates.js";
import { createManifest } from "../lib/manifest.js";
import { saveConfig } from "../lib/config.js";
import { createDefaultSettings } from "../lib/settings.js";
import { commandExists, isGhAuthenticated } from "../lib/system.js";
import {
  shouldUseInteractiveMode,
  getNonInteractiveReason,
} from "../lib/tty.js";
import inquirer from "inquirer";

const mockFileExists = vi.mocked(fileExists);
const mockEnsureDir = vi.mocked(ensureDir);
const mockDetectStack = vi.mocked(detectStack);
const mockCopyTemplates = vi.mocked(copyTemplates);
const mockCreateManifest = vi.mocked(createManifest);
const mockSaveConfig = vi.mocked(saveConfig);
const mockCreateDefaultSettings = vi.mocked(createDefaultSettings);
const mockCommandExists = vi.mocked(commandExists);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);
const mockShouldUseInteractiveMode = vi.mocked(shouldUseInteractiveMode);
const mockGetNonInteractiveReason = vi.mocked(getNonInteractiveReason);
const mockInquirerPrompt = vi.mocked(inquirer.prompt);

describe("init command", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Default: not initialized, all commands work
    mockFileExists.mockResolvedValue(false);
    mockEnsureDir.mockResolvedValue(undefined);
    mockDetectStack.mockResolvedValue(null);
    mockCopyTemplates.mockResolvedValue(undefined);
    mockCreateManifest.mockResolvedValue(undefined);
    mockSaveConfig.mockResolvedValue(undefined);
    mockCreateDefaultSettings.mockResolvedValue(undefined);
    mockCommandExists.mockReturnValue(true);
    mockIsGhAuthenticated.mockReturnValue(true);
    // Default: interactive mode enabled (TTY detected)
    mockShouldUseInteractiveMode.mockReturnValue(true);
    mockGetNonInteractiveReason.mockReturnValue(null);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  describe("prerequisite checks", () => {
    it("shows no warnings when all prerequisites are met", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(true);

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).not.toContain("Prerequisites:");
      expect(output).not.toContain("GitHub CLI (gh) is not installed");
      expect(output).not.toContain("GitHub CLI is not authenticated");
      expect(output).toContain("Sequant initialized successfully");
    });

    it("warns when gh CLI is not installed", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "gh");
      mockIsGhAuthenticated.mockReturnValue(false);

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Prerequisites:");
      expect(output).toContain("GitHub CLI (gh) is not installed");
      expect(output).toContain("Remember to address prerequisites");
    });

    it("warns when gh CLI is not authenticated", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(false);

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Prerequisites:");
      expect(output).toContain("GitHub CLI is not authenticated");
      expect(output).toContain("gh auth login");
      expect(output).toContain("Remember to address prerequisites");
    });

    it("shows optional jq suggestion when jq is not installed", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "jq");
      mockIsGhAuthenticated.mockReturnValue(true);

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Optional improvements:");
      expect(output).toContain("Install jq for faster JSON parsing");
      // Should NOT show prerequisites warning since jq is optional
      expect(output).not.toContain("Prerequisites:");
    });

    it("shows both gh warning and jq suggestion when both are missing", async () => {
      mockCommandExists.mockReturnValue(false);
      mockIsGhAuthenticated.mockReturnValue(false);

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Prerequisites:");
      expect(output).toContain("GitHub CLI (gh) is not installed");
      expect(output).toContain("Optional improvements:");
      expect(output).toContain("Install jq for faster JSON parsing");
    });

    it("skips auth check when gh is not installed", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "gh");

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should only show "not installed", not "not authenticated"
      expect(output).toContain("GitHub CLI (gh) is not installed");
      expect(output).not.toContain("GitHub CLI is not authenticated");
    });
  });

  describe("initialization flow", () => {
    it("completes successfully with --yes and --stack flags", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(true);

      await initCommand({ yes: true, stack: "nextjs" });

      expect(mockEnsureDir).toHaveBeenCalledWith(".claude/skills");
      expect(mockEnsureDir).toHaveBeenCalledWith(".claude/hooks");
      expect(mockEnsureDir).toHaveBeenCalledWith(".claude/memory");
      expect(mockEnsureDir).toHaveBeenCalledWith(".claude/.sequant");
      expect(mockEnsureDir).toHaveBeenCalledWith(".sequant/logs");
      expect(mockEnsureDir).toHaveBeenCalledWith("scripts/dev");
      expect(mockCreateDefaultSettings).toHaveBeenCalled();
      expect(mockSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          tokens: { DEV_URL: "http://localhost:3000" },
          stack: "nextjs",
        }),
      );
      expect(mockCopyTemplates).toHaveBeenCalledWith("nextjs", {
        DEV_URL: "http://localhost:3000",
      });
      expect(mockCreateManifest).toHaveBeenCalledWith("nextjs");

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Sequant initialized successfully");
    });

    it("warns but continues when already initialized without --force", async () => {
      mockFileExists.mockImplementation(async (path: string) => {
        return path === ".claude/settings.json";
      });
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(true);

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("already initialized");
    });
  });

  describe("non-interactive mode (TTY detection)", () => {
    it("shows non-interactive message when TTY is not available", async () => {
      mockShouldUseInteractiveMode.mockReturnValue(false);
      mockGetNonInteractiveReason.mockReturnValue(
        "stdin is not a terminal (piped input detected)",
      );

      await initCommand({ stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Non-interactive mode detected");
      expect(output).toContain("stdin is not a terminal");
      expect(output).toContain("Use --interactive to force prompts");
      expect(output).toContain("Sequant initialized successfully");
    });

    it("does not show non-interactive message when --yes is used", async () => {
      mockShouldUseInteractiveMode.mockReturnValue(false);
      mockGetNonInteractiveReason.mockReturnValue("running in CI environment");

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).not.toContain("Non-interactive mode detected");
      expect(output).toContain("Sequant initialized successfully");
    });

    it("uses detected stack as default in non-interactive mode", async () => {
      mockShouldUseInteractiveMode.mockReturnValue(false);
      mockGetNonInteractiveReason.mockReturnValue("running in CI environment");
      mockDetectStack.mockResolvedValue("nextjs");

      await initCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Detected stack: nextjs (default)");
      expect(mockSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          stack: "nextjs",
        }),
      );
    });

    it("uses generic stack when no detection in non-interactive mode", async () => {
      mockShouldUseInteractiveMode.mockReturnValue(false);
      mockGetNonInteractiveReason.mockReturnValue("running in CI environment");
      mockDetectStack.mockResolvedValue(null);

      await initCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Using stack: generic (default)");
      expect(mockSaveConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          stack: "generic",
        }),
      );
    });

    it("skips all prompts in non-interactive mode", async () => {
      mockShouldUseInteractiveMode.mockReturnValue(false);
      mockGetNonInteractiveReason.mockReturnValue(
        "running in CI environment (github actions)",
      );

      await initCommand({});

      // Inquirer.prompt should never be called
      expect(mockInquirerPrompt).not.toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Sequant initialized successfully");
    });

    it("forces interactive mode with --interactive flag", async () => {
      // When --interactive is passed, shouldUseInteractiveMode returns true
      mockShouldUseInteractiveMode.mockReturnValue(true);

      // Setup prompts to return values
      mockInquirerPrompt
        .mockResolvedValueOnce({ selectedStack: "python" })
        .mockResolvedValueOnce({ inputDevUrl: "http://localhost:8000" })
        .mockResolvedValueOnce({ confirm: true });

      await initCommand({ interactive: true });

      // shouldUseInteractiveMode should be called with the interactive flag
      expect(mockShouldUseInteractiveMode).toHaveBeenCalledWith(true);
      // Prompts should have been called
      expect(mockInquirerPrompt).toHaveBeenCalled();
    });

    it("shows CI environment name in non-interactive message", async () => {
      mockShouldUseInteractiveMode.mockReturnValue(false);
      mockGetNonInteractiveReason.mockReturnValue(
        "running in CI environment (github actions)",
      );

      await initCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("github actions");
    });

    it("uses default dev URL in non-interactive mode", async () => {
      mockShouldUseInteractiveMode.mockReturnValue(false);
      mockGetNonInteractiveReason.mockReturnValue("running in CI environment");

      await initCommand({});

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Dev URL: http://localhost:3000 (default)");
    });
  });
});
