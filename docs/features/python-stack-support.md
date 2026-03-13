# Python Stack Support

**Quick Start:** Sequant now auto-detects Python projects and uses the correct package manager commands (pip, poetry, or uv) throughout the workflow.

## How It Works

When you run `sequant init` or `sequant run` in a Python project, Sequant detects your package manager from lockfiles and configures all skill templates accordingly.

## Detection Priority

Sequant checks for lockfiles in this order:

| Priority | Lockfile | Package Manager |
|----------|----------|-----------------|
| 1 | `uv.lock` | uv |
| 2 | `poetry.lock` | poetry |
| 3 | `pyproject.toml` (fallback) | pip |
| 4 | `requirements.txt` (fallback) | pip |

**Note:** JavaScript lockfiles (`bun.lockb`, `yarn.lock`, `pnpm-lock.yaml`, `package-lock.json`) take priority. In a mixed JS/Python project, the JS package manager is used.

## Package Manager Commands

Each Python PM maps to these commands:

| Command | pip | poetry | uv |
|---------|-----|--------|----|
| Run | `python -m` | `poetry run` | `uv run` |
| Exec | `python -m` | `poetry run` | `uvx` |
| Install | `pip install` | `poetry install` | `uv pip install` |
| Install (quiet) | `pip install -q` | `poetry install -q` | `uv pip install -q` |

## Usage

### Initialize a Python Project

1. Navigate to your Python project directory
2. Run `sequant init`
3. Sequant detects the stack (e.g., `python`, `django`, `fastapi`) and package manager
4. Skill templates are generated with the correct `{{PM_RUN}}` token

### Verify Detection

Check which package manager Sequant detected:

```bash
cat .sequant/settings.json | jq '.packageManager'
```

## Supported Stacks

Python package managers work with these detected stacks:

| Stack | Detection | Notes |
|-------|-----------|-------|
| `python` | `pyproject.toml` or `requirements.txt` | Generic Python |
| `django` | `manage.py` present | Django projects |
| `fastapi` | `fastapi` in dependencies | FastAPI projects |

## Troubleshooting

### Wrong package manager detected

**Symptoms:** Sequant uses `pip` when you use `poetry` or `uv`.

**Solution:** Ensure your lockfile exists in the project root. Run `poetry lock` or `uv lock` to generate it, then re-run `sequant init`.

### Mixed JS/Python project uses JS package manager

**Symptoms:** Project has both `package.json` and `pyproject.toml`, but Sequant uses npm.

**Solution:** This is by design. JavaScript lockfiles take priority in mixed projects. If your project is primarily Python, remove the `package.json` or configure the package manager manually in `.sequant/settings.json`.

---

*Generated for Issue #94 on 2026-03-13*
