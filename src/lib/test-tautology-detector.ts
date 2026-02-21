/**
 * Test Tautology Detector
 *
 * Detects tautological tests — tests that pass but don't call any production code.
 * These tests provide zero regression protection as they only assert on local values.
 *
 * @example
 * ```typescript
 * import { detectTautologicalTests, formatTautologyResults } from './test-tautology-detector';
 *
 * const results = detectTautologicalTests([
 *   { path: 'src/lib/foo.test.ts', content: fileContent },
 * ]);
 * console.log(formatTautologyResults(results));
 * ```
 */

/**
 * Represents an imported function from a source module
 */
export interface ImportedFunction {
  /** Function name */
  name: string;
  /** Module path the function was imported from */
  modulePath: string;
}

/**
 * Represents a test block (it() or test())
 */
export interface TestBlock {
  /** Test description */
  description: string;
  /** Line number where the test starts */
  lineNumber: number;
  /** Whether this test is tautological (no production function calls) */
  isTautological: boolean;
  /** Style of test block: 'it' or 'test' */
  style: "it" | "test";
}

/**
 * Result of analyzing a single test file
 */
export interface TautologyFileResult {
  /** Path to the test file */
  filePath: string;
  /** Total number of test blocks found */
  totalTests: number;
  /** Number of tautological test blocks */
  tautologicalCount: number;
  /** Percentage of tests that are tautological */
  tautologicalPercentage: number;
  /** Individual test blocks with their analysis */
  testBlocks: TestBlock[];
  /** Imported functions from source modules */
  importedFunctions: ImportedFunction[];
  /** Whether the file could be parsed successfully */
  parseSuccess: boolean;
  /** Error message if parsing failed */
  parseError?: string;
}

/**
 * Overall tautology detection results
 */
export interface TautologyResults {
  /** Results for each analyzed file */
  fileResults: TautologyFileResult[];
  /** Summary statistics */
  summary: {
    totalFiles: number;
    totalTests: number;
    totalTautological: number;
    overallPercentage: number;
    /** Whether >50% of tests are tautological (blocking threshold) */
    exceedsBlockingThreshold: boolean;
  };
}

/**
 * Test library imports to exclude from production function detection
 */
const TEST_LIBRARY_PATTERNS = [
  /^vitest$/,
  /^@vitest\//,
  /^jest$/,
  /^@jest\//,
  /^@testing-library\//,
  /^react-test-renderer/,
  /^enzyme/,
  /^sinon/,
  /^chai/,
  /^mocha/,
  /^node:test/,
  /^assert$/,
];

/**
 * Mock/fixture path patterns to exclude
 */
const MOCK_FIXTURE_PATTERNS = [
  /mock/i,
  /fixture/i,
  /stub/i,
  /fake/i,
  /__mocks__/,
  /__fixtures__/,
  /test-utils?/i,
  /test-helper/i,
];

/**
 * Check if an import path is from a source module (not a test library or mock)
 */
export function isSourceModule(modulePath: string): boolean {
  // Check if it's a test library
  for (const pattern of TEST_LIBRARY_PATTERNS) {
    if (pattern.test(modulePath)) {
      return false;
    }
  }

  // Check if it's a mock/fixture
  for (const pattern of MOCK_FIXTURE_PATTERNS) {
    if (pattern.test(modulePath)) {
      return false;
    }
  }

  // Check if it's a Node.js built-in
  if (modulePath.startsWith("node:")) {
    return false;
  }

  // Source modules typically start with ./ or ../ or are absolute imports
  // For this detector, we consider relative imports as production code
  if (modulePath.startsWith("./") || modulePath.startsWith("../")) {
    return true;
  }

  // Absolute imports from the project (non-node_modules) are also production code
  // We can't reliably detect this without filesystem access, so we're conservative
  // and only count relative imports as production code
  return false;
}

/**
 * Extract imports from a test file
 *
 * Handles:
 * - Named imports: `import { foo, bar } from './module'`
 * - Default imports: `import foo from './module'`
 * - Namespace imports: `import * as foo from './module'` (extracts the namespace name)
 */
