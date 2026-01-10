# Package Manager Detection

**Quick Start:** Sequant automatically detects your project's package manager (npm, Bun, Yarn, or pnpm) from lockfiles and uses the correct commands throughout the workflow. No configuration required.

## How It Works

During `sequant init`, the package manager is detected from your lockfile:

| Lockfile | Detected PM |
|----------|-------------|
| `bun.lockb` / `bun.lock` | Bun |
| `yarn.lock` | Yarn |
| `pnpm-lock.yaml` | pnpm |
| `package-lock.json` | npm |
| No lockfile | npm (default) |

The detected package manager is stored in `.sequant-manifest.json` and used for all subsequent commands.

## Usage

### Automatic Detection

Simply run init - detection happens automatically:

```bash
sequant init
```

Output shows the detected package manager:

```
📋 Stack: nextjs
📦 Package Manager: bun
```

### Verification

Check your manifest to see the stored package manager:

```bash
cat .sequant-manifest.json | jq .packageManager
```

## Command Mapping

Sequant uses the correct commands for each package manager:

| Package Manager | Run Script | Execute Package | Install |
|-----------------|------------|-----------------|---------|
| npm | `npm run <script>` | `npx <pkg>` | `npm install` |
| Bun | `bun run <script>` | `bunx <pkg>` | `bun install` |
| Yarn | `yarn <script>` | `yarn dlx <pkg>` | `yarn install` |
| pnpm | `pnpm run <script>` | `pnpm dlx <pkg>` | `pnpm install` |

### Where Commands Are Used

- **Worktree setup:** When creating feature worktrees, Sequant runs the correct install command
- **Post-update:** After `sequant update`, dependencies are reinstalled with the correct PM
- **Hook detection:** Test and build failure detection in hooks works with all package managers

## Priority Order

If multiple lockfiles exist (rare), Sequant uses this priority:

1. **Bun** (bun.lockb, bun.lock)
2. **Yarn** (yarn.lock)
3. **pnpm** (pnpm-lock.yaml)
4. **npm** (package-lock.json)

## Common Workflows

### Migrating to a Different Package Manager

If you switch package managers:

1. Delete old lockfile
2. Create new lockfile with your new PM
3. Re-run `sequant init` (or manually edit manifest)

```bash
# Example: Switch from npm to Bun
rm package-lock.json
bun install  # Creates bun.lockb
sequant init  # Re-detects as Bun
```

### Manual Override

Edit `.sequant-manifest.json` directly if needed:

```json
{
  "version": "0.1.0",
  "stack": "nextjs",
  "packageManager": "bun",
  "installedAt": "2026-01-09T00:00:00.000Z"
}
```

## Troubleshooting

### Wrong Package Manager Detected

**Symptoms:** Sequant uses npm commands but you use Bun/Yarn/pnpm

**Solution:**
1. Ensure your lockfile exists in the project root
2. Re-run `sequant init` to re-detect
3. Or manually edit `.sequant-manifest.json`

### Missing packageManager in Manifest

**Symptoms:** Older projects don't have `packageManager` field

**Solution:** This is normal for projects initialized before this feature. Sequant defaults to npm. To update:

```bash
# Re-initialize to detect package manager
sequant init

# Or manually add to manifest
```

### Install Command Fails in Worktree

**Symptoms:** `bun install` or similar fails in feature worktree

**Solution:** Ensure your package manager is installed globally and in PATH:

```bash
# Verify PM is available
bun --version   # or yarn/pnpm
```

## Supported Package Managers

| Package Manager | Version | Notes |
|-----------------|---------|-------|
| npm | Any | Default, always available with Node.js |
| Bun | 1.0+ | Fast JS runtime and package manager |
| Yarn | 1.x, 2.x+ | Classic and Berry versions |
| pnpm | 7.0+ | Efficient disk space usage |

---

*Generated for Issue #6 on 2026-01-10*
