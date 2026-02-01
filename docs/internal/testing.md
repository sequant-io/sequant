# Cross-Platform Testing Guide

This document outlines the testing matrix for Sequant across different platforms and IDEs.

## Testing Matrix (AC-14)

### Platform Testing

| Platform | IDE | Tester | Status | Notes |
|----------|-----|--------|--------|-------|
| macOS | Claude Code | - | ✅ Tested | Primary development platform |
| macOS | Cursor | - | 🔲 Pending | |
| macOS | VS Code | - | 🔲 Pending | |
| Linux | Claude Code | - | 🔲 Pending | |
| Linux | Terminal | - | 🔲 Pending | CLI-only testing |
| Windows WSL | Claude Code | - | 🔲 Pending | |
| Windows WSL | VS Code | - | 🔲 Pending | |

### Test Checklist

For each platform/IDE combination, verify:

#### Installation

- [ ] `npm install -g sequant` completes without errors
- [ ] `sequant --version` returns correct version
- [ ] `sequant --help` displays help text

#### Initialization

- [ ] `sequant init` detects project stack correctly
- [ ] All files created in `.claude/` directory
- [ ] Shell scripts in `scripts/dev/` are executable
- [ ] `.sequant-manifest.json` created correctly

#### CLI Commands

- [ ] `sequant doctor` passes all checks
- [ ] `sequant status` shows correct information
- [ ] `sequant update --dry-run` works without errors
- [ ] `npx sequant run 1 --dry-run` shows expected output

#### Shell Scripts (Bash environments only)

- [ ] `./scripts/dev/list-worktrees.sh` runs without errors
- [ ] `./scripts/dev/new-feature.sh 1` creates worktree (if issue exists)
- [ ] `./scripts/dev/cleanup-worktree.sh` shows usage help

#### Skills Integration

- [ ] Skills appear in IDE skill picker
- [ ] `/spec 1` loads and shows planning prompt
- [ ] `/exec 1` loads and shows implementation prompt
- [ ] `/qa 1` loads and shows review prompt

## Platform-Specific Notes

### macOS

- Primary development and testing platform
- All features fully supported
- Both Intel and Apple Silicon tested

### Linux

- Tested on Ubuntu 22.04+
- Requires `bash` for shell scripts
- `jq` required for worktree scripts (install with package manager)

### Windows WSL

- Requires WSL2 with a Linux distribution (Ubuntu recommended)
- Install Node.js inside WSL, not Windows
- GitHub CLI should be configured inside WSL
- Shell scripts work natively in WSL bash

### Windows Native (Limited Support)

- CLI commands work in PowerShell/CMD
- Shell scripts (`*.sh`) do not work natively
- Worktree scripts require WSL or Git Bash
- Consider using WSL for full functionality

## IDE-Specific Notes

### Claude Code

- Full support for all features
- Skills load automatically from `.claude/skills/`
- Hooks execute as configured

### Cursor

- Skills should load from `.claude/skills/`
- Verify skill picker shows Sequant skills
- Test hook execution

### VS Code + Copilot

- Skills should be compatible
- Test with Copilot Chat for skill invocation
- Verify workspace settings don't conflict

## Reporting Issues

When reporting platform-specific issues, include:

1. **Platform**: OS version (e.g., macOS 14.2, Ubuntu 22.04, Windows 11 + WSL2)
2. **IDE**: Name and version
3. **Node.js version**: Output of `node --version`
4. **Sequant version**: Output of `sequant --version`
5. **Error output**: Full error message or screenshot
6. **Steps to reproduce**: What commands were run

File issues at: https://github.com/admarble/sequant/issues

## Contributing Test Results

If you test Sequant on a new platform/IDE combination:

1. Run through the test checklist above
2. Note any issues or workarounds needed
3. Submit a PR updating this document with your results
4. Include your platform details in the testing matrix