export function extractImports(content: string): ImportedFunction[] {
  const imports: ImportedFunction[] = [];

  // Named imports: import { foo, bar, baz as qux } from './module'
  const namedImportPattern = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match;

  while ((match = namedImportPattern.exec(content)) !== null) {
    const names = match[1];
    const modulePath = match[2];

    if (!isSourceModule(modulePath)) {
      continue;
    }

    // Parse individual imports, handling aliases (foo as bar)
    const importedNames = names.split(",").map((n) => n.trim());
    for (const name of importedNames) {
      if (!name) continue;

      // Handle aliased imports: "originalName as aliasName"
      const aliasMatch = name.match(/(\w+)\s+as\s+(\w+)/);
      if (aliasMatch) {
        // Use the alias (the name actually used in code)
        imports.push({ name: aliasMatch[2], modulePath });
      } else {
        // No alias, use the name directly
        const cleanName = name.replace(/\s+/g, "");
        if (cleanName) {
          imports.push({ name: cleanName, modulePath });
        }
      }
    }
  }

  // Default imports: import foo from './module'
  const defaultImportPattern = /import\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g;

  while ((match = defaultImportPattern.exec(content)) !== null) {
    const name = match[1];
    const modulePath = match[2];

    if (isSourceModule(modulePath)) {
      imports.push({ name, modulePath });
    }
  }

  // Namespace imports: import * as foo from './module'
  const namespaceImportPattern =
    /import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g;

  while ((match = namespaceImportPattern.exec(content)) !== null) {
    const name = match[1];
    const modulePath = match[2];

    if (isSourceModule(modulePath)) {
      imports.push({ name, modulePath });
    }
  }

  return imports;
}

/**
 * Extract test blocks (it() and test()) from content
 *
 * Returns the description, line number, body content, and style of each test block.
 */
