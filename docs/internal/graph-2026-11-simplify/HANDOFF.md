# Handoff: graph-2026-11-simplify, wave close (2026-11-18)

`main` = `63d74cb02` ("chore: release v3.0.0 (#1701)"), tagged `v3.0.0`. Tracker #1645. Merge consent was **stop at every PR** (I-5) throughout. Every merge below had the owner's word, logged in the research repo's decision log.

sequant 3.0.0 is on npm under `next`. `latest` stays on 2.20.0 until `/release --soaked`. Registry at close: `{"latest":"2.20.0","next":"3.0.0"}`; `npm view sequant@3.0.0 dist.shasum` → `e888a63f4305e7b9ecc56771f183739fb3ce410e`. Since `research-baseline-2026-11-03` (`31c6f8bdc`, untouched): `src` and `bin` show 70 files changed, 2619 insertions and 6404 deletions.

## Ledger

| Node | State | Merged as |
|---|---|---|
| #1646 repeat halt | closed | `f5489a8` (PR #1660) |
| #1647 ladder and effort-escalation removal | closed | `fad6b40` (PR #1664) |
| #1648 `--stacked`, `--reflect`, `--full-qa` removal | closed | `d1eb83b` (PR #1674) |
| #1649 label test-add | closed | `a5bba30` (PR #1659) |
| #1650 | closed | `7855852` (PR #1677) |
| #1651 | closed | `d93aff8` (PR #1678) |
| #1652 | closed | `4d02df1` (PR #1679) |
| #1680 (from W4) | closed | `677e1bb` (PR #1686) |
| #1681 (from W4) | closed | `fd2a475` (PR #1687) |
| #1688 evidence reach at one dispatch site (option A, AC-3 amended) | closed | `1de9dd5` (PR #1690) |
| #1691 spec divergence parsed without a timestamp | closed | `b0eaf80` (PR #1693) |
| #1655 smoke | closed, owner: `SMOKE: ship` | — (gate) |
| #1656 pin | closed, route C | `admarble/harness` `d08032a`: `scripts/launch.sh` runs `~/.sequant/pins/2.20.0/node_modules/.bin/sequant`. OQ-5: no other repo needs a pin |
| #1657 release | closed, ACs 1–4 pass (comment on #1657) | `6c2f28ccc` (PR #1702, canary on a major), `63d74cb02` (PR #1701) |
| #1653 #1068 pre-registration (E8) | **open: waiting for the owner's approval** | — |
| #1654 hook precision, 50 labels | **open: waiting for the owner's labels** | — |

## After 3.0 (filed, outside this graph)

- #1682: CLI wrappers.
- #1689: the summary's "N unmet" counts gap bullets.
- #1692: the AC record is never refreshed.
- #1700: codex sandbox `git add` exits 128 on macOS 27.2.1. Local only; CI is green.
- #1662: `/assess`'s skill line (OQ-7: skill items run as their own PRs).

## Next

1. **Owner:** promote `latest` with `/release --soaked`, after the Step 9b checklist passes: the CI canary against the published tarball, then `npx sequant@next sync --dry-run` and `npx sequant@next doctor` in your own repos.
2. **Owner:** approve E8 (#1653), and confirm or correct the 50 labels (#1654). Then close tracker #1645.

## Rules that mattered

- **npm's publish notice can name the wrong tag.** A bare `npm publish` printed "Publishing to https://registry.npmjs.org/ with tag latest", but `publishConfig.tag: "next"` in `package.json` (#1098) won, and the registry put 3.0.0 on `next`. Read `npm view sequant dist-tags` after the publish becomes visible. Don't trust the log line, and don't move a tag based on it.
- **A publish answers `PUT 202`, then takes minutes.** It became visible about 6 minutes later (`.time["3.0.0"]` = `2026-11-18T05:29:01Z`). Until then, `npm view` returns 404 and the dist-tags look unchanged.
- **The first major release broke the canary fixture.** Deriving the "previous minor" from `X.0.0` fails. Since PR #1702 the fixture installs the last release of the previous major.
- **A runtime AC can't produce its own evidence when the runner is a pinned release.** #1688's first run built option B because the spec divergence marker lacked a timestamp and was silently dropped. That became #1691. A re-run of a `ready_for_merge` issue needs `--force`.
- **An AC that only a person can discharge** (an env-file command) can't pass in an unattended smoke. By the owner's decision, the re-smoke dropped it from issue A rather than grading around it.
- Don't build in this checkout while a run is live: its `dist/` is the binary the run executes (`npm link`). The harness no longer depends on it (#1656).
