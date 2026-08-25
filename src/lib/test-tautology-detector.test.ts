/**
 * Tests for Test Tautology Detector
 */
import { describe, it, expect } from "vitest";
import {
  isSourceModule,
  extractImports,
  extractTestBlocks,
  testBlockCallsProductionCode,
  analyzeTestFile,
  detectTautologicalTests,
  formatTautologyResults,
  getTautologyVerdictImpact,
} from "./test-tautology-detector.js";

describe("isSourceModule", () => {
  it("returns true for relative imports with ./", () => {
    expect(isSourceModule("./run.js")).toBe(true);
    expect(isSourceModule("./utils/helpers")).toBe(true);
  });

  it("returns true for relative imports with ../", () => {
    expect(isSourceModule("../run.js")).toBe(true);
    expect(isSourceModule("../../lib/utils")).toBe(true);
  });

  it("returns false for test libraries", () => {
    expect(isSourceModule("vitest")).toBe(false);
    expect(isSourceModule("@vitest/utils")).toBe(false);
    expect(isSourceModule("jest")).toBe(false);
    expect(isSourceModule("@jest/globals")).toBe(false);
    expect(isSourceModule("@testing-library/react")).toBe(false);
    expect(isSourceModule("chai")).toBe(false);
    expect(isSourceModule("mocha")).toBe(false);
  });

  it("returns false for mock/fixture paths", () => {
    expect(isSourceModule("./mock-data")).toBe(false);
    expect(isSourceModule("../fixtures/users")).toBe(false);
    expect(isSourceModule("./__mocks__/api")).toBe(false);
    expect(isSourceModule("./test-utils")).toBe(false);
    expect(isSourceModule("./stubData")).toBe(false);
    expect(isSourceModule("./FakeService")).toBe(false);
  });

  it("returns false for node built-ins", () => {
    expect(isSourceModule("node:fs")).toBe(false);
    expect(isSourceModule("node:path")).toBe(false);
    expect(isSourceModule("node:test")).toBe(false);
  });
});

describe("extractImports", () => {
  it("extracts named imports from source modules", () => {
    const content = `
      import { foo, bar } from './module';
      import { baz } from '../utils';
    `;
    const imports = extractImports(content);
    expect(imports).toHaveLength(3);
    expect(imports).toContainEqual({ name: "foo", modulePath: "./module" });
    expect(imports).toContainEqual({ name: "bar", modulePath: "./module" });
    expect(imports).toContainEqual({ name: "baz", modulePath: "../utils" });
  });

  it("handles aliased imports", () => {
    const content = `import { originalName as aliasName } from './module';`;
    const imports = extractImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual({ name: "aliasName", modulePath: "./module" });
  });

  it("extracts default imports", () => {
    const content = `import myFunc from './myModule';`;
    const imports = extractImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual({ name: "myFunc", modulePath: "./myModule" });
  });

  it("extracts namespace imports", () => {
    const content = `import * as utils from './utils';`;
    const imports = extractImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual({ name: "utils", modulePath: "./utils" });
  });

  it("ignores imports from test libraries", () => {
    const content = `
      import { describe, it, expect } from 'vitest';
      import { render } from '@testing-library/react';
      import { executePhaseWithRetry } from './run.js';
    `;
    const imports = extractImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].name).toBe("executePhaseWithRetry");
  });

  it("ignores imports from mock modules", () => {
    const content = `
      import { mockUser } from './mock-data';
      import { fixtureData } from '../fixtures/data';
      import { realFunction } from './real-module';
    `;
    const imports = extractImports(content);
    expect(imports).toHaveLength(1);
    expect(imports[0].name).toBe("realFunction");
  });

  it("handles mixed import styles", () => {
    const content = `
      import defaultExport from './default';
      import { namedExport } from './named';
      import * as namespace from './namespace';
    `;
    const imports = extractImports(content);
    expect(imports).toHaveLength(3);
    expect(imports.map((i) => i.name).sort()).toEqual([
      "defaultExport",
      "namedExport",
      "namespace",
    ]);
  });
});

