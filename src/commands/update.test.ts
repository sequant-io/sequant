import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Only `resolvePackageManager` is replaced; everything else in stacks.js stays
// real, so PM_CONFIG lookups downstream of the resolution are genuine.
//
// Deliberately NOT `vi.spyOn(process, "cwd")`. An earlier revision of these
// tests faked the cwd so the resolver would read a temp-dir lockfile. Because
// `pool: "forks"` reuses a worker across test files, that process-global patch
// leaked: full-suite wall clock went 211s → 695s and four *unrelated* files
// (semgrep, mcp-serve, App.tsx, lock-manager) began timing out. It also let
// `syncSequantMcpPin` write the repo's real `.mcp.json` whenever the fake cwd
// was not active. Faking a process global to test a pure function's argument
// was the wrong lever — the resolver's own semantics are covered directly in
// `src/lib/stacks.resolve-package-manager.test.ts` (12 cases, mutation-
// verified against a real temp dir). What is left to pin here is the *wiring*,
// which needs no filesystem at all.
vi.mock("../lib/stacks.js", async (importActual) => {
  const actual = await importActual<typeof import("../lib/stacks.js")>();
  return { ...actual, resolvePackageManager: vi.fn() };
});
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

// `updateCommand` pins the MCP server version before it computes template
// changes, and that write is real. The pre-existing tests never noticed
// because they all pass `--dry-run`; the #870 cases below exercise the
// non-dry-run path, which rewrote the repo's own `.mcp.json` on every run.
vi.mock("../lib/mcp-config.js", () => ({
  syncSequantMcpPin: vi.fn(() => ({ changed: false })),
}));

import { getManifest, getPackageVersion } from "../lib/manifest.js";
import { computeTemplateChanges } from "../lib/templates.js";
import { getConfig, saveConfig } from "../lib/config.js";
import { resolvePackageManager } from "../lib/stacks.js";
import { updateCommand } from "./update.js";

const mockGetManifest = vi.mocked(getManifest);
const mockGetPackageVersion = vi.mocked(getPackageVersion);
const mockComputeTemplateChanges = vi.mocked(computeTemplateChanges);
const mockGetConfig = vi.mocked(getConfig);
const mockSaveConfig = vi.mocked(saveConfig);
const mockResolvePackageManager = vi.mocked(resolvePackageManager);

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
  // `update.ts` used to spell this `(manifest.packageManager as keyof typeof
  // PM_CONFIG) || "npm"` at three sites. The manifest field is absent precisely
  // on pre-1.3.0 installs — the population the PM_RUN backfill below exists to
  // serve — so the site most likely to run without a recorded manager was the
  // one hardcoding npm, writing an npm PM_RUN into pnpm/yarn/bun projects.
  //
  // These tests pin the wiring: that `update` asks the resolver rather than
  // assuming, hands it the manifest value and the project root, and lets the
  // answer drive PM_RUN. The resolver's own lockfile semantics live in
  // stacks.resolve-package-manager.test.ts.
  let prevExitCode: typeof process.exitCode;

  /** Pre-1.3.0 manifest shape: initialized, but no packageManager recorded. */
  const MANIFEST_NO_PM = {
    version: "2.6.1",
    stack: "generic",
    installedAt: "2024-01-01",
    files: {},
  };

  beforeEach(() => {
    prevExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockGetManifest.mockResolvedValue(MANIFEST_NO_PM);
    mockGetPackageVersion.mockReturnValue("2.6.1");
    mockResolvePackageManager.mockReturnValue("npm");
    // Nothing to apply → the command short-circuits before any file write, so
    // no template rendering, no install, and no `.mcp.json` rewrite.
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
    mockResolvePackageManager.mockReset();
  });

  it("consults the resolver with the manifest value and the project root", async () => {
    mockGetConfig.mockResolvedValue(null);

    await updateCommand({ dryRun: true });

    // Reverting to the bare `|| "npm"` literal removes this call entirely.
    expect(mockResolvePackageManager).toHaveBeenCalledWith(
      undefined, // manifest recorded no packageManager
      process.cwd(), // update operates on the project in place
    );
  });

  it("backfills a legacy install's PM_RUN from the resolved manager", async () => {
    mockResolvePackageManager.mockReturnValue("pnpm");
    mockGetConfig.mockResolvedValue({
      tokens: { DEV_URL: "http://localhost:3000" }, // PM_RUN missing → backfill
      stack: "generic",
      initialized: "2024-01-01",
    });

    await updateCommand({});

    expect(mockSaveConfig).toHaveBeenCalled();
    expect(mockSaveConfig.mock.calls.at(-1)![0].tokens.PM_RUN).toBe("pnpm run");
  });

  it("writes the resolved manager's run command on first-time config setup", async () => {
    mockResolvePackageManager.mockReturnValue("yarn");
    mockGetConfig.mockResolvedValue(null);

    await updateCommand({ yes: true });

    // PM_CONFIG.yarn.run is bare "yarn" — yarn takes no `run` prefix. Reading
    // it from the real PM_CONFIG (not the mock) keeps this honest.
    expect(mockSaveConfig.mock.calls.at(-1)![0].tokens.PM_RUN).toBe("yarn");
  });

  it("still yields npm when the resolver reports npm", async () => {
    mockResolvePackageManager.mockReturnValue("npm");
    mockGetConfig.mockResolvedValue(null);

    await updateCommand({ yes: true });

    expect(mockSaveConfig.mock.calls.at(-1)![0].tokens.PM_RUN).toBe("npm run");
  });

  it("passes a manifest-recorded manager straight through to the resolver", async () => {
    mockGetManifest.mockResolvedValue({
      ...MANIFEST_NO_PM,
      packageManager: "bun",
    });
    mockGetConfig.mockResolvedValue(null);

    await updateCommand({ dryRun: true });

    expect(mockResolvePackageManager).toHaveBeenCalledWith(
      "bun",
      process.cwd(),
    );
  });
});
