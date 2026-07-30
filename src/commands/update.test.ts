import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
import { getConfig, saveConfig } from "../lib/config.js";
import { updateCommand } from "./update.js";

const mockGetManifest = vi.mocked(getManifest);
const mockGetPackageVersion = vi.mocked(getPackageVersion);
const mockComputeTemplateChanges = vi.mocked(computeTemplateChanges);
const mockGetConfig = vi.mocked(getConfig);
const mockSaveConfig = vi.mocked(saveConfig);

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

  // #848: the not-initialized rejection bare-returned at exit 0, matching the
  // same bug fixed in run.ts. (The issue premise wrongly cited update.ts as a
  // correct reference — only sync.ts set the code on this branch.)
  it("sets exit code 1 when Sequant is not initialized (#848)", async () => {
    mockGetManifest.mockResolvedValue(null);

    await updateCommand({ dryRun: true });

    expect(process.exitCode).toBe(1);
  });
});

describe("update resolves the package manager when the manifest omits it (#870)", () => {
  // All three former `(manifest.packageManager as keyof typeof PM_CONFIG) ||
  // "npm"` sites now read one `const pm` resolved right after the manifest
  // loads, so exercising that single resolution covers every consumer.
  //
  // The manifest's packageManager is absent precisely on pre-1.3.0 installs —
  // the population the PM_RUN backfill exists to serve — so the old literal
  // wrote an npm PM_RUN into pnpm/yarn/bun projects. `process.cwd()` is
  // redirected at a real temp dir because the resolver reads lockfiles from
  // disk through `existsSync`.
  let dir: string;
  let prevExitCode: typeof process.exitCode;

  /** Pre-1.3.0 manifest shape: initialized, but no packageManager recorded. */
  const MANIFEST_NO_PM = {
    version: "2.6.1",
    stack: "generic",
    installedAt: "2024-01-01",
    files: {},
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sequant-870-update-"));
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    mockGetManifest.mockResolvedValue(MANIFEST_NO_PM);
    mockGetPackageVersion.mockReturnValue("2.6.1");
    // Nothing to apply → the command short-circuits before any file write.
    mockComputeTemplateChanges.mockResolvedValue([
      {
        path: ".claude/skills/qa/SKILL.md",
        templatePath: "templates/skills/qa/SKILL.md",
        status: "unchanged",
        rendered: "same",
      },
    ]);
  });

  afterEach(() => {
    process.exitCode = prevExitCode;
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("backfills PM_RUN from the lockfile, not npm, on a legacy pnpm install", async () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mockGetConfig.mockResolvedValue({
      tokens: { DEV_URL: "http://localhost:3000" }, // PM_RUN missing → backfill
      stack: "generic",
      initialized: "2024-01-01",
    });

    await updateCommand({});

    expect(mockSaveConfig).toHaveBeenCalled();
    const saved = mockSaveConfig.mock.calls.at(-1)![0];
    expect(saved.tokens.PM_RUN).toBe("pnpm run");
  });

  it("writes a yarn PM_RUN on first-time config setup for a yarn project", async () => {
    writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");
    mockGetConfig.mockResolvedValue(null); // no config → first-time setup path

    await updateCommand({ yes: true });

    const saved = mockSaveConfig.mock.calls.at(-1)![0];
    // PM_CONFIG.yarn.run is bare "yarn" — yarn takes no `run` prefix.
    expect(saved.tokens.PM_RUN).toBe("yarn");
  });

  it("still writes npm when the project has no lockfile at all", async () => {
    // Unchanged from before #870: detection's own npm default.
    mockGetConfig.mockResolvedValue(null);

    await updateCommand({ yes: true });

    const saved = mockSaveConfig.mock.calls.at(-1)![0];
    expect(saved.tokens.PM_RUN).toBe("npm run");
  });

  it("prefers a manifest that does record a manager over the lockfile", async () => {
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mockGetManifest.mockResolvedValue({
      ...MANIFEST_NO_PM,
      packageManager: "bun",
    });
    mockGetConfig.mockResolvedValue(null);

    await updateCommand({ yes: true });

    const saved = mockSaveConfig.mock.calls.at(-1)![0];
    expect(saved.tokens.PM_RUN).toBe("bun run");
  });
});
