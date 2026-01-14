# Demo Assets

This directory contains demo GIFs and their source `.tape` files for [VHS](https://github.com/charmbracelet/vhs).

## Generating GIFs

### Prerequisites

```bash
# macOS
brew install vhs

# Or use Docker (no local install needed)
docker run --rm -v $PWD:/vhs ghcr.io/charmbracelet/vhs <file>.tape
```

### Generate All GIFs

```bash
cd docs/assets
vhs demo.tape       # Creates demo.gif
vhs workflow.tape   # Creates workflow.gif
```

### Automated Generation (CI)

GIFs are automatically regenerated on PR via GitHub Actions when `.tape` files change.
See `.github/workflows/generate-gifs.yml`.

## Tape Files

| File | Output | Description |
|------|--------|-------------|
| `demo.tape` | `demo.gif` | Quick start installation |
| `workflow.tape` | `workflow.gif` | Step-by-step workflow |

## Editing Tips

- Use `Set TypingSpeed 50ms` for readable typing
- Use `Sleep 2s` to pause for reading
- Test locally before committing: `vhs <file>.tape`
- Keep GIFs under 10 seconds for fast loading
