gate(owner): hook precision — 50 pre-tool blocks from the frozen logs, stratified by rule, labelled true or false; counts per rule published, block text kept private

**Epic:** graph-2026-11-simplify   **Tier:** mechanical   **Execution:** owner   **Blocked by:** #S-00

- **Blocked by**: #S-00

## Problem

D-5: hand-label 50 of the pre-tool blocks before any hook change. The pre-tool hook (1,701 lines) is in the "in use, unmeasured" bin: it blocks often and no block has ever been labelled true or false. The 538 blocks the 2026-10-27 inventory counted are no longer on disk: `~/.sequant/logs/claude-hook.log` rotates and now holds 442 blocks from 2026-11-02 and 11-03. Three logs were frozen on 2026-11-04 (founding doc §4): 663 blocks over 14 rules. The sample frame is those copies. Founding doc P-11.

## The gate

- **Artifact reviewed:** a 50-row sheet in `admarble/smpl-sequant` at `evidence/hook-precision-2026-11/sample.md`, one row per block: source log, rule, the redacted command line, the runner's proposed label (`true` = the hook stopped something that should be stopped; `false` = it stopped legitimate work; `unsure`) and a one-line reason.
- **Question the owner answers, per row:** is the proposed label right? The owner edits any row they disagree with and signs the sheet.
- **Reject route:** a disputed sampling frame reopens this node's sampling step with a new seed recorded; labels never move a hook in this graph (D-5, §3).

## Procedure

1. Verify the three copies against their sha256 in founding doc §4.
2. Draw 50 blocks with a fixed, recorded seed, stratified by rule across all 663: proportional allocation, at least 2 for any rule with 2 or more blocks and 1 for a singleton, remainder by largest share.
3. The runner proposes a label for each from the block line and, where it exists, the transcript around it.
4. The owner confirms or corrects each row.
5. Publish counts only: `docs/evidence/hook-precision-2026-11.md` in sequant, one row per rule (blocks in frame, sampled, true, false, unsure) and the seed. No command text.

## Acceptance Criteria

- [ ] AC-1: The sheet has 50 rows and the owner's sign-off. Evidence: `grep -cE '^\| [0-9]+ \|' ~/Projects/smpl-sequant/evidence/hook-precision-2026-11/sample.md` → `50`
- [ ] AC-2: The published counts cover every sampled rule and sum to 50. Evidence: `awk -F'|' '/^\| [a-z-]+ \|/{s+=$4} END{print s}' docs/evidence/hook-precision-2026-11.md` → `50`
- [ ] AC-3: The published page carries no command text from the logs. Evidence: `grep -cE 'BLOCKED|git push|cat |printenv' docs/evidence/hook-precision-2026-11.md` → `0`

## May touch

`admarble/smpl-sequant`: `evidence/hook-precision-2026-11/` (new). `sequant-io/sequant`: `docs/evidence/hook-precision-2026-11.md` (new; lands through a docs PR).

## Non-Goals

- Changing any hook or rule (D-5).
- Publishing block text (I-6).

## Done when

Each rule's sampled precision exists as an owner-confirmed count in sequant's docs.
