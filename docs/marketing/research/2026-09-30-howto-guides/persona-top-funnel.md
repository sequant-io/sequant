# Persona trace: top-of-funnel visitor (Reddit click, daily Claude Code user)

Date: 2026-09-30. Sources seen: github.com/sequant-io/sequant (rendered repo page plus raw README), sequant.io, sequant.io/docs/, sequant.io/docs/getting-started/quickstart, sequant.io/research/, and the hero GIF (3 frames extracted). npmjs.com returned HTTP 403 to the fetcher, so the npm page was not seen; only the README's npm badges were.

---

## 1. The 90-second test (GitHub repo page only)

**One sentence:** Sequant is a Claude Code plugin/CLI that takes one of my GitHub issues, has an AI plan it, write it, and review it in a separate git branch, then opens a PR for me to merge. It is for solo devs or small teams who already track work in GitHub issues. The price is never stated. I assume it's free (MIT) and burns my own Claude Code usage. It needs Claude Code (or Aider), `gh`, Git, and Node 22.13+.

**What I'm unsure of after 90s:** whether it costs me anything in tokens, and whether "merge-ready" means "compiles" or "actually correct".

**Words/phrases I'd have to look up or that tripped me:**
- "acceptance criterion" / "AC". The tagline leads with it. I know the term from Jira, but I don't know where Sequant gets ACs from. Do I have to write them in the issue? In a particular format?
- "each acceptance criterion checked". Checked by whom? Another LLM? Tests?
- "three phases: plan, implement, review", but then the pipeline is `/spec → /exec → /test → /qa → Merge`. That's four or five steps, not three, and the names don't match the words.
- "git worktree". I've heard of it but never used it. Why should I care?
- "quality gates" / "8 quality gates" (the README says the list "includes" items; sequant.io says 8). Not clear whether these are linters, LLM judgments, or both.
- "Semgrep analysis", "scope analysis", "execution evidence", "anti-pattern detection". Is Semgrep something I have to install?
- `/fullsolve` vs `npx sequant run ... -Q`. What does `-Q` mean? Two install paths (plugin vs npm), and I don't know which one I am.
- "quality loop", "effort escalation", "phase-specific model/effort overrides"
- "invariant, not a setting" (fine, but reads like internal-design language)
- "MCP server". Why would a workflow tool need one?
- "constitution file" (on sequant.io)
- "headless"
- The "Why Claude Code ≥ 2.1.208?" box about the dangerous-`rm` analyzer and `bypassPermissions`. It sits in the Prerequisites, before Install. It makes me wonder: does this run my agent with permissions bypassed? That's scary to read before I've even installed it.
- "Plugins do not auto-update" warning, also above the fold of Install. That's maintenance burden before I've seen any value.

## 2. Install / star / close?

**Honest answer: close the tab, maybe star it first. Not install.**

**Deciding reason:** the hero GIF shows "#64 Add user authentication" going spec 02s → exec 04s → qa 02s → "completed" in **9 seconds**. Nobody's agent implements auth in 4 seconds, so I read it as a staged demo. It also ends on a green "completed" line with no PR, no diff, and no checked AC list. The README's whole pitch is "prove their work", and the main visual proves nothing. Then the repo page shows **1 star, 1 fork, 0 watchers**. Together those say "someone's side project with a fake demo". That's unfair if the tool is real, but it's what I'd see.

## 3. Click trace

| # | URL | Looking for | Found? | Effort |
|---|-----|-------------|--------|--------|
| 1 | github.com/sequant-io/sequant | What is it, is it legit | Partly. The tagline is clear-ish. 1 star hurts. | ~30s |
| 2 | (scroll) README hero GIF | What the output looks like | A 12s terminal animation ending at "completed" in 9s total. No PR. | ~15s |
| 3 | (scroll) Why Sequant / Prereqs | How it differs from Claude Code, cost | "Stop babysitting the agent". No cost info. Hit the `rm`/`bypassPermissions` note. | ~40s |
| 4 | (scroll) Install | Which path to take | Two paths, plus a plugin update warning. Have to decide plugin vs npm. | ~30s |
| 5 | npmjs.com/package/sequant | Download count, recency, popularity | **Page blocked (403) for me.** Fell back to the README badges (npm version/downloads). No real signal. | ~10s, abandoned |
| 6 | sequant.io | A clearer pitch, demo, pricing, social proof | Same tagline. FAQ answers "different from Claude Code?" (good). Shows "14 skills, 8 quality gates". No demo of output, no cost, no users. | ~60s |
| 7 | sequant.io FAQ | Cost / does it use my API key | Not answered anywhere. | ~20s |
| 8 | sequant.io/docs/getting-started/quickstart | What a first run looks like end to end | Command syntax only. **No sample output, PR, or verdict.** | ~45s |
| 9 | sequant.io/docs/ | Glossary, example run, case study | 50+ feature pages, 20+ reference pages, no example run, no case study. Too big for a first visit. | ~30s |
| 10 | sequant.io/research/ | Evidence it works | One post: "44% of second looks found a would-ship bug" (27 transcripts), and fresh-session QA costs ~5% more tokens. This is the most convincing thing I found, and it's buried two clicks deep. It says it's an internal measurement with a small sample. | ~45s |

