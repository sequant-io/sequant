# ADR-0007: A deferred QA finding carries its resolution as a description suffix

**Status:** Accepted
**Date:** 2026-10-03
**Issue:** #1249

## Context

Root causes are found, then dropped. The re-patch retrospective (#1236)
counted 80 upstream causes or sibling sites raised across 40 fix issues;
22 of them were raised by spec, QA or the PR and then neither filed nor
fixed, and several came back as new bugs. QA already emits its deferred
items as data: `SEQUANT_QA_GAPS` findings with
`recommendedAction: "document"`. Nothing made anyone resolve them, and
nothing carried them to the PR.

`/qa` now keeps a Follow-up Ledger (§7): every deferred item ends
`filed #N`, `fixed in this PR` or `dropped: <reason>`, and an unresolved
item caps the verdict at `AC_MET_BUT_NOT_A_PLUS`. The orchestrator renders
the latest QA pass's `document` findings as a `## Follow-ups` checklist in
the PR body (`renderFollowups`, `worktree-manager.ts`). The PR body needs
each finding's resolution, and the issue's Non-Goals rule out changing the
`SEQUANT_QA_GAPS` schema.

## Decision

QA writes the resolution as a suffix on the finding's `description`:
` — filed #N`, ` — fixed in this PR` or ` — dropped: <reason>`.
`renderFollowups` parses that suffix. A finding without one renders as an
unchecked `unresolved` line. The suffix is a parse contract between the QA
skill's §7 Follow-up Ledger and `FOLLOWUP_RESOLUTION_RE`.

## Options

### Option A: description suffix (chosen)

**Pros:** no schema change; the PR body reads only the existing marker
channel; an old QA output with no suffix degrades to "unresolved", which is
the honest reading. **Cons:** the contract lives in prose and a regex
rather than a type.

### Option B: parse the ledger table out of QA's prose

Rejected: a second channel next to the marker. Prose parsing is what #921,
#1119 and #1194 kept re-patching.

### Option C: a `resolution` field on `GapFindingSchema`

Deferred, not rejected: it is a schema change, a Non-Goal of #1249. It is
the upgrade path if the suffix proves fragile: add the optional field, let
`renderFollowups` prefer it, keep the suffix as a fallback.

## Consequences

- The PR body shows every deferred QA finding, so a dropped follow-up is
  visible at merge time instead of only in a QA comment.
- QA still never files issues itself; the runner or owner does, and the
  verdict stays below `READY_FOR_MERGE` until they have.
- Only the latest QA pass's findings render (`latestPhaseResult`), since an
  earlier pass describes code a quality-loop iteration has since changed.
