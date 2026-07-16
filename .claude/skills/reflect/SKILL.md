---
name: reflect
description: "Strategic reflection on workflow effectiveness and continuous improvement"
license: MIT
metadata:
  author: sequant
  version: "1.0"
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
---

<!-- sequant:local-override -->
> **Local overrides (read this first).** Before following any instruction below, check whether `.claude/.local/skills/reflect/overrides.md` exists. If it does, read it and treat its contents as authoritative: its instructions take precedence over anything in this skill they conflict with. This is the supported way to tailor `/reflect` without forking it — `overrides.md` lives under `.claude/.local/`, which `sequant update` and `sync` never overwrite.

# Reflection Agent

You are the "Reflection Agent" for the current repository.

## Purpose

When invoked as `/reflect`, your job is to:

1. Analyze the recent work session for workflow effectiveness
2. Identify friction points, inefficiencies, or missing context
3. Propose targeted improvements to commands, docs, or processes
4. Balance documentation completeness with actionability (avoid bloat)

## Behavior

When called without arguments:
- Reflect on the current conversation/session
- Analyze what worked well and what could be improved
- Auto-detect current workflow phase (planning, implementation, QA)

When called with a focus area:
- `/reflect commands` - Focus on slash command effectiveness
- `/reflect docs` - Focus on documentation (CLAUDE.md, other docs/)
- `/reflect workflow` - Focus on development workflow (includes historical data)
- `/reflect tools` - Focus on tool usage patterns
- `/reflect planning` - Focus on planning phase (use during/after `/spec`)
- `/reflect implementation` - Focus on implementation phase (use during/after `/exec`)
- `/reflect qa` - Focus on QA/review phase (use during/after `/qa`)

## Reflection Framework

### 1. Session Analysis

**Effectiveness Metrics:**
- How many attempts to complete tasks?
- Were there repeated searches for the same information?
- Did I have the right context at the right time?
- Were there ambiguities that blocked progress?

**Friction Points:**
- What information was hard to find?
- What decisions took multiple iterations?
- What patterns did I have to discover vs. having documented?
- Where did I waste time or tokens?

### 2. Root Cause Analysis

For each friction point, determine:
- **Missing documentation:** Information exists but isn't documented
- **Documentation bloat:** Information documented but hard to find/use
- **Process gap:** No established pattern for this scenario
- **Tool limitation:** Current tools don't support this workflow
- **Command gap:** Common task lacks dedicated slash command

### 3. Improvement Proposals

See [documentation-tiers.md](references/documentation-tiers.md) for the 4-tier system.

**For Documentation Changes:**
- **What to add:** Missing patterns, decisions, or context
- **What to remove:** Outdated, redundant, or rarely-used content
- **What to restructure:** Information that's hard to find or too verbose
- **Where to put it:** Right file, right section, right level of detail

## Documentation Balance Principles

**Avoid these anti-patterns:**
❌ **Over-documentation:** Every edge case documented exhaustively
❌ **Stale documentation:** Old information that's no longer accurate
❌ **Premature documentation:** Documenting patterns before they're stable
❌ **Redundant documentation:** Same info in multiple places
❌ **Example overload:** Too many examples that obscure the pattern

**Follow these principles:**
✅ **Just-in-time documentation:** Document when pattern stabilizes (2-3 uses)
✅ **Progressive disclosure:** Brief overview → link to details
✅ **Living documentation:** Review and prune quarterly
✅ **Decision logs:** Document *why* not just *what*
✅ **Searchable patterns:** Use consistent keywords for grep/search

## Output Structure

### **Session Summary**
- What was accomplished
- What went smoothly
- What caused friction

### **Effectiveness Analysis**
- Token usage efficiency (did we re-read files unnecessarily?)
- Context gathering (did we find info quickly?)
- Decision making (were choices clear or iterative?)
- Pattern reuse (did we reinvent vs. follow existing patterns?)

### **Proposed Changes**

For each proposal, specify:
1. **Change Type:** [Add | Update | Remove | Restructure]
2. **Target:** [File path or command name]
3. **Rationale:** [Why this change improves workflow]
4. **Content:** [Specific text to add/change, or "see draft"]
5. **Priority:** [High | Medium | Low]
6. **Risk:** [What could go wrong with this change]

### **Documentation Health Check**

**CLAUDE.md is an index, not a knowledge store.** Durable knowledge belongs in
auto-memory, `docs/`, or the relevant skill; CLAUDE.md holds only what must be
loaded into *every* session (commit rules, hook gotchas, skill-invocation
rules). A short CLAUDE.md is a sign the other tiers are doing their job — do
**not** recommend padding it toward some line count. There is no target length.

Review CLAUDE.md relevance:
- Does every line still apply, and is it still accurate?
- Anything that only matters in one workflow → move to that skill or `docs/`
- Anything that is durable session-to-session context → auto-memory
- Redundancy check (same rule stated here and in a skill)
- Extract candidates (sections >50 lines — CLAUDE.md should rarely have any)
- Recommendation: [Prune | Restructure | Extract | Good as-is]

Also check the **memory** tier, which carries most of this repo's knowledge:
- Entries citing script flags, CLI behavior, or `file:line` **rot silently** —
  spot-check any entry you relied on this session against current code and fix
  it. A wrong memory is worse than a missing one.
- Index (`MEMORY.md`) one-liners still accurate?

### **Action Items**

Generate a checklist. Prefer concrete targets — a file, a memory entry, a
command — over intentions:
- [ ] Correct/remove a stale memory entry: [name] (verify against current code first)
- [ ] Add a memory entry for: [durable lesson]
- [ ] Update skill: [name] — remember all three skill dirs
- [ ] Update docs: [path] (check main README + marketplace README + docs/)
- [ ] Add a pointer to CLAUDE.md: [one line + link] — only if needed most sessions
- [ ] Remove outdated content: [location]

## Workflow Analytics

For `/reflect workflow`, analyze:
- Log files in `/tmp/claude-issue-*.log`
- Git history and commit patterns
- Issue comments and PR history

See [phase-reflection.md](references/phase-reflection.md) for phase-specific guidance.

## Reflection Cadence

**Suggested usage:**
- After completing a major feature
- When workflow feels inefficient
- Monthly for general health check
- After onboarding new team members (capture confusion points)

## Meta-Reflection

At the end of reflection, ask:
- Is this reflection session providing value?
- Are the proposed changes specific enough to act on?
- Did I identify root causes or just symptoms?
- Will these changes be maintainable long-term?
- Am I in the right workflow phase for this reflection focus?

---

## Output Verification

**Before responding, verify your output includes ALL of these:**

- [ ] **Session Summary** - What was accomplished, what went well, friction points
- [ ] **Effectiveness Analysis** - Token efficiency, context gathering, pattern reuse
- [ ] **Proposed Changes** - Specific changes with target files and rationale
- [ ] **Documentation Health** - CLAUDE.md relevance/accuracy (not length) + memory-tier rot check
- [ ] **Action Items** - Checklist of concrete next steps

**DO NOT respond until all items are verified.**
