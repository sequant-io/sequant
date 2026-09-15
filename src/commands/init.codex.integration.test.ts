/**
 * #1059 (part of epic #497) — `sequant init --agent codex` provisioning:
 * the `.agents/skills` symlink codex's skill discovery requires, and the
 * `.codex/config.toml` hook wrapper.
 *
 * Runs against a real temp git repo and the real filesystem (not mocked),
 * since AC-1 requires verifying an actual symlink via `readlink`.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CODEX_SKILLS_SYMLINK_TARGET,
  writeCodexProvisioning,
  writeCodexSkillsSymlink,
} from "./init.js";
import { copyTemplates } from "../lib/templates.js";

const REPO_ROOT = resolve(__dirname, "../..");

describe("1059 AC-1/AC-2: codex provisioning", () => {
  let target: string;
  let prevTemplates: string | undefined;

  beforeAll(async () => {
    prevTemplates = process.env.SEQUANT_TEMPLATES_DIR;
    process.env.SEQUANT_TEMPLATES_DIR = join(REPO_ROOT, "templates");
    target = mkdtempSync(join(tmpdir(), "sequant-init-codex-"));
    execFileSync("git", ["init", "-q"], { cwd: target });
  });

  afterAll(() => {
    if (prevTemplates === undefined) delete process.env.SEQUANT_TEMPLATES_DIR;
    else process.env.SEQUANT_TEMPLATES_DIR = prevTemplates;
    rmSync(target, { recursive: true, force: true });
  });

  it("AC-1: creates .agents/skills as a relative symlink to ../.claude/skills", async () => {
    const result = await writeCodexProvisioning(target);
    expect(result.symlinkStatus).toBe("created");

    const linkPath = join(target, ".agents/skills");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(CODEX_SKILLS_SYMLINK_TARGET);
    expect(readlinkSync(linkPath)).toBe("../.claude/skills");
  });

  it("AC-1: re-running init is idempotent — no error, no change", async () => {
    const linkPath = join(target, ".agents/skills");
    const before = readlinkSync(linkPath);

    const result = await writeCodexProvisioning(target);

    expect(result.symlinkStatus).toBe("already-correct");
    expect(readlinkSync(linkPath)).toBe(before);
  });

  it("AC-1: warns and skips rather than overwriting a foreign .agents/skills", async () => {
    const foreignTarget = mkdtempSync(
      join(tmpdir(), "sequant-init-codex-foreign-"),
    );
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(foreignTarget, ".agents"), { recursive: true });
      writeFileSync(join(foreignTarget, ".agents/skills"), "not a symlink");

      const status = await writeCodexSkillsSymlink(foreignTarget);
      expect(status).toBe("skipped-foreign");
      expect(readFileSync(join(foreignTarget, ".agents/skills"), "utf-8")).toBe(
        "not a symlink",
      );
    } finally {
      rmSync(foreignTarget, { recursive: true, force: true });
    }
  });

  it("AC-1: --force replaces a stray file but never a real directory", async () => {
    const dirTarget = mkdtempSync(join(tmpdir(), "sequant-init-codex-dir-"));
    try {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(dirTarget, ".agents/skills"), { recursive: true });
      writeFileSync(join(dirTarget, ".agents/skills/mine.md"), "user content");

      // A bare unlink on a directory throws, which would abort init before
      // .codex/config.toml is written; the directory must be left intact and
      // provisioning must continue.
      const { symlinkStatus, configPath } = await writeCodexProvisioning(
        dirTarget,
        true,
      );
      expect(symlinkStatus).toBe("skipped-foreign");
      expect(
        readFileSync(join(dirTarget, ".agents/skills/mine.md"), "utf-8"),
      ).toBe("user content");
      expect(existsSync(configPath)).toBe(true);

      // A stray *file* is still replaced under --force.
      const fileTarget = mkdtempSync(
        join(tmpdir(), "sequant-init-codex-file-"),
      );
      try {
        mkdirSync(join(fileTarget, ".agents"), { recursive: true });
        writeFileSync(join(fileTarget, ".agents/skills"), "not a symlink");
        expect(await writeCodexSkillsSymlink(fileTarget, true)).toBe("created");
        expect(readlinkSync(join(fileTarget, ".agents/skills"))).toBe(
          CODEX_SKILLS_SYMLINK_TARGET,
        );
      } finally {
        rmSync(fileTarget, { recursive: true, force: true });
      }
    } finally {
      rmSync(dirTarget, { recursive: true, force: true });
    }
  });

  it("AC-2: writes .codex/config.toml with hooks.PreToolUse and hooks.PostToolUse pointing at the existing guard scripts", async () => {
    const configPath = join(target, ".codex/config.toml");
    expect(existsSync(configPath)).toBe(true);
    const content = readFileSync(configPath, "utf-8");

    expect(content).toContain("[[hooks.PreToolUse]]");
    expect(content).toContain("[[hooks.PostToolUse]]");
    expect(content).toContain(".claude/hooks/pre-tool.sh");
    expect(content).toContain(".claude/hooks/post-tool.sh");
  });

  it("AC-2: renders from exactly one templates/ location", () => {
    // Grep across src and templates for the literal `hooks.PreToolUse` —
    // must resolve to exactly one file under templates/.
    const grep = execFileSync(
      "sh",
      [
        "-c",
        `grep -rl 'hooks.PreToolUse' ${join(REPO_ROOT, "src")} ${join(REPO_ROOT, "templates")} || true`,
      ],
      { encoding: "utf-8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    const templateHits = grep.filter((f) => f.includes("/templates/"));
    expect(templateHits).toHaveLength(1);
    expect(templateHits[0]).toContain("templates/codex/config.toml");
  });
});

describe("1059 AC-6: .agents/skills survives sequant update in both copy and symlink modes", () => {
  let target: string;
  let prevTemplates: string | undefined;

  beforeAll(() => {
    prevTemplates = process.env.SEQUANT_TEMPLATES_DIR;
    process.env.SEQUANT_TEMPLATES_DIR = join(REPO_ROOT, "templates");
  });

  afterAll(() => {
    if (prevTemplates === undefined) delete process.env.SEQUANT_TEMPLATES_DIR;
    else process.env.SEQUANT_TEMPLATES_DIR = prevTemplates;
  });

  it.each([
    ["symlink mode (default)", false],
    ["copy mode (--no-symlinks)", true],
  ])(
    "%s: readlink .agents/skills still resolves after copyTemplates re-runs",
    async (_label, noSymlinks) => {
      const dir = mkdtempSync(join(tmpdir(), "sequant-update-codex-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: dir });
        const cwdBefore = process.cwd();
        process.chdir(dir);
        try {
          await writeCodexProvisioning(dir);
          // Simulate `sequant update`/`sequant sync`'s underlying template
          // copy — templates/codex/** is excluded from this engine (routed
          // to null by templateDestination), so it must never touch
          // .agents/skills regardless of --no-symlinks.
          await copyTemplates("generic", {}, { noSymlinks, force: true });
        } finally {
          process.chdir(cwdBefore);
        }

        const linkPath = join(dir, ".agents/skills");
        expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
        expect(readlinkSync(linkPath)).toBe(CODEX_SKILLS_SYMLINK_TARGET);
        // The symlink must resolve to a real file, not a dangling link.
        expect(existsSync(join(dir, ".agents/skills/qa/SKILL.md"))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
