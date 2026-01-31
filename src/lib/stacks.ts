/**
 * Stack detection and configuration
 */

import { readdir } from "fs/promises";
import { fileExists, readFile } from "./fs.js";

/**
 * Detected stack with location information
 */
export interface DetectedStack {
  /** Stack name (e.g., "nextjs", "python") */
  stack: string;
  /** Path relative to project root (empty string for root) */
  path: string;
}

/**
 * Stack configuration for persistence in .sequant/stack.json
 */
export interface StackConfig_Persisted {
  /** Primary stack for the project (determines dev URL, commands) */
  primary: {
    name: string;
    path?: string;
  };
  /** Additional stacks to include in constitution notes */
  additional?: Array<{
    name: string;
    path?: string;
  }>;
}

/**
 * Directories to skip during multi-stack detection
 */
const SKIP_DIRECTORIES = [
  "node_modules",
  ".git",
  "vendor",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".output",
  "__pycache__",
  "target",
  ".claude",
  ".sequant",
];

/**
 * Supported package managers
 */
export type PackageManager = "npm" | "bun" | "yarn" | "pnpm";

/**
 * Package manager command configuration
 */
export interface PackageManagerConfig {
  run: string; // e.g., "npm run", "bun run", "yarn"
  exec: string; // e.g., "npx", "bunx", "yarn dlx"
  install: string; // e.g., "npm install", "bun install"
  installSilent: string; // e.g., "npm install --silent", "bun install --silent"
}

/**
 * Package manager configurations
 */
export const PM_CONFIG: Record<PackageManager, PackageManagerConfig> = {
  npm: {
    run: "npm run",
    exec: "npx",
    install: "npm install",
    installSilent: "npm install --silent",
  },
  bun: {
    run: "bun run",
    exec: "bunx",
    install: "bun install",
    installSilent: "bun install --silent",
  },
  yarn: {
    run: "yarn",
    exec: "yarn dlx",
    install: "yarn install",
    installSilent: "yarn install --silent",
  },
  pnpm: {
    run: "pnpm run",
    exec: "pnpm dlx",
    install: "pnpm install",
    installSilent: "pnpm install --silent",
  },
};

/**
 * Lockfile to package manager mapping (priority order: bun > yarn > pnpm > npm)
 */
const LOCKFILE_PRIORITY: Array<{ file: string; pm: PackageManager }> = [
  { file: "bun.lockb", pm: "bun" },
  { file: "bun.lock", pm: "bun" },
  { file: "yarn.lock", pm: "yarn" },
  { file: "pnpm-lock.yaml", pm: "pnpm" },
  { file: "package-lock.json", pm: "npm" },
];

/**
 * Detect package manager from lockfiles
 * Priority: bun > yarn > pnpm > npm
 * Falls back to npm if no lockfile found but package.json exists
 */
export async function detectPackageManager(): Promise<PackageManager | null> {
  // Check lockfiles in priority order
  for (const { file, pm } of LOCKFILE_PRIORITY) {
    if (await fileExists(file)) {
      return pm;
    }
  }

  // Fallback to npm if package.json exists
  if (await fileExists("package.json")) {
    return "npm";
  }

  // Not a Node.js project
  return null;
}

/**
 * Get package manager command configuration
 */
export function getPackageManagerCommands(
  pm: PackageManager,
): PackageManagerConfig {
  return PM_CONFIG[pm];
}

export interface StackConfig {
  name: string;
  displayName: string;
  detection: {
    files?: string[];
    packageDeps?: string[];
  };
  commands: {
    test: string;
    build: string;
    lint: string;
    dev?: string;
  };
  variables: Record<string, string>;
  devUrl: string;
}

