# Conventions Command

**Quick Start:** View, detect, or reset codebase conventions that guide code generation style. Conventions are auto-detected during `sequant init` and stored in `.sequant/conventions.json`.

## Access

- **Command:** `sequant conventions [options]`

## Subcommands

### `sequant conventions` (default)

Display current conventions (detected + manual overrides).

```bash
sequant conventions
```

**Output:**

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

Edit .sequant/conventions.json to add manual overrides.
```

If no conventions file exists, prompts to run detection.

### `sequant conventions --detect`

Re-run convention detection. Scans source files and updates the `detected` section while preserving any `manual` overrides.

```bash
sequant conventions --detect
```

Use this after significant codebase changes (e.g., migrating from Jest to Vitest, switching to tabs).

### `sequant conventions --reset`

Clear all detected conventions. Manual overrides in the `manual` section are preserved.

```bash
sequant conventions --reset
```

## Options

| Flag | Description |
|------|-------------|
| `--detect` | Re-run convention detection and save results |
| `--reset` | Clear detected conventions, keep manual overrides |
| `-h, --help` | Display help |

## Detected Conventions

| Key | What It Detects | Example Values |
|-----|-----------------|----------------|
| `testFilePattern` | Test file naming convention | `*.test.ts`, `*.spec.ts`, `__tests__/` |
| `exportStyle` | Named vs default exports | `named`, `default`, `mixed` |
| `asyncPattern` | Async/await vs promise chains | `async/await`, `promise-chains`, `mixed` |
| `typescriptStrict` | TypeScript strict mode | `enabled`, `disabled` |
| `sourceStructure` | Source directory layout | `src/`, `src/, app/` |
| `packageManager` | Package manager from lockfile | `npm`, `yarn`, `pnpm`, `bun` |
| `indentation` | Indentation style | `2 spaces`, `4 spaces`, `tabs` |
| `semicolons` | Semicolon usage | `required`, `omitted`, `mixed` |
| `componentDir` | Component directory location | `src/components/`, `components/` |

## File Format

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

- **`detected`** — Auto-populated by detection scan
- **`manual`** — User-edited overrides (always take precedence)
- **`detectedAt`** — Timestamp of last detection run

## Related

- [Codebase Conventions Feature Guide](../features/codebase-conventions.md)
- [`sequant init`](../getting-started/) — Runs detection automatically