Total: about 5.5 minutes. A real Reddit visitor would have left at step 2 or 3.

## 4. Five questions no page answered

1. **What does a run cost?** Tokens or dollars per issue, and does it eat my Claude Pro/Max limits or need an API key? (The only cost figure anywhere is the "+5%" for fresh QA on /research.)
2. **What does the output actually look like?** A real PR from Sequant, the comment it posts on the issue, and an "AC checked" report. I want one real link.
3. **How long does a real issue take?** The GIF says 9 seconds, which I don't believe. Is it 5 minutes or 45?
4. **What do my issues have to look like?** Does it need acceptance criteria written in a particular format, or will a one-line bug report work? What happens when the issue is vague?
5. **What does it do to my repo and machine?** What files does `init`/`setup` add, does it commit or push on its own, and what are the hooks / `bypassPermissions` doing? Also, does it work with GitLab/Bitbucket or no-issue workflows? (GitHub only, as far as I can tell.)

Runner-up: "who else uses this?" No named user, repo, or testimonial anywhere.

## 5. Visual audit

- **Above the fold on GitHub:** title, tagline, 2 lines of text, 6 badges (npm version, npm downloads, stars, CI, OpenSSF Scorecard, MIT), then the run-grid GIF.
- **The GIF:** 1610x760, 12.4s, 309 frames. Someone types `sequant run 64`, a boxed TUI shows `#64 Add user authentication`, branch `feature/64-user-auth`, phases ✓ spec 02s ▸ ✓ exec 04s ▸ ✓ qa 02s, total 00:09, then "completed" and "✔ #64 Add user authentication".
  - It's a terminal status widget, not the payoff. It shows that phases ran, not what they produced.
  - The timings make it look staged or simulated, which hurts trust in a product that sells "proof".
  - There's no PR URL, diff, AC checklist, or QA verdict text in it.
- **sequant.io:** no screenshots or GIFs of output that I could detect. The hero is a copyable install command.
- **The single image that would convince me:** a screenshot of a real GitHub issue comment posted by Sequant. It would show the AC checklist (each AC ✅/❌ with a file:line or test as evidence) and the QA verdict, with the linked PR next to it showing "+142 −18, checks green, awaiting your merge". A plus would be one real ❌ the loop then fixed. Caption it with the real wall time and token cost.

## 6. Trust signals

| Signal | Present? | Notes |
|--------|----------|-------|
| GitHub stars | Present but **harmful** | 1 star, 1 fork, 0 watchers. Showing a stars badge in the README makes this worse. |
| npm downloads | Badge only | Couldn't load npm. The badge number alone doesn't mean much to me. |
| CI badge / OpenSSF Scorecard | Present | Good. Signals engineering seriousness. |
| MIT license, "no telemetry" | Present | Good. Answers "is my code sent anywhere". |
| Threat model doc | Listed in docs | Good for a careful dev, but not surfaced. |
| Active development / version cadence | Not obvious from the page | The version badge exists. No "used in production for N months" claim. |
| Named users / testimonials / logos | **Absent** | |
| Case study / real example PR link | **Absent** | The biggest gap. |
| Numbers about outcomes | Buried | /research "44% of second looks found a would-ship bug" (n=27). Not on the README or homepage hero. |
| Cost / time numbers | **Absent** | |
| Author identity / who's behind it | Not visible | No "built by X" line. |
| Comparison to alternatives | Partial | One FAQ answer vs plain Claude Code. Nothing vs Copilot agent, Devin, Codex cloud, or Claude Code's own GitHub Action. |

What would make me believe it: 2–3 links to real merged PRs (in this repo, since it dogfoods itself) with the issue comment showing ACs checked, real time and token cost per issue, and the 44% stat moved to the README hero with the caveat attached.

## 7. Proposed first 10 lines of the README

```markdown
# Sequant

Give it a GitHub issue. Get back a pull request, plus a checklist proving each requirement in the issue was met.

You run one command: `npx sequant run 123` (or `/fullsolve 123` inside Claude Code).
Sequant has Claude Code plan the change, write it on a separate branch, then review it in a fresh session.
The review checks every requirement in the issue against the code and tests, and posts the results as an issue comment.
If a check fails, it fixes the problem and tries again. It never merges; you do.

Free and open source (MIT). It uses your existing Claude Code usage: a typical issue takes ~N minutes and ~$N in tokens.
Needs: Claude Code (or Aider), the GitHub CLI, Git, Node 22.13+. GitHub repos only.

**See a real one:** [issue #NNN](link) → [the PR it opened](link) → [the review checklist it posted](link)
```

Notes on the rewrite:
- The outcome comes first. "Acceptance criterion" becomes "requirement", worktree becomes "separate branch", and phases become verbs.
- Cost and time stay as placeholders until measured. Don't publish a number you haven't measured.
- Replace the GIF with the issue-comment screenshot described in section 5. If the GIF stays, use real timings and end it on the PR URL.
- Move "Why Claude Code ≥ 2.1.208", "Plugins do not auto-update", the badges row, and the stars badge below the Install section. Or drop the stars badge until the count helps.
