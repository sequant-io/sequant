# Rust Stack Guide

This guide covers using Sequant with Rust projects.

## Detection

Sequant automatically detects Rust projects by looking for:

- `Cargo.toml`

## Default Commands

When initialized with the Rust stack, Sequant configures these commands:

| Command | Default |
|---------|---------|
| Test | `cargo test` |
| Build | `cargo build --release` |
| Lint | `cargo clippy` |
| Check | `cargo check` |

## File Patterns

The workflow skills use these patterns to locate files:

| Pattern | Glob |
|---------|------|
| Source | `src/**/*.rs` |
| Tests | `tests/**/*.rs` |
| Benchmarks | `benches/**/*.rs` |

## Workflow Integration

### /spec Phase

During planning, Sequant will:
- Review module structure in `src/`
- Check existing patterns and traits
- Look for integration tests in `tests/`

### /exec Phase

During implementation, the agent will:
- Run `cargo clippy` for linting
- Run `cargo test` for verification
- Run `cargo build --release` to ensure it compiles

### /qa Phase

Quality review includes:
- Clippy warnings check
- Documentation review (`cargo doc`)
- Test coverage review
- Unsafe code audit

## Customization

Override commands in `.claude/.local/memory/constitution.md`:

```markdown
## Build Commands

- Test: `cargo test --all-features`
- Build: `cargo build --release --all-features`
- Lint: `cargo clippy -- -D warnings`
```

## Common Patterns

### Library Crate

```
src/
├── lib.rs
├── module/
│   ├── mod.rs
│   └── submodule.rs
└── utils.rs
```

### Binary Crate

```
src/
├── main.rs
├── cli.rs
├── commands/
│   └── mod.rs
└── lib.rs
```

### Workspace

```
Cargo.toml          # Workspace root
crates/
├── core/
│   ├── Cargo.toml
│   └── src/
├── cli/
│   ├── Cargo.toml
│   └── src/
```

## Tips

1. **Use `cargo clippy`** - Sequant runs Clippy by default; fix all warnings before the QA phase.

2. **Documentation** - Add doc comments (`///`) for public APIs; the agent will check for missing docs.

3. **Error Handling** - Prefer `thiserror` for library errors and `anyhow` for application errors.

4. **Testing** - Place unit tests in the same file with `#[cfg(test)]` modules; integration tests go in `tests/`.

## See Also

- [Customization Guide](../customization.md)
- [Troubleshooting](../troubleshooting.md)
