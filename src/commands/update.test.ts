import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the modules `updateCommand` reads so the dry-run preview is fully
// driven by `computeTemplateChanges` — no real filesystem or templates needed.
vi.mock("../lib/manifest.js", () => ({
  getManifest: vi.fn(),
  updateManifest: vi.fn(async () => {}),
  getPackageVersion: vi.fn(() => "2.6.1"),
}));

vi.mock("../lib/templates.js", () => ({
  computeTemplateChanges: vi.fn(),
}));

vi.mock("../lib/config.js", () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(async () => {}),
}));

import { getManifest, getPackageVersion } from "../lib/manifest.js";
import { computeTemplateChanges } from "../lib/templates.js";
import { getConfig } from "../lib/config.js";
import { updateCommand } from "./update.js";

const mockGetManifest = vi.mocked(getManifest);
const mockGetPackageVersion = vi.mocked(getPackageVersion);
const mockComputeTemplateChanges = vi.mocked(computeTemplateChanges);
const mockGetConfig = vi.mocked(getConfig);

const INITIALIZED_MANIFEST = {
  version: "2.6.1",
  stack: "generic",
  installedAt: "2024-01-01",
  files: {},
  packageManager: "npm",
};

const CONFIG = {
  tokens: { DEV_URL: "http://localhost:3000", PM_RUN: "npm run" },
  stack: "generic",
  initialized: "2024-01-01",
};

// One pending "new" file → drives applySet non-empty.
const PENDING_NEW = {
  path: ".claude/skills/demo/SKILL.md",
  templatePath: "templates/skills/demo/SKILL.md",
  status: "new" as const,
  rendered: "new",
};

// An in-place customization → "local-override" (protected unless --force).
const LOCAL_OVERRIDE = {
  path: ".claude/memory/constitution.md",
  templatePath: "templates/memory/constitution.md",
  status: "local-override" as const,
  rendered: "template",
};

describe("update command — dry-run exit code (#724)", () => {
  let prevExitCode: typeof process.exitCode;

  beforeEach(() => {
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockGetManifest.mockResolvedValue(INITIALIZED_MANIFEST);
    mockGetPackageVersion.mockReturnValue("2.6.1");
    mockGetConfig.mockResolvedValue(CONFIG);
  });

  afterEach(() => {
    process.exitCode = prevExitCode;
    vi.restoreAllMocks();
  });

  it("sets exit code 1 when there is pending work (AC-1)", async () => {
    mockComputeTemplateChanges.mockResolvedValue([PENDING_NEW]);

    await updateCommand({ dryRun: true });

    // Pending new/modified work → non-zero so CI/automation can gate on it.
    expect(process.exitCode).toBe(1);
  });

  it("stays exit 0 when there is nothing to apply (AC-2)", async () => {
    mockComputeTemplateChanges.mockResolvedValue([
      {
        path: ".claude/skills/qa/SKILL.md",
        templatePath: "templates/skills/qa/SKILL.md",
        status: "unchanged",
        rendered: "same",
      },
    ]);

    await updateCommand({ dryRun: true });

    // No-op case short-circuits at "Everything is up to date!" → exit stays 0.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("stays exit 0 when only local overrides are protected (no --force)", async () => {
    // Without --force, local overrides are protected and excluded from applySet,
    // so there is nothing to apply — the preview must not signal drift.
    mockComputeTemplateChanges.mockResolvedValue([LOCAL_OVERRIDE]);

    await updateCommand({ dryRun: true });

    expect(process.exitCode ?? 0).toBe(0);
  });

  it("sets exit code 1 when --force will overwrite local overrides", async () => {
    // Under --force the override becomes pending work, so the preview signals it.
    mockComputeTemplateChanges.mockResolvedValue([LOCAL_OVERRIDE]);

    await updateCommand({ dryRun: true, force: true });

    expect(process.exitCode).toBe(1);
  });
});