export const STACKS: Record<string, StackConfig> = {
  nextjs: {
    name: "nextjs",
    displayName: "Next.js",
    detection: {
      files: ["next.config.js", "next.config.mjs", "next.config.ts"],
      packageDeps: ["next"],
    },
    commands: {
      test: "npm test",
      build: "npm run build",
      lint: "npm run lint",
      dev: "npm run dev",
    },
    variables: {
      TEST_COMMAND: "npm test",
      BUILD_COMMAND: "npm run build",
      LINT_COMMAND: "npm run lint",
    },
    devUrl: "http://localhost:3000",
  },
  rust: {
    name: "rust",
    displayName: "Rust",
    detection: {
      files: ["Cargo.toml"],
    },
    commands: {
      test: "cargo test",
      build: "cargo build --release",
      lint: "cargo clippy",
    },
    variables: {
      TEST_COMMAND: "cargo test",
      BUILD_COMMAND: "cargo build --release",
      LINT_COMMAND: "cargo clippy",
    },
    devUrl: "http://localhost:8080",
  },
  python: {
    name: "python",
    displayName: "Python",
    detection: {
      files: ["pyproject.toml", "setup.py", "requirements.txt"],
    },
    commands: {
      test: "pytest",
      build: "python -m build",
      lint: "ruff check .",
    },
    variables: {
      TEST_COMMAND: "pytest",
      BUILD_COMMAND: "python -m build",
      LINT_COMMAND: "ruff check .",
    },
    devUrl: "http://localhost:5000",
  },
  go: {
    name: "go",
    displayName: "Go",
    detection: {
      files: ["go.mod"],
    },
    commands: {
      test: "go test ./...",
      build: "go build ./...",
      lint: "golangci-lint run",
    },
    variables: {
      TEST_COMMAND: "go test ./...",
      BUILD_COMMAND: "go build ./...",
      LINT_COMMAND: "golangci-lint run",
    },
    devUrl: "http://localhost:8080",
  },
  astro: {
    name: "astro",
    displayName: "Astro",
    detection: {
      files: ["astro.config.mjs", "astro.config.js", "astro.config.ts"],
      packageDeps: ["astro"],
    },
    commands: {
      // Note: Astro projects may not have test/lint configured by default
      test: "npm test",
      build: "npm run build",
      lint: "npm run lint",
      dev: "npm run dev",
    },
    variables: {
      TEST_COMMAND: "npm test",
      BUILD_COMMAND: "npm run build",
      LINT_COMMAND: "npm run lint",
    },
    devUrl: "http://localhost:4321",
  },
  sveltekit: {
    name: "sveltekit",
    displayName: "SvelteKit",
    detection: {
      files: ["svelte.config.js", "svelte.config.ts"],
      packageDeps: ["@sveltejs/kit"],
    },
    commands: {
      test: "npm test",
      build: "npm run build",
      lint: "npm run lint",
      dev: "npm run dev",
    },
    variables: {
      TEST_COMMAND: "npm test",
      BUILD_COMMAND: "npm run build",
      LINT_COMMAND: "npm run lint",
    },
    devUrl: "http://localhost:5173",
  },
  remix: {
    name: "remix",
    displayName: "Remix",
    detection: {
      files: ["remix.config.js", "remix.config.ts"],
      packageDeps: ["@remix-run/react"],
    },
    commands: {
      test: "npm test",
      build: "npm run build",
      lint: "npm run lint",
      dev: "npm run dev",
    },
    variables: {
      TEST_COMMAND: "npm test",
      BUILD_COMMAND: "npm run build",
      LINT_COMMAND: "npm run lint",
    },
    devUrl: "http://localhost:5173",
  },
  nuxt: {
    name: "nuxt",
    displayName: "Nuxt",
    detection: {
      files: ["nuxt.config.ts", "nuxt.config.js"],
      packageDeps: ["nuxt"],
    },
    commands: {
      test: "npm test",
      build: "npm run build",
      lint: "npm run lint",
      dev: "npm run dev",
    },
    variables: {
      TEST_COMMAND: "npm test",
      BUILD_COMMAND: "npm run build",
      LINT_COMMAND: "npm run lint",
    },
    devUrl: "http://localhost:3000",
  },
  generic: {
    name: "generic",
    displayName: "Generic",
    detection: {},
    commands: {
      test: "echo 'No test command configured'",
      build: "echo 'No build command configured'",
      lint: "echo 'No lint command configured'",
    },
    variables: {
      TEST_COMMAND: "npm test",
      BUILD_COMMAND: "npm run build",
      LINT_COMMAND: "npm run lint",
    },
    devUrl: "http://localhost:3000",
  },
};

