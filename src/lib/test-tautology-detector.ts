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
  /** Whether the file was skipped via @tautology-skip pragma */
  skipped?: boolean;
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
 * string literal (single, double, or template), comment (line or block),
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
 * Build a whole-identifier reference matcher for `name`, bounded by
 * non-identifier chars ([\w$]). Catches direct calls, method calls, callback
 * references, and assignments while rejecting substring matches.
 */
function referenceMatcher(name: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegex(name)}(?![\\w$])`);
}

/**
 * Child-process spawn functions. A test that spawns the project's *build
 * output* is exercising production code across a process boundary that static
 * import analysis cannot see through — issue #885.
 *
 * Two alternates by name ambiguity: the long names are unambiguous
 * child-process API and match anywhere, including method-style calls from a
 * namespace import (`cp.execSync(...)`). The short names (`exec`, `spawn`,
 * `fork`) collide with unrelated methods — `RegExp.prototype.exec` most of
 * all — so they must not be preceded by `.` (or an identifier char). The
 * cost is that method-style callback `cp.exec(...)` no longer counts; tests
 * that spawn build output overwhelmingly use the sync variants, and a false
 * tautology report is loud where the `.exec()` collision was silent.
 */
const SPAWN_PATTERN =
  /(?:\b(?:execFileSync|spawnSync|execSync|execFile)\s*\(|(?<![\w$.])(?:exec|fork|spawn)\s*\()/;

/**
 * Marker for the project's build-output directory. A spawn whose arguments
 * reach this path is running compiled production code.
 */
const BUILD_OUTPUT_PATTERN = /\bdist\//;

/**
 * Non-compiled production code this project ships and executes: the hook
 * scripts and the `scripts/` + `templates/scripts/` trees (#906).
 *
 * `dist/` alone was too narrow. `checkout-lock.integration.test.ts` drives the
 * real `.claude/hooks/pre-tool.sh` as a subprocess — that hook IS the
 * enforcement half of the feature under test — yet every block in the file
 * read as tautological because the path is not under `dist/`.
 */
const PROJECT_SCRIPT_PATTERN = /\b(?:hooks\/[\w.-]+\.sh|scripts\/[\w./-]+)/;

/**
 * Collect names of variables bound to a path into the project's own executable
 * code, e.g.
 *   const cliPath = resolve(projectRoot, "dist/bin/cli.js");
 *   const HOOK    = join(REPO_ROOT, ".claude/hooks/pre-tool.sh");
 * captures `cliPath` / `HOOK`. Tests almost always spawn via such a handle
 * rather than an inline string, so these names stand in for the literal path.
 *
 * The right-hand side is statement-bounded (`[^;]`) so a match cannot bleed
 * across declarations, and must reach one of the two markers. Spawning a
 * *system* binary (`git`, `bash` with a temp fixture) matches neither, which
 * is the intended exclusion — those are not this project's code.
 */
function collectBuildOutputVars(content: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /(?:const|let|var)\s+(\w+)\s*=\s*[^;]*?\bdist\//g,
    /(?:const|let|var)\s+(\w+)\s*=\s*[^;]*?\b(?:hooks\/[\w.-]+\.sh|scripts\/[\w./-]+)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      names.add(match[1]);
    }
  }
  return [...names];
}

/**
 * Whether a code body references a build-output token: either the literal
 * `dist/` marker or one of the collected build-path variable names.
 */
function referencesBuildOutput(
  body: string,
  buildOutputVars: string[],
): boolean {
  if (BUILD_OUTPUT_PATTERN.test(body) || PROJECT_SCRIPT_PATTERN.test(body)) {
    return true;
  }
  return buildOutputVars.some((name) => referenceMatcher(name).test(body));
}

/**
 * Whether a code body itself spawns the build output: it must contain BOTH a
 * child-process spawn call AND a build-output token. Requiring co-occurrence
 * keeps a helper that merely mentions `dist/` in a string (but never spawns)
 * from counting as production (#885 AC-5).
 */
function spawnsBuildOutput(body: string, buildOutputVars: string[]): boolean {
  return (
    SPAWN_PATTERN.test(body) && referencesBuildOutput(body, buildOutputVars)
  );
}

/**
 * Extract module/describe-scope helper definitions as { name, body } pairs.
 *
 * Two shapes, because both are idiomatic and a detector that saw only one
 * produced large-scale false positives (#906): a test calling a helper the
 * detector cannot see reads as import-less, hence tautological. Measured on
 * `checkout-lock.integration.test.ts` (helpers written as `function`
 * declarations): 17 of 19 blocks flagged, every one of them real.
 *
 * Params are matched with `[^()]*` (no nested parens) to keep the scan from
 * running away across the file. Expression-bodied arrows are skipped — they
 * have no `{` body to extract.
 */
function extractHelperDefinitions(
  content: string,
): Array<{ name: string; body: string }> {
  const helpers: Array<{ name: string; body: string }> = [];

  // Arrow consts anchor on `=> {`, so the body brace is unambiguous.
  const arrowPattern =
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^()]*\)\s*(?::[^=]*?)?=>\s*\{/g;
  let match;
  while ((match = arrowPattern.exec(content)) !== null) {
    if (isInsideString(content, match.index)) continue;
    const braceIndex = match.index + match[0].length - 1;
    helpers.push({
      name: match[1],
      body: extractBlockBody(content.substring(braceIndex)),
    });
  }

  // Declarations have no `=>` marker, and the return-type annotation may open
  // a brace group of its own:
  //   function runHook(o): { status: number; stderr: string } { ... }
  // so the body is NOT simply the first `{` after the parameters. Do not try
  // to express that in the regex — a greedy annotation subpattern silently ran
  // past the body and anchored on the NEXT declaration's brace, yielding a
  // "helper" whose body was somebody else's code (caught by the object
  // return-type test below). Match only to the closing paren, then walk: take
  // the first brace group; if another `{` follows it, that group was the
  // return type and the body is the next one.
  const declPattern = /(?:async\s+)?function\s*\*?\s*(\w+)\s*\([^()]*\)/g;
  while ((match = declPattern.exec(content)) !== null) {
    if (isInsideString(content, match.index)) continue;
    const rest = content.substring(match.index + match[0].length);
    const firstBrace = rest.indexOf("{");
    if (firstBrace === -1) continue;
    // Anything between `)` and the first `{` must be an annotation, not code.
    if (/[;)=]/.test(rest.substring(0, firstBrace))) continue;

    let body = extractBlockBody(rest.substring(firstBrace));
    const after = rest.substring(firstBrace + body.length);
    if (/^\s*\{/.test(after)) {
      body = extractBlockBody(after);
    }
    helpers.push({ name: match[1], body });
  }
  return helpers;
}

/**
 * Collect the names of helper functions that reach production code, resolving
 * indirection transitively: a helper that calls an already-known handle is
 * itself a handle. This lets a test that only calls `expectFlagAccepted(...)`
 * (which calls `runInUninitializedDir`, which spawns the CLI) count as
 * exercising production code.
 *
 * A helper qualifies two ways:
 *  - it spawns the project's own executable code (subprocess integration
 *    tests), or
 *  - it references an imported production function (#906). `makeLock()`
 *    returning `new CheckoutLock({...})` is production code by any reading,
 *    but seeding on spawns alone missed it, so every test that built its
 *    subject through a factory read as tautological.
 */
function collectProductionHandles(
  content: string,
  buildOutputVars: string[],
  importedFunctions: ImportedFunction[] = [],
): string[] {
  const helpers = extractHelperDefinitions(content);
  const handles = new Set<string>();

  // Seed: helpers that directly reach production.
  for (const helper of helpers) {
    if (
      spawnsBuildOutput(helper.body, buildOutputVars) ||
      importedFunctions.some((fn) =>
        referenceMatcher(fn.name).test(helper.body),
      )
    ) {
      handles.add(helper.name);
    }
  }

  // Transitive closure: a helper referencing a known spawn helper is one too.
  let changed = true;
  while (changed) {
    changed = false;
    for (const helper of helpers) {
      if (handles.has(helper.name)) {
        continue;
      }
      for (const known of handles) {
        if (referenceMatcher(known).test(helper.body)) {
          handles.add(helper.name);
          changed = true;
          break;
        }
      }
    }
  }

  return [...handles];
}

/**
 * Check if a test block calls production code. A block counts as non-tautological
 * when it references an imported production function, directly spawns the
 * project's build output, or calls a helper that (transitively) does so.
 *
 * @param productionHandles Names of describe/module-scope helpers that reach
 *   production — by spawning the project's executable code or by calling an
 *   imported production function (see {@link collectProductionHandles}).
 * @param buildOutputVars Variable names bound to a build-output path (see
 *   {@link collectBuildOutputVars}).
 */
export function testBlockCallsProductionCode(
  body: string,
  importedFunctions: ImportedFunction[],
  productionHandles: string[] = [],
  buildOutputVars: string[] = [],
): boolean {
  // 1. References an imported production function.
  for (const fn of importedFunctions) {
    if (referenceMatcher(fn.name).test(body)) {
      return true;
    }
  }

  // 2. Directly spawns the project's build output (#885). Static import
  //    analysis can't see through a subprocess boundary, so a test that runs
  //    `dist/bin/cli.js` looks import-less but exercises production code.
  if (spawnsBuildOutput(body, buildOutputVars)) {
    return true;
  }

  // 3. Calls a describe/module-scope helper that (transitively) reaches
  //    production — spawns the project's executable code, or calls an imported
  //    production function (#906). Covers arrow-const and `function` helpers.
  for (const handle of productionHandles) {
    if (referenceMatcher(handle).test(body)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a file opts out of tautology detection via pragma comment.
 *
 * Recognized pragmas (must appear in the first 10 lines):
 *   // @tautology-skip: <reason>
 *   // @tautology-skip
 */
export function hasTautologySkipPragma(content: string): boolean {
  const headerLines = content.split("\n").slice(0, 10);
  return headerLines.some((line) => /\/\/\s*@tautology-skip/.test(line));
}

/**
 * Analyze a single test file for tautological tests
 */
export function analyzeTestFile(
  content: string,
  filePath: string,
): TautologyFileResult {
  if (hasTautologySkipPragma(content)) {
    return {
      filePath,
      totalTests: 0,
      tautologicalCount: 0,
      tautologicalPercentage: 0,
      testBlocks: [],
      importedFunctions: [],
      parseSuccess: true,
      skipped: true,
    };
  }

  try {
    const importedFunctions = extractImports(content);
    const buildOutputVars = collectBuildOutputVars(content);
    const productionHandles = collectProductionHandles(
      content,
      buildOutputVars,
      importedFunctions,
    );
    const testBlocks = extractTestBlocks(content);

    const analyzedBlocks: TestBlock[] = testBlocks.map((block) => ({
      description: block.description,
      lineNumber: block.lineNumber,
      style: block.style,
      isTautological: !testBlockCallsProductionCode(
        block.body,
        importedFunctions,
        productionHandles,
        buildOutputVars,
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

  // Exclude skipped files from summary counts
  const analyzed = fileResults.filter((r) => !r.skipped);
  const totalFiles = analyzed.length;
  const totalTests = analyzed.reduce((sum, r) => sum + r.totalTests, 0);
  const totalTautological = analyzed.reduce(
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

  // Skipped files (via @tautology-skip pragma)
  const skippedFiles = results.fileResults.filter((r) => r.skipped);
  if (skippedFiles.length > 0) {
    lines.push(
      `| Tautology Check | ⏭️ SKIP | ${skippedFiles.length} file(s) skipped via @tautology-skip |`,
    );
    lines.push("");
    lines.push("**Skipped (@tautology-skip):**");
    for (const file of skippedFiles) {
      lines.push(`- \`${file.filePath}\``);
    }
    lines.push("");
    if (results.summary.totalTests === 0) {
      return lines.join("\n");
    }
  } else if (results.summary.totalTests === 0) {
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
