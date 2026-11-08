# Handoff: graph-2026-11-simplify, W1 run (2026-11-07)

`main` = `a5bba3067` (after #1658, #1660 and #1659). Tracker #1645. Merge consent: **stop at every PR** (I-5).

## Ledger

| Node | State | Verdict, then runner checks and fixes |
|---|---|---|
| #1646 repeat halt | **merged** as `f5489a8fe` (PR #1660), issue closed | QA `NEEDS_VERIFICATION` (CI pending only). Runner re-ran all 6 ACs: pass. Fix `997ae80da`: two unused exports made file-local. Opus ×3 confirmed |
| #1649 label test-add | **merged** as `a5bba3067` (PR #1659, after a main merge at `073467f80`, CI green), #1649 and #1631 closed | QA `AC_MET_BUT_NOT_A_PLUS`. Runner re-ran all 4 ACs: pass. Fix `05e9a7a5b`: `docs/features/assess-minimal-flags.md` no longer says a UI label adds `test`. `/assess`'s skill line filed as #1662: post-3.0, its own PR (OQ-7, answered 2026-11-06: none join) |
| #1653 #1068 pre-reg | draft committed in smpl-sequant (`abcd80f`), **waiting for the owner's approval** | E8: block stage (−P/−F/−G/−K) then sections, #1272's threshold and zero-spread rule, ceiling $150. Once approved: a decision-log row, then the `SEQUANT_PREREG` comment on #1068 |
| #1654 hook precision | sheet with proposed labels in smpl-sequant (`430f878`), **waiting for the owner's labels** | Frame corrected: 469 of 662 records are test fixtures (comment on #1654). 50 of 193 drawn by rule. Proposed: 9 true, 32 false, 9 unsure |
| #1656 pin | **owner's gate** | Finding (comment on #1656): the harness runs this checkout's `dist/` through the global `npm link`, so route A doesn't pin. Route C offered: an absolute-path install under `~/.sequant/pins/2.20.0` |
| #1647 ladder removal | **frontier** (#1646 merged) | W2; launches on the owner's word |
| #1648 to #1657, other nodes | blocked | |

## Next

1. **Owner:** approve E8 (#1653); confirm or correct the 50 labels (#1654); pick the pin route (#1656).
2. **W2: #1647** (judgment, all-opus) now unblocked. Launch exactly as W1: a one-shot launchd plist running `npx sequant@2.20.0 run 1647 --phases spec,exec,qa -Q --no-tui -v` from this checkout on `main`, with the tier flip and an `EXIT`-trap restore (script pattern in X-1 to X-3, founding doc §7). Context comment first: the `SPEC_DIVERGENCE` halt and #1646's `loopHalted` must survive, and `divergence-halt.ts` stays.
3. Then W3 #1648, then W4 #1650, #1651, #1652 (§8 waves).

## Rules that mattered

- **A spec phase rebuilt the live binary mid-run.** `dist/` in this checkout was rebuilt at 2026-11-08T00:25Z, three minutes into #1646's run, while its spec phase (which runs in the main checkout) was live. The source was `7337cdd39`, identical to `31c6f8bdc` in `src/`, `bin/` and `package.json`, so W1's binary code didn't change. With the checkout now at `a5bba3067`, the same thing in W2 would put the W1 code into the binary the harness runs (X-2). Land #1656's pin before W2, or check `stat dist/bin/cli.js` after each run and rebuild from `research-baseline-2026-11-03` if it moved.
- Worktrees for #1646 and #1649 were removed after merge (both clean, nothing unpushed). Their remote branches are kept. The main checkout is fast-forwarded to `a5bba3067` for W2's spec; `dist/` was not rebuilt.
- `CHANGELOG.md`'s `[Unreleased]` has two `### Added` headings. They were already there at `7337cdd39`, so W1 didn't cause it; #1657's release PR should fold them.

- Don't build in this checkout while a run is live: its `dist/` is the binary the run (and the harness) execute.
- PR #1370 (changelog fragments) is active. If it merges first, the changelog ACs in later nodes need rewording (context comments say so).
- The monitor filter must include `SUMMARY` and the `== … exit=` lines; the job's end is the `.done` file plus `cmp` of the settings.