export async function detectStack(): Promise<string | null> {
  // Check for Next.js config files
  for (const file of STACKS.nextjs.detection.files || []) {
    if (await fileExists(file)) {
      return "nextjs";
    }
  }

  // Check for Astro config files
  for (const file of STACKS.astro.detection.files || []) {
    if (await fileExists(file)) {
      return "astro";
    }
  }

  // Check for SvelteKit config files
  for (const file of STACKS.sveltekit.detection.files || []) {
    if (await fileExists(file)) {
      return "sveltekit";
    }
  }

  // Check for Remix config files
  for (const file of STACKS.remix.detection.files || []) {
    if (await fileExists(file)) {
      return "remix";
    }
  }

  // Check for Nuxt config files
  for (const file of STACKS.nuxt.detection.files || []) {
    if (await fileExists(file)) {
      return "nuxt";
    }
  }

  // Check package.json for all JS framework dependencies (read once)
  // Priority order: Next.js > Astro > SvelteKit > Remix > Nuxt
  if (await fileExists("package.json")) {
    try {
      const pkg = JSON.parse(await readFile("package.json"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) return "nextjs";
      if (deps.astro) return "astro";
      if (deps["@sveltejs/kit"]) return "sveltekit";
      if (deps["@remix-run/react"]) return "remix";
      if (deps.nuxt) return "nuxt";
    } catch {
      // Ignore parse errors
    }
  }

  // Check for Rust
  if (await fileExists("Cargo.toml")) {
    return "rust";
  }

  // Check for Go
  if (await fileExists("go.mod")) {
    return "go";
  }

  // Check for Python
  for (const file of STACKS.python.detection.files || []) {
    if (await fileExists(file)) {
      return "python";
    }
  }

  return null;
}

/**
 * Detect stack in a specific directory
 * Similar to detectStack but operates on a given path
 *
 * @param basePath - Directory path to check (relative to cwd)
 * @returns Stack name or null if not detected
 */
export async function detectStackInDirectory(
  basePath: string,
): Promise<string | null> {
  const pathPrefix = basePath ? `${basePath}/` : "";

  // Check for Next.js config files
  for (const file of STACKS.nextjs.detection.files || []) {
    if (await fileExists(`${pathPrefix}${file}`)) {
      return "nextjs";
    }
  }

  // Check for Astro config files
  for (const file of STACKS.astro.detection.files || []) {
    if (await fileExists(`${pathPrefix}${file}`)) {
      return "astro";
    }
  }

  // Check for SvelteKit config files
  for (const file of STACKS.sveltekit.detection.files || []) {
    if (await fileExists(`${pathPrefix}${file}`)) {
      return "sveltekit";
    }
  }

  // Check for Remix config files
  for (const file of STACKS.remix.detection.files || []) {
    if (await fileExists(`${pathPrefix}${file}`)) {
      return "remix";
    }
  }

  // Check for Nuxt config files
  for (const file of STACKS.nuxt.detection.files || []) {
    if (await fileExists(`${pathPrefix}${file}`)) {
      return "nuxt";
    }
  }

  // Check package.json for JS framework dependencies
  const packageJsonPath = `${pathPrefix}package.json`;
  if (await fileExists(packageJsonPath)) {
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) return "nextjs";
      if (deps.astro) return "astro";
      if (deps["@sveltejs/kit"]) return "sveltekit";
      if (deps["@remix-run/react"]) return "remix";
      if (deps.nuxt) return "nuxt";
    } catch {
      // Ignore parse errors
    }
  }

  // Check for Rust
  if (await fileExists(`${pathPrefix}Cargo.toml`)) {
    return "rust";
  }

  // Check for Go
  if (await fileExists(`${pathPrefix}go.mod`)) {
    return "go";
  }

  // Check for Python
  for (const file of STACKS.python.detection.files || []) {
    if (await fileExists(`${pathPrefix}${file}`)) {
      return "python";
    }
  }

  return null;
}

