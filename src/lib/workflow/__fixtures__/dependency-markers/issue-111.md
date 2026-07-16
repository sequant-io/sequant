## Summary

Two related improvements to the workflow orchestration:

1. **`/fullsolve` should invoke actual skills** - Currently runs phases "inline" without calling `/spec`, `/exec`, `/qa`. Should orchestrate the real skills for proper audit trail and structured output.

2. **`/solve` should recommend `--chain` when appropriate** - The new `--chain` flag needs to be integrated into `/solve`'s workflow recommendations.

---

## Problem

### /fullsolve runs inline instead of invoking skills

Current behavior:
```
/fullsolve 123
→ Does spec-like work inline
→ Does exec-like work inline  
→ Does qa-like work inline
→ No GitHub comments, no structured output
```

Expected behavior:
```
/fullsolve 123
→ Invokes /spec 123 (posts plan to GitHub)
→ Invokes /exec 123 (implements following spec)
→ Invokes /qa 123 (posts review to GitHub)
→ Full audit trail, structured workflow
```

### /solve doesn't know about --chain

The `/solve` command recommends workflows but doesn't know when to suggest `--chain` for dependent issues.

---

## Acceptance Criteria

### /fullsolve improvements
- [ ] Use `Skill` tool to invoke `/spec`, `/exec`, `/qa` instead of inline implementation
- [ ] Maintain orchestration context (SEQUANT_ORCHESTRATOR env vars)
- [ ] Handle skill failures gracefully (stop chain, report status)
- [ ] Preserve the quality loop iteration logic between skill calls

### /solve --chain recommendations

Add `--chain` to workflow recommendations when:
- [ ] Multiple issues are being solved together
- [ ] Issues have explicit dependencies (depends-on labels/body)
- [ ] Issues are part of a multi-part feature (detected from titles/labels)
- [ ] User specifies related issues in the same request

Do NOT recommend `--chain` when:
- [ ] Single issue
- [ ] Issues are independent/unrelated
- [ ] Issues touch completely different areas of codebase
- [ ] Batch mode is more appropriate (parallel work)

### /solve output format update
- [ ] Add "Chain Mode" section to recommendations when applicable
- [ ] Explain why chain is/isn't recommended
- [ ] Show expected chain structure: `origin/main → #1 → #2 → #3`

---

## Technical Design

### /fullsolve skill invocation

```typescript
// Instead of inline implementation:
await executePhase(issueNumber, "spec", config);

// Use Skill tool:
await invokeSkill("spec", issueNumber.toString());
```

### /solve chain detection

```typescript
interface ChainRecommendation {
  recommended: boolean;
  reason: string;
  chainOrder?: number[];  // Suggested order if recommended
}

function shouldRecommendChain(issues: Issue[]): ChainRecommendation {
  // Check for explicit dependencies
  // Check for related labels/titles
  // Check for overlapping file changes (from history)
  // Return recommendation with reasoning
}
```

### Example /solve output with chain

```markdown
## Recommended Workflow

**Issues:** #10, #11, #12
**Mode:** Sequential with chain
**Phases:** spec → exec → qa

### Chain Recommendation: ✅ Recommended

These issues form a dependency chain:
- #10: Add auth middleware (base)
- #11: Add login page (depends on #10)
- #12: Add logout (depends on #11)

**Command:**
```bash
sequant run 10 11 12 --sequential --chain
```

**Chain structure:**
```
origin/main → feature/10-auth → feature/11-login → feature/12-logout
```
```

---

## Related

- #88 - feat: Add --chain flag for dependent sequential issues (merged)
- `/fullsolve` skill: `.claude/skills/fullsolve/SKILL.md`
- `/solve` skill: `.claude/skills/solve/SKILL.md`
