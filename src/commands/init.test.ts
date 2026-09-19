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
  generateSettingsReference: vi.fn(() => "# Settings Reference\n"),
  SETTINGS_PATH: ".sequant/settings.json",
}));

// Mock stacks
vi.mock("../lib/stacks.js", () => ({
  detectStack: vi.fn(),
  detectAllStacks: vi.fn(() => Promise.resolve([])),
  detectPackageManager: vi.fn(() => Promise.resolve("npm")),
  getPackageManagerCommands: vi.fn(() => ({
    run: "npm run",
    exec: "npx",
    install: "npm install",
    installSilent: "npm install --silent",
  })),
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
  STACKS: {
    nextjs: { displayName: "Next.js" },
    python: { displayName: "Python" },
    generic: { displayName: "Generic" },
  },
}));

// Mock config
vi.mock("../lib/config.js", () => ({
  saveConfig: vi.fn(),
}));

// Mock templates
// `ownershipPolicy` is deliberately NOT stubbed: `createDefaultSettings` reads
// it to decide preserve-vs-overwrite (#1090 AC-3), and a stub would make the
// #1071 preservation cases assert against the stub rather than the declared
// ownership table. `importOriginal` keeps it (and the rest of the module) real.
vi.mock("../lib/templates.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    copyTemplates: vi.fn(() =>
      Promise.resolve({ scriptsSymlinked: true, symlinkResults: [] }),
    ),
    // Templates-root guard (#822). Defaults to "present" so this suite exercises
    // the paths past the guard; the guard's own failure branch is covered in
    // templates.test.ts and sync-source-invocation.integration.test.ts.
    assertTemplatesDirExists: vi.fn(async () => "/pkg/templates"),
  };
});

// Mock manifest
vi.mock("../lib/manifest.js", () => ({
  createManifest: vi.fn(),
}));

// Mock stack-config
vi.mock("../lib/stack-config.js", () => ({
  saveStackConfig: vi.fn(),
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
  isCI: vi.fn(),
}));

// Mock wizard functions
vi.mock("../lib/wizard.js", () => ({
  checkAllDependencies: vi.fn(() => ({
    dependencies: [],
    allRequiredMet: true,
    hasMissing: false,
  })),
  displayDependencyStatus: vi.fn(),
  runSetupWizard: vi.fn(() =>
    Promise.resolve({
      skipped: false,
      completed: true,
      remainingIssues: [],
    }),
  ),
  shouldRunSetupWizard: vi.fn(() => false),
}));

// Mock mcp-config (no detected clients in tests)
vi.mock("../lib/mcp-config.js", () => ({
  detectMcpClients: vi.fn(() => []),
  addSequantToMcpConfig: vi.fn(() => true),
  getSequantMcpConfig: vi.fn(() => ({
    command: "npx",
    // Pinned to the installed version (#793); representative value for the mock.
    args: ["-y", "sequant@9.9.9", "serve"],
  })),
  isSequantInProjectMcpJson: vi.fn(() => false),
  createProjectMcpJson: vi.fn(() => ({
    created: true,
    merged: false,
    skipped: false,
  })),
}));

// Mock inquirer
vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn(),
  },
}));

