import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { run, collectMetrics, compare, countUnusedExports } from "./health-report.js";

// Real files in a temp tree, no fs mock. ESLint and the TS parser load on the
// first call, so each case sets its own timeout (the unit project defaults to 5s).
const T = 60_000;

let root: string;
let baseline: string;

function put(rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "health-"));
  baseline = path.join(root, "baseline.json");
  put("src/a.ts", "export function f() {\n  try {\n    g();\n  } catch (e) {\n    h(e);\n  }\n}\n");
  put("docs/adr/0001-x.md", "**Status:** Accepted (owner, 2026-01-01)\n");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const args = (...a: string[]): string[] => ["--root", root, "--baseline", baseline, ...a];

describe("health-report --check ratchet", () => {
  it("measures the fixture tree", () => {
    put("src/b.ts", "try {\n  x();\n} catch {}\n");
    const m = collectMetrics(root, {});
    expect(m.emptyCatch.total).toBe(1);
    expect(m.emptyCatch.byFile).toEqual({ "src/b.ts": 1 });
    expect(m.adrWithoutActor).toBe(0);
    expect(m.harness.memoryFiles).toBeNull();
    expect(m.unusedExports).toBe(0);
  }, T);

  it("counts unused exports and types from knip JSON", () => {
    const issue = (exports: number, types: number): object => ({
      file: "src/x.ts",
      exports: Array.from({ length: exports }, (_, i) => ({ name: `e${i}` })),
      types: Array.from({ length: types }, (_, i) => ({ name: `t${i}` })),
      files: [{ name: "src/y.ts" }],
    });
    expect(countUnusedExports(JSON.stringify({ issues: [issue(2, 1), issue(0, 3)] }))).toBe(6);
    expect(countUnusedExports(JSON.stringify({ issues: [] }))).toBe(0);
    expect(() => countUnusedExports("{}")).toThrow();
  });

  it("exits 0 when the baseline equals the tree", () => {
    run(args("--write-baseline"), root);
    const r = run(args("--check"), root);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  }, T);

  it("exits 1 and names the key when a metric rose", () => {
    run(args("--write-baseline"), root);
    put("src/b.ts", "try {\n  x();\n} catch {}\n");
    const r = run(args("--check"), root);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("emptyCatch.total rose 0 -> 1");
  }, T);

  it("exits 0 and reports ratchet available when a metric dropped", () => {
    put("src/b.ts", "try {\n  x();\n} catch {}\n");
    run(args("--write-baseline"), root);
    fs.rmSync(path.join(root, "src/b.ts"));
    const r = run(args("--check"), root);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ratchet available: emptyCatch.total");
  }, T);

  it("--write-baseline rewrites the file and a following --check exits 0", () => {
    run(args("--write-baseline"), root);
    put("src/b.ts", "try {\n  x();\n} catch {}\n");
    expect(run(args("--check"), root).code).toBe(1);
    run(args("--write-baseline"), root);
    expect(JSON.parse(fs.readFileSync(baseline, "utf8")).emptyCatch.total).toBe(1);
    expect(run(args("--check"), root).code).toBe(0);
  }, T);

  it("exits 2 when the baseline file is missing", () => {
    expect(run(args("--check"), root).code).toBe(2);
  }, T);

  it("ignores the ungated keys", () => {
    const base = { testRatio28d: { sum: 1 }, harness: { memoryFiles: 1, skillLines: 5 } };
    const cur = { testRatio28d: { sum: 9 }, harness: { memoryFiles: 9, skillLines: 5 } };
    expect(compare(cur, base)).toEqual({ raised: [], lowered: [] });
  });
});

describe("prose gate", () => {
  // The fixture bodies are built with S so this file holds no literal skill file name.
  const S = "SKILL" + ".md";
  const proseFiles = (): number => collectMetrics(root, {}).proseGate.files;

  it("counts a file that reads a skill file and asserts on its text", () => {
    put("src/gate.test.ts", `const t = readFileSync(join(dir, "qa", "${S}"), "utf8");\nexpect(t).toContain("x");\n`);
    put(
      "src/via-var.test.ts",
      `const P = join(dir, "${S}");\nconst t = fs.readFileSync(P, "utf8");\nexpect(t).toMatch(/x/);\n`,
    );
    put("src/via-roots.test.ts", `for (const r of SKILL_ROOTS) read(r);\nexpect(t).toContain("x");\n`);
    expect(proseFiles()).toBe(3);
  }, T);

  it("does not count a file that names the skill file only in a comment or a path string", () => {
    put("src/comment.test.ts", `// reads ${S} elsewhere\nexpect(out).toContain("x");\n`);
    put("src/path.test.ts", `const p = "docs/${S}";\nexpect(run(p)).toContain("${S}");\n`);
    put("src/fixture.test.ts", `writeFileSync(join(dir, "${S}"), "# s");\nexpect(out).toMatch(/ok/);\n`);
    put(
      "src/scratch.test.ts",
      `const P = ".claude/skills/demo/${S}";\nconst t = await readFile(join(tmp, P), "utf8");\nexpect(t).toContain("x");\n`,
    );
    expect(proseFiles()).toBe(0);
  }, T);

  it("does not count a file whose only SKILL_ROOTS is inside a string", () => {
    put("src/roots-string.test.ts", `const msg = "iterates SKILL_ROOTS";\nexpect(run()).toContain(msg);\n`);
    expect(proseFiles()).toBe(0);
  }, T);

  it("does not count a file that reads a skill file but asserts nothing on it", () => {
    put("src/no-assert.test.ts", `const t = readFileSync(join(dir, "${S}"), "utf8");\nexpect(t.length).toBe(3);\n`);
    expect(proseFiles()).toBe(0);
  }, T);
});
