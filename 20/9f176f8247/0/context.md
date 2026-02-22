# Session Context

## User Prompts

### Prompt 1

release

### Prompt 2

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

