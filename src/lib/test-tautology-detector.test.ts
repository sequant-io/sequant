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
