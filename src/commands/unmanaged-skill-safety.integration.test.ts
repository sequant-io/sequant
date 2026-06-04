// Issue #711 — AC-3: a net-new, unmanaged skill under `.claude/skills/` is a
// supported home for custom skills, and `update`/`sync` must never clobber it.
// Both commands only write paths derived from the bundled templates and never
// delete unmanaged files, so an unmanaged `.claude/skills/foo/` is left intact.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile as fsWriteFile,
  readFile as fsReadFile,
} from "fs/promises";
import { tmpdir } from "os";

vi.mock("../lib/manifest.js", () => ({
  getManifest: vi.fn(async () => ({
    version: "2.6.1",
    stack: "generic",
    installedAt: "2024-01-01",
    files: {},
    packageManager: "npm",
  })),
  updateManifest: vi.fn(async () => {}),
  getPackageVersion: vi.fn(() => "2.6.1"),
}));

vi.mock("../lib/config.js", () => ({
  getConfig: vi.fn(async () => ({
    tokens: { DEV_URL: "http://localhost:3000", PM_RUN: "npm run" },
    stack: "generic",
    initialized: "2024-01-01",
  })),
  saveConfig: vi.fn(async () => {}),
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn(async () => ({ proceed: true })) },
}));

import { updateCommand } from "./update.js";
import { syncCommand } from "./sync.js";

const UNMANAGED_SKILL = ".claude/skills/foo/SKILL.md";
const UNMANAGED_CONTENT =
  "---\nname: foo\ndescription: my custom skill\n---\n\n# Foo\n\nUser-owned skill, not in templates.\n";

// A managed skill the templates DO ship, so update/sync have real work to do.
const MANAGED_SKILL = ".claude/skills/spec/SKILL.md";

describe("AC-3: update/sync never clobber an unmanaged .claude/skills/ dir", () => {
  let prevCwd: string;
  let cwdDir: string;
  let templatesDir: string;

  beforeEach(async () => {
    prevCwd = process.cwd();
    cwdDir = await mkdtemp(join(tmpdir(), "sequant-unmanaged-cwd-"));
    templatesDir = await mkdtemp(join(tmpdir(), "sequant-unmanaged-tpl-"));
    process.chdir(cwdDir);
    process.env.SEQUANT_TEMPLATES_DIR = templatesDir;
    vi.spyOn(console, "log").mockImplementation(() => {});

    await fsWriteFile(
      join(cwdDir, "package.json"),
      JSON.stringify({ name: "my-project" }),
    );

    // Templates ship a `spec` skill only.
    await mkdir(join(templatesDir, "skills", "spec"), { recursive: true });
    await fsWriteFile(
      join(templatesDir, "skills", "spec", "SKILL.md"),
      "# spec template v2\n",
    );

    // Installed tree: an outdated managed `spec` plus an UNMANAGED `foo`.
    await mkdir(join(cwdDir, ".claude", "skills", "spec"), { recursive: true });
    await fsWriteFile(join(cwdDir, MANAGED_SKILL), "# spec template v1\n");
    await mkdir(join(cwdDir, ".claude", "skills", "foo"), { recursive: true });
    await fsWriteFile(join(cwdDir, UNMANAGED_SKILL), UNMANAGED_CONTENT);
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    delete process.env.SEQUANT_TEMPLATES_DIR;
    await rm(cwdDir, { recursive: true, force: true });
    await rm(templatesDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("update leaves the unmanaged skill untouched while updating the managed one", async () => {
    await updateCommand({});

    const foo = await fsReadFile(join(cwdDir, UNMANAGED_SKILL), "utf-8");
    expect(foo).toBe(UNMANAGED_CONTENT);

    // Sanity: the managed skill was actually updated (proves update did work).
    const spec = await fsReadFile(join(cwdDir, MANAGED_SKILL), "utf-8");
    // DIAG-711 (temporary): surface env/cwd if the sanity check is about to fail.
    if (spec !== "# spec template v2\n") {
      const fs2 = await import("fs/promises");
      const tplSpec = await fs2
        .readFile(join(templatesDir, "skills", "spec", "SKILL.md"), "utf-8")
        .catch((e) => `READ_ERR:${e.code}`);
      console.error(
        "DIAG-711",
        JSON.stringify({
          cwd: process.cwd(),
          cwdDir,
          templatesDir,
          envTpl: process.env.SEQUANT_TEMPLATES_DIR,
          specGot: spec,
          tplSpecOnDisk: tplSpec,
        }),
      );
    }
    expect(spec).toBe("# spec template v2\n");
  });

  it("sync --force leaves the unmanaged skill untouched while syncing the managed one", async () => {
    await syncCommand({ force: true, quiet: true });

    const foo = await fsReadFile(join(cwdDir, UNMANAGED_SKILL), "utf-8");
    expect(foo).toBe(UNMANAGED_CONTENT);

    const spec = await fsReadFile(join(cwdDir, MANAGED_SKILL), "utf-8");
    expect(spec).toBe("# spec template v2\n");
  });
});
