import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createManifest, updateManifest } from "./manifest.js";

// #1355: every manifest write ends with exactly one newline, so a repo whose
// CI runs `prettier --check .` stays green after `sequant sync`.
describe("manifest trailing newline (#1355)", () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "sequant-manifest-newline-"));
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(testDir, { recursive: true, force: true });
  });

  async function readManifest(): Promise<string> {
    return readFile(join(testDir, ".sequant-manifest.json"), "utf8");
  }

  // Prettier's output for a JSON object of strings and plain objects is
  // exactly JSON.stringify(value, null, 2) plus one newline, so matching that
  // form is what `prettier --check` accepts, without a prettier dependency.
  function isPrettierCanonical(text: string): boolean {
    return text === `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  }

  it("createManifest ends the file with one newline in prettier's canonical form", async () => {
    await createManifest("node", "pnpm");
    const text = await readManifest();
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(isPrettierCanonical(text)).toBe(true);
  });

  it("updateManifest ends the file with one newline in prettier's canonical form", async () => {
    // A manifest written by an older sequant, without the newline.
    await writeFile(
      join(testDir, ".sequant-manifest.json"),
      JSON.stringify(
        {
          version: "0.0.1",
          stack: "node",
          installedAt: "2026-01-01T00:00:00.000Z",
          files: {},
        },
        null,
        2,
      ),
    );
    await updateManifest();
    const text = await readManifest();
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(isPrettierCanonical(text)).toBe(true);
  });
});