// Mock cli-ui to pass through content without visual formatting
vi.mock("../lib/cli-ui.js", () => ({
  configureUI: vi.fn(),
  getUIConfig: vi.fn(() => ({ noColor: true, jsonMode: false })),
  colors: {
    success: (s: string) => s,
    error: (s: string) => s,
    warning: (s: string) => s,
    info: (s: string) => s,
    muted: (s: string) => s,
    header: (s: string) => s,
    label: (s: string) => s,
    value: (s: string) => s,
    accent: (s: string) => s,
    bold: (s: string) => s,
    pending: (s: string) => s,
    running: (s: string) => s,
    completed: (s: string) => s,
    failed: (s: string) => s,
  },
  logo: vi.fn(() => ""),
  banner: vi.fn(() => ""),
  box: vi.fn((content: string) => content),
  successBox: vi.fn((title: string, content?: string) =>
    content ? `${title}\n${content}` : title,
  ),
  errorBox: vi.fn((title: string, content?: string) =>
    content ? `${title}\n${content}` : title,
  ),
  warningBox: vi.fn((title: string, content?: string) =>
    content ? `${title}\n${content}` : title,
  ),
  headerBox: vi.fn((title: string) => title),
  table: vi.fn(() => ""),
  keyValueTable: vi.fn(() => ""),
  statusIcon: vi.fn(() => ""),
  printStatus: vi.fn(),
  divider: vi.fn(() => "---"),
  sectionHeader: vi.fn((title: string) => title),
  phaseProgress: vi.fn(() => ""),
  progressBar: vi.fn(() => ""),
  spinner: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    warn: vi.fn(),
    text: "",
  })),
  ui: {
    logo: vi.fn(() => ""),
    banner: vi.fn(() => ""),
    box: vi.fn((content: string) => content),
    successBox: vi.fn((title: string, content?: string) =>
      content ? `${title}\n${content}` : title,
    ),
    errorBox: vi.fn((title: string, content?: string) =>
      content ? `${title}\n${content}` : title,
    ),
    warningBox: vi.fn((title: string, content?: string) =>
      content ? `${title}\n${content}` : title,
    ),
    headerBox: vi.fn((title: string) => title),
    table: vi.fn(() => ""),
    keyValueTable: vi.fn(() => ""),
    statusIcon: vi.fn(() => ""),
    printStatus: vi.fn(),
    divider: vi.fn(() => "---"),
    sectionHeader: vi.fn((title: string) => title),
    phaseProgress: vi.fn(() => ""),
    progressBar: vi.fn(() => ""),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      warn: vi.fn(),
      text: "",
    })),
  },
}));

import { initCommand } from "./init.js";
import { fileExists, ensureDir, readFile, writeFile } from "../lib/fs.js";
import { detectStack, detectAllStacks } from "../lib/stacks.js";
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
import {
  detectMcpClients,
  addSequantToMcpConfig,
  createProjectMcpJson,
} from "../lib/mcp-config.js";

const mockFileExists = vi.mocked(fileExists);
const mockEnsureDir = vi.mocked(ensureDir);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockDetectStack = vi.mocked(detectStack);
const mockDetectAllStacks = vi.mocked(detectAllStacks);
const mockCopyTemplates = vi.mocked(copyTemplates);
const mockCreateManifest = vi.mocked(createManifest);
const mockSaveConfig = vi.mocked(saveConfig);
const mockCreateDefaultSettings = vi.mocked(createDefaultSettings);
const mockCommandExists = vi.mocked(commandExists);
const mockIsGhAuthenticated = vi.mocked(isGhAuthenticated);
const mockShouldUseInteractiveMode = vi.mocked(shouldUseInteractiveMode);
const mockGetNonInteractiveReason = vi.mocked(getNonInteractiveReason);
const mockInquirerPrompt = vi.mocked(inquirer.prompt);
const mockDetectMcpClients = vi.mocked(detectMcpClients);
const mockAddSequantToMcpConfig = vi.mocked(addSequantToMcpConfig);
const mockCreateProjectMcpJson = vi.mocked(createProjectMcpJson);

