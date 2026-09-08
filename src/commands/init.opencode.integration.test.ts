/**
 * `sequant init --agent opencode` command wrappers (#862 AC-5).
 *
 * Real filesystem, real templates directory — the point of the AC is that the
 * wrappers are *rendered from one source*, which a mocked-fs test cannot show.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { writeOpencodeCommands } from "./init.js";
import { getPhaseNames } from "../lib/workflow/phase-registry.js";

const REPO_TEMPLATES = resolve(__dirname, "..", "..", "templates");

let workDir: string;
let previousTemplatesDir: string | undefined;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sequant-init-opencode-"));
  previousTemplatesDir = process.env.SEQUANT_TEMPLATES_DIR;
  process.env.SEQUANT_TEMPLATES_DIR = REPO_TEMPLATES;
});

afterEach(() => {
  if (previousTemplatesDir === undefined) {
    delete process.env.SEQUANT_TEMPLATES_DIR;
  } else {
    process.env.SEQUANT_TEMPLATES_DIR = previousTemplatesDir;
  }
  // `workDir` is a mkdtemp result and is never reassigned between here and its
  // creation — do not make it a mutable target of this rmSync (#883).
  rmSync(workDir, { recursive: true, force: true });
});

describe("862 AC-5: opencode command wrappers", () => {
  it("862 AC-5 writes one wrapper per registered phase", async () => {
    await writeOpencodeCommands(workDir);

    const written = readdirSync(join(workDir, ".opencode", "commands")).sort();
    const expected = getPhaseNames()
      .map((p) => `${p}.md`)
      .sort();

    expect(written).toEqual(expected);
    expect(written.length).toBeGreaterThan(0);
  });

  it("862 AC-5 renders every wrapper from the single template source", async () => {
    await writeOpencodeCommands(workDir);

    const template = readFileSync(
      join(REPO_TEMPLATES, "opencode", "command.md"),
      "utf-8",
    );

    for (const phase of getPhaseNames()) {
      const rendered = readFileSync(
        join(workDir, ".opencode", "commands", `${phase}.md`),
        "utf-8",
      );
      // Byte-equal to the template with the one placeholder substituted — a
      // hand-mirrored fourth tree could not satisfy this.
      expect(rendered).toBe(template.replaceAll("{{PHASE}}", phase));
      expect(rendered).not.toContain("{{PHASE}}");
    }
  });

  it("862 AC-5 each wrapper instructs the model to load its own skill", async () => {
    await writeOpencodeCommands(workDir);

    const qa = readFileSync(
      join(workDir, ".opencode", "commands", "qa.md"),
      "utf-8",
    );
    expect(qa).toContain('{"name": "qa"}');
    expect(qa).toContain("$ARGUMENTS");
    // The skill tool truncates a long SKILL.md body (#992); the wrapper is the
    // only place that can tell the model to page through the rest.
    expect(qa).toContain("truncated");
  });

  it("862 AC-5 keeps the commands-directory literal in exactly one source", () => {
    // OQ-5: the AC's `grep -rl … | wc -l` is layout-brittle, so the layout is
    // pinned here rather than left to luck — init.ts owns the path, and the
    // template carries no copy of it.
    const initSource = readFileSync(join(__dirname, "init.ts"), "utf-8");
    const templateSource = readFileSync(
      join(REPO_TEMPLATES, "opencode", "command.md"),
      "utf-8",
    );

    expect(initSource).toContain(".opencode/commands");
    expect(templateSource).not.toContain("opencode/commands");
  });

  it("862 AC-5 registers --agent on the init command so the flag is not inert", () => {
    // The classic silent-no-op trap: an InitOptions field with no `.option()`
    // in bin/cli.ts never receives a value (#305).
    const cli = readFileSync(
      resolve(__dirname, "..", "..", "bin", "cli.ts"),
      "utf-8",
    );
    const initBlock = cli.slice(
      cli.indexOf('.command("init")'),
      cli.indexOf(".action(initCommand)"),
    );
    expect(initBlock).toContain('"--agent <name>"');
    expect(initBlock).toContain("opencode");
  });
});
