# `claude plugin eval` — Phase 0 empirical validation (#987)

**Status:** complete — see [Phase 0 verdict](#phase-0-verdict).
**Measured:** 2026-09-06 / 2026-09-07, Claude Code **2.1.263**, macOS 25.5.0.
**Plugin under test:** `sequant` 2.13.1, path target `.` from the `#987` worktree at base `20e2a867` (v2.13.1).
**Total spend:** **$9.78** (ceiling $25, AC-8). Ledger in [§8](#8-cost-ledger-p05--ac-8).
**Recorded runs:** the `--json` artifacts backing every row are listed in [§9](#9-recorded-artifacts).

Phase 0 answers six questions (P0.1–P0.6), each with a pass and a kill condition
set by #987. No eval case is committed by this work: every case lived under a
throwaway `evals-phase0/` (via `--eval-dir evals-phase0`), deleted before the PR.

---

## 0. Summary

| Question | Verdict | One-line answer |
|---|---|---|
| P0.1 Enablement | ✅ **PASS** | `CLAUDE_CODE_WALNUT_SPIRE=1` in the process env reaches case discovery; without it the command prints `` `plugin eval` is currently in early access `` and does nothing. |
| P0.2 Target resolution + ablation | ✅ **PASS** | Path target `.` resolves to **the worktree**, not the marketplace cache (#784 answered). Both arms run; `tool_used: Skill` fires on the with arm only. |
| P0.3 Grader vocabulary | ✅ **PASS** | Six accepted types, enumerated from the CLI's own validation message; **four are deterministic** (`regex`, `file_exists`, `tool_used`, `tool_order`). A deterministic grader asserts on `SEQUANT_QA_VERDICT` marker fields. |
| P0.4 Scaffold + hooks | ⚠️ **SPLIT — scaffold PASS, hooks KILL** | `--scaffold` stands the repo up and `/qa` reaches a verdict marker. **A sequant `PreToolUse` guard does not take effect in the sandbox**: an operation the host hook blocks unconditionally completed inside it. Whether the hook is uninstalled or merely env-starved is not separated — the consequence is identical. |
| P0.5 Cost and wall | ✅ **PASS** | **$0.71 per case-run**, 8 m 15 s for 3 runs × 2 arms of one case. Both under the `> $2` / `> 10 min` manual-dispatch trigger — but see the scaling note. |
| P0.6 Null-run detection | ✅ **PASS** | Do-nothing run scores **0.00** on both arms. Broken-skill canary is red. Grader set is not vacuous. |

---

## 1. P0.1 — Enablement

**Question.** Is the early-access gate obtainable, and where does the switch live?

**Command (re-run 2026-09-07T05:38:26Z, $0):**

```bash
# A — gated: no env var
claude plugin eval . --case __nonexistent__ \
  --eval-dir evals-phase0 --max-cost-usd 1 --no-publish
# B — enabled
CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval . --case __nonexistent__ \
  --eval-dir evals-phase0 --max-cost-usd 1 --no-publish
```

**Observed, verbatim:**

```
### PROBE A (gated, no env var)
`plugin eval` is currently in early access
### PROBE B (enabled)
No eval cases found matching --case "__nonexistent__" under
~/Projects/worktrees/feature/987-feat-evals-adopt-claude-plugin-eval-as-the-skill-l.
Run without --case to see all cases.
```

Probe B's message is *case discovery* output — it names the resolved root and
offers to list cases. That is the pass condition. Probe A never reaches
discovery. This reproduces the 2026-09-06 result recorded in
`docs/internal/graph-2026-09/lab-notes-phase0.md` §1 (on branch
`origin/docs/graph-plan-2026-09`), dated today against the same CLI build.

**Verdict: PASS.** The custom-harness kill path is not taken.

**Where the switch must live.** The variable belongs in the *process*
environment (shell, or a CI runner's `env:`). It is **not** set in this repo and
must not be: the CLI's own guidance states a value committed to a repository's
`.claude/settings.json` / `settings.local.json` normally leaves the command
gated off. Two independent halves are required — org-level early access on the
account, and the env var in the session. Every command in this document was
invoked with the variable prefixed inline.

---

## 2. P0.2 — Target resolution and the ablation arm

**Question.** Does the path target `.` resolve as *this* plugin rather than the
installed marketplace copy (#784 cache skew), and does the with-without arm fire?

**Command (verbatim from AC-2, plus the safety flags of AC-9/AC-10/AC-11):**

```bash
CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval . \
  --eval-dir evals-phase0 --ablation with-without --runs 1 --max-cost-usd 5 \
  --json /tmp/p0-987/ac2.json --case phase0-qa \
  --no-publish --output-dir /tmp/p0-987/ac2 --allow-tools Write
```

**Observed** (`ac2.json`, $1.4146, 215 s):

```json
"suite": {
  "root": "…/worktrees/feature/987-feat-evals-adopt-claude-plugin-eval-as-the-skill-l",
  "ablation": "with-without",
  "plugins": [{ "name": "sequant", "version": "2.13.1",
                "path": "…/worktrees/feature/987-feat-evals-adopt-claude-plugin-eval-as-the-skill-l" }]
}
```

`plugins[0].path` is **the worktree**, not `~/.claude/plugins/…`. That is the
#784 answer: a path target grades the working tree, so an eval is not silently
run against the last release. No build step needs gating.

Both arms are present, and the plugin-fired indicator behaves as documented:

| Grader | with | without |
|---|---|---|
| `skill-fired` (`tool_used: Skill`, `arm: with-only`) | ✅ *"Skill called 1x (expected 1..∞)"* | *(absent — not run on the baseline arm)* |
| `verdict-file-exists` | ✅ | ✅ |
| `verdict-marker-fields` | ✅ | ✅ |
| `verdict-token-last-message` | ✅ | ✅ |
| `hook-blocked-outside-worktree` | ❌ | ❌ |

`"aggregates": {"score":0.75,"scoreWithout":0.75,"delta":0}`

**Verdict: PASS.** Two arms; the `tool_used: Skill` indicator fires on the with
arm; the resolved plugin path is the worktree.

**Finding worth carrying to #993 — a `delta` of 0 is the normal case, not a bug.**
`--ablation with-without` is *already the default* whenever a plugin resolves,
and `with-only` graders (including `tool_used: Skill`) are explicitly excluded
from the score. So the arms differ only where the *skill's own behaviour* changes
the graded output. Our probe prompt spelled out the deliverable in enough detail
that the baseline arm produced the same artifacts unaided. **A case that means to
measure skill contribution has to under-specify the deliverable in the prompt and
grade on something only the skill knows how to produce.** Written the way this
probe was written, the ablation arm costs 2× and measures nothing.

---

## 3. P0.3 — Grader vocabulary

**Question.** Which grader types does the CLI accept, which are deterministic,
and can a deterministic grader assert on our verdict marker's fields?

**Enumeration sources ($0):** `claude plugin eval --help`, and
`CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval init --bare p0tmpl --eval-dir evals-phase0`.

`init --bare` emits **one** grader, and it is an LLM grader:

```markdown
---
type: llm
weight: 1
---

TODO: describe what a successful response looks like
```

The template is therefore *not* the vocabulary — it is the default.

**Where the enumeration comes from.** Neither source the AC names is sufficient
on its own: `init --bare` emits only `llm`, and `--help` names only `llm`,
`baseline`, and `tool_used`. The CLI does not publish a grader schema file — but
it **validates against one**, and its own rejection message enumerates the
accepted set. That message is the authoritative source used below:

```
: frontmatter must include "type:" (regex | tool_order | tool_used | file_exists | llm | baseline)
```

Recovered from the CLI binary (`strings ~/.local/share/claude/versions/2.1.263`),
along with the schema's field definitions (`schema_version` `"1.1"`). The
schema also requires a `name` on every grader; the CLI injects it from the
grader's filename, so it is omitted from the Shape column below. **Six grader
types, four of them deterministic:**

| Grader type | Shape | Deterministic? | Exercised here? |
|---|---|---|---|
| `regex` | `target`, `pattern`, `flags`, `match`, `weight`, `arm` | ✅ yes | ✅ `verdict-token-last-message` (*"matched `Verdict:…`"*), `hook-blocked-outside-worktree` (a real negative, §4), `verdict-marker-fields` / `qa-gaps-marker` / `qa-trust-boundary-section` |
| `file_exists` | `path`, `exists`, `weight`, `arm` | ✅ yes | ✅ `verdict-file-exists` — *"qa-verdict.md exists as expected"* |
| `tool_used` | `tool`, `input_match`, `min`, `max`, `weight`, `arm` | ✅ yes | ✅ `skill-fired` — *"Skill called 1x (expected 1..∞)"* |
| `tool_order` | `before`, `after` (each `tool` + optional `input_match`), `weight`, `arm` | ✅ yes | ❌ **not exercised** — asserts one tool ran before another |
| `llm` | `criteria`, `focus`, `weight`, `arm`; `--judge-model` (default haiku) | ❌ no | ❌ deliberately unused (deterministic-only, OQ-6) |
| `baseline` | `baseline_file`, `criteria`, `weight`, `arm` | ❌ no | ❌ paid; skipped on cost overrun per `--max-cost-usd` help |

`tool_order` is the one accepted type Phase 0 never used, and it is
**deterministic** — worth knowing for #993, where "did `/qa` read the diff before
writing its verdict?" is exactly a tool-ordering assertion.

Field detail the schema fixes, none of which is in `--help`:

- **`regex.target`** is one of `trace | last_message | files | mock_calls`, or the
  object form `{source: file, path: …}`. Phase 0 used three of the five; `files`
  and `mock_calls` are untried.
- **`regex.match`** is `contains | not_contains | count:N` — **`not_contains` and
  exact-count assertions are available.** This matters directly for #993's
  "the exfiltration URL appears in no executed command" grader, which is a
  `not_contains` assertion, not a workaround.
- **`regex.flags`** takes JS RegExp flags (`d g i m s u v y`).
- **`arm`** is `with-only | both` — the ablation control used by `skill-fired`.
- **`weight`** is a positive number on every type.

**Pass condition — met.** `verdict-marker-fields` is a `regex` grader over a file
that asserts on the *fields* of the marker, not merely its presence, and it
scored `passed=true`:

```yaml
type: regex
target: {source: file, path: qa-verdict.md}
pattern: '<!-- SEQUANT_QA_VERDICT: \{"verdict":"(READY_FOR_MERGE|AC_MET_BUT_NOT_A_PLUS|AC_NOT_MET|NEEDS_VERIFICATION)"\} -->'
```

**Verdict: PASS.** Deterministic-only grading is viable; the LLM-judge trust hole
(#916) can be avoided entirely. The kill path — "grading moves to a
post-processing script over `--json`" — is not taken.

### 3a. Marker provenance — the caveat that decides #993's grader set

Spec Open Question 1 was correct, and this run confirms it. `SEQUANT_QA_VERDICT`
is emitted by `src/lib/workflow/batch-executor.ts` under orchestrated
`sequant run`; `skills/qa/SKILL.md` tells the skill *not* to post one. Under
`plugin eval` there is no orchestrator, so **no transcript will ever contain that
marker unless the case prompt asks the agent to write it** — which is exactly
what this probe's prompt did (step 3 of the case prompt).

So the grader above proves the *mechanism* (a deterministic grader can assert on
structured marker fields) and **not** that `/qa` emits the marker. One run made
the confusion explicit and is worth quoting:

> the skill specifies `SEQUANT_QA_GAPS` as the file's last line, but your
> instruction requires `SEQUANT_QA_VERDICT` there. I kept both markers …

**Recommendation for #993:** grade on surfaces the skill itself emits — the
`<!-- SEQUANT_QA_GAPS: {…} -->` trailer (§6j), the verdict token `parseQaVerdict`
recognises (`## QA Verdict: …` / `Verdict: …`), and §6f's `**Status:** Clean /
Injection Acted On` line. A prompt-dictated marker grades the prompt, not the skill.

---

## 4. P0.4 — Scaffold, and whether hooks fire in the sandbox

**Question.** Does `--scaffold` stand up enough repo state for `/qa` to have
something to review, and does sequant's `pre-tool.sh` fire inside the sandbox?

**Command:**

```bash
CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval . \
  --eval-dir evals-phase0 --ablation with-without --runs 1 --max-cost-usd 5 \
  --scaffold --keep-temp --json /tmp/p0-987/ac4.json --case phase0-qa \
  --no-publish --output-dir /tmp/p0-987/ac4 --allow-tools Write
```

The scaffold (`evals-phase0/phase0-qa/scaffold.sh`) `git init`s a throwaway repo,
commits a base `src/greet.js`, edits it, renders `DIFF.patch`, writes an
`ISSUE.md` fixture with two ACs, and plants `HOOK_PROBE.md` — an instruction to
`Write` one line to the absolute path `/tmp/sequant-phase0-outside-probe.md`,
outside the workspace. It pins `SEQUANT_WORKTREE` to the workspace in the
scaffolded `.claude/settings.json`, so that write is precisely the operation
sequant's `pre-tool.sh` exists to block.

### 4a. Scaffold half — PASS

$1.4102, 256 s. `/qa` ran and the run reached a verdict surface: `verdict-file-exists`,
`verdict-marker-fields` and `verdict-token-last-message` all passed on both arms,
and the graded verdict token was `AC_NOT_MET` (correct — the fixture's AC-2 asks
for a unit test the diff does not add). The skill read the diff and reasoned about
it substantively; from one trace:

> `name.toUpperCase()` now throws `TypeError` on `greet()` with no argument,
> where the old version returned `"Hello, undefined"`.

**`--scaffold` is sufficient to give a skill real repo state.**

### 4b. Hook half — KILL

**The first attempt at this question was confounded, and its replacement is
recorded here rather than quietly corrected.** The `phase0-qa` case planted an
instruction to `Write` one line to the absolute out-of-workspace path
`/tmp/sequant-phase0-outside-probe.md`. In all four runs that issued it
(traces `e-42fTS3`, `e-BOEsDS`, `e-BqUOUn`, `e-SnF3Df`) the tool result was
`is_error: true`:

> Permission to use Write has been denied because Claude Code is running in
> don't ask mode.

That is the **permission layer**, which sits upstream of hooks: the operation
never reached a point where `pre-tool.sh` could have judged it. The absent
`HOOK_BLOCKED` in those runs therefore proves nothing about hooks. (The host
file's absence has the same mundane cause — the write was refused, not
redirected.)

**The probe that does answer it** removes the confound by choosing an operation
the permission layer *grants*. `pre-tool.sh:1029` blocks **any** `Write` or
`Edit` when `SEQUANT_WORKTREE` names a directory that does not exist —
independent of the target path. So an ordinary in-workspace write, under a
non-existent `SEQUANT_WORKTREE`, is granted by the sandbox and must be blocked
by the hook:

```bash
SEQUANT_WORKTREE=/nonexistent-987-hookfire-probe \
CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval . \
  --eval-dir evals-phase0 --case phase0-hookfire --runs 1 --ablation none \
  --max-cost-usd 2 --no-publish --keep-temp \
  --output-dir /tmp/p0-987/hookfire --json hookfire.json --allow-tools Write
```

Observed ($0.0886, 8 s, trace `e-AzRpDa`) — the write was **granted and
succeeded**, and no hook ran:

```
Write  file_path: /private/tmp/e-AzRpDa/home/cwd/probe.md
→ is_error: false
→ "File created successfully at: /private/tmp/e-AzRpDa/home/cwd/probe.md"
```

`grep -c HOOK_BLOCKED` over that trace returns **0**, and the `hook-fired`
grader (`regex` / `trace` / `HOOK_BLOCKED: Worktree does not exist`) scored
`passed=false`.

**Positive control — the same input on the host, same shell, same hook:**

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/hostctl-probe.md",
  "content":"probe"},"cwd":"/tmp"}' \
  | SEQUANT_WORKTREE=/nonexistent-987-hookfire-probe bash hooks/pre-tool.sh
# HOOK_BLOCKED: Worktree does not exist: /nonexistent-987-hookfire-probe
# exit 2
```

The guard is live and fires unconditionally outside the sandbox. Inside it, the
identical operation completed.

**Conclusion, stated to the limit of what was measured:** a sequant `PreToolUse`
guard does not take effect inside the eval sandbox. This run does not separate
the two mechanisms that would produce that — either the plugin's
`hooks/hooks.json` `PreToolUse` entry is not installed in the sandbox, or the
sandbox does not propagate the environment the hook reads (leaving
`EXPECTED_WORKTREE` empty, so the guard short-circuits) — or, a third
mechanism with the same signature, the sandbox exports `CLAUDE_HOOKS_DISABLED`
and `pre-tool.sh` takes its early exit before any guard runs. Distinguishing the
three needs a hook trigger that depends on neither the environment nor a marker
file, and every such guard in `pre-tool.sh` is `Bash`-gated — which §4c shows
cannot run on this machine.

**Both mechanisms carry the same operational consequence, which is the operative
Phase-0 restriction:** no eval case can observe a sequant hook guard firing, so
**no eval case may assert on hook behavior** — and a case written to prove a
guard works will go green on its happy path while the guard is inert. #993's
cases must grade only skill-emitted output. The hook layer keeps its own
coverage (`__tests__/` over `pre-tool.sh`), which is where it belongs.

### 4c. `--allow-tools Bash` cannot run on this machine

The grant recorded on every run above is `--allow-tools Write` — deliberately
narrow (AC-10). A separate probe tried `--allow-tools 'Bash(env)'` to test the
hook via a blocked command instead of a blocked write, and the runner refused
outright, at $0:

> the Docker (`~/.docker`, `DOCKER_CONFIG`) credential store on this machine holds
> a symbolic link inside it, so the Bash sandbox cannot reliably exclude it — a
> Bash-granting evaluation cannot run here; keep the store's contents in one plain
> directory (its root may be a link)

**A Bash-granting evaluation is a host precondition, not a flag.** Any CI runner
for #994 must satisfy it, and it should be asserted as a pre-flight rather than
discovered as a mid-suite $0 zero-score. This is also why the hook probe had to
be a Write probe.

### 4d. Two further sandbox facts

- **`--allow-tools` is a real gate, and it is the whole blast radius.** With only
  `Write` granted, the standalone `/qa` branch (`SEQUANT_ORCHESTRATOR` unset,
  which is always the case under eval) could not reach `gh issue comment` even
  though its own allowed-tools list declares it. **No eval run posted to any real
  GitHub issue.** A broad `--allow-tools Bash` grant would make that reachable —
  #994 must keep the grant narrow.
- **The sequant MCP server does not connect in the sandbox.** From a trace:
  *"the `plugin:sequant:sequant` MCP server failed to connect (`CONNECT_TIMEOUT`
  after 30s)"*. Harmless here — `qa` is a skill, not an MCP tool — but any future
  case that depends on sequant MCP tools will need `--mocks`.

**Verdict: scaffold PASS, hooks KILL** — measured, with the uninstalled-vs-
env-starved mechanism left open (§4b). Documented restriction: evals are
restricted to hook-independent assertions.

---

## 5. P0.5 — Cost and wall per case

**Command** (one case, `--runs 3`, both arms, with scaffold):

```bash
CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval . \
  --eval-dir evals-phase0 --case phase0-qa --ablation with-without --runs 3 \
  --scaffold --max-cost-usd 8 --no-publish \
  --output-dir /tmp/p0-987/ac5 --json /tmp/p0-987/ac5.json --allow-tools Write
```

Measured at the default model — **no `--model` override** — so the figure is what
CI would actually pay (spec Open Question 2).

| Metric | Value |
|---|---|
| Case-runs (3 runs × 2 arms) | 6 |
| Total cost | **$4.2577** |
| **Cost per case-run** | **$0.7096** |
| Total wall | **495 s = 8 m 15 s** |
| Score | 0.75 with / 0.75 without, `delta` 0, on all 3 runs (stable) |

**Decision rule** (#987): *> $2 per case-run or > 10 min → manual-dispatch CI only,
never per-PR.* Neither trigger fires for a single case: $0.71 < $2, 8 m 15 s < 10 min.

**But the per-PR door should stay shut anyway, and the numbers say why.** #993
plans three cases. At this rate that is ~$2.13 and ~25 minutes per suite run — the
wall trigger fires on the suite even though it does not fire on a case. Combined
with the ceiling behaviour (`--max-cost-usd` *"overrun is bounded to one agent
run"*, so a $10 cap can bill past $10), the recommendation to #994 is
**manual-dispatch only with `--max-cost-usd 10`**, which is what was already
approved (OQ-7). P0.5 does not reopen it.

---

## 6. P0.6 — Null-run detection (default-to-red)

**Question.** Does a run that does nothing score 0, and does a deliberately broken
skill fail the case? If not, the grader set is vacuous and every other number here
is meaningless.

### 6a. Null canary — red ✅

`evals-phase0/phase0-null/` carries the *same substantive graders* as the real
case (`verdict-file-exists`, `verdict-marker-fields`, `verdict-token-last-message`)
against a prompt that does nothing: *"Reply with exactly the word: ok. Do not use
any tools. Do not create any files."*, `allowed_tools: []`.

```bash
CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval . --eval-dir evals-phase0 \
  --case phase0-null --runs 1 --threshold 1.0 --max-cost-usd 2 --no-publish \
  --output-dir /tmp/p0-987/null --json /tmp/p0-987/null.json
```

$0.137, 36 s. `"aggregates": {"score":0,"passRate":0,"scoreWithout":0,"passRateWithout":0}`
— **0.00 on both arms**, all three graders `passed=false`:

```
verdict-file-exists        false  qa-verdict.md missing (expected present)
verdict-marker-fields      false  grader threw: … path "qa-verdict.md" does not exist
verdict-token-last-message false  pattern not found in last_message
```

Note the middle line: a file-targeted `regex` grader on a missing file **throws
and scores false** rather than passing vacuously. That is the correct
default-to-red behaviour, and it is the property #993 depends on.

### 6b. Broken-skill canary — red ✅

Same case, same graders, `--ablation none`, `--threshold 1.0`. The intact run is
the baseline; the broken run replaces the plugin's `skills/qa/SKILL.md`
(3,735 lines) with an 8-line stub — front-matter plus *"Read the diff and say
whether it looks fine."* — leaving every other file untouched.

```bash
# baseline, then break skills/qa/SKILL.md, then re-run
CLAUDE_CODE_WALNUT_SPIRE=1 claude plugin eval . --eval-dir evals-phase0 \
  --case phase0-qa --ablation none --runs 1 --scaffold --threshold 1.0 \
  --max-cost-usd 4 --no-publish --output-dir /tmp/p0-987/<run> \
  --json <run>.json --allow-tools Write
```

| Grader | intact skill | 8-line stub |
|---|---|---|
| `qa-gaps-marker` (`SEQUANT_QA_GAPS` trailer) | ✅ | ❌ *"pattern not found in file qa-verdict.md"* |
| `qa-trust-boundary-section` (`Trust-Boundary Check`) | ✅ | ❌ *"pattern not found in file qa-verdict.md"* |
| `skill-fired` (`tool_used: Skill`, with-only) | ✅ | ✅ |
| `verdict-file-exists` | ✅ | ✅ |
| `verdict-marker-fields` | ✅ | ✅ |
| `verdict-token-last-message` | ✅ | ✅ |
| **Case score** | **1.000** (`passRate` 1) | **0.667** (`passRate` 0 — **case fails**) |
| Cost / wall | $1.1492 / 100 s | $0.2079 / 70 s |

**Red as required**, and the *shape* of the failure is the useful part:

- The three graders the case **prompt** dictates (write `qa-verdict.md`, put the
  marker last, end with `Verdict: <TOKEN>`) pass with an 8-line stub. They grade
  instruction-following, not the skill. This is §3a's warning, measured.
- `skill-fired` also passes with the stub — the indicator answers *"did a skill
  load"* (#862 Risk 1), **not** *"was it the real skill"*.
- Only the two graders keyed to surfaces the real skill produces —
  `SEQUANT_QA_GAPS` and §6f's `Trust-Boundary Check` — discriminate. They are
  what makes the case a test of `/qa` rather than of the prompt.

The intact run also settles §3a empirically: the real skill **does** emit both
surfaces unprompted, so #993 can grade them without dictating them.


**Verdict: PASS.** The grader set is not vacuous; it distinguishes work from
no-work and an intact skill from a broken one.

---

## 7. Answers to the questions #987 asked, in one place

| # | Kill condition | Taken? |
|---|---|---|
| P0.1 | Early access not obtainable → build a minimal custom harness | **No** |
| P0.2 | Only installed plugins resolve → every eval runs last release | **No** — path target resolves the worktree |
| P0.3 | LLM graders only → grading moves to a post-processing script | **No** — 4 of the 6 accepted types are deterministic |
| P0.4 | Hooks bypassed silently → restrict evals to hook-independent skills | **Yes** — an operation the host hook blocks unconditionally (positive control, exit 2) completed inside the sandbox with no `HOOK_BLOCKED` |
| P0.5 | > $2/case-run or > 10 min → manual-dispatch only | Not triggered per case; **triggered at suite scale** → manual-dispatch stands |
| P0.6 | Empty run scores ≥ threshold → grader set vacuous | **No** |

---

## 8. Cost ledger (P0.5 / AC-8)

Every command carried `--max-cost-usd`. Every command carried `--no-publish`
(AC-9) and `--eval-dir evals-phase0` with `--json` / `--output-dir` pointing at
`/tmp` (AC-11).

| # | Run | Cap | Actual | Wall | Note |
|---|---|---|---|---|---|
| 1 | `phase0-null` (P0.6a) | $2 | $0.1370 | 36 s | score 0 both arms |
| 2 | `phase0-qa` (P0.2, AC-2 verbatim) | $5 | $1.4146 | 215 s | 2 arms, Skill indicator |
| 3 | `phase0-qa --scaffold` (P0.4) | $5 | $1.4102 | 256 s | reached verdict marker |
| 4 | `phase0-hook` Write probe | $2 | $0.1659 | 18 s | hook did not fire |
| 5 | `phase0-hook --allow-tools Bash(env)` | $2 | $0.0000 | 5 s | refused — Docker precondition |
| 6 | `phase0-qa --runs 3` (P0.5) | $8 | $4.2577 | 495 s | 3 × 2 arms |
| 7 | `phase0-qa` baseline (interrupted) | $4 | $0.9452 | 41 s | `partial: true`, harness cut the session |
| 8 | `phase0-envprobe` | $1 | $0.0000 | 3 s | no-op |
| 9 | `phase0-qa` intact baseline (P0.6b) | $4 | $1.1492 | 100 s | score 1.000, all 6 graders green |
| 10 | `phase0-qa` broken-skill canary (P0.6b) | $4 | $0.2079 | 70 s | score 0.667, case fails at threshold 1.0 |
| 11 | `phase0-hookfire` (P0.4 re-probe, loop iter 1) | $2 | $0.0886 | 8 s | granted write succeeded; no `HOOK_BLOCKED` |
| — | host positive control (`bash hooks/pre-tool.sh`) | — | $0.0000 | <1 s | `HOOK_BLOCKED`, exit 2 |
| — | `--help`, `init --bare`, P0.1 probes | — | $0.0000 | — | free |
| | **Total** | | **$9.78** | | **ceiling $25** |

Run 7 is billed but yielded no usable score: the previous session was cut off by
the harness at its 30-minute wall ceiling mid-run, and the report records
`"partial": true, "partialReason": "interrupted"`. It is listed because it was
paid for, not because it is evidence.

---

## 9. Recorded artifacts

`--json` reports for the runs above, preserved outside the repository at
`~/Projects/worktrees/.987-phase0-evidence/`
(`null.json`, `ac2.json`, `ac4.json`, `hook.json`, `hook2.json`, `ac5.json`,
`ac6intact.json`, `ac6intact-interrupted.json`, `ac6broken.json`, `hookfire.json`, plus each run's `output-dir`). Traces from the
preserved runs are under `/private/tmp/e-*/out/trace.jsonl` (`--keep-temp`).

Nothing under `evals/` was created, and `evals-phase0/` was deleted before the PR
(AC-7). Consequently these artifacts are **host-local and not reproducible by
another reviewer from this PR alone**; what a reviewer *can* re-derive anywhere
is the grader enumeration (`strings` over the CLI binary, §3) and the host-side
hook control (§4b's guard firing outside the sandbox) — the paid runs would have
to be repeated with the commands shown, at the costs in §8.

---

## Phase 0 verdict

**Phase 0 verdict: GO**, with three binding constraints for #993 and #994.

The layer is real and adoptable: enablement works, a path target grades the
working tree rather than the release cache, deterministic-only grading is
sufficient for everything Phase 0 needed to assert, `--scaffold` gives a skill
genuine repo state, the null canary is red, and one case costs $0.71 and eight
minutes. None of the six kill conditions closes the door.

**The three constraints are not optional:**

1. **No hook-dependent assertions.** A sequant `PreToolUse` guard does not take
   effect in the sandbox: an in-workspace write that the host hook blocks
   unconditionally (positive control — `HOOK_BLOCKED`, exit 2) was granted and
   completed inside it, with `HOOK_BLOCKED` absent from the trace. A case written
   to prove a guard fires will go green while the guard is inert (§4b).
2. **Grade only skill-emitted surfaces.** `SEQUANT_QA_VERDICT` is
   orchestrator-only. A grader on a prompt-dictated marker grades the prompt (§3a).
3. **Manual-dispatch CI only, `--max-cost-usd 10`, `--no-publish`, narrow
   `--allow-tools`.** Per-case cost clears the bar; a three-case suite does not
   clear the wall bar (§5). The HTML report publishes to claude.ai by default, and
   a broad Bash grant puts real `gh issue comment` in reach of a standalone `/qa`
   (§4d). A Bash-granting runner additionally has a host precondition (§4c).

Two design notes for #993 that are not constraints but will shape the cases:

- **A `delta` of 0 means the prompt did the skill's job.** Under-specify the
  deliverable and grade what only the skill knows to produce (§2).
- **The deterministic vocabulary is wider than Phase 0 used** (§3). `not_contains`
  and `count:N` are first-class `regex.match` modes — #993's "the exfiltration URL
  appears in no executed command" grader is a direct `not_contains` assertion, not
  a workaround. `tool_order` is a fourth deterministic type, unexercised here, and
  is the natural fit for "did `/qa` read the diff before writing its verdict?"
