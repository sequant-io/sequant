---
name: setup
description: "Initialize Sequant in your project - copies constitution and creates worktrees directory"
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Read
  - Write
  - Bash(mkdir:*)
  - Bash(cp:*)
  - Bash(ls:*)
  - Bash(cat:*)
---

# Sequant Setup

Initialize Sequant workflow system in your current project.

## Purpose

When invoked as `/sequant:setup` or `/setup`, this skill:

1. Creates the worktrees directory structure
2. Copies the constitution.md template to your project
3. Validates prerequisites (git, gh CLI)

## Usage

```
/sequant:setup
```

## What It Does

### 1. Validate Prerequisites

```bash
git --version
gh auth status
```

### 2. Create Worktrees Directory

```bash
mkdir -p ../worktrees/feature
```

### 3. Copy Constitution Template

```bash
mkdir -p .claude/memory
cp "${CLAUDE_PLUGIN_ROOT}/memory/constitution.md" .claude/memory/constitution.md
```

### 4. Customize Constitution

After setup, edit `.claude/memory/constitution.md` to describe your project.

## Post-Setup

1. Edit constitution.md for your project
2. Run `/assess <issue>` to start working
3. Run `/fullsolve <issue>` for end-to-end resolution
