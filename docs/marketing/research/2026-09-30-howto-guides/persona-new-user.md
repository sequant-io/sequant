# New-user persona trace: sequant 2.18.0

Date: 2026-09-30. Machine: macOS (Darwin 25.5), Node v22.23.0, git 2.47.1, gh 2.66.1 (authenticated), Claude Code 2.1.286, jq present.
Sources I used: README.md, docs/guides/quickstart.md, docs/getting-started/{prerequisites,installation,first-workflow}.md, docs/troubleshooting.md, docs/reference/cheat-sheet.md, sequant.io (home, /docs/, /docs/getting-started/quickstart), and CLI output.
Scratch projects are under `scratchpad/newuser/`: `notgit/` (not a git repo), `tinyapp/` (Node, git, no remote), `ttytest/` (Python, git, no remote), `ttynode/` (Node, used for the TTY tests).
Caveat: this machine also has a global `/opt/homebrew/bin/sequant` (a dev build). I used `npx -y sequant@latest` everywhere. I checked that the bare `npx sequant --version` also resolves to 2.18.0, so the global install didn't change any result.

---

## 1. What I expected after reading the README and quickstart

- Quickstart title: "zero to your first solved issue in 5 minutes".
- I expected to run `npx sequant init` and `npx sequant doctor`, then run `/fullsolve 123` inside Claude Code. That should give me a worktree, a plan comment on the issue, and then a PR.
- Prerequisites as stated: Claude Code, an authenticated `gh`, and "A GitHub repository with at least one open issue". Nothing said what the issue should contain (format, acceptance criteria, labels).
- I expected the CLI to stop at the PR and never merge. The README calls this "an invariant, not a setting".

What I had to guess before running anything:
- **Which install path is mine?** The docs give four different answers (details in the contradictions table):
  - README: `npm install sequant`, then `npx sequant init`.
  - installation.md: npx with no install is "Recommended".
  - sequant.io: `npm i sequant && npx sequant init`.
  - Plugin: `/plugin install …` plus `/sequant:setup`.
  - The README splits these as "inside Claude Code" vs "headless/CI". A first-timer who wants to try it in Claude Code can't tell whether to use the plugin or `npx init`.
- **Is `/fullsolve 123` typed in the terminal or in Claude Code?** The quickstart doesn't say. The README does say "Inside Claude Code".

---

## 2. Step-by-step trace

### Step A: `npx -y sequant@latest --version` (not a git dir)
- Docs: none specific.
- Actual: `2.18.0`, in 1.5 s (npx cache was warm).

### Step B: `npx sequant@latest --help`
- Docs: the cheat sheet lists the CLI commands.
- Actual (trimmed):
  - `Usage: sequant [options] [command]`
  - Tagline: `Quantize your development workflow - Sequential AI phases with quality gates`
  - Commands: init, update, sync, doctor, status, run, resume, prompt, watch, abort, merge, ready, conventions, logs, stats, dashboard, serve, state, locks, worktree.
- Mismatches:
  - The tagline differs from the README and site ("AI coding agents that prove their work").
  - Internal issue numbers show up in user-facing help: `prompt … (#383)`, `watch … (#383)`, `abort … (#858)`.
  - `prompt`, `watch`, `abort` and `worktree` are not in the cheat sheet's "CLI Commands" table.
  - `resume` help points to `docs/reference/halt-and-resume.md`, which is a repo path, not a URL.

### Step C: `npx sequant init`, run literally in an interactive terminal (TTY) — CRASH
- Docs: creates `.claude/` and `.sequant/`, adds the manifest, detects the stack.
- Actual: I ran it under a pseudo-terminal in a Python repo and in a Node repo. Both times it crashed right after the dependency check:
  ```
  Checking dependencies...
    ✔ GitHub CLI (gh) - installed
    ✔ Claude Code CLI - installed
    ✔ jq (JSON processor) - installed
  UnknownPromptTypeError: Prompt type "list" is not registered. Available prompt types: checkbox, confirm, editor, expand, input, number, password, rawlist, search, select
      at async Command.initCommand (.../node_modules/sequant/dist/src/commands/init.js:629:44)
  Node.js v22.23.0
  ```
  Exit code 1. No files are written (the repo is unchanged).
