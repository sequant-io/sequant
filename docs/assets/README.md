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
# demo.tape and workflow.tape are self-contained — run them from this directory:
cd docs/assets
vhs demo.tape       # Creates demo.gif
vhs workflow.tape   # Creates workflow.gif

# run-grid.tape drives the real harness, so run it from the REPO ROOT
# (it needs tsx + node_modules + tsconfig):
cd ../..
vhs docs/assets/run-grid.tape   # Creates docs/assets/run-grid.gif
```

### Rendering (local, then commit)

There is no CI render step — the old `.github/workflows/generate-gifs.yml` was
removed (commit `103e453`). Render GIFs locally and **commit the `.gif`**: the
root `README.md` ships verbatim to npm, so its embeds resolve via an absolute
`raw.githubusercontent.com` URL, not a CI-rendered relative path.

## Tape Files

| File | Output | Description |
|------|--------|-------------|
| `demo.tape` | `demo.gif` | Quick start installation |
| `workflow.tape` | `workflow.gif` | Step-by-step workflow |
| `run-grid.tape` | `run-grid.gif` | The live **boxed Ink TUI** run grid, driven by the privacy-safe harness `scripts/demo/run-grid-demo.ts` (fictional `#64`, no real-machine data). Embedded near the top of the root `README.md`. |

## Editing Tips

- Use `Set TypingSpeed 50ms` for readable typing
- Use `Sleep 2s` to pause for reading
- Test locally before committing: `vhs <file>.tape`
- Keep GIFs under 10 seconds for fast loading
