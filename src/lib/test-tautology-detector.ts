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

import { existsSync } from "fs";
import * as nodePath from "path";

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
 * - Dynamic imports: `const { foo } = await import('./module')` (#956)
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

  // Dynamic destructured imports: const { foo } = await import('./module')
  // Vitest suites that must control module state import at runtime rather
  // than at the top of the file; 27 blocks in one file read as import-less
  // for exactly this reason (#956).
  const dynamicNamedPattern =
    /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  while ((match = dynamicNamedPattern.exec(content)) !== null) {
    const modulePath = match[2];
    if (!isSourceModule(modulePath)) {
      continue;
    }
    for (const name of match[1].split(",")) {
      const aliasMatch = name.match(/(\w+)\s*:\s*(\w+)/);
      const cleanName = aliasMatch ? aliasMatch[2] : name.trim();
      if (/^\w+$/.test(cleanName)) {
        imports.push({ name: cleanName, modulePath });
      }
    }
  }

  // Dynamic default/namespace imports: const foo = await import('./module')
  const dynamicDefaultPattern =
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  while ((match = dynamicDefaultPattern.exec(content)) !== null) {
    if (isSourceModule(match[2])) {
      imports.push({ name: match[1], modulePath: match[2] });
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

    // Find the callback body. Start the search *after* the title, and skip
    // any brace group that is not a function body (#956): both
    //   it("... feature/838-fix{,-more} ...", () => {...})
    //   it("...", { timeout: 20_000 }, async () => {...})
    // put a `{` ahead of the callback, and anchoring on the first one made the
    // "body" a title fragment or an options object — so the block read as
    // tautological no matter what it actually called.
    const afterTitle = content.substring(startIndex + match[0].length);
    const body = extractTestCallbackBody(afterTitle);

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
/**
 * Body of a test block's callback argument, given the source *after* the
 * title literal.
 *
 * A brace group counts as the callback body only when the text immediately
 * before it ends an arrow (`=>`) or a `function` head. Any earlier group is an
 * options object (`{ timeout: 20_000 }`) and is skipped. Keying on what
 * precedes the brace — rather than on what follows it — also keeps the legacy
 * `it("x", () => {...}, 5000)` timeout-as-last-argument form working.
 */
function extractTestCallbackBody(text: string): string {
  let rest = text;
  for (let attempt = 0; attempt < 4; attempt++) {
    const braceIndex = rest.indexOf("{");
    if (braceIndex === -1) return "";
    const preceding = rest.substring(0, braceIndex);
    const body = extractBlockBody(rest.substring(braceIndex));
    if (/=>\s*$/.test(preceding) || /\bfunction\b[^{]*$/.test(preceding)) {
      return body;
    }
    rest = rest.substring(braceIndex + Math.max(body.length, 1));
  }
  return "";
}

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

/* ------------------------------------------------------------------ *
 * Resolved-path recognition (#956)
 *
 * The two collectors above are purely textual: they recognize a spawn as
 * production only when the source contains a contiguous `dist/`, `hooks/*.sh`
 * or `scripts/**` substring. Two idiomatic path constructions defeat that and
 * produced 62 of the 132 advisory flags measured across the repo:
 *
 *   const CLI  = path.resolve(__dirname, "tautology-detector-cli.ts");
 *   const HOOK = join(REPO_ROOT, "hooks", "pre-tool.sh");
 *
 * The first hides the location in `__dirname` (a runtime global); the second
 * splits the token across separate string literals. Neither leaves a
 * contiguous marker to match. Rather than pattern-matching ever more literal
 * tokens, this section *resolves* such expressions to an absolute path and
 * asks whether that path names executable code inside the repository.
 * ------------------------------------------------------------------ */

/**
 * Extensions denoting *executable* code rather than data. A resolved
 * repo-internal path counts as production only when it names something the
 * project can actually run.
 *
 * This gate is load-bearing, not cosmetic. Without it "any repo-internal
 * path" would excuse a test that merely spawns `git` with
 * `{ cwd: SOME_REPO_DIR }` — a genuine tautology the widened heuristic would
 * otherwise swallow. Widening the exemption is the main risk this change
 * carries, so it is bounded twice: by this pattern and by
 * {@link VENDOR_PATH_PATTERN}.
 */
const EXECUTABLE_PATH_PATTERN = /\.(?:[cm]?[jt]sx?|sh|bash)$/;

/** Dependency trees: inside the repo on disk, but not this project's code. */
const VENDOR_PATH_PATTERN = /(?:^|[\\/])node_modules[\\/]/;

/**
 * `__dirname` and its two idiomatic ESM equivalents. All three denote the
 * directory of the file being analyzed, which `analyzeTestFile` already knows
 * from `filePath` — so a path built from one is statically resolvable even
 * though the token itself is a runtime value.
 */
const THIS_DIR_EXPRESSIONS = [
  /^__dirname$/,
  /^(?:[\w$]+\s*\.\s*)?fileURLToPath\s*\(\s*new\s+URL\s*\(\s*(['"`])\.\/?\1\s*,\s*import\s*\.\s*meta\s*\.\s*url\s*\)\s*\)$/,
  /^(?:[\w$]+\s*\.\s*)?dirname\s*\(\s*(?:[\w$]+\s*\.\s*)?fileURLToPath\s*\(\s*import\s*\.\s*meta\s*\.\s*url\s*\)\s*\)$/,
];

/** A `resolve(...)` / `join(...)` call, optionally namespaced (`path.join`). */
const PATH_CALL_PATTERN = /(?:[\w$]+\s*\.\s*)?\b(?:resolve|join)\s*\(/g;

/** Guard against pathological nesting while resolving an expression. */
const MAX_PATH_RESOLUTION_DEPTH = 8;

/**
 * Everything needed to resolve a path expression found in a test file.
 *
 * Exported because {@link testBlockCallsProductionCode} accepts one; build it
 * with {@link buildPathContext} rather than by hand.
 */
export interface PathContext {
  /** Directory of the analyzed file — what `__dirname` denotes there. */
  thisDir: string;
  /** Repo root, or null when undeterminable (path resolution then off). */
  repoRoot: string | null;
  /** Declared variable name → the absolute path it resolves to. */
  vars: Map<string, string>;
}

/**
 * Nearest ancestor of `startDir` holding `.git` (a directory in a normal
 * clone, a *file* in a worktree — hence `existsSync`, not `isDirectory`),
 * falling back to the nearest `package.json`.
 *
 * Deliberately derived from the analyzed file's own path rather than
 * `process.cwd()`, so a caller's working directory cannot change the verdict.
 */
function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  let packageRoot: string | null = null;
  for (let i = 0; i < 64; i++) {
    if (existsSync(nodePath.join(dir, ".git"))) {
      return dir;
    }
    if (!packageRoot && existsSync(nodePath.join(dir, "package.json"))) {
      packageRoot = dir;
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return packageRoot;
}

/**
 * Inner text of the parenthesized group opening at `openIndex`, or null if
 * unbalanced. String contents are skipped so a paren inside a literal (test
 * titles routinely contain them) does not throw off the depth count.
 */
function readBalancedParens(text: string, openIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inString) {
      if (char === stringChar) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = true;
      stringChar = char;
      continue;
    }
    if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth === 0) return text.substring(openIndex + 1, i);
    }
  }
  return null;
}

/**
 * Split an argument list on its top-level commas, ignoring commas nested in
 * brackets or string literals. Returns null if the text is unbalanced.
 */
function splitTopLevelArgs(text: string): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inString) {
      if (char === stringChar) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = true;
      stringChar = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth++;
    } else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth < 0) return null;
    } else if (char === "," && depth === 0) {
      args.push(text.substring(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || inString) return null;
  const tail = text.substring(start);
  if (tail.trim() || args.length > 0) args.push(tail);
  return args;
}

/**
 * Resolve a path expression to an absolute path, or null when any part of it
 * is not statically knowable.
 *
 * Handles string literals, `__dirname` (and ESM equivalents), already-resolved
 * variable names, and nested `resolve`/`join` calls. Anything else — a
 * `mkdtempSync(...)` sandbox, `process.env.X`, a template literal with an
 * interpolation — resolves to null, which is what keeps temp-directory paths
 * from being mistaken for repo code.
 */
function resolvePathExpression(
  expr: string,
  ctx: PathContext,
  depth = 0,
): string | null {
  if (depth > MAX_PATH_RESOLUTION_DEPTH) return null;
  const trimmed = expr.trim();
  if (!trimmed) return null;

  if (THIS_DIR_EXPRESSIONS.some((pattern) => pattern.test(trimmed))) {
    return ctx.thisDir;
  }

  // A plain string literal — no escapes, and no `${}` interpolation.
  const literal = trimmed.match(/^(['"`])((?:(?!\1)[^\\])*)\1$/);
  if (literal) {
    return literal[1] === "`" && literal[2].includes("${") ? null : literal[2];
  }

  if (/^[\w$]+$/.test(trimmed)) {
    return ctx.vars.get(trimmed) ?? null;
  }

  const head = trimmed.match(/^(?:[\w$]+\s*\.\s*)?\b(resolve|join)\s*\(/);
  if (!head) return null;
  const openIndex = head[0].length - 1;
  const inner = readBalancedParens(trimmed, openIndex);
  // The call must span the whole expression; a trailing `.replace(...)` or
  // similar means the value is not the path we resolved.
  if (inner === null || openIndex + inner.length + 2 !== trimmed.length) {
    return null;
  }
  const args = splitTopLevelArgs(inner);
  if (!args || args.length === 0) return null;

  const parts: string[] = [];
  for (const arg of args) {
    const resolved = resolvePathExpression(arg, ctx, depth + 1);
    if (resolved === null) return null;
    parts.push(resolved);
  }
  // Require an absolute anchor: otherwise `path.resolve` would silently fall
  // back to `process.cwd()`, making the verdict depend on the caller's shell.
  if (!nodePath.isAbsolute(parts[0])) return null;

  return head[1] === "join"
    ? nodePath.join(...parts)
    : nodePath.resolve(...parts);
}

/**
 * Whether an absolute path names executable code this repository ships.
 */
function isProductionPath(absolutePath: string, ctx: PathContext): boolean {
  if (!ctx.repoRoot) return false;
  const rel = nodePath.relative(ctx.repoRoot, absolutePath);
  if (!rel || rel.startsWith("..") || nodePath.isAbsolute(rel)) return false;
  if (VENDOR_PATH_PATTERN.test(rel)) return false;
  return EXECUTABLE_PATH_PATTERN.test(rel);
}

/**
 * Whether `text` contains a path-construction call resolving to production
 * code — the inline counterpart of {@link collectResolvedPathVars}, for
 * spawns that build their path in place rather than via a named handle.
 */
function containsProductionPath(
  text: string,
  ctx: PathContext | null,
): boolean {
  if (!ctx || !ctx.repoRoot) return false;
  PATH_CALL_PATTERN.lastIndex = 0;
  let match;
  while ((match = PATH_CALL_PATTERN.exec(text)) !== null) {
    const openIndex = match.index + match[0].length - 1;
    const inner = readBalancedParens(text, openIndex);
    if (inner === null) continue;
    const call = text.substring(match.index, openIndex + inner.length + 2);
    const resolved = resolvePathExpression(call, ctx);
    if (resolved !== null && isProductionPath(resolved, ctx)) {
      PATH_CALL_PATTERN.lastIndex = 0;
      return true;
    }
  }
  return false;
}

/**
 * Build the resolution context for a file: locate the repo root, then resolve
 * every `const NAME = <path expression>` declaration to a fixpoint so that
 * chains chase through (`HERE → REPO_ROOT → HOOK`).
 *
 * Returns a context with `repoRoot: null` when the root cannot be located, in
 * which case every path-resolution check below is inert and the detector
 * behaves exactly as it did before this change.
 */
export function buildPathContext(filePath: string): PathContext {
  const thisDir = nodePath.dirname(nodePath.resolve(filePath));
  return { thisDir, repoRoot: findRepoRoot(thisDir), vars: new Map() };
}

/**
 * Statement-bounded variable declaration. The optional type annotation stops
 * at the first `=`, matching {@link collectBuildOutputVars}'s convention.
 */
const PATH_DECL_PATTERN =
  /(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]*)?=\s*([^;]+)/g;

/** Resolve declared path variables into `ctx.vars`, iterating to a fixpoint. */
function populatePathVars(content: string, ctx: PathContext): void {
  if (!ctx.repoRoot) return;
  for (let round = 0; round < MAX_PATH_RESOLUTION_DEPTH; round++) {
    let changed = false;
    PATH_DECL_PATTERN.lastIndex = 0;
    let match;
    while ((match = PATH_DECL_PATTERN.exec(content)) !== null) {
      const name = match[1];
      if (ctx.vars.has(name)) continue;
      const resolved = resolvePathExpression(match[2], ctx);
      if (resolved !== null) {
        ctx.vars.set(name, resolved);
        changed = true;
      }
    }
    if (!changed) break;
  }
}

/**
 * Names of variables whose declaration builds a path to this project's own
 * executable code — the resolved-path counterpart of
 * {@link collectBuildOutputVars}.
 *
 * The whole statement-bounded right-hand side is scanned, not just a
 * single-expression RHS, so a *table* of paths is collected too:
 *   const HOOK_PAIRS = [["label", join(REPO_ROOT, "hooks", "pre-tool.sh"), …]];
 * captures `HOOK_PAIRS`, which then feeds {@link collectDescribeEachParams}.
 */
function collectResolvedPathVars(content: string, ctx: PathContext): string[] {
  if (!ctx.repoRoot) return [];
  const names = new Set<string>();
  PATH_DECL_PATTERN.lastIndex = 0;
  let match;
  while ((match = PATH_DECL_PATTERN.exec(content)) !== null) {
    if (containsProductionPath(match[2], ctx)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

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
 *
 * An optional type annotation is allowed between the name and `=`, e.g.
 *   const HOOK_COPIES: Array<[label: string, path: string]> = [...];
 * The annotation submatch (`[^=;]*`) stops at the first `=`, so an arrow-
 * function-typed annotation (`const f: (x: string) => void = ...`) breaks
 * the match at its `=>` instead of reaching the real assignment — accepted
 * as a narrow miss; typed function-value declarations are not the shape this
 * collector targets (path-bearing table/tuple declarations are).
 */
function collectBuildOutputVars(content: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /(?:const|let|var)\s+(\w+)\s*(?::[^=;]*)?=\s*[^;]*?\bdist\//g,
    /(?:const|let|var)\s+(\w+)\s*(?::[^=;]*)?=\s*[^;]*?\b(?:hooks\/[\w.-]+\.sh|scripts\/[\w./-]+)/g,
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
 * Collect callback parameter names bound to a build-output table's rows via
 * `describe.each(X)("...", (a, b) => {...})`, when `X` is itself a
 * build-output source: a var already collected by collectBuildOutputVars, or
 * an inline array literal containing a build-output token directly.
 *
 * `describe.each` destructures each table row into positional callback
 * params. A helper spawning `hookPath` — the param, not the table var — is
 * exercising production code just as much as one spawning `HOOK_COPIES`
 * directly; static analysis of the table alone misses it entirely. The
 * string-title argument is matched by quote char (not `[^()]*`) because test
 * titles routinely contain literal parens (e.g. `"... (#564) [%s]"`), which
 * a paren-excluding class would truncate on.
 *
 * Bounded like the rest of this file's helper matchers: no nested parens in
 * the table-var/params captures, so a callback with a destructured or
 * default-valued param is skipped rather than mis-parsed.
 */
function collectDescribeEachParams(
  content: string,
  buildOutputVars: string[],
): string[] {
  const names = new Set<string>();
  const pattern =
    /describe\.each\(\s*([^()]*?)\s*\)\s*\(\s*(['"`])(?:(?!\2)[\s\S])*?\2\s*,\s*(?:async\s+)?\(([^()]*)\)\s*=>/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const tableArg = match[1].trim();
    const isKnownVar =
      /^\w+$/.test(tableArg) && buildOutputVars.includes(tableArg);
    const isInlineSource =
      BUILD_OUTPUT_PATTERN.test(tableArg) ||
      PROJECT_SCRIPT_PATTERN.test(tableArg);
    if (!isKnownVar && !isInlineSource) continue;

    for (const param of match[3].split(",")) {
      const name = param.trim().split(":")[0].trim();
      if (/^\w+$/.test(name)) {
        names.add(name);
      }
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
  pathContext: PathContext | null = null,
): boolean {
  if (BUILD_OUTPUT_PATTERN.test(body) || PROJECT_SCRIPT_PATTERN.test(body)) {
    return true;
  }
  if (buildOutputVars.some((name) => referenceMatcher(name).test(body))) {
    return true;
  }
  // Inline construction: `spawnSync("bash", [join(REPO_ROOT, "hooks", "x.sh")])`
  // never binds a name for the clause above to match (#956).
  return containsProductionPath(body, pathContext);
}

/**
 * Whether a code body itself spawns the build output: it must contain BOTH a
 * child-process spawn call AND a build-output token. Requiring co-occurrence
 * keeps a helper that merely mentions `dist/` in a string (but never spawns)
 * from counting as production (#885 AC-5).
 */
function spawnsBuildOutput(
  body: string,
  buildOutputVars: string[],
  pathContext: PathContext | null = null,
): boolean {
  return (
    SPAWN_PATTERN.test(body) &&
    referencesBuildOutput(body, buildOutputVars, pathContext)
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
 * running away across the file. The captured parameter list feeds
 * {@link collectHelperParamBindings}.
 *
 * Expression-bodied arrows are handled separately (#956): `const runInTemp =
 * (args) => runCli(args, {...});` has no brace body, so the brace-anchored
 * pass below cannot see it, and 9 blocks across two files read as tautological
 * purely because their only handle was written without braces.
 */
function extractHelperDefinitions(
  content: string,
): Array<{ name: string; params: string[]; body: string }> {
  const helpers: Array<{ name: string; params: string[]; body: string }> = [];

  // Arrow consts anchor on `=> {`, so the body brace is unambiguous.
  const arrowPattern =
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^()]*)\)\s*(?::[^=]*?)?=>\s*\{/g;
  let match;
  while ((match = arrowPattern.exec(content)) !== null) {
    if (isInsideString(content, match.index)) continue;
    const braceIndex = match.index + match[0].length - 1;
    helpers.push({
      name: match[1],
      params: parseParamNames(match[2]),
      body: extractBlockBody(content.substring(braceIndex)),
    });
  }

  // Expression-bodied arrows: no brace to anchor on, so the "body" is the rest
  // of the statement. Bounded to the next top-level `;` (or end of file) by
  // extractExpressionBody, mirroring the statement-bounded scans elsewhere.
  const exprArrowPattern =
    /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^()]*)\)\s*(?::[^=]*?)?=>\s*(?!\{)/g;
  while ((match = exprArrowPattern.exec(content)) !== null) {
    if (isInsideString(content, match.index)) continue;
    helpers.push({
      name: match[1],
      params: parseParamNames(match[2]),
      body: extractExpressionBody(
        content.substring(match.index + match[0].length),
      ),
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
    // The return-type group may close a generic before the body opens:
    //   async function spawnRunLike(): Promise<{ pid: number }> { ... }
    // so `>` and `[]` are skipped alongside whitespace (#956). Without this
    // the "body" stayed the return type and the helper never registered as
    // reaching production.
    if (/^[\s>[\]]*\{/.test(after)) {
      body = extractBlockBody(after);
    }
    helpers.push({ name: match[1], params: parseParamNames(match[0]), body });
  }
  return helpers;
}

/**
 * Parameter names from a parameter-list source fragment, stripped of type
 * annotations, default values and destructuring. A parameter that is not a
 * plain identifier yields "" so positional indexes stay aligned with the
 * call-site arguments {@link collectHelperParamBindings} matches against.
 */
function parseParamNames(paramSource: string): string[] {
  const open = paramSource.indexOf("(");
  const inner =
    open === -1
      ? paramSource
      : (readBalancedParens(paramSource, open) ?? paramSource);
  if (!inner.trim()) return [];
  return inner.split(",").map((param) => {
    const name = param.trim().split(/[:=]/)[0].trim();
    return /^[\w$]+$/.test(name) ? name : "";
  });
}

/**
 * Text of an expression-bodied arrow function: everything up to the next
 * top-level `;`, ignoring brackets and string literals.
 */
function extractExpressionBody(text: string): string {
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inString) {
      if (char === stringChar) inString = false;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = true;
      stringChar = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      depth--;
      if (depth < 0) return text.substring(0, i);
    } else if (char === ";" && depth === 0) {
      return text.substring(0, i);
    }
  }
  return text;
}

/**
 * Bind build-output values into helper *parameters* across a call site.
 *
 * `describe.each(HOOK_PAIRS)` yields callback params `preHook`/`postHook`,
 * but the helper that actually spawns them declares its own parameter as
 * `hook` — so the name-text match that {@link collectDescribeEachParams}
 * relies on has no bridge, and `run(preHook, "git status")` was invisible
 * (#956 / the #966 remainder). Given a call `H(a, b)` where argument *N* is a
 * known build-output name, this adds `H`'s parameter *N* to the set.
 */
function collectHelperParamBindings(
  content: string,
  helpers: Array<{ name: string; params: string[]; body: string }>,
  buildOutputVars: string[],
): string[] {
  const names = new Set<string>();
  const known = new Set(buildOutputVars);
  for (const helper of helpers) {
    if (helper.params.length === 0) continue;
    const callPattern = new RegExp(
      `(?<![\\w$.])${escapeRegex(helper.name)}\\s*\\(`,
      "g",
    );
    let call;
    while ((call = callPattern.exec(content)) !== null) {
      const openIndex = call.index + call[0].length - 1;
      const inner = readBalancedParens(content, openIndex);
      if (inner === null) continue;
      const args = splitTopLevelArgs(inner);
      if (!args) continue;
      args.forEach((arg, index) => {
        const trimmed = arg.trim();
        const paramName = helper.params[index];
        if (paramName && /^[\w$]+$/.test(trimmed) && known.has(trimmed)) {
          names.add(paramName);
        }
      });
    }
  }
  return [...names];
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
/**
 * Lifecycle hooks that run before a test block's own body does.
 */
const LIFECYCLE_HOOK_PATTERN = /\b(?:beforeEach|beforeAll)\s*\(/g;

/** `name = ...` / `name: Type = ...` assignments, statement-bounded. */
const HOOK_ASSIGNMENT_PATTERN = /(?:^|[;{)\n])\s*([\w$]+)\s*=\s*[^=]/g;

/**
 * Names assigned inside a lifecycle hook whose body reaches production (#956).
 *
 * A suite-scope handle is routinely *declared* bare (`let client;`) and only
 * *assigned* in `beforeEach`. Neither {@link collectBuildOutputVars} (which
 * needs a path-bearing right-hand side) nor {@link extractHelperDefinitions}
 * (which needs a function body) can see that shape, so every block driving the
 * handle reads as tautological. This was the last residual class in the #956
 * corpus: `src/mcp/server-extended.test.ts` imports `createServer` from
 * `./server.js` inside `beforeEach`, connects the real server over an
 * in-memory transport, assigns the connected client to an outer `client`, and
 * then exercises production in all 21 blocks via `client.callTool(...)`.
 *
 * The hook body itself is the gate: assignments become handles only when the
 * hook reaches production. A hook that merely does
 * `tempDir = mkdtempSync(...)` registers nothing, which is what keeps
 * file-content gate tests — the ones that stage a fixture and then assert on
 * text — correctly flagged.
 */
function collectHookAssignedHandles(
  content: string,
  buildOutputVars: string[],
  importedFunctions: ImportedFunction[],
  knownHandles: string[],
  pathContext: PathContext | null,
): string[] {
  const names = new Set<string>();
  LIFECYCLE_HOOK_PATTERN.lastIndex = 0;
  let hook;
  while ((hook = LIFECYCLE_HOOK_PATTERN.exec(content)) !== null) {
    if (isInsideString(content, hook.index)) continue;
    const body = extractTestCallbackBody(content.substring(hook.index));
    if (!body) continue;

    const reachesProduction =
      spawnsBuildOutput(body, buildOutputVars, pathContext) ||
      importedFunctions.some((fn) => referenceMatcher(fn.name).test(body)) ||
      knownHandles.some((handle) => referenceMatcher(handle).test(body));
    if (!reachesProduction) continue;

    HOOK_ASSIGNMENT_PATTERN.lastIndex = 0;
    let assign;
    while ((assign = HOOK_ASSIGNMENT_PATTERN.exec(body)) !== null) {
      names.add(assign[1]);
    }
  }
  return [...names];
}

function collectProductionHandles(
  content: string,
  buildOutputVars: string[],
  importedFunctions: ImportedFunction[] = [],
  helpers: Array<{
    name: string;
    params: string[];
    body: string;
  }> = extractHelperDefinitions(content),
  pathContext: PathContext | null = null,
): string[] {
  const handles = new Set<string>();

  // Seed: helpers that directly reach production.
  for (const helper of helpers) {
    if (
      spawnsBuildOutput(helper.body, buildOutputVars, pathContext) ||
      importedFunctions.some((fn) =>
        referenceMatcher(fn.name).test(helper.body),
      )
    ) {
      handles.add(helper.name);
    }
  }

  // Suite-scope handles assigned by a production-reaching lifecycle hook
  // (#956). Seeded before the closure so a helper wrapping such a handle is
  // promoted by it in the same pass.
  for (const name of collectHookAssignedHandles(
    content,
    buildOutputVars,
    importedFunctions,
    [...handles],
    pathContext,
  )) {
    handles.add(name);
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
  pathContext: PathContext | null = null,
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
  if (spawnsBuildOutput(body, buildOutputVars, pathContext)) {
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
    const pathContext = buildPathContext(filePath);
    populatePathVars(content, pathContext);
    const helpers = extractHelperDefinitions(content);

    // Widen the build-output set to a fixpoint: a describe.each table row can
    // bind a callback param, which a call site can then bind into a helper
    // parameter, which may itself feed another table — one pass is not enough.
    let buildOutputVars = [
      ...new Set([
        ...collectBuildOutputVars(content),
        ...collectResolvedPathVars(content, pathContext),
      ]),
    ];
    for (let round = 0; round < MAX_PATH_RESOLUTION_DEPTH; round++) {
      const widened = new Set(buildOutputVars);
      for (const name of collectDescribeEachParams(content, buildOutputVars)) {
        widened.add(name);
      }
      for (const name of collectHelperParamBindings(
        content,
        helpers,
        buildOutputVars,
      )) {
        widened.add(name);
      }
      if (widened.size === buildOutputVars.length) break;
      buildOutputVars = [...widened];
    }

    const productionHandles = collectProductionHandles(
      content,
      buildOutputVars,
      importedFunctions,
      helpers,
      pathContext,
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
        pathContext,
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
