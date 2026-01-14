# Two Modes of Operation

Sequant offers two ways to work: interactive in Claude Code chat, or autonomous via headless CLI.

## Mode Comparison

| Aspect | Interactive | Autonomous |
|--------|-------------|------------|
| **Interface** | Claude Code chat | Terminal CLI |
| **Control** | Review each phase | Hands-off |
| **Best for** | Complex issues, learning | Batch processing |
| **Iteration** | Manual `/loop` | Automatic quality loop |

## Interactive Mode

Use slash commands in Claude Code chat for step-by-step control.

### Commands

```bash
/spec 123      # Plan implementation
/exec 123      # Build in worktree
/test 123      # UI verification
/qa 123        # Quality review
/loop 123      # Fix and retry

# Or all-in-one
/fullsolve 123
```

### When to Use

- **Learning Sequant** — See each phase's output
- **Complex issues** — Review plans before implementation
- **Sensitive changes** — Need human oversight at each step
- **Debugging** — Investigate issues between phases

### Example Session

```
You: /spec 42

Claude: I've analyzed issue #42 and drafted a plan...
[Shows implementation plan]

You: Looks good, but let's use a different approach for the database query.

Claude: Updated plan. Ready for /exec?

You: /exec 42

Claude: Implemented in worktree feature/42-add-caching...
[Shows changes and test results]

You: /qa 42

Claude: QA complete. All AC items satisfied. Ready to merge.
```

### Advantages

- Full visibility into each phase
- Can intervene and redirect
- Better for learning and understanding
- Collaborative decision-making

## Autonomous Mode

Use the CLI for batch processing without interaction.

### Commands

```bash
# Single issue
npx sequant run 123

# Multiple issues in parallel
npx sequant run 1 2 3

# Sequential processing
npx sequant run 1 2 3 --sequential

# With quality loop (auto-fix)
npx sequant run 123 --quality-loop

# Custom phases
npx sequant run 123 --phases exec,qa

# Preview without execution
npx sequant run 123 --dry-run
```

### When to Use

- **Batch processing** — Multiple issues at once
- **CI/CD integration** — Automated workflows
- **Simple issues** — Bug fixes, docs updates
- **Overnight runs** — Queue work and review later

### Example: Batch Processing

```bash
# Process sprint backlog overnight
npx sequant run 45 46 47 48 --quality-loop

# In the morning, review PRs
gh pr list
```

### Quality Loop

Autonomous mode can automatically fix issues:

```bash
npx sequant run 123 --quality-loop --max-iterations 5
```

**How it works:**
1. Runs phases (spec → exec → qa)
2. If QA fails, runs `/loop` to fix
3. Re-runs failed phases
4. Repeats up to N iterations

### Smart Defaults

Quality loop auto-enables for issues with these labels:
- `complex`
- `refactor`
- `breaking`
- `major`

### Advantages

- Process multiple issues efficiently
- No manual intervention needed
- Consistent execution
- Good for overnight batch work

## Hybrid Workflow

Combine modes for the best of both:

```bash
# Start with interactive spec
/spec 123
# Review and approve plan

# Run implementation autonomously
npx sequant run 123 --phases exec,qa --quality-loop

# Review results in chat
/assess 123
```

## Mode Selection Guide

| Scenario | Recommended Mode |
|----------|------------------|
| First time using Sequant | Interactive |
| Complex feature with unclear requirements | Interactive |
| Simple bug fix | Autonomous |
| Sprint batch processing | Autonomous |
| Security-sensitive change | Interactive |
| Documentation updates | Autonomous |
| Refactoring with breaking changes | Interactive (spec), then autonomous |

## Configuration

### Default Settings

Configure in `.sequant/settings.json`:

```json
{
  "run": {
    "qualityLoop": false,
    "maxIterations": 3,
    "sequential": false
  }
}
```

### Override Per Run

```bash
# Override settings with flags
npx sequant run 123 --quality-loop --max-iterations 5 --sequential
```

CLI flags always override settings file values.
