# Python Stack Guide

This guide covers using Sequant with Python projects.

## Detection

Sequant automatically detects Python projects by looking for:

- `pyproject.toml`
- `setup.py`
- `requirements.txt`

## Default Commands

When initialized with the Python stack, Sequant configures these commands:

| Command | Default |
|---------|---------|
| Test | `pytest` |
| Build | `python -m build` |
| Lint | `ruff check .` |
| Format | `ruff format .` |

## File Patterns

The workflow skills use these patterns to locate files:

| Pattern | Glob |
|---------|------|
| Source | `src/**/*.py` |
| Tests | `tests/**/*.py` |

## Workflow Integration

### /spec Phase

During planning, Sequant will:
- Review package structure in `src/`
- Check existing modules and classes
- Look for test patterns in `tests/`

### /exec Phase

During implementation, the agent will:
- Run `ruff check .` for linting
- Run `pytest` for test verification
- Run `python -m build` to ensure packaging works

### /qa Phase

Quality review includes:
- Ruff linting and formatting
- Type checking (if mypy/pyright configured)
- Test coverage review
- Docstring review

## Customization

Override commands in `.claude/.local/memory/constitution.md`:

```markdown
## Build Commands

- Test: `pytest -v --cov=src`
- Build: `poetry build`
- Lint: `ruff check . && mypy src`
```

## Common Patterns

### Modern Package (src layout)

```
pyproject.toml
src/
└── mypackage/
    ├── __init__.py
    ├── core.py
    └── utils.py
tests/
├── conftest.py
├── test_core.py
└── test_utils.py
```

### Poetry Project

```
pyproject.toml      # Poetry configuration
poetry.lock
src/
└── mypackage/
tests/
```

### Django Project

```
manage.py
myproject/
├── settings.py
├── urls.py
└── wsgi.py
apps/
├── users/
└── api/
```

## Tips

1. **Use `pyproject.toml`** - Modern Python projects should use `pyproject.toml` for configuration.

2. **Ruff** - Sequant uses Ruff by default for fast linting and formatting. Configure in `pyproject.toml`.

3. **Type Hints** - Add type hints for better code quality; the agent will use them for understanding the codebase.

4. **Virtual Environments** - Ensure your venv is activated before running Sequant commands.

## See Also

- [Customization Guide](../customization.md)
- [Troubleshooting](../troubleshooting.md)