describe("extractTestBlocks", () => {
  it("extracts it() blocks", () => {
    const content = `
      it('should do something', () => {
        expect(true).toBe(true);
      });
    `;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].description).toBe("should do something");
    expect(blocks[0].style).toBe("it");
  });

  it("extracts test() blocks", () => {
    const content = `
      test('should do something', () => {
        expect(true).toBe(true);
      });
    `;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].description).toBe("should do something");
    expect(blocks[0].style).toBe("test");
  });

  it("extracts both it() and test() blocks", () => {
    const content = `
      it('using it', () => {});
      test('using test', () => {});
    `;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].style).toBe("it");
    expect(blocks[1].style).toBe("test");
  });

  it("handles it.skip and test.skip", () => {
    const content = `
      it.skip('skipped it', () => {});
      test.skip('skipped test', () => {});
    `;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(2);
  });

  it("handles it.only and test.only", () => {
    const content = `
      it.only('focused it', () => {});
      test.only('focused test', () => {});
    `;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(2);
  });

  it("handles async tests", () => {
    const content = `
      it('async test', async () => {
        await someAsyncOperation();
      });
    `;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toContain("someAsyncOperation");
  });

  it("extracts correct line numbers", () => {
    const content = `describe('suite', () => {
  it('first test', () => {});

  it('second test', () => {});
});`;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].lineNumber).toBe(2);
    expect(blocks[1].lineNumber).toBe(4);
  });

  it("handles nested braces in test body", () => {
    const content = `
      it('complex test', () => {
        const obj = { nested: { value: true } };
        if (obj.nested.value) {
          expect(true).toBe(true);
        }
      });
    `;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toContain("nested");
    expect(blocks[0].body).toContain("expect(true)");
  });

  it("skips test blocks inside template literal strings", () => {
    const content = `
      import { extractTestBlocks } from './detector';

      it('outer real test', () => {
        const content = \`
          it('inner fake test', () => {
            expect(true).toBe(true);
          });
        \`;
        const blocks = extractTestBlocks(content);
        expect(blocks).toHaveLength(1);
      });
    `;
    const blocks = extractTestBlocks(content);
    // Should only find the outer test block, not the one inside the template literal
    expect(blocks).toHaveLength(1);
    expect(blocks[0].description).toBe("outer real test");
  });

  it("skips test blocks inside single-quoted strings", () => {
    const content = `
      it('outer test', () => {
        const str = 'it("inner", () => { expect(1).toBe(1); })';
        expect(str).toBeDefined();
      });
    `;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].description).toBe("outer test");
  });

  it("handles nested template literals correctly", () => {
    const content =
      "const x = `outer ${`inner`} still outer`;\n" +
      "it('real test after nested template', () => {\n" +
      "  expect(1).toBe(1);\n" +
      "});\n";
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].description).toBe("real test after nested template");
  });

  it("skips test blocks inside line comments", () => {
    const content = `
      // it('commented out test', () => { expect(true).toBe(true); });
      it('real test', () => {
        expect(1).toBe(1);
      });
    `;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].description).toBe("real test");
  });

  it("skips test blocks inside block comments", () => {
    const content = `
      /* it('block commented test', () => { expect(true).toBe(true); }); */
      it('real test', () => {
        expect(1).toBe(1);
      });
    `;
    const blocks = extractTestBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].description).toBe("real test");
  });
});

