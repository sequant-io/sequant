// #1409: a repo adopted with `init --manifest-only` + `sync --only skills`
// warned "N file(s) differ" forever — the drift count covered the whole
// template set, so every hook, agent and settings file the install skipped
// counted as drift — and the remedy it printed (`sync --force`) overwrote the
// repo's constitution. These tests run the real commands against the real
// bundled templates in a temp repo.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initCommand } from "./init.js";
import { areSkillsOutdated, syncCommand } from "./sync.js";
import { updateCommand } from "./update.js";
import {
  getSkillsInstallStatus,
  runVersionPreflight,
} from "./version-preflight.js";
import {
  getInstallScope,
  getManifest,
  updateManifest,
} from "../lib/manifest.js";

const CONSTITUTION = "# Our constitution\n\nRepo-owned. Never overwrite.\n";
const MANIFEST = ".sequant-manifest.json";

/** Every file under `root`, as relative path → content. */
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

/** Paths added, removed or changed between two snapshots. */
function changedPaths(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort();
}

/** Run a printed `… sync <flags>` remedy through the real sync command. */
async function runSyncRemedy(remedy: string): Promise<void> {
  const tokens = remedy.trim().split(/\s+/);
  const args = tokens.slice(tokens.lastIndexOf("sync") + 1);
  const onlyAt = args.indexOf("--only");
  const known = new Set(["--only", "skills", "--force"]);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    throw new Error(`remedy has flags this runner does not map: ${unknown}`);
  }
  await syncCommand({
    quiet: true,
    force: args.includes("--force"),
    ...(onlyAt >= 0 && { only: args[onlyAt + 1] as "skills" }),
  });
}

function captureLog(): { output: () => string; restore: () => void } {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  return {
    output: () => spy.mock.calls.map((c) => String(c[0])).join("\n"),
    restore: () => spy.mockRestore(),
  };
}