describe("init command", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Default: not initialized, all commands work
    mockFileExists.mockResolvedValue(false);
    mockEnsureDir.mockResolvedValue(undefined);
    mockDetectStack.mockResolvedValue(null);
    mockCopyTemplates.mockResolvedValue({
      scriptsSymlinked: true,
      symlinkResults: [],
    });
    mockCreateManifest.mockResolvedValue(undefined);
    mockSaveConfig.mockResolvedValue(undefined);
    // createDefaultSettings now reports what it did (#1071) — the default
    // here is the fresh-repo outcome the rest of this suite assumes.
    mockCreateDefaultSettings.mockResolvedValue({
      action: "created",
      path: ".sequant/settings.json",
      updatedKeys: [],
    });
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

    it("warns when gh CLI is not installed (with --skip-setup)", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "gh");
      mockIsGhAuthenticated.mockReturnValue(false);

      // Using skipSetup triggers legacy warning behavior
      await initCommand({ yes: true, stack: "generic", skipSetup: true });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Prerequisites:");
      expect(output).toContain("GitHub CLI (gh) is not installed");
      expect(output).toContain("Remember to install missing dependencies");
    });

    it("warns when gh CLI is not authenticated (with --skip-setup)", async () => {
      mockCommandExists.mockReturnValue(true);
      mockIsGhAuthenticated.mockReturnValue(false);

      // Using skipSetup triggers legacy warning behavior
      await initCommand({ yes: true, stack: "generic", skipSetup: true });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Prerequisites:");
      expect(output).toContain("GitHub CLI is not authenticated");
      expect(output).toContain("gh auth login");
      expect(output).toContain("Remember to install missing dependencies");
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

    it("shows both gh warning and jq suggestion when both are missing (with --skip-setup)", async () => {
      mockCommandExists.mockReturnValue(false);
      mockIsGhAuthenticated.mockReturnValue(false);

      // Using skipSetup triggers legacy warning behavior
      await initCommand({ yes: true, stack: "generic", skipSetup: true });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Prerequisites:");
      expect(output).toContain("GitHub CLI (gh) is not installed");
      expect(output).toContain("Optional improvements:");
      expect(output).toContain("Install jq for faster JSON parsing");
    });

    it("skips auth check when gh is not installed (with --skip-setup)", async () => {
      mockCommandExists.mockImplementation((cmd: string) => cmd !== "gh");

      // Using skipSetup triggers legacy warning behavior
      await initCommand({ yes: true, stack: "generic", skipSetup: true });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      // Should only show "not installed", not "not authenticated"
      expect(output).toContain("GitHub CLI (gh) is not installed");
      expect(output).not.toContain("GitHub CLI is not authenticated");
    });

    it("shows skip-setup message when wizard is skipped", async () => {
      await initCommand({ yes: true, stack: "generic", skipSetup: true });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Skipping dependency setup wizard");
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
          tokens: { DEV_URL: "http://localhost:3000", PM_RUN: "npm run" },
          stack: "nextjs",
        }),
      );
      expect(mockCopyTemplates).toHaveBeenCalledWith(
        "nextjs",
        {
          DEV_URL: "http://localhost:3000",
          PM_RUN: "npm run",
        },
        {
          noSymlinks: undefined,
          force: undefined,
          additionalStacks: [],
        },
      );
      expect(mockCreateManifest).toHaveBeenCalledWith("nextjs", "npm");

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

  // === MULTI-STACK SELECTION UI (Issue #197) ===
  describe("multi-stack selection (AC-4, AC-5)", () => {
    it("shows multi-stack detection when multiple stacks found", async () => {
      // Given: Monorepo with multiple stacks detected
      mockDetectAllStacks.mockResolvedValue([
        { stack: "nextjs", path: "" },
        { stack: "python", path: "backend" },
      ]);

      // Setup prompts: checkbox selection, primary selection, dev URL
      mockInquirerPrompt
        .mockResolvedValueOnce({ selectedStacks: ["nextjs", "python"] })
        .mockResolvedValueOnce({ primaryStack: "nextjs" })
        .mockResolvedValueOnce({ inputDevUrl: "http://localhost:3000" })
        .mockResolvedValueOnce({ confirm: true });

      await initCommand({ interactive: true });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Detected 2 stacks");
      expect(output).toContain("Next.js");
      expect(output).toContain("Python");
    });

    it("passes additional stacks to copyTemplates", async () => {
      // Given: User selects multiple stacks with Next.js as primary
      mockDetectAllStacks.mockResolvedValue([
        { stack: "nextjs", path: "" },
        { stack: "python", path: "backend" },
      ]);

      mockInquirerPrompt
        .mockResolvedValueOnce({ selectedStacks: ["nextjs", "python"] })
        .mockResolvedValueOnce({ primaryStack: "nextjs" })
        .mockResolvedValueOnce({ inputDevUrl: "http://localhost:3000" })
        .mockResolvedValueOnce({ confirm: true });

      await initCommand({ interactive: true });

      // Then: copyTemplates receives additionalStacks
      expect(mockCopyTemplates).toHaveBeenCalledWith(
        "nextjs",
        expect.any(Object),
        expect.objectContaining({
          additionalStacks: ["python"],
        }),
      );
    });

    it("allows changing primary stack from checkbox selection", async () => {
      // Given: User selects python and nextjs, then picks python as primary
      mockDetectAllStacks.mockResolvedValue([
        { stack: "nextjs", path: "frontend" },
        { stack: "python", path: "backend" },
      ]);

      mockInquirerPrompt
        .mockResolvedValueOnce({ selectedStacks: ["nextjs", "python"] })
        .mockResolvedValueOnce({ primaryStack: "python" }) // Change to python
        .mockResolvedValueOnce({ inputDevUrl: "http://localhost:8000" })
        .mockResolvedValueOnce({ confirm: true });

      await initCommand({ interactive: true });

      // Then: python is primary, nextjs is additional
      expect(mockCopyTemplates).toHaveBeenCalledWith(
        "python",
        expect.any(Object),
        expect.objectContaining({
          additionalStacks: ["nextjs"],
        }),
      );
    });

    it("skips primary selection when only one stack selected", async () => {
      // Given: Multiple stacks detected but user only selects one
      mockDetectAllStacks.mockResolvedValue([
        { stack: "nextjs", path: "" },
        { stack: "python", path: "backend" },
      ]);

      mockInquirerPrompt
        .mockResolvedValueOnce({ selectedStacks: ["nextjs"] }) // Only select one
        .mockResolvedValueOnce({ inputDevUrl: "http://localhost:3000" })
        .mockResolvedValueOnce({ confirm: true });

      await initCommand({ interactive: true });

      // Then: No additional stacks, no primary selection prompt
      expect(mockCopyTemplates).toHaveBeenCalledWith(
        "nextjs",
        expect.any(Object),
        expect.objectContaining({
          additionalStacks: [],
        }),
      );
    });

    it("skips multi-stack UI in non-interactive mode", async () => {
      // Given: Multi-stack project but non-interactive mode
      mockShouldUseInteractiveMode.mockReturnValue(false);
      mockGetNonInteractiveReason.mockReturnValue("running in CI");
      mockDetectAllStacks.mockResolvedValue([
        { stack: "nextjs", path: "" },
        { stack: "python", path: "backend" },
      ]);
      mockDetectStack.mockResolvedValue("nextjs");

      await initCommand({});

      // Then: Falls back to single-stack detection
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).not.toContain("Detected 2 stacks");
      expect(output).toContain("Detected stack: nextjs");
      expect(mockInquirerPrompt).not.toHaveBeenCalled();
    });

    // === ERROR HANDLING (multi-stack) ===
    describe("error handling", () => {
      it("requires at least one stack selection", async () => {
        // Given: Multi-stack detection
        mockDetectAllStacks.mockResolvedValue([
          { stack: "nextjs", path: "" },
          { stack: "python", path: "backend" },
        ]);

        // When: Checkbox prompt has validation
        mockInquirerPrompt.mockImplementation(async (questions) => {
          const q = Array.isArray(questions) ? questions[0] : questions;
          if (q.type === "checkbox" && q.validate) {
            // Verify validation rejects empty selection
            const result = q.validate([]);
            expect(result).toBe("You must select at least one stack.");
          }
          return { selectedStacks: ["nextjs"] };
        });

        await initCommand({ interactive: true });
      });

      it("handles detectAllStacks failure gracefully", async () => {
        // Given: detectAllStacks throws an error
        mockDetectAllStacks.mockRejectedValue(new Error("Read error"));
        mockDetectStack.mockResolvedValue("generic");

        // When/Then: Should not crash, falls back to single-stack
        await expect(initCommand({ yes: true })).resolves.not.toThrow();
      });
    });
  });

  describe("MCP config behavior (#392)", () => {
    const fakeClients = [
      {
        name: "Claude Desktop",
        clientType: "claude-desktop" as const,
        configPath: "/fake/claude.json",
        exists: true,
      },
      {
        name: "Cursor",
        clientType: "cursor" as const,
        configPath: "/fake/cursor.json",
        exists: true,
      },
    ];

    it("does NOT auto-add MCP config with --yes alone", async () => {
      mockDetectMcpClients.mockReturnValue(fakeClients);

      await initCommand({ yes: true, stack: "generic" });

      expect(mockAddSequantToMcpConfig).not.toHaveBeenCalled();
      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("Skipping MCP config");
    });

    it("auto-adds MCP config with --yes --mcp", async () => {
      mockDetectMcpClients.mockReturnValue(fakeClients);

      await initCommand({ yes: true, mcp: true, stack: "generic" });

      expect(mockAddSequantToMcpConfig).toHaveBeenCalledTimes(2);
      expect(mockAddSequantToMcpConfig).toHaveBeenCalledWith(
        "/fake/claude.json",
        "claude-desktop",
      );
      expect(mockAddSequantToMcpConfig).toHaveBeenCalledWith(
        "/fake/cursor.json",
        "cursor",
      );
    });

    it("prompts user in interactive mode when MCP clients detected", async () => {
      mockDetectMcpClients.mockReturnValue(fakeClients);
      mockShouldUseInteractiveMode.mockReturnValue(true);

      // Setup prompts: stack selection, dev URL, confirmation, then MCP prompt
      mockInquirerPrompt
        .mockResolvedValueOnce({ selectedStack: "generic" })
        .mockResolvedValueOnce({ inputDevUrl: "http://localhost:3000" })
        .mockResolvedValueOnce({ confirm: true })
        .mockResolvedValueOnce({ confirm: true }); // MCP confirm

      await initCommand({ interactive: true });

      // The MCP prompt should have been called
      const promptCalls = mockInquirerPrompt.mock.calls;
      const mcpPrompt = promptCalls.find((call) => {
        const questions = Array.isArray(call[0]) ? call[0] : [call[0]];
        return questions.some(
          (q: Record<string, unknown>) =>
            typeof q.message === "string" && q.message.includes("MCP server"),
        );
      });
      expect(mcpPrompt).toBeDefined();
    });

    it("does NOT auto-add MCP config in non-interactive mode without --mcp", async () => {
      mockDetectMcpClients.mockReturnValue(fakeClients);
      mockShouldUseInteractiveMode.mockReturnValue(false);
      mockGetNonInteractiveReason.mockReturnValue("running in CI");

      await initCommand({});

      expect(mockAddSequantToMcpConfig).not.toHaveBeenCalled();
    });
  });

  describe(".mcp.json creation (#418)", () => {
    it("creates .mcp.json by default without --mcp flag", async () => {
      await initCommand({ yes: true, stack: "generic" });

      expect(mockCreateProjectMcpJson).toHaveBeenCalled();
    });

    it("creates .mcp.json with --yes flag", async () => {
      await initCommand({ yes: true, stack: "generic" });

      expect(mockCreateProjectMcpJson).toHaveBeenCalled();
    });

    it("creates .mcp.json even without --mcp flag in non-interactive mode", async () => {
      mockShouldUseInteractiveMode.mockReturnValue(false);
      mockGetNonInteractiveReason.mockReturnValue("running in CI");

      await initCommand({});

      expect(mockCreateProjectMcpJson).toHaveBeenCalled();
    });

    it("creates .mcp.json AND writes global configs with --mcp", async () => {
      const fakeClients = [
        {
          name: "Claude Desktop",
          clientType: "claude-desktop" as const,
          configPath: "/fake/claude.json",
          exists: true,
        },
      ];
      mockDetectMcpClients.mockReturnValue(fakeClients);

      await initCommand({ yes: true, mcp: true, stack: "generic" });

      // .mcp.json created
      expect(mockCreateProjectMcpJson).toHaveBeenCalled();
      // Global client config also written
      expect(mockAddSequantToMcpConfig).toHaveBeenCalledWith(
        "/fake/claude.json",
        "claude-desktop",
      );
    });

    it("does NOT write global configs without --mcp with --yes", async () => {
      const fakeClients = [
        {
          name: "Claude Desktop",
          clientType: "claude-desktop" as const,
          configPath: "/fake/claude.json",
          exists: true,
        },
      ];
      mockDetectMcpClients.mockReturnValue(fakeClients);

      await initCommand({ yes: true, stack: "generic" });

      // .mcp.json created
      expect(mockCreateProjectMcpJson).toHaveBeenCalled();
      // Global client config NOT written
      expect(mockAddSequantToMcpConfig).not.toHaveBeenCalled();
    });

    it("always shows .mcp.json in preview", async () => {
      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain(".mcp.json");
      expect(output).toContain("Claude Code MCP server config");
    });
  });

  // #848 (AC-3 audit): `--upgrade-skills` with no installed skills directory
  // printed a red error and bare-returned at exit 0. It must set exit 1 so a
  // scripted upgrade can detect the failure.
  describe("--upgrade-skills exit code (#848)", () => {
    let prevExitCode: typeof process.exitCode;

    beforeEach(() => {
      prevExitCode = process.exitCode;
      process.exitCode = undefined;
    });

    afterEach(() => {
      process.exitCode = prevExitCode;
    });

    it("sets exit 1 when no skills directory is found", async () => {
      // Default mockFileExists → false, so `.claude/skills` is absent.
      await initCommand({ upgradeSkills: true });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain("No skills directory found");
      expect(process.exitCode).toBe(1);
    });
  });

  // 497 AC-5: codex only loads project-layer hooks once the project is
  // marked trusted in the USER config (~/.codex/config.toml, not the
  // project one init writes). Init's completion output must state the exact
  // `trust_level = "trusted"` TOML requirement so a user cannot miss it.
  // #1059 F4: `init --agent <name>` provisions for that driver, so the driver
  // has to reach settings — otherwise `run.agent` stays unset, every later run
  // falls back to claude-code, and `doctor` runs none of that driver's checks
  // while the README says it does.
  describe("1059 F4: init persists the selected agent", () => {
    it("forwards --agent codex to createDefaultSettings", async () => {
      await initCommand({ yes: true, stack: "generic", agent: "codex" });

      expect(mockCreateDefaultSettings).toHaveBeenCalledWith(
        "codex",
        undefined,
      );
    });

    it("passes no agent when the flag is absent", async () => {
      await initCommand({ yes: true, stack: "generic" });

      expect(mockCreateDefaultSettings).toHaveBeenCalledWith(
        undefined,
        undefined,
      );
    });
  });

  describe("497 AC-5: codex trust requirement in init output", () => {
    it('prints the exact `trust_level = "trusted"` TOML requirement when --agent codex', async () => {
      await initCommand({ yes: true, stack: "generic", agent: "codex" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain('trust_level = "trusted"');
      expect(output).toContain("~/.codex/config.toml");
    });

    it("prints no codex trust message for another agent", async () => {
      await initCommand({ yes: true, stack: "generic", agent: "opencode" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).not.toContain('trust_level = "trusted"');
    });
  });

  // #1071: `init --agent <name>` on an already-initialized repo overwrote
  // `.sequant/settings.json` with defaults — `run.timeout` reset, the whole
  // `run.phases` block deleted, under a success banner. These cases drive the
  // REAL `createDefaultSettings` via importActual (the module is mocked
  // file-wide above); `../lib/fs.js` stays mocked, so the assertions are on
  // the readFile/writeFile calls the guard makes.
  describe("1071: init preserves an existing .sequant/settings.json", () => {
    const SETTINGS = ".sequant/settings.json";

    /** A tuned file: the exact keys the bug report saw destroyed. */
    const TUNED = JSON.stringify(
      {
        version: "1.0",
        run: {
          timeout: 5400,
          phases: { spec: "sonnet", exec: "sonnet", qa: "opus" },
        },
      },
      null,
      2,
    );

    type SettingsModule = typeof import("../lib/settings.js");
    let realCreateDefaultSettings: SettingsModule["createDefaultSettings"];
    let realStripJsoncComments: SettingsModule["stripJsoncComments"];

    beforeEach(async () => {
      const actual =
        await vi.importActual<SettingsModule>("../lib/settings.js");
      realCreateDefaultSettings = actual.createDefaultSettings;
      realStripJsoncComments = actual.stripJsoncComments;
      mockWriteFile.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(TUNED);
    });

    /** What the guard wrote to the settings file, parsed. `null` = never written. */
    function writtenSettings(): Record<string, unknown> | null {
      const call = mockWriteFile.mock.calls.find((c) => c[0] === SETTINGS);
      if (!call) return null;
      // Strip // comments so this works for both the JSONC default file and
      // the plain-JSON merge output.
      const stripped = String(call[1])
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      return JSON.parse(stripped) as Record<string, unknown>;
    }

    /** The raw string passed to `writeFile`, unparsed — for comment/byte checks. */
    function writtenRaw(): string | null {
      const call = mockWriteFile.mock.calls.find((c) => c[0] === SETTINGS);
      return call ? String(call[1]) : null;
    }

    it("AC-1: preserves run.timeout and run.phases instead of writing defaults", async () => {
      // Both files present — the fully-initialized repo from the report.
      mockFileExists.mockResolvedValue(true);

      const result = await realCreateDefaultSettings();

      expect(result.action).toBe("preserved");
      // Nothing written at all: the file stays byte-identical, comments and all.
      expect(writtenSettings()).toBeNull();
    });

    it("AC-2: --agent codex still records run.agent while preserving the rest", async () => {
      mockFileExists.mockResolvedValue(true);

      const result = await realCreateDefaultSettings("codex");

      expect(result.action).toBe("updated");
      expect(result.updatedKeys).toEqual(["run.agent"]);
      const written = writtenSettings() as {
        run: { agent: string; timeout: number; phases: Record<string, string> };
      };
      // #1059 behavior kept…
      expect(written.run.agent).toBe("codex");
      // …without taking the tuned keys down with it.
      expect(written.run.timeout).toBe(5400);
      expect(written.run.phases).toEqual({
        spec: "sonnet",
        exec: "sonnet",
        qa: "opus",
      });
    });

    it("AC-3: --force still overwrites with defaults", async () => {
      mockFileExists.mockResolvedValue(true);

      const result = await realCreateDefaultSettings(undefined, true);

      expect(result.action).toBe("created");
      const written = writtenSettings() as {
        run: { timeout: number; phases?: unknown };
      };
      expect(written.run.timeout).toBe(1800);
      expect(written.run.phases).toBeUndefined();
    });

    it("AC-4: init reports the preserved file instead of succeeding silently", async () => {
      // init-level: createDefaultSettings is the file-wide mock here, so this
      // asserts initCommand renders the decision it is handed. The spinner is
      // mocked out in this suite, so the line has to go through console.log.
      mockCreateDefaultSettings.mockResolvedValue({
        action: "preserved",
        path: SETTINGS,
        updatedKeys: [],
      });

      await initCommand({ yes: true, stack: "generic" });

      const output = consoleLogSpy.mock.calls.map((c) => c[0]).join("\n");
      expect(output).toContain(SETTINGS);
      expect(output).toMatch(/preserved/i);
    });

    it("AC-5: preserves even with no .claude/settings.json present", async () => {
      // The "already initialized" warning keys off `.claude/settings.json`;
      // the file destroyed is `.sequant/settings.json`. With only the latter
      // present the old code clobbered with no warning at all, so the guard
      // must key off the file it writes.
      mockFileExists.mockImplementation(async (path: string) =>
        path.includes(".sequant/settings.json"),
      );

      const result = await realCreateDefaultSettings("codex");

      expect(result.action).toBe("updated");
      const written = writtenSettings() as {
        run: { agent: string; timeout: number; phases: unknown };
      };
      expect(written.run.agent).toBe("codex");
      expect(written.run.timeout).toBe(5400);
      expect(written.run.phases).toEqual({
        spec: "sonnet",
        exec: "sonnet",
        qa: "opus",
      });
    });

    it("derived: leaves an unparseable settings file untouched and warns", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue('{ "run": { "timeout": 5400 ');

      const result = await realCreateDefaultSettings("codex");

      expect(result.action).toBe("preserved");
      expect(writtenSettings()).toBeNull();
      expect(result.warning).toContain(SETTINGS);
      expect(result.warning).toContain("--force");
    });

    it("1071: an explicit --agent claude-code switches back off a recorded driver", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(
        JSON.stringify({ run: { agent: "codex", timeout: 5400 } }),
      );

      const result = await realCreateDefaultSettings("claude-code");

      expect(result.action).toBe("updated");
      const written = writtenSettings() as { run: { agent: string } };
      expect(written.run.agent).toBe("claude-code");
    });

    // #1100: the update path used to round-trip through
    // JSON.stringify(merged, null, 2), which silently dropped every `//`
    // comment in the JSONC file `init --yes` generates. These cases exercise
    // the targeted raw-string edit that replaces only the `run.agent` line.
    const JSONC_FIXTURE = [
      "{",
      "  // Schema version for migration support",
      '  "version": "1.0",',
      "",
      "  // Run command settings",
      '  "run": {',
      "    // Default timeout per phase in seconds",
      '    "timeout": 5400',
      "  }",
      "}",
      "",
    ].join("\n");

    /** Length of the longest common subsequence of two line arrays. */
    function lcsLength(a: string[], b: string[]): number {
      const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
        new Array<number>(b.length + 1).fill(0),
      );
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          dp[i][j] =
            a[i - 1] === b[j - 1]
              ? dp[i - 1][j - 1] + 1
              : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
      return dp[a.length][b.length];
    }

    /** Lines in `after` not part of the LCS with `before` — insertions and changes both count once, and insertion doesn't inflate it. */
    function countChangedOrInsertedLines(
      before: string[],
      after: string[],
    ): number {
      return after.length - lcsLength(before, after);
    }

    it("1100 AC-1: preserves JSONC comments on the run.agent update", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(JSONC_FIXTURE);

      const result = await realCreateDefaultSettings("codex");

      expect(result.action).toBe("updated");
      const raw = writtenRaw();
      expect(raw).not.toBeNull();
      expect(raw).toContain("// Schema version for migration support");
      expect(raw).toContain("// Run command settings");
      expect(raw).toContain("// Default timeout per phase in seconds");

      const parsed = JSON.parse(realStripJsoncComments(raw as string)) as {
        run: { agent: string; timeout: number };
      };
      expect(parsed.run.agent).toBe("codex");
      expect(parsed.run.timeout).toBe(5400);
    });

    it("1100 AC-2: touches only the run.agent line", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(JSONC_FIXTURE);

      await realCreateDefaultSettings("codex");

      const raw = writtenRaw() as string;
      const changedOrInserted = countChangedOrInsertedLines(
        JSONC_FIXTURE.split("\n"),
        raw.split("\n"),
      );
      expect(changedOrInserted).toBe(1);
    });

    it("1100 AC-3: a blank settings file gets defaults with run.agent set, action created", async () => {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue("   \n");

      const result = await realCreateDefaultSettings("codex");

      expect(result.action).toBe("created");
      const written = writtenSettings() as { run: { agent: string } };
      expect(written.run.agent).toBe("codex");
    });

    /** AC-5: the written file must round-trip through the real loader path. */
    function parseWritten(raw: string): {
      run: Record<string, unknown>;
      scopeAssessment?: { run?: Record<string, unknown> };
    } {
      return JSON.parse(realStripJsoncComments(raw)) as ReturnType<
        typeof parseWritten
      >;
    }

    async function updateFixture(fixture: string): Promise<string> {
      mockFileExists.mockResolvedValue(true);
      mockReadFile.mockResolvedValue(fixture);
      const result = await realCreateDefaultSettings("codex");
      expect(result.action).toBe("updated");
      return writtenRaw() as string;
    }

    it("1100 AC-5: an empty run block gets a single-line insert that still parses", async () => {
      const fixture = [
        "{",
        '  "version": "1.0",',
        "  // nothing tuned yet",
        '  "run": {}',
        "}",
        "",
      ].join("\n");
      const raw = await updateFixture(fixture);
      expect(parseWritten(raw).run.agent).toBe("codex");
      expect(raw).toContain("// nothing tuned yet");
      expect(
        countChangedOrInsertedLines(fixture.split("\n"), raw.split("\n")),
      ).toBe(1);
    });

    it("1100 AC-5: a whitespace-only run block is treated like an empty one", async () => {
      const fixture = ["{", '  "run": {   }', "}", ""].join("\n");
      const raw = await updateFixture(fixture);
      expect(parseWritten(raw).run.agent).toBe("codex");
      expect(
        countChangedOrInsertedLines(fixture.split("\n"), raw.split("\n")),
      ).toBe(1);
    });

    it("1100 AC-5: a comment-only run block is inserted without a trailing comma", async () => {
      const fixture = [
        "{",
        '  "run": {',
        "    // per-phase models go here",
        "  }",
        "}",
        "",
      ].join("\n");
      const raw = await updateFixture(fixture);
      expect(parseWritten(raw).run.agent).toBe("codex");
      expect(raw).toContain("    // per-phase models go here");
      expect(
        countChangedOrInsertedLines(fixture.split("\n"), raw.split("\n")),
      ).toBe(1);
    });

    it('1100 AC-5: a comment quoting "run": { and a nested run key do not capture the edit', async () => {
      const fixture = [
        "{",
        '  // Example: "run": { "agent": "codex" }',
        '  "scopeAssessment": { "run": { "enabled": true } },',
        '  "run": {',
        '    "timeout": 5400',
        "  }",
        "}",
        "",
      ].join("\n");
      const raw = await updateFixture(fixture);
      expect(raw).toContain('  // Example: "run": { "agent": "codex" }');
      const parsed = parseWritten(raw);
      expect(parsed.run.agent).toBe("codex");
      expect(parsed.run.timeout).toBe(5400);
      expect(parsed.scopeAssessment?.run?.agent).toBeUndefined();
      expect(
        countChangedOrInsertedLines(fixture.split("\n"), raw.split("\n")),
      ).toBe(1);
    });
  });
});
