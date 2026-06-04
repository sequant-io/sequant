# Customization Guide

Sequant is designed to be customizable without losing the ability to receive updates. This guide explains how to customize your workflow while maintaining update safety.

## Update-Safe Architecture

Sequant uses a two-layer system:

```
.claude/
├── skills/           # Package-managed (updated by sequant update/sync)
├── hooks/            # Package-managed
├── memory/           # Package-managed
├── settings.json     # Package-managed
├── settings.local.json  # YOUR settings/hook overrides (Claude Code merges this; gitignored)
└── .local/           # YOUR runtime overlays (never written by update/sync)
    ├── skills/<name>/overrides.md  # Per-skill instruction deltas (read at invocation)
    └── memory/constitution.md      # Custom constitution additions (read at invocation)
```

**Key principle:** `sequant update` and `sync` never *write* into `.claude/.local/`, and they never delete files they don't manage. But putting a file under `.local/` is not enough on its own — it only has an effect if something actually *reads* it:

| Customization | Where it goes | What reads it |
|---------------|---------------|---------------|
| Modify an existing skill | `.claude/.local/skills/<name>/overrides.md` | The skill itself, at invocation (overlay directive) |
| Add a brand-new skill | `.claude/skills/<name>/` (checked in) or `~/.claude/skills/<name>/` | Claude Code skill discovery |
| Constitution additions | `.claude/.local/memory/constitution.md` | The constitution, at load time |
| Custom hooks | A script + a `.claude/settings.local.json` entry | Claude Code's hook runner |

> **Important:** Claude Code's skill discovery only scans `~/.claude/skills/` (user), `.claude/skills/` (project), and plugin scopes. It does **not** scan `.claude/.local/skills/`. A full `SKILL.md` placed there is never loaded — see "Modifying an Existing Skill" below for the supported overlay mechanism.

## Customizing the Constitution

The constitution in `.claude/memory/constitution.md` defines project-wide rules. To add your own rules:

1. Create `.claude/.local/memory/constitution.md`
2. Add your project-specific rules

```markdown
# Project-Specific Rules

## Code Style

- Use 2-space indentation
- Prefer functional components over classes
- Always use TypeScript strict mode

## Build Commands

- Test: `npm run test:ci`
- Build: `npm run build:prod`
- Lint: `npm run lint:strict`

## Dependencies

- Use date-fns instead of moment
- Prefer native fetch over axios
- Use zod for validation
```

## Customizing Skills

### Modifying an Existing Skill

Do **not** copy the full `SKILL.md` into `.claude/.local/skills/` — Claude Code never loads it from there, so the copy would silently do nothing.

Instead, write an **overrides file**. Every managed skill ends with a directive instructing it to honor `.claude/.local/skills/<name>/overrides.md` if that file exists, treating its instructions as authoritative over anything that conflicts. Claude reads the full skill body (including that directive) at invocation, so your overrides take effect without forking the skill.

To customize the `/spec` skill:

1. Create the overrides file:
   ```bash
   mkdir -p .claude/.local/skills/spec
   ```

2. Write only the *deltas* — the behavior you want to change — into `.claude/.local/skills/spec/overrides.md`:
   ```markdown
   # Overrides for /spec

   - Always include a "Risks" section in the plan.
   - Skip the Label Review section for internal repos.
   - Cap the plan at 200 lines.
   ```

3. Invoke `/spec`. The overlay directive at the end of `spec/SKILL.md` makes these instructions win over the defaults.

**Why deltas, not a full copy?** A small `overrides.md` survives `sequant update`/`sync` cleanly (those commands never write into `.local/`), and you avoid the "vendored fork" problem where your full copy drifts out of date as the upstream skill improves.

### Verifying an override took effect

Don't trust file placement alone — confirm the override actually changes behavior:

1. Add a small, unmistakable instruction to `overrides.md`, e.g. `Begin your reply with the literal line: OVERRIDE-ACTIVE.`
2. Invoke the skill (`/spec`, `/qa`, …) and confirm the marker appears in the output.
3. Remove the marker once you've confirmed the overlay is wired up, then keep your real deltas.

If the marker does not appear, check that the path is exactly `.claude/.local/skills/<name>/overrides.md` (the `<name>` must match the skill directory) and that the managed `SKILL.md` still contains its `<!-- sequant:local-override -->` directive (restore it with `sequant update --force` if you edited it away).

### Creating a New Skill

A net-new skill needs a home that Claude Code's discovery actually scans. `.claude/.local/skills/` is **not** such a location. Use one of:

- **Project scope** (`.claude/skills/<name>/`) — checked into your repo, shared with the team. This is the recommended home for a project-specific skill.
- **User scope** (`~/.claude/skills/<name>/`) — available across all your projects, not committed.

`sequant update`/`sync` only write the skills they manage (those shipped in the package templates) and never delete unmanaged directories, so a net-new `.claude/skills/<name>/` you add is treated as yours and is never clobbered.

Create the skill directory and `SKILL.md`:

```
.claude/skills/deploy/
└── SKILL.md
```

Example `SKILL.md`:

```markdown
---
name: deploy
description: "Deploy the application to production"
license: MIT
metadata:
  author: your-team
  version: "1.0"
allowed-tools:
  - Bash(npm run deploy:*)
  - Bash(gh workflow run:*)
---

# Deploy Skill

When invoked as `/deploy`, deploy the application.

## Behavior

1. Run pre-deployment checks
2. Build the production bundle
3. Deploy to the target environment
4. Verify deployment health
```

