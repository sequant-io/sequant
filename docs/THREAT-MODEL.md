# Sequant threat model

Sequant runs AI phase agents over GitHub issues. Those agents read text written
by people who are not you, and they hold broad local tool access while they do
it. This document states what that means, which defenses hold when the model is
compromised, and which do not.

The organising claim is deliberately modest: **sequant assumes the model can be
fooled.** Prompt injection is unsolved at the model layer — OWASP ranks it LLM01
and its own researchers describe it as architecturally open — so the controls
below are not attempts to stop a model from being persuaded. They are attempts
to bound what a persuaded model can *reach*, and to make the attempt visible.
Nothing here claims that prompt injection is solved, in sequant or anywhere.

Every defense in this document names the file, section, or key that enforces
it. If a claim has no enforcer, it appears under
[Residual risks](#residual-risks) rather than in the defenses table.

---

## Untrusted-input surfaces

A phase agent's inputs are not all equally trustworthy. These are the surfaces
that carry text sequant did not write and cannot vouch for:

<!-- surfaces:begin -->

| Surface | Reaches the agent via | Notes |
|---------|----------------------|-------|
| Issue bodies | `/spec`, `/exec`, `/qa`, `/loop`, `/assess` all read the issue body | The primary requirements channel, and the primary injection vector |
| Issue and PR comments | Comment threads are read for clarifications, spec output, and review feedback | Anyone with repository read access can add one |
| Repository file contents | The agent reads the code it is working on, including files a contributor changed | A poisoned comment in a source file is input |
| Tool output | Command stdout, test failures, `gh` responses, MCP tool results | Attacker-controlled if the tool reaches attacker-controlled data |
| Dependencies | Package contents, install scripts, and transitive updates | Executes with the developer's privileges, outside any agent decision |
| Linked URLs and files | Anything the above link to and the agent follows | Inherits the trust level of its source, which is none |

<!-- surfaces:end -->

The rule sequant's skills apply to all of these is in
[`templates/skills/_shared/references/trust-model.md`](../templates/skills/_shared/references/trust-model.md):
external text is **data describing what to build**, not a channel for
redirecting what the agent does. Product requirements and the author's process
guidance are followed normally. An imperative to execute a command, reach the
network, read or transmit secrets, or override the agent's own instructions is
surfaced as a security finding and not acted on.

---

## Defenses and their enforcers

Each row names its enforcer and classifies it:

- **deterministic** — the control runs outside the model and holds even if the
  model is fully compromised. A hook that refuses a command does not care what
  the agent intended.
- **model-dependent** — the control works by the agent reading text and
  complying. It raises the cost of an attack and makes one visible in review,
  but a sufficiently persuaded model can step around it.

The deterministic layer is a PreToolUse hook carrying
<!-- guards:count -->16 distinct `HOOK_BLOCKED:` refusals. That number is
recomputed from the hook source by CI rather than typed here, so it cannot
drift (`src/lib/__tests__/security-docs.test.ts`, AC-4).

<!-- defenses:begin -->

| Defense | Enforcer | Class | Residual risk |
|---------|----------|-------|---------------|
| Privilege-escalation and deploy blocks | `templates/hooks/pre-tool.sh` (`HOOK_BLOCKED: sudo command`, `HOOK_BLOCKED: Deployment command`, `HOOK_BLOCKED: Workflow trigger`) | deterministic | Matches on command shape; an unrecognised spelling of the same intent is not refused |
| Worktree containment | `templates/hooks/pre-tool.sh` (`HOOK_BLOCKED: File operation must be within worktree`) | deterministic | Covers file operations routed through the hook; a process that writes without a tool call is outside its reach |
| Secret and credential read blocks | `templates/hooks/pre-tool.sh` (`HOOK_BLOCKED: Reading secret file`, `HOOK_BLOCKED: Reading credential directory`, `HOOK_BLOCKED: Environment dump`) | deterministic | Path- and pattern-based; a secret stored somewhere the patterns do not name is readable |
| Staged-secret and sensitive-file commit blocks | `templates/hooks/pre-tool.sh` (`HOOK_BLOCKED: Hardcoded secret detected in staged changes`, `HOOK_BLOCKED: Sensitive file in commit`) | deterministic | Detects known credential shapes; a novel or encoded secret format passes |
| History-destruction blocks | `templates/hooks/pre-tool.sh` (`HOOK_BLOCKED: Force push`, `HOOK_BLOCKED: git reset --hard would lose local work:`) | deterministic | Bounds damage to the local checkout and branch; it is not a backup |
| Concurrency locks on shared state | `templates/hooks/pre-tool.sh` (`HOOK_BLOCKED: Checkout held by another session`, `HOOK_BLOCKED: File locked by another agent`) | deterministic | Prevents concurrent agents corrupting each other's work; not a security boundary between them |
| Phase-agent MCP isolation | `src/lib/mcp-config.ts` (`getPhaseMcpServersConfig`) with settings key `mcpAllowlist` in `src/lib/settings.ts` | deterministic | An operator who allowlists a server re-exposes that server's credentials to phase agents by choice |
| Skill-text CI gate for the trust-model block | `src/lib/__tests__/trust-model-skill.test.ts` | deterministic | Gates that the text exists and is wired into every ingest skill; it cannot gate whether an agent obeyed it |
| Skill-mirror integrity across the three shipped trees | `scripts/check-skill-sync.ts` and `.github/workflows/ci.yml` (`npm run lint:skill-sync`) | deterministic | Proves the installed skills match the repository; says nothing about the content being correct |
| Behavioural injection eval with deterministic graders | `evals/qa-trust-boundary/graders/exfil-absent.md` and `.github/workflows/plugin-eval.yml` | model-dependent | Evidence, not containment: the graders are deterministic but the eval only records how the model behaved on a fixture, and only when someone dispatches it — a regression between runs holds nothing back. One vector (issue body) today; PR-comment and tool-output vectors are tracked in #1024 |
| Lockfile-pinned installs and scheduled dependency updates | `package-lock.json` and `.github/dependabot.yml` | deterministic | Pins and updates versions; it does not inspect what a pinned package does |
| Trust-model block in every ingest skill | `templates/skills/_shared/references/trust-model.md` | model-dependent | Holds only while the agent reads and follows the block |
| Trust-Boundary Check on every QA run, including Simple Fix mode | `templates/skills/qa/SKILL.md` §6f | model-dependent | A compromised reviewer agent can decline to report what it found |
| Verdict floor when injection was acted on | `templates/skills/qa/SKILL.md` §7 (`trust_boundary_status`) | model-dependent | The floor only fires if the check above reported honestly |
| Mutation-verification record for gate-test claims | `templates/skills/qa/SKILL.md` §6i | model-dependent | Detects a fabricated verification record; a well-formed record for a weak test still passes |

<!-- defenses:end -->

The shape of the table is the substance of the claim: the controls that survive
a compromised model are hooks, CI jobs, and config — not instructions. The
model-dependent rows are worth having because most failures are not adversarial
and because they make an attack legible to a human reviewer. They are not worth
counting as containment.

---

## OWASP Top 10 for Agentic Applications (2026)

Source: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/

Categories are cited by identifier first and title second: the `ASI01`–`ASI10`
identifiers are stable across OWASP's publications, while the exact wording of
several titles varies between the announcement and secondary summaries.

<!-- owasp:begin -->

| Category | Sequant disposition |
|----------|--------------------|
| ASI01 Agent Goal Hijack | Mitigated in part. `templates/skills/_shared/references/trust-model.md` and the `templates/skills/qa/SKILL.md` §6f check are model-dependent; the deterministic bound is the hook guard set in `templates/hooks/pre-tool.sh`; the human merge gate then limits a hijacked phase to an unmerged PR, but it is a human decision, not a mechanical control (no branch protection today — see Residual risks) |
| ASI02 Tool Misuse and Exploitation | Mitigated. The PreToolUse guard set in `templates/hooks/pre-tool.sh` refuses privilege escalation, deploys, workflow triggers, secret reads, and out-of-worktree writes regardless of agent intent |
| ASI03 Identity and Privilege Abuse | Mitigated in part. `src/lib/mcp-config.ts` withholds desktop MCP credentials from phase agents by default; the credentials a phase agent does hold are the developer's own, and granting tool permissions is out of scope — Claude Code's permission layer owns it |
| ASI04 Agentic Supply Chain Vulnerabilities | Mitigated in part. `package-lock.json` pins installs and `.github/dependabot.yml` schedules updates. Publish-side provenance and an OpenSSF Scorecard signal are not in place today; see Residual risks |
| ASI05 Unexpected Code Execution | Mitigated in part. `templates/hooks/pre-tool.sh` refuses a named set of dangerous command forms, but a phase agent legitimately runs project commands. Sandboxed execution is out of scope — Claude Code's permission and sandbox layer owns it |
| ASI06 Memory and Context Poisoning | Mitigated in part. Sequant keeps no cross-run agent memory that an attacker can write to; the poisoning surface is the issue thread and repository content it re-reads each run, handled by the trust-model block and `templates/skills/qa/SKILL.md` §6f |
| ASI07 Insecure Inter-Agent Communication | Out of scope — Claude Code's agent transport. Sequant spawns subagents through the harness and exchanges no messages over a network of its own; what it does control is the worktree each agent may write to, via `templates/hooks/pre-tool.sh` |
| ASI08 Cascading Failures | Mitigated in part. The escalation ladder halts rather than looping, with the halt conditions documented in `docs/reference/model-ladder.md`, and no phase merges its own work. A wrong-but-plausible change can still propagate into later phases of the same run |
| ASI09 Human-Agent Trust Exploitation | Mitigated in part. Verdict floors in `templates/skills/qa/SKILL.md` §7 and the mutation-verification record in `templates/skills/qa/SKILL.md` §6i exist because an agent's self-report is not evidence. All are model-dependent, which is why the human merge gate is the last word |
| ASI10 Rogue Agents | Mitigated in part. Worktree containment and the guard set in `templates/hooks/pre-tool.sh` bound what a misbehaving agent reaches on disk, and it cannot merge. Egress from a rogue agent is out of scope — Claude Code's permission layer owns it |

<!-- owasp:end -->

---

## Residual risks

These are stated because they are true, not because they are comfortable.

**The human merge gate is a convention, not an enforced control.** It is the
single most load-bearing claim in this document — every "bounded at an unmerged
PR" above rests on it — and on this repository it is enforced by nothing
outside the model. `main` has no branch protection, and no hook guard covers
`gh pr merge`. Treat the gate as model-dependent: a phase agent that decided to
merge would not be stopped by sequant. Enabling branch protection with a
required review on your own repository is what makes this deterministic, and we
recommend it.

**A phase agent can be influenced by the text it reads.** This is not a defect
we can close. It is the reason the Trust-Boundary Check and the merge gate
exist: the design goal is that an influenced agent produces a *visible* PR a
human declines, not a silent action.

**The dependency surface has the thinnest coverage.** Lockfile pinning and
scheduled Dependabot version updates are in place; Dependabot **security
alerts** are not enabled on this repository, there is no secret-scanning
configuration, and there is no OpenSSF Scorecard signal (#1025) or npm publish
provenance (#1028) yet. A malicious package executes with the developer's
privileges before any agent decision is made, so no control in the table above
is positioned to catch it.

**Network egress is not sequant's layer.** Sequant does not sandbox network
access, and the hook guards do not attempt to enumerate every command that
could reach the network. Egress control belongs to Claude Code's permission and
sandbox layer. If your threat model requires egress restriction, configure it
there.

**Deterministic guards are pattern-based.** Each `HOOK_BLOCKED:` refusal
matches specific command and path shapes. They stop the known dangerous forms,
including the ones that have actually occurred, but an unrecognised spelling of
the same intent is not refused. Their value is that they hold against an agent
that wants to proceed — not that the pattern set is complete.

**The behavioural evidence is narrow and manually triggered.** The injection
eval covers the issue-body vector, is dispatched by hand, and produces one
recorded run rather than a continuous signal. The PR-comment and tool-output
vectors are tracked in #1024.

**CI checks that citations resolve, not that classifications are correct.** The
gate behind this document verifies that every path, skill anchor, and settings
key above exists, and that the guard count matches the source. It cannot verify
that a control labelled `deterministic` truly is one. A wrong label here would
be a public misstatement that passes every test, so reviewers re-derive each
`Class` cell from its enforcer rather than accepting it as written.

---

## Reporting

Security reports go through the process in [`SECURITY.md`](../SECURITY.md).
A report that names the deterministic control it bypasses is the most useful
kind we receive.
