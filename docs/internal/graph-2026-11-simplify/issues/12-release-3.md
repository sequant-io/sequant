gate(owner): release sequant 3.0.0 — `/release` major from `main` after the smoke and the pin; `next` first, `latest` on the owner's word

**Epic:** graph-2026-11-simplify   **Tier:** mechanical   **Execution:** owner   **Blocked by:** #S-10, #S-11

- **Blocked by**: #S-10
- **Blocked by**: #S-11

## Problem

#S-02 to #S-04 remove flags, a setting and an MCP parameter, so the release is a semver major. The owner decided on 2026-11-03 that the simplification lands on `main` as 3.0, with no fork, and that 3.0 waits for the downstream pin. Founding doc P-13.

## The gate

- **Artifact reviewed:** the `[Unreleased]` section of `CHANGELOG.md` on `main` and the smoke report (#S-10).
- **Question the owner answers:** publish 3.0.0 to `next`? Then, separately: promote to `latest`?
- **Reject route:** a changelog gap reopens the node that owns it; a smoke `reopen` already blocks this node.

## Acceptance Criteria

- [ ] AC-1: 3.0.0 is on npm. Evidence: `npm view sequant@3.0.0 version` → `3.0.0`
- [ ] AC-2: The release tag exists. Evidence: `git ls-remote --tags origin v3.0.0 | wc -l | tr -d ' '` → `1`
- [ ] AC-3: The 3.0.0 changelog section lists the removals. Evidence: `awk '/^## \[3\.0\.0\]/,/^## \[2\./' CHANGELOG.md | grep -cE -- '--model-ladder|--escalate-effort|--stacked|--reflect|--full-qa'` → `≥ 5`
- [ ] AC-4: The measured build's tag is untouched. Evidence: `git rev-parse 'research-baseline-2026-11-03^{commit}' | cut -c1-9` → `31c6f8bdc` (constraint)

## May touch

`package.json`, `package-lock.json`, `CHANGELOG.md` through `/release`'s PR (#1131).

## Non-Goals

- Promoting to `latest` without the owner's second answer.
- Anything not merged by #S-01 to #S-07.

## Done when

`sequant@3.0.0` is published with a changelog that names every removal, and the production executor still runs 2.20.0.