/**
 * Detect all stacks in the repository
 *
 * Traverses root and immediate subdirectories (1 level deep) to find
 * all stacks present in a monorepo or multi-stack project.
 *
 * @returns Array of detected stacks with their paths
 */
export async function detectAllStacks(): Promise<DetectedStack[]> {
  const results: DetectedStack[] = [];

  // Check root directory
  const rootStack = await detectStackInDirectory("");
  if (rootStack) {
    results.push({ stack: rootStack, path: "" });
  }

  // Check immediate subdirectories (1 level deep)
  try {
    const entries = await readdir(".", { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRECTORIES.includes(entry.name)) continue;
      if (entry.name.startsWith(".")) continue; // Skip hidden directories

      const subdirStack = await detectStackInDirectory(entry.name);
      if (subdirStack) {
        // Skip if same stack as root (likely a false positive)
        // e.g., both root and /packages/web detect "nextjs"
        // We want distinct stacks, not duplicates
        const isDuplicate = results.some(
          (r) => r.stack === subdirStack && r.path === "",
        );

        // Only skip if root has the same stack AND this is a common mono-repo pattern
        // (like packages/, apps/, etc.)
        if (
          !isDuplicate ||
          entry.name === "frontend" ||
          entry.name === "backend"
        ) {
          results.push({ stack: subdirStack, path: entry.name });
        }
      }
    }
  } catch {
    // Directory read failed, return what we have
  }

  return results;
}

export function getStackConfig(stack: string): StackConfig {
  return STACKS[stack] || STACKS.generic;
}

/**
 * Stack-specific notes for constitution templates
 *
 * These notes are injected into the constitution during setup to provide
 * context-aware guidance for AI-assisted development.
 */
