# Prose-gate test files — execute, checksum or keep (#1511)

Input to F-12 (#1512) and the D-3 owner decision. This document classifies; it
changes no test.

## Method

**Selection.** A test file (`*.test.ts`, `*.spec.ts`, `.tsx` too) is a
prose-gate file when its text contains `SKILL.md` and matches
`toContain|toMatch`. This is the heuristic in `collectMetrics`
(`scripts/qa/health-report.ts`), so the list below is the same list that
`proseGate.files` counts. At `ec9d583b4` it selects 76 files, 30,693 lines.

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
