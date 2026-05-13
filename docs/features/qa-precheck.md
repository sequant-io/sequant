# QA Precheck (Phase 0c)

A short, deterministic script that runs before the `/qa` agent and writes its findings to `.sequant/gap-precheck.json`. The QA skill reads the file and skips three of its inline gap-checks, paying less token cost and producing a faster fail signal when something deterministic is wrong.

You don't normally invoke this directly — `/qa` runs it as Phase 0c. The output file is what's user-visible.

## Prerequisites

1. **sequant initialized** — `.sequant/` exists in the repo
2. **`gh` authenticated** — needed to read the GitHub issue body
3. **`jq` installed** — consumed by `/qa`'s fallback shell snippets (most macOS / Linux installs have it)

## What the Precheck Does

Three deterministic gap-checks are extracted from `/qa`'s prompt and run as a script:

| Check | What it finds | Replaces inline section |
|---|---|---|
| `fixtures` | Verbatim motivating-example code fences / blockquotes from the issue body | §6c Step 4, §6d Q1 |
| `siblingGrep` | Changed identifiers from the diff that have call/use sites elsewhere in the codebase | §5 Sibling-site Scan |
| `acLiteralDiff` | AC checkbox IDs present in the issue body but missing from the PR body | §1 AC Literal Verification |

Three other checks stay inline because they require judgment:

- §6c detection-pattern verification (cheaper as a conditional inline grep)
- §6d adversarial re-read (judgment-only)
- §4 Q5 intra-file sibling-line audit (judgment-only)

## What You See in `/qa` Output

When the precheck runs, `/qa` includes a **Precheck Findings** table near the top of its review:

```
**Precheck Findings**

| Check          | Status         | Detail                              |
| -------------- | -------------- | ----------------------------------- |
| fixtures       | pass           | 2 fenced blocks extracted           |
| siblingGrep    | fail           | 1 identifier with 3 unverified sites |
| acLiteralDiff  | not_applicable | no PR body yet                      |
```

If the precheck didn't run, you get a single line instead:

```
**Precheck Findings:** unavailable — inline fallback used.
```

Either path produces a correct verdict; the precheck just saves tokens and surfaces failures faster.

## Running the Precheck Manually

```bash
# Issue only (no PR yet)
npx tsx scripts/qa/precheck.ts --issue 604

# Issue + PR
npx tsx scripts/qa/precheck.ts --issue 604 --pr 623

# Custom output path
npx tsx scripts/qa/precheck.ts --issue 604 --out /tmp/precheck.json
```

The script always exits 0. Findings live in the JSON; consumers (the `/qa` skill, custom tooling) decide gating.

## Output Schema — `.sequant/gap-precheck.json`

```json
{
  "schemaVersion": 1,
  "issue": 604,
  "pr": 623,
  "generatedAt": "2026-05-11T18:42:01.123Z",
  "checks": {
    "fixtures": {
      "status": "pass",
      "count": 2,
      "fixtures": [
        {
          "kind": "fenced",
          "label": "Repro",
          "content": "▸ #614  spec\n✔ #614  spec  5m 13s\n...",
          "line": 18
        }
      ]
    },
    "siblingGrep": {
      "status": "fail",
      "identifiers": [
        {
          "name": "applyRowCap",
          "definedIn": "src/lib/cli-ui/run-renderer.ts",
          "siblingSites": [
            "src/lib/cli-ui/run-renderer.test.ts:120",
            "src/lib/cli-ui/format.ts:88"
          ]
        }
      ]
    },
    "acLiteralDiff": {
      "status": "not_applicable",
      "issueACs": [],
      "prACs": [],
      "missingInPR": []
    }
  }
}
```

| Status | Meaning |
|---|---|
| `pass` | Check completed cleanly. Findings (if any) are surfaced for agent judgment. |
| `fail` | Deterministic failure: missing AC IDs, sibling sites the diff didn't touch, etc. |
| `not_applicable` | Check skipped (e.g. no issue body, no PR yet, no changed identifiers). |

`schemaVersion` is checked by `/qa` — mismatched versions trigger the inline-fallback path.

## What to Expect

- **Best-effort.** A missing or malformed `gap-precheck.json` never blocks the QA run. The `/qa` skill falls back to its pre-#609 inline behavior.
- **Token savings.** Three sections of `/qa` no longer prompt the agent to do extraction work the script already did. Net cost reduction varies by PR — most savings come on PRs with many fixtures or wide cross-file impact.
- **Runs once per `/qa` invocation.** The script is fast (seconds); the JSON file is overwritten each time.
- **Safe to delete.** Removing `.sequant/gap-precheck.json` just forces `/qa` into the fallback path on the next run.

## Reference

| Flag | Required | Default | Description |
|---|---|---|---|
| `--issue <N>` | yes | — | GitHub issue number; the issue body is the source for fixture and AC extraction. |
| `--pr <P>` | no | — | PR number; needed for `acLiteralDiff` to compare PR body to issue body. |
| `--out <path>` | no | `.sequant/gap-precheck.json` | Override output location. |

## Troubleshooting

### `/qa` says "precheck unavailable — inline fallback used"

**Cause:** Either the script didn't run, `jq` failed to parse the JSON, or `schemaVersion` doesn't match what `/qa` expects.

**Fix:** Run `npx tsx scripts/qa/precheck.ts --issue <N>` manually and inspect `.sequant/gap-precheck.json`. If `schemaVersion` is missing or != 1, upgrade sequant. If `jq` is missing, install it.

### `siblingGrep.fail` but the sibling sites are intentional

**Cause:** The check surfaces *candidates*; it's agent-judgment to dismiss false positives.

**Fix:** No action — `/qa` will inspect each surfaced site and decide whether it's a real gap. You can also delete the precheck file to skip the check entirely.

### Precheck found motivating-example fixtures my implementation already handles

**Cause:** This is the expected path. The fixtures get listed so the QA agent can verify each one against the implementation per `feedback_motivating_example_regression.md`.

**Fix:** No action — fixture extraction is informational input, not a failure.

---

*Documents issue #609 (extract deterministic QA gap-checks into precheck script).*