export const STACK_NOTES: Record<string, string> = {
  nextjs: `### Next.js

**Testing:**
- Use Jest or Vitest with React Testing Library
- Place tests in \`__tests__/\` directories or as \`.test.ts(x)\` files
- Use \`next/jest\` preset for proper Next.js configuration
- Mock \`next/router\` and \`next/navigation\` in component tests

**Linting:**
- ESLint with \`eslint-config-next\` (included by default)
- Run \`npm run lint\` or \`next lint\`
- TypeScript strict mode recommended

**Build:**
- Output to \`.next/\` directory
- Use \`next build\` for production builds
- Static exports via \`output: 'export'\` in next.config.js`,

  astro: `### Astro

**Testing:**
- Astro projects may not have test scripts configured by default
- Consider adding Vitest: \`npm install -D vitest\`
- Use \`@astrojs/test-utils\` for component testing

**Linting:**
- Consider ESLint with \`eslint-plugin-astro\`
- Install: \`npm install -D eslint eslint-plugin-astro\`

**Build:**
- Output to \`dist/\` by default
- Use \`astro build\` for production
- SSR mode available via adapters`,

  sveltekit: `### SvelteKit

**Testing:**
- Use Vitest with \`@testing-library/svelte\`
- Playwright for E2E testing (often pre-configured)
- Place unit tests in \`src/\` alongside components

**Linting:**
- ESLint with \`eslint-plugin-svelte\`
- Prettier with \`prettier-plugin-svelte\`
- Run \`npm run lint\` and \`npm run check\`

**Build:**
- Output depends on adapter (node, static, vercel, etc.)
- Use \`svelte-kit build\` for production
- Type-check with \`svelte-kit sync && svelte-check\``,

  remix: `### Remix

**Testing:**
- Use Vitest or Jest with React Testing Library
- Cypress or Playwright for E2E testing
- Test loaders and actions separately from components

**Linting:**
- ESLint with React and TypeScript plugins
- Remix doesn't include ESLint config by default

**Build:**
- Output to \`build/\` directory
- Use \`remix build\` for production
- Server and client bundles are separate`,

  nuxt: `### Nuxt

**Testing:**
- Use Vitest with \`@nuxt/test-utils\`
- \`@vue/test-utils\` for component testing
- Playwright for E2E testing

**Linting:**
- ESLint with \`@nuxt/eslint-config\`
- Run \`npm run lint\` or \`nuxi lint\`

**Build:**
- Output to \`.output/\` directory
- Use \`nuxi build\` for production
- \`nuxi generate\` for static site generation`,

  rust: `### Rust

**Testing:**
- Unit tests: \`#[cfg(test)]\` modules in source files
- Integration tests: \`tests/\` directory
- Run \`cargo test\` for all tests
- Use \`#[should_panic]\` for panic tests

**Linting:**
- \`cargo clippy\` for lints (install: \`rustup component add clippy\`)
- \`cargo fmt\` for formatting
- Consider \`cargo deny\` for dependency auditing

**Build:**
- Debug: \`cargo build\`
- Release: \`cargo build --release\`
- Output to \`target/debug/\` or \`target/release/\``,

  python: `### Python

**Testing:**
- pytest is the standard test runner
- Place tests in \`tests/\` directory
- Use \`pytest-cov\` for coverage reports
- Fixtures in \`conftest.py\`

**Linting:**
- Ruff for fast linting and formatting: \`ruff check .\` and \`ruff format .\`
- Alternative: Black + isort + flake8
- mypy for type checking

**Build:**
- Use virtual environments (venv, poetry, pdm)
- \`python -m build\` for package builds
- \`pip install -e .\` for development installs`,

  go: `### Go

**Testing:**
- Tests in \`*_test.go\` files alongside source
- Run \`go test ./...\` for all packages
- Use \`-v\` for verbose output, \`-race\` for race detection
- Table-driven tests are idiomatic

**Linting:**
- \`golangci-lint run\` for comprehensive linting
- \`go vet\` for basic checks
- \`gofmt\` or \`goimports\` for formatting

**Build:**
- \`go build ./...\` to compile
- \`go install\` to build and install
- Cross-compile with GOOS/GOARCH environment variables`,

  generic: `### General Guidelines

**Testing:**
- Check for test scripts in package.json or equivalent
- Common patterns: \`npm test\`, \`pytest\`, \`go test\`, \`cargo test\`

**Linting:**
- Check for lint scripts or configuration files
- Common: ESLint, Prettier, Ruff, golangci-lint, clippy

**Build:**
- Check for build scripts and output directories
- Document build commands in README`,
};

/**
 * Get stack-specific notes for constitution template
 *
 * @param stack - The stack name (e.g., "nextjs", "python", "rust")
 * @returns The stack-specific notes markdown content
 */
export function getStackNotes(stack: string): string {
  return STACK_NOTES[stack] || STACK_NOTES.generic;
}

/**
 * Get combined stack notes for multiple stacks
 *
 * Combines notes from a primary stack and optional additional stacks
 * into a single markdown section for multi-stack projects.
 *
 * @param primary - Primary stack name (determines primary tooling)
 * @param additional - Additional stacks to include notes for
 * @returns Combined stack notes markdown content
 */
export function getMultiStackNotes(
  primary: string,
  additional: string[] = [],
): string {
  const sections: string[] = [];

  // Add primary stack notes (with "Primary" marker)
  const primaryNotes = STACK_NOTES[primary] || STACK_NOTES.generic;
  if (additional.length > 0) {
    // Replace the first line heading to include "(Primary)"
    const modifiedPrimary = primaryNotes.replace(
      /^### (.+)$/m,
      "### $1 (Primary)",
    );
    sections.push(modifiedPrimary);
  } else {
    sections.push(primaryNotes);
  }

  // Add additional stack notes
  for (const stack of additional) {
    if (stack === primary) continue; // Skip if same as primary
    const notes = STACK_NOTES[stack];
    if (notes && notes !== STACK_NOTES.generic) {
      sections.push(notes);
    }
  }

  return sections.join("\n\n---\n\n");
}