export function extractTestBlocks(content: string): Array<{
  description: string;
  lineNumber: number;
  body: string;
  style: "it" | "test";
}> {
  const blocks: Array<{
    description: string;
    lineNumber: number;
    body: string;
    style: "it" | "test";
  }> = [];

  // Find test block starts with their line numbers
  // Pattern matches: it("...", ...) or test("...", ...)
  // Including variations like it.skip, it.only, test.skip, test.only
  const testBlockStartPattern =
    /\b(it|test)(?:\.skip|\.only)?\s*\(\s*(['"`])(.+?)\2/g;

  let match;
  while ((match = testBlockStartPattern.exec(content)) !== null) {
    const style = match[1] as "it" | "test";
    const description = match[3];
    const startIndex = match.index;

    // Skip matches inside string literals (e.g., test code embedded in template literals)
    if (isInsideString(content, startIndex)) {
      continue;
    }

    // Calculate line number
    const contentBeforeMatch = content.substring(0, startIndex);
    const lineNumber = contentBeforeMatch.split("\n").length;

    // Find the matching closing brace for the test block
    // This is a simplified approach that works for most cases
    const afterMatch = content.substring(startIndex);
    const body = extractBlockBody(afterMatch);

    blocks.push({
      description,
      lineNumber,
      body,
      style,
    });
  }

  return blocks;
}

/**
 * Check if a position in the content is inside a non-code context:
 * string literal (single, double, or template), comment (// or /* ... *​/),
 * or a template expression's string context.
 *
 * Handles nested template literals: `` `outer ${`inner`} still outer` ``
 * by tracking template expression depth via a stack.
 */
function isInsideString(content: string, position: number): boolean {
  let inString = false;
  let stringChar = "";
  let escaped = false;
  // Stack tracks brace depth inside template expressions.
  // When we encounter `${`, we push 0. Nested `{` increments top.
  // `}` at depth 0 pops the stack and re-enters the template literal.
  const templateExprStack: number[] = [];

  for (let i = 0; i < position && i < content.length; i++) {
    const char = content[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    // Inside a template literal — handle ${...} expressions
    if (inString && stringChar === "`") {
      if (char === "$" && i + 1 < content.length && content[i + 1] === "{") {
        // Enter template expression — temporarily leave string context
        templateExprStack.push(0);
        inString = false;
        i++; // skip the `{`
        continue;
      }
      if (char === "`") {
        inString = false;
        continue;
      }
      continue;
    }

    // Inside a non-template string
    if (inString) {
      if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    // Not in any string — check if we're inside a template expression
    if (templateExprStack.length > 0) {
      if (char === "{") {
        templateExprStack[templateExprStack.length - 1]++;
      } else if (char === "}") {
        if (templateExprStack[templateExprStack.length - 1] === 0) {
          // Closing the template expression — re-enter the template literal
          templateExprStack.pop();
          inString = true;
          stringChar = "`";
        } else {
          templateExprStack[templateExprStack.length - 1]--;
        }
      } else if (char === "`" || char === '"' || char === "'") {
        inString = true;
        stringChar = char;
      } else if (
        char === "/" &&
        i + 1 < content.length &&
        content[i + 1] === "/"
      ) {
        // Line comment — if position falls within it, return true
        const eol = content.indexOf("\n", i);
        const commentEnd = eol === -1 ? content.length : eol;
        if (position <= commentEnd) return true;
        i = commentEnd;
      } else if (
        char === "/" &&
        i + 1 < content.length &&
        content[i + 1] === "*"
      ) {
        // Block comment — if position falls within it, return true
        const end = content.indexOf("*/", i + 2);
        const commentEnd = end === -1 ? content.length : end + 1;
        if (position <= commentEnd) return true;
        i = commentEnd;
      }
      continue;
    }

    // Top-level code
    if (char === "`" || char === '"' || char === "'") {
      inString = true;
      stringChar = char;
    } else if (
      char === "/" &&
      i + 1 < content.length &&
      content[i + 1] === "/"
    ) {
      // Line comment — if position falls within it, return true
      const eol = content.indexOf("\n", i);
      const commentEnd = eol === -1 ? content.length : eol;
      if (position <= commentEnd) return true;
      i = commentEnd;
    } else if (
      char === "/" &&
      i + 1 < content.length &&
      content[i + 1] === "*"
    ) {
      // Block comment — if position falls within it, return true
      const end = content.indexOf("*/", i + 2);
      const commentEnd = end === -1 ? content.length : end + 1;
      if (position <= commentEnd) return true;
      i = commentEnd;
    }
  }

  return inString || templateExprStack.length > 0;
}

/**
 * Extract the body of a function block (content between { and matching })
 */
function extractBlockBody(content: string): string {
  // Find the first opening brace
  const firstBrace = content.indexOf("{");
  if (firstBrace === -1) {
    return "";
  }

  let depth = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;

  for (let i = firstBrace; i < content.length; i++) {
    const char = content[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (!inString && (char === '"' || char === "'" || char === "`")) {
      inString = true;
      stringChar = char;
      continue;
    }

    if (inString && char === stringChar) {
      inString = false;
      continue;
    }

    if (!inString) {
      if (char === "{") {
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0) {
          return content.substring(firstBrace, i + 1);
        }
      }
    }
  }

  // If we didn't find a matching brace, return everything after the first brace
  return content.substring(firstBrace);
}

/**
 * Escape special regex characters in a string for safe use in `new RegExp()`.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check if a test block contains calls to any of the imported production functions
 */
export function testBlockCallsProductionCode(
  body: string,
  importedFunctions: ImportedFunction[],
): boolean {
  if (importedFunctions.length === 0) {
    return false;
  }

  for (const fn of importedFunctions) {
    // Check for any reference to the imported name bounded by non-identifier chars.
    // Uses [\w$] to match JS identifier characters (letters, digits, _, $).
    // This catches direct calls (fn()), method calls (ns.method()),
    // callback references (arr.map(fn)), and assignments (const x = fn).
    const escaped = escapeRegex(fn.name);
    const referencePattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
    if (referencePattern.test(body)) {
      return true;
    }
  }

  return false;
}

/**
 * Analyze a single test file for tautological tests
 */
export function analyzeTestFile(
  content: string,
  filePath: string,
): TautologyFileResult {
  try {
    const importedFunctions = extractImports(content);
    const testBlocks = extractTestBlocks(content);

    const analyzedBlocks: TestBlock[] = testBlocks.map((block) => ({
      description: block.description,
      lineNumber: block.lineNumber,
      style: block.style,
      isTautological: !testBlockCallsProductionCode(
        block.body,
        importedFunctions,
      ),
    }));

    const tautologicalCount = analyzedBlocks.filter(
      (b) => b.isTautological,
    ).length;
    const totalTests = analyzedBlocks.length;
    const tautologicalPercentage =
      totalTests > 0 ? (tautologicalCount / totalTests) * 100 : 0;

    return {
      filePath,
      totalTests,
      tautologicalCount,
      tautologicalPercentage,
      testBlocks: analyzedBlocks,
      importedFunctions,
      parseSuccess: true,
    };
  } catch (error) {
    return {
      filePath,
      totalTests: 0,
      tautologicalCount: 0,
      tautologicalPercentage: 0,
      testBlocks: [],
      importedFunctions: [],
      parseSuccess: false,
      parseError:
        error instanceof Error ? error.message : "Unknown parse error",
    };
  }
}

/**
 * Detect tautological tests across multiple files
 */
export function detectTautologicalTests(
  files: Array<{ path: string; content: string }>,
): TautologyResults {
  const fileResults = files.map((file) =>
    analyzeTestFile(file.content, file.path),
  );

  const totalFiles = fileResults.length;
  const totalTests = fileResults.reduce((sum, r) => sum + r.totalTests, 0);
  const totalTautological = fileResults.reduce(
    (sum, r) => sum + r.tautologicalCount,
    0,
  );
  const overallPercentage =
    totalTests > 0 ? (totalTautological / totalTests) * 100 : 0;

  return {
    fileResults,
    summary: {
      totalFiles,
      totalTests,
      totalTautological,
      overallPercentage,
      exceedsBlockingThreshold: overallPercentage > 50,
    },
  };
}

/**
 * Format tautology results as markdown for QA output
 */
export function formatTautologyResults(results: TautologyResults): string {
  const lines: string[] = [];

  lines.push("### Test Quality Review");
  lines.push("");

  // Summary table
  lines.push("| Category | Status | Notes |");
  lines.push("|----------|--------|-------|");

  if (results.summary.totalTests === 0) {
    lines.push("| Tautology Check | ⏭️ SKIP | No test blocks found |");
    return lines.join("\n");
  }

  const status = results.summary.exceedsBlockingThreshold
    ? "❌ FAIL"
    : results.summary.totalTautological > 0
      ? "⚠️ WARN"
      : "✅ OK";

  const notes =
    results.summary.totalTautological > 0
      ? `${results.summary.totalTautological} tautological test blocks found (${results.summary.overallPercentage.toFixed(1)}%)`
      : "All tests call production code";

  lines.push(`| Tautology Check | ${status} | ${notes} |`);
  lines.push("");

  // List tautological tests if any found
  if (results.summary.totalTautological > 0) {
    lines.push("**Tautological Tests Found:**");
    lines.push("");

    for (const fileResult of results.fileResults) {
      const tautologicalBlocks = fileResult.testBlocks.filter(
        (b) => b.isTautological,
      );
      for (const block of tautologicalBlocks) {
        lines.push(
          `- \`${fileResult.filePath}:${block.lineNumber}\` - \`${block.style}("${block.description}")\` - No production function calls`,
        );
      }
    }

    lines.push("");
  }

  // Verdict impact
  if (results.summary.exceedsBlockingThreshold) {
    lines.push(
      "**Verdict Impact:** >50% tautological tests — blocks `READY_FOR_MERGE`",
    );
    lines.push("");
  }

  // Parse errors if any
  const parseErrors = results.fileResults.filter((r) => !r.parseSuccess);
  if (parseErrors.length > 0) {
    lines.push("**Parse Warnings:**");
    for (const error of parseErrors) {
      lines.push(`- \`${error.filePath}\`: ${error.parseError}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Determine verdict impact based on tautology results
 */
export function getTautologyVerdictImpact(
  results: TautologyResults,
): "none" | "warning" | "blocking" {
  if (results.summary.totalTests === 0) {
    return "none";
  }

  if (results.summary.exceedsBlockingThreshold) {
    return "blocking";
  }

  if (results.summary.totalTautological > 0) {
    return "warning";
  }

  return "none";
}