describe("testBlockCallsProductionCode", () => {
  it("returns true when imported function is called", () => {
    const body = `{
      const result = myFunction(arg);
      expect(result).toBe(true);
    }`;
    const imports = [{ name: "myFunction", modulePath: "./module" }];
    expect(testBlockCallsProductionCode(body, imports)).toBe(true);
  });

  it("returns false when no imported function is called", () => {
    const body = `{
      const x = true;
      expect(x).toBe(true);
    }`;
    const imports = [{ name: "myFunction", modulePath: "./module" }];
    expect(testBlockCallsProductionCode(body, imports)).toBe(false);
  });

  it("returns true for method calls on namespace imports", () => {
    const body = `{
      const result = utils.helper();
      expect(result).toBe(true);
    }`;
    const imports = [{ name: "utils", modulePath: "./utils" }];
    expect(testBlockCallsProductionCode(body, imports)).toBe(true);
  });

  it("returns false when no imports provided", () => {
    const body = `{
      myFunction();
    }`;
    expect(testBlockCallsProductionCode(body, [])).toBe(false);
  });

  it("returns true when async function is awaited", () => {
    const body = `{
      const result = await asyncFunction();
      expect(result).toBe(true);
    }`;
    const imports = [{ name: "asyncFunction", modulePath: "./async" }];
    expect(testBlockCallsProductionCode(body, imports)).toBe(true);
  });

  it("matches multiple imported functions", () => {
    const body = `{
      funcA();
    }`;
    const imports = [
      { name: "funcA", modulePath: "./a" },
      { name: "funcB", modulePath: "./b" },
    ];
    expect(testBlockCallsProductionCode(body, imports)).toBe(true);
  });

  it("returns true when function is passed as callback reference", () => {
    const body = `{
      const results = items.map(validator);
      expect(results).toEqual([true, false]);
    }`;
    const imports = [{ name: "validator", modulePath: "./validate" }];
    expect(testBlockCallsProductionCode(body, imports)).toBe(true);
  });

  it("returns true when function is assigned to a variable", () => {
    const body = `{
      const handler = myHandler;
      handler();
    }`;
    const imports = [{ name: "myHandler", modulePath: "./handlers" }];
    expect(testBlockCallsProductionCode(body, imports)).toBe(true);
  });

  it("handles identifiers with special regex characters like $", () => {
    const body = `{
      const el = $(".selector");
      expect(el).toBeDefined();
    }`;
    const imports = [{ name: "$", modulePath: "./jquery" }];
    expect(testBlockCallsProductionCode(body, imports)).toBe(true);
  });

  it("does not match function name as substring of another identifier", () => {
    const body = `{
      const fooHandler = 42;
      expect(fooHandler).toBe(42);
    }`;
    const imports = [{ name: "foo", modulePath: "./foo" }];
    // "foo" appears as prefix of "fooHandler" but not as a standalone reference
    expect(testBlockCallsProductionCode(body, imports)).toBe(false);
  });
});

describe("analyzeTestFile", () => {
  it("identifies tautological tests", () => {
    const content = `
      import { realFunc } from './real';

      it('tautological test', () => {
        const x = true;
        expect(x).toBe(true);
      });
    `;
    const result = analyzeTestFile(content, "test.ts");
    expect(result.totalTests).toBe(1);
    expect(result.tautologicalCount).toBe(1);
    expect(result.tautologicalPercentage).toBe(100);
    expect(result.testBlocks[0].isTautological).toBe(true);
  });

  it("identifies real tests", () => {
    const content = `
      import { realFunc } from './real';

      it('real test', () => {
        const result = realFunc();
        expect(result).toBe(true);
      });
    `;
    const result = analyzeTestFile(content, "test.ts");
    expect(result.totalTests).toBe(1);
    expect(result.tautologicalCount).toBe(0);
    expect(result.tautologicalPercentage).toBe(0);
    expect(result.testBlocks[0].isTautological).toBe(false);
  });

  it("handles mixed tautological and real tests", () => {
    const content = `
      import { realFunc } from './real';

      it('tautological', () => {
        expect(true).toBe(true);
      });

      it('real', () => {
        realFunc();
      });
    `;
    const result = analyzeTestFile(content, "test.ts");
    expect(result.totalTests).toBe(2);
    expect(result.tautologicalCount).toBe(1);
    expect(result.tautologicalPercentage).toBe(50);
  });

  it("handles files with no test blocks", () => {
    const content = `
      import { something } from './somewhere';
      const x = 1;
    `;
    const result = analyzeTestFile(content, "not-a-test.ts");
    expect(result.totalTests).toBe(0);
    expect(result.tautologicalCount).toBe(0);
    expect(result.tautologicalPercentage).toBe(0);
    expect(result.parseSuccess).toBe(true);
  });

  it("handles files with no source imports", () => {
    const content = `
      import { describe, it, expect } from 'vitest';

      it('test without source imports', () => {
        expect(1 + 1).toBe(2);
      });
    `;
    const result = analyzeTestFile(content, "test.ts");
    expect(result.totalTests).toBe(1);
    expect(result.tautologicalCount).toBe(1);
    expect(result.importedFunctions).toHaveLength(0);
  });
});

