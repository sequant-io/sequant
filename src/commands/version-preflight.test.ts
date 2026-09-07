// #988 AC-1: the per-command skills pre-flight is warn-only. A stale install
// (version marker ≠ package) must produce a warning and leave every project
// file byte-identical. Until #988 this branch ran `syncCommand({ quiet: true })`,
// a silent forced template copy — the exact write this test forbids.
//
// Mutation-verified: restoring `await syncCommand({ quiet: true })` in the
// `outdated` branch of runVersionPreflight copies the bundled templates into
// the fixture and the "pre-tool.sh is untouched" assertion fails.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PREFLIGHT_EXEMPT_COMMANDS,
  formatSkillsInstallWarning,
  getSkillsInstallStatus,
  runVersionPreflight,
} from "./version-preflight.js";

const CUSTOM_HOOK = "#!/bin/bash\necho custom commit-on-main guard\n";

function writeStaleProject(root: string): void {
  fs.mkdirSync(path.join(root, ".claude", "skills", "qa"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".sequant-manifest.json"),
    JSON.stringify({ version: "0.0.1", stack: "nextjs", files: {} }),
  );
  // Marker far below any real package version → `outdated: true`.
  fs.writeFileSync(path.join(root, ".claude", "skills", ".sequant-version"), "0.0.1");
  fs.writeFileSync(path.join(root, ".claude", "hooks", "pre-tool.sh"), CUSTOM_HOOK);
  fs.writeFileSync(path.join(root, ".claude", "skills", "qa", "SKILL.md"), "# custom qa\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "custom agents\n");
}

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(root, full), fs.readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return out;
}

describe("#988 AC-1: runVersionPreflight is warn-only", () => {
  let root: string;
  let prevCwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-preflight-"));
    writeStaleProject(root);
    prevCwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("warns on a stale marker and writes nothing", async () => {
    const before = snapshot(root);
    const warn = vi.fn(async () => true);

    const { getManifest } = await import("../lib/manifest.js");
    const { areSkillsOutdated } = await import("./sync.js");
    const outcome = await runVersionPreflight("status", {
      getManifest,
      areSkillsOutdated,
      warn,
    });

    expect(outcome).toBe("warned");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({
      outdated: true,
      currentVersion: "0.0.1",
    });

    // The load-bearing assertion: the customized hook — and every other file
    // in the fixture — is byte-identical after the pre-flight.
    expect(
      fs.readFileSync(path.join(root, ".claude", "hooks", "pre-tool.sh"), "utf8"),
    ).toBe(CUSTOM_HOOK);
    expect(snapshot(root)).toEqual(before);
    // No new files either (a template copy would add dozens).
    expect(fs.existsSync(path.join(root, ".claude", "skills", "spec"))).toBe(false);
  });

  it("exempts serve (stdout is the MCP channel) alongside init/sync/update", async () => {
    for (const cmd of ["init", "sync", "update", "serve"]) {
      expect(PREFLIGHT_EXEMPT_COMMANDS.has(cmd)).toBe(true);
      const warn = vi.fn(async () => true);
      const { getManifest } = await import("../lib/manifest.js");
      const { areSkillsOutdated } = await import("./sync.js");
      expect(
        await runVersionPreflight(cmd, { getManifest, areSkillsOutdated, warn }),
      ).toBe("exempt");
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it("stays silent when the project has no manifest or manages skills by hand", async () => {
    const warn = vi.fn(async () => true);
    const { getManifest } = await import("../lib/manifest.js");
    const { areSkillsOutdated } = await import("./sync.js");

    fs.rmSync(path.join(root, ".claude", "skills", ".sequant-version"));
    expect(
      await runVersionPreflight("status", { getManifest, areSkillsOutdated, warn }),
    ).toBe("unmanaged");

    fs.rmSync(path.join(root, ".sequant-manifest.json"));
    expect(
      await runVersionPreflight("status", { getManifest, areSkillsOutdated, warn }),
    ).toBe("no-manifest");
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("#988 AC-3: install status for serve", () => {
  let root: string;
  let prevCwd: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-install-"));
    writeStaleProject(root);
    prevCwd = process.cwd();
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports stale + remediation, says nothing was modified, and modifies nothing", async () => {
    const before = snapshot(root);
    const status = await getSkillsInstallStatus();
    expect(status).toMatchObject({
      managed: true,
      outdated: true,
      currentVersion: "0.0.1",
      filesModified: false,
    });
    expect(status!.remediation).toMatch(/^(npx )?sequant update$/);
    expect(formatSkillsInstallWarning(status)).toMatch(
      /^!  Skills install is stale \(0\.0\.1 → \d+\.\d+\.\d+[^)]*\)\. No files were modified\. Run: (npx )?sequant update$/,
    );
    expect(snapshot(root)).toEqual(before);
  });

  it("returns null with no manifest and no warning line when clean", async () => {
    fs.rmSync(path.join(root, ".sequant-manifest.json"));
    expect(await getSkillsInstallStatus()).toBeNull();
    expect(formatSkillsInstallWarning(null)).toBeNull();
    expect(
      formatSkillsInstallWarning({
        managed: true,
        outdated: false,
        currentVersion: "1.0.0",
        packageVersion: "1.0.0",
        contentDrift: 0,
        filesModified: false,
      }),
    ).toBeNull();
  });
});
