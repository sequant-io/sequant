## Summary

The `/sequant:setup` skill copies a generic constitution template. For better user experience, we should detect the project's tech stack and either:
1. Copy a stack-specific template, or
2. Dynamically inject stack-specific notes

## Proposed Approach

### Option A: Multiple Templates
```
memory/
├── constitution.md           # Generic fallback
├── constitution.node.md      # Node.js/TypeScript
├── constitution.python.md    # Python
├── constitution.rust.md      # Rust
└── constitution.go.md        # Go
```

### Option B: Dynamic Injection (Preferred)
Keep single template with a `{{STACK_NOTES}}` placeholder. Setup skill detects stack and injects relevant notes:

**Node.js Detection:** `package.json` exists
- Testing: Jest, Vitest, Mocha patterns
- Linting: ESLint, Prettier conventions
- Build: Common output directories

**Python Detection:** `pyproject.toml`, `setup.py`, `requirements.txt`
- Testing: pytest conventions
- Linting: ruff, black, mypy
- Virtual environments

**Rust Detection:** `Cargo.toml`
- Testing: cargo test conventions
- Clippy lints
- Module organization

## Acceptance Criteria

- [ ] Setup skill detects project stack
- [ ] Injects appropriate stack-specific notes
- [ ] Falls back to generic notes if stack unknown
- [ ] Stack notes include testing, linting, and build conventions

## Nice to Have

- [ ] Interactive mode asks user to confirm/customize detected stack
- [ ] Support for multi-stack projects (e.g., Node + Python)

## Related

- Depends on #187 (project name detection shares detection logic)
- Part of plugin portability improvements from #185