// Issue #885: subprocess-driven integration tests (e.g. cli.integration.test.ts)
// import only node builtins and exercise production code by spawning the build
// output (dist/bin/cli.js). Static import analysis can't see through the
// process boundary, so before this fix every such block scored 100%
// tautological. Detection keys on CONTENT (a spawn of a dist/ build path),
// never on the filename or an opt-out annotation.
describe("analyzeTestFile — subprocess-driven tests (#885)", () => {
  it("counts a direct spawn of dist/ build output as production (AC-2)", () => {
    // Arbitrary non-integration filename, only a node builtin imported, no
    // @tautology-skip — so passing this cannot come from a filename or
    // annotation shortcut; it must come from detecting the spawn itself.
    const content = `
      import { execSync } from "node:child_process";
      import { resolve } from "node:path";
      const cliPath = resolve(projectRoot, "dist/bin/cli.js");

      it("runs the built CLI", () => {
        const out = execSync(\`node \${cliPath} --version\`);
        expect(out.trim()).toBe("1.2.3");
      });
    `;
    const result = analyzeTestFile(content, "src/commands/cli.smoke.test.ts");
    expect(result.totalTests).toBe(1);
    expect(result.tautologicalCount).toBe(0);
    expect(result.testBlocks[0].isTautological).toBe(false);
  });

  it("counts an inline dist/ spawn (no build-path variable) as production (AC-2)", () => {
    const content = `
      import { execSync } from "node:child_process";
      it("runs the built CLI inline", () => {
        const out = execSync("node dist/bin/cli.js --version");
        expect(out).toBeDefined();
      });
    `;
    const result = analyzeTestFile(content, "src/commands/inline.test.ts");
    expect(result.testBlocks[0].isTautological).toBe(false);
  });

  it("counts a block that spawns the CLI via a closure helper as production (AC-1)", () => {
    // The block never spawns directly — it calls runHelp(), which closes over
    // cliPath and spawns. Detection must resolve the helper.
    const content = `
      import { execSync } from "node:child_process";
      const cliPath = resolve(projectRoot, "dist/bin/cli.js");
      const runHelp = (): string => {
        return execSync(\`node \${cliPath} run --help\`);
      };

      it("uses the help via helper", () => {
        const output = runHelp();
        expect(output).toContain("Usage");
      });
    `;
    const result = analyzeTestFile(content, "src/commands/helper.test.ts");
    expect(result.testBlocks[0].isTautological).toBe(false);
  });

  it("resolves spawn helpers transitively (helper that calls another helper) (AC-1)", () => {
    // Mirrors cli.integration.test.ts: a test calls expectAccepted(), which
    // calls run(), which spawns the CLI. Both indirection levels must resolve.
    const content = `
      import { spawnSync } from "node:child_process";
      const cliPath = resolve(projectRoot, "dist/bin/cli.js");
      const run = (...args: string[]): { stdout: string } => {
        const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf-8" });
        return { stdout: r.stdout ?? "" };
      };
      const expectAccepted = (flag: string): void => {
        const { stdout } = run("run", "1", flag, "--dry-run");
        expect(stdout).toBeDefined();
      };

      it("accepts the flag via a two-level helper", () => {
        expectAccepted("-q");
      });
    `;
    const result = analyzeTestFile(content, "src/commands/transitive.test.ts");
    expect(result.testBlocks[0].isTautological).toBe(false);
  });

  it("still flags a genuinely tautological block in a subprocess-driven file (AC-3)", () => {
    // Same file has a real spawn block AND a do-nothing block. The fix must be
    // per-block: it must not blanket-exempt the whole file.
    const content = `
      import { execSync } from "node:child_process";
      const cliPath = resolve(projectRoot, "dist/bin/cli.js");

      it("spawns the built CLI", () => {
        execSync(\`node \${cliPath} status\`);
      });

      it("asserts only on locals", () => {
        const x = 1 + 1;
        expect(x).toBe(2);
      });
    `;
    const result = analyzeTestFile(content, "src/commands/mixed.test.ts");
    expect(result.totalTests).toBe(2);
    const spawnBlock = result.testBlocks.find(
      (b) => b.description === "spawns the built CLI",
    );
    const localBlock = result.testBlocks.find(
      (b) => b.description === "asserts only on locals",
    );
    expect(spawnBlock?.isTautological).toBe(false);
    expect(localBlock?.isTautological).toBe(true);
  });

  it("does not mask a tautology via method-style .exec() plus a dist/ token (AC-3)", () => {
    // regex.exec() is RegExp.prototype.exec, not child_process.exec. A block
    // that runs it against a build-path string but asserts only on locals
    // calls nothing real and must stay flagged — the spawn matcher must not
    // treat `.exec(` as a spawn.
    const content = `
      const cliPath = "dist/bin/cli.js";

      it("matches the path with a regex", () => {
        const match = /cli/.exec(cliPath);
        expect(match).not.toBeNull();
      });
    `;
    const result = analyzeTestFile(content, "src/commands/regexexec.test.ts");
    expect(result.testBlocks[0].isTautological).toBe(true);
  });

  it("still counts method-style sync spawns from a namespace import as production (AC-2)", () => {
    // The unambiguous long names must keep matching in method position:
    // cp.execSync(...) is child-process API even though it follows a dot.
    const content = `
      import * as cp from "node:child_process";
      it("runs the built CLI via namespace import", () => {
        const out = cp.execSync("node dist/bin/cli.js --version");
        expect(out).toBeDefined();
      });
    `;
    const result = analyzeTestFile(content, "src/commands/nsimport.test.ts");
    expect(result.testBlocks[0].isTautological).toBe(false);
  });

  it("does not treat a helper that references a dist/ string but never spawns as production (AC-5)", () => {
    // buildDir is a build-output token, but describeBuild only concatenates it —
    // no spawn. A block that merely calls describeBuild() calls nothing real.
    const content = `
      const buildDir = "dist/bin";
      const describeBuild = (): string => {
        return "the build dir is " + buildDir;
      };

      it("mentions the build dir but runs nothing real", () => {
        const label = describeBuild();
        expect(label).toContain("build dir");
      });
    `;
    const result = analyzeTestFile(content, "src/commands/nospawn.test.ts");
    expect(result.testBlocks[0].isTautological).toBe(true);
  });
});

