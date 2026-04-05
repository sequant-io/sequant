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

| Package Manager | Run Script | Execute Package | Install All | Add Package | Remove Package | Update Package |
|-----------------|------------|-----------------|-------------|-------------|----------------|----------------|
| npm | `npm run <script>` | `npx <pkg>` | `npm install` | `npm install <pkg>` | `npm uninstall <pkg>` | `npm update <pkg>` |
| Bun | `bun run <script>` | `bunx <pkg>` | `bun install` | `bun add <pkg>` | `bun remove <pkg>` | `bun update <pkg>` |
| Yarn | `yarn <script>` | `yarn dlx <pkg>` | `yarn install` | `yarn add <pkg>` | `yarn remove <pkg>` | `yarn upgrade <pkg>` |
| pnpm | `pnpm run <script>` | `pnpm dlx <pkg>` | `pnpm install` | `pnpm add <pkg>` | `pnpm remove <pkg>` | `pnpm update <pkg>` |

### Where Commands Are Used

- **Worktree setup:** When creating feature worktrees, Sequant runs the correct install command
- **Post-update:** After `sequant update`, dependencies are reinstalled with the correct PM
- **Hook detection:** Test and build failure detection in hooks works with all package managers
- **CLI messages:** Version update suggestions, uninstall hints, and dependency install errors use your package manager's commands (e.g., `pnpm update sequant` instead of `npm update sequant`)

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

## Installing Sequant

Use your project's package manager to install sequant — don't mix package managers (e.g., don't run `npm install` in a pnpm project).

### npx (recommended, no install)

```bash
npx sequant init
npx sequant doctor
```

### Local install

```bash
npm install --save-dev sequant   # npm
pnpm add -D sequant              # pnpm
yarn add -D sequant              # yarn
bun add -D sequant               # bun
```

### Global install

```bash
npm install -g sequant           # npm
pnpm add -g sequant              # pnpm
yarn global add sequant          # yarn
bun add -g sequant               # bun
```

## Troubleshooting

### "Cannot read properties of null" when running npm in a pnpm/yarn project

**Symptoms:** `npm update sequant` or `npm install sequant` crashes with `Cannot read properties of null (reading 'matches')` in a project that uses pnpm or yarn.

**Solution:** Use your project's package manager instead of npm. Check which lockfile exists in your project root:

```bash
ls pnpm-lock.yaml yarn.lock bun.lockb bun.lock package-lock.json 2>/dev/null
```

Then use the matching package manager's commands (see table above).

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

*Generated for Issue #6 on 2026-01-10. Updated for Issue #487 on 2026-04-05.*
