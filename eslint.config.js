import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='require']",
          message: "Use ES module imports instead of require() in ESM modules",
        },
      ],
      // Temporarily relaxed rules for gradual adoption
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "prefer-const": "warn",
    },
  },
  // #647 AC-3: forbid raw stdout writes in `phase-executor.ts`. Every
  // message emitted from this file fires while the renderer's live zone
  // may be active; raw `console.log` / `process.stdout.write` advance
  // the cursor without log-update's knowledge, so the next
  // `eraseLines(previousLineCount)` undershoots and strands the prior
  // frame's top row in scrollback as a duplicate header. Route through
  // `bracketedConsoleLog` (src/lib/workflow/notice.ts) instead, which
  // clears the live zone via `PhasePauseHandle.appendNotice` and falls
  // back to plain `console.log` when no handle is present.
  //
  // Scope intentionally narrow to phase-executor.ts. `run-orchestrator.ts`
  // also imports `bracketedConsoleLog` for its two batch-boundary sites,
  // but the rest of its `console.log` calls are pre-flight (before any
  // issue is registered with the renderer) or post-dispose (after
  // `renderSummary`), where the live zone is empty and `console.log` is
  // correct. Forcing the rule there would require ~10 eslint-disable
  // comments for zero real catches.
  {
    files: ["src/lib/workflow/phase-executor.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='require']",
          message: "Use ES module imports instead of require() in ESM modules",
        },
        {
          selector:
            "CallExpression[callee.object.name='console'][callee.property.name=/^(log|info|warn|error)$/]",
          message:
            "Don't use console.* in renderer-window files — it strands duplicate headers in scrollback (#647). Use `bracketedConsoleLog(spinner, msg)` from ./notice.js instead.",
        },
        {
          selector:
            "CallExpression[callee.object.object.name='process'][callee.object.property.name=/^(stdout|stderr)$/][callee.property.name='write']",
          message:
            "Don't write to process.stdout/stderr in renderer-window files — it strands duplicate headers in scrollback (#647). Use `bracketedConsoleLog(spinner, msg)` from ./notice.js instead.",
        },
      ],
    },
  },
  {
    ignores: [
      "dist/",
      "node_modules/",
      "templates/",
      "**/*.js",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.d.ts",
    ],
  },
);
