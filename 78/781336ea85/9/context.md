# Session Context

## User Prompts

### Prompt 1

How do I fix this graphic? some of the ascii isnt aligned. can I manually edit?\

### Prompt 2

[Image: source: /Users/tony/Desktop/Screenshot 2026-03-19 at 6.58.07 PM.png]

### Prompt 3

Are there any other diagrams across docs that need a review?

### Prompt 4

commit push

### Prompt 5

did you commit?

### Prompt 6

release

### Prompt 7

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

### Prompt 8

proceed

### Prompt 9

done

### Prompt 10

proceed

### Prompt 11

done

### Prompt 12

it's not synced with whats on github. We made some subtle changes

### Prompt 13

should we rebuild

### Prompt 14

look at the changes we made in the sequant repo

### Prompt 15

do some investigating. use subagents if needed

### Prompt 16

yes

### Prompt 17

ran it but the docs are still stale:\
https://sequant.io/docs/

### Prompt 18

I need pro and I'm on the free tier. any alternative?

### Prompt 19

this is from the incognito window diagram:\
"                         ┌──────────────┐
                         │ GitHub Issue  │
                         │    #123       │
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │    /spec     │  Runs in main repo.
                         │     Plan...

### Prompt 20

yes

### Prompt 21

That worked. Can you document what to do in the future for doc syncing in the sequant-landing repo?