describe("#1409 skills-only install scope", () => {
  let root: string;
  let prevCwd: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "sequant-install-scope-"));
    prevCwd = process.cwd();
    process.chdir(root);
    fs.mkdirSync(path.join(root, ".claude", "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".claude", "memory", "constitution.md"),
      CONSTITUTION,
    );

    const log = captureLog();
    try {
      await initCommand({ manifestOnly: true, stack: "generic" });
      await syncCommand({ only: "skills", quiet: true });
    } finally {
      log.restore();
    }
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(root, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("AC-4: init --manifest-only + sync --only skills records the skills scope in the manifest", async () => {
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(root, MANIFEST), "utf8"),
    );
    expect(onDisk.groups).toEqual(["skills"]);
    const manifest = await getManifest();
    expect(getInstallScope(manifest!)).toEqual({
      kind: "partial",
      groups: ["skills"],
    });
  });

  it("AC-1: the status pre-flight reports drift 0 and prints no warning", async () => {
    // The skipped groups really are absent — they are what used to count.
    expect(fs.existsSync(path.join(root, ".claude", "hooks"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".claude", "settings.json"))).toBe(
      false,
    );

    expect((await areSkillsOutdated()).contentDrift).toBe(0);

    const log = captureLog();
    try {
      // Twice: the second run is served from the drift-fingerprint cache,
      // which must not hold a stale whole-template count.
      expect(await runVersionPreflight("status")).toBe("clean");
      expect(await runVersionPreflight("status")).toBe("clean");
      expect(log.output()).not.toContain("differ");
    } finally {
      log.restore();
    }
    expect((await areSkillsOutdated({ cache: true })).contentDrift).toBe(0);
  });

  it("AC-2: one modified SKILL.md drifts 1, and the printed remedy rewrites only .claude/skills/**", async () => {
    const skillsDir = path.join(root, ".claude", "skills");
    const skill = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .find(
        (e) =>
          e.isDirectory() &&
          fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")),
      );
    expect(skill).toBeDefined();
    const skillPath = path.join(skillsDir, skill!.name, "SKILL.md");
    const original = fs.readFileSync(skillPath, "utf8");
    fs.writeFileSync(skillPath, original + "\nlocal edit\n");

    expect((await areSkillsOutdated()).contentDrift).toBe(1);

    const log = captureLog();
    let remedy: string;
    try {
      expect(await runVersionPreflight("status")).toBe("warned");
      const output = log.output();
      expect(output).toContain("1 file(s) differ");
      const match = output.match(/Run: (.+)/);
      expect(match).not.toBeNull();
      remedy = match![1];
    } finally {
      log.restore();
    }
    expect(remedy).toMatch(/ sync --only skills --force$/);
    // `sequant://install` names the same remedy.
    expect((await getSkillsInstallStatus())?.remediation).toBe(remedy);

    const before = snapshot(root);
    await runSyncRemedy(remedy);
    const after = snapshot(root);

    const outsideSkills = changedPaths(before, after).filter(
      (p) =>
        !p.startsWith(".claude/skills/") &&
        p !== MANIFEST &&
        !p.startsWith(".claude/.sequant/"),
    );
    expect(outsideSkills).toEqual([]);
    expect(
      fs.readFileSync(
        path.join(root, ".claude", "memory", "constitution.md"),
        "utf8",
      ),
    ).toBe(CONSTITUTION);
    for (const skipped of [
      ".claude/hooks",
      ".claude/agents",
      ".claude/settings.json",
      "scripts/dev",
    ]) {
      expect(fs.existsSync(path.join(root, skipped))).toBe(false);
    }
    // The remedy fixed the drift it was printed for.
    expect(fs.readFileSync(skillPath, "utf8")).toBe(original);
    expect((await areSkillsOutdated()).contentDrift).toBe(0);
  });

  it("AC-4: a manifest without a scope field reads as a full install and counts new files outside .claude/skills/", async () => {
    const manifestPath = path.join(root, MANIFEST);
    const legacy = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete legacy.groups;
    fs.writeFileSync(manifestPath, JSON.stringify(legacy));

    expect(getInstallScope((await getManifest())!)).toEqual({ kind: "full" });
    // Same files on disk as the skills-only case, which drifts 0: the full
    // scope counts every hook, agent and settings file the install lacks.
    expect((await areSkillsOutdated()).contentDrift).toBeGreaterThan(1);
  });

  it("AC-4: sync --only never narrows a full install", async () => {
    const manifestPath = path.join(root, MANIFEST);
    const legacy = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete legacy.groups;
    fs.writeFileSync(manifestPath, JSON.stringify(legacy));

    await updateManifest({ addGroup: "skills" });

    const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect("groups" in onDisk).toBe(false);
  });

  it("plain sync keeps a skills-only scope (#1485 AC-5)", async () => {
    // Version mismatch, so the plain sync takes the apply path. It must write
    // only the skills group and keep the recorded scope.
    fs.writeFileSync(
      path.join(root, ".claude", "skills", ".sequant-version"),
      "0.0.1",
    );
    await syncCommand({ quiet: true });

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(root, MANIFEST), "utf8"),
    );
    expect(onDisk.groups).toEqual(["skills"]);
    for (const skipped of [
      ".claude/hooks",
      ".claude/agents",
      ".claude/settings.json",
    ]) {
      expect(fs.existsSync(path.join(root, skipped))).toBe(false);
    }
  });

  it("plain sync keeps a skills-only scope: --dry-run previews the same set (#1485 AC-5)", async () => {
    fs.writeFileSync(
      path.join(root, ".claude", "skills", ".sequant-version"),
      "0.0.1",
    );
    const log = captureLog();
    try {
      await syncCommand({ dryRun: true });
      expect(log.output()).not.toContain(".claude/hooks");
      expect(log.output()).not.toContain(".claude/settings.json");
    } finally {
      log.restore();
    }
  });

  it("plain sync keeps a skills-only scope: a manifest without groups still gets a full sync (#1485 AC-5)", async () => {
    const manifestPath = path.join(root, MANIFEST);
    const legacy = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete legacy.groups;
    fs.writeFileSync(manifestPath, JSON.stringify(legacy));
    fs.writeFileSync(
      path.join(root, ".claude", "skills", ".sequant-version"),
      "0.0.1",
    );
    await syncCommand({ quiet: true });
    expect(fs.existsSync(path.join(root, ".claude", "hooks"))).toBe(true);
  });

  function editOneSkill(): void {
    const skillsDir = path.join(root, ".claude", "skills");
    const skill = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .find(
        (e) =>
          e.isDirectory() &&
          fs.existsSync(path.join(skillsDir, e.name, "SKILL.md")),
      );
    const p = path.join(skillsDir, skill!.name, "SKILL.md");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8") + "\nlocal edit\n");
  }

  it("plain sync on a skills-only install counts drift only inside the scope (#1485 AC-1)", async () => {
    let log = captureLog();
    process.exitCode = 0;
    try {
      await syncCommand();
      expect(log.output()).toContain("already up to date");
    } finally {
      log.restore();
    }
    expect(process.exitCode).toBe(0);

    editOneSkill();
    log = captureLog();
    try {
      await syncCommand();
      expect(log.output()).toContain("1 file(s) differ");
      expect(log.output()).toContain("sync --only skills --force");
    } finally {
      log.restore();
    }
    expect(process.exitCode).toBe(1);
  });

  it("no remedy widens a partial install (#1485 AC-4)", async () => {
    editOneSkill();
    const outputs: string[] = [];

    let log = captureLog();
    try {
      await syncCommand();
      outputs.push(log.output());
    } finally {
      log.restore();
    }
    log = captureLog();
    try {
      await runVersionPreflight("status");
      outputs.push(log.output());
    } finally {
      log.restore();
    }
    outputs.push((await getSkillsInstallStatus())?.remediation ?? "");

    // Outdated variant of the same producers.
    fs.writeFileSync(
      path.join(root, ".claude", "skills", ".sequant-version"),
      "0.0.1",
    );
    log = captureLog();
    try {
      await runVersionPreflight("status");
      outputs.push(log.output());
    } finally {
      log.restore();
    }
    outputs.push((await getSkillsInstallStatus())?.remediation ?? "");

    // Only the fix-message lines: the banner's plugin note says "update".
    const text = outputs
      .join("\n")
      .split("\n")
      .filter(
        (l) => !/Plugins/.test(l) && /Run:|run `|differ|^sequant /.test(l),
      )
      .join("\n");
    expect(outputs.every((o) => o.length > 0)).toBe(true);
    expect(text).not.toMatch(/\bupdate\b/);
    expect(text).not.toMatch(/sync --force/);
    for (const line of text.split("\n").filter((l) => /Run:|run `/.test(l))) {
      expect(line).toContain("--only skills");
    }
  });

  /**
   * Every file, before/after an `update` run. The root gets a `.mcp.json` with
   * a stale `sequant@` pin first, so a pin write shows up in the snapshot
   * (without the file, `syncSequantMcpPin` returns `no-file` and writes nothing).
   */
  async function runUpdate(opts: Parameters<typeof updateCommand>[0]) {
    fs.writeFileSync(
      path.join(root, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            sequant: { command: "npx", args: ["-y", STALE_PIN, "serve"] },
          },
        },
        null,
        2,
      ),
    );
    const before = snapshot(root);
    const log = captureLog();
    process.exitCode = 0;
    let out = "";
    try {
      await updateCommand(opts);
    } finally {
      out = log.output();
      log.restore();
    }
    return { before, after: snapshot(root), out };
  }

  const STALE_PIN = "sequant@0.0.1";

  describe("update refuses on a skills-only install", () => {
    for (const opts of [{ yes: true }, { force: true }] as const) {
      it(`update refuses on a skills-only install (${Object.keys(opts)[0]})`, async () => {
        const { before, after, out } = await runUpdate(opts);
        expect(changedPaths(before, after)).toEqual([]);
        expect(after.get(MANIFEST)).toBe(before.get(MANIFEST));
        expect(process.exitCode).toBe(1);
        expect(out).toContain("sync --only skills");
        expect(fs.existsSync(path.join(root, ".claude", "hooks"))).toBe(false);
      });
    }

    it("update refuses on a skills-only install (groups: [])", async () => {
      const manifestPath = path.join(root, MANIFEST);
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      m.groups = [];
      fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));
      const { before, after, out } = await runUpdate({ yes: true });
      expect(changedPaths(before, after)).toEqual([]);
      expect(process.exitCode).toBe(1);
      expect(out).toContain("sync --only skills");
    });
  });

  it("update --dry-run refuses on a skills-only install", async () => {
    const { before, after, out } = await runUpdate({ dryRun: true });
    expect(changedPaths(before, after)).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(out).toContain("sync --only skills");
  });

  it("update on a full install applies every group and writes no groups field", async () => {
    const manifestPath = path.join(root, MANIFEST);
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete m.groups;
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2));

    const { out } = await runUpdate({ yes: true });
    const onDisk = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    // The same stale pin the refusal tests leave untouched is rewritten here,
    // so those tests would see a pin write if one happened.
    expect(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).not.toContain(
      STALE_PIN,
    );
    expect(fs.existsSync(path.join(root, ".claude", "hooks"))).toBe(true);
    expect("groups" in onDisk).toBe(false);
    expect(out).not.toContain("sync --only skills");
  });
});
