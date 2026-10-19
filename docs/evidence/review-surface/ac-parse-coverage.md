# Per-AC status parse coverage over QA comments (#1524, RD-1)

**Status:** measured; RD-1 is a proposal until the owner confirms it on #1523.
**Measured:** 2026-10-19, against `main` at `ec9d583b4`, with `scripts/qa/ac-status-parse-coverage.ts`.
**Question:** can a parser read per-AC status out of the QA skill's prose well enough to ship (RS-02, #1525), or does the QA skill need a per-AC marker first?

---

## 0. What would make this measurement meaningless (written before the numbers)

- **Labels written to fit the parser.** If the ground truth were written after the parser, it could drift toward what the parser reads. The labels are in commit `909f068be`. The parser is in the next commit, `04f6142b3`. A reviewer can check the order with `git log --oneline -- __tests__/fixtures/qa-comments/expected.json scripts/qa/ac-status-parse-coverage.ts`.
- **One labeller.** The labels come from the exec agent, not the owner. A single labeller's reading of "PARTIALLY_MET" or "MET (locally) / PENDING (CI)" is a judgment. The owner's blind re-read in §5 is the agreement check, and it has not happened yet.
- **A wrong denominator.** If the denominator were the AC ids that the comment itself mentions, a comment that skips an AC would drop it from the count and coverage would look higher. The denominator here is the AC ids in each comment's issue body (`extractAcceptanceCriteria`).
- **A chosen sample.** The 12 fixtures were picked to cover formats (tables, bullet lists, failed verdicts, short follow-ups, rows with two status words), not drawn at random. Precision on the fixture is not precision on the corpus. It is the best number available with hand labels.

## 1. Corpus

Every comment in `sequant-io/sequant` created on or after 2026-08-01 whose body contains `<!-- SEQUANT_PHASE: {"phase":"qa"`. The `since` query parameter of the GitHub API filters on `updated_at`, so the script also filters on `created_at`. A comment that only quotes the marker in prose (for example the `/spec` comment on #1524) is not selected, because the selector needs the `<!--` prefix.

| Slice | Comments | Issue-body ACs | Classified | Coverage |
|-------|---------:|---------------:|-----------:|---------:|
| All | 76 | 343 | 275 | **80%** |
| `status: completed` | 61 | 265 | 198 | 75% |
| `status: failed` | 15 | 78 | 77 | 99% |

The issue counted 49 comments at planning. The spec counted 76 on the same day as this run, and so does the script. This run did not trace the cause of the difference. The selector is stated above, so the count can be reproduced.

20 of the 76 comments belong to issues whose body has no AC line that `extractAcceptanceCriteria` reads (no `- [ ]` checkbox, or no AC section). Those comments add 0 to the denominator. They are counted in `commentsWithoutIssueAcs`.

Parsed statuses over the corpus: 249 `met`, 19 `not_met`, 7 `pending`, 68 `unknown`.

## 2. The candidate parser

`parseAcStatuses(body, acIds)` in the script. For each AC id of the issue, it takes the first table row, list item or heading that *leads* with that id (the first cell of a table row, or the start of the item), and reads the first status token after the id: `NOT_MET` / `PARTIALLY_MET` → `not_met`, `MET` or ✅ → `met`, `PENDING` or ⚠ → `pending`, ❌ → `not_met`. It ignores free prose, ids outside the lead position, fenced code and HTML comments. `\b` treats `_` as a word character, so the verdict names `AC_NOT_MET` and `AC_MET_BUT_NOT_A_PLUS` inside description cells do not match.

## 3. Fixture: precision and recall

`__tests__/fixtures/qa-comments/`: 12 verbatim comments, named `<issue>-<commentId>.md`, and `expected.json` with 75 labels (53 `met`, 7 `not_met`, 8 `pending`, 7 `unknown`).

Labelling rule: the status the comment asserts for that AC, in a per-AC row or by an explicit collective claim ("All 7 ACs remain MET"). `PARTIALLY_MET` reads `not_met`. "MET (locally) / PENDING (CI)" reads `pending`, because the AC is not done until CI runs. No claim reads `unknown`.

Scoring: TP = the parse is not `unknown` and equals the label. FP = the parse is not `unknown` and differs from the label. FN = the label is not `unknown` and the parse is `unknown`.

| TP | FP | FN | Precision | Recall |
|---:|---:|---:|----------:|-------:|
| 65 | 2 | 1 | **97%** | 98% |

- **FP, 1265 AC-2 and AC-7.** The rows read `| AC-2 | MET (locally) / PENDING (CI) | …`. The parser takes the first token, `MET`. The comment's own verdict is `AC_NOT_MET`, and these two ACs are not done. This is the stray-`MET`-near-an-AC-id case from the issue, and it is real, not synthesized.
- **FN, 922 AC-3.** The comment closes the issue with the heading "Closing — AC-3 resolved against the gate". The word is "resolved", not a status token.

## 4. Where the corpus misses are

All 68 `unknown` parses in the corpus, by comment shape:

| Shape | Comments | Unknown ACs |
|-------|---------:|------------:|
| Short follow-up with no per-AC rows ("All 9 ACs were already MET", gap-closure notes, closing reports) | 9 | 60 |
| Full QA comment with a table that omits or rewords some ACs | 4 | 8 |

The follow-ups are the bulk of the gap. They restate the verdict for the issue as a whole and never repeat a per-AC row. A better regex cannot recover a status that the comment does not write per AC; it can only guess from a collective sentence such as "All 6 ACs are MET or PENDING", which is the false-positive shape that §3 measures. A per-AC marker would carry the status in every QA comment, follow-ups included.

## 5. Decision

RD-B rule: parser-now if coverage is 90% or more; otherwise marker-first. Coverage is 80%. Precision on the fixture is high, but RD-B sets no precision floor, and the gap is in comments that do not write per-AC status at all.

RD-1: marker-first — coverage 80% on 76 comments, precision 97% (fixture: 12 comments, 75 ACs, recall 98%)

This line is exec's proposal. RD-1 is a human approval point; the owner confirms or changes it on #1523.

### Blind re-read (owner)

Re-read (owner): pending — 8 fixtures listed below

Re-label these 8 without opening `expected.json`, then replace the line above with `Re-read: N of 8 agreed …`, where a fixture agrees when every AC label matches:

1. `879-5167288457.md` (bullet list, collective "All 7 ACs remain MET")
2. `922-5236374780.md` (closing report, no per-AC rows)
3. `927-5236440445.md` (table with MET and PENDING)
4. `939-5277343845.md` (table with verdict names in description cells)
5. `958-5389990054.md` (emoji status cells)
6. `975-5466166413.md` ("MET (metrics) / schema-only (marker)")
7. `1265-5933933577.md` ("MET (locally) / PENDING (CI)", PARTIALLY_MET)
8. `1487-6237541904.md` (failed verdict, PARTIALLY_MET)

## 6. Re-run

```bash
npx tsx scripts/qa/ac-status-parse-coverage.ts --since 2026-08-01          # live corpus; needs gh auth
npx tsx scripts/qa/ac-status-parse-coverage.ts --fixture                   # precision and recall, with each miss
npx vitest run scripts/qa/ac-status-parse-coverage.test.ts                 # offline
```

Comments posted after 2026-10-19 (including #1521's reviewer line) change the live numbers. The fixture does not change.
