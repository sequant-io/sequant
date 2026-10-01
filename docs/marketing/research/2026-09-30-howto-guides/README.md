# How-to guide research, 2026-09-30

Inputs for Sequant's user-facing how-to guides. `docs/marketing/` is excluded from the sequant.io docs sync, so nothing here is published to the site (it is visible in the public repo).

| File | What it is |
|---|---|
| `brief.html` | Synthesis: stop-ship fixes, 12 ranked guides, screenshot strategy, distribution |
| `persona-top-funnel.md` | Blind read as a first-time visitor (README, npm, sequant.io only) |
| `persona-new-user.md` | Blind walkthrough of the quickstart in a scratch repo |
| `persona-veteran.md` | Blind read as an experienced user, 10 real scenarios against the docs |
| `edge-case-corpus.md` | 30 edge cases and 9 user stories mined from issues, run logs and Entire checkpoints |
| `distribution.md` | Channels, directories, awesome-lists, handles, comparable tools (with source URLs) |

The persona agents had no access to source, issues or maintainer notes. Frequencies in the corpus are mostly the maintainer's own usage.

Follow-ups filed from this research: #1256 (interactive `init` crash; PR #1258), #1257 (`doctor` and `run --dry-run` false passes), and the comment-trigger example hardening (PR #1259).
