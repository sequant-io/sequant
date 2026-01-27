# Telemetry Policy

## Decision: No Telemetry

**Sequant does not collect any usage telemetry, analytics, or user data.**

This is an intentional design decision, not an oversight.

## Reasoning

### 1. Trust and Transparency

Sequant skills execute with significant permissions - they can:
- Read and write files in your project
- Execute shell commands
- Make network requests via GitHub CLI

Adding telemetry to a tool with these capabilities would undermine user trust. Users should be confident that Sequant only does what its skills explicitly describe.

### 2. Privacy by Default

Development workflows may involve:
- Proprietary code
- Sensitive project names
- Internal issue tracking
- Company-specific patterns

Even "anonymous" telemetry (skill usage counts, error rates) could inadvertently leak information about what users are working on.

### 3. Claude Code Already Handles This

Claude Code (the CLI tool that runs Sequant) has its own telemetry and feedback mechanisms. Adding a second layer of telemetry for a plugin would be:
- Redundant
- Confusing for users
- Additional maintenance burden

### 4. Simplicity

Telemetry requires:
- Consent management
- Data storage infrastructure
- Privacy policy updates
- GDPR/CCPA compliance
- Opt-out mechanisms

None of this adds value to Sequant's core mission of providing quality workflow skills.

## How We Gather Feedback Instead

### GitHub Issues

All feedback flows through GitHub issues:

- **Bug reports:** Use the [Bug Report template](https://github.com/admarble/sequant/issues/new?template=bug.yml)
- **Plugin-specific issues:** Use the [Plugin Feedback template](https://github.com/admarble/sequant/issues/new?template=plugin-feedback.yml)
- **Feature requests:** Use the [Feature Request template](https://github.com/admarble/sequant/issues/new?template=feature.yml)

### The `/improve` Skill

Users can run `/improve` to:
1. Analyze their codebase for issues
2. Generate structured improvement reports
3. Create GitHub issues with proper formatting

This provides structured feedback without any data leaving the user's machine.

### Community Contributions

We welcome contributions via pull requests. See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines, including plugin-specific contribution instructions.

## What This Means for You

- **No tracking:** Your skill usage is not monitored
- **No data collection:** We don't know which projects use Sequant
- **No network calls:** Sequant never phones home (except explicit GitHub CLI operations you initiate)
- **Full control:** All data stays on your machine

## Future Considerations

If we ever reconsider telemetry, we commit to:

1. **Opt-in only** - Never enabled by default
2. **Full transparency** - Clear documentation of what's collected
3. **Local-first** - Aggregate locally, only send summaries
4. **Easy disable** - Single setting to turn off completely
5. **Community input** - Discussion before implementation

For now, the answer is simply: **No telemetry.**

---

*Last updated: January 2026*