- Root cause, from public npm metadata: `sequant@2.18.0` declares `inquirer ^14.1.0`. npx resolved inquirer 14.2.0, and the error message itself shows that inquirer 14 no longer has a `list` prompt type (it has `select`).
- Impact: **the very first command in the quickstart fails for anyone who types it into a normal terminal.** `init --interactive` and `-i` go down the same prompt path. The docs recommend them for monorepos.
- Time to failure: about 2 s.
- Stuck? Yes. Nothing in the troubleshooting guide mentions this error. A new user would give up here, or file a bug.
- **Caveat:** I tested this in a pty I started from a script, not in a terminal I typed into. Someone should confirm it by typing `npx sequant init` once in a real terminal.

### Step C2: `npx sequant init -y` in a TTY — hangs (unconfirmed)
- Under the same pseudo-terminal, `init -y` printed the plan and then sat at `⠋ Creating directories...`.
- I tried three times, waiting 25 to 100 s. I also tried sending one Enter keypress after 8 s. It never finished, and I killed the process each time.
- A partial `.claude/`, `.sequant/` and `scripts/` were left behind.
- This could be an artifact of my pty harness. It needs confirmation by hand in a real terminal.

### Step C3: `npx sequant init` with non-interactive stdin (`</dev/null`) — works
- Prints `⚡ Non-interactive mode detected … Using defaults`, then completes in about 2 s with exit code 0.
- tinyapp (Node): `Using stack: generic (default)`, `Package Manager: npm`, `Dev URL: http://localhost:3000 (default)`, `✔ Detected 1 codebase conventions`, `✔ Created .mcp.json`, `Sequant initialized successfully!`
- ttytest (Python): `Detected stack: python (default)`, `Dev URL: http://localhost:5000`. The constitution mentions pytest.
- Mismatches and rough edges:
  - The banner says `skills/ (14 workflow skills)`, but `sequant status` reports `Skills: 21`.
  - A plain Node package with no web server is assigned `Dev URL: http://localhost:3000`.
  - It warns: `!  scripts/dev templates dir is outside the project tree (npx cache …) — copying instead of symlinking; pass --no-symlinks to silence this`. That warning fires on the docs' own recommended path (npx).
  - It reports `Detected 1 MCP-compatible client(s): • Claude Desktop … Skipping MCP config`. As a new user I don't know whether I need that.
  - The final "Next steps" list is `1. Review .claude/memory/constitution.md  2. /spec 123 …`. It does **not** say:
    - commit `.claude/skills/` (the README calls this a hard runtime dependency);
    - run `doctor`;
    - that `/spec` is typed inside Claude Code;
    - that you need a GitHub remote and an issue.
  - The "Documentation" link points to `github.com/sequant-io/sequant#readme`, not sequant.io.
  - `.gitignore` gains `.sequant/`. That means `.sequant/settings.json`, which the docs describe as project configuration, is never committed or shared with a team.
  - After init, `git status` shows everything untracked: `.claude/`, `.gitignore`, `.mcp.json`, `.sequant-manifest.json`, `AGENTS.md`, `scripts/`.

### Step D: `npx sequant doctor`
- Docs: "verifies Node.js version, GitHub CLI authentication, Git availability, Optional MCP configurations".
- In tinyapp (git repo, **no remote**, skills not committed): `All 18 checks passed! Your Sequant installation is healthy.` It also prints `✔ Closed Issues: All recently closed issues have commits in main`, which passes in a repo with no remote (presumably vacuously). Exit code 0.
- Outside a git repo (`notgit/`): `! Git Repository: Not a git repository (worktree features won't work)` … `All checks passed (1 warning) … Sequant should work correctly.` Exit code 0.
- It always shows `!  WARN: Claude Code #43869 — subagent model: declarations are ignored.` A new user can't act on this, and it isn't counted in the warning total.
- **Gap:** doctor misses the three things that will actually block the first run:
  - no GitHub remote;
  - `.claude/skills/` not committed;
  - no issues in the repo.
  "Healthy" is misleading.
- Time: about 2 s.

### Step E: `npx sequant status` and `status --issues`
- Time: about 2 s each.
- `Status: Initialized … Skills: 21 … Run sequant doctor…`, then `No workflow state found. Run sequant run <issue> to start tracking.` This was fine.

### Step F: `npx sequant sync --dry-run` (about 2 s)
- Prints `Note: For seamless auto-updates, install sequant as a Claude Code plugin: /plugin install sequant@claude-plugin-directory. Plugin users get auto-updates without running sync manually.`
- **Contradicts the README** in two ways:
  - The README says "Plugins do not auto-update" and tells you to run `claude plugin update`.
  - The README gives the install id as `sequant@sequant-io/sequant`, not `sequant@claude-plugin-directory`. The README's update command uses `sequant@sequant`, a third id.

