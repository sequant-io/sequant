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

// Mock manifest (initialized project; version match is irrelevant to apply logic)
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

// Mock config so update() skips the first-time setup prompt
vi.mock("../lib/config.js", () => ({
  getConfig: vi.fn(async () => ({
    tokens: { DEV_URL: "http://localhost:3000", PM_RUN: "npm run" },
    stack: "generic",
    initialized: "2024-01-01",
  })),
  saveConfig: vi.fn(async () => {}),
}));

// Mock inquirer to accept the default "Apply updates? (Y/n)" prompt
vi.mock("inquirer", () => ({
  default: {
    prompt: vi.fn(async () => ({ proceed: true })),
  },
}));

import { updateCommand } from "./update.js";

const CONSTITUTION_LOCAL = ".claude/memory/constitution.md";
const CUSTOM_CONSTITUTION =
  "# my-project Constitution\n\n## Custom Principle\n\nKeep it simple.\n";
const RENDERED_CONSTITUTION = "# my-project Constitution\n";

describe("update command — in-place customization protection (AC-5)", () => {
  let prevCwd: string;
  let cwdDir: string;
  let templatesDir: string;

  beforeEach(async () => {
    prevCwd = process.cwd();
    cwdDir = await mkdtemp(join(tmpdir(), "sequant-update-int-cwd-"));
    templatesDir = await mkdtemp(join(tmpdir(), "sequant-update-int-tpl-"));
    process.chdir(cwdDir);
    process.env.SEQUANT_TEMPLATES_DIR = templatesDir;
    vi.spyOn(console, "log").mockImplementation(() => {});

    // Deterministic PROJECT_NAME
    await fsWriteFile(
      join(cwdDir, "package.json"),
      JSON.stringify({ name: "my-project" }),
    );

    // Templates tree: a constitution that renders to RENDERED_CONSTITUTION
    await mkdir(join(templatesDir, "memory"), { recursive: true });
    await fsWriteFile(
      join(templatesDir, "memory", "constitution.md"),
      "# {{PROJECT_NAME}} Constitution\n",
    );

    // Seed a customized constitution edited in place (no parallel .local file)
    await mkdir(join(cwdDir, ".claude", "memory"), { recursive: true });
    await fsWriteFile(join(cwdDir, CONSTITUTION_LOCAL), CUSTOM_CONSTITUTION);
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    delete process.env.SEQUANT_TEMPLATES_DIR;
    await rm(cwdDir, { recursive: true, force: true });
    await rm(templatesDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does not overwrite a customized constitution on the default (Y) path", async () => {
    await updateCommand({});

    const after = await fsReadFile(join(cwdDir, CONSTITUTION_LOCAL), "utf-8");
    expect(after).toBe(CUSTOM_CONSTITUTION);
  });

  it("overwrites the customized constitution only with --force", async () => {
    await updateCommand({ force: true });

    const after = await fsReadFile(join(cwdDir, CONSTITUTION_LOCAL), "utf-8");
    expect(after).toBe(RENDERED_CONSTITUTION);
  });
});
