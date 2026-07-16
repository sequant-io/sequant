## Summary

When `/spec` generates Derived ACs from the Feature Quality Planning section (#219), these ACs are not explicitly tracked through the `/exec` and `/qa` phases. This can lead to derived ACs being forgotten or not verified.

## Problem

### Current State
1. `/spec` generates Derived ACs table in Feature Quality Planning section
2. `/exec` mentions "Address derived ACs alongside original ACs" but doesn't:
   - Extract derived ACs from the spec comment
   - Include them in the Pre-PR AC Verification table
   - Track their completion status
3. `/qa` says "Treat derived ACs as additional AC items" but doesn't:
   - Show HOW to extract them from spec comments
   - Include a mechanism to parse the derived ACs table
   - Add them to the AC Coverage table automatically

### The Gap
```
/spec generates:
  └─> Derived ACs table (AC-6, AC-7, AC-8)
                    ↓
/exec should track:
  └─> [Missing] Extract derived ACs from spec comment
  └─> [Missing] Include in Pre-PR AC Verification table
                    ↓
/qa should verify:
  └─> [Missing] Parse derived ACs from spec comment
  └─> [Missing] Include in AC Coverage table
  └─> [Missing] Mark as MET/NOT_MET
```

## Proposed Solution

### 1. Add Derived AC Extraction to `/exec`

In the Context Gathering section, add explicit extraction:

```markdown
#### Extract Derived ACs

If quality plan has a Derived ACs table, extract them:

```bash
# Example: Parse derived ACs from spec comment
# Look for table rows like: | Error Handling | AC-6: Description | High |
derived_acs=$(gh issue view <issue> --comments --json comments -q '.comments[].body' | \
  grep -oE "AC-[0-9]+: [^|]+" | sort -u)
```

Include extracted derived ACs in:
- AC checklist during implementation
- Pre-PR AC Verification table
```

### 2. Update Pre-PR AC Verification in `/exec`

Add a section for derived ACs:

```markdown
### Pre-PR AC Verification

| AC | Description | Status | Evidence |
|----|-------------|--------|----------|
| AC-1 | [Original AC] | ✅ | ... |
| AC-2 | [Original AC] | ✅ | ... |
| **Derived ACs** | | | |
| AC-6 | [From Error Handling] | ✅ | ... |
| AC-7 | [From Best Practices] | ⚠️ Partial | ... |
```

### 3. Add Derived AC Parsing to `/qa`

In the AC Coverage section, add explicit handling:

```markdown
#### Derived ACs Verification

1. Extract derived ACs from spec comment's quality plan
2. Add to AC Coverage table with "Derived" label
3. Verify each derived AC same as original ACs

| AC | Source | Description | Status |
|----|--------|-------------|--------|
| AC-6 | Derived (Error Handling) | Rate limit handling | MET |
| AC-7 | Derived (Best Practices) | Logging | MET |
```

## Acceptance Criteria

- [ ] AC-1: `/exec` extracts derived ACs from spec comment's Feature Quality Planning section
- [ ] AC-2: `/exec` includes derived ACs in Pre-PR AC Verification table (labeled as "Derived")
- [ ] AC-3: `/qa` parses derived ACs from spec comment
- [ ] AC-4: `/qa` includes derived ACs in AC Coverage table with source attribution
- [ ] AC-5: Derived ACs are treated identically to original ACs for verdict determination

## Why This Matters

Without explicit tracking:
- Derived ACs might be implemented but not verified
- Derived ACs might be forgotten entirely
- QA can't objectively verify all planned work was completed
- The value of Feature Quality Planning is reduced

## Related

- #219 - Parent feature (Feature Quality Planning)
- Depends on: #219 being merged first

## Labels

`enhancement`, `workflow`, `exec`, `qa`