### Step G: `gh issue list` (first-workflow Step 1; instant)
- Actual: `no git remotes found`. This is the first sign that you need a GitHub-hosted repo. The docs say "A GitHub repository", but none of `init`, `doctor` or `run --dry-run` checks for one.

### Step H: `npx sequant run 1 --dry-run` (safe preview, recommended in troubleshooting)
- Actual: `Phases auto-detect from labels` … `Would execute: /spec 1` … `Could not parse spec recommendation, using label-based detection / Fallback: exec → qa` … then a summary table showing `#1 ✔ passed  spec → exec → qa`, and exit code 0.
- Mismatches:
  - The dry run reports **"passed"** for an issue that doesn't exist, in a repo with no remote and no committed skills.
  - It says it "could not parse" output from a spec that never ran.
  - It introduces "label-based detection" without saying which labels count.
  - The dry run doesn't check any precondition. The skills pre-flight checks that `.claude/skills/` exists, not that it is committed, so a fresh clone or CI checkout would still break.
- No side effects: afterwards there was no worktree and no `state.json`, and no tokens were spent. Time: under 5 s.
- `run --help` has no `--auto-merge`, although the quickstart and cheat sheet advertise `--auto-merge` for `/fullsolve`.

---

## 3. Contradictions and inaccuracies in the docs

| # | Claim A | Claim B |
|---|---|---|
| 1 | README: the pipeline "never merges. That is an invariant, not a setting." | quickstart, cheat-sheet and first-workflow: "Pass `--auto-merge` (or set `run.autoMerge: true`) if you want it to also merge" |
| 2 | README Install: `npm install sequant` then `npx sequant init` | installation.md: "Recommended: npx (No Install)". Site: `npm i sequant && npx sequant init`. Plugin: `/plugin install sequant@sequant-io/sequant` + `/sequant:setup`. `sync` note: `sequant@claude-plugin-directory`. README update: `sequant@sequant` |
| 3 | README: "Plugins do not auto-update" | `sync` output: "Plugin users get auto-updates" |
| 4 | README: the run "opens a merge-ready PR" | first-workflow Step 5: "Create a pull request: `gh pr create --fill`" or `git merge` directly |
| 5 | README: you must commit `.claude/skills/` | `init` "Next steps" and `doctor` never mention it, and doctor reports healthy with it untracked |
| 6 | Quickstart: "5 minutes" | needs a GitHub remote, an open issue, and Claude Code. None of the free commands check the first two |
| 7 | init banner: "14 workflow skills" | `status`: "Skills: 21" |
| 8 | troubleshooting Windows section links `../README.md#windows-users` | the README has no such section, only a "Platform Support" table |
| 9 | README "Documentation" list links `docs/internal/what-weve-built.md` | that is an internal doc in the public user list |
| 10 | quickstart `/fullsolve`: "plan → implement → test → review" | README diagram calls `/test` optional (UI only, needs Chrome MCP) |
| 11 | first-workflow `/exec`: "Runs tests (`npm test`)" | a non-JS user gets a different command, per troubleshooting |

---

## 4. The "aha moment" and what blocks it

- **The promised moment:** "Sequant creates an isolated worktree, posts a plan comment to the issue, and opens a merge-ready PR". The README shows this with the `SEQUANT WORKFLOW · #683` panel (spec ✔ 9 ACs, qa ✔ 8/9 ACs MET, pr ✔).
- **Can a new user reach it in 5 minutes without an issue already prepared? No.** Here are the silent blockers, in the order you hit them:
  1. **Interactive `init` crashes** (inquirer `list` prompt). This is a hard stop at minute 0 unless you happen to pipe stdin.
  2. **A GitHub remote is required.** Nothing checks for it: init, doctor ("healthy") and the dry run ("passed") all succeed without one. You only find out from `gh` ("no git remotes found") or when a real run fails.
  3. **An open GitHub issue is required.** The docs never say what a good one looks like. The README mentions an "AC Authoring Standard" (single-line ACs, `Evidence:` fields), but only inside `.claude/memory/constitution.md`, which init creates. No getting-started doc shows a sample issue, and nothing says whether labels matter. The dry run says "auto-detect from labels" but never names them.
  4. **`.claude/skills/` has to be committed** before `sequant run`. The README covers this, but the quickstart, init output and doctor don't.
  5. **Claude Code needs to be open in the repo**, and the slash commands are typed there. The quickstart doesn't say this.
  6. **Token cost and run time.** Nothing in the getting-started docs says a run spends model tokens, or roughly how much or how long. The default phase timeout of 1800 s shows up only in the cheat sheet.
