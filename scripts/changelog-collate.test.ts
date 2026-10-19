import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  collate,
  parseFragment,
  readFragments,
  unreleasedBullets,
} from "./changelog-collate.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "changelog-collate.ts");
const FIXTURE = join(
  here,
  "../__tests__/fixtures/changelog-unreleased-pre-1351.md",
);
const BASE = `# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- old (#1)\n`;

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(changelog = BASE): string {
  const d = mkdtempSync(join(tmpdir(), "collate-"));
  dirs.push(d);
  mkdirSync(join(d, "changelog.d"));
  writeFileSync(join(d, "CHANGELOG.md"), changelog);
  return d;
}
function frag(d: string, name: string, content: string): void {
  writeFileSync(join(d, "changelog.d", name), content);
}
const bullets = (s: string) => s.split("\n").filter((l) => l.startsWith("- "));

describe("changelog collate", { timeout: 30_000 }, () => {
  it("groups fragments by kind into a version section and deletes them", () => {
    const d = repo();
    frag(d, "20-fix-b.md", "kind: Fixed\n\nFixed B (#20)\n");
    frag(d, "10-add-a.md", "kind: Added\n\nAdded A (#10)\n");
    frag(d, "15-add-c.md", "kind: Added\n\nAdded C (#15)\n");
    collate(d, "1.1.0", "2026-02-02");
    const log = readFileSync(join(d, "CHANGELOG.md"), "utf-8");
    expect(log).toContain("## [Unreleased]\n\n## [1.1.0] - 2026-02-02");
    expect(log.indexOf("### Added")).toBeLessThan(log.indexOf("### Fixed"));
    expect(log.indexOf("Added A")).toBeLessThan(log.indexOf("Added C"));
    expect(log).toContain("## [1.0.0] - 2026-01-01");
    expect(readdirSync(join(d, "changelog.d"))).toEqual([]);
  });

  it.each([
    ["no kind line", "01-x.md", "just text\n"],
    ["unknown kind", "01-x.md", "kind: Wibble\n\ntext\n"],
    ["empty body", "01-x.md", "kind: Added\n\n  \n"],
    ["bad filename", "Notes.md", "kind: Added\n\ntext\n"],
  ])("exits non-zero and deletes nothing on %s", (_n, name, content) => {
    const d = repo();
    frag(d, "02-good.md", "kind: Added\n\ngood\n");
    frag(d, name, content);
    const r = spawnSync("npx", ["tsx", SCRIPT, "1.1.0"], {
      cwd: d,
      encoding: "utf-8",
    });
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(d, "CHANGELOG.md"), "utf-8")).toBe(BASE);
    expect(existsSync(join(d, "changelog.d", "02-good.md"))).toBe(true);
    expect(existsSync(join(d, "changelog.d", name))).toBe(true);
  });

  it("--check validates and writes nothing", () => {
    const d = repo();
    frag(d, "02-good.md", "kind: Added\n\ngood\n");
    const r = spawnSync("npx", ["tsx", SCRIPT, "1.1.0", "--check"], {
      cwd: d,
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(readFileSync(join(d, "CHANGELOG.md"), "utf-8")).toBe(BASE);
    expect(existsSync(join(d, "changelog.d", "02-good.md"))).toBe(true);
  });

  it("rejects a malformed fragment through parseFragment", () => {
    expect(() => parseFragment("1-a.md", "kind: Added\n\nok")).not.toThrow();
    expect(() => parseFragment("1-a.md", "")).toThrow(/kind/);
  });

  it("carries entries still under [Unreleased] into the section (AC-5)", () => {
    const fixture = readFileSync(FIXTURE, "utf-8");
    const before = bullets(fixture.slice(fixture.indexOf("## [Unreleased]")));
    expect(before.length).toBeGreaterThan(10);
    const d = repo(fixture + "\n## [2.19.0] - 2026-10-01\n\n- older (#1)\n");
    frag(d, "1351-new.md", "kind: Changed\n\nNew entry (#1351)\n");
    collate(d, "2.20.0", "2026-10-08");
    const log = readFileSync(join(d, "CHANGELOG.md"), "utf-8");
    const section = log.slice(
      log.indexOf("## [2.20.0]"),
      log.indexOf("## [2.19.0]"),
    );
    expect(bullets(section).sort()).toEqual(
      [...before, "- New entry (#1351)"].sort(),
    );
    expect(log.slice(0, log.indexOf("## [2.20.0]"))).toMatch(
      /## \[Unreleased\]\n\n$/,
    );
  });

  it("refuses an [Unreleased] bullet with no ### Kind heading, writing nothing", () => {
    const log = BASE.replace("## [Unreleased]\n", "## [Unreleased]\n\n- orphan bullet (#9)\n");
    const d = repo(log);
    frag(d, "1351-new.md", "kind: Changed\n\nNew entry (#1351)\n");
    expect(() => collate(d, "2.20.0", "2026-10-08")).toThrow(/orphan bullet/);
    expect(readFileSync(join(d, "CHANGELOG.md"), "utf-8")).toBe(log);
    expect(existsSync(join(d, "changelog.d", "1351-new.md"))).toBe(true);
    expect(() => unreleasedBullets("\nsome prose\n")).toThrow(/some prose/);
  });

  it("every pre-switch [Unreleased] bullet lives in a migrated fragment or CHANGELOG.md (AC-5)", () => {
    const fixture = readFileSync(FIXTURE, "utf-8");
    const before = bullets(fixture.slice(fixture.indexOf("## [Unreleased]"))).map(
      (b) => b.slice(2),
    );
    expect(before.length).toBeGreaterThan(10);
    const root = join(here, "..");
    const bodies = readFragments(join(root, "changelog.d")).map((f) => f.body);
    // After a release collates and deletes the fragments, the bullets live on
    // in a released section of CHANGELOG.md.
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf-8");
    const missing = before.filter(
      (b) => !bodies.some((x) => x.startsWith(b)) && !changelog.includes(b),
    );
    expect(missing).toEqual([]);
  });

  it("two branches that each add a fragment merge without conflict (AC-4)", () => {
    const d = repo();
    const git = (...a: string[]) =>
      execFileSync("git", ["-C", d, ...a], { encoding: "utf-8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(d, "changelog.d", ".gitkeep"), "");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    for (const [br, name] of [
      ["a", "10-a.md"],
      ["b", "11-b.md"],
    ]) {
      git("checkout", "-q", "-b", br, "main");
      frag(d, name, `kind: Added\n\nentry ${br}\n`);
      git("add", "-A");
      git("commit", "-q", "-m", br);
    }
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "merge a", "a");
    git("merge", "-q", "--no-ff", "-m", "merge b", "b");
    expect(readdirSync(join(d, "changelog.d")).sort()).toEqual([
      ".gitkeep",
      "10-a.md",
      "11-b.md",
    ]);
  });
});
