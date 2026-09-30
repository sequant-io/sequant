# Advisor tool on `exec` — Phase 0 measurement (#1138)

**Status:** complete. **Verdict: NO-GO** for the build track (AC-3…AC-7). See [§6](#6-verdict).
**Measured:** 2026-09-30, 01:32–08:18 CDT, sequant built from `5dc4ff63` (the #1227 fix), Claude Code CLI 2.1.285, Sonnet 5 exec at `effort: medium`, Opus 5.5 as the advisor.
**Runs:** 18 scored plus 1 smoke run. 3 source issues × 2 arms × 3 reps, arms interleaved, sequential, one fresh fixture issue per run.
**Costs:** every dollar figure is the SDK's `costUSD` estimate (the #986 convention). They are not a billing statement.

---

## 0. What would make this measurement meaningless (written before the numbers)

- **Power.** At 9 runs per arm, a binary outcome only reaches p < 0.05 (two-sided Fisher) for splits like 5/9 vs 0/9, 6/9 vs 1/9, or 8/9 vs 2–3/9. Any smaller quality difference is invisible here. A "no difference" result means "no difference this large", not "no difference".
- **Treatment leakage.** If the advisor reached spec or qa in only one arm, a verdict difference could come from a different plan or a different judge, not from exec. Spec and qa ran with `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` in both arms (§1). The transcripts confirm 0 advisor calls in every spec and qa session.
- **Treatment absence.** If the committed `advisorModel` never reached the exec worktree, arm B was arm A with extra ceremony. The worktree's `.claude/settings.json` read `{"advisorModel":"opus"}` in every advisor run, and 8 of 9 advisor exec phases have an Opus `phaseUsage` row (§3).
- **Stranded runs.** Three runs (2 advisor-off, 1 advisor-on) ended exec without committing (§4). QA reviewed the uncommitted working tree and still passed them. Their verdicts are reported both included and excluded.

**Null criterion from #1138:** if advisor-on and advisor-off show the same verdict mix and loop count, the build track closes as not needed. That is what happened.

## 1. Design

- **Sources:** #946, #947, #973, the three merged issues from #916's phase-0 bench. Each was replayed in a private fixture fork pinned at its pre-fix base commit, with the issue body copied and no comment history. Each fork ships that base commit's skills (August 2026). The arms are identical in this respect.
- **Arms:** both arms commit a local `bench-arm` branch and run every phase with `--base bench-arm`. The only difference between arms is that branch's single commit.
  - **off:** an empty commit.
  - **advisor:** the commit sets `.claude/settings.json` `advisorModel: "opus"`.
  - The advisor has to be committed because sequant cuts the phase worktree from the base ref, so an uncommitted setting never reaches the phase. The claude-code driver loads project settings only, so a user-scope `advisorModel` never reaches phases at all.
- **Phases:** three invocations per run: `spec`, `exec`, and `qa` (the last two with `--force`, because the spec-only invocation marks the issue complete).
  - spec and qa: Sonnet, advisor disabled in both arms.
  - exec: Sonnet at `effort: medium`, advisor per arm.
  - `qualityLoop: false`, `--no-pr`.
- **Order:** reps 1 and 3 run off→advisor, rep 2 runs advisor→off, and the sources rotate within each rep.
- **Tool pinning:** sequant ran from a dedicated clone at `5dc4ff63`, not the shared dev `dist/`. That avoids #916 confound 2, where the code changed under the bench.
- **Collected per run:** the run logs, `metrics.json` (avoiding #916 confound 3), diff file lists, wall time per phase, and the phase transcripts. Transcripts were used only to count advisor calls and to classify the stranded runs. They are retained locally and are not published.

## 2. Results

Verdicts are the first qa verdict. RFM = `READY_FOR_MERGE`, A− = `AC_MET_BUT_NOT_A_PLUS`, NOT_MET = `AC_NOT_MET`.

| Source | Arm | Verdicts (r1, r2, r3) | Exec wall s | Exec $ (total) | of which advisor $ | Stranded |
|---|---|---|---|---|---|---|
| #946 | off | A−, RFM, RFM* | 519, 544, 325* | 1.64, 1.85, 1.16* | — | 1 |
| #946 | advisor | RFM, RFM, RFM | 1341, 918, 1168 | 10.10, 3.80, 2.71 | 5.84, 0.76, 0.61 | 0 |
| #947 | off | NOT_MET, A−*, A− | 442, 258*, 646 | 1.18, 0.85*, 1.28 | — | 1 |
| #947 | advisor | A−, RFM, A− | 476, 1070, 710 | 2.32, 2.20, 2.43 | 0.45, 0.57, 0.60 | 0 |
| #973 | off | A−, RFM, A− | 808, 445, 854 | 1.51, 1.17, 1.14 | — | 0 |
| #973 | advisor | A−, A−, RFM* | 833, 497, 250* | 2.00, 2.53, 0.83* | 0.47, 0.45, 0* | 1 |

\* = stranded run (§4).

| Measure | off (n=9) | advisor (n=9) | Difference |
|---|---|---|---|
| RFM | 3/9 | 5/9 | Fisher p = 0.64 |
| NOT_MET | 1/9 | 0/9 | p = 1.0 |
| RFM, stranded runs excluded | 2/7 | 4/8 | p = 0.61 |
| Loop iterations | 0 | 0 | **By design** (`qualityLoop: false`, matching #916's baseline), not a measured null |
| Stranded (exec ended without committing) | 2/9 | 1/9 | — |
| Exec wall, median | 519 s | 833 s | **+60%** |
| Exec cost, median | $1.18 | $2.43 | **×2.1** |
| Sonnet-only exec cost, median (advisor row removed, non-stranded runs) | $1.28 | $1.97 | **+54%** |
| Advisor row share of exec cost, median | — | 23% | range $0.45–$5.84 per run |
| `metrics.tokensUsed` per run, median | 57,059 | 174,114 | ×3.1. Advisor input is uncached and counts toward `tokensUsed`; cache reads don't |
| File-set Jaccard vs the reference PR | varies | varies | Direction flips by source, as in #916. No ranking |

## 3. Advisor behavior in `exec`

- **Calls per phase:** 0 in every spec and qa session; that's the kill switch, not the advisor declining. In exec:
  - 7 of 9 runs made exactly 1 call.
  - `946-advisor-r1` made 8 calls, and its advisor row alone was $5.84.
  - The stranded run made 0.
- **Where calls land:** at 0.30–0.93 of each exec session's assistant turns (median about 0.6), after orientation and mostly around the implementation-to-verification turn. None came at the very start.
- **Cost shape:** the advisor row is always uncached (`cacheReadTokens: 0`), at 90k–150k input per call on these issues. It shows up in `modelUsage`, and therefore in `phaseUsage`, as its own `claude-opus-5-5` key. No code change was needed to see it.
- **The finding that matters:** the advisor's own tokens are only part of the extra cost. The Sonnet exec spend also rose 54%, and wall time rose 60%. After consulting the advisor, the main model does more work. This is the main per-phase cost signal, and it is larger than the 17–20% per-turn overhead observed in interactive sessions.

## 4. Stranded runs

Three exec phases (`946-off-r3`, `947-off-r2`, `973-advisor-r3`) started the full test suite in the background, said they would wait for its completion notification, and the session ended without a commit. That is the failure mode #1032 addressed, and it recurs here because the fixture forks ship pre-#1032 skills.

In all three, qa then reviewed the uncommitted working tree and returned a passing verdict (2 RFM, 1 A−). That is a separate trust gap, noted here but out of scope for #1138.

The split was 2 off and 1 advisor, so stranding doesn't separate the arms.

## 5. Background parallel-group implementers (AC-1's subagent question)

**Structural null.** No exec phase in either arm spawned a subagent: none of these issues' specs produced a `## Parallel Groups` section that exec acted on. So this run cannot answer whether background parallel-group implementers inherit the advisor.

All 15 subagent transcripts came from qa quality checkers, which ran with the advisor disabled. They appear in 4 of 9 scored advisor-arm qa sessions (plus the smoke run) and 0 of 9 off-arm sessions. qa had no advisor in either arm, so that difference comes from the diffs qa was judging, not from the advisor.

A field observation from interactive sessions on one account in 2026-09: background subagents did call the advisor. That points against upstream #76381, but it isn't phase evidence.

## 6. Verdict

**NO-GO for the build track (AC-3…AC-7).**

- **Quality:** advisor-on shows no verdict difference that 9 runs per arm can detect. The RFM trend (5/9 vs 3/9, 4/8 vs 2/7 excluding stranded runs) points toward the advisor, but it is well inside noise at p ≈ 0.6. There is one NOT_MET, in the off arm.
- **Cost:** exec cost roughly doubles and exec wall time rises 60%.
- **Why that's enough:** #1138's null criterion is met, and the cost is large and certain while the benefit, if any, is below what this bench can see.

**What would reopen it.** A single experiment of the same shape at 3× the runs per arm won't do it: it could only detect differences like 8/9 vs 2/9. Either of these is a new hypothesis for a new issue:
- the retry-rung design: advisor only on a quality-loop retry, so its cost lands only where a first pass already failed;
- a larger, cross-judged replay with verdict discharge, per #916's minimum fixes.

## 7. Limitations

- **Sample:** 3 sources and 9 runs per arm, one repo, all small issues (reference PRs of 78–342 changed lines).
- **Judge:** qa was Sonnet in both arms, not cross-judged. NV-free verdicts are still claims; none were discharged by executing the ACs.
- **Fixture skills:** the forks ship the base commits' August 2026 skills, pre-#1032, which is why stranding recurs. Current skills may behave differently.
- **Advisor model:** only Opus 5.5 advising Sonnet 5 was measured. A Fable advisor, or an Opus-on-Opus pairing, is untested.

## 8. Artifacts

Retained locally, not committed:
- per-run results: run logs, `metrics.json`, diff lists, wall times, transcripts;
- the bench driver and analysis script;
- the manifest mapping each cell to its fixture issue.

The fixture forks are private scratch repositories.