- A realistic estimate for a careful first-timer is 20–40 minutes: work around the init crash, create a GitHub repo, push, write an issue with ACs, commit `.claude/`, open Claude Code, and run `/fullsolve`. That assumes no further bugs.

---

## 5. Jargon I hit before it was defined (in reading order)

- **acceptance criterion / AC.** The first line of the README uses it, and it's never defined for users. The format lives in the constitution.
- **worktree / git worktree.** Partly explained later in "Worktree Isolation".
- **quality gates**
- **phases (plan/implement/review = spec/exec/qa)**
- **Claude Code ≥ 2.1.208, "native dangerous-`rm` analyzer", `bypassPermissions`, "pre-tool hooks"**
- **MCP servers (`chrome-devtools`, `sequential-thinking`, `context7`)**
- **skills (`.claude/skills/`, `_shared`)**
- **plugin / marketplace**
- **headless**
- **`-Q` / quality loop.** It reads as "runs the quality loop" without saying what that is.
- **per-phase agents / driver**
- **`SEQUANT_CHECKOUT=in-place`**
- **`next` tag / downstream canary**
- **`/fullsolve`, `/assess`, "6-action vocabulary", PROCEED/PARK/CLOSE**
- **constitution / Agent Contract / Definition of Done "§7 gate list" / `lint:constitution-dod`**
- **mutation-verification gate**
- **AGENTS.md ownership marker**
- **`scripts/dev` links**
- **verdicts (READY_FOR_MERGE, AC_MET_BUT_NOT_A_PLUS, NEEDS_VERIFICATION, AC_NOT_MET), "A+"**
- **`sequant ready` / "human merge gate"**
- **`resumeAt` / halt-and-resume**
- **model escalation ladder / SPEC_DIVERGENCE**
- **"blocked by #N" / chain mode / GitHub markers**
- **smart tests, conventions, stack, "relay outbox" (from `--help`)**

---

## 6. Edge cases

| Edge case | Covered in docs? | Tested? Result |
|---|---|---|
| Not a git repo | Only indirectly ("Git is required for worktree support") | Yes. `init` succeeds silently with no warning. `doctor` shows a ⚠ but says "Sequant should work correctly". It should refuse, or warn loudly at init |
| No `gh` auth | Yes (prerequisites, troubleshooting "GitHub CLI not authenticated") | Not tested, to avoid logging out the host. The init dependency check lists gh "installed" but not "authenticated"; doctor does check auth |
| GitHub remote missing | **No** | Yes. doctor reports "healthy", the dry run reports "passed", and only `gh` errors |
| Monorepo | Yes (installation.md "Multi-Stack Projects" → `init --interactive`) | That path goes through the crashing interactive prompts |
| Non-JS stack | Yes (troubleshooting "non-Node.js projects", stack guides) | Yes, Python. Non-TTY init detects python, sets Dev URL :5000, and the constitution mentions pytest. Fine |
| Windows | Partly (platform table: "Native ⚠️ CLI only"; troubleshooting WSL section) | Not testable. The troubleshooting link to the "README Windows Users section" is broken |
| No issues in repo | **No** (only "at least one open issue" in prerequisites) | No guidance on writing a first issue or its AC format |
| Private repo | **No** | Not tested (I created no remote). Nothing says whether `gh` scopes or org permissions matter |
| Interactive terminal (normal case!) | n/a | **Crashes**, see Step C |

---

## 7. Three how-to guides that would have saved me the most time

1. **"Your first issue: write one Sequant can run"**: a copy-paste sample issue with 2–3 single-line ACs in the house format, which labels (if any) matter, and `gh issue create` commands, so the 5-minute promise works on an empty repo.
2. **"Pick your install path in 30 seconds"**: one decision table (plugin vs npx vs local devDependency vs global) with the exact commands for each. It should cover the correct plugin id, which files to commit afterwards (`.claude/skills/`, why `.sequant/` is gitignored), and how updates work for each path.
3. **"Preflight: is this repo ready for `sequant run`?"**: a checklist that pairs with `doctor`. Check for a git repo, a GitHub remote (public or private, plus `gh` scopes), committed skills, an existing issue, Claude Code opened in the repo, and the expected token cost and run time. Also cover reading `--dry-run` output, which currently says "passed" for anything.

---

## Times
- `--version` 1.5 s · TTY `init` crash 2 s · non-TTY `init` 1.7–2.3 s · `doctor` 1.9 s · `run --dry-run` under 5 s.
- Reading the docs took far longer than running the commands. The README alone is about 400 lines, and much of it is upgrade and ownership detail aimed at existing users.
