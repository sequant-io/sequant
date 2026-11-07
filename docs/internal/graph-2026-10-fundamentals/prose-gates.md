# Prose-gate test files — execute, checksum or keep (#1511)

Input to F-12 (#1512) and the D-3 owner decision. This document classifies; it
changes no test.

## Method

**Selection.** A test file (`*.test.ts`, `*.spec.ts`, `.tsx` too) is a
prose-gate file when its text contains `SKILL.md` and matches
`toContain|toMatch`. This is the heuristic in `collectMetrics`
(`scripts/qa/health-report.ts`), so the list below is the same list that
`proseGate.files` counts. At `ec9d583b4` it selects 76 files, 30,693 lines.

> **Redefined in #1566.** `collectMetrics` no longer counts a file just because it
> contains `SKILL.md`. A file now counts only when it reads a skill file (a read
> call whose path argument names `SKILL.md`, or a variable assigned from such a
> path, or any use of `SKILL_ROOTS` outside a string), and calls `toContain|toMatch`, with
> comments stripped first. A variable assigned a bare relative path literal is a scratch
> fixture, not a read. The selection above is the old heuristic; the 34 files it drops
> are all `not a prose gate:` rows below, and `__tests__/quality-checks-worktree-root.integration.test.ts`
> joins (it reads through `SKILL_ROOTS` with no literal path). Net 63 to 30.

**Classes** (from the issue):

- **execute** — the skill section names a command or pattern the test can run
  (the #1290 pattern: extract the grep from the skill, run real grep on sample
  input). The row names the command, in backticks.
- **checksum** — the assertion checks that wording is present and nothing else.
  Deletable under D-3's default. The row names the asserted phrases.
- **keep** — the assertion guards a contract another tool parses (for example
  `lint:skill-gates` exact phrases, `Evidence:` grammar, the `SEQUANT_MUTATION`
  marker), or the test already exercises behaviour. It stays as is. The row
  names the parser or the behaviour.

**Unit.** One row per file. A file is classified by the assertions that read
skill prose.

**Mixed files (precedence).** A file with assertions of more than one class
takes the highest class in **keep > execute > checksum**. The reason cell gives
the other classes and an approximate count, for example
`keep (SEQUANT_MUTATION parser); also ~6 checksum phrases`. A plain `checksum`
label therefore means the file holds no keep or execute assertion, and F-12 can
act on the whole file.

**Not a prose gate.** A file where `SKILL.md` appears only as a path string (a
fixture file name, a sync target, an error message), and no assertion reads the
text of a real skill, is classed **keep** with the reason starting
`not a prose gate:`. F-12 leaves it alone. These files are counted separately
after the totals as an over-count in the metric.

**Process.** The rubric above was written before any file was read. The 76
files were split into 4 batches balanced by line count and each batch was read
by a separate agent that had only this rubric. A fresh agent then re-classified
8 rows blind (see Re-read).

## Table

Sorted by path. Line references are to the test file at `ec9d583b4`.

| Path | Class | Command, contract or phrases |
|------|-------|------------------------------|
| __tests__/integration/behavior-rule-qa-wiring.integration.test.ts | execute | Runs a hand-written snippet, not the skill's: extract the §6e `QA_AC_TEXT=... npx tsx -e` block from qa/SKILL.md and run it on the fixture. Prose reads today are ~7 checksum regexes (heading, findSurvivingInverseSymbols, env vars) at :52-75. |
| __tests__/integration/behavior-rule-spec-wiring.integration.test.ts | execute | Runs a hand-copied findTouchpoints snippet (:104-140): extract the spec skill's `SPEC_AC_TEXT=... npx tsx -e` block and run it instead. Prose reads today are ~8 checksum phrases (findTouchpoints, SPEC_AC_ID, Rule Touchpoints) at :38-58. |
| __tests__/integration/in-place-checkout-skill.integration.test.ts | keep | Already behaviour: extracts the in-place region's bash block, runs it with `bash -c` in a scratch clone and judges it with resolveIssueWorktree and verifyWorktreePath (:216, :238). Also ~15 checksum phrases (:260, :465). |
| __tests__/integration/qa-markdown-only-ci-snippet.integration.test.ts | execute | Runs a verbatim copy of the snippet: extract the `SEQUANT_QA_RELAX_FILES=... npx tsx -e` block from qa/SKILL.md and run that (:22, :46). Prose reads today are 6 checksum names (env vars, detectMarkdownOnlyDiff) at :116-121. |
| __tests__/integration/worktree-contract-skill.integration.test.ts | execute | Extract the guard block and run `npx sequant worktree verify <missing-or-foreign-path> --issue N` expecting exit 1 (:136, :148). Also ~20 checksum phrases (new-feature.sh at :98, SEQUANT_WORKTREE_* codes) and regex sweeps for glob offenders. |
| scripts/affected-tests-skill.test.ts | keep | Already behaviour: extracts the documented `grep -rlF "<changed path>"` and `grep -rlw SKILL_ROOTS` commands and runs them with execSync (:44, :51, :69); checks the `Evidence:` line (:37). Also ~6 checksum phrases (vitest list, --shard=1/3). |
| scripts/check-constitution-dod.test.ts | keep | Runs generateDodTable and parseStep4Branches on the real qa SKILL.md and asserts the constitution DoD region equals the output (:67, :91, :132-150). Also ~3 checksum: the spec cross-link phrase per copy (:184). |
| scripts/check-skill-sync.test.ts | keep | not a prose gate: SKILL.md is a temp fixture file name passed to collectFiles (:27-78). |
| scripts/exec-skill-marker.test.ts | keep | SEQUANT_MUTATION contract: runs parseMutationMarkers on the example marker taken from exec SKILL.md "Recording the mutation result" and asserts it is valid (:42-45). Also 3 checksum phrases (:29-31). |
| scripts/lint-skill-calls.test.ts | keep | not a prose gate: SKILL.md files are temp fixtures for the lintSkillCalls parser (:112-147). |
| scripts/lint-skill-gates.test.ts | keep | lint:skill-gates: runs parseVerdictAlgorithm, parseSections and parseEvidenceAcPattern on the real qa/SKILL.md (:76, :132, :462, :477, :509). Also ~2 checksum phrases in §2h (:488-489). |
| scripts/preexisting-claim-gate.test.ts | keep | lint:skill-gates grammar: the §7 token line `settle_evidence_status = ... Section 2a` and its Unbacked branch (:117-129). Also ~12 checksum phrases (settle-against-base.sh, "reverted first and debugged second") at :166. |
| scripts/spec/ground-check.test.ts | keep | not a prose gate: qa/SKILL.md is an index and citation path string for candidatePaths, resolvePath and extractCitations (:64, :123, :234, :256). |
| src/commands/__tests__/locks-cli.integration.test.ts | keep | not a prose gate: SKILL.md is only in the header comment (:5); the tests spawn the CLI and assert exit codes and JSON. |
| src/commands/doctor.test.ts | keep | not a prose gate: exec/SKILL.md is a mocked getSkillsCommitState path (:410); assertions read doctor output (:416). |
| src/commands/init.codex.integration.test.ts | keep | not a prose gate: SKILL.md is an existsSync install check (:218); assertions read the generated config.toml (:151-154). |
| src/commands/init.next-steps-1387.test.ts | keep | not a prose gate: SKILL.md is a stub fixture and a path argument (:47, :77); assertions read buildNextSteps output. |
| src/commands/serve.integration.test.ts | keep | not a prose gate: a fixture qa SKILL.md in a temp project (:42); assertions read stale-install stderr (:121-138). |
| src/commands/sync-source-invocation.integration.test.ts | keep | not a prose gate: SKILL.md is a sync-target path checked with fileExists (:119); assertions read CLI output (:132, :147). |
| src/commands/sync.install-scope.integration.test.ts | keep | not a prose gate: edits a real SKILL.md to cause drift (:140-152), then asserts areSkillsOutdated, runVersionPreflight and runSyncRemedy behaviour. |
| src/commands/sync.test.ts | keep | not a prose gate: SKILL.md appears as mocked manifest paths and dry-run output (:197, :793); readFile is mocked. |
| src/commands/update.integration.test.ts | keep | not a prose gate: a demo SKILL.md fixture template written by the test (:115, :148). |
| src/commands/update.test.ts | keep | not a prose gate: SKILL.md paths are mocked manifest entries (:90, :133). |
| src/commands/version-preflight.test.ts | keep | not a prose gate: a fixture `# custom qa` SKILL.md in a temp root (:33); asserts preflight leaves it untouched. |
| src/lib/__tests__/adr-convention.test.ts | checksum | spec/SKILL.md Design Review span: "when the recommended plan chooses between designs", "exec PR to include an ADR in docs/adr/" (:94-97). The ADR checks on docs are not skill prose. |
| src/lib/__tests__/assess-collision-detect.test.ts | keep | not a prose gate: SKILL.md paths sit in issue-body fixtures for extractPathsFromIssueBody (:246-255). |
| src/lib/__tests__/assess-skill.test.ts | execute | Already checks phases and flags against getPhaseNames() and the bin/cli.ts options (:50, :120, :133); the extracted example lines could run as `sequant run <N> --dry-run ...`. Also 1 mirror-identity check. |
| src/lib/__tests__/evidence-clause-skill.test.ts | checksum | "### 6h. Declared-Evidence Execution", "execute the exact backtick-quoted command", AC.evidence, declared_evidence_status pseudo-code and checklist lines (:53, :64, :73, :92, :104). Does not run the Evidence: parser. |
| src/lib/__tests__/exec-orchestrated-no-pr-skill.test.ts | keep | SEQUANT_MUTATION contract: buildAutomatedPRBody and parseMutationMarkers back the "markers inside the final ## Summary" claim (:81-95). Also ~9 checksum phrases (no gh pr create, --no-pr) at :59-76. |
| src/lib/__tests__/exec-pr-body-edit-skill.test.ts | checksum | "Do not change the PR's body or title by any means", "no gh pr edit", "no MCP tool", "put it in your final ## Summary" (:42-46), plus the qa §6i pointer line. |
| src/lib/__tests__/exec-skill-foreground-rule.test.ts | execute | §3 names `perl -e 'alarm shift; exec @ARGV' 600 <command>`: extract it and run it with a 1-second alarm on `sleep 5` to confirm the kill (:38). Also ~7 checksum phrases (foreground, coreutils, "exactly once per phase") at :32-49. |
| src/lib/__tests__/fullsolve-checkout-lock-skill.test.ts | execute | Extracts the bash fences but only counts sites by regex (:166, :197, :240): run the extracted `npx sequant locks checkout acquire --issue=<N> --skip-pid-check` and the matching release against a temp repo. Also ~20 checksum phrases in §0.3 (:76-130). |
| src/lib/__tests__/fullsolve-merge-gate-skill.test.ts | keep | allowed-tools frontmatter that Claude Code's permission system parses: no `Bash(gh pr merge:*)`, create and list kept (:142, :154-155). Also ~20 checksum phrases (--auto-merge, run.autoMerge, STOP before the merge) at :165-292. |
| src/lib/__tests__/improve-tech-debt-scoring-skill.test.ts | checksum | 6 category rows, "Score = (Impact + Risk) × (6 − Effort)", the tech-debt-scoring.md link, "Sort rows by Score, highest first", the I/R/E Score header (:63-88). |
| src/lib/__tests__/loop-context-source-skill.test.ts | execute | Step 1A names a jq filter: run the extracted `jq '.comments[]'` select on startswith("## QA Review for Issue") against a sample comments JSON (:170). Also ~10 checksum phrases; the sentinel checks at :137 use the runtime constant. |
| src/lib/__tests__/merger-checkout-lock-skill.test.ts | execute | Run the extracted `npx sequant locks checkout acquire --issue=N --skip-pid-check` and the release under a temp repo (:87, :158). Also ~8 checksum phrases ("first issue number" at :126, #906, SEQUANT_ORCHESTRATOR no-op). |
| src/lib/__tests__/merger-named-set-boundary-skill.test.ts | checksum | "halt", "named set", "#958", "Named-Set Boundary" in the boundary region and the Dependency and Stacked PR sections (:88-90, :101, :112). |
| src/lib/__tests__/mutation-verification-skill.test.ts | keep | lint:skill-gates: calls lintSkillGates on the shipped skill and expects zero violations (:130). Also ~9 checksum assertions on §6i status words and §7 AC_NOT_MET branches (:37, :65). |
| src/lib/__tests__/qa-followup-ledger-skill.test.ts | keep | lint:skill-gates parsers parseVerdictAlgorithm, parseTemplateSections and parseChecklists on each qa copy for followup_ledger_status (:77-80, :114-119). Also ~12 checksum ledger phrases (:95-107, :131). |
| src/lib/__tests__/qa-oneshot-skill.test.ts | keep | The `### Verdict:` line that parseQaVerdict reads (phase-executor.ts:506-510), asserted at :69. Also ~6 checksum phrases ("later turn", "background poll", "never end"). |
| src/lib/__tests__/qa-review-dimensions-skill.test.ts | checksum | The references/review-dimensions.md pointer in §2, checklist terms (xss, csrf, ssrf) present in the reference and absent from §2, "n+1" and "hardcoded secret" kept in §2 (:96, :117, :133-148). |
| src/lib/__tests__/qa-sibling-scan-skill.test.ts | checksum | parseSections only scopes §5; the assertions are wording: "name the **defect class**", "Class searched: <class>", "mark the AC PENDING", "NEEDS_VERIFICATION via pending_count" (:78-123). |
| src/lib/__tests__/qa-verdict-comment-skill.test.ts | checksum | §9 region: "### 9. Update GitHub Issue", "batch-executor.ts", "SEQUANT_QA_VERDICT", "#964", and the absence of "orchestrator handles aggregated summary" (:42, :51, :54). |
| src/lib/__tests__/release-checkout-lock-skill.test.ts | execute | Step 0 fence: run the extracted `npx sequant locks checkout acquire --issue=999999999 --skip-pid-check` and the release sites against a temp lock dir (:57-58, :133). Also ~8 checksum phrases (sentinel, --label, SEQUANT_ORCHESTRATOR no-op) at :86-92, :162-163. |
| src/lib/__tests__/release-plugin-validate-skill.test.ts | keep | Already behaviour: runs the extracted pre-flight bash fence through spawnSync bash -c with a stub claude and asserts exit status and call order (:132, :142). Also ~3 checksum phrases (manifest paths). |
| src/lib/__tests__/release-skill-security-table.test.ts | execute | Step 4.67's verify block: run the extracted `grep -qE` supported-versions check for `${new_minor}.x` against a fixture SECURITY.md. Today it only matches SECURITY.md, Supported versions and new_minor (:30-32). |
| src/lib/__tests__/release-skill-soak.test.ts | checksum | Order and wording: "npm publish --tag next" before the dist-tag latest line, "Soak checklist", "npx sequant@next sync --dry-run", "Without --soaked: refuse" (:50, :59, :68-71, :82). A publish cannot be run safely. |
| src/lib/__tests__/security-docs.test.ts | keep | Citation resolver over the docs/THREAT-MODEL.md defenses table: reads each cited SKILL.md only to check that the § heading exists and cited tokens resolve (:224-246, :274-294). |
| src/lib/__tests__/spec-design-review-skill.test.ts | keep | The SPEC_DIVERGENCE marker fields that parseSpecDivergence reads (:72). Also ~18 checksum phrases ("git log -S" at :50, "≥2 producers", constitution row). |
| src/lib/__tests__/spec-skill-self-skip-marker.test.ts | keep | The SEQUANT_SPEC marker restatement that SPEC_MARKER_REGEX (spec-recommendation.ts:40) parses, asserted at :33. Also ~3 checksum phrases ("restate it", "verbatim"). |
| src/lib/__tests__/testgen-skill.test.ts | checksum | "Sub-Agent Delegation for Stub Generation", subagent_type="sequant-testgen", "anthropics/claude-code#43869", "When to recommend testgen phase", "Skip testgen", "spec → testgen → exec → qa" (:31-150). |
| src/lib/__tests__/testgen-testing-pyramid-skill.test.ts | checksum | Pyramid level names, component-type labels, "When the spec's verification section names no test level", the testing-pyramid.md link (:59, :78, :90, :93). |
| src/lib/__tests__/trust-model-skill.test.ts | keep | lint:skill-gates grammar: the §7 step-2 token `trust_boundary_status = status from Section 6f`, the step-4 branch and the Simple Fix checklist entry (:145, :153). Also ~10 checksum phrases ("Trust-Boundary Check", trust-model.md pointer) at :74, :85. |
| src/lib/__tests__/writer-state-matrix.test.ts | keep | not a prose gate: spec/SKILL.md is a fixture destination for the writer matrix (:171); byte comparisons at :1008 check sync behaviour. |
| src/lib/ac-parser.test.ts | keep | not a prose gate: "SKILL.md" is a sample string for isGateTestEvidence (:1043); the file unit-tests the Evidence: grammar. |
| src/lib/assess/renderer.test.ts | keep | not a prose gate: SKILL.md is only in the header comment (:7); assertions read renderer output. |
| src/lib/assess/skill-examples.test.ts | keep | Production render() output must equal the assess SKILL.md worked examples byte for byte; RUN_COL and separator geometry in all three copies (:185, :202-230). |
| src/lib/heuristics/__tests__/behavior-rule-detector.test.ts | keep | not a prose gate: SKILL.md is inside verbatim #533 AC text passed to findTouchpoints (:220); assertions check the production walker's hits. |
| src/lib/locks/checkout-lock.test.ts | keep | not a prose gate: SKILL.md is in a code comment (:654); the assertion pins RELEASE_SENTINEL_ISSUE in code. |
| src/lib/merge-check/merge-check-extended.test.ts | keep | not a prose gate: qa/SKILL.md is a filesModified fixture path and expected message text (:370, :394, :411). |
| src/lib/merge-check/merge-check.test.ts | keep | not a prose gate: SKILL.md paths are filesModified fixtures and expected mirror-drift messages (:74-312). |
| src/lib/skills-commit-state.integration.test.ts | keep | not a prose gate: fixture SKILL.md files in a temp repo (:26, :76); assertions read commit-state warnings (:95, :138). |
| src/lib/stacks.no-npm-fallback-gate.test.ts | execute | "### 5. Detect Package Manager": run the extracted `[ -f "pnpm-lock.yaml" ]` chain in temp dirs seeded with each lockfile. Today it compares order to LOCKFILE_PRIORITY as text (:115). Also 1 checksum (:81). |
| src/lib/templates.test.ts | keep | not a prose gate: SKILL.md is a fixture and destination path for ownershipPolicy, templateDestination and sync targets (:360, :589, :936, :1230). |
| src/lib/verify-skill-guard.integration.test.ts | keep | Already behaviour: extracts the verify guard's bash block, checks allowed-tools pre-approves it, and runs it via sh -c with SEQUANT_PHASE (:72-90). Also ~4 checksum phrases (:58-61). |
| src/lib/workflow/drivers/__tests__/driver-conformance.test.ts | keep | not a prose gate: SKILL.md is only in comments (:613, :773); assertions check driver options and the opencode ndjson fixture. |
| src/lib/workflow/drivers/opencode.test.ts | keep | not a prose gate: SKILL.md is only in a comment (:542); assertions check parse and evaluateOpencodeRun on JSONL fixtures. |
| src/lib/workflow/model-ladder.test.ts | keep | SEQUANT_PHASE contract: passes exec and loop SKILL.md's own SPEC_DIVERGENCE marker line to parsePhaseMarkers and parseSpecDivergence (:1264-1309). Also 2 checksum phrases (:1318-1319). |
| src/lib/workflow/phase-executor.property.test.ts | keep | not a prose gate: SKILL.md is only in a comment (:122); property tests call parseQaSummary. |
| src/lib/workflow/phase-executor.test.ts | keep | not a prose gate: SKILL.md is in an expected error string (:2709); no skill text is read. |
| src/lib/workflow/qa-stagnation.test.ts | keep | not a prose gate: SKILL.md is only in a doc comment (:369); the test drives detectStagnation in a real worktree. |
| src/lib/workflow/run-orchestrator.test.ts | keep | not a prose gate: stub `# s` SKILL.md fixtures so the skills pre-flight passes (:280, :489). |
| src/lib/workflow/run-orchestrator.worktree-failure.test.ts | keep | not a prose gate: stub SKILL.md fixtures committed into a temp repo (:108); assertions cover worktree-failure behaviour. |
| src/lib/workflow/run-skills-commit-warning.integration.test.ts | keep | not a prose gate: stub SKILL.md fixture (:60); assertions read orchestrator console output (:113). |
| src/lib/workflow/skills-preflight.integration.test.ts | keep | not a prose gate: spec/SKILL.md is only in the expected abortReason message (:124). |
| src/lib/workflow/skills-preflight.test.ts | keep | not a prose gate: SKILL.md is a `# name` fixture asserted only as a missing path in the preflight result (:374, :634). |

**Totals:** execute 12, checksum 11, keep 53 (of which 34 not prose gates: `SKILL.md` appears only as a path, fixture, comment or message string)

## Re-read

**Selection.** Take the 76 paths in order of `sha1(path)` (the first 12 hex
digits from `printf '%s' "$path" | shasum -a 1`) and use the first 8. If a class
is missing from those 8, replace the 8th with the first path of the missing
class in the same order. The first 8 held no execute row, so
`scripts/check-skill-sync.test.ts` (8th) was replaced by
`src/lib/__tests__/release-skill-security-table.test.ts` (13th, the first
execute). A fresh agent received only the rubric and the 8 paths. It was told
not to open this document or its history.

**Re-read:** 7 of 8 rows agreed.

| # | Path | First pass | Re-read | Agreed |
|---|------|------------|---------|--------|
| 1 | src/commands/update.integration.test.ts | keep (not a prose gate) | keep (not a prose gate) | yes |
| 2 | scripts/exec-skill-marker.test.ts | keep | keep | yes |
| 3 | __tests__/integration/in-place-checkout-skill.integration.test.ts | keep | keep | yes |
| 4 | src/lib/workflow/drivers/__tests__/driver-conformance.test.ts | keep (not a prose gate) | keep (not a prose gate) | yes |
| 5 | src/lib/__tests__/qa-verdict-comment-skill.test.ts | checksum | checksum | yes |
| 6 | src/lib/assess/skill-examples.test.ts | keep | keep | yes |
| 7 | src/lib/__tests__/spec-design-review-skill.test.ts | keep | keep | yes |
| 8 | src/lib/__tests__/release-skill-security-table.test.ts | execute | checksum | no |

**Disagreement on row 8.** The re-read judged the test alone: it asserts only
three words in Step 4.67, so it found "nothing it could run". The first pass
read the skill section too. Step 4.67 ends in a bash verify block
(`new_minor=$(node -p ...)` then `grep -qE "^\| ${new_minor}\.x \|" SECURITY.md`)
that a test could run against a fixture `package.json` and `SECURITY.md`. The
rubric asks what the *section* names, not what the test does today, so the
table keeps `execute`. The split shows where the rubric is easiest to misapply:
a checksum test that sits on a runnable section looks like a checksum when only
the test is read. F-12 should open the skill section for every checksum row
before deleting it.

## Findings for #1512 and D-3

1. **The metric over-counts by 34 of 76 files.** In 34 files `SKILL.md`
   appears only as a fixture name, a mocked path, a comment or an expected
   message. Those 34 files hold 22,206 of the 30,693 counted lines. The real
   prose-gate population is 42 files and 8,487 lines. The heuristic in
   `collectMetrics` (`scripts/qa/health-report.ts`) cannot tell a path string
   from a read of skill text. This issue does not change the metric. A
   follow-up could count only files that read a file under a skill root
   (`SKILL_ROOTS` or a `skills/` path passed to `readFileSync`). A narrower
   metric would make `proseGate` track F-12's progress instead of fixture
   churn.
2. **11 files are pure checksum** and hold no keep or execute assertion. F-12
   can act on each whole file under D-3's default: adr-convention,
   evidence-clause, exec-pr-body-edit, improve-tech-debt-scoring,
   merger-named-set-boundary, qa-review-dimensions, qa-sibling-scan,
   qa-verdict-comment, release-skill-soak, testgen, testgen-testing-pyramid.
   None of them is the only guard on a section that a live parser reads.
   `qa-verdict-comment` names the `SEQUANT_QA_VERDICT` marker, but the
   runtime emits that marker and the parser reads the runtime's output, not
   the prose.
3. **12 files are execute candidates, in three groups.**
   - *Checkout lock* (3 files: fullsolve-, merger- and release-checkout-lock):
     each extracts the same `npx sequant locks checkout acquire ... --skip-pid-check`
     / `release` fences and only counts them. One shared harness that runs the
     extracted fences against a temp lock dir serves all three.
   - *Hand-copied `npx tsx -e` snippets* (3 files: behavior-rule-qa-wiring,
     behavior-rule-spec-wiring, qa-markdown-only-ci-snippet): these already
     run code, but a copy of the snippet, not the snippet in the skill. The copy
     can drift from the skill without failing. Extracting the block from
     SKILL.md is the highest-value conversion in the set.
   - *Single commands* (6 files): worktree-contract (`sequant worktree verify`),
     assess-skill (`sequant run --dry-run`), stacks.no-npm-fallback-gate
     (lockfile detection chain), exec-skill-foreground-rule (`perl` alarm),
     loop-context-source (`jq` select), release-skill-security-table
     (`grep -qE` on SECURITY.md).
4. **Mixed keep files carry most of the remaining checksum phrases.** With
   keep > execute > checksum precedence, 19 files with a real contract or
   behaviour are classed keep, and several also hold 10 to 20 checksum phrases
   (fullsolve-merge-gate ~20, spec-design-review ~18, in-place-checkout ~15,
   preexisting-claim-gate ~12, qa-followup-ledger ~12, trust-model ~10). If
   D-3 deletes checksum assertions inside these files, it is a per-assertion
   edit. The keep label means F-12 must not delete the whole file.
5. **Execute rows are also checksum-heavy.** Most execute files carry 6 to 20
   checksum phrases besides the runnable section. Converting the runnable part
   does not by itself retire the phrase checks.