describe("detectTautologicalTests", () => {
  it("aggregates results from multiple files", () => {
    const files = [
      {
        path: "file1.test.ts",
        content: `
          import { fn } from './fn';
          it('tautological', () => { expect(true).toBe(true); });
        `,
      },
      {
        path: "file2.test.ts",
        content: `
          import { fn } from './fn';
          it('real', () => { fn(); });
        `,
      },
    ];
    const results = detectTautologicalTests(files);
    expect(results.summary.totalFiles).toBe(2);
    expect(results.summary.totalTests).toBe(2);
    expect(results.summary.totalTautological).toBe(1);
    expect(results.summary.overallPercentage).toBe(50);
    expect(results.summary.exceedsBlockingThreshold).toBe(false);
  });

  it("sets exceedsBlockingThreshold when >50% tautological", () => {
    const files = [
      {
        path: "file.test.ts",
        content: `
          import { fn } from './fn';
          it('tautological1', () => { expect(true).toBe(true); });
          it('tautological2', () => { expect(true).toBe(true); });
          it('real', () => { fn(); });
        `,
      },
    ];
    const results = detectTautologicalTests(files);
    expect(results.summary.totalTests).toBe(3);
    expect(results.summary.totalTautological).toBe(2);
    expect(results.summary.overallPercentage).toBeCloseTo(66.67, 1);
    expect(results.summary.exceedsBlockingThreshold).toBe(true);
  });

  it("does not set blocking threshold at exactly 50%", () => {
    const files = [
      {
        path: "file.test.ts",
        content: `
          import { fn } from './fn';
          it('tautological', () => { expect(true).toBe(true); });
          it('real', () => { fn(); });
        `,
      },
    ];
    const results = detectTautologicalTests(files);
    expect(results.summary.totalTests).toBe(2);
    expect(results.summary.totalTautological).toBe(1);
    expect(results.summary.overallPercentage).toBe(50);
    expect(results.summary.exceedsBlockingThreshold).toBe(false);
  });

  it("handles empty file list", () => {
    const results = detectTautologicalTests([]);
    expect(results.summary.totalFiles).toBe(0);
    expect(results.summary.totalTests).toBe(0);
    expect(results.summary.totalTautological).toBe(0);
    expect(results.summary.overallPercentage).toBe(0);
    expect(results.summary.exceedsBlockingThreshold).toBe(false);
  });
});

