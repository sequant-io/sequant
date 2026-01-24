# Sequant Landing Page Copy

> Draft copy for sequant.dev landing page. All 7 sections included with A/B test variations.

---

## 1. Hero Section

### Eyebrow (Trust Signal)

```
⭐ [stars] GitHub stars  •  📦 [downloads]/week on npm
```

### Headlines (3 Variations for A/B Testing)

**Variation A: Pain-First** (Recommended)
> Stop babysitting AI coding agents

**Variation B: Outcome-First**
> Ship faster with structured AI workflows

**Variation C: Clarity-First**
> Orchestrate Claude Code with confidence

### Subheadline

> One CLI to run Claude Code through acceptance criteria, quality gates, and automated iteration—until tests pass.

**Alternative (shorter):**
> Structured workflows for AI-assisted development. Define criteria. Execute. Ship.

### Primary CTA

```bash
npx sequant init
```
*[Copy button]*

### Secondary CTA

```
View on GitHub →
```

**Reference:** Cursor's code-first hero, Mendral's pain-first approach

---

## 2. Trust Block

### Badge

```
Works with Claude Code
```

### Metrics Display

```
⭐ [X] stars  |  📦 [X]/week  |  [X] issues closed
```

**Alternative format:**
```
Trusted by developers shipping with AI
```

### Secondary Badge (Optional)

```
MIT Licensed • Open Source
```

**Reference:** Moda's YC badge placement, Grade's metrics display

---

## 3. Problem Section

### Pain Statement

AI agents write code fast—but ship broken PRs faster.

Without structure, you're stuck reviewing AI-generated code that "looks right" but fails in production. You babysit every PR, re-run tests manually, and hope nothing breaks.

### Contrast Statement

> Other tools generate code and hope for the best.
> Sequant adds structure: acceptance criteria, quality gates, and automated iteration until tests pass.

### Comparison Table (Optional)

| | Manual | Raw AI | Sequant |
|---|--------|--------|---------|
| **Speed** | Slow | Fast | Fast |
| **Quality gates** | You check | You check | Automated |
| **Iteration** | Manual | Manual | Auto-loop |
| **Confidence** | High | Low | High |

**Reference:** Moda's problem-solution contrast, Mousecat's comparison table

---

## 4. How It Works

### Section Headline

> Four commands. Zero babysitting.

**Alternative:**
> From issue to merge in four phases.

### Process Steps

| Step | Command | Title | Description |
|------|---------|-------|-------------|
| 01 | `/spec` | **Plan** | Extract acceptance criteria from GitHub issues. Know exactly what "done" looks like before writing code. |
| 02 | `/exec` | **Build** | Implement in isolated git worktrees. AI writes code while you review the approach. |
| 03 | `/loop` | **Iterate** | Auto-fix failing tests and lint errors. Loop until quality gates pass—up to 3 retries. |
| 04 | `/merger` | **Ship** | Merge with confidence. All criteria verified, all tests passing, ready for production. |

### One-Liner Summary

> Define acceptance criteria → Execute implementation → Iterate until tests pass → Merge with confidence

**Reference:** Mendral's Watch → Diagnose → Fix, Grade's 3-step flow

---

## 5. Features Section (4 Cards)

### Card 1: Structured Workflows

**Title:** Ship with structure, not hope

**Description:**
Every issue gets acceptance criteria extracted automatically. Implementation follows a defined plan. No more "AI wrote something, let's see if it works."

### Card 2: Isolated Worktrees

**Title:** Safe experimentation, zero conflicts

**Description:**
Each issue gets its own git worktree. Work on multiple features in parallel. If something breaks, your main branch stays clean.

### Card 3: Quality Loops

**Title:** Automated iteration until tests pass

**Description:**
When tests fail, Sequant doesn't stop. It analyzes the failure, fixes the code, and retries—up to 3 times. You review working code, not broken builds.

### Card 4: Multi-Issue Batching

**Title:** Process your backlog in parallel

