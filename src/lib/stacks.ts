/**
 * Stack detection and configuration
 */

import { fileExists, readFile } from "./fs.js";

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

export function getStackConfig(stack: string): StackConfig {
  return STACKS[stack] || STACKS.generic;
}
