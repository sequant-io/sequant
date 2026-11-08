# Handoff: graph-2026-11-simplify, W1 run (2026-11-07)

`main` = `a5bba3067` (after #1658, #1660 and #1659). Tracker #1645. Merge consent: **stop at every PR** (I-5).

## Ledger

| Node | State | Verdict, then runner checks and fixes |
|---|---|---|
| #1646 repeat halt | **merged** as `f5489a8fe` (PR #1660), issue closed | QA `NEEDS_VERIFICATION` (CI pending only). Runner re-ran all 6 ACs: pass. Fix `997ae80da`: two unused exports made file-local. Opus ×3 confirmed |
| #1649 label test-add | **merged** as `a5bba3067` (PR #1659, after a main merge at `073467f80`, CI green), #1649 and #1631 closed | QA `AC_MET_BUT_NOT_A_PLUS`. Runner re-ran all 4 ACs: pass. Fix `05e9a7a5b`: `docs/features/assess-minimal-flags.md` no longer says a UI label adds `test`. `/assess`'s skill line filed as #1662 (OQ-7 candidate) |
| #1653 #1068 pre-reg | draft committed in smpl-sequant (`abcd80f`), **waiting for the owner's approval** | E8: block stage (−P/−F/−G/−K) then sections, #1272's threshold and zero-spread rule, ceiling $150. Once approved: a decision-log row, then the `SEQUANT_PREREG` comment on #1068 |
| #1654 hook precision | sheet with proposed labels in smpl-sequant (`430f878`), **waiting for the owner's labels** | Frame corrected: 469 of 662 records are test fixtures (comment on #1654). 50 of 193 drawn by rule. Proposed: 9 true, 32 false, 9 unsure |
| #1656 pin | **owner's gate** | Finding (comment on #1656): the harness runs this checkout's `dist/` through the global `npm link`, so route A doesn't pin. Route C offered: an absolute-path install under `~/.sequant/pins/2.20.0` |
| #1647 ladder removal | **frontier** (#1646 merged) | W2; launches on the owner's word |
| #1648 to #1657, other nodes | blocked | |

## Next

1. **Owner:** approve E8 (#1653); confirm or correct the 50 labels (#1654); pick the pin route (#1656); answer OQ-7.
2. **W2: #1647** (judgment, all-opus) now unblocked. Launch exactly as W1: a one-shot launchd plist running `npx sequant@2.20.0 run 1647 --phases spec,exec,qa -Q --no-tui -v` from this checkout on `main`, with the tier flip and an `EXIT`-trap restore (script pattern in X-1 to X-3, founding doc §7). Context comment first: the `SPEC_DIVERGENCE` halt and #1646's `loopHalted` must survive, and `divergence-halt.ts` stays.
3. Then W3 #1648, then W4 #1650, #1651, #1652 (§8 waves).

## Rules that mattered

- Don't build in this checkout while a run is live: its `dist/` is the binary the run (and the harness) execute.
- PR #1370 (changelog fragments) is active. If it merges first, the changelog ACs in later nodes need rewording (context comments say so).
- The monitor filter must include `SUMMARY` and the `== … exit=` lines; the job's end is the `.done` file plus `cmp` of the settings.
