# Customization Guide

Sequant is designed to be customizable without losing the ability to receive updates. This guide explains how to customize your workflow while maintaining update safety.

## Update-Safe Architecture

Sequant uses a two-layer system:

```
.claude/
├── skills/           # Package-managed (updated by sequant update)
├── hooks/            # Package-managed
├── memory/           # Package-managed
├── settings.json     # Package-managed
└── .local/           # YOUR customizations (never touched by updates)
    ├── skills/       # Custom or modified skills
    ├── hooks/        # Custom hooks
    └── memory/       # Custom constitution additions
```

**Key principle:** Put your customizations in `.claude/.local/` and they will never be overwritten.

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

To customize the `/spec` skill:

1. Copy the original:
   ```bash
   cp .claude/skills/spec/SKILL.md .claude/.local/skills/spec/SKILL.md
   ```

2. Edit your copy in `.local/skills/spec/SKILL.md`

3. The local version takes precedence

### Creating a New Skill

Create a new skill directory in `.claude/.local/skills/`:

```
.claude/.local/skills/deploy/
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

## Customizing Hooks

Hooks run before and after tool executions. Create custom hooks in `.claude/.local/hooks/`:

### Pre-Edit Hook

`.claude/.local/hooks/pre-edit.sh`:

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

### Post-Commit Hook

`.claude/.local/hooks/post-commit.sh`:

```bash
#!/bin/bash
# Run after git commits

# Notify team on Slack
curl -X POST "$SLACK_WEBHOOK" \
  -H 'Content-type: application/json' \
  -d '{"text":"New commit pushed to repository"}'
```

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

- [Stack Guides](stacks/)
- [Troubleshooting](troubleshooting.md)