describe("formatTautologyResults", () => {
  it("formats results with no tests", () => {
    const results = detectTautologicalTests([]);
    const output = formatTautologyResults(results);
    expect(output).toContain("### Test Quality Review");
    expect(output).toContain("SKIP");
    expect(output).toContain("No test blocks found");
  });

  it("formats results with all passing tests", () => {
    const files = [
      {
        path: "file.test.ts",
        content: `
          import { fn } from './fn';
          it('real', () => { fn(); });
        `,
      },
    ];
    const results = detectTautologicalTests(files);
    const output = formatTautologyResults(results);
    expect(output).toContain("✅ OK");
    expect(output).toContain("All tests call production code");
  });

  it("formats results with warnings", () => {
    const files = [
      {
        path: "file.test.ts",
        content: `
          import { fn } from './fn';
          it('tautological', () => { expect(true).toBe(true); });
          it('real', () => { fn(); });
        `,
      },
    ];
    const results = detectTautologicalTests(files);
    const output = formatTautologyResults(results);
    expect(output).toContain("⚠️ WARN");
    expect(output).toContain("1 tautological test blocks found");
    expect(output).toContain("**Tautological Tests Found:**");
    expect(output).toContain("file.test.ts");
  });

  it("formats results with blocking threshold exceeded", () => {
    const files = [
      {
        path: "file.test.ts",
        content: `
          import { fn } from './fn';
          it('tautological1', () => { expect(true).toBe(true); });
          it('tautological2', () => { expect(true).toBe(true); });
        `,
      },
    ];
    const results = detectTautologicalTests(files);
    const output = formatTautologyResults(results);
    expect(output).toContain("❌ FAIL");
    expect(output).toContain("blocks `READY_FOR_MERGE`");
  });
});

describe("getTautologyVerdictImpact", () => {
  it('returns "none" when no tests', () => {
    const results = detectTautologicalTests([]);
    expect(getTautologyVerdictImpact(results)).toBe("none");
  });

  it('returns "none" when all tests are real', () => {
    const files = [
      {
        path: "file.test.ts",
        content: `
          import { fn } from './fn';
          it('real', () => { fn(); });
        `,
      },
    ];
    const results = detectTautologicalTests(files);
    expect(getTautologyVerdictImpact(results)).toBe("none");
  });

  it('returns "warning" when some tests are tautological', () => {
    const files = [
      {
        path: "file.test.ts",
        content: `
          import { fn } from './fn';
          it('tautological', () => { expect(true).toBe(true); });
          it('real', () => { fn(); });
        `,
      },
    ];
    const results = detectTautologicalTests(files);
    expect(getTautologyVerdictImpact(results)).toBe("warning");
  });

  it('returns "blocking" when >50% tests are tautological', () => {
    const files = [
      {
        path: "file.test.ts",
        content: `
          import { fn } from './fn';
          it('tautological1', () => { expect(true).toBe(true); });
          it('tautological2', () => { expect(true).toBe(true); });
          it('real', () => { fn(); });
        `,
      },
    ];
    const results = detectTautologicalTests(files);
    expect(getTautologyVerdictImpact(results)).toBe("blocking");
  });
});