**Description:**
Queue up multiple issues and let Sequant work through them. Each gets its own worktree, its own PR, its own quality verification.

**Pattern applied:** Outcome-first titles, then mechanism (per issue guidelines)

**Reference:** Zymbly's feature cards, Mousecat's persona-based sections

---

## 6. Social Proof

### Maintainer Quote

> "I built Sequant because I was tired of reviewing AI-generated code that passed lint but broke in production. Now I define what 'done' looks like upfront, and the AI iterates until it gets there."

**Attribution:**
— [Maintainer Name], Creator of Sequant

### Testimonial Placeholders (Future)

```markdown
<!-- Add user testimonials as they come in -->

> "[Quote about specific benefit]"
> — [Name], [Role] at [Company]

> "[Quote about time saved or quality improved]"
> — [Name], [Role] at [Company]
```

### Metrics Placeholder (Early Stage)

```
[X] PRs merged  |  [X] issues automated  |  [X] hours saved
```

**Reference:** Cursor's named testimonials, Lance's quantified quotes

---

## 7. Final CTA

### Section Headline

> Ready to ship with confidence?

**Alternative:**
> Stop babysitting. Start shipping.

### Install Block

```bash
# Initialize Sequant in your project
npx sequant init

# Run your first workflow
npx sequant run <issue-number>
```

### Links

```
GitHub  |  npm  |  Docs
```

### Closing Line

> Open source. MIT licensed. Built for developers who ship.

**Reference:** Mendral's dual CTA, Cursor's "Try now" simplicity

---

## Copy Guidelines Applied

| Guideline | Status | Example Used |
|-----------|--------|--------------|
| Headlines 5-8 words | ✅ | "Stop babysitting AI coding agents" (5 words) |
| Subheadlines 10-15 words | ✅ | "One CLI to run Claude Code through..." (15 words) |
| Actual commands used | ✅ | `/spec`, `/exec`, `/loop`, `/merger` |
| Outcomes lead | ✅ | "Ship with structure" not "Has workflows" |
| Terminal-native voice | ✅ | No marketing fluff, dev-to-dev tone |
| Problem → Solution contrast | ✅ | "Other tools... Sequant..." pattern |

---

## Mobile Compliance

All sections verified for mobile:
- ✅ No paragraph exceeds 3 sentences
- ✅ All headlines under 8 words
- ✅ Short, scannable bullet points
- ✅ Code blocks are single-line where possible
- ✅ Tables have max 4 columns

---

## Quantified Benefits

Included placeholders for metrics that will be populated as the project matures:

| Metric | Placeholder | Source |
|--------|-------------|--------|
| GitHub stars | `[X]` | GitHub API |
| npm downloads/week | `[X]` | npm API |
| Issues closed | `[X]` | Project metrics |
| PRs merged | `[X]` | GitHub API |
| Hours saved | `[X]` | User surveys |

**Future quantified claims (when data available):**
- "X% reduction in PR review time"
- "X issues automated per week"
- "X% of PRs pass on first review"

---

## Section-to-Reference Mapping

| Section | Reference Site | Pattern Applied |
|---------|----------------|-----------------|
| Hero | Cursor, Mendral | Pain-first headline, code-first CTA |
| Trust | Moda, Grade | Badge + metrics format |
| Problem | Moda, Mousecat | Contrast statement, comparison table |
| How It Works | Mendral, Grade | Numbered steps with commands |
| Features | Zymbly, Mousecat | Outcome-first cards |
| Social Proof | Cursor, Lance | Maintainer quote, testimonial structure |
| Final CTA | Mendral, Cursor | Install block + links |

---

## Notes for Implementation

1. **Dynamic metrics:** The `[X]` placeholders should be replaced with live data from GitHub/npm APIs
2. **A/B testing:** Headlines should be testable—consider using a feature flag or split test
3. **Dark theme:** Recommended per research (terminal-native aesthetic)
4. **Typography:** Headlines 48-72px, subheadlines 20-24px, body 16-20px
5. **Grid:** 12-24 column grid (Brex pattern)
