# Contributing to Sequant

Thank you for your interest in contributing to Sequant! This document provides guidelines and information for contributors.

## Getting Started

### Prerequisites

- Node.js 18.0.0 or higher
- Git
- GitHub CLI (`gh`) for testing issue integration

### Setup

```bash
# Clone the repository
git clone https://github.com/admarble/sequant.git
cd sequant

# Install dependencies
npm install

# Build the project
npm run build

# Run in development mode
npm run dev -- --help
```

## Development Workflow

### Running Locally

```bash
# Run CLI commands in dev mode
npm run dev -- init --help
npm run dev -- doctor
npm run dev -- run 1 --dry-run

# Build and test
npm run build
npm run lint
npm run validate:skills
```

### Project Structure

```
sequant/
├── bin/cli.ts              # CLI entry point
├── src/
│   ├── commands/           # CLI command implementations
│   │   ├── init.ts
│   │   ├── update.ts
│   │   ├── doctor.ts
│   │   ├── status.ts
│   │   └── run.ts
│   ├── lib/                # Shared utilities
│   │   ├── fs.ts           # File system helpers
│   │   ├── manifest.ts     # Manifest management
│   │   ├── stacks.ts       # Stack detection
│   │   ├── templates.ts    # Template processing
│   │   └── workflow/       # Workflow execution
│   └── index.ts            # Public exports
├── templates/              # Skill and hook templates
│   ├── skills/             # 14 workflow skills
│   ├── hooks/              # Pre/post tool hooks
│   ├── memory/             # Constitution template
│   └── scripts/            # Shell script helpers
├── stacks/                 # Stack configuration files
│   ├── nextjs.yaml
│   ├── rust.yaml
│   ├── python.yaml
│   └── go.yaml
└── docs/                   # Documentation
```

## Making Changes

### Adding a New Command

1. Create a new file in `src/commands/`:

```typescript
// src/commands/mycommand.ts
import chalk from "chalk";

interface MyCommandOptions {
  flag?: boolean;
}

export async function myCommand(options: MyCommandOptions): Promise<void> {
  console.log(chalk.blue("Running my command..."));
  // Implementation
}
```

2. Register in `bin/cli.ts`:

```typescript
import { myCommand } from "../src/commands/mycommand.js";

program
  .command("mycommand")
  .description("Description of my command")
  .option("-f, --flag", "Option description")
  .action(myCommand);
```

### Adding a New Skill

1. Create directory: `templates/skills/myskill/`
2. Create `SKILL.md` with YAML frontmatter:

```markdown
---
name: myskill
description: "What this skill does"
license: MIT
metadata:
  author: your-name
  version: "1.0"
allowed-tools:
  - Read
  - Edit
  - Bash(npm test:*)
---

# My Skill

Instructions for the AI agent...
```

3. Validate with: `npx skills-ref validate templates/skills/myskill`

### Adding a New Stack

1. Create `stacks/mystack.yaml`:

```yaml
name: mystack
displayName: My Stack
description: Description of the stack

detection:
  files:
    - mystack.config.js
  packageDeps:
    - mystack-core

commands:
  test: mystack test
  build: mystack build
  lint: mystack lint

variables:
  TEST_COMMAND: mystack test
  BUILD_COMMAND: mystack build
  LINT_COMMAND: mystack lint

patterns:
  src: src/**/*.ms
  tests: tests/**/*.ms
```

2. Update `src/lib/stacks.ts` if needed for special handling.

## Code Style

- TypeScript strict mode enabled
- ESLint for linting (`npm run lint`)
- Use `chalk` for colored output
- Use async/await for asynchronous operations
- Export types from `src/index.ts` for public API

### Commit Messages

Follow conventional commits:

```
feat: Add new feature
fix: Fix a bug
docs: Documentation changes
ci: CI/CD changes
refactor: Code refactoring
test: Add or update tests
chore: Maintenance tasks
```

## Testing

### Manual Testing

```bash
# Test initialization
npm run dev -- init --stack nextjs --yes

# Test doctor
npm run dev -- doctor

# Test run command
npm run dev -- run 1 --dry-run --verbose
```

### Skills Validation

```bash
# Validate all skills
npm run validate:skills

# Validate single skill
npx skills-ref validate templates/skills/spec
```

### CI Checks

Before submitting a PR, ensure:

```bash
npm run lint        # No lint errors
npm run build       # Build succeeds
npm run validate:skills  # All skills valid
```

## Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Run tests and linting
5. Commit with a descriptive message
6. Push and create a PR

### PR Checklist

- [ ] Code follows project style
- [ ] Changes are documented
- [ ] All CI checks pass
- [ ] Skills validated (if modified)
- [ ] README updated (if needed)

## Reporting Issues

When reporting bugs, include:

- Sequant version (`sequant --version`)
- Node.js version (`node --version`)
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Error messages or logs

## Questions?

- Open a [GitHub Issue](https://github.com/admarble/sequant/issues)
- Check existing issues for similar questions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