describe("analyzeTestFile — helper shapes the detector must see (#906)", () => {
  // Measured motivation: `checkout-lock.integration.test.ts` (helpers written
  // as `function` declarations) read 17/19 tautological on origin/main, and
  // `checkout-lock.test.ts` (a `function makeLock` factory) 7/20 — every one a
  // false positive. Both files drive real production code.

  it("sees a helper declared with `function`, not just an arrow const", () => {
    const content = `
import { doWork } from './work';
function helper() { return doWork(); }
describe('x', () => {
  it('uses the helper', () => { expect(helper()).toBe(1); });
});`;
    const result = analyzeTestFile(content, "a.test.ts");
    expect(result.tautologicalCount).toBe(0);
  });

  it("sees a `function` helper whose return type is an object literal", () => {
    // The body brace is NOT the first `{` after the parameters here — the
    // return-type annotation opens one first.
    const content = `
import { doWork } from './work';
function helper(x: number): { status: number; out: string } {
  return doWork(x);
}
describe('x', () => {
  it('uses the helper', () => { expect(helper(1).status).toBe(0); });
});`;
    const result = analyzeTestFile(content, "a.test.ts");
    expect(result.tautologicalCount).toBe(0);
  });

  it("counts a helper that calls an imported production function", () => {
    // Previously only spawn-based helpers were resolved, so a test that built
    // its subject through a factory read as import-less.
    const content = `
import { CheckoutLock } from './locks';
function makeLock(pid: number) { return new CheckoutLock({ pid }); }
describe('x', () => {
  it('acquires', () => { expect(makeLock(1).acquire(23, 'c')).toBeTruthy(); });
});`;
    const result = analyzeTestFile(content, "a.test.ts");
    expect(result.tautologicalCount).toBe(0);
  });

  it("resolves helper indirection transitively through `function` helpers", () => {
    const content = `
import { doWork } from './work';
function inner() { return doWork(); }
function outer() { return inner(); }
describe('x', () => {
  it('uses the outer helper', () => { expect(outer()).toBe(1); });
});`;
    const result = analyzeTestFile(content, "a.test.ts");
    expect(result.tautologicalCount).toBe(0);
  });

  it("counts spawning a project script, not only `dist/` build output", () => {
    // The hook IS the production code under test in the checkout-lock suite;
    // it just does not live under dist/.
    const content = `
import { spawnSync } from 'child_process';
const HOOK = join(REPO_ROOT, '.claude/hooks/pre-tool.sh');
function runHook(cmd: string): { status: number } {
  return spawnSync('bash', [HOOK], { input: cmd });
}
describe('x', () => {
  it('blocks', () => { expect(runHook('git checkout main').status).toBe(2); });
});`;
    const result = analyzeTestFile(content, "a.test.ts");
    expect(result.tautologicalCount).toBe(0);
  });

  it("still flags a `function` helper that reaches no production code", () => {
    // The widening must not turn the detector off: a helper is only a handle
    // when it actually reaches production.
    const content = `
import { describe } from 'vitest';
function helper(): { a: number } { return { a: 1 }; }
describe('x', () => {
  it('asserts on the helper only', () => { expect(helper().a).toBe(1); });
  it('asserts on locals only', () => { const a = true; expect(a).toBe(true); });
});`;
    const result = analyzeTestFile(content, "a.test.ts");
    expect(result.tautologicalCount).toBe(2);
  });

  it("counts an inline project-script path, not only a captured handle", () => {
    // Gates PROJECT_SCRIPT_PATTERN itself. The `runHook` case above reaches
    // production through the collected `HOOK` variable, so it survives even
    // with that pattern removed — this one does not.
    const content = `
import { spawnSync } from 'child_process';
describe('x', () => {
  it('runs the migration script', () => {
    expect(spawnSync('npx', ['tsx', 'scripts/migrate.ts']).status).toBe(0);
  });
});`;
    const result = analyzeTestFile(content, "a.test.ts");
    expect(result.tautologicalCount).toBe(0);
  });

  it("does not treat spawning a system binary as production code", () => {
    const content = `
import { spawnSync } from 'child_process';
function git(cwd: string) { return spawnSync('git', ['status'], { cwd }); }
describe('x', () => {
  it('runs git', () => { expect(git('/tmp').status).toBe(0); });
});`;
    const result = analyzeTestFile(content, "a.test.ts");
    expect(result.tautologicalCount).toBe(1);
  });
});

describe("analyzeTestFile — type-annotated table + describe.each param (#963)", () => {
  // Measured motivation: pre-tool-hook.integration.test.ts read 74/74
  // tautological on origin/main. Two compounding misses: a type annotation
  // between the table var's name and `=` hid its build-output tokens from
  // collectBuildOutputVars, and the runHook() helper spawns via a
  // describe.each callback parameter — never the table var itself — so
  // nothing tied that parameter back to production code.

  it("sees a type-annotated table var's project-script path, and the describe.each param bound to a row's path", () => {
    const content = `
import { spawnSync } from 'child_process';
const HOOK_COPIES: Array<[label: string, path: string]> = [
  ['a', 'hooks/pre-tool.sh'],
];
function runHook(hookPath: string): { status: number } {
  return spawnSync('bash', [hookPath], { input: 'x' });
}
describe.each(HOOK_COPIES)('x [%s]', (_label, hookPath) => {
  it('blocks', () => { expect(runHook(hookPath).status).toBe(2); });
});`;
    const result = analyzeTestFile(content, "a.test.ts");
    expect(result.tautologicalCount).toBe(0);
  });

  it("still flags the same shape when the spawned binary is a system command, not a project script", () => {
    // Negative control: same type-annotated table + describe.each param
    // structure, but no project-script token appears anywhere in the file —
    // the widening must not turn the detector off for genuinely unrelated
    // spawns.
    const content = `
import { spawnSync } from 'child_process';
const LABELS: Array<[label: string, bin: string]> = [
  ['a', 'git'],
];
function runBin(bin: string): { status: number } {
  return spawnSync(bin, ['status'], {});
}
describe.each(LABELS)('x [%s]', (_label, bin) => {
  it('runs it', () => { expect(runBin(bin).status).toBe(0); });
});`;
    const result = analyzeTestFile(content, "a.test.ts");
    expect(result.tautologicalCount).toBe(1);
  });
});
