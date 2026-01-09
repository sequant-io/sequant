# Release Checklist

Before tagging a release, verify:

## Build & Test
- [ ] `npm test` passes
- [ ] `npm run build` passes
- [ ] `npm run lint` passes

## Validation
- [ ] All skills validate: `npm run validate:skills`
- [ ] `sequant doctor` passes in a test project

## Package
- [ ] Version bumped in `package.json`
- [ ] CHANGELOG.md updated
- [ ] No uncommitted changes: `git status`

## Smoke Test
- [ ] `sequant init` works in a fresh directory
- [ ] `sequant run <issue> --dry-run` works
