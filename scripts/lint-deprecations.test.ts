import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { findUnversionedDeprecations } from "./lint-deprecations.js";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "lint-deprecations.ts");
let tmp: string;

function project(file: string, body: string): string {
  tmp = mkdtempSync(join(tmpdir(), "lint-deprecations-"));
  mkdirSync(join(tmp, "src"), { recursive: true });
  writeFileSync(join(tmp, file), body);
  return tmp;
}

function run(root: string) {
  return spawnSync("npx", ["tsx", SCRIPT, root], { encoding: "utf8" });
}

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("lint-deprecations", () => {
  it("fails on a bare tag and names file:line", () => {
    const root = project("src/a.ts", "// ok\n/** @deprecated Use b */\nexport const a = 1;\n");
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("src/a.ts:2");
  });

  it("passes when the tag says remove in v3.1", () => {
    const root = project("src/a.ts", "/** @deprecated Use b (remove in v3.1) */\nexport const a = 1;\n");
    expect(run(root).status).toBe(0);
  });

  it("passes with no tags and ignores test files", () => {
    const root = project("src/a.test.ts", "/** @deprecated bare */\n");
    expect(findUnversionedDeprecations(root)).toEqual([]);
  });
});