> **Note:** Skill `allowed-tools` do not override project or user-level `deny` rules. See [Permission Precedence](../reference/permissions.md) for how layers interact.

## Customizing Hooks

Hooks run before and after tool executions. Claude Code fires hooks from the `hooks` block of your settings files — it does **not** auto-discover scripts under `.claude/.local/hooks/`. Dropping a script there alone runs nothing; you must register it.

The supported, update-safe mechanism is `.claude/settings.local.json`. Claude Code merges it over the package-managed `.claude/settings.json`, and `sequant update`/`sync` never touch it (it is gitignored by default).

### Register a custom hook

1. Write your hook script anywhere you control — e.g. `.claude/.local/hooks/pre-edit.sh`:

   ```bash
   #!/bin/bash
   # Run before any file edit

   FILE="$1"

   # Prevent editing production config
   if [[ "$FILE" == *"production.config"* ]]; then
     echo "ERROR: Cannot edit production config files"
     exit 1
   fi
   ```

   ```bash
   chmod +x .claude/.local/hooks/pre-edit.sh
   ```

2. Register it in `.claude/settings.local.json` so Claude Code actually runs it:

   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "matcher": "Edit",
           "hooks": [
             {
               "type": "command",
               "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/.local/hooks/pre-edit.sh"
             }
           ]
         }
       ]
     }
   }
   ```

The script may live under `.claude/.local/hooks/` (update-safe), but it only fires because of the explicit `settings.local.json` entry — the path is what matters, not the directory's name.

## Environment Variables

Set project-specific environment variables in `.env.local`:

```bash
# Override phase timeout
PHASE_TIMEOUT=3600

# Enable quality loop by default
QUALITY_LOOP=true

# Custom phases
PHASES=spec,testgen,exec,test,qa
```

## Workflow Customization

### Custom Phase Order

Override the default phase order in the run command:

```bash
# Skip spec, only run exec and qa
npx sequant run 123 --phases exec,qa

# Include test generation
npx sequant run 123 --phases spec,testgen,exec,test,qa
```

### Quality Loop Settings

Configure automatic iteration:

```bash
# Enable quality loop with max 5 iterations
QUALITY_LOOP=true MAX_ITERATIONS=5 npx sequant run 123
```

## Stack Overrides

If your project doesn't fit the default stack patterns, override detection:

```bash
# Force a specific stack
sequant init --stack rust --force
```

Or modify `.sequant-manifest.json`:

```json
{
  "version": "0.1.0",
  "stack": "rust",
  "installedAt": "2024-01-01T00:00:00.000Z"
}
```

## Tips

1. **Start with defaults** - Use the default configuration first, then customize as needed.

2. **Document changes** - Add comments explaining why you customized something.

3. **Version control** - Commit your `.claude/.local/` directory to preserve customizations.

4. **Test updates** - After running `sequant update`, verify your customizations still work.

## Testing Configuration

The `/test` skill uses configurable settings for dev server URL and package manager commands.

### Default Values by Stack

| Stack | Dev URL | Dev Command |
|-------|---------|-------------|
| Next.js | `http://localhost:3000` | `npm run dev` |
| Astro | `http://localhost:4321` | `npm run dev` |
| SvelteKit | `http://localhost:5173` | `npm run dev` |
| Vite/Remix | `http://localhost:5173` | `npm run dev` |
| Nuxt | `http://localhost:3000` | `npm run dev` |
| Python | `http://localhost:5000` | - |
| Rust | `http://localhost:8080` | - |
| Go | `http://localhost:8080` | - |
| Generic | `http://localhost:3000` | `npm run dev` |

### Customizing Dev Server URL

The dev server URL is set during `sequant init` and stored in `.claude/.sequant/config.json`:

```json
{
  "tokens": {
    "DEV_URL": "http://localhost:4321",
    "PM_RUN": "npm run"
  },
  "stack": "astro",
  "initialized": "2024-01-01T00:00:00.000Z"
}
```

**To change the dev server URL:**

1. Edit `.claude/.sequant/config.json` directly
2. Update the `DEV_URL` value
3. Run `sequant update` to refresh templates with the new value

**Example for custom port:**
```json
{
  "tokens": {
    "DEV_URL": "http://localhost:8080",
    "PM_RUN": "bun run"
  }
}
```

### Package Manager Detection

Sequant automatically detects your package manager from lockfiles:

| Lockfile | Package Manager | PM_RUN Value |
|----------|-----------------|--------------|
| `bun.lockb` or `bun.lock` | bun | `bun run` |
| `yarn.lock` | yarn | `yarn` |
| `pnpm-lock.yaml` | pnpm | `pnpm run` |
| `package-lock.json` | npm | `npm run` |

The `PM_RUN` token is used in skill templates to run scripts with the correct package manager.

### Chrome DevTools MCP (Optional)

The `/test` skill works best with the Chrome DevTools MCP for browser automation, but it's **optional**:

**With MCP:** Automated browser testing with screenshots and element interaction
**Without MCP:** Generates a manual testing checklist with URLs and steps

To install Chrome DevTools MCP, see the [MCP documentation](https://github.com/anthropics/claude-code).

## See Also

- [Stack Guides](../stacks/)
- [Troubleshooting](../troubleshooting.md)
