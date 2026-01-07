/**
 * Stack detection and configuration
 */

import { fileExists, readFile } from "./fs.js";

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
  },
};

export async function detectStack(): Promise<string | null> {
  // Check for Next.js
  for (const file of STACKS.nextjs.detection.files || []) {
    if (await fileExists(file)) {
      return "nextjs";
    }
  }

  // Check package.json for Next.js dependency
  if (await fileExists("package.json")) {
    try {
      const pkg = JSON.parse(await readFile("package.json"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) {
        return "nextjs";
      }
    } catch {
      // Ignore parse errors
    }
  }

  // Check for Astro
  for (const file of STACKS.astro.detection.files || []) {
    if (await fileExists(file)) {
      return "astro";
    }
  }

  // Check package.json for Astro dependency
  if (await fileExists("package.json")) {
    try {
      const pkg = JSON.parse(await readFile("package.json"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.astro) {
        return "astro";
      }
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
