# Session Context

## User Prompts

### Prompt 1

this is the first time I've seen this happen:\
(base) tony@Tambras-MacBook-Air matcha-maps % npx sequant run 596 592 -q
⚠️  Running sequant from local node_modules
   For latest version: npx sequant@latest
   To remove local: npm uninstall sequant

╭──────────────────╮
│ SEQUANT WORKFLOW │
╰──────────────────╯
  ⚠️  sequant 1.20.1 is available (you have 1.20.0)
   Run: npm update sequant
   Note: You have...

### Prompt 2

do we need to create an issue for sequant?

### Prompt 3

I meant moreso portable for sequant users or is this an isolated incident?

### Prompt 4

yes

### Prompt 5

Base directory for this skill: /Users/tony/Projects/sequant/.claude/skills/release

# Release Skill

Automates the full release workflow: version bump, git tag, GitHub release, and npm publish.

## Usage

```
/release [patch|minor|major] [--prerelease <tag>] [--dry-run]
```

- `/release` - Interactive, asks for version type
- `/release patch` - Patch release (1.3.1 → 1.3.2)
- `/release minor` - Minor release (1.3.1 → 1.4.0)
- `/release major` - Major release (1.3.1 → 2.0.0)
- `/release min...

### Prompt 6

[Request interrupted by user for tool use]

### Prompt 7

proceed

