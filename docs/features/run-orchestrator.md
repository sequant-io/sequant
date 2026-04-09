# RunOrchestrator — Programmatic Workflow Execution

Use `RunOrchestrator` to run sequant workflows from Node.js code without going through the CLI. This is the foundation for MCP server integration, SDK consumers, CI scripts, and custom tooling.

## Prerequisites

1. **sequant initialized** — `sequant init` completed in the project
2. **GitHub CLI** — `gh auth status` shows authenticated (used for issue fetching)
3. **Node.js 20+** — `node --version`

## Setup

Install sequant as a dependency:

```bash
npm install sequant
```

Import the orchestrator:

```ts
import { RunOrchestrator } from 'sequant';
```

No CLI context, Commander.js, or process globals are required.

## What You Can Do

### Run a full workflow on issues

The simplest way — handles config resolution, services, worktrees, and cleanup:

```ts
import { RunOrchestrator } from 'sequant';
import { getSettings } from 'sequant/lib/settings';
import { getManifest } from 'sequant/lib/manifest';

const settings = await getSettings();
const manifest = await getManifest();

const result = await RunOrchestrator.run(
  {
    options: { phases: 'spec,exec,qa' },
    settings,
    manifest: { stack: manifest.stack, packageManager: manifest.packageManager ?? 'npm' },
  },
  ['123', '456'],  // issue numbers as strings
);

console.log(`Exit code: ${result.exitCode}`);
for (const r of result.results) {
  console.log(`#${r.issueNumber}: ${r.success ? 'passed' : 'failed'}`);
}
```

### Use low-level execution for custom setups

For callers that manage their own services and worktrees:

```ts
import { RunOrchestrator, buildExecutionConfig, resolveRunOptions } from 'sequant';

const config = buildExecutionConfig(mergedOptions, settings, issueCount);

const orchestrator = new RunOrchestrator({
  config,
  options: mergedOptions,
  issueInfoMap: new Map([[123, { title: 'My issue', labels: [] }]]),
  worktreeMap: new Map(),
  services: { logWriter: null, stateManager: null },
});

const results = await orchestrator.execute([123]);
```

### Resolve config with 4-layer priority

Config layers: defaults < settings < env < explicit (CLI flags).

```ts
import { resolveRunOptions, ConfigResolver } from 'sequant';

// Quick: merge CLI options with settings
const merged = resolveRunOptions(cliOptions, settings);

// Generic: use ConfigResolver for custom layer merging
const resolver = new ConfigResolver({
  defaults: { timeout: 60 },
  settings: { timeout: 1800 },
  env: { timeout: process.env.SEQUANT_TIMEOUT },
  explicit: { timeout: userOverride },
});
const resolved = resolver.resolve();
```

### Monitor progress

Pass an `onProgress` callback to receive per-phase events:

```ts
const result = await RunOrchestrator.run(
  {
    options: {},
    settings,
    manifest,
    onProgress: (issue, phase, event, extra) => {
      // event: 'start' | 'complete' | 'failed'
      console.log(`#${issue} ${phase}: ${event}`);
    },
  },
  ['123'],
);
```

## What to Expect

- **Execution time:** 5-20 minutes per issue depending on phases and complexity.
- **Output:** `RunResult` object with per-issue results, log path, exit code, and resolved config. No `process.exit` is called — the caller decides what to do with failures.
- **Worktrees:** Created automatically under `../worktrees/feature/` relative to the project root. Cleaned up on shutdown.
- **Logs:** Written to `.sequant/logs/` when `logJson` is enabled in settings.
- **Env vars:** `SEQUANT_QUALITY_LOOP`, `SEQUANT_MAX_ITERATIONS`, `SEQUANT_SMART_TESTS`, `SEQUANT_TESTGEN` are respected as config overrides.

## API Reference

### `RunOrchestrator.run(init, issueArgs, batches?)`

Full lifecycle execution. Handles everything from config resolution to metrics recording.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `init` | `RunInit` | Yes | Settings, options, manifest, callbacks |
| `issueArgs` | `string[]` | Yes | Issue numbers as strings |
| `batches` | `number[][]` | No | Pre-parsed batch groups (overrides `--batch`) |

Returns `Promise<RunResult>`.

### `orchestrator.execute(issueNumbers)`

Low-level dispatch. Caller manages setup and teardown.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `issueNumbers` | `number[]` | Yes | Issues to process |

Returns `Promise<IssueResult[]>`.

### `resolveRunOptions(cliOptions, settings)`

Merge CLI options with settings and env. Filters out `undefined` keys so programmatic callers don't clobber env/settings values.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cliOptions` | `RunOptions` | Yes | Caller-provided options (undefined keys are safe) |
| `settings` | `SequantSettings` | Yes | Project settings |

Returns `RunOptions`.

### `buildExecutionConfig(mergedOptions, settings, issueCount)`

Build phase-level execution config from merged options.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mergedOptions` | `RunOptions` | Yes | Output of `resolveRunOptions` |
| `settings` | `SequantSettings` | Yes | Project settings |
| `issueCount` | `number` | Yes | Number of issues (affects parallel mode) |

Returns `ExecutionConfig`.

### Key Types

| Type | Description |
|------|-------------|
| `RunInit` | High-level init: options, settings, manifest, callbacks |
| `RunResult` | Results, log path, exit code, worktree/issue maps |
| `IssueResult` | Per-issue: success, phase results, duration, PR info |
| `OrchestratorConfig` | Low-level config for `new RunOrchestrator()` |
| `OrchestratorServices` | Injectable services: logWriter, stateManager, shutdownManager |
| `ConfigLayers` | 4-layer config: defaults, settings, env, explicit |
| `ProgressCallback` | `(issue, phase, event, extra?) => void` |

## Execution Modes

| Mode | Trigger | Behavior |
|------|---------|----------|
| **Parallel** | Multiple issues, `sequential: false` | Concurrent execution with `p-limit` concurrency control |
| **Sequential** | `sequential: true` | One at a time, stops on first failure |
| **Chain** | `chain: true` | Sequential with dependency ordering, QA gate support |
| **Batch** | `batch: ['123,456', '789']` | Groups executed in order, issues within group run per mode |

## Troubleshooting

### Import fails with "Cannot find module"

**Symptoms:** `import { RunOrchestrator } from 'sequant'` throws at runtime.

**Solution:** Ensure sequant is installed and built. Run `npm run build` in the sequant directory if using a local copy.

### Config values are unexpectedly undefined

**Symptoms:** Options you set in settings or env vars aren't taking effect.

**Solution:** Check config layer priority. Explicit options (passed directly) override env, which overrides settings. If passing options programmatically, omit keys you don't want to set rather than setting them to `undefined`.

### Worktree creation fails

**Symptoms:** Error about git worktree conflicts or existing branches.

**Solution:** Run `git worktree list` to check for stale worktrees. Clean up with `git worktree remove <path>` or `sequant clean`.

---

*Generated for Issue #503 on 2026-04-08*
