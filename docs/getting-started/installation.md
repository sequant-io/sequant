# Installation

Install and configure Sequant in your project.

## Quick Install

```bash
# Initialize Sequant in your project
npx sequant init

# Verify installation
npx sequant doctor
```

## What `init` Does

The `init` command sets up Sequant in your project:

1. **Creates `.claude/` directory** with workflow skills
2. **Creates `.sequant/` directory** for configuration
3. **Adds `.sequant-manifest.json`** for version tracking
4. **Detects your stack** (Next.js, Rust, Python, Go, and more) and configures commands

## Interactive Mode

For guided stack configuration, use the `--interactive` flag:

```bash
npx sequant init --interactive
# or
npx sequant init -i
```

Interactive mode:
- Confirms the detected stack before proceeding
- Lets you select a different stack from the available options
- In monorepos, detects multiple stacks and offers checkbox selection

## Multi-Stack Projects

For monorepos or projects with multiple stacks (e.g., Next.js frontend + Python backend):

```bash
npx sequant init --interactive
```

Sequant will:
1. **Scan root and subdirectories** for stack indicators
2. **Display all detected stacks** with their locations
3. **Let you select which stacks to include** via checkbox
4. **Ask which stack is primary** (determines dev URL and commands)
5. **Combine notes from all selected stacks** in your constitution

Stack selection is saved to `.sequant/stack.json` for future reference

## Global vs Local Installation

### Recommended: npx (No Install)

```bash
npx sequant init
npx sequant doctor
npx sequant run 123
```

Using `npx` ensures you always run the latest version.

### Global Installation

```bash
npm install -g sequant
sequant init
sequant doctor
```

### Local Installation (package.json)

```bash
npm install --save-dev sequant
npx sequant init
```

## Updating

To update Sequant templates while preserving your customizations:

```bash
npx sequant update
```

This updates files in `.claude/skills/` and `.claude/hooks/` while leaving your local overrides in `.claude/skills.local/` and `.claude/hooks.local/` untouched.

## Directory Structure

After installation:

```
.claude/
├── skills/              # Workflow commands (updated by sequant update)
│   ├── spec/SKILL.md
│   ├── exec/SKILL.md
│   ├── qa/SKILL.md
│   └── ...
├── skills.local/        # Your overrides (never modified)
├── hooks/               # Pre/post tool hooks
├── hooks.local/         # Your hook overrides
├── memory/              # Project context
│   └── constitution.md
└── settings.json        # Hooks configuration

.sequant/
└── settings.json        # Run command configuration

.sequant-manifest.json   # Version tracking
```

## Next Steps

- [Your First Workflow](first-workflow.md) — Solve your first issue
- [Customization Guide](../customization.md) — Override templates safely
