# Security policy

Sequant orchestrates AI phase agents that read untrusted text (GitHub issue
bodies, comments, repository files) and run with broad local tool access. Its
defensive posture — which controls hold when the model itself is compromised,
and which do not — is documented in
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). Read that first if you are
assessing sequant rather than reporting a specific flaw.

## Reporting a vulnerability

Report privately. Do not open a public issue for a security flaw, and do not
include a working exploit payload in any public thread.

<!-- security-contact -->

**Primary channel:** GitHub private vulnerability reporting —
https://github.com/sequant-io/sequant/security/advisories/new

<!-- /security-contact -->

Please include, as far as you can establish it:

- The sequant version (`sequant --version`) and how it was installed (npm
  global, `npx`, or Claude Code plugin).
- The host platform and Claude Code version, if the behaviour depends on them.
- Reproduction steps. If reproducing requires a phase agent run, say so and
  include the issue body, comment, or file content that triggers it — that is
  the untrusted-input surface we need to see verbatim.
- The impact you believe it has: what an attacker gains, and whether it
  survives the human merge gate (see
  [Residual risks](docs/THREAT-MODEL.md#residual-risks)).
- Any deterministic control you believe it bypasses, named by file — a report
  that names the bypassed hook guard or skill section is triaged much faster.

Reports about the *behaviour of the underlying model* — that a phase agent can
be persuaded by cleverly worded text — belong upstream with Anthropic unless
the report also shows a sequant control failing to contain the consequence.
The threat model states plainly that a phase agent can be influenced; what we
treat as our defect is a containment control that does not hold.

## Response expectations

Sequant is maintained by a single maintainer. These windows are what that can
realistically meet, and are commitments rather than aspirations:

| Stage | Target |
|-------|--------|
| Acknowledgement of your report | 5 business days |
| Initial triage and severity assessment | 10 business days |
| Fix, mitigation, or a written explanation of why neither is planned | 30 days from triage |

We follow coordinated disclosure: we will agree a disclosure date with you,
credit you in the advisory and release notes unless you ask us not to, and
publish a GitHub Security Advisory when the fix ships. If a report is declined,
you will get the reasoning, and you remain free to disclose after the agreed
date.

If you have not heard back within the acknowledgement window, escalate by
opening a *non-descriptive* public issue ("awaiting response on a private
security report") — that signals the queue without disclosing anything.

## Supported versions

Sequant ships from a single line of development; only the latest minor series
receives security fixes. There are no long-term-support branches.

| Version | Supported |
|---------|-----------|
| 2.14.x | ✅ Security fixes |
| < 2.14 | ❌ Upgrade to the latest release |

Fixes ship in a new patch release rather than as backports. Because sequant is
a developer tool installed per-machine, upgrading is `npm install -g sequant`
or re-running the plugin install; see [CHANGELOG.md](CHANGELOG.md) for what
changed in each release.

## Scope

In scope: sequant's own code, hooks, skills, workflows, and release artifacts —
including any case where a documented deterministic control fails to hold.

Out of scope, with the owning layer named in the
[OWASP mapping](docs/THREAT-MODEL.md#owasp-top-10-for-agentic-applications-2026):
model-level susceptibility to persuasion (Anthropic), network egress and tool
permission enforcement (Claude Code), and the security of your own GitHub
repository configuration.
