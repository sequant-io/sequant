# Codebase Conventions Detection

**Quick Start:** Sequant detects your codebase's coding conventions during `sequant init` and stores them in `.sequant/conventions.json`. The `/exec` skill reads these conventions to generate code that matches your project's style — test naming, export patterns, indentation, and more.

## How It Works

During `sequant init`, Sequant scans your project files using deterministic pattern matching (no AI) and records what it finds. The detected conventions are then available to workflow skills like `/exec`, which reference them before generating code.

### Detected Conventions

| Convention | Detection Method | Example Values |
|------------|-----------------|----------------|
| `testFilePattern` | Count `*.test.*` vs `*.spec.*` vs `__tests__/` files | `*.test.ts`, `*.spec.ts`, `__tests__/` |
| `exportStyle` | Ratio of `export default` vs named exports | `named`, `default`, `mixed` |
| `asyncPattern` | Ratio of `await` vs `.then()` usage | `async/await`, `promise-chains`, `mixed` |
| `typescriptStrict` | Read `tsconfig.json` `compilerOptions.strict` | `enabled`, `disabled` |
| `sourceStructure` | Check for `src/`, `lib/`, `app/`, `pages/` dirs | `src/`, `src/, app/` |
| `packageManager` | Check for lockfiles (`package-lock.json`, etc.) | `npm`, `yarn`, `pnpm`, `bun` |
| `indentation` | Sample source files for leading whitespace | `2 spaces`, `4 spaces`, `tabs` |
| `semicolons` | Ratio of lines ending with `;` | `required`, `omitted`, `mixed` |
| `componentDir` | Check for `src/components/`, `components/`, etc. | `src/components/` |

## Usage

### Automatic Detection (During Init)

Conventions are detected automatically when initializing a project:

```bash
sequant init
```

You'll see output like:

```
✔ Detected 8 codebase conventions
```

### Viewing Conventions

To see what was detected:

```bash
sequant conventions
```

Example output:

```
Detected conventions:
  testFilePattern: *.test.ts
  exportStyle: named
  asyncPattern: async/await
  typescriptStrict: enabled
  sourceStructure: src/
  packageManager: npm
  indentation: 2 spaces
  semicolons: required

Last detected: 2026-03-13T20:23:03.899Z
```

### Re-Running Detection

If your codebase has changed significantly:

```bash
sequant conventions --detect
```

This re-scans the project and updates the `detected` section while preserving any manual overrides.

### Resetting Detected Conventions

To clear all detected values (keeping manual overrides):

```bash
sequant conventions --reset
```

## Manual Overrides

Edit `.sequant/conventions.json` directly to add or override conventions. Entries in the `manual` section always take precedence over detected values.

```json
{
  "detected": {
    "testFilePattern": "*.test.ts",
    "exportStyle": "named"
  },
  "manual": {
    "testFilePattern": "*.spec.ts",
    "prTitleFormat": "feat(#N): description"
  },
  "detectedAt": "2026-03-13T20:23:03.899Z"
}
```

In this example, `/exec` will use `*.spec.ts` for test files (manual override) but `named` for export style (detected value).

You can add any key-value pair to the `manual` section — it doesn't have to match a detected convention key.

## How Skills Use Conventions

The `/exec` skill reads `.sequant/conventions.json` before generating code:

- **Test files** are named according to `testFilePattern`
- **Exports** use `named` or `default` style per `exportStyle`
- **Async code** uses `async/await` or promise chains per `asyncPattern`
- **Indentation** and **semicolons** match detected preferences

Conventions are optional — if the file doesn't exist, skills proceed with their default behavior.

## Options & Settings

| Option | Description | Default |
|--------|-------------|---------|
| `--detect` | Re-run convention detection | Off |
| `--reset` | Clear detected conventions, keep manual | Off |

## Troubleshooting

### No conventions detected

**Symptoms:** `sequant conventions` shows "No conventions detected yet."

**Solution:** Run `sequant conventions --detect` or `sequant init` to trigger detection. Detection requires source files in the project directory.

### Wrong convention detected

**Symptoms:** A detected value doesn't match your team's actual preference.

**Solution:** Add a manual override in `.sequant/conventions.json`:

```json
{
  "manual": {
    "exportStyle": "default"
  }
}
```

Manual entries always take precedence over detected values. Re-running detection will not overwrite your manual section.

### Conventions not affecting generated code

**Symptoms:** `/exec` generates code that doesn't follow conventions.

**Solution:** Verify the file exists and is readable:

```bash
cat .sequant/conventions.json
```

If the file is missing, run `sequant conventions --detect`. Note that conventions are advisory — they guide code generation but don't enforce rules (use ESLint/Prettier for enforcement).

---

*Generated for Issue #233 on 2026-03-13*
