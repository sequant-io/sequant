# Unified /assess Command

The `/assess` command is the single entry point for issue triage. It analyzes an issue's state, runs health checks, and recommends exactly one action from a fixed vocabulary. If the action is PROCEED, it includes a full workflow plan with CLI command.

## Prerequisites

1. **GitHub CLI** — `gh auth status` (must be authenticated)
2. **sequant initialized** — `ls .sequant/` (project must have sequant set up)

## What You Can Do

**Assess a single issue:**
```
/assess 123
```

**Assess multiple issues independently:**
```
/assess 152 153
```

**Use the deprecated /solve alias:**
```
/solve 123
```
Shows a deprecation notice, then runs `/assess`.

## What to Expect

`/assess` is read-only. It never makes changes, creates branches, or executes workflows. It analyzes and recommends.

Every assessment recommends exactly one of six actions:

| Action | Meaning | When |
|--------|---------|------|
| **PROCEED** | Ready for work | Issue is clear, codebase matches, no blockers |
| **CLOSE** | Outdated or resolved | Resolved by another PR, references gone, duplicate |
| **MERGE** | Overlaps with another issue | Two issues cover 70%+ same scope |
| **REWRITE** | PR/branch needs fresh start | PR too far behind main, files diverged |
| **CLARIFY** | Needs more information | No ACs, ambiguous requirements |
| **PARK** | Valid but not actionable now | Blocked on dependency, explicitly deferred |

## Output Format

The action is always the headline — scannable in under 5 seconds:

```
#152 — Add user dashboard
Status: Open | Labels: ui, enhancement | Last activity: 3 days ago

-> PROCEED — Issue is clear, codebase matches, ready for work.

Health:
  [check] References match codebase
  [check] No conflicting PRs or worktrees
  [check] No overlapping issues detected
```

For **PROCEED**, the output also includes:
- AC coverage (MET/IN_PROGRESS/NOT_STARTED/UNCLEAR per item)
- Full workflow recommendation with `npx sequant run` command
- Flags table (-q, --chain, --qa-gate, --base, --testgen) with reasoning
- Label review with suggestions
- Confidence level

## Health Checks

`/assess` runs four categories of health checks before recommending an action:

**Codebase Match** — Do files/APIs referenced in the issue still exist? Were they recently changed?

**PR/Branch Health** — Is the PR behind main? Are there merge conflicts? Is the branch stale?

**Overlap/Redundancy** — Does another open issue cover the same scope? Was this solved by another PR?

**Staleness/Blockers** — No activity in 14+ days? Blocked on another issue? Open questions unanswered?

## Machine-Readable Markers

When you save the assessment to the issue, `/assess` embeds HTML markers that downstream tools (`/spec`, `sequant run`) can parse:

```html
<!-- assess:phases=spec,exec,qa -->
<!-- assess:action=PROCEED -->
<!-- assess:quality-loop=true -->
```

Legacy `<!-- solve:... -->` markers from old `/solve` comments are still parsed for backward compatibility.

## TypeScript API

The parser is available as a library export:

```typescript
import {
  findAssessComment,
  parseAssessWorkflow,
  assessWorkflowToSignals,
} from "sequant";

const comment = findAssessComment(issueComments);
if (comment) {
  const workflow = parseAssessWorkflow(comment.body);
  // workflow.action: "PROCEED" | "CLOSE" | "MERGE" | ...
  // workflow.phases: ["spec", "exec", "qa"]
  // workflow.qualityLoop: true

  const signals = assessWorkflowToSignals(workflow);
  // signals[0].source === "assess" (new primary signal source)
}
```

### Signal Source & Priority

The phase signal system uses `"assess"` as the primary signal source (priority 3). The deprecated `"solve"` source is preserved at the same priority for backward compatibility.

```typescript
import type { SignalSource } from "sequant";

// SignalSource = "label" | "assess" | "solve" | "title" | "body"
// Priority:       4         3          3          2         1
```

- `assessWorkflowToSignals()` emits `source: "assess"`
- `solveWorkflowToSignals()` (deprecated) emits `source: "solve"`
- Both resolve to priority 3 in `mergePhaseSignals()`

### CI Trigger Labels

The CI system accepts both `sequant:assess` (preferred) and `sequant:solve` (deprecated) as trigger labels for the full spec → exec → qa workflow.

```typescript
import { TRIGGER_LABELS } from "sequant";

TRIGGER_LABELS.ASSESS  // "sequant:assess" (primary)
TRIGGER_LABELS.SOLVE   // "sequant:solve"  (deprecated)
```

When either label triggers a run, both labels are removed from the issue to prevent re-triggering.

**Deprecated aliases still work:**
```typescript
// These still work but are deprecated:
import { findSolveComment, parseSolveWorkflow } from "sequant";
```

## Migration from /solve

`/solve` has been merged into `/assess`. During the transition:

- `/solve` works as an alias (shows deprecation notice, then runs `/assess`)
- Both `assess:` and `solve:` HTML markers are parsed
- All `solve*` TypeScript exports are preserved as deprecated aliases
- `solveWorkflowToSignals()` preserves "/solve" wording for backward compat

**What changed:** `/assess` now includes everything `/solve` did (workflow recommendations, flag analysis, CLI command generation) plus health checks, lifecycle recommendations, and the 6-action vocabulary.

## Troubleshooting

### /assess recommends CLARIFY but the issue looks clear

The issue may lack explicit acceptance criteria. `/assess` flags issues without clear ACs as needing clarification. Add AC items to the issue body, then re-run `/assess`.

### Old /solve comments aren't being parsed

Both `<!-- solve:... -->` and `<!-- assess:... -->` markers are parsed. If a comment has both, `assess:` markers take precedence. Check that the comment contains valid HTML markers (not just prose).

### /assess shows stale health signals

`/assess` checks timestamps and commit activity. If work was done outside the tracked branch (e.g., on main directly), `/assess` may flag the issue as stale. The health check is informational — override the recommendation if you know the context.

---

*Updated for Issue #438 on 2026-03-25 — added signal source, priority, and CI trigger label documentation*
