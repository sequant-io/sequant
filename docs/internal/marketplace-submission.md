# Official Marketplace Submission Guide

Step-by-step guide for submitting sequant to the [Claude Code official plugin directory](https://github.com/anthropics/claude-plugins-official).

## Prerequisites

1. All versions synced: `npm run validate:marketplace`
2. Plugin structure valid: `npm run prepare:marketplace`
3. Tests passing: `npm test`

## Steps

### 1. Build the Marketplace Package

```bash
npm run prepare:marketplace
```

This creates `dist/marketplace/external_plugins/sequant/` with the required structure:

```
external_plugins/sequant/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   └── (all template skills)
├── hooks/
│   └── (hook scripts)
└── README.md
```

### 2. Validate the Package

```bash
npm run validate:marketplace
```

Checks:
- `plugin.json` has required fields (name, description, version, author)
- `plugin.json` has recommended fields (homepage, repository, license, keywords)
- Skills directory exists with SKILL.md files
- README.md is present

### 3. Submit to Official Directory

1. Go to the [plugin directory submission form](https://clau.de/plugin-directory-submission)
2. Fill in the submission details:
   - **Plugin name:** sequant
   - **Repository:** https://github.com/sequant-io/sequant
   - **Description:** Structured workflow system for Claude Code
3. Submit and wait for review

### 4. Post-Approval

After approval:
- Auto-update will be enabled by default for all users
- Users install via `/plugin install sequant@claude-plugin-directory`
- No more manual `sequant sync` needed for plugin users

## Reference

- [Official marketplace README](https://github.com/anthropics/claude-plugins-official)
- [Context7 as reference](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/context7)
